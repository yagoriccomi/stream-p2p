import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, addViewer, removeViewer, directQuota, depth, jitterTargetMs } from './topology.js';

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

test('deeper viewers get smaller jitter buffer, clamped at 0', () => {
  const room = createRoom('h', '1440p60', 20000);
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i'].forEach((id) => addViewer(room, id));
  assert.equal(jitterTargetMs(room, 'a'), 120);
  assert.ok(jitterTargetMs(room, 'b') < jitterTargetMs(room, 'a'));
  for (const id of room.nodes.keys()) assert.ok(jitterTargetMs(room, id) >= 0);
});
