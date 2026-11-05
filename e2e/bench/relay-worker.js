// Encoded relay (prototype, ticket 05 scenario 2): forwards the parent's encoded video frames
// to every child without decoding or re-encoding them. The relay still decodes once for its own
// screen (it is also a viewer).
//
// Chromium (Edge 156) silently drops frames written to a sender that its own encoder did not
// produce, even copies with fixed metadata. So each child sender carries a 2x2 placeholder
// track fed on demand: for every parent frame the page pushes one tiny frame into that track,
// the sender's encoder turns it into a ~20-byte frame, and here its payload is swapped for the
// parent's. Same mechanism as end-to-end encryption, which Chromium accepts.
let upstream = null; // receiver transformer
const children = new Map(); // id -> { writer, queue, waitingKey }
let lastKeyAsk = 0;
const stats = { in: 0, out: 0, keys: 0, keyAsks: 0, dropped: 0, queueMax: 0, swapMs: 0 };

function askKey() {
  const now = performance.now();
  if (!upstream || now - lastKeyAsk < 500) return; // throttle: no PLI storm up the tree
  lastKeyAsk = now;
  stats.keyAsks++;
  upstream.sendKeyFrameRequest().catch(() => {});
}

onrtctransform = async ({ transformer }) => {
  const { role, id } = transformer.options;
  if (role === 'receiver') {
    upstream = transformer;
    const writer = transformer.writable.getWriter();
    const reader = transformer.readable.getReader();
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) return;
      stats.in++;
      const key = frame.type === 'key';
      if (key) stats.keys++;
      if (children.size) {
        const item = { data: frame.data.slice(0), key, at: performance.now() };
        for (const c of children.values()) {
          c.queue.push(item);
          stats.queueMax = Math.max(stats.queueMax, c.queue.length);
        }
        postMessage('tick'); // page pushes one placeholder frame
      }
      writer.write(frame);
    }
  }
  const c = { writer: transformer.writable.getWriter(), queue: [], waitingKey: true };
  children.set(id, c);
  askKey();
  const reader = transformer.readable.getReader();
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) { children.delete(id); return; }
    // The placeholder encoder emits a key frame when the child asks for one (PLI/FIR): pass the
    // request up. Never drop a placeholder frame: a gap in its frame ids makes the child ask for
    // a key frame again, and the requests snowball up the tree.
    if (frame.type === 'key' && c.started) askKey();
    c.started = true;
    let item = c.queue.shift();
    if (c.waitingKey) {
      const k = c.queue.findIndex((x) => x.key);
      if (!item?.key && k >= 0) { stats.dropped += k + 1; item = c.queue.splice(0, k + 1).pop(); }
    }
    if (!item || (c.waitingKey && !item.key)) { if (item) stats.dropped++; c.writer.write(frame); continue; } // tiny 2x2 frame
    c.waitingKey = false;
    frame.data = item.data;
    stats.swapMs += performance.now() - item.at;
    stats.out++;
    c.writer.write(frame);
  }
};

onmessage = (e) => { if (e.data === 'stats') postMessage({ ...stats, swapMsAvg: stats.out ? +(stats.swapMs / stats.out).toFixed(2) : null }); };
