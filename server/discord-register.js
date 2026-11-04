// Registers /stream criar on the Discord app. Run once, or after changing the command:
//   node --env-file=.env server/discord-register.js
// Needs DISCORD_ID (Application ID) and DISCORD_BOT_TOKEN (Bot tab). The token stays in .env, out of Git.
const { DISCORD_ID: id, DISCORD_BOT_TOKEN: token } = process.env;
if (!id || !token) {
  console.error('Defina DISCORD_ID e DISCORD_BOT_TOKEN no .env.');
  process.exit(2);
}

import { CALL_COMMAND, MODE_CHOICES } from './discord.js';

const commands = [{
  name: 'stream',
  description: 'Transmissão de tela P2P',
  options: [
    { type: 1, name: 'criar', description: 'Abre uma sessão e posta o botão Entrar', options: [
      { type: 5, name: 'dono', description: 'Você vira dono(a) da sessão (padrão: sim)' },
      { type: 3, name: 'qualidade', description: 'Qualidade sugerida para quem transmitir', choices: MODE_CHOICES.map((m) => ({ name: m, value: m })) },
    ] },
    { type: 1, name: 'status', description: 'Sessões abertas neste servidor' },
    { type: 1, name: 'convite', description: 'Posta de novo o botão da última sessão' },
    { type: 1, name: 'encerrar', description: 'Encerra a última sessão que você criou aqui' },
    { type: 1, name: 'app', description: 'Link do app para Windows' },
    { type: 1, name: 'help', description: 'Explica as funções e dá dicas' },
  ],
}, { type: 2, name: CALL_COMMAND }];

// PUT replaces the whole global set: running it twice is harmless.
const res = await fetch(`https://discord.com/api/v10/applications/${encodeURIComponent(id)}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(commands),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Discord respondeu ${res.status}:`, JSON.stringify(body));
  process.exit(1);
}
console.log(`Registrado: ${body.map((c) => `/${c.name}`).join(', ')}`);
