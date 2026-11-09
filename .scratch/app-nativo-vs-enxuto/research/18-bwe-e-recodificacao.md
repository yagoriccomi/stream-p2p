# 18 — BWE no relay nativo e custo de uma recodificação (medido neste PC)

Data: 2026-11-08. PC: RTX 4060 Ti, 12 processadores lógicos, Edge 157.0.4341.42 (headless), encoder "NVIDIA H.264 Encoder MFT".
Cenários:
- (A) atraso do BWE: presenter Rust `--synth` 1080p60 H.264 8 Mbps → relay 1 → relay 2 (`sp2p-native-bench`, str0m 0.25) → espectador Edge, ICE direto, rede "boa", settle 20 s, medição 15 s. BWE desligado vs. `RELAY_BWE=8000` (`enable_bwe` + `set_bitrate(800k, 8M)` + `set_unpaced(true)` nos filhos).
- (B) reação a queda: mesmo cenário via TURN local, `RELAY_BWE=8000`, e 5 s após o início da medição o proxy limita a 2000 kbps (token bucket, fila drop-tail de 200 ms). O proxy limita a perna TURN de todos os saltos, não de um filho só.
- (C) recodificação: bin `transcode` headless (sem janela, sem rede). 1200 quadros synth 1080p pré-codificados no NVENC, depois em ritmo de 60 fps: MS H.264 decoder MFT com D3D11 (DXVA, `MF_LOW_LATENCY`) → video processor D3D11 NV12 1920x1080 → 1280x720 (espera a GPU por event query) → NVENC 720p 4 Mbps. Um quadro em voo; 60 de aquecimento descartados.

Nenhuma janela visível; `BENCH_ALLOW_VISIBLE` não usado. As rodadas de (C) e (A/B) só rodaram com a máquina sem Firefox nem outro `bench-relay` (o agente do ticket 19 usa o mesmo bench).

## Comandos

```
cd <worktree>
# (A)
BENCH_DIRECT=1 BENCH_MODE=native-synth BENCH_LABEL=t18-d-off-<n> node e2e/bench-relay.js
RELAY_BWE=8000 BENCH_DIRECT=1 BENCH_MODE=native-synth BENCH_LABEL=t18-d-on-<n> node e2e/bench-relay.js
# (B)
RELAY_BWE=8000 BENCH_CAP=2000@5000 BENCH_MODE=native-synth BENCH_LABEL=t18-cap-<n> node e2e/bench-relay.js
# (C) + GPU a cada 250 ms
e2e/bench/native/target/release/transcode.exe 1200
nvidia-smi --query-gpu=utilization.gpu,utilization.encoder,utilization.decoder --format=csv,noheader,nounits -lms 250
```

Código novo: `RELAY_BWE`/`RELAY_BWE_PACED` e série `bwe` nos stats em `e2e/bench/native/src/main.rs`; `BENCH_CAP` e `results.cap` em `e2e/bench-relay.js`; `e2e/bench/native/src/bin/transcode.rs` (reaproveita `Synth`/`Encoder` de `presenter.rs`). Sem as envs, o comportamento não muda.

Resultados: `e2e/bench/results/t18-d-{off,on}-{1,2,3}.json`, `t18-cap-{1,2,3}.json`, `t18-transcode-{1,2,3}.json` + `-gpu.csv`, `t18-gpu-idle.csv`, `t18-off-1.json` (base TURN sem limite). Todas as rodadas saíram com exit 0.

## Por rodada

### (A) atraso do BWE (ICE direto)

| rótulo | lat ms | fps | kbps | cong. | perda % | CPU relay 1 / 2 % | RAM relay MB | PLIs r1/r2 |
|---|---|---|---|---|---|---|---|---|
| d-off-1 | 48 | 51 | 8027 | 1 | 1.6 | 3 / 4 | 3 | 4/3 |
| d-off-2 | 51 | 60 | 7942 | 0 | 0 | 3 / 4 | 3 | 2/1 |
| d-off-3 | 50 | 60 | 8024 | 0 | 0 | 4 / 4 | 3–4 | 2/1 |
| d-on-1 | 48 | 60 | 7959 | 0 | 0 | 4 / 4 | 3 | 2/1 |
| d-on-2 | 53 | 53 | 7875 | 1 | 0.7 | 3 / 4 | 4 | 4/3 |
| d-on-3 | 49 | 51 | 8038 | 1 | 1.5 | 3 / 4 | 4 | 4/3 |

Estimativa com BWE: a sondagem inicial sobe a 150–400 Mbps nos primeiros ~3 s e depois assenta em 6–15 Mbps (última: 10.6–14.8 Mbps).

### (B) queda para 2000 kbps (TURN), série `EgressBitrateEstimate` do relay 2 → espectador (ms após o limite: kbps)

| rótulo | antes | 1ª queda | < 2000 kbps | final | espectador (janela inteira) |
|---|---|---|---|---|---|
| cap-1 | 11975 | +250 ms: 8998 (+362: 6021) | +4044 ms: 1529 | ~130 (colapso) | 14 fps, 3945 kbps, 50.5 % perda, lat 12077 ms |
| cap-2 | 2647 (já baixa antes) | sobe até 3597, cai a partir de +872 | +3294 ms: 1113 | ~130 | 18 fps, 3805 kbps, 52.8 % perda, lat 12126 ms |
| cap-3 | ~12000 | +277 ms: 9988 (+652: 5208) | +3948 ms: 1192 | ~130 | 13 fps, 3874 kbps, 51.5 % perda, lat 12079 ms |

Relay 1 → relay 2 (filho nativo): cap-1 sem eventos; cap-2 constante (12676); cap-3 cai de 12724 para 7469 entre +2 e +2.4 s e volta a subir. Base TURN sem limite (`t18-off-1`, sem BWE): lat 1112 ms, 52 fps, 7740 kbps.

