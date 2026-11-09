---
Type: grilling
Status: resolved
Blocked by: 16
---

# Codec comum na árvore mista Web + nativo

Pergunta: a árvore força H.264 para todos (o espectador e o relay nativos só precisam de H.264), ou o nativo também decodifica VP9/AV1 quando o transmissor Web preferir? Hoje há codec preferido configurável (`web/stream.js:199`, `server/index.js:417-433`).

## Resolução (2026-11-08)
Árvore não força H.264. O nativo assiste e transmite os mesmos cinco formatos da web (H.264, VP8, VP9, AV1, H.265), com a mesma opção nas configurações; a opção da web fica como está. Sem decode na GPU, decoder embutido pelo processador. Ver `E:/Projetos/stream-p2p/answers/2026_11_08 app-nativo-vs-enxuto 004.md`.
