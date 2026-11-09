# 13 — Fallback software e perfis H.264 (medido neste PC)

Data: 2026-11-08. PC: RTX 4060 Ti, 12 processadores lógicos, Edge 157.0.4341.42 (espectador headless).
Cenário: presenter Rust `--synth` (fonte sintética 1080p60 com relógio, sem janela) → espectador Edge, sem relays (`BENCH_NORELAY=1`), ICE direto (`BENCH_DIRECT=1`), rede "boa", 8000 kbps, settle 20 s, medição 15 s.
Nenhuma janela visível; `BENCH_ALLOW_VISIBLE` não usado.

Antes das rodadas: `cargo build --release` (e2e/bench/native) ok; `node --test e2e/bench-relay.test.js` 21/21.

## Comandos

```
cd <worktree>
# hw constrained-baseline (padrão), baseline, main
BENCH_MODE=native-synth BENCH_NORELAY=1 BENCH_DIRECT=1 [BENCH_PROFILE=baseline|main] BENCH_LABEL=fb13-hw-<cfg>-<n> node e2e/bench-relay.js
# software
BENCH_MODE=native-synth BENCH_NORELAY=1 BENCH_DIRECT=1 BENCH_ENCODER=software BENCH_LABEL=fb13-sw-cb-<n> node e2e/bench-relay.js
# troca ao vivo (BENCH_LIVE_EVERY_MS padrão 5000)
BENCH_MODE=native-synth BENCH_NORELAY=1 BENCH_DIRECT=1 BENCH_LIVE="bitrate:4000,resize:1280x720,bitrate:8000,resize:1920x1080" BENCH_LABEL=fb13-live-hw-cb-<n> node e2e/bench-relay.js
```

Resultados: `e2e/bench/results/fb13-{hw-cb,hw-baseline,hw-main,sw-cb}-{1,2,3}.{json,log}`, `fb13-live-hw-cb-{1,2}.{json,log}`. Todas as rodadas saíram com exit 0.

## Por rodada

CPU % do presenter = tempo de CPU / tempo de parede (100 % = 1 núcleo lógico; máquina inteira = 1200 %). "enc ms" = `encodeMsAvg` do presenter.

| rótulo | encoder | perfil (fmtp no Edge) | espectador | lat ms | kbps | cong. | perda | tx CPU % | tx RAM MB | enc ms | skip |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hw-cb-1 | NVIDIA H.264 Encoder MFT | 42e01f | 1920x1080 60 fps | 51 | 8172 | 0 | 0 | 8 | 38 | 6.51 | 2 |
| hw-cb-2 | NVIDIA | 42e01f | 1920x1080 60 | 34 | 8132 | 0 | 0 | 9 | 38 | 6.02 | 0 |
| hw-cb-3 | NVIDIA | 42e01f | 1920x1080 60 | 32 | 8010 | 0 | 0 | 7 | 38 | 5.84 | 2 |
| hw-baseline-1 | NVIDIA | 42001f | 1920x1080 60 | 35 | 8182 | 0 | 0 | 8 | 39 | 5.78 | 0 |
| hw-baseline-2 | NVIDIA | 42001f | 1920x1080 60 | 40 | 8200 | 0 | 0 | 8 | 38 | 6.09 | 1 |
| hw-baseline-3 | NVIDIA | 42001f | 1920x1080 60 | 41 | 8001 | 0 | 0 | 7 | 38 | 6.27 | 2 |
| hw-main-1 | NVIDIA | 4d001f | 1920x1080 60 | 48 | 7983 | 0 | 0 | 11 | 38 | 4.81 | 7 |
| hw-main-2 | NVIDIA | 4d001f | 1920x1080 60 | 51 | 8006 | 0 | 0 | 9 | 38 | 6.01 | 1 |
| hw-main-3 | NVIDIA | 4d001f | 1920x1080 60 | 34 | 7978 | 0 | 0 | 7 | 38 | 5.73 | 2 |
| sw-cb-1 | Microsoft H264 Video Encoder MFT (software) | 42e01f | 1920x1080 60 | 29 | 8003 | 0 | 0 | 158 | 91 | 7.12 | 0 |
| sw-cb-2 | MS software | 42e01f | 1920x1080 60 | 39 | 7978 | 0 | 0 | 146 | 91 | 6.60 | 0 |
| sw-cb-3 | MS software | 42e01f | 1920x1080 60 | 47 | 8019 | 0 | 0 | 159 | 91 | 6.74 | 0 |

Espectador Edge em todas: RAM 145–161 MB, CPU 5–19 %.

## Médias (faixa)

