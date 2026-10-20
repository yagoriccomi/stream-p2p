# PLANO-scaffold-mvp

Modo: 🔁 Loop (sem confirmação). Fonte: `handoff_stream_p2p_architecture.md` §2 (passos 1–3).

## Enunciado canônico
- **Problema:** projeto vazio; arquitetura híbrida Mesh + Árvore/Relay só existe no papel.
- **Resultado esperado:** servidor de sinalização Node/WebSocket que atribui cotas (direto no host vs. relay) + cliente web MVP que transmite tela via WebRTC com bitrate destravado (`b=AS:`) nos modos 720p30/1080p60/1440p60.
- **Como validar:** `npm test` verde (lógica de cotas/árvore); `npm start`, abrir host + 2..N espectadores em abas, ver vídeo chegar e espectadores excedentes virarem relay.

## Escopo negativo [#8]
- Sem cliente nativo Tauri / captura zero-copy (DXGI/NVENC) — Rust não instalado; fase seguinte.
- Sem bot do Discord.
- Sem TURN, autenticação, persistência, deploy.

## Premissas assumidas (Loop)
1. Upload é **declarado** pelo usuário (campo na tela), não medido — medição real exige endpoint de speedtest; adiar [#8].
2. Bitrates: 720p30=4 Mbps, 1080p60=8 Mbps, 1440p60=15 Mbps (handoff cita ~15 Mbps p/ 1440p60). Folga de 80% do upload.
3. Novo espectador pendura no nó **mais raso** com vaga (BFS) → menor latência. Saída de nó re-pendura filhos (com subárvore).
4. Sincronia de latência: `jitterBufferTarget = max(0, 150 − profundidade × 30 ms)`; atraso estimado por salto fixo.
5. Relay em navegador re-codifica (decode+encode) — aceitável no MVP.
6. Host sair = sala encerrada.

## Decisão visual
Mockup: **não** — tela é bancada de teste técnico descartável (botões + vídeo). `design-de-interface-projeto` fica **pendente** para a UI real (próxima fase).

## Passos atômicos
| # | Arquivo | Mudança | Prática | Verificação |
|---|---|---|---|---|
| 1 | `package.json`, `.gitignore` | scaffold, dep única `ws` | [#7][#40] | `npm install` ok |
| 2 | `server/topology.js` | lógica pura de cotas/árvore/buffer | [#2][#3][#30] | testes passo 3 |
| 3 | `server/topology.test.js` | testes `node:test` incl. falhas (sala cheia, saída de relay) | [#41][#46] | `npm test` |
| 4 | `server/index.js` | HTTP estático (whitelist) + WS sinalização | [#22][#51][#65] | smoke test WS |
| 5 | `web/index.html`, `web/app.js` | captura, WebRTC, relay, `b=AS:`, buffer | [#1][#9] | teste manual em abas |
| 6 | `README.md` | instalar/rodar/arquitetura | [#96] | leitura |

## Riscos e rollback
- `jitterBufferTarget` só Chrome/Edge ≥114 → fallback silencioso (sem sincronia). Rollback: projeto novo, `git revert`.
- Sem TURN: NAT simétrico falha; teste local ok.

## Definição de Pronto
- [ ] `npm test` verde
- [ ] servidor sobe e responde join/assign via WS
- [ ] ENTREGA-scaffold-mvp.md escrito
