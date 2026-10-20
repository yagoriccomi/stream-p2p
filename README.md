# stream-p2p

Transmissão de tela P2P híbrida (Mesh + Árvore/Relay). Ver `handoff_stream_p2p_architecture.md`.

## Rodar
```bash
npm install
npm test     # lógica de cotas/árvore
npm start    # http://localhost:3000  (PORT para mudar)
```
## Testar
**Automático:** `npm run e2e`. Sobe o servidor e abre Chrome headless com 1 host (1440p60, 20 Mbps) e 3 viewers. Confere vídeo em todos, topologia (1 direto, 2 via relay) e re-parent quando o relay sai. Use `HEADFUL=1` para ver as janelas e `CHROME_PATH` para outro navegador.

**Manual, mesma máquina:**
1. Rode `npm start`.
2. Em `http://localhost:3000`, clique **Compartilhar tela**.
3. Clique **Copiar** no convite.
4. Abra o convite em 2–3 abas.
5. Bitrate e fps aparecem na linha de estatísticas e em `chrome://webrtc-internals`.

**Manual, LAN:** o host abre em `localhost` (captura de tela exige contexto seguro). Os amigos abrem `http://<seu-IP>:3000/?room=<sala>`. Libere a porta 3000 no firewall do Windows. Fora da LAN precisa de TURN, ainda não implementado.

> Em uma única máquina a resolução cai (o CPU codifica para todos). O teste real de qualidade é com PCs separados.

## Como funciona
- `server/topology.js` — cota direta = `floor(upload × 0.8 / bitrate do modo)`; excedentes vão para o nó mais raso com vaga (relay, máx. 2 filhos). Saída de relay re-pendura os filhos.
- `server/index.js` — HTTP estático + WebSocket de sinalização (`host`, `join`, `signal`).
- `web/app.js` — `getDisplayMedia`, WebRTC, `b=AS:` + `maxBitrate` para destravar bitrate, `jitterBufferTarget` = 150 ms − 30 ms × profundidade.

| Modo | Bitrate |
|---|---|
| 720p30 | 4 Mbps |
| 1080p60 | 8 Mbps |
| 1440p60 | 15 Mbps |

## Limitações (MVP)
Upload declarado (não medido), só STUN (sem TURN), relay re-codifica no navegador, estado em memória, sem Tauri/NVENC nativo nem bot do Discord.
