---
Type: research
Status: resolved
Blocked by: none
---

# Encoder e decoder de VP8, VP9, AV1 e H.265 em Rust

Decisão (17): o nativo assiste e transmite os cinco formatos da web. Pergunta: para cada formato, qual caminho de encode e decode na GPU (MFT do Windows por fabricante: NVIDIA/AMD/Intel, gerações com suporte) e qual fallback software embutível (libvpx, dav1d, SVT-AV1/rav1e, libde265/x265, openh264), com crate Rust, licença (compatível com GPLv3), patente (H.265), tamanho no instalador e custo de CPU estimado a 1080p60? Como o str0m 0.25 empacota cada um (RTP, perfis, `MediaData`). Impacto no relay que recodifica (09): um decoder por formato. Base: `research/03-encoders.md`, `08-espectador-nativo.md`, `09-relay-recodifica.md`, `16-perfis-h264.md`.

## Resolução (2026-11-08)
Mesmo pipeline MF+D3D11 do H.264 para os quatro, trocando subtype/perfil. VP8/VP9: libvpx embutida (BSD + patente Google); nenhuma GPU codifica VP8, só Intel codifica VP9. AV1: decode GPU (RTX 30+, RDNA2+, Tiger Lake+) ou dav1d (BSD-2); encode só GPU (RTX 40+, RDNA3+, Arc), CPU a 1080p60 inviável. H.265: só GPU/MFT do Windows (extensão da Store), sem lib embutida por patente. str0m 0.25 já negocia/depacketiza os cinco; desligar no SDP o que a máquina não faz. Relay: 1 decoder do formato do pai, recodifica para H.264. Riscos: extensões da Store podem faltar; build C de dav1d/libvpx no Windows; str0m anuncia VP9 perfil 2 (P010, espectador assume NV12); H.265 nível 6.0. Nada medido. Ver `research/20-codecs.md`.
**Conflito com a 17, resolvido em `answers/… 005.md`:** avisa, oferece atalho e cai para H.264 quando transmitir AV1 sem GPU compatível e decodificar H.265 sem GPU/extensão não têm caminho viável.
