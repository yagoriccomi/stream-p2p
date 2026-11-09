# 07 — Protótipo Slint + wgpu DX12 com vídeo 1080p60 na GPU

Ticket: [../07-prototipo-toolkit-ui.md](../07-prototipo-toolkit-ui.md). Data: 2026-11-09. Janela visível autorizada (answers 006 #2).
Máquina: NVIDIA GeForce RTX 4060 Ti, monitor 2560 px a 144 Hz. Slint 1.18.1 (`renderer-femtovg-wgpu`, `unstable-wgpu-30`, `backend-winit`, `accessibility`), wgpu 30.0.1 só DX12, windows 0.62.2.

## Veredito

- O caminho funciona ponta a ponta sem cópia para CPU: o vídeo aparece (snapshot da área de vídeo com luma média 135–138 e desvio 65–66; com vídeo desligado, 0/0).
- **RAM < 50 MB: reprovada.** Working set 154–155 MB e private bytes 308 MB com vídeo; 116 MB / 263 MB só com a UI. 76 MB de working set e 123 MB de private bytes já vêm só de criar o device wgpu DX12, antes de qualquer UI ou vídeo.
- **CPU: problema.** 85–89 % de um núcleo (7,1–7,4 % da máquina) com vídeo. Sem decode, só trocando a imagem a 60 Hz: 81 %. Trocando só um texto a 60 Hz, sem vídeo: 78 %. Parado: 0–1 %. O custo vem do redesenho do Slint/femtovg, não do vídeo.
- Latência decode + apresentação: p50 16,2–16,7 ms, p95 23,1–23,9 ms (até o submit do quadro do Slint, sem o vsync/composição).
- Não troquei para iced: as falhas acima não bloqueiam o caminho de vídeo; o iced não tem acessibilidade (04).

## Respostas às perguntas do ticket

| Pergunta | Resposta | Evidência |
|---|---|---|
| `Image::try_from` copia a textura? | **Não.** Valida formato (`Rgba8Unorm`/`Srgb`) e usos (`TEXTURE_BINDING`+`RENDER_ATTACHMENT`) e guarda o `wgpu::Texture`; o femtovg embrulha como `Texture::Internal(native_texture)` | `i-slint-core-1.18.1/graphics/wgpu_30.rs` (`TryFrom<wgpu_30::Texture>`), `i-slint-renderer-femtovg-1.18.1/images.rs:192`, `femtovg-0.27.0/src/renderer/wgpu.rs:751` |
| Device wgpu compartilhado com o vídeo? | **Sim.** `WGPUConfiguration::Manual` com o nosso device; no `RenderingSetup` o device do Slint é igual ao nosso (`slintUsesOurWgpuDevice: true`). D3D11 do decoder criado no mesmo adaptador (`sameAdapterLuid: true`) | `p07-play-*.json` |
| Fence D3D11↔D3D12 | **Funciona.** `ID3D11Fence` compartilhado: D3D11 sinaliza após o `VideoProcessorBlt`, a fila D3D12 do wgpu espera no `BeforeRendering`. `ID3D12Fence` compartilhado: a fila sinaliza no `AfterRendering`, o D3D11 espera antes de reescrever a textura do pool (3 texturas). Nenhum rasgo visível nem erro em 3 × 20 s | `main.rs` |
| RAM < 50 MB | **Não.** Ver tabela | — |
| Narrador lê os campos? | **Sim, via UI Automation**: `Edit` com nome "Seu nome" e `ValuePattern` = "Yago", focável; `Button` "Entrar", focável; `Image` "Tela compartilhada". Narrador em si não foi ligado | `results/p07-uia.txt`, `results/p07-uia.ps1` |

## Números (3 rodadas de 20 s de vídeo, após 1 s de aquecimento)

| | r1 | r2 | r3 |
|---|---|---|---|
| Quadros novos apresentados/s | 58,6 | 58,9 | 58,9 |
| Decode (entrada → amostra D3D11), p50 / p95 ms | 0,26 / 0,38 | 0,26 / 0,37 | 0,26 / 0,38 |
| Blt NV12→RGBA + signal, p50 / p95 ms | 0,32 / 0,44 | 0,32 / 0,42 | 0,32 / 0,42 |
| Entrada no decoder → submit do quadro Slint, p50 / p95 / máx ms | 16,7 / 23,9 / 28,3 | 16,5 / 23,4 / 29,6 | 16,5 / 23,4 / 30,8 |
| Working set / private com vídeo (MB) | 154,4 / 308,0 | 154,8 / 307,9 | 155,1 / 307,8 |
| Working set / private só UI (MB) | 115,8 / 263,9 | 116,0 / 263,7 | 116,2 / 262,6 |
| CPU (% de 1 núcleo, média) | 89,4 | 85,4 | 85,7 |

Decode < 0,4 ms é o tempo de CPU até o MFT devolver a amostra (`MF_LOW_LATENCY` + `CODECAPI_AVLowLatencyMode` VT_UI4); o trabalho da GPU é aguardado pela fence. A latência é casada pelo índice do quadro devolvido, então inclui eventual atraso do decoder (não contado à parte). Hipótese não verificada: a maior parte dos ~16 ms é espera pelo próximo redesenho do Slint (`invoke_from_event_loop` → próximo quadro do winit).

RAM por etapa (r1–r3, working set / private MB): início 10,8 / 2,3 → device wgpu DX12 75,6 / 124,7 → device D3D11 80,6 / 138,3 → fences + VP + pool 81,8 / 139,2 → `App::new` Slint 87,1 / 194,2 → janela visível 116 / 263 → vídeo 155 / 308.

Isolamento de CPU (1 rodada de 10 s cada):
- `P07_NOSET=1` (decode e blt rodam, imagem não muda): 0,9 % de um núcleo, 3 renders.
- `P07_NODECODE=1` (sem decoder; troca entre as 3 imagens do pool a 60 Hz): 80,7 %.
- `P07_TEXTONLY=1 P07_NODECODE=1` (só um texto muda a 60 Hz): 77,7 %.

## Comandos

```
cd e2e/bench/proto07
cargo build --release
target/release/proto07.exe encode target/p07.h264 1800    # NVIDIA H.264 Encoder MFT, 42e01f, ~8 Mbps
target/release/proto07.exe play target/p07.h264 20         # abre a janela, fecha sozinho, imprime JSON
powershell -File ../results/p07-uia.ps1                    # com a janela aberta
```

Resultados: `e2e/bench/results/p07-play-{1,2,3}.json`, `p07-idle-1.json`, `p07-nodecode-1.json`, `p07-textonly-1.json`, `p07-uia.txt`.

## Não medido / limites

- Fonte é um arquivo H.264 pré-gerado (sintético, `Synth` do presenter), não str0m: sem jitter, perda nem PLI.
- Latência medida até o `queue.submit` do Slint; não inclui `Present`, vsync de 144 Hz nem composição DWM. Sem medição foto a foto.
- Causa exata dos ~80 % de CPU no redesenho não investigada (femtovg tessela no CPU? `AutoVsync` com espera ativa?). Não testei `renderer-skia` nem o renderizador de software do Slint, nem iced.
- Só NVIDIA. Sem AMD/Intel (14 adiado).
- RAM com outros toolkits wgpu não medida: a base de 76 MB do device DX12 provavelmente se repete em qualquer toolkit sobre wgpu, mas não verifiquei.
- Visual: só cabeçalho, área de vídeo, campo e botão; fontes Archivo/Inter não embutidas (usa a fonte do sistema).
