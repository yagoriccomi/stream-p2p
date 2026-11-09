---
Type: prototype
Status: resolved
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

## Etapa 2c — Edge com H.264 por hardware (feita em 2026-11-05)
Opção `BENCH_CODEC` na bancada: `h264` força o perfil baseline 42e01f (o mesmo do Rust); `h264any` aceita qualquer perfil H.264 com packetization-mode=1. Também `BENCH_HEADFUL` e `BENCH_EDGEARGS` para testar flags.

Achados:
- Com o baseline 42e01f o Edge **não usa a placa de vídeo**: cai no OpenH264 (software), mesmo com `--enable-features=MediaFoundationH264CbpEncoding`. Fica pior que o VP8: 369 ms no espectador, 398p.
- Com outro perfil (`h264any`) o Edge usa o `NVIDIA H.264 Encoder MFT`, o mesmo codificador do transmissor nativo.
- O `edge://gpu` confirma codificação H.264 por hardware até 1080p a 121 quadros/s; o `mediaCapabilities` diz o contrário (`powerEfficient: false`), então não serve para detectar.

| Cenário (captura real, rede boa) | Atraso no espectador | Quadros/s · altura | RAM transmissor / relay | CPU transmissor |
|---|---|---|---|---|
| App de hoje com H.264 por hardware (relays Edge recodificam) | **97–120 ms** | 46 · 534p | 210 / ~190 MB | ~60 % |
| 100 % Rust (etapa 2b) | 87–103 ms | 60 · 1070p | 30 / 3 MB | ~10 % |

- Só trocar o codec do app de hoje para H.264 por hardware corta o atraso de 190–243 ms para ~100 ms. Mas a imagem cai para 534p a 46 quadros/s. Pelos dados, a queda parece vir da captura `getDisplayMedia` e da adaptação do WebRTC, não do codificador.
- A primeira rodada de cada configuração foi instável (1 quadro/s, atrasos absurdos), provavelmente pelo aquecimento do codificador. As rodadas seguintes repetiram 97–120 ms.
- O repasse sem decodificar no Edge (`encoded`) **não funcionou com H.264**: o relay 2 não recebeu nada. A técnica da "fachada" foi feita para VP8.
- O relay Rust aceita só o perfil 42e01f. Para combinar Edge com H.264 por hardware e relays Rust, falta aceitar outros perfis (640c1f / 42e01f com o perfil que o Edge oferece).

Conclusão parcial histórica: o H.264 por hardware fecha boa parte da diferença de **atraso** entre o app enxuto e o nativo. As diferenças de **RAM** (210 vs 30 MB; relay 190 vs 3 MB) e de **qualidade** (534p46 vs 1080p60) continuam. A comparação envolve resoluções diferentes; não demonstra vantagem com qualidade equivalente.

## Retomada — itens 3 e 4 (2026-11-06)

Dados exploratórios preservados em `e2e/bench/results/`. Todas as rodadas abaixo contam, inclusive as instáveis. **Aquecimento não foi demonstrado**; as menções anteriores são hipóteses, não justificativa para excluir amostras. Nenhuma destas séries comprova atendimento estável às metas.

| Arquivo JSON (sem extensão) | Latência espectador (ms) | FPS recebidos | Altura recebida | RAM transmissor / relays (MB) |
|---|---:|---:|---:|---|
| tela-relay-rust-h264hw-1 | 116 | 28 | 534 | 192 / 4, 3 |
| tela-relay-rust-h264hw-2 | 75 | 48 | 534 | 192 / 3, 3 |
| tela-relay-rust-h264hw-3 | 83 | 49 | 534 | 190 / 3, 3 |
| diag-captura-h264hw | 82 | 48 | 534 | 191 / 3, 3 |
| diag-captura-h264hw-mres-1 | 79 | 48 | 712 | 182 / 3, 3 |
| diag-captura-h264hw-mres-2 | 247 | 46 | 712 | 182 / 3, 3 |
| diag-native-size | 66 | 15 | 712 | 29 / 3, 3 |
| diag-native-1080 | 80 | 53 | 1072 | 29 / 3, 3 |
| diag-captura-h264hw-1080 | 299 | 26 | 720 | 230 / 3, 3 |
| diag-captura-h264hw-1080-2 | 180 | 28 | 804 | 212 / 3, 4 |
| diag-captura-h264hw-1080-3 | 170 | 31 | 804 | 215 / 3, 3 |
| diag-captura-h264hw-1080-mres-1 | 2689 | 15 | 1072 | 201 / 4, 3 |
| diag-captura-h264hw-1080-mres-2 | 103 | 22 | 1072 | 203 / 3, 3 |

### O que os dados sustentam

