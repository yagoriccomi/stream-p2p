// Pure topology logic: who connects directly to the host vs. who becomes a relay child.
// No I/O here so it can be unit-tested [#30].

export const MODES = {
  '720p30': { width: 1280, height: 720, fps: 30, kbps: 4000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, kbps: 8000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, kbps: 15000 },
};

const UPLOAD_HEADROOM = 0.8; // keep 20% of upload free for audio/signaling/bursts
const MAX_CHILDREN_PER_RELAY = 2; // viewers usually have weaker upload than the host
const TARGET_LATENCY_MS = 150; // upper bound of the 90–150 ms sync window
const EST_HOP_LATENCY_MS = 30; // ponytail: fixed per-hop estimate; replace with measured RTT via getStats()

export function directQuota(uploadKbps, mode) {
  const { kbps } = MODES[mode];
  return Math.max(1, Math.floor((uploadKbps * UPLOAD_HEADROOM) / kbps));
}

export function createRoom(hostId, mode, uploadKbps) {
  if (!MODES[mode]) throw new Error(`unknown mode: ${mode}`);
  if (!(uploadKbps > 0)) throw new Error('uploadKbps must be > 0');
  return {
    hostId,
    mode,
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
  room.nodes.get(id).parent = parentId;
  room.nodes.get(parentId).children.push(id);
}

export function addViewer(room, id) {
  if (room.nodes.has(id)) throw new Error(`duplicate id: ${id}`);
  const parentId = findParent(room);
  if (!parentId) return null; // every node saturated
  room.nodes.set(id, { parent: null, children: [], capacity: MAX_CHILDREN_PER_RELAY });
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

// Deeper viewers already carry hop delay, so they buffer less → everyone lands near TARGET_LATENCY_MS.
export function jitterTargetMs(room, id) {
  return Math.max(0, TARGET_LATENCY_MS - depth(room, id) * EST_HOP_LATENCY_MS);
}
