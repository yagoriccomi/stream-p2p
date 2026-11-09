---
Type: task
Status: resolved
Blocked by: 13 (resolvido)
---

# Validar 42e01f a 1080p60 contra Firefox e Safari iOS/PWA (HITL)

Pergunta: o presenter nativo oferecendo `42e01f` (packetization-mode=1) entrega 1080p60 a um espectador Firefox (neste PC, headless) e Safari iOS/PWA (iPhone do usuário), ou o nível 3.1 força resolução/FPS menores? Firefox o agente roda; Safari iOS o usuário roda com lista de verificação.

## Resolução parcial (2026-11-08) — Firefox

Firefox 159 headless recebe 1920x1080 a 60 fps, ~8 Mbps, lat 34–44 ms, com 42e01f e 42001f (3 rodadas cada; o nível 3.1 não limitou).
Main (4d001f) falha: o Firefox rejeita a m-line e o presenter entra em pânico (`RemoteSdp missing a=ice-ufrag/pwd`).
Detalhes, comandos e lista de verificação do Safari iOS/PWA: `research/19-firefox-1080p60.md`. Falta o Safari (HITL).

## Resolução (2026-11-09)

Fecha com o Firefox. iPhone (Safari iOS/PWA) fora do lançamento (answers 006 #3): não garantido na 1ª versão; lista de verificação fica em `research/19-firefox-1080p60.md` para depois.
