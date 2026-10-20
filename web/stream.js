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
    this.audioOn = true;
  }

  // nid tags one negotiation: after a re-parent a relay may re-offer while the child's answer
  // to the previous offer is still in flight; that stale answer must not hit the new pc.
  newPc(peerId, nid) {
    const pc = new RTCPeerConnection({ iceServers: this.getIce() });
    pc.nid = nid;
    pc.onicecandidate = (e) => e.candidate && this.send({ type: 'signal', to: peerId, data: { candidate: e.candidate, nid } });
    pc.onconnectionstatechange = () => this.log(`vídeo ${peerId.slice(0, 6)}: ${pc.connectionState}`);
    return pc;
  }

  // ── presenter ──
  present(stream, mode) {
    this.reset();
    this.presenting = true;
    this.stream = stream;
    this.mode = mode;
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
    const pc = this.newPc(childId, crypto.randomUUID().slice(0, 8));
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
    this.downstream.get(id)?.close();
    this.downstream.delete(id);
    this.pending.delete(id);
  }

  async signal(from, { sdp, candidate, nid }) {
    if (sdp?.type === 'offer') return this.acceptFrom(from, sdp, nid);
    const pc = from === this.parentId ? this.upstream : this.downstream.get(from);
    if (!pc || pc.nid !== nid) return; // answer/candidate of a negotiation we already replaced
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
