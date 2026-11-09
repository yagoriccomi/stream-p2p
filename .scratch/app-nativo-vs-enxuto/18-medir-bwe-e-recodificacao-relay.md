---
Type: task
Status: resolved
Blocked by: none
---

# Medir BWE e recodificação no relay (AFK)

Pergunta: neste PC, com `e2e/netsim.js` simulando perda/limite de banda num filho, (1) quanto atraso o `enable_bwe` + `set_unpaced(true)` soma ao repasse em `e2e/bench/native/src/main.rs`, e a estimativa reage em quanto tempo? (2) quanto custa decode + escala + encode de um degrau (ex.: 720p) por salto, em ms e GPU/CPU? Cabe em < 15 ms? Headless, sem roubar foco. Base: `research/09-relay-recodifica.md`.

## Resolução (2026-11-08)

Detalhes em `research/18-bwe-e-recodificacao.md`.
- BWE + unpaced no relay: sem atraso mensurável (50.0 contra 49.7 ms de ponta a ponta, CPU igual, 3 rodadas cada). A estimativa TWCC reage a uma queda de 12 para 2 Mbps em ~250–280 ms e fica abaixo de 2 Mbps em 3–4 s. O limite valeu para todos os saltos, não para um único filho.
- Recodificação 1080p60 → 720p 4 Mbps (MS decoder DXVA + video processor + NVENC): 4.2 ms por quadro, p95 ≤ 6.1, máx ≤ 9.2. Cabe em < 15 ms. CPU ~30 % de um núcleo; NVENC +15 pp.
- Exige `MF_LOW_LATENCY` no decoder (sem ele, ~15 quadros de atraso). Com a GPU disputada, o p95 chegou a 25–31 ms.
