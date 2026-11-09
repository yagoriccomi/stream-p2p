# 08 — Espectador nativo: decode e render na GPU

Ticket: [`../08-espectador-nativo.md`](../08-espectador-nativo.md). Data: 2026-11-08.
Versões verificadas: str0m 0.25.0 e windows 0.62.2 (fonte local em `~/.cargo/registry`), wgpu 30.0.1, egui-wgpu 0.37.0, Slint 1.18.1, iced 0.14.0 (docs.rs).

## Recomendação

```
str0m Event::MediaData (H.264 Annex B, quadro inteiro)
  └─ contiguous=false ou decoder erra → descarta até keyframe + request_keyframe(Pli)
MFT H.264 da Microsoft (CLSID_CMSH264DecoderMFT), síncrono, chamado direto (sem Media Session)
  ├─ MFT_MESSAGE_SET_D3D_MANAGER (IMFDXGIDeviceManager do nosso ID3D11Device)
  ├─ CODECAPI_AVLowLatencyMode = 1 (VT_UI4 neste decoder!)
  └─ saída NV12 em ID3D11Texture2D (fatia de array) via IMFDXGIBuffer
ID3D11VideoContext::VideoProcessorBlt NV12 → BGRA/RGBA (textura própria, SHARED_NTHANDLE)
  └─ handle NT → ID3D12Device::OpenSharedHandle → wgpu-hal dx12 texture_from_raw
     → wgpu::Device::create_texture_from_hal → toolkit (Slint/egui/iced via wgpu)
```

Um único MFT cobre NVIDIA/AMD/Intel (DXVA do driver) e fallback software (o próprio MFT decodifica em CPU quando não há DXVA). Nenhum pixel vai para a CPU no caminho de GPU.

## 1. Depacketização H.264 no str0m

- No modo padrão (frame mode) o str0m entrega `Event::MediaData` com `data: Arc<[u8]>` = "a full depayloaded Frame" (`src/media/event.rs`, struct `MediaData`).
- O depacketizador H.264 escreve start codes Annex B `00 00 00 01` antes de cada NALU (`src/packet/h264.rs`, `ANNEXB_NALUSTART_CODE`, `fn depacketize`, trata NALU simples, STAP-A e FU-A). Esse formato é o que o MFT exige: "Input data must conform to Annex B of ISO/IEC 14496-10. The data must include the start codes." [MS H.264 Video Decoder]
- `MediaData::is_keyframe()` usa `CodecExtra::H264.is_keyframe`, marcado quando aparece NALU tipo 5 (IDR) (`h264.rs`, `IDR_NALU_TYPE = 5`).
- `MediaData::contiguous`: "If this is false, we got an interruption in RTP packets, and the data may or may not be usable in a decoder without requesting a new keyframe." (`event.rs`)
- Sincronia: `MediaData.time` (timestamp RTP; vídeo 90 kHz, áudio 48 kHz) e `last_sender_info: Option<SenderInfo>` (último Sender Report). (`event.rs`)

## 2. Jitter buffer e reordenação (o que já vem do str0m)

- O str0m já tem buffer de reordenação por contagem de pacotes: `set_reordering_size_video` (padrão 30) e `set_reordering_size_audio` (padrão 15), com `set_reordering_timeout_audio` (padrão 1 s). (`src/config.rs`, linhas ~511–600, padrões na linha ~900)
- Vídeo: "Video recovery waits for a complete successor and missing packets' NACK attempts plus three RTTs. When NACK timing is unavailable, it waits three RTTs [...] (100 ms RTT until measured)." O valor "must be at least as big as the number of packets the biggest keyframe can be split over". (`config.rs`)
- Há NACK no receptor (`src/streams/receive.rs`, `suppress_nack`, contador `nacks`).
- Consequência: não há jitter buffer de *playout* (atraso alvo por tempo). Para tela compartilhada a menor latência é exibir assim que decodificar (sem playout delay de vídeo); o buffer de playout fica só no áudio (§6).
- Risco: um keyframe 1072p a 8 Mbps pode passar de 30 pacotes; ajustar `set_reordering_size_video` com base no tamanho máximo medido. Não medido aqui.

## 3. Perda e pedido de keyframe (PLI)

