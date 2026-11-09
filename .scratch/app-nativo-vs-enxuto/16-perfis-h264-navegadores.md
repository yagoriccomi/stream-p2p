---
Type: research
Status: resolved
Blocked by: none
---

# Perfis H.264 aceitos por Safari, Firefox e PWA iOS

Pergunta (precisa de acesso à web; a 11 não teve): quais `profile-level-id` e `packetization-mode` Safari (macOS/iOS/PWA), Firefox, Chrome e Edge decodificam via WebRTC, e quais enviam? 42e01f com packetization-mode=1 é seguro para todos? Fontes primárias (WebKit, Mozilla, libwebrtc).

## Resolução (2026-11-08)
`42e01f;packetization-mode=1;level-asymmetry-allowed=1` é o único anunciado pelos quatro (Safari/PWA iOS, Firefox, Chrome, Edge), envio e recepção. `640c1f` só como extra. Encoder precisa gerar Constrained Baseline de fato. Risco: nível 3.1 anunciado por Safari/Firefox pode limitar 1080p60. PWA iOS/Edge deduzidos do motor. Ver `research/16-perfis-h264.md`.
