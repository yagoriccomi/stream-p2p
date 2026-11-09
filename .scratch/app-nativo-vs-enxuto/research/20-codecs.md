# 20 — VP8, VP9, AV1 e H.265 no app nativo em Rust

Ticket: [`../20-codecs-alem-do-h264.md`](../20-codecs-alem-do-h264.md). Data: 2026-11-08.
Base: `03-encoders.md` (MF para H.264), `08-espectador-nativo.md` (MF decoder D3D11 → wgpu), `09-relay-recodifica.md` (1 decoder + encoder por degrau), `16-perfis-h264.md`.
Legenda: **[F]** = fato com fonte; **[I]** = inferência; **[E]** = estimativa sem medição (não usar como dado).

## Recomendação

1. **Mesmo pipeline do H.264 (MFT + D3D11) para os quatro formatos**, escolhendo o MFT de hardware por `MFTEnumEx(HARDWARE, subtype)` com `MFVideoFormat_VP80/VP90/AV1/HEVC`. O código de 03/08 vira genérico por subtype: troca só o GUID e o perfil. É o que o Chromium faz para encode VP9/AV1/HEVC via MF [C1].
2. **Fallback software só onde o Windows não traz nada:**
   - VP8 e VP9: **libvpx** (BSD-3 + concessão de patente do Google) para decode e encode.
   - AV1 decode: **dav1d** (BSD-2). AV1 encode por CPU: **não oferecer** (SVT-AV1/rav1e a 1080p60 em tempo real é caro, [E]). Sem AV1 na GPU, o nativo não transmite AV1 e negocia outro formato.
   - H.265: **sem fallback embutido**. Decode via MFT da Microsoft só se a extensão HEVC estiver instalada; encode só na GPU. Embutir libde265/x265 traz risco de patente (pools HEVC) sem cobertura, ao contrário de OpenH264. O Chrome também só anuncia H.265 no SDP quando há hardware [W2].
3. **Anunciar no SDP só o que a máquina realmente faz** (como o Chrome): o str0m liga os cinco por padrão; desligar com `enable_h265(false)` etc. quando não houver caminho. A negociação cai em H.264/VP8.
4. **Relay (09):** um decoder por formato *de entrada* (o pai manda um só por vez), não cinco simultâneos. O encoder do degrau pode recodificar para H.264 na GPU (universal) se o filho aceitar. Reduz a matriz de encoders para 1 por relay.

Ordem sugerida de implementação: VP8 (obrigatório no WebRTC, RFC 7742) → VP9 → AV1 → H.265.

## str0m 0.25: como cada formato chega (código local)

Fonte: `~/.cargo/registry/src/*/str0m-0.25.0/src/`.

| Formato | Ligado por padrão | PT/perfis anunciados | Depacketizador → `MediaData.data` | Keyframe |
|---|---|---|---|---|
| H.264 | sim (`config.rs:327`) | 7 PTs: `42001f`, `42e01f`, `4d001f`, `64001f`, pm 0/1 (`format/codec_config.rs:388-405`) | Annex B com `00 00 00 01` (08) | NALU 5 |
| H.265 | sim (`config.rs:335`); comentário: "still considered an experimental/hidden codec in parts of the public API" (`codec_config.rs:409-412`) | 1 PT, Main, Main tier, level-id 180 = nível 6.0 (`codec_config.rs:425`) | Annex B com `ANNEXB_NALUSTART_CODE` (`packet/h265.rs:53, 1455, 1516, 1580, 1614`), trata AP, FU e PACI | `H265CodecExtra.is_keyframe` (`media/event.rs:294`) |
| VP8 | sim (`config.rs:319`) | 1 PT sem fmtp (`codec_config.rs:372-385`) | quadro VP8 cru, descritor removido (`packet/vp8.rs`) | `Vp8CodecExtra.is_keyframe` |
| VP9 | sim (`config.rs:352`) | 2 PTs: `profile-id=0` e `profile-id=2` (10 bits) (`codec_config.rs:475-502`) | quadro VP9 cru; packetizer padrão **NonFlexible** ("Compatible with all major browsers"; Flexible "causes issues with Safari") (`packet/vp9.rs:15-25`) | `Vp9CodecExtra.is_keyframe`; traz mapa de camadas SVC |
| AV1 | sim (`config.rs:360`) | 1 PT sem fmtp (`codec_config.rs:505-518`) | OBUs em formato "low overhead" com `obu_has_size_field` forçado (`packet/av1.rs`, `obu.header \|= OBU_SIZE_PRESENT_MASK`), ou seja, *temporal unit* pronto para dav1d/MFT | bit N do cabeçalho de agregação (`av1.rs:16-22`) |

