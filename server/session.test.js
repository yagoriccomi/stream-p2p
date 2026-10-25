import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, addMember, rename, removeMember, startStream, stopStream, requestTurn, passTurn,
  moderate, updateSettings, crown, newCode, normalizeCode, CAN, HttpError, MAX_MEMBERS, TURN_GRANT_MS,
} from './session.js';

const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError, e.message); return e.code; }
  assert.fail('expected HttpError');
};

function room() {
  const s = createSession('abcd-ef', 'ana', 'Ana', 'dev-ana', 0);
  addMember(s, 'bruno', 'Bruno', 'dev-bruno', 1);
  addMember(s, 'caio', 'Caio', 'dev-caio', 2);
  addMember(s, 'dani', 'Dani', 'dev-dani', 3);
  moderate(s, 'ana', 'promote', 'caio');
  return s;
}

test('code format avoids ambiguous characters', () => {
  for (let i = 0; i < 200; i++) assert.match(newCode(), /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{2}$/);
  assert.equal(normalizeCode(' ABCD-EF '), 'abcd-ef');
});

test('nickname is required, trimmed and unique ignoring case and accents', () => {
  const s = room();
  assert.equal(code(() => addMember(s, 'x', '   ')), 400);
  assert.equal(code(() => addMember(s, 'x', 'x'.repeat(25))), 400);
  assert.equal(code(() => addMember(s, 'x', ' bruno ')), 409);
  assert.equal(code(() => addMember(s, 'x', 'Âna')), 409);
  assert.equal(code(() => rename(s, 'dani', 'CAIO')), 409);
  assert.equal(rename(s, 'dani', 'Dani'), 'Dani'); // own name is fine
  assert.equal(rename(s, 'dani', '  Daniela   B '), 'Daniela B');
});

test('locked → 423, full → 503, banned device → 403', () => {
  const s = room();
  updateSettings(s, 'caio', { locked: true }); // moderators may lock
  assert.equal(code(() => addMember(s, 'x', 'Eva')), 423);
  updateSettings(s, 'ana', { locked: false });
  moderate(s, 'ana', 'ban', 'dani');
  assert.equal(code(() => addMember(s, 'x', 'Outro nome', 'dev-dani')), 403);
  for (let i = s.members.size; i < MAX_MEMBERS; i++) addMember(s, `m${i}`, `Pessoa ${i}`);
  assert.equal(code(() => addMember(s, 'x', 'Mais um')), 503);
});

test('one presenter at a time; others queue', () => {
  const s = room();
  startStream(s, 'bruno', { mode: '1080p60' }, 10);
  assert.equal(code(() => startStream(s, 'dani', { mode: '720p30' })), 409);
  assert.equal(requestTurn(s, 'dani'), 1);
  assert.equal(requestTurn(s, 'ana'), 2);
  assert.equal(requestTurn(s, 'dani'), 1); // idempotent
});

test('presenter can pass the turn; the grant is reserved for 1 minute', () => {
  const s = room();
  startStream(s, 'bruno', { mode: '1080p60' }, 0);
  requestTurn(s, 'dani');
  passTurn(s, 'bruno', 'dani', 100);
  assert.equal(s.presenterId, null);
  assert.deepEqual(s.queue, []);
  assert.equal(code(() => startStream(s, 'ana', {}, 200)), 409); // reserved for Dani
  startStream(s, 'ana', {}, 100 + TURN_GRANT_MS + 1); // expired → anyone
  assert.equal(s.presenterId, 'ana');
});

test('presenterCanPass off → only staff passes', () => {
  const s = room();
  updateSettings(s, 'ana', { presenterCanPass: false });
  startStream(s, 'bruno', {}, 0);
  assert.equal(code(() => passTurn(s, 'bruno', 'dani')), 403);
  passTurn(s, 'caio', 'dani'); // moderator
  assert.equal(s.grant.id, 'dani');
  assert.equal(code(() => passTurn(s, 'dani', 'bruno')), 403); // plain member, not presenting
});

test('autoApprove hands the turn to the first in line on stop', () => {
  const s = room();
  updateSettings(s, 'ana', { autoApprove: true });
  startStream(s, 'bruno', {}, 0);
  requestTurn(s, 'dani');
  assert.equal(stopStream(s, 'bruno', 5), 'dani');
  assert.equal(s.grant.id, 'dani');
});

test('stopping someone else: owner and moderators only', () => {
  const s = room();
  startStream(s, 'bruno', {}, 0);
  assert.equal(code(() => stopStream(s, 'dani')), 403);
  stopStream(s, 'caio');
  assert.equal(s.presenterId, null);
  startStream(s, 'ana', {}, 0);
  assert.equal(code(() => stopStream(s, 'caio')), 403); // mod can't stop the owner
});

test('permission matrix matches the T10 table', () => {
  const s = room();
  startStream(s, 'bruno', {}, 0);
  const [owner, presenter, mod, member] = ['ana', 'bruno', 'caio', 'dani'].map((id) => s.members.get(id));
  const row = (action, target) => [owner, mod, presenter, member].map((a) => (a === target ? null : CAN[action](s, a, target)));
  assert.deepEqual(row('passTurn'), [true, true, true, false]);
  assert.deepEqual(row('kick', member), [true, true, false, null]);
  assert.deepEqual(row('muteForAll', member), [true, true, false, null]);
  assert.deepEqual(row('lock'), [true, true, false, false]);
  assert.deepEqual(row('ban', member), [true, false, false, null]);
  assert.deepEqual(row('promote', member), [true, false, false, null]);
  assert.deepEqual(row('transferOwner', member), [true, false, false, null]);
  assert.deepEqual(row('end'), [true, false, false, false]);
  assert.equal(CAN.kick(s, mod, owner), false);
  assert.equal(code(() => moderate(s, 'caio', 'ban', 'dani')), 403);
  assert.equal(code(() => updateSettings(s, 'caio', { autoApprove: true })), 403);
  assert.equal(code(() => updateSettings(s, 'ana', { nope: true })), 400);
});

test('owner leaving passes the crown to the oldest moderator', () => {
  const s = room();
  assert.equal(removeMember(s, 'ana'), 'caio');
  assert.equal(s.members.get('caio').role, 'owner');
  assert.equal(removeMember(s, 'caio'), 'bruno'); // no mods left → oldest member
});

test('transferOwner keeps the old owner as moderator', () => {
  const s = room();
  moderate(s, 'ana', 'transferOwner', 'dani');
  assert.equal(s.ownerId, 'dani');
  assert.equal(s.members.get('ana').role, 'mod');
  assert.equal(code(() => moderate(s, 'ana', 'end')), 400);
});

test('presenter leaving clears the stream', () => {
  const s = room();
  startStream(s, 'bruno', {}, 0);
  removeMember(s, 'bruno');
  assert.equal(s.presenterId, null);
});

test('crown makes someone owner and the former owner a moderator', () => {
  const s = room();
  crown(s, 'dani');
  assert.equal(s.ownerId, 'dani');
  assert.equal(s.members.get('dani').role, 'owner');
  assert.equal(s.members.get('ana').role, 'mod');
});
