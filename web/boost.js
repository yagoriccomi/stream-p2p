// Playback level above 100%. A media element's volume stops at 1, so beyond that the sound goes
// through WebAudio: the element keeps playing muted (Chrome feeds WebAudio silence from a remote
// stream no element plays) and a gain node plays the same stream louder. At or below 1 the
// element plays it alone, as it always did.
let ctx = null;
let sinkId = '';
const boosted = new WeakMap(); // element -> { stream, src, gain }

export function release(el) {
  const b = boosted.get(el);
  if (!b) return;
  b.src.disconnect();
  b.gain.disconnect();
  boosted.delete(el);
}

// level: 0..2 (1 = the stream as it arrives).
export function playAt(el, level, muted) {
  const stream = el.srcObject;
  if (level <= 1 || muted || !stream?.getAudioTracks().length) {
    release(el);
    el.volume = Math.min(1, level);
    el.muted = muted;
    return;
  }
  if (!ctx) {
    ctx = new AudioContext();
    if (sinkId) ctx.setSinkId?.(sinkId).catch(() => {});
  }
  ctx.resume().catch(() => {});
  let b = boosted.get(el);
  if (b?.stream !== stream) {
    release(el);
    b = { stream, src: ctx.createMediaStreamSource(stream), gain: ctx.createGain() };
    b.src.connect(b.gain).connect(ctx.destination);
    boosted.set(el, b);
  }
  b.gain.gain.value = level;
  el.muted = true;
}

export function setBoostSink(id) {
  sinkId = id;
  ctx?.setSinkId?.(id).catch(() => {});
}