Notas:
- `contiguous`, `request_keyframe(Pli)` e o resto do fluxo de perda do 08 valem igual para todos. Há verificação de contiguidade específica para VP8/VP9 (`packet/contiguity_vp8.rs`, `contiguity_vp9.rs`).
- Perfil VP9 2 (10 bits) é anunciado por padrão. O caminho 8 bits (NV12) não decodifica perfil 2 sem P010. **Desligar o PT 100** ou suportar P010. [I]
- H.265 só com nível 6.0 anunciado; a interoperabilidade com o `level-id` do Chrome precisa de teste (o WPT do Chromium tem testes específicos de `level-id` [W3]). [I]

## Windows / Media Foundation

| Formato | Decoder MS embutido | Encoder MS embutido | Fonte |
|---|---|---|---|
| H.264 | sim (Win 7+), DXVA ou software | sim (Win 7+) | [M1] |
| H.265 | MFT `hevcdecoder.dll` / `hevcdecoder_store.dll`, Main/Main10, Annex B, DX11/DX12 DXVA, "at higher resolutions … otherwise, decoding is done with software" | MFT `Mfh265enc.dll`, só Main 4:2:0 8 bits, CBR, `ForceKeyFrame`, `AVLowLatencyMode` | [M2][M3] |
| VP8, VP9, AV1 | **não** listados nos formatos nativos de MF [M1][M4]. VP9 e AV1 vêm por extensões da Store ("VP9 Video Extensions", "AV1 Video Extension") [M5] | não | [M1][M4][M5] |

- A tabela "Supported Media Formats" (atualizada em 2025) só lista H.264 entre os formatos modernos; HEVC aparece em "Codec Objects" mas, na prática, o decoder depende da **HEVC Video Extension** (o Edge diz: "Requires a valid HEVC Video Extension and a working HEVC decoder path") [M5]. O nome `hevcdecoder_store.dll` aponta nessa direção. [I]
- MFTs de hardware dos fabricantes registram subtypes próprios (VP9/AV1/HEVC) e o Chromium usa MF para encode H.264, VP9, AV1 (Main) e HEVC (Main) [C1]. **VP8 não está no encoder MF do Chromium** [C1]. [I] Encode VP8 por hardware no Windows é praticamente inexistente; tratar VP8 como software.

## GPU por fabricante (encode / decode)

| Formato | NVIDIA [N1] | AMD (VCN) [A1] | Intel [I1][I2] |
|---|---|---|---|
| H.265 encode | Maxwell 2ª (GM206)+; B-frames a partir de Turing 7ª geração | VCN 2.0+ (8/10 bits) | 6ª/7ª geração Core+, Arc |
| H.265 decode | GM206+ | VCN 2.0+ | 6ª geração+ (10 bits 7ª+), Arc |
| VP8 decode | Maxwell 2ª+, Pascal varia por chip | **não listado** na tabela da AMF | iGPUs até Tiger Lake; **Arc/DG2 não** [I3] |
| VP8 encode | **não** (tabela NVENC não tem VP8) | não | não |
| VP9 decode | GM206 (8 bits)+; Pascal+ 10/12 bits | VCN 2.0+ | 6ª geração+; Arc |
| VP9 encode | **não** | **não** (sem coluna de encode VP9) | sim em Arc A/B e Core Ultra [I1] |
| AV1 decode | Ampere (RTX 30)+ | VCN 3.0+ (RDNA2) | Tiger Lake (11ª)+, Arc |
| AV1 encode | Ada (RTX 40)+ | VCN 4.0+ (RDNA3) | Arc A/B, Core Ultra [I1] |

Consequência [I]: **transmitir VP9 em GPU só funciona na Intel**; em NVIDIA/AMD, VP9 encode = libvpx em CPU. AV1 encode exige GPU de 2022+.

## Tabelas por formato

Tamanho e CPU são **[E]** (ordem de grandeza, sem medição neste projeto). A única referência medida de software é a do libde265 (abaixo), em hardware de 2012.

### VP8

