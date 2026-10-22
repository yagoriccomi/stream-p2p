// Video tree. The presenter captures; each viewer receives from its parent and, if assigned
// children, forwards the same MediaStream to them (relay). Source, quality, pause and audio
// change live on the presenter's senders — no renegotiation, so nobody drops.
export const MODES = {
  '720p30': { width: 1280, height: 720, fps: 30, kbps: 4000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, kbps: 8000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, kbps: 15000 },
};

// Unlock bitrate: Chrome caps video at ~2.5 Mbps by default. b=AS goes in the video m-section.
export function mungeBitrate(sdp, kbps) {
  return sdp.replace(/(m=video[^\r\n]*\r\n(?:(?!m=)[^\r\n]*\r\n)*?c=[^\r\n]*\r\n)/, `$1b=AS:${kbps}\r\n`);
}

// Where the sender's bandwidth estimate starts. Chrome starts at ~300 kbps and climbs for 13–16 s
// (low resolution meanwhile); the measured upload says how much fits. Read by the SENDING side
// from its remote description, so the presenter applies it to each answer it receives.
const VIDEO_CODECS = /^(VP8|VP9|AV1|H264|H265)$/i;
const UPLOAD_HEADROOM = 0.8; // same 20% the server keeps free when sizing the direct quota
// Half the mode: in 720p30 it reaches full resolution as fast as the full bitrate (3–4 s against
// 10–13 s), with half the freezes when the path turns out worse than the upload (netsim, 2026-10-21).
const START_FRACTION = 0.5;
export function mungeStartBitrate(sdp, kbps) {
  const start = sdp.indexOf('m=video');
  if (start < 0) return sdp;
  const next = sdp.indexOf('\r\nm=', start);
  const end = next < 0 ? sdp.length : next + 2;
  const lines = sdp.slice(start, end).split('\r\n');
  const param = `x-google-start-bitrate=${Math.round(kbps)}`;
  const pts = lines.map((l) => l.match(/^a=rtpmap:(\d+) ([^/]+)\//)).filter((m) => m && VIDEO_CODECS.test(m[2])).map((m) => m[1]);
  for (const pt of pts) {
    const i = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    if (i >= 0) {
      const [head, ...rest] = lines[i].split(' ');
      const params = rest.join(' ').split(';').filter((p) => p && !p.startsWith('x-google-start-bitrate='));
      lines[i] = `${head} ${[...params, param].join(';')}`;
    } else lines.splice(lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `)) + 1, 0, `a=fmtp:${pt} ${param}`);
  }
  return sdp.slice(0, start) + lines.join('\r\n') + sdp.slice(end);
}

export function captureConstraints(mode, surface) {
  const m = MODES[mode];
  return {
    video: { width: m.width, height: m.height, frameRate: m.fps, displaySurface: surface },
    audio: true, // always ask: the live switch only toggles track.enabled
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
  };
}

// crypto.randomUUID only exists in secure contexts, and a browser that joins a LAN server over
// plain http is not one (app.js and stream.js).
export function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Re-negotiation after a failed connection (stream.js and voice.js).
export const RECOVER_BASE_MS = 1000;
export const RECOVER_MAX_MS = 5000; // short: the connect deadline already spaces attempts out
const CONNECT_TIMEOUT_MS = 10_000;

// A pc that never connects (offer lost, or no candidates while the network is down) never
// reaches 'failed' either, so the offering side gives it a deadline.
export function connectDeadline(pc, onTimeout) {
  setTimeout(() => ['new', 'connecting'].includes(pc.connectionState) && onTimeout(), CONNECT_TIMEOUT_MS);
}

export class VideoNet {
  constructor({ send, log, onStream, getIce, getCodec }) {
    Object.assign(this, { send, log, onStream, getIce, getCodec });
    this.stream = null; // stream we have (captured or received)
    this.mode = null;
    this.upstream = null; // RTCPeerConnection to parent
    this.parentId = null;
    this.jitterMs = 0;
    this.downstream = new Map(); // childId -> RTCPeerConnection
    this.pending = new Set(); // children that arrived before we had a stream
    this.presenting = false;
    this.startKbps = 0; // presenter only: where each child's bandwidth estimate starts
    this.audioOn = true;
    this.retries = new Map(); // childId -> failed attempts in a row (backoff)
  }

  // nid tags one negotiation: after a re-parent a relay may re-offer while the child's answer
  // to the previous offer is still in flight; that stale answer must not hit the new pc.
  newPc(peerId, nid) {
    const pc = new RTCPeerConnection({ iceServers: this.getIce() });
    pc.nid = nid;
    pc.onicecandidate = (e) => e.candidate && this.send({ type: 'signal', to: peerId, data: { candidate: e.candidate, nid } });
    pc.onconnectionstatechange = () => {
      this.log(`vídeo ${peerId.slice(0, 6)}: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') this.retries.delete(peerId);
      if (pc.connectionState === 'failed' && this.downstream.get(peerId) === pc) this.recover(peerId, pc);
    };
    return pc;
  }

  // Past ICE consent (~30 s without packets) a pc stays failed for good (and a re-offer made
  // while the network is down may never connect: see connectDeadline). The parent owns the
  // link, so it offers again on a fresh pc (fresh TURN allocation too); the child takes any
  // offer, like after a re-parent. Backs off while the network is still down.
  recover(childId, pc) {
    const n = this.retries.get(childId) ?? 0;
    this.retries.set(childId, n + 1);
    const ms = Math.min(RECOVER_MAX_MS, RECOVER_BASE_MS * 2 ** n);
    this.log(`vídeo ${childId.slice(0, 6)}: refazendo em ${ms} ms`);
    setTimeout(() => {
      // Gone, replaced, or the old pc made it after all (late candidates) while we waited.
      if (this.downstream.get(childId) !== pc || pc.connectionState === 'connected' || !this.stream) return;
      this.offerTo(childId);
    }, ms);
  }

  // ── presenter ──
  present(stream, mode, uploadKbps) {
    this.reset();
    this.presenting = true;
    this.stream = stream;
    this.mode = mode;
    // Each direct child starts at half the mode's bitrate, unless the measured upload says less.
    this.startKbps = uploadKbps > 0 ? Math.min(MODES[mode].kbps * START_FRACTION, uploadKbps * UPLOAD_HEADROOM) : 0;
    stream.getVideoTracks()[0].contentHint = 'motion'; // games: prefer fps over sharpness
    this.applyAudio();
  }

  async replaceSource(next) {
    const old = this.stream;
    next.getVideoTracks()[0].contentHint = 'motion';
    const [video] = next.getVideoTracks();
    const [audio] = next.getAudioTracks();
    for (const pc of this.downstream.values()) {
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track.kind;
        await t.sender.replaceTrack(kind === 'video' ? video : audio ?? null).catch((e) => this.log(`replaceTrack: ${e.message}`));
      }
    }
    this.stream = next;
    this.applyAudio();
    old?.getTracks().forEach((t) => t.stop());
  }

  async setMode(mode) {
    const m = MODES[mode];
    this.mode = mode;
    const [track] = this.stream?.getVideoTracks() ?? [];
    await track?.applyConstraints({ width: m.width, height: m.height, frameRate: m.fps }).catch((e) => this.log(`applyConstraints: ${e.message}`));
    for (const pc of this.downstream.values()) await this.tuneSender(pc);
  }

  setPaused(paused) {
    for (const t of this.stream?.getVideoTracks() ?? []) t.enabled = !paused; // black frames, no renegotiation
  }

  setAudio(on) {
    this.audioOn = on;
    this.applyAudio();
  }

  applyAudio() {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = this.audioOn;
  }

  hasAudio() {
    return Boolean(this.stream?.getAudioTracks().length);
  }

  async tuneSender(pc) {
    const m = MODES[this.mode];
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: m.kbps * 1000, maxFramerate: m.fps }];
      params.degradationPreference = 'maintain-framerate';
      await sender.setParameters(params).catch((e) => this.log(`setParameters: ${e.message}`));
    }
  }

  preferCodec(pc) {
    const want = this.getCodec?.();
    if (!want || !RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
    const ordered = [...caps.filter((c) => c.mimeType.toLowerCase() === `video/${want}`), ...caps.filter((c) => c.mimeType.toLowerCase() !== `video/${want}`)];
    for (const t of pc.getTransceivers()) {
      if (t.sender.track?.kind === 'video' || t.receiver.track.kind === 'video') t.setCodecPreferences?.(ordered);
    }
  }

  async offerTo(childId) {
    this.downstream.get(childId)?.close();
    const pc = this.newPc(childId, randomId().slice(0, 8));
    this.downstream.set(childId, pc);
    const s = this.stream;
    const [video] = s.getVideoTracks();
    const [audio] = s.getAudioTracks();
    pc.addTransceiver(video, { direction: 'sendonly', streams: [s] });
    // Reserve the audio m-line even without captured audio, so a later source with audio
    // (or a relay forwarding one) never needs a new offer.
    pc.addTransceiver(audio ?? 'audio', { direction: 'sendonly', streams: [s] });
    this.preferCodec(pc);
    await this.tuneSender(pc);
    if (this.downstream.get(childId) !== pc) return; // replaced or gone while we awaited
    const offer = await pc.createOffer();
    if (this.downstream.get(childId) !== pc) return;
    await pc.setLocalDescription({ type: 'offer', sdp: mungeBitrate(offer.sdp, MODES[this.mode].kbps) });
    this.send({ type: 'signal', to: childId, data: { sdp: pc.localDescription, nid: pc.nid } });
    connectDeadline(pc, () => this.downstream.get(childId) === pc && this.recover(childId, pc));
  }

  // ── viewer ──
  assigned({ parent, mode, jitterMs }) {
    this.parentId = parent;
    this.mode = mode;
    this.jitterMs = jitterMs;
  }

  // The server recomputes buffers as the tree grows and hops get measured; applies live.
  setJitter(ms) {
    this.jitterMs = ms;
    for (const r of this.upstream?.getReceivers() ?? []) if ('jitterBufferTarget' in r) r.jitterBufferTarget = ms;
  }

  async acceptFrom(parentId, sdp, nid) {
    this.upstream?.close();
    const pc = (this.upstream = this.newPc(parentId, nid));
    pc.ontrack = (e) => {
      // Uniform latency for video AND its audio (A/V sync); deeper nodes already carry hop delay.
      if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = this.jitterMs;
      if (e.track.kind !== 'video') return; // fires once per track; forward once
      this.stream = e.streams[0];
      this.onStream(this.stream);
      // Pending children plus the ones we fed before a re-parent, each offered once.
      const ids = new Set([...this.pending, ...this.downstream.keys()]);
      this.pending.clear();
      for (const id of ids) this.offerTo(id);
    };
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: mungeBitrate(answer.sdp, MODES[this.mode].kbps) });
    this.send({ type: 'signal', to: parentId, data: { sdp: pc.localDescription, nid } });
  }

  child(id) {
    return this.stream ? this.offerTo(id) : this.pending.add(id);
  }

  childGone(id) {
    this.retries.delete(id);
    this.downstream.get(id)?.close();
    this.downstream.delete(id);
    this.pending.delete(id);
  }

  async signal(from, { sdp, candidate, nid }) {
    if (sdp?.type === 'offer') return this.acceptFrom(from, sdp, nid);
    const pc = from === this.parentId ? this.upstream : this.downstream.get(from);
    if (!pc || pc.nid !== nid) return; // answer/candidate of a negotiation we already replaced
    if (sdp && this.presenting && this.startKbps) return pc.setRemoteDescription({ type: sdp.type, sdp: mungeStartBitrate(sdp.sdp, this.startKbps) });
    if (sdp) return pc.setRemoteDescription(sdp);
    if (candidate) return pc.addIceCandidate(candidate).catch(() => {});
  }

  // Ends whatever role we had. Presenter stops capture.
  reset() {
    if (this.presenting) this.stream?.getTracks().forEach((t) => t.stop());
    this.upstream?.close();
    for (const pc of this.downstream.values()) pc.close();
    this.downstream.clear();
    this.pending.clear();
    this.retries.clear();
    Object.assign(this, { upstream: null, parentId: null, stream: null, presenting: false });
  }

  async stats() {
    const pcs = this.upstream ? [this.upstream] : [...this.downstream.values()];
    if (!pcs.length) return null;
    let bytes = 0, fps = 0, w = 0, h = 0, codec = '', rttMs = null;
    for (const pc of pcs) {
      const report = await pc.getStats();
      report.forEach((r) => {
        // RTT of the hop from our parent: the selected pair of the upstream connection.
        if (pc === this.upstream && r.type === 'transport' && r.selectedCandidatePairId) {
          const rtt = report.get(r.selectedCandidatePairId)?.currentRoundTripTime;
          if (rtt !== undefined) rttMs = rtt * 1000;
        }
        if (r.kind !== 'video' || (r.type !== 'inbound-rtp' && r.type !== 'outbound-rtp')) return;
        bytes += r.bytesReceived ?? r.bytesSent ?? 0;
        fps = Math.max(fps, r.framesPerSecond ?? 0);
        w = Math.max(w, r.frameWidth ?? 0);
        h = Math.max(h, r.frameHeight ?? 0);
        if (r.codecId) codec = report.get(r.codecId)?.mimeType?.split('/')[1] ?? codec;
      });
    }
    return { bytes, fps, w, h, codec, rttMs, children: this.downstream.size, viewer: Boolean(this.upstream) };
  }
}
