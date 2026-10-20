import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { iceServers, restCredential, turnUrls, DEFAULT_STUN, TURN_TTL_S } from './ice.js';

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
