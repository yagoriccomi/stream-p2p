import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRoom, addViewer, removeViewer, jitterTargetMs, MODES } from './topology.js';

const PORT = Number(process.env.PORT) || 3000;
const MAX_MSG_BYTES = 64 * 1024; // SDP + ICE fit easily; blocks memory abuse [#65]
const STATIC = {
  // whitelist: no path traversal possible [#51]
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
};

const http = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/health') return res.end('ok'); // [#82]
  const entry = STATIC[path];
  if (!entry) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': entry[1] });
  res.end(await readFile(new URL(`../${entry[0]}`, import.meta.url)));
});

// ponytail: in-memory state, single process. Move to Redis when horizontal scaling is needed [#27].
const rooms = new Map(); // roomId -> topology room
const clients = new Map(); // clientId -> { ws, roomId }

const send = (id, msg) => clients.get(id)?.ws.send(JSON.stringify(msg));

function notifyAssigned(room, id, parent) {
  send(id, { type: 'assigned', parent, mode: room.mode, jitterMs: jitterTargetMs(room, id) });
  send(parent, { type: 'child', id });
}

function leave(id) {
  const client = clients.get(id);
  clients.delete(id);
  const room = client?.roomId && rooms.get(client.roomId);
  if (!room) return;

  if (id === room.hostId) {
    for (const nodeId of room.nodes.keys()) send(nodeId, { type: 'ended' });
    rooms.delete(client.roomId);
    return;
  }
  const parent = room.nodes.get(id)?.parent;
  for (const { id: childId, parent: newParent } of removeViewer(room, id)) {
    if (newParent) notifyAssigned(room, childId, newParent);
    else send(childId, { type: 'ended', reason: 'room full' });
  }
  if (parent) send(parent, { type: 'childGone', id });
}

function handle(id, msg) {
  const client = clients.get(id);
  switch (msg.type) {
    case 'host': {
      if (client.roomId) return send(id, { type: 'error', error: 'already in a room' });
      const roomId = randomUUID().slice(0, 8);
      rooms.set(roomId, createRoom(id, msg.mode, Number(msg.uploadKbps)));
      client.roomId = roomId;
      return send(id, { type: 'room', room: roomId, mode: msg.mode });
    }
    case 'join': {
      if (client.roomId) return send(id, { type: 'error', error: 'already in a room' });
      const room = rooms.get(String(msg.room));
      if (!room) return send(id, { type: 'error', error: 'room not found' });
      const parent = addViewer(room, id);
      if (!parent) return send(id, { type: 'error', error: 'room full' });
      client.roomId = msg.room;
      return notifyAssigned(room, id, parent);
    }
    case 'signal': {
      // only relay between members of the same room
      if (!client.roomId || clients.get(msg.to)?.roomId !== client.roomId) return;
      return send(msg.to, { type: 'signal', from: id, data: msg.data });
    }
    default:
      send(id, { type: 'error', error: 'unknown type' });
  }
}

new WebSocketServer({ server: http, maxPayload: MAX_MSG_BYTES }).on('connection', (ws) => {
  const id = randomUUID();
  clients.set(id, { ws, roomId: null });
  ws.send(JSON.stringify({ type: 'hello', id, modes: Object.keys(MODES) }));
  ws.on('message', (raw) => {
    try {
      handle(id, JSON.parse(raw));
    } catch (err) {
      send(id, { type: 'error', error: err.message });
    }
  });
  ws.on('close', () => leave(id));
});

http.listen(PORT, () => console.log(`stream-p2p em http://localhost:${PORT}`));
