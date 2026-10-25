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
  return handleInteraction(headers, raw, { publicKey: PUB_HEX, baseUrl: 'https://stream.example', ...deps });
}

// Fake server state for the commands that read open sessions.
let made, ended, dms;
const open = [{ code: 'k7f2-q9', author: 'u-ana', authorName: 'Ana', ownerName: 'Ana', ownerToken: 'tok', mode: '1080p60', members: 3, presenter: 'Bruno' }];
const deps = {
  createSession: (meta) => ((made = meta), { code: 'k7f2-q9' }),
  sessionsIn: (scope) => (scope === 'g1' ? open : []),
  endSession: (code, by) => (ended = [code, by]),
  dm: (id, m) => dms.push([id, m]),
};
const cmd = (sub, extra = {}) => call({ type: 2, guild_id: 'g1', channel_id: 'c1', data: { name: 'stream', options: [{ name: sub, type: 1, ...extra }] }, member: { nick: 'Ana', user: { id: 'u-ana', username: 'ana' } } });

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

test('/stream help answers privately and links the download page', () => {
  const out = call({ type: 2, data: { name: 'stream', options: [{ name: 'help', type: 1 }] } });
  assert.equal(out.body.data.flags, 64);
  assert.match(out.body.data.content, /\/stream criar/);
  assert.match(out.body.data.content, /https:\/\/stream\.example\/download/);
});

test('button click returns a private link with the clicker server nickname', () => {
  const out = call({ type: 3, guild_id: 'g1', data: { custom_id: 'join:k7f2-q9' }, member: { nick: null, user: { id: 'u-bruno', username: 'bruno', global_name: 'Bruno G' } } });
  assert.equal(out.body.data.flags, 64);
  assert.equal(out.body.data.components[0].components[0].url, 'https://stream.example/?code=k7f2-q9&name=Bruno+G');
});

test('only the author click carries the owner token', () => {
  const out = call({ type: 3, guild_id: 'g1', data: { custom_id: 'join:k7f2-q9' }, member: { nick: 'Ana', user: { id: 'u-ana' } } });
  assert.match(out.body.data.components[0].components[0].url, /owner=tok/);
});

test('/stream criar options: owner by default, dono:false and a quality', () => {
  cmd('criar');
  assert.equal(made.owner, true);
  assert.equal(made.scope, 'g1');
  assert.equal(made.channel, 'c1');
  const out = cmd('criar', { options: [{ name: 'dono', value: false }, { name: 'qualidade', value: '1440p60' }] });
  assert.deepEqual([made.owner, made.mode], [false, '1440p60']);
  assert.match(out.body.data.embeds[0].footer.text, /primeira pessoa/);
  assert.match(out.body.data.embeds[0].description, /1440p60/);
  assert.equal(cmd('criar', { options: [{ name: 'qualidade', value: '8k' }] }) && made.mode, null);
});

test('/stream status, convite, app, encerrar', () => {
  const st = cmd('status');
  assert.equal(st.body.data.flags, 64);
  assert.match(st.body.data.content, /Ana · 3 pessoas · Bruno transmitindo/);
  assert.equal(cmd('convite').body.data.components[0].components[0].custom_id, 'join:k7f2-q9');
  assert.match(cmd('app').body.data.content, /\/download/);
  cmd('encerrar');
  assert.deepEqual(ended, ['k7f2-q9', 'Ana']);
  const other = call({ type: 2, guild_id: 'g2', data: { name: 'stream', options: [{ name: 'status', type: 1 }] } });
  assert.match(other.body.data.content, /Nenhuma sessão/);
});

test('encerrar is refused to someone who did not create it', () => {
  ended = null;
  const out = call({ type: 2, guild_id: 'g1', data: { name: 'stream', options: [{ name: 'encerrar', type: 1 }] }, member: { user: { id: 'u-x', username: 'x' } } });
  assert.equal(out.body.data.flags, 64);
  assert.equal(ended, null);
});

test('user command calls the target to the latest session and DMs them', () => {
  dms = [];
  const out = call({ type: 2, guild_id: 'g1', data: { type: 2, name: 'Chamar para stream', target_id: 'u-dani', resolved: { users: { 'u-dani': { username: 'dani' } }, members: { 'u-dani': { nick: 'Dani' } } } }, member: { nick: 'Ana', user: { id: 'u-ana' } } });
  assert.match(out.body.data.content, /<@u-dani>/);
  assert.deepEqual(out.body.data.allowed_mentions, { users: ['u-dani'] });
  assert.equal(dms[0][0], 'u-dani');
  assert.equal(dms[0][1].components[0].components[0].url, 'https://stream.example/?code=k7f2-q9&name=Dani');
});

test('name fallbacks and length', () => {
  assert.equal(serverName({ user: { username: 'solo' } }), 'solo');
  assert.equal(serverName({ member: { nick: 'x'.repeat(40), user: {} } }).length, 24);
  assert.equal(inviteUrl('http://h:3000', 'abcd-ef', ''), 'http://h:3000/?code=abcd-ef');
});