- API: `Writer`/receptor `request_keyframe(..., KeyframeRequestKind::Pli)` (`src/media/writer.rs:300`). O bench já usa: `rx.request_keyframe(KeyframeRequestKind::Pli)` (`e2e/bench/native/src/main.rs:249`); o presenter já reage a `Event::KeyframeRequest` forçando IDR (`e2e/bench/native/src/bin/presenter.rs:302`).
- O encoder do presenter usa GOP de 10 s (`CODECAPI_AVEncMPVGOPSize = FPS*10`, `presenter.rs:209`), logo sem PLI a recuperação de uma perda levaria até 10 s.
- Regra proposta: ao receber `contiguous == false` (ou `ProcessInput/ProcessOutput` com erro), parar de alimentar o decoder até um quadro com `is_keyframe()`, mandar PLI e repetir com limite (ex.: no máximo 1 PLI a cada ~RTT) para não inundar o presenter. Exibir o último quadro bom enquanto espera (congela em vez de borrar).
- Opcional: alimentar o decoder mesmo após perda (ele tolera, com artefatos) é uma escolha de produto; o padrão "congelar até IDR" é o mais simples.

## 4. Decode na GPU: Media Foundation + D3D11VA

Fatos da documentação da Microsoft [MS H.264 Video Decoder]:
- Criação: `MFTEnumEx` ou `CoCreateInstance(CLSID_CMSH264DecoderMFT)` (constante `CMSH264DecoderMFT` existe em `windows` 0.62.2, `Win32/Media/MediaFoundation/mod.rs:2488`).
- Perfis Baseline, Main, High até nível 5.1; saída NV12 (entre outras); máximo 4096×2304.
- "The maximum guaranteed resolution for DXVA acceleration is 1920 × 1088 pixels; at higher resolutions, decoding is done with DXVA, if it is supported by the underlying hardware, otherwise, decoding is done with software." Isso é o fallback software embutido.
- "DXVA decoding is supported only for Main-compatible Baseline, Main, and High profile bitstreams" (Baseline precisa `constrained_set1_flag=1`, i.e. Constrained Baseline, que é o perfil usual do WebRTC).
- `CODECAPI_AVLowLatencyMode` (Windows 8+). Aviso: "the Media Foundation H.264 decoder uses the type VT_UI4 for this property. All other implementations, including the H.264 encoder, use the type VT_BOOL." [CODECAPI_AVLowLatencyMode]. O presenter usa VT_BOOL no encoder (`presenter.rs:205`); no decoder tem de ser VT_UI4.
- Input type mínimo: `MF_MT_MAJOR_TYPE=Video`, `MF_MT_SUBTYPE=MFVideoFormat_H264`; espere `MF_E_TRANSFORM_STREAM_CHANGE` no primeiro `ProcessOutput` e renegocie a saída (ou preencha `MF_MT_FRAME_SIZE` para evitar).

Ligação com D3D11 [MS D3D11 decoding in MF]:
- O decoder recebe o `IMFDXGIDeviceManager` (de `MFCreateDXGIDeviceManager` + `ResetDevice`) via `ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, ptr)`; o MFT expõe `MF_SA_D3D11_AWARE`.
- Ligar `ID3D10Multithread::SetMultithreadProtected(true)` no device ("recommended ... to prevent deadlock issues").
- A saída são amostras do próprio MFT (`MFT_OUTPUT_STREAM_PROVIDES_SAMPLES`): fatias de um `Texture2D` array com `D3D11_BIND_DECODER`. Pegar com `IMFSample::GetBufferByIndex` → `IMFDXGIBuffer::GetResource` + `GetSubresourceIndex`.
- `MF_SA_D3D11_BINDFLAGS` nos atributos do stream de saída é só *dica* ("The MFT should attempt to honor the setting ... If that is not possible, the MFT can ignore the attribute") [MF_SA_D3D11_BINDFLAGS]. Por isso não contar com `SHADER_RESOURCE` na textura do decoder: copiar via VideoProcessor.
- `MF_SA_MINIMUM_OUTPUT_SAMPLE_COUNT` controla quantas superfícies o MFT aloca; manter pequeno.
- Fallback do lado do app: se `SET_D3D_MANAGER`/`SetOutputType` falhar (`MF_E_UNSUPPORTED_D3D_TYPE`), mandar `SET_D3D_MANAGER` com NULL e usar saída NV12 em memória de sistema, subir para textura com `UpdateSubresource` (única cópia CPU→GPU, só no fallback).
- Todos os símbolos necessários existem em `windows` 0.62.2 com as features que o bench já usa (`Win32_Media_MediaFoundation`, `Win32_Graphics_Direct3D11`): `MFCreateDXGIDeviceManager` (mod.rs:517), `MFT_MESSAGE_SET_D3D_MANAGER`, `MF_SA_D3D11_AWARE`, `MF_SA_D3D11_BINDFLAGS`, `MF_SA_D3D11_SHARED_WITHOUT_MUTEX`, `IMFDXGIBuffer`, `CODECAPI_AVLowLatencyMode`, `CODECAPI_AVDecVideoAcceleration_H264`, `D3D11_RESOURCE_MISC_SHARED_NTHANDLE`.

