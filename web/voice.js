// Session voice: an audio-only mesh between all members, no jitter target (real time).
// Every pair has one connection; the lower id offers, so both sides never offer at once.
// The audio transceiver exists from the start (sendrecv), so turning the mic on or off,
// changing device or gain is a replaceTrack — never a renegotiation.
export class VoiceMesh {
  constructor({ send, log, getIce, onError }) {
    Object.assign(this, { send, log, getIce, onError });
    this.me = null;
    this.peers = new Map(); // id -> { pc, el }
    this.raw = null; // getUserMedia stream
    this.ctx = null;
    this.gain = null;
    this.out = null; // processed track sent to peers
    this.micOn = false;
    this.ptt = false;
    this.pttDown = false;
    this.opts = { noiseSuppression: true, echoCancellation: true, deviceId: '', gain: 1 };
    this.volumes = new Map(); // id -> 0..1 (local only)
    this.localMute = new Set();
    this.master = 1;
    this.deafened = false;
    this.sinkId = '';
  }

  // Ask for the mic only on a click. A denial never blocks the session: we stay listen-only.
  async enableMic() {
    if (!this.raw) {
      try {
        this.raw = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: this.opts.noiseSuppression,
            echoCancellation: this.opts.echoCancellation,
            autoGainControl: true,
            ...(this.opts.deviceId && { deviceId: { exact: this.opts.deviceId } }),
          },
        });
      } catch (e) {
        this.onError(e);
        return false;
      }
      this.ctx ??= new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.raw);
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.opts.gain;
      const dest = this.ctx.createMediaStreamDestination();
      src.connect(this.gain).connect(dest);
      this.out = dest.stream.getAudioTracks()[0];
      for (const { pc } of this.peers.values()) this.attachMic(pc);
    }
    this.micOn = true;
    this.applyMic();
    return true;
  }

  disableMic() {
    this.micOn = false;
    this.applyMic();
  }

  applyMic() {
    if (this.out) this.out.enabled = this.micOn && (!this.ptt || this.pttDown);
  }

  setPtt(on) {
    this.ptt = on;
    this.applyMic();
  }

  setPttDown(down) {
    this.pttDown = down;
    this.applyMic();
  }

  setGain(g) {
    this.opts.gain = g;
    if (this.gain) this.gain.gain.value = g;
  }

  // Device / processing change: rebuild the raw capture, keep the same senders.
  async reconfigure(patch) {
    Object.assign(this.opts, patch);
    if (!this.raw) return;
    const wasOn = this.micOn;
    this.raw.getTracks().forEach((t) => t.stop());
    this.raw = null;
    if (wasOn) await this.enableMic();
  }

  attachMic(pc) {
    const t = pc.getTransceivers()[0];
    t?.sender.replaceTrack(this.out ?? null).catch((e) => this.log(`voz replaceTrack: ${e.message}`));
  }

  newPc(id) {
    const pc = new RTCPeerConnection({ iceServers: this.getIce() });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.attachMic(pc);
    pc.onicecandidate = (e) => e.candidate && this.send({ type: 'vsignal', to: id, data: { candidate: e.candidate } });
    pc.onconnectionstatechange = () => this.log(`voz ${id.slice(0, 6)}: ${pc.connectionState}`);
    const el = new Audio();
    el.autoplay = true;
    if (this.sinkId && el.setSinkId) el.setSinkId(this.sinkId).catch(() => {});
    pc.ontrack = (e) => {
      el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      el.play().catch(() => {});
    };
    this.peers.set(id, { pc, el });
    this.applyVolume(id);
    return pc;
  }

  // Called on every session snapshot: connect to newcomers, drop who left.
  async sync(me, memberIds) {
    this.me = me;
    const want = new Set(memberIds.filter((id) => id !== me));
    for (const id of this.peers.keys()) if (!want.has(id)) this.drop(id);
    for (const id of want) {
      if (this.peers.has(id) || me > id) continue; // the lower id offers
      const pc = this.newPc(id);
      const offer = await pc.createOffer();
      // A snapshot or an incoming offer may have replaced this pc while we awaited.
      if (this.peers.get(id)?.pc !== pc) continue;
      await pc.setLocalDescription(offer);
      if (this.peers.get(id)?.pc !== pc) continue;
      this.send({ type: 'vsignal', to: id, data: { sdp: pc.localDescription } });
    }
  }

  async signal(from, { sdp, candidate }) {
    let pc = this.peers.get(from)?.pc;
    if (sdp?.type === 'offer') {
      this.drop(from);
      pc = this.newPc(from);
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      if (this.peers.get(from)?.pc !== pc) return;
      await pc.setLocalDescription(answer);
      return this.send({ type: 'vsignal', to: from, data: { sdp: pc.localDescription } });
    }
    if (sdp) return pc?.setRemoteDescription(sdp);
    if (candidate) return pc?.addIceCandidate(candidate).catch(() => {});
  }

  drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    p.pc.close();
    p.el.srcObject = null;
    this.peers.delete(id);
  }

  // ── mixer (local only) ──
  setVolume(id, v) {
    this.volumes.set(id, v);
    this.applyVolume(id);
  }

  setLocalMute(id, muted) {
    if (muted) this.localMute.add(id);
    else this.localMute.delete(id);
    this.applyVolume(id);
  }

  setMaster(v) {
    this.master = v;
    for (const id of this.peers.keys()) this.applyVolume(id);
  }

  setDeafened(on) {
    this.deafened = on;
    for (const id of this.peers.keys()) this.applyVolume(id);
  }

  applyVolume(id) {
    const p = this.peers.get(id);
    if (!p) return;
    p.el.volume = Math.min(1, (this.volumes.get(id) ?? 1) * this.master);
    p.el.muted = this.deafened || this.localMute.has(id);
  }

  async setSink(sinkId) {
    this.sinkId = sinkId;
    for (const { el } of this.peers.values()) await el.setSinkId?.(sinkId).catch(() => {});
  }

  leave() {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.raw?.getTracks().forEach((t) => t.stop());
    this.raw = null;
    this.out = null;
    this.micOn = false;
  }
}