| config | lat ms | kbps | tx CPU % | tx RAM MB | enc ms |
|---|---|---|---|---|---|
| hw constrained-baseline | 39 (32–51) | 8105 | 8 (7–9) | 38 | 6.1 |
| hw baseline | 39 (35–41) | 8128 | 7.7 (7–8) | 38–39 | 6.0 |
| hw main | 44 (34–51) | 7989 | 9 (7–11) | 38 | 5.5 |
| sw constrained-baseline | 38 (29–47) | 8000 | 154 (146–159) | 91 | 6.8 |

Todas: 1920x1080, 60 fps no espectador, 0 congelamentos, 0 % perda.

## Troca ao vivo (hw constrained-baseline, 2 rodadas)

Comandos enviados a cada ~10 s (5 s de espera + 5 s de amostragem a cada 50 ms). Presenter registrou todos com `ok: true`.

| evento | presenter | espectador (rodada 1 / 2) |
|---|---|---|
| bitrate 4000 | aplicado em ~0.01 ms | 1ª janela de 500 ms já ~4.2 / ~3.2 Mbps; maior intervalo sem quadro 54 / 53 ms; 0 cong.; 1 keyframe extra |
| resize 1280x720 | reinício do encoder 0.18 / 0.21 ms; 1ª saída em 15.8 / 18.7 ms | já 1280x720 na 1ª amostra (≤ ~50 ms de sondagem); intervalo máx. 53 / 54 ms; 0 cong. |
| bitrate 8000 | ~0.01 ms | 1ª janela ~7.4 / ~7.1 Mbps; intervalo máx. 54 / 53 ms; 0 cong. |
| resize 1920x1080 | reinício 0.22 / 0.18 ms; 1ª saída em 15.7 / 20.5 ms | já 1920x1080 na 1ª amostra; intervalo máx. 54 / 54 ms; 0 cong. |

Médias da janela inteira (mistura das fases): 60 fps, 40 / 42 ms, 6215 / 6256 kbps, presenter 7 % CPU, 52 / 48 MB RAM (contra 38 MB sem trocas).

## Falhas e limites

- `fb13-live-hw-cb-2.log`: uma linha `ProcessOutput: Error { code: HRESULT(0x8000FFFF), message: "Falha catastrófica" }` logo após a troca para 4000 kbps. O presenter só registra e descarta o quadro (presenter.rs ~l.441); sem efeito visível (0 congelamentos, intervalo máx. 53 ms). Causa não investigada; não apareceu na rodada 1.
- `viewerSwitchMs` gravado no JSON é inválido (negativo, ~-1670 ms): `s.at` vem do relógio da página e `sentAt` do `performance.now()` do Node. Usei a 1ª amostra da série como referência. Resolução real do tempo de reação: limitada pela sondagem de 50 ms, então "≤ ~50 ms" é o máximo que se pode afirmar. Bitrate medido em janelas de 500 ms.
- Perfil "aceito pelo MFT" = `SetOutputType` com `MF_MT_MPEG2_PROFILE` não falhou e o MFT codificou. O presenter não lê o SPS, então o `profile_idc` real do bitstream não foi conferido. O Edge negociou o `profile-level-id` pedido (fmtp acima) e decodificou 60 fps.
- Somente rede boa, ICE direto, sem relays, fonte sintética (não captura de janela), 3 rodadas. A latência varia 29–51 ms dentro de cada config. Isso é maior que as diferenças entre configs.
- Rodadas live: 2 (não 3).

## Conclusões

Comprovadas neste PC:
- O MFT NVIDIA aceita constrained-baseline (42e01f), baseline (42001f) e main (4d001f). O Edge negocia e decodifica os três a 1080p60, ~8 Mbps, sem congelamentos nem perda.
- O fallback software (MS MFT) sustenta 1080p60 a ~8 Mbps com latência equivalente (38 ms em média). Custo: ~1.5 núcleos lógicos (146–159 %, ~13 % dos 12) e +53 MB de RAM no presenter (91 contra 38 MB). Codificação a 6.8 ms/quadro, sem quadros pulados.
- Troca de bitrate e resolução ao vivo no hw: aplicada sem congelamentos. O maior intervalo entre quadros fica em 53–54 ms. A nova resolução aparece no espectador dentro da 1ª sondagem (≤ ~50 ms), e o bitrate converge dentro de 500 ms.

Não comprovadas:
- Diferença de latência ou CPU entre perfis: dentro do ruído.
- `profile_idc` real no bitstream; uso de recursos do main (CABAC) pelo NVENC.
- Fallback software em CPU mais fraca, com captura real ou com relays.
- Causa e frequência do `0x8000FFFF` após troca de bitrate.
- Tempo de reação abaixo de 50 ms (falta resolução de medição; o campo `viewerSwitchMs` precisa usar o mesmo relógio).