- Edge H.264 com relays Rust funcionou neste ambiente usando o perfil configurado `42001f`; `encoderImplementation` registrou `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`. O perfil, sozinho, não garante hardware em outras máquinas. A primeira série inteira ficou em **75–116 ms**, 28–49 FPS e 534p.
- Em `diag-captura-h264hw`, a captura reportou **1266×712**, configuração de 60 FPS, entrega medida de 48 quadros/s. A saída foi 534p (712 × 0,75), com `qualityLimitationReason=bandwidth` durante todo o intervalo observado. Isso aponta adaptação após a captura; não prova falta de capacidade física da rede local.
- `maintain-resolution` preservou 712p nas duas rodadas menores, mas a latência variou de **79 a 247 ms**. Preservar resolução não garante latência nem FPS.
- A janela passou a ser solicitada em 1920×1080 com escala do navegador 1. A captura efetiva variou: **1920×1080** em uma rodada, **1906×1072** nas seguintes. Dimensão solicitada não é dimensão capturada; a causa da diferença histórica de escala não foi isolada.
- Com captura maior e `balanced`, saída de 720/804p, **170–299 ms**, 26–31 FPS; limitação reportada de banda. Com `maintain-resolution`, saída de 1072p, **103–2689 ms**, 15–22 FPS. Não há melhoria estável demonstrada.
- O diagnóstico nativo em 1072p recebeu 53 FPS e 80 ms, com um congelamento. Uma rodada não demonstra 60 FPS estáveis. `diag-native-size` usou intervalos menores (8 s de estabilização, 5 s de medição); não deve ser agregado às rodadas padrão.

### Campanha controlada adicional — 2026-11-06

24 execuções sequenciais, sem descarte de amostras: `controle-20261106-{decode,native,native-full}-{base,cadeia}-{1,2,3}.json` e `controle-20261106-native-mres-{base,cadeia}-{1,2,3}.json`. Captura real, ICE direto, rede local; estabilização solicitada de 20 s e medição de 15 s. Metadados incluem codec negociado e dimensões finais. As bases `native` são Edge → Edge, sem processo Rust.

Valores separados por vírgulas seguem a ordem das repetições 1, 2 e 3. Latência é a mediana de cada rodada, não percentil de toda a sessão.

| Cenário | Base (ms) | Cadeia (ms) | Dimensão final base / cadeia | FPS base / cadeia |
|---|---|---|---|---|
| Edge + relays Edge, balanced | 61, 63, 56 | 98, 94, 69 | 952×536 em todas | 48, 48, 51 / 48, 48, 51 |
| Edge + relays Rust, balanced | 58, 123, 124 | 74, 72, 71 | base: 952×536, 1428×804, 952×536; cadeia: 952×536 | 48, 32, 32 / 48, 48, 51 |
| Transmissor e relays Rust | 44, 41, 42 | 69, 57, 86 | 1906×1072 em todas | 62, 62, 63 / 62, 63, 62 |
| Edge + relays Rust, maintain-resolution | 63, 67, 70 | 86, 90, 82 | 1906×1072 em todas | 22, 22, 22 / 22, 22, 18 |

- Perfil recebido: `42001f` nas séries Edge; `42e01f` no transmissor Rust. Mesmo perfil dentro de cada par; perfis diferentes entre transmissores.
- Zero congelamentos nas 18 rodadas balanced. Maintain-resolution: um congelamento na terceira cadeia; zero nas outras cinco rodadas.
- RAM nas cadeias: Edge balanced, transmissor 206–213 MB e relays Edge 188–191 MB; Edge/Rust balanced, transmissor 210–212 MB e relays 3 MB; transmissor Rust 29–30 MB e relays 3 MB; Edge maintain-resolution, transmissor 199–202 MB e relays 3–4 MB. São processos da bancada, não app completo.
- Captura Edge da série maintain-resolution: 1906×1072, configuração de 60 FPS, entrega medida de 51–52 FPS; receptor 18–22 FPS. Encoder NVIDIA reportado, limitação `none` no intervalo. Isso localiza a redução de FPS após a entrega da captura, mas não identifica sua causa. `none` não demonstra ausência de limitação interna.
- Bases 2/3 de Edge/Rust balanced não são equivalentes às cadeias em resolução e/ou FPS; não calcular custo por salto com esses pares. Não selecionar outra base retrospectivamente para obter resultado favorável.
- Mesmo nos pares semelhantes, diferença base/cadeia inclui buffering e variação entre execuções. Não mede processamento isolado de cada relay nem comprova a meta de 5 ms. Dimensões finais não demonstram resolução constante no intervalo; latência é coletada após as estatísticas.

**Conclusão local:** o caminho Rust apresentou 57–86 ms em 1906×1072 nesta série curta. Edge balanced reduziu resolução; maintain-resolution preservou dimensões à custa de FPS. Nenhuma comparação demonstra qualidade equivalente, estabilidade prolongada ou cumprimento integral das metas. Os 62–63 FPS são valores medidos, não comprovação de 60 quadros únicos por segundo. Não substituir os resultados exploratórios anteriores por esta série mais favorável.

**Bloqueios:** rede ruim não comparável com o proxy TURN atual (saturação e enlaces Rust diretos); segundo PC não validado pela bancada loopback. Faltam sincronização/medição externa, validação de áudio e app real com interface/decodificação. Encerrada a matriz local planejada; conclusão arquitetural e ADR continuam pendentes.

### Limites e próximos passos

Os JSONs exploratórios acima foram produzidos antes do registro completo de configuração; os nomes não substituem metadados. Não reescrever esses dados como se tivessem configuração registrada originalmente. As durações das estatísticas incluem a coleta entre amostras, podendo superar os 15 s solicitados. Falta isolar a causa do FPS baixo e da variabilidade, repetir séries com dimensões equivalentes e medir base sem relays nas mesmas condições antes de estimar custo por salto. Rede ruim, segundo PC e ADR permanecem pendentes. Relatório HTML histórico não atualizado nesta retomada; não usar seus veredictos como comprovação das metas.
