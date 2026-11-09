---
Type: research
Status: resolved
Blocked by: none
---

# Cliente TURN para str0m

Pergunta: qual crate (ou implementação própria) faz Allocate/Refresh/ChannelBind e encapsula o tráfego do str0m via TURN UDP/TCP/TLS, compatível com o coturn do projeto (`handoff/turn-proprio/`) e Cloudflare, com credencial REST de `/ice.json`? Licença, manutenção, esforço.

## Resolução (2026-11-08)
`turn-client-proto` 0.7.3 + `turn-client-rustls` 0.1.2 (MIT/Apache, sans-IO como o str0m; UDP/TCP/TLS; Allocate, Refresh, CreatePermission, ChannelBind). Credencial REST de `/ice.json` como usuário/senha; nova alocação antes de expirar (não troca credencial em alocação aberta). str0m: `Candidate::relayed`. Estimativa 300–500 linhas. Reserva `rtc-turn` 0.21.1 (sem TLS). Não testado contra coturn/Cloudflare. Ver `research/15-cliente-turn.md`.
