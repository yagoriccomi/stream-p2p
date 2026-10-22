import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mungeStartBitrate, randomId } from './stream.js';

// Trimmed from a real Chrome answer: VP8 has no fmtp line, H264 has one, rtx points at both.
const SDP = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102', 'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 VP8/90000', 'a=rtcp-fb:96 nack',
  'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
  '',
].join('\r\n');

test('start bitrate: VP8 without fmtp gets one, right after its rtpmap', () => {
  const out = mungeStartBitrate(SDP, 4000);
  assert.match(out, /a=rtpmap:96 VP8\/90000\r\na=fmtp:96 x-google-start-bitrate=4000\r\n/);
});

test('start bitrate: an existing fmtp keeps its parameters', () => {
  const out = mungeStartBitrate(SDP, 4000);
  assert.match(out, /a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f;x-google-start-bitrate=4000\r\n/);
});

test('start bitrate: rtx and audio are left alone', () => {
  const out = mungeStartBitrate(SDP, 4000);
  assert.match(out, /a=fmtp:97 apt=96\r\n/);
  assert.match(out, /a=fmtp:111 minptime=10;useinbandfec=1\r\n/);
  assert.equal(out.match(/x-google-start-bitrate/g).length, 2);
});

test('start bitrate: applying twice replaces the value instead of repeating it', () => {
  const out = mungeStartBitrate(mungeStartBitrate(SDP, 4000), 2500);
  assert.equal(out.match(/x-google-start-bitrate/g).length, 2);
  assert.match(out, /a=fmtp:96 x-google-start-bitrate=2500\r\n/);
});

test('random id: a v4 UUID even without crypto.randomUUID (plain http on the LAN)', (t) => {
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); // shadows the prototype's
  t.after(() => delete crypto.randomUUID);
  const a = randomId();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(randomId(), a);
});

test('start bitrate: no video section, no change', () => {
  const audioOnly = SDP.slice(0, SDP.indexOf('m=video'));
  assert.equal(mungeStartBitrate(audioOnly, 4000), audioOnly);
});
