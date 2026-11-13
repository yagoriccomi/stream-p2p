// Dev helper: fills a session with fake people so the layout can be checked with a crowd.
// Usage: node scripts/fake-people.js <code> [count] [url]
//   node scripts/fake-people.js ABCD-1234 4 ws://localhost:3017
// Each fake person joins, answers the server's pings, says hi in the chat, and stays until Ctrl+C.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const [code, count = '4', url = 'ws://localhost:3000'] = process.argv.slice(2);
if (!code) {
  console.error('Uso: node scripts/fake-people.js <código> [quantidade] [ws://host:porta]');
  process.exit(1);
}
const NAMES = ['Léo', 'Bia', 'Caio', 'Duda', 'Rafa', 'Nina', 'Theo', 'Malu'];
const HELLO = ['oi gente', 'cheguei', 'bora', 'tô ouvindo', 'eae'];

for (let i = 0; i < Number(count); i++) {
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${i}` : '');
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code, name, device: randomUUID() })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'session' || msg.type === 'joined') {
      setTimeout(() => ws.send(JSON.stringify({ type: 'chat', text: HELLO[i % HELLO.length] })), 500 + i * 400);
    }
    if (msg.type === 'error') console.error(`${name}: ${msg.code} ${msg.message ?? ''}`);
  });
  ws.on('close', () => console.log(`${name} saiu`));
  console.log(`${name} entrando…`);
}
