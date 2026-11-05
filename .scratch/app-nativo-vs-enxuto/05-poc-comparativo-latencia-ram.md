---
Type: prototype
Status: claimed
Blocked by: 01, 02 (resolvidos)
---

# PoC do benchmark triplo

Decisões: `answers/2026_11_05 app-nativo-vs-enxuto 002.md`.

## Etapa 1 — atual e Edge enxuto (feita em 2026-11-05)

Bancada: `e2e/bench-relay.js` + `e2e/bench/relay.html` + `e2e/bench/relay-worker.js`. Transmissor → relay 1 → relay 2 → espectador, um Edge 156 por nó, 1080p60 com movimento, rede local limpa. Dados brutos em `e2e/bench/results/`; página com gráficos em `e2e/bench/relatorio.html` (publicada como artifact).

| Cenário | Atraso no espectador | Custo por salto | RAM transmissor / relay / espectador |
|---|---|---|---|
| Atual (recodifica) | 82 ms | 14–27 ms | 231 / 210 / 162 MB |
| Atual + flags de memória | 126 ms (variação da medida) | 24–43 ms | 224 / 198 / 139 MB |
| Repasse sem recodificar (Encoded Transform) | 34,5 s (fila crescente) | não sustenta | 230 / 196 / 153 MB |

Achados:
- O relay de hoje já fica abaixo de 100 ms ponta a ponta em rede limpa; o custo por salto (14–27 ms) passa da meta de 5 ms.
- O Edge descarta, sem erro, quadros repassados que não saíram do próprio codificador do envio. Só funciona trocando o conteúdo de um quadro de fachada (truque da criptografia ponta a ponta). A fachada nunca passa de ~30 quadros/s e cada salto corta pela metade. Testados sem efeito: maxFramerate 120/1000, fachada 2×2 e 1080p, `x-google-min-bitrate` 6000, MediaStreamTrackGenerator, canvas `captureStream(0)` e `(240)`, field trial `WebRTC-CongestionWindow`. Com isso o cenário 2 não se sustenta no navegador; o repasse sem recodificar fica para o motor nativo.
- O repasse sem recodificar corta a codificação do relay de ~355 para ~4 ms de CPU por segundo, o que mostra o ganho que o motor nativo pode buscar.
- As flags de memória do WebView2 economizam 7–23 MB por nó: pouco perto da meta.

Limites: rede ruim não medida (o TURN local + proxy não aguentam 3 × 8 Mbps: até o modo atual degrada); uma rodada por cenário; Edge sem janela, não o WebView2 real; vídeo saiu em 720p por limite de CPU do codificador por software, igual nos 3 cenários.

## Etapa 2a — relay nativo (feita em 2026-11-05)
Relays 1 e 2 trocados pelo relay em Rust (`e2e/bench/native`, `str0m` 0.25 em modo RTP): recebe os pacotes VP8 do pai e os escreve iguais para o filho, sem decodificar. Pedidos de quadro-chave sobem um a cada 500 ms. Transmissor e espectador continuam no Edge. Mesma rede limpa, ICE direto.

| Cenário | Atraso no espectador | Custo por salto | RAM por relay | CPU por relay |
|---|---|---|---|---|
| Sem relay (base: transmissor direto no espectador) | 53–56 ms | — | — | — |
| Atual (Edge recodifica) | 82 ms | ~14 ms | 210 MB | ~100 % de um núcleo |
| Relay nativo em Rust | 59–68 ms | ~2–7 ms | **4 MB** | **3 %** |

Achados:
- O relay nativo repassa os 8 Mbps e ~880 pacotes/s inteiros, sem perder quadros (espectador a 49–57 quadros/s, 0–1 congelamento).
- Custo por salto estimado em 2–7 ms (atraso nativo menos a base, dividido por 2): em torno da meta de 5 ms. O erro da leitura do relógio é de um quadro (±17 ms), então o número exato pede mais rodadas.
- RAM do relay cai de ~210 MB para 4 MB: 50× menos.

Limites: o relay nativo não mostra o vídeo (não decodifica); o espectador que também repassa, no app, precisaria decodificar uma vez para a tela. Duas rodadas, rede ruim não medida.

## Etapa 2b — transmissor nativo e captura real (feita em 2026-11-05)
Transmissor em Rust (`e2e/bench/native/src/bin/presenter.rs`): captura a janela com Windows.Graphics.Capture, converte BGRA→NV12 na GPU (processador de vídeo D3D11), codifica H.264 no `NVIDIA H.264 Encoder MFT` (Media Foundation, NVENC) e envia com `str0m`. Os relays Rust repassam H.264 (`SP2P_CODEC=h264`).

Para comparar de forma justa, a "tela do jogo" virou uma janela real do Edge (canvas 1080p60 com o relógio), mantida no topo. O transmissor do Edge passa a capturá-la com `getDisplayMedia`, como o app faz (`BENCH_SCREEN=1`). Duas a três rodadas por cenário, rede limpa, ICE direto.

| Cenário (captura real da janela) | Atraso no espectador | Sem relay (base) | Quadros/s · altura | RAM transmissor / relay | CPU do transmissor |
|---|---|---|---|---|---|
| App de hoje (Edge captura + VP8 por software, relays Edge) | 190–243 ms | 90–111 ms | 32–46 · 801p | 228 / ~215 MB | 111–170 % |
| Edge captura + relays Rust | 115–183 ms | — | 32–49 · 801p | 227 / 3 MB | 81–146 % |
| **100 % Rust (WGC + NVENC + str0m)** | **87–103 ms** | **74–86 ms** | **60 · 1070p** | **30 / 3 MB** | **~10 %** |

Achados:
- Com a captura real, o app de hoje fica acima da meta: 190–243 ms no espectador. O codificador VP8 por software do Edge satura a CPU, cai para 801p e 32–46 quadros/s.
- 100 % Rust: 87–103 ms ponta a ponta, 1080p60 cravado, zero congelamentos. A conversão de cor leva 0,6 ms e a codificação 4,6 ms por quadro. Custo por salto ~7 ms (média com relays menos média da base, dividido por 2), perto da meta de 5 ms.
- RAM: transmissor de 228 para 30 MB, relay de ~215 para 3 MB.
- Só os relays Rust, com o transmissor do Edge, já cortam o atraso, mas o transmissor do Edge vira o gargalo.

Limites: o codec é diferente (H.264 por hardware no nativo, VP8 por software no Edge). O app real, no WebView2, pode usar H.264 por hardware, e isso diminuiria a diferença no transmissor (medir na ADR). A janela-fonte fica "sempre no topo" durante a medição, porque o Windows para de atualizar janela coberta. Rede ruim não medida. Os relays nativos não mostram vídeo.
