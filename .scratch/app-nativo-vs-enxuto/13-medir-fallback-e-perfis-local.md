---
Type: task
Status: resolved
Blocked by: none
---

# Medir fallback software e perfis H.264 neste PC (AFK)

Pergunta: neste PC (RTX 4060 Ti), forçando o MS H.264 software MFT, o presenter sustenta 1080p60 com que CPU/latência? E o MFT NVIDIA funciona com perfis constrained-baseline, baseline e main, aceitos pelo Edge espectador? Testar troca de bitrate e de resolução ao vivo. Headless, sem roubar foco. Base: `research/03-encoders.md`, `e2e/bench/native/src/bin/presenter.rs`.

## Resolução (2026-11-08)
Neste PC (RTX 4060 Ti, fonte sintética 1080p60 headless, sem relay, rede boa, 3 rodadas cada): MFT NVIDIA aceita constrained-baseline/baseline/main e o Edge decodifica os três a 1080p60, ~39–44 ms, 8 % CPU, 38 MB. Software MFT sustenta 1080p60 com latência igual (~38 ms) por ~1,5 núcleo (154 %) e 91 MB. Troca ao vivo de bitrate e resolução sem congelar (maior intervalo 53–54 ms; resolução nova ≤ ~50 ms; bitrate < 500 ms). Limites: um `ProcessOutput 0x8000FFFF` não investigado após troca de bitrate; `profile_idc` do SPS não conferido; só este PC e rede boa. Ver `research/13-fallback-e-perfis.md`.
