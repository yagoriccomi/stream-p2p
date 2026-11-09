---
Type: research
Status: resolved
Blocked by: none
---

# Captura e encoder para todas as GPUs

Pergunta: qual caminho WGC → textura D3D11 → H.264 funciona sem cópia para CPU em NVIDIA (NVENC), AMD (AMF) e Intel (QSV), e qual o fallback software (Media Foundation / openh264) para GPU sem encoder? Para cada um: API/crate em Rust, suporte a bitrate e resolução variáveis em tempo real, latência esperada, licença. Base: `e2e/bench/native/src/bin/presenter.rs` (só NVENC via MF, testado).

## Resolução (2026-11-08)
Caminho único Media Foundation (MFT de hardware) para NVIDIA/AMD/Intel, generalizando `presenter.rs`. Bitrate ao vivo via `CODECAPI_AVEncCommonMeanBitRate`; resolução ao vivo reiniciando o stream no mesmo MFT (keyframe; Intel exige `FLUSH`); FPS fixo. Escolher o MFT do mesmo adaptador da captura (híbridos). Fallback: MS H.264 software MFT (sem dependência, exige cópia para CPU); OpenH264 só se faltar, com binário Cisco baixado à parte. SDKs NVENC/AMF/VPL adiados. Alerta: Chromium evita MFT NVIDIA em constrained-baseline (perfil usado no presenter). Nada medido fora da RTX 4060 Ti. Ver `research/03-encoders.md`.
