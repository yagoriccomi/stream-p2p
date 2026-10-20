import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, addViewer, removeViewer, directQuota, depth, jitterTargets, setHopRtt } from './topology.js';

test('quota: 1440p60 on 20 Mbps upload allows 1 direct viewer', () => {
  assert.equal(directQuota(20000, '1440p60'), 1);
});

test('quota: 720p30 on 20 Mbps upload allows 4 direct viewers', () => {
  assert.equal(directQuota(20000, '720p30'), 4);
});

test('quota is never below 1 even on weak upload', () => {
  assert.equal(directQuota(1000, '1440p60'), 1);
});

test('createRoom rejects unknown mode and non-positive upload', () => {
  assert.throws(() => createRoom('h', '4k120', 50000));
  assert.throws(() => createRoom('h', '720p30', 0));
});

test('excess viewers become relay children (BFS, shallowest first)', () => {
  const room = createRoom('h', '1440p60', 20000); // host capacity 1
  assert.equal(addViewer(room, 'a'), 'h');
  assert.equal(addViewer(room, 'b'), 'a');
  assert.equal(addViewer(room, 'c'), 'a');
  assert.equal(addViewer(room, 'd'), 'b');
  assert.equal(depth(room, 'd'), 3);
});

test('duplicate viewer id throws', () => {
  const room = createRoom('h', '720p30', 20000);
  addViewer(room, 'a');
  assert.throws(() => addViewer(room, 'a'));
});

test('removing a relay re-hangs its children without cycles', () => {
  const room = createRoom('h', '1440p60', 20000);
  ['a', 'b', 'c', 'd'].forEach((id) => addViewer(room, id)); // h→a→{b,c}, b→d
  const moved = removeViewer(room, 'a');
  assert.deepEqual(moved.map((m) => m.id), ['b', 'c']);
  assert.equal(room.nodes.get('b').parent, 'h');
  assert.equal(room.nodes.get('c').parent, 'b'); // b has slot (d + c)
  assert.equal(room.nodes.get('d').parent, 'b');
  assert.ok(!room.nodes.has('a'));
});

test('dropped child reports its whole subtree when no slot is left', () => {
  const room = createRoom('h', '1440p60', 20000); // host cap 1, relays cap 2
  ['a', 'b', 'c', 'd', 'e'].forEach((id) => addViewer(room, id)); // h→a→{b,c}, b→{d,e}
  const moved = removeViewer(room, 'a'); // b→h; c: h full, b full, d/e free → c under d
  assert.equal(room.nodes.get('b').parent, 'h');
  assert.equal(room.nodes.get('c').parent, 'd');
  assert.ok(moved.every((m) => m.parent !== null));
});

test('removing host or unknown id is a no-op', () => {
  const room = createRoom('h', '720p30', 20000);
  assert.deepEqual(removeViewer(room, 'h'), []);
  assert.deepEqual(removeViewer(room, 'zzz'), []);
});

// Arrival time of a frame on screen for each viewer = Σ hops + buffers of the path (relays
// forward after their buffer). Used to check the sync claim, not just the buffer numbers.
function shownAt(room, hop) {
  const buf = jitterTargets(room);
  const at = new Map([[room.hostId, 0]]);
  const walk = (id) => room.nodes.get(id).children.forEach((c) => { at.set(c, at.get(id) + hop(c) + buf.get(c)); walk(c); });
  walk(room.hostId);
  at.delete(room.hostId);
  return at;
}

test('a lone direct viewer buffers up to the 150 ms target', () => {
  const room = createRoom('h', '1440p60', 20000);
  addViewer(room, 'a');
  assert.deepEqual([...jitterTargets(room)], [['a', 120]]); // 30 ms estimated hop
});

test('with a relay, its children land on 150 ms and the relay one hop ahead', () => {
  const room = createRoom('h', '1440p60', 20000); // quota 1 → b, c hang under a
  ['a', 'b', 'c'].forEach((id) => addViewer(room, id));
  assert.deepEqual(Object.fromEntries(jitterTargets(room)), { a: 90, b: 0, c: 0 });
  assert.deepEqual(Object.fromEntries(shownAt(room, () => 30)), { a: 120, b: 150, c: 150 });
});

test('measured RTT replaces the estimate and adds relay processing below the host', () => {
  const room = createRoom('h', '1440p60', 20000);
  ['a', 'b', 'c'].forEach((id) => addViewer(room, id));
  setHopRtt(room, 'a', 10); // 5 ms one way
  setHopRtt(room, 'b', 10); // 5 + 20 ms relay
  setHopRtt(room, 'c', 30); // 15 + 20 ms relay
  assert.deepEqual(Object.fromEntries(jitterTargets(room)), { a: 110, b: 10, c: 0 });
});

test('a deep tree never buffers below 0 and every leaf lands on the same time', () => {
  const room = createRoom('h', '1440p60', 20000);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i'];
  ids.forEach((id) => addViewer(room, id));
  for (const ms of jitterTargets(room).values()) assert.ok(ms >= 0);
  const at = shownAt(room, () => 30);
  const leaves = ids.filter((id) => !room.nodes.get(id).children.length).map((id) => at.get(id));
  assert.equal(new Set(leaves).size, 1);
});

test('re-parenting forgets the measured hop of the old edge', () => {
  const room = createRoom('h', '1440p60', 20000);
  ['a', 'b'].forEach((id) => addViewer(room, id));
  setHopRtt(room, 'b', 100);
  removeViewer(room, 'a'); // b moves up to the host
  assert.equal(room.nodes.get('b').hopMs, null);
  assert.equal(setHopRtt(room, 'h', 10), false, 'host has no upstream edge');
});