| Item | Valor |
|---|---|
| GPU encode | nenhuma das três [N1][A1][I1] |
| GPU decode | NVIDIA Maxwell 2ª+; Intel iGPU antigas; AMD não; via MF depende de o driver registrar MFT VP8 [I] |
| Fallback software | libvpx (decode + encode `realtime`) |
| Crate | `vpx-encode` 0.6.2 (só encoder, 2022) + `env-libvpx-sys` 5.1.3 (FFI; **não compila libvpx**, linka via pkg-config/`VPX_LIB_DIR`, `VPX_STATIC=1`) [R1][R2]. Decoder: chamar `vpx_codec_decode` pelo `-sys` |
| Licença | libvpx BSD-3 [L1] — compatível com GPLv3 |
| Patente | concessão do Google "no-charge, royalty-free, irrevocable", termina se o licenciado processar [L2] |
| Tamanho | libvpx estática ~2–4 MB (VP8+VP9) [E] |
| CPU 1080p60 | decode ~1 núcleo; encode realtime 2–4 núcleos [E] |

### VP9

| Item | Valor |
|---|---|
| GPU encode | **só Intel** (Arc, Core Ultra) [I1] |
| GPU decode | NVIDIA GM206+, AMD VCN 2.0+, Intel 6ª geração+ [N1][A1][I1] |
| Fallback software | libvpx (mesma lib do VP8) |
| Crate | idem VP8 |
| Licença / patente | idem VP8 [L1][L2] |
| Tamanho | incluso na libvpx acima |
| CPU 1080p60 | decode 1–2 núcleos; encode realtime 4+ núcleos [E] — caro para o transmissor; **evitar transmitir VP9 em CPU** |

### AV1

| Item | Valor |
|---|---|
| GPU encode | NVIDIA Ada+, AMD VCN 4.0+, Intel Arc/Core Ultra [N1][A1][I1] |
| GPU decode | NVIDIA Ampere+, AMD VCN 3.0+, Intel Tiger Lake+ [N1][A1][I2] |
| Fallback software decode | dav1d |
| Fallback software encode | SVT-AV1 (BSD-3-Clear + AOM Patent License 1.0) [S1] ou rav1e 0.8.1 (BSD-2 + AOM PL; "near real-time" no preset 10; precisa de NASM) [R3][L3] — **não recomendado** |
| Crate | `dav1d` 0.11.1 (MIT; **linka libdav1d do sistema** via `system-deps`; no Windows via vcpkg; "Might not work for >1.5.0") [R4] |
| Licença | dav1d BSD-2 [L4]; AV1 com AOM Patent License 1.0, royalty-free [L5] |
| Patente | AOM PL 1.0 (royalty-free, modelo W3C RF) [L5] |
| Tamanho | libdav1d ~1–2 MB [E]; encoder SVT-AV1 ~5–10 MB [E] |
| CPU 1080p60 | decode dav1d ~1–2 núcleos [E]; encode em CPU tempo real muito caro [E] |

### H.265

| Item | Valor |
|---|---|
| GPU encode | NVIDIA GM206+, AMD VCN 2.0+, Intel 6ª/7ª+ [N1][A1][I1]; via MFT do fabricante |
| GPU decode | idem; MFT MS `hevcdecoder` com DX11/DX12 DXVA [M2] |
| Fallback software | MFT MS decoder (software "otherwise") **se** a HEVC Video Extension estiver instalada [M2][M5]; MFT encoder MS `Mfh265enc.dll` [M3]. Embutir: libde265 (LGPL, só decoder maduro; 1080p a 150 fps / 45% CPU num i7-2700K) [L6] — **não recomendado** |
| Crate | nenhuma madura sem FFI; usar MF pelo `windows` 0.62 (já em uso) |
| Licença | MF = parte do Windows; libde265 LGPL (compatível com GPLv3, exige link dinâmico ou entrega de objetos) [L6] |
| Patente | **risco**: H.265 tem pools de patente; nenhuma das libs livres traz licença de patente (ao contrário do binário OpenH264 da Cisco para H.264). Usar só os codecs licenciados do Windows/driver [I] |
| Tamanho | 0 (Windows/driver) |
| CPU 1080p60 | GPU ~0; software MS não medido [E] |
| Navegadores | Chrome 136+ envia/recebe H.265 no WebRTC **só com hardware**; Firefox não; Edge removeu [W1][W2] |

## Impacto no relay (09)

- Decoder: 1 instância por relay, do formato que o pai envia. Trocar de formato só se o transmissor renegociar (raro). [I]
- Encoder do degrau: precisa ser um formato que o filho aceita. Como todo navegador aceita H.264 (16), **recodificar sempre para H.264 na GPU** evita encoders VP9/AV1 em CPU no relay. Custo: o filho perde a eficiência de AV1/VP9 só enquanto estiver recodificado. [I]
- Se o pai mandar VP9 e o relay não tiver decode VP9 na GPU, o decode cai em libvpx na CPU (ordem de 1–2 núcleos a 1080p60 [E]). Aceitável para 1 decoder por relay.
- Repasse puro (sem recodificar) independe de codec: o str0m repassa qualquer um dos cinco.