### (C) recodificação 1080p → 720p (ms por quadro: média / p50 / p95 / máx)

| rodada | decode | escala | encode | total | CPU % de 1 núcleo (máquina) | GPU / enc / dec % | perdidos |
|---|---|---|---|---|---|---|---|
| 1 | 0.19 / 0.17 / 0.28 / 0.52 | 0.99 / 0.86 / 2.64 / 5.45 | 3.02 / 3.17 / 3.39 / 7.66 | 4.20 / 4.26 / 6.07 / 9.16 | 28 (2.3) | 11 / 15 / 6 | 0 |
| 2 | 0.18 / 0.17 / 0.22 / 0.40 | 0.95 / 0.85 / 2.24 / 4.90 | 3.07 / 3.20 / 3.42 / 7.33 | 4.20 / 4.26 / 6.05 / 8.85 | 31 (2.6) | 10 / 16 / 6 | 0 |
| 3 | 0.18 / 0.17 / 0.25 / 0.48 | 1.00 / 0.85 / 2.70 / 3.81 | 2.99 / 3.16 / 3.28 / 7.91 | 4.18 / 4.23 / 5.82 / 8.89 | 28 (2.4) | 9 / 15 / 6 | 0 |

GPU ociosa: 4 / 1 / 0 %. Entrada: ~8060 kbps; saída: ~4050 kbps (alvo 4000). Atraso do decoder: 0 quadros; 0 erros de entrada.

## Médias (faixa)

| config | lat ms | CPU relay % | outros |
|---|---|---|---|
| (A) BWE desligado | 49.7 (48–51) | 3–4 | 51–60 fps |
| (A) BWE ligado, unpaced | 50.0 (48–53) | 3–4 | 51–60 fps |
| (B) 1ª queda da estimativa | +250 / +277 ms (2 de 3 rodadas) | 4 | < 2 Mbps em 3.3–4.0 s |
| (C) recodificação | total 4.19 (p95 5.8–6.1, máx ≤ 9.2) | 29 % de 1 núcleo | GPU +6 pp, NVENC +15 pp, NVDEC +6 pp |

## Falhas e limites

- O MS H.264 decoder segurava ~15 quadros (~250 ms a 60 fps) só com `CODECAPI_AVLowLatencyMode`. Também aparecia `MF_E_NOTACCEPTING` (~4 a cada 600 quadros). Com `MF_LOW_LATENCY = 1` nos atributos do MFT: 0 quadros de atraso, 0 erros. Sem isso, um relay recodificador soma ~250 ms.
- Contenção: com o bench Firefox do ticket 19 rodando (rodada prévia, descartada), o total do transcode foi a média 10.1–10.7 ms, p95 25–31 ms, máx 59–73 ms. Os números acima valem com a GPU livre. A disputa por GPU numa máquina real (jogo + captura) não foi medida.
- (B) não isola "um filho": o limite do proxy vale para todas as pernas TURN. O relay só repassa, então a estimativa não reduz o que é enviado. A fonte segue a 8 Mbps num enlace de 2 Mbps, a perda fica em ~50 % e a estimativa colapsa para ~130 kbps. A latência de 12 s do espectador reflete isso, não o BWE. O TURN local já tem 1.1 s de latência sem limite. A reação "~250–280 ms" vem de 2 rodadas; na cap-2 a estimativa já estava baixa (~0.6–3 Mbps) antes do limite.
- Relay 1 → relay 2 (filho str0m): série BWE ausente ou incoerente. Provável falta de feedback TWCC do lado receptor nativo (o pai é criado sem BWE). Não investigado.
- Em (A), a resolução de latência do bench (~±5 ms entre rodadas) é maior que qualquer diferença. Congelamentos e perda aparecem nos dois modos (1 de 3 off, 2 de 3 on), sem padrão.
- Usei o limitador do próprio `bench-relay.js`, não `e2e/netsim.js`. A decodificação usa o MS MFT (DXVA), não NVDEC direto. A fonte é sintética. Só NVIDIA; não testei Intel/AMD nem fallback software.
- `decodeMs` é o tempo até `ProcessOutput` devolver a amostra. O trabalho de GPU pendente cai na espera da escala (event query), então o total cobre os três estágios.

## Conclusões

Comprovadas neste PC:
- `enable_bwe` + `set_unpaced(true)` não somam atraso mensurável ao repasse: 50.0 contra 49.7 ms de ponta a ponta, CPU do relay igual (3–4 %), 3 rodadas cada.
- A estimativa TWCC do relay → espectador Edge reage a uma queda de 12 para 2 Mbps em ~250–280 ms (1ª redução) e fica abaixo de 2 Mbps em 3.3–4.0 s.
- Recodificar 1080p60 → 720p 4 Mbps em hardware (MS decoder DXVA + video processor + NVENC) custa 4.2 ms por quadro em média, p95 ≤ 6.1 e máx ≤ 9.2 ms. Cabe em < 15 ms com folga. CPU: ~30 % de um núcleo (~2.5 % da máquina). GPU: +6 pp de uso geral, +15 pp de NVENC, +6 pp de NVDEC.
- Exige `MF_LOW_LATENCY` no decoder: sem ele, ~15 quadros de atraso.

Não comprovadas:
- Reação do BWE a uma queda num único filho, ou com perda sem limite de banda (o cenário limita todos os saltos).
- BWE entre dois relays nativos (feedback TWCC do receptor str0m).
- Custo da recodificação com a GPU disputada (jogo, captura, outro encoder), em GPU Intel/AMD, ou com vários degraus ao mesmo tempo.
- Latência de ponta a ponta com um relay recodificador real na cadeia (só o custo por quadro, isolado).
