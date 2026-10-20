# ENTREGA-scaffold-mvp

Modo: 🔁 Loop. Plano: `PLANO-scaffold-mvp.md`. Data: 2026-10-19.

## Arquivos
- `package.json`, `.gitignore` — scaffold, dependência única `ws`.
- `server/topology.js` — cotas, árvore BFS, re-parent, buffer de sincronia.
- `server/topology.test.js` — 10 testes (`node:test`), todos verdes.
- `server/index.js` — HTTP (whitelist, `/health`) + sinalização WS (`maxPayload` 64 KB, signal só dentro da sala).
- `web/index.html`, `web/app.js` — host/viewer/relay WebRTC, `b=AS:`, `maxBitrate`, `jitterBufferTarget`.
- `README.md`.

## Verificação
- `npm test`: 10/10 aprovados.
- Smoke test WS: host 1440p60 com 20 Mbps → 1 conexão direta (buffer 120 ms); viewers 2 e 3 viram relay sob o viewer 1 (buffer 90 ms). `/../package.json` → 404.
- **Não verificado:** vídeo real entre abas (exige interação no navegador).

## Desvio do plano
`removeViewer` passou a reportar a subárvore inteira dos nós descartados (antes avisava só o filho direto) e ganhou um teste para isso.

## Pendências / próximos passos
1. Teste manual: `npm start`, 3+ abas, conferir bitrate em `chrome://webrtc-internals`.
2. Medir upload real e RTT por salto (`getStats`) em vez dos valores fixos.
3. TURN; cliente Tauri com captura nativa (exige Rust); bot do Discord.
4. UI real: passar por `design-de-interface-projeto`.
5. `git init` + primeiro commit (não feito: o projeto não era um repositório).
