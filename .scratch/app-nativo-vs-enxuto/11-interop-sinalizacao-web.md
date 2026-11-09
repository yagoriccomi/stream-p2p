---
Type: research
Status: resolved
Blocked by: none
---

# Interoperabilidade com sinalização e pares Web

Pergunta: o que o app nativo precisa falar para entrar na árvore atual ao lado de pares Web/PWA: protocolo de sinalização (`server/`, `worker/`), papéis na árvore, heartbeat/reconexão (`docs/planos/ENTREGA-recuperar-conexao.md`), ICE/TURN, codecs/perfis aceitos por Chrome/Edge/Safari/Firefox. O que no str0m 0.25 falta para isso.

## Resolução (2026-11-08)
WS JSON; servidor só repassa `signal` (vídeo, `nid`) e `vsignal` (voz); pai sempre oferece; falha/re-parent = conexão nova (sem renegociação nem ICE restart); prazo 10 s, backoff 1/2/4/5 s; `device` persistido evita 409; TURN de `/ice.json` (1 h); enviar `hopRtt`/`srcStats`. str0m 0.25 tem trickle ICE, Opus (FEC), data channel, H.264 42001f/42e01f/4d001f/64001f, VP8/VP9/AV1/H.265. Falta no str0m (app implementa): cliente TURN, jitter buffer adaptativo, estados/RTT/prazo, codec Opus. Ver `research/11-interop.md`.