## Riscos

1. **Extensões da Store** (HEVC, VP9, AV1) podem faltar; o nativo não pode depender delas para VP9/AV1. Por isso libvpx e dav1d embutidos.
2. **Crates Rust finas**: `env-libvpx-sys` e `dav1d` não compilam a lib C; o build Windows precisa de vcpkg/estático. Trabalho de empacotamento não estimado.
3. **VP9 profile 2 e AV1 10 bits** exigem P010 no pipeline; o 08 assume NV12.
4. **H.265 patente**: só usar o que o Windows/driver fornece.
5. Nenhum número de CPU/latência foi medido para esses formatos; medir antes de fixar metas.

## Fontes

- [M1] Microsoft Learn, Supported Media Formats in Media Foundation: https://learn.microsoft.com/en-us/windows/win32/medfound/supported-media-formats-in-media-foundation
- [M2] Microsoft Learn, H.265 / HEVC Video Decoder: https://learn.microsoft.com/en-us/windows/win32/medfound/h-265---hevc-video-decoder
- [M3] Microsoft Learn, H.265 / HEVC Video Encoder: https://learn.microsoft.com/en-us/windows/win32/medfound/h-265---hevc-video-encoder
- [M4] Microsoft Learn, Codec Objects: https://learn.microsoft.com/en-us/windows/win32/medfound/codecobjects
- [M5] Microsoft Learn, Fix Edge Video Playback Problems (tabela de codecs): https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues
- [C1] Chromium, `media_foundation_video_encode_accelerator_win.cc`: https://chromium.googlesource.com/chromium/src/+/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc
- [N1] NVIDIA Video Encode and Decode Support Matrix: https://developer.nvidia.com/video-encode-decode-support-matrix
- [A1] AMD AMF Wiki, GPU and APU HW Features and Support: https://github.com/GPUOpen-LibrariesAndSDKs/AMF/wiki/GPU%20and%20APU%20HW%20Features%20and%20Support
- [I1] Intel, Video Codecs Supported by Intel Arc GPUs: https://www.intel.com/content/www/us/en/support/articles/000098345/graphics.html
- [I2] Intel, Media Capabilities Supported by Intel Hardware: https://www.intel.com/content/www/us/en/docs/onevpl/developer-reference-media-intel-hardware/1-1/overview.html
- [I3] Intel media-driver, `docs/media_features.md` (VP8 sem DG2): https://github.com/intel/media-driver/blob/fcb8d5744a3c4ccc802e40c5d087ed4749764269/docs/media_features.md
- [R1] crates.io `vpx-encode` 0.6.2: https://crates.io/crates/vpx-encode
- [R2] docs.rs `env-libvpx-sys` 5.1.3: https://docs.rs/crate/env-libvpx-sys/latest
- [R3] docs.rs `rav1e` 0.8.1: https://docs.rs/crate/rav1e/latest
- [R4] docs.rs `dav1d` 0.11.1: https://docs.rs/crate/dav1d/latest
- [S1] SVT-AV1 README: https://gitlab.com/AOMediaCodec/SVT-AV1/-/blob/master/README.md
- [L1] libvpx LICENSE: https://github.com/webmproject/libvpx/blob/main/LICENSE
- [L2] WebM Additional IP Rights Grant: https://www.webmproject.org/license/additional/
- [L3] rav1e LICENSE e PATENTS: https://github.com/xiph/rav1e
- [L4] dav1d COPYING (BSD-2): https://github.com/videolan/dav1d/blob/master/COPYING
- [L5] AOMedia Legal / Patent License 1.0: https://aomedia.org/about/legal/
- [L6] libde265 README: https://github.com/strukturag/libde265
- [W1] blink-dev, Intent to Ship: H265 in WebRTC: https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c
- [W2] Hiszpanski, "Does your browser support WebRTC + HEVC?" (Chrome 136, SDP só com hardware): https://www.hiszpanski.name/posts/is-webrtc-hevc-supported/
- [W3] WPT `webrtc/protocol/h265-level-id.https.html`: https://chromium.googlesource.com/external/github.com/web-platform-tests/wpt/+/refs/tags/merge_pr_54362/webrtc/protocol/h265-level-id.https.html
- str0m 0.25.0, fonte local: `~/.cargo/registry/src/*/str0m-0.25.0/src/` (`config.rs`, `format/codec_config.rs`, `packet/{h265,vp8,vp9,av1}.rs`, `media/event.rs`).