Por que não D3D11VA "puro" (`ID3D11VideoDecoder` direto): exigiria parsear SPS/PPS/slices e montar `DXVA_PicParams_H264` à mão (a doc lista `GetDecoderBuffer`/`SubmitDecoderBuffers`/`DecoderBeginFrame`, ver [MS D3D11 decoding in MF] §Decoding). É o que o MFT já faz por nós. Só vale considerar se o MFT se mostrar com latência inaceitável em alguma GPU.

## 5. Conversão e entrega da textura à UI (sem cópia para CPU)

1. NV12 (fatia do array do decoder) → `ID3D11VideoContext::VideoProcessorBlt` → textura própria `B8G8R8A8`/`R8G8B8A8` com `D3D11_RESOURCE_MISC_SHARED_NTHANDLE` ("Performs a video processing operation ... and writes the result to a Direct3D surface", Windows 8+) [VideoProcessorBlt]. Isso também faz escala e conversão de cor no hardware de vídeo, e libera a superfície do decoder de imediato.
2. `IDXGIResource1::CreateSharedHandle` → handle NT [OpenSharedResource1, passos para compartilhar entre devices].
3. Lado wgpu (backend DX12): `ID3D12Device::OpenSharedHandle(handle)` → `ID3D12Resource` [OpenSharedHandle]; `wgpu_hal::dx12::Device::texture_from_raw(resource, format, dim, size, 1, 1)` [wgpu-hal dx12/device.rs]; `wgpu::Device::create_texture_from_hal::<Dx12>(...)` (unsafe; "hal_texture must be created from this device internal handle") [wgpu Device]. Fazer uma vez por textura do pool (2–3 texturas em rodízio), não por quadro.
4. Sincronização D3D11→D3D12: `Flush` no contexto D3D11 basta em teste, mas o correto é fence compartilhada (`ID3D11Fence`/`ID3D12Fence` com handle compartilhado) ou keyed mutex. Ponto a validar no protótipo.

Encaixe por toolkit:
- egui (egui-wgpu 0.37): `Renderer::register_native_texture(device, &TextureView, FilterMode) -> TextureId` e `update_egui_texture_from_wgpu_texture` para reaproveitar o ID. Exige `Rgba8Unorm` [egui-wgpu Renderer]. Logo o VideoProcessor deve escrever `R8G8B8A8_UNORM`.
- Slint 1.18: `impl TryFrom<wgpu::Texture> for Image` (wgpu 29 e 30), API marcada instável (features `unstable-wgpu-29/30`) [Slint Image]. Caminho OpenGL (`BorrowedOpenGLTextureBuilder`) exigiria interop WGL_NV_DX_interop, pior em AMD/Intel; preferir o renderizador wgpu.
- iced 0.14: widget `shader` (feature `wgpu`) com traits `Program`/`Primitive`/`Pipeline`; o primitive desenha a textura importada [iced shader].
- Alternativa que independe do toolkit: swap chain DXGI própria (composição DirectComposition/child HWND) com o vídeo, UI por cima. Menor latência possível (flip model), mas complica overlay de controles. Guardar como plano B se o caminho wgpu der latência extra (não medido).

Conclusão para 04/07: os três toolkits aceitam `wgpu::Texture`; o requisito novo é o toolkit rodar sobre wgpu com backend DX12 (não Vulkan, não GL), para o import via handle NT funcionar.

## 6. Áudio Opus e sincronia

