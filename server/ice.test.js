import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { iceServers, iceSource, restCredential, turnUrls, DEFAULT_STUN, TURN_TTL_S, CF_TURN_API, CF_TTL_S } from './ice.js';

const NOW = 1_700_000_000_000;

test('without TURN env only the default STUN is offered', () => {
  assert.deepEqual(iceServers({}, NOW), [{ urls: DEFAULT_STUN }]);
});

test('TURN_SECRET yields a coturn REST credential that expires after the TTL', () => {
  const [, turn] = iceServers({ TURN_URLS: 'turn:t.example.com:3478, turns:t.example.com:5349', TURN_SECRET: 's3cret' }, NOW);
  assert.deepEqual(turn.urls, ['turn:t.example.com:3478', 'turns:t.example.com:5349']);
  assert.equal(turn.username, `${NOW / 1000 + TURN_TTL_S}:sp2p`);
  assert.equal(turn.credential, createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
});

test('static TURN credentials are used when there is no secret', () => {
  const [, turn] = iceServers({ TURN_URLS: 'turn:t.example.com', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }, NOW);
  assert.deepEqual(turn, { urls: ['turn:t.example.com'], username: 'u', credential: 'p' });
});

test('TURN without any credential is left out instead of failing ICE', () => {
  assert.deepEqual(iceServers({ TURN_URLS: 'turn:t.example.com' }, NOW), [{ urls: DEFAULT_STUN }]);
});

test('invalid TURN urls are dropped', () => {
  assert.deepEqual(turnUrls({ TURN_URLS: 'http://x, turn:ok.example.com,, stun:y' }), ['turn:ok.example.com']);
});

test('the secret changes the credential', () => {
  assert.notEqual(restCredential('a', NOW).credential, restCredential('b', NOW).credential);
});

const CF_ENV = { CF_TURN_KEY_ID: 'key1', CF_TURN_API_TOKEN: 'tok' };
const cfReply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
const CF_BODY = { iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' },
] };

test('cloudflare: asks for credentials with the key, keeps TURN and drops port 53', async () => {
  const calls = [];
  const ice = iceSource(CF_ENV, async (url, init) => { calls.push({ url, init }); return cfReply(201, CF_BODY)(); });
  const servers = await ice(NOW);
  assert.equal(calls[0].url, `${CF_TURN_API}/key1/credentials/generate-ice-servers`);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ttl: CF_TTL_S });
  assert.deepEqual(servers, [{ urls: DEFAULT_STUN }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' }]);
});

test('cloudflare: one set is shared until it is due for renewal', async () => {
  let n = 0;
  const ice = iceSource(CF_ENV, async () => { n++; return cfReply(201, CF_BODY)(); });
  await ice(NOW);
  await ice(NOW + 3600_000);
  assert.equal(n, 1);
  await ice(NOW + CF_TTL_S * 1000);
  assert.equal(n, 2);
});

test('cloudflare: a failed renewal keeps the last set while it lasts, then falls back to STUN', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let fail = false;
  const ice = iceSource(CF_ENV, async () => (fail ? cfReply(500, {})() : cfReply(201, CF_BODY)()));
  const first = await ice(NOW);
  fail = true;
  assert.deepEqual(await ice(NOW + 13 * 3600_000), first);
  assert.deepEqual(await ice(NOW + CF_TTL_S * 1000 + 1), [{ urls: DEFAULT_STUN }]);
});

test('cloudflare: without the key the env TURN settings are used', async () => {
  assert.deepEqual(await iceSource({}, async () => assert.fail('no call'))(NOW), [{ urls: DEFAULT_STUN }]);
});
