import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { handleInteraction, serverName, inviteUrl } from './discord.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function call(body, { tamper = false } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = '1700000000';
  const sig = sign(null, Buffer.concat([Buffer.from(ts), raw]), privateKey).toString('hex');
  const headers = { 'x-signature-ed25519': tamper ? sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) : sig, 'x-signature-timestamp': ts };
  return handleInteraction(headers, raw, { publicKey: PUB_HEX, baseUrl: 'https://stream.example', createSession: () => ({ code: 'k7f2-q9' }) });
}

test('rejects bad signatures with 401', () => {
  assert.equal(call({ type: 1 }, { tamper: true }).status, 401);
  assert.equal(handleInteraction({}, Buffer.from('{}'), { publicKey: PUB_HEX }).status, 401);
});

test('answers PING', () => {
  assert.deepEqual(call({ type: 1 }), { status: 200, body: { type: 1 } });
});

test('/stream criar posts an embed whose button is per person', () => {
  const out = call({ type: 2, data: { name: 'stream', options: [{ name: 'criar', type: 1 }] }, member: { nick: 'Ana do Clã', user: { username: 'ana' } } });
  assert.equal(out.body.type, 4);
  assert.equal(out.body.data.embeds[0].title, 'Ana do Clã abriu uma sessão');
  assert.equal(out.body.data.embeds[0].color, 0x7f00ff);
  assert.equal(out.body.data.components[0].components[0].custom_id, 'join:k7f2-q9');
  assert.doesNotMatch(JSON.stringify(out.body.data.embeds), /k7f2/); // code stays hidden
});

test('button click returns a private link with the clicker server nickname', () => {
  const out = call({ type: 3, data: { custom_id: 'join:k7f2-q9' }, member: { nick: null, user: { username: 'bruno', global_name: 'Bruno G' } } });
  assert.equal(out.body.data.flags, 64);
  assert.equal(out.body.data.components[0].components[0].url, 'https://stream.example/?code=k7f2-q9&name=Bruno+G');
});

test('name fallbacks and length', () => {
  assert.equal(serverName({ user: { username: 'solo' } }), 'solo');
  assert.equal(serverName({ member: { nick: 'x'.repeat(40), user: {} } }).length, 24);
  assert.equal(inviteUrl('http://h:3000', 'abcd-ef', ''), 'http://h:3000/?code=abcd-ef');
});
