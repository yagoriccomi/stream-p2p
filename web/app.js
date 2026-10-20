// MVP client. Host captures screen; each viewer receives from its parent and,
// if assigned children, forwards the same MediaStream to them (relay).
const MODES = {
  '720p30': { width: 1280, height: 720, fps: 30, kbps: 4000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, kbps: 8000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, kbps: 15000 },
};
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // ponytail: STUN only; add TURN for symmetric NAT

const $ = (id) => document.getElementById(id);
const log = (m) => ($('log').textContent += `${new Date().toLocaleTimeString()} ${m}\n`);
const status = (m, kind = 'info') => {
  $('status').textContent = m;
  $('status').dataset.kind = kind;
  if (kind === 'error') console.error(m);
};

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
const sendWs = (msg) => ws.send(JSON.stringify(msg));

let stream = null; // stream we have (captured or received)
let mode = null;
let upstream = null; // RTCPeerConnection to parent
const downstream = new Map(); // childId -> RTCPeerConnection
const pendingChildren = new Set(); // children that arrived before we had a stream

// Unlock bitrate: Chrome caps video at ~2.5 Mbps by default. b=AS goes in the video m-section.
function mungeBitrate(sdp, kbps) {
  return sdp.replace(/(m=video[^\r\n]*\r\n(?:(?!m=)[^\r\n]*\r\n)*?c=[^\r\n]*\r\n)/, `$1b=AS:${kbps}\r\n`);
}

function newPc(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  pc.onicecandidate = (e) => e.candidate && sendWs({ type: 'signal', to: peerId, data: { candidate: e.candidate } });
  pc.onconnectionstatechange = () => log(`${peerId.slice(0, 6)}: ${pc.connectionState}`);
  return pc;
}

async function offerTo(childId) {
  downstream.get(childId)?.close();
  const pc = newPc(childId);
  downstream.set(childId, pc);
  for (const track of stream.getTracks()) {
    const sender = pc.addTrack(track, stream);
    if (track.kind !== 'video') continue;
    const params = sender.getParameters();
    params.encodings = [{ maxBitrate: MODES[mode].kbps * 1000, maxFramerate: MODES[mode].fps }];
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params).catch((e) => log(`setParameters: ${e.message}`));
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription({ type: 'offer', sdp: mungeBitrate(offer.sdp, MODES[mode].kbps) });
  sendWs({ type: 'signal', to: childId, data: { sdp: pc.localDescription } });
}

async function acceptFrom(parentId, sdp, jitterMs) {
  upstream?.close();
  upstream = newPc(parentId);
  upstream.ontrack = (e) => {
    // Uniform latency: deeper nodes already have hop delay, so they buffer less (Chrome/Edge ≥114).
    if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = jitterMs;
    if (e.track.kind !== 'video') return; // fires once per track; forward once
    stream = e.streams[0];
    $('video').srcObject = stream;
    for (const id of pendingChildren) offerTo(id);
    pendingChildren.clear();
    // Re-feed existing children with the new stream after a re-parent.
    for (const id of downstream.keys()) offerTo(id);
  };
  await upstream.setRemoteDescription(sdp);
  const answer = await upstream.createAnswer();
  await upstream.setLocalDescription({ type: 'answer', sdp: mungeBitrate(answer.sdp, MODES[mode].kbps) });
  sendWs({ type: 'signal', to: parentId, data: { sdp: upstream.localDescription } });
}

let jitterMs = 0;
let parentId = null;

// Serialize handling: a candidate must not race ahead of its setRemoteDescription.
let queue = Promise.resolve();
ws.onmessage = ({ data }) => {
  queue = queue.then(() => handle(JSON.parse(data))).catch((e) => log(`erro: ${e.message}`));
};

async function handle(msg) {
  switch (msg.type) {
    case 'hello': {
      status('Pronto.');
      const room = new URLSearchParams(location.search).get('room');
      if (room) { $('room').value = room; sendWs({ type: 'join', room }); }
      return;
    }
    case 'room': {
      status(`Transmitindo. Sala: ${msg.room}`);
      $('room').value = msg.room;
      const url = `${location.origin}/?room=${msg.room}`;
      Object.assign($('invite-link'), { href: url, textContent: url });
      $('invite').hidden = false;
      return;
    }
    case 'assigned':
      ({ mode, jitterMs, parent: parentId } = msg);
      return status(`Conectado via ${parentId.slice(0, 6)} — buffer ${jitterMs} ms`);
    case 'child':
      log(`novo filho ${msg.id.slice(0, 6)}`);
      return stream ? offerTo(msg.id) : pendingChildren.add(msg.id);
    case 'childGone':
      downstream.get(msg.id)?.close();
      downstream.delete(msg.id);
      pendingChildren.delete(msg.id);
      return;
    case 'signal': {
      const { sdp, candidate } = msg.data;
      const pc = msg.from === parentId ? upstream : downstream.get(msg.from);
      if (sdp?.type === 'offer') return acceptFrom(msg.from, sdp, jitterMs);
      if (sdp) return pc?.setRemoteDescription(sdp);
      if (candidate) return pc?.addIceCandidate(candidate).catch(() => {});
      return;
    }
    case 'ended':
      status(`Transmissão encerrada${msg.reason ? `: ${msg.reason}` : ''}.`);
      upstream?.close();
      return;
    case 'error':
      return status(`Erro: ${msg.error}`, 'error');
  }
}
ws.onclose = () => status('Desconectado do servidor.', 'error');

// Live stats every 2 s: viewer reads inbound from parent, host reads outbound to children.
window.__stats = null; // read by e2e
let lastBytes = 0;
let lastAt = 0;
setInterval(async () => {
  const pcs = upstream ? [upstream] : [...downstream.values()];
  if (!pcs.length) return;
  let bytes = 0, fps = 0, w = 0, h = 0;
  for (const pc of pcs) {
    (await pc.getStats()).forEach((r) => {
      if (r.kind !== 'video' || (r.type !== 'inbound-rtp' && r.type !== 'outbound-rtp')) return;
      bytes += r.bytesReceived ?? r.bytesSent ?? 0;
      fps = Math.max(fps, r.framesPerSecond ?? 0);
      w = Math.max(w, r.frameWidth ?? 0);
      h = Math.max(h, r.frameHeight ?? 0);
    });
  }
  const now = performance.now();
  const kbps = lastAt ? Math.round(((bytes - lastBytes) * 8) / (now - lastAt)) : 0;
  [lastBytes, lastAt] = [bytes, now];
  window.__stats = { kbps, fps, w, h };
  const role = upstream ? `buffer ${jitterMs} ms` : `${pcs.length} filho(s) direto(s)`;
  $('stats').textContent = `${w}×${h} · ${fps} fps · ${kbps} kbps · ${role}`;
}, 2000);

$('host').onclick = async () => {
  mode = $('mode').value;
  const m = MODES[mode];
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: m.width, height: m.height, frameRate: m.fps },
      audio: true,
    });
  } catch (e) {
    return status(`Captura cancelada: ${e.message}`, 'error');
  }
  stream.getVideoTracks()[0].contentHint = 'motion'; // games: prefer fps over sharpness
  $('video').srcObject = stream;
  sendWs({ type: 'host', mode, uploadKbps: Number($('upload').value) * 1000 });
};

$('copy').onclick = () =>
  navigator.clipboard.writeText($('invite-link').href).then(
    () => status('Convite copiado.'),
    () => status('Não deu para copiar; selecione o link manualmente.', 'error'),
  );

$('join').onclick =() => sendWs({ type: 'join', room: $('room').value.trim() });
