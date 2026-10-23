// Pure topology logic: who connects directly to the host vs. who becomes a relay child.
// No I/O here so it can be unit-tested [#30].

export const MODES = {
  '720p30': { width: 1280, height: 720, fps: 30, kbps: 4000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, kbps: 8000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, kbps: 15000 },
};

const UPLOAD_HEADROOM = 0.8; // keep 20% of upload free for audio/signaling/bursts
const MAX_CHILDREN_PER_RELAY = 2; // viewers usually have weaker upload than the host
// Everyone sees a frame this long after it leaves the presenter. 'auto' picks the lowest value
// every viewer's network can hold without stalling; a number fixes it.
export const LATENCY = { DEFAULT_MS: 150, MIN_MS: 60, MAX_MS: 400, SAFETY_MS: 20, ROUND_MS: 10 };
const EST_HOP_LATENCY_MS = 30; // used for an edge until its viewer reports a measured RTT
const RELAY_PROCESSING_MS = 20; // a relay decodes and re-encodes before forwarding
export const JITTER_STEP_MS = 5; // smaller changes aren't worth a message

export function directQuota(uploadKbps, mode) {
  const { kbps } = MODES[mode];
  return Math.max(1, Math.floor((uploadKbps * UPLOAD_HEADROOM) / kbps));
}

export const validLatency = (v) => v === 'auto' || (Number.isInteger(v) && v >= LATENCY.MIN_MS && v <= LATENCY.MAX_MS);

export function createRoom(hostId, mode, uploadKbps, latency = 'auto') {
  if (!MODES[mode]) throw new Error(`unknown mode: ${mode}`);
  if (!(uploadKbps > 0)) throw new Error('uploadKbps must be > 0');
  if (!validLatency(latency)) throw new Error(`bad latency: ${latency}`);
  return {
    hostId,
    mode,
    latency,
    targetMs: latency === 'auto' ? LATENCY.DEFAULT_MS : latency, // auto starts safe, then follows the measurements
    nodes: new Map([[hostId, { parent: null, children: [], capacity: directQuota(uploadKbps, mode) }]]),
  };
}

export function depth(room, id) {
  let d = 0;
  for (let n = room.nodes.get(id); n.parent; n = room.nodes.get(n.parent)) d++;
  return d;
}

// Shallowest node with a free slot (BFS) → minimum hops → minimum latency.
function findParent(room, exclude = new Set()) {
  const queue = [room.hostId];
  while (queue.length) {
    const id = queue.shift();
    if (exclude.has(id)) continue;
    const node = room.nodes.get(id);
    if (node.children.length < node.capacity) return id;
    queue.push(...node.children);
  }
  return null;
}

function attach(room, id, parentId) {
  Object.assign(room.nodes.get(id), { parent: parentId, hopMs: null, needMs: null }); // new edge: not measured yet
  room.nodes.get(parentId).children.push(id);
}

export function addViewer(room, id) {
  if (room.nodes.has(id)) throw new Error(`duplicate id: ${id}`);
  const parentId = findParent(room);
  if (!parentId) return null; // every node saturated
  room.nodes.set(id, { parent: null, children: [], capacity: MAX_CHILDREN_PER_RELAY, hopMs: null, needMs: null });
  attach(room, id, parentId);
  return parentId;
}

function subtree(room, id, acc = new Set()) {
  acc.add(id);
  for (const c of room.nodes.get(id).children) subtree(room, c, acc);
  return acc;
}

// Removes a viewer; its children are re-hung (with their subtrees) elsewhere.
// Returns [{ id, parent }] for every re-hung child (parent null = no slot left, must drop).
export function removeViewer(room, id) {
  const node = room.nodes.get(id);
  if (!node || id === room.hostId) return [];
  const parent = room.nodes.get(node.parent);
  parent.children = parent.children.filter((c) => c !== id);
  room.nodes.delete(id);

  const moved = [];
  for (const childId of node.children) {
    const exclude = subtree(room, childId); // avoid attaching a node under its own descendant
    const newParent = findParent(room, exclude);
    if (newParent) {
      attach(room, childId, newParent);
      moved.push({ id: childId, parent: newParent });
    } else {
      for (const d of exclude) {
        room.nodes.delete(d);
        moved.push({ id: d, parent: null });
      }
    }
  }
  return moved;
}

// One-way latency of the edge parent → id, from the RTT the viewer measured with getStats().
export function setHopRtt(room, id, rttMs) {
  const node = room.nodes.get(id);
  if (!node?.parent) return false;
  node.hopMs = rttMs / 2 + (node.parent === room.hostId ? 0 : RELAY_PROCESSING_MS);
  return true;
}

// Buffer a viewer's own network needs to play without stalling, measured by its jitter buffer.
export function setHopNeed(room, id, needMs) {
  const node = room.nodes.get(id);
  if (!node?.parent) return false;
  node.needMs = needMs;
  return true;
}

const hopOf = (node) => node.hopMs ?? EST_HOP_LATENCY_MS;
const needOf = (node) => node.needMs ?? 0;

// How long before the common show time each node must show (and forward): the longest chain
// below it of hop + the buffer that child's network needs.
function slacks(room) {
  const slack = new Map();
  const slackOf = (id) => {
    const node = room.nodes.get(id);
    const s = Math.max(0, ...node.children.map((c) => hopOf(room.nodes.get(c)) + needOf(room.nodes.get(c)) + slackOf(c)));
    slack.set(id, s);
    return s;
  };
  slackOf(room.hostId);
  return slack;
}

// Lowest show time that leaves every viewer the buffer its network asked for, plus a margin.
// Until someone measures, the safe default.
export function autoTarget(room) {
  if (![...room.nodes.values()].some((n) => n.needMs !== null && n.needMs !== undefined)) return LATENCY.DEFAULT_MS;
  const ms = Math.ceil((slacks(room).get(room.hostId) + LATENCY.SAFETY_MS) / LATENCY.ROUND_MS) * LATENCY.ROUND_MS;
  return Math.min(LATENCY.MAX_MS, Math.max(LATENCY.MIN_MS, ms));
}

// Moves the show time (auto, or the fixed choice); true when it changed.
export function retarget(room) {
  const next = room.latency === 'auto' ? autoTarget(room) : room.latency;
  if (next === room.targetMs) return false;
  room.targetMs = next;
  return true;
}

// Buffer per viewer so everyone shows a frame at about the same time.
// A relay forwards what leaves its own jitter buffer, so its children carry that delay too.
// Each node therefore shows (and forwards) at target − slack: leaves land on the target,
// a relay early enough for its children to still have the buffer their networks need.
export function jitterTargets(room) {
  const slack = slacks(room);
  const out = new Map();
  const walk = (id, forwardAt) => {
    for (const c of room.nodes.get(id).children) {
      const arrival = forwardAt + hopOf(room.nodes.get(c));
      const buffer = Math.max(0, room.targetMs - slack.get(c) - arrival);
      out.set(c, Math.round(buffer));
      walk(c, arrival + buffer);
    }
  };
  walk(room.hostId, 0);
  return out;
}
