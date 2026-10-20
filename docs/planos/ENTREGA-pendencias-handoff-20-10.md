# ENTREGA-pendencias-handoff-20-10

Modo: 🔁 Loop. Plano: `PLANO-pendencias-handoff-20-10.md`. Data: 2026-10-20.

## Antes de começar
O `main` local estava 3 commits atrás de `origin/main`, e o handoff descrevia `fc5fb6f`. Fiz fast-forward (`--ff-only`); não havia mudanças locais.

## O que mudou
| Commit | Arquivos | O quê |
|---|---|---|
| `fix(pwa)` | `web/app.js` | Na primeira visita, o `clients.claim()` do service worker recarregava a página enquanto a pessoa digitava o apelido. Agora só recarrega quando é uma atualização. Era o que quebrava o e2e aqui. |
| `fix(video)` | `web/stream.js` | No re-parent, a resposta de uma oferta antiga caía na conexão nova e o filho ficava sem vídeo. Agora cada oferta leva um `nid`, e sinais de negociação substituída são ignorados. |
| `feat(ice)` | `server/ice.js` (+ teste), `server/index.js`, `web/app.js`, `README.md` | `GET /ice.json` com STUN + TURN do env. `TURN_SECRET` gera credencial temporária no padrão do coturn. O cliente renova a lista a cada hora. |
| `feat(latencia)` | `server/topology.js` (+ testes), `server/index.js`, `web/stream.js`, `web/app.js`, `e2e/run.js` | Buffers calculados pelo RTT medido (`hopRtt` → `jitter` ao vivo) e por um modelo que considera que o relay reenvia depois do próprio buffer. |
| `feat(upload)` | `server/index.js`, `web/app.js`, `web/index.html`, `web/styles.css`, `e2e/run.js` | `POST /speedtest` e botão **Medir** em T02. Na primeira vez mede sozinho e nunca sobrescreve o valor digitado. |
| `docs` | `README.md`, handoff, este arquivo, `web/sw.js` | Variáveis de TURN, limitações e e2e atualizados. `VERSION` do SW passa a `sp2p-v2` para avisar a nova versão. |

## Achado importante (medido, não suposto)
O e2e agora desenha um relógio em bits no vídeo falso, e cada espectador decodifica o horário para medir a latência ponta a ponta. Os números:

| Modelo | Buffers enviados | Latência medida | Diferença |
|---|---|---|---|
| Antigo (150 − 30 × profundidade) | relay 120, filhos 90/90 | 136 / 237 / 238 ms | ~100 ms |
| Novo (folga por saltos + RTT medido) | relay ~129, filhos ~0/0 | 139–147 / 166–185 ms | ~30 ms |

O modelo antigo ignorava que o relay reenvia o quadro **depois** do próprio jitter buffer.

## Verificação
- `npm test`: 37/37, com testes novos de credencial TURN, buffers, RTT medido, sincronia das folhas e re-parent.
- `npm run e2e`: `E2E OK` em 10 de 11 rodadas nesta máquina. A única falha foi um timeout em "Caio entrou", antes de qualquer transmissão, e não se repetiu nas 10 rodadas seguintes.
- `/speedtest` testado à mão: 200, 429 na terceira chamada em 10 s, 413 acima de 32 MB (pelo código).
- T02 conferida em captura de tela: botão "Medir de novo", "Medido agora" em verde e cota recalculada.

## Premissas
Ver P1–P6 no plano. As principais: o TURN padrão é o do operador (env), e o atraso de recodificar num relay é estimado em 20 ms.

## Não feito (e por quê)
- **1, 2, 3 (instalador, captura nativa, NVENC):** esta máquina não tem `rustc`/`cargo`. Instalar Rust e as Build Tools de C++ do Visual Studio é mudança de sistema e fica para a sua decisão.
- **6, 7 (bot do Discord, HTTPS público):** precisam de conta no Discord, domínio e deploy reais.
- O caminho "Usar este valor" foi testado só pelo e2e; o erro 503 de rede da medição não foi forçado.

## Próximos passos
1. Instalar a toolchain Rust + MSVC e gerar o instalador (`cd app && npm i && npm run build`).
2. Subir um coturn e definir `TURN_URLS` e `TURN_SECRET` no servidor publicado.
3. Reduzir a cota ao vivo quando `availableOutgoingBitrate` cair.