- O str0m entrega Opus já depacketizado (`src/packet/opus.rs`) como `MediaData` de áudio; não decodifica. Decoder Opus fica a cargo do app (libopus via crate; não verificado nesta pesquisa qual crate, decidir no 12).
- Saída: WASAPI (o app já usa áudio do sistema em `app/src-tauri/src/sysaudio.rs` para captura).
- Sincronia (lip sync): converter `MediaData.time` de cada trilha para relógio NTP do remetente usando `last_sender_info` (RTCP SR: par NTP↔RTP por SSRC). Com isso:
  - Áudio é o relógio mestre, com buffer de playout pequeno (ex.: 20–40 ms, ajustável pelo jitter observado; valor a medir).
  - Vídeo é exibido "o quanto antes"; só se estiver adiantado em relação ao áudio além de um limiar é que segura um quadro. Para tela compartilhada, preferir atrasar o áudio a atrasar o vídeo.
- Antes do primeiro SR, exibir sem sincronia (ambos o quanto antes).

## 7. Latência esperada (decode + apresentação)

Não há medição neste repositório para o lado espectador nativo. O 05 mediu 8–12 ms por salto com relays Rust (encode+rede). Estimativa a confirmar no protótipo: decode DXVA de um quadro 1080p em modo low-latency é tipicamente de poucos ms; o VideoProcessorBlt e a composição somam ~1 quadro de vsync (16,7 ms a 60 Hz) no pior caso. Instrumentar: `network_time` do `MediaData` → retorno de `ProcessOutput` → `Present`. Não extrapolar antes de medir.

## 8. Riscos e pontos em aberto

- Comportamento do MFT em low-latency por fabricante (alguns drivers seguram quadros apesar do modo). Medir em NVIDIA/AMD/Intel (depende do segundo PC, ver 03).
- Mudança de resolução no meio do fluxo (relay recodificando sob demanda, 09): tratar `MF_E_TRANSFORM_STREAM_CHANGE` e recriar o pool de texturas.
- Perda de device (TDR): recriar tudo; a doc pede `IMFDXGIDeviceManager::TestDevice`.
- Slint wgpu API instável entre minors.

## Fontes

Primárias, código local:
- str0m 0.25.0: `src/media/event.rs` (MediaData), `src/packet/h264.rs` (depacketize, Annex B, IDR), `src/config.rs` (reordering), `src/media/writer.rs:300` (request_keyframe), `src/streams/receive.rs` (NACK).
- windows 0.62.2: `src/Windows/Win32/Media/MediaFoundation/mod.rs`, `src/Windows/Win32/Graphics/Direct3D11/mod.rs`.
- Repositório: `e2e/bench/native/src/main.rs:249`, `e2e/bench/native/src/bin/presenter.rs:205-209,302`.

Primárias, web:
- [MS H.264 Video Decoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder)
- [MS D3D11 decoding in MF](https://learn.microsoft.com/en-us/windows/win32/medfound/supporting-direct3d-11-video-decoding-in-media-foundation)
- [CODECAPI_AVLowLatencyMode](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode)
- [MF_SA_D3D11_BINDFLAGS](https://learn.microsoft.com/en-us/windows/win32/medfound/mf-sa-d3d11-bindflags)
- [VideoProcessorBlt](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videocontext-videoprocessorblt)
- [OpenSharedResource1](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11device1-opensharedresource1)
- [ID3D12Device::OpenSharedHandle](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-opensharedhandle)
- [wgpu-hal dx12/device.rs (texture_from_raw)](https://github.com/gfx-rs/wgpu/blob/trunk/wgpu-hal/src/dx12/device.rs)
- [wgpu Device (create_texture_from_hal, as_hal)](https://docs.rs/wgpu/latest/wgpu/struct.Device.html)
- [egui-wgpu Renderer](https://docs.rs/egui-wgpu/latest/egui_wgpu/struct.Renderer.html)
- [Slint Image](https://docs.rs/slint/latest/slint/struct.Image.html)
- [iced shader](https://docs.rs/iced/latest/iced/widget/shader/index.html)

Secundária (só como exemplo de uso do mesmo caminho D3D11 handle → D3D12 → wgpu-hal): [tauri-apps/cef-rs osr_texture_import/d3d11.rs](https://github.com/tauri-apps/cef-rs/blob/02cd5a01/cef/src/osr_texture_import/d3d11.rs).
