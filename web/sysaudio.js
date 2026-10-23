// System audio captured by the Windows app (app/src-tauri/src/sysaudio.rs) as a MediaStreamTrack.
// Chromium's own system audio fails on some devices and takes the screen down with it; the app's
// WASAPI loopback does not. Interleaved stereo f32 chunks arrive over a Tauri channel and an
// AudioWorklet plays them, from a short queue, into a MediaStreamAudioDestinationNode.
const PRIME_S = 0.03; // wait for this much before playing, so 10 ms chunks do not click
const MAX_S = 0.2; // beyond this, drop the oldest audio: latency stays low

const WORKLET = `
class SysAudio extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    Object.assign(this, { prime: o.prime, max: o.max, q: [], off: 0, frames: 0, playing: false });
    this.port.onmessage = ({ data }) => {
      const f = new Float32Array(data);
      this.q.push(f);
      this.frames += f.length / 2;
      while (this.frames > this.max && this.q.length > 1) {
        this.frames -= (this.q.shift().length - this.off) / 2;
        this.off = 0;
      }
    };
  }
  process(_, [[l, r]]) {
    if (!this.playing && this.frames < this.prime) return true; // outputs stay at zero
    this.playing = true;
    let i = 0;
    while (i < l.length && this.q.length) {
      const f = this.q[0];
      for (; i < l.length && this.off < f.length; i++, this.off += 2) { l[i] = f[this.off]; r[i] = f[this.off + 1]; }
      if (this.off >= f.length) { this.q.shift(); this.off = 0; }
    }
    this.frames -= i;
    if (i < l.length) this.playing = false; // ran dry: prime again
    return true;
  }
}
registerProcessor('sysaudio', SysAudio);
`;

// Resolves to the track, or rejects when the app has no such command (older app) or the
// capture does not start. Call it straight from a click: the AudioContext needs the gesture.
export async function nativeSystemAudio({ core }) {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const out = new core.Channel();
  let node = null;
  out.onmessage = (data) => {
    const buf = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    node?.port.postMessage(buf, [buf]);
  };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const rate = ctx.sampleRate;
    node = new AudioWorkletNode(ctx, 'sysaudio', {
      numberOfInputs: 0, outputChannelCount: [2], processorOptions: { prime: rate * PRIME_S, max: rate * MAX_S },
    });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    await core.invoke('system_audio_start', { out });
    await ctx.resume();
    const [track] = dest.stream.getAudioTracks();
    // Narrows the sound to the program behind a shared window (its HWND), so the voice chat,
    // ours or Discord's, does not go back to the friend. On failure the whole PC minus the app
    // comes back: the stream keeps sound, and the caller is told.
    track.focusWindow = async (window) => {
      try {
        await core.invoke('system_audio_start', { out, window });
      } catch (e) {
        await core.invoke('system_audio_start', { out });
        throw e;
      }
    };
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      core.invoke('system_audio_stop').catch(() => {});
      ctx.close();
    };
    return track;
  } catch (e) {
    ctx.close();
    throw e;
  }
}
