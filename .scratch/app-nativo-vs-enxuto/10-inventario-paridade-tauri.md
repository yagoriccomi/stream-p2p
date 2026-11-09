---
Type: research
Status: resolved
Blocked by: none
---

# Inventário de paridade com o app Tauri

Pergunta: lista exata do que o app Tauri + web faz hoje (transmitir, assistir, repassar, picker de tela/janela, áudio do sistema, convite/deep link, reconexão, prioridade de transmissão, instalador, SmartScreen, atualização) e onde cada item vive no código (`app/src-tauri/`, `web/`, `worker/`, `server/`). Marcar o que é reaproveitável em Rust e o que precisa ser reescrito.

## Resolução (2026-11-08)
Ver `research/10-paridade-tauri.md`. Rust atual reaproveita captura de áudio, bandeja, CLI, instância única, deep link e servidor configurável; todo WebRTC, voz, mixer, chat, moderação e UI (~1900 linhas JS) são reescrita; servidor e protocolo WS não mudam. Voz em mesh com supressão de ruído/eco entra na paridade.
