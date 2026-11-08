# Handoff 002 — análise de desempenho Edge × Rust, para planejar o app Windows nativo em Rust

Foco da próxima sessão: **planejar a construção do app Windows nativo em Rust** (não medir mais). Este documento entrega os números e o que eles permitem ou não afirmar.

Anterior: `handoff/app-nativo-vs-enxuto/001 - 06_11_2026 benchmark etapas 1 a 2c.md` (etapas 1–2c, contexto do benchmark). Não repetido aqui.

## Onde está o trabalho

- Worktree: `E:\Projetos\stream-p2p\.claude\worktrees\app-nativo-edge-benchmark-0b34a3`, branch `claude/app-nativo-edge-benchmark-0b34a3`.
- **Nada commitado** desta campanha (usuário não pediu). Modificados: `e2e/bench-relay.js`, `e2e/bench/relay.html`, `e2e/bench/native/src/main.rs`, `e2e/bench/native/src/bin/presenter.rs`, `.scratch/app-nativo-vs-enxuto/05-poc-comparativo-latencia-ram.md`. Não rastreados: `docs/planos/{PLANO,ENTREGA}-benchmark-retomada.md`, `e2e/bench-relay.test.js`, `e2e/bench/results/*`. Decidir com o usuário se commita antes de começar.
- Registro completo e verificado: `docs/planos/ENTREGA-benchmark-retomada.md` (seções "Séries visíveis autorizadas…" e "Sonda de teto de bitrate"). Plano: `docs/planos/PLANO-benchmark-retomada.md`.
- Dados brutos: `e2e/bench/results/focusctl-20261107-*`, `focusctl-20261107-mres-*`, `kbps-probe-*` (JSON + `-focus.json` + `.log`).
- Trilha de decisão: `.scratch/app-nativo-vs-enxuto/map.md` (metas: latência < 100 ms ponta a ponta, < 5 ms por salto, RAM < 200 MB, sem quebrar Web/PWA), notas 01–06; resposta original em `answers/2026_11_04 app-nativo-vs-enxuto 001.md`.

## Resultados (RTX 4060 Ti, Windows 11, rede local boa, H.264 hardware, 1920×1080@60 pedido)

Latência = espectador (Edge). RAM/CPU = processo que captura e transmite.

**Sem relays**

| Configuração | Teto kbps | Enviado | Resolução | FPS | Latência ms | RAM MB / CPU % |
|---|---|---|---|---|---|---|
| Rust (WGC + NVENC + str0m) | 8000 | ~8,1 Mbps | 1906×1072 | 59–61 | 39–42 | 29–30 / 9–10 |
| Edge, balanced | 8000 | ~7,6 Mbps | 1428×804 | 44–48 | 59–76 | 208–212 / 60–71 |
| Edge, maintain-resolution | 8000 | ~8,0 Mbps | 1906×1072 | 25 | 63–69 | 193–201 / 61–69 |
| Edge, balanced (1 rodada, 15/10 s) | 20000 | 17,4 Mbps | 1428×804 | 48 | 99 | 216 / 58 |
| Edge, maintain-resolution (1 rodada) | 20000 | 19,4 Mbps | 1906×1072 | 49 | 61 | 197 / 77 |

**Cadeia transmissor → relay 1 → relay 2 → espectador** (só teto 8000)

| Configuração | Resolução | FPS | Latência ms | RAM MB / CPU % |
|---|---|---|---|---|
| Rust (relays Rust str0m) | 1906×1072 | 60 | 56–63 | 29 / 8–9 |
| Edge balanced (relays Rust) | 952×536 (2×), 1428×804 (1×) | 46–48 | 62–74 | 204–208 / 51–67 |
| Edge maintain-resolution (relays Rust) | 1906×1072 | 25 | 78–88 | 195–196 / 59–62 |

Relays Rust: 3 MB, 3–6% CPU cada. Espectador Edge: 139–163 MB. Zero congelamentos/perda. Todas as rodadas visíveis com observador de foco: 0 roubos de foco.

## O que os números sustentam (para o planejamento)

- Só o pipeline Rust entregou 1072p a 60 FPS; presenter ~7× menos RAM e ~7× menos CPU que o Edge (média 9% × 62,5%).
- Captura do Edge (getDisplayMedia) não passou de 44–49 dos 60 quadros/s em nenhuma rodada; causa não isolada.
- Edge a 8000 kbps troca resolução por FPS; a 20 Mbps chega a 1072p/49 FPS (inferência: taxa era o limite; `BENCH_KBPS` também muda `b=AS` e taxa inicial).
- Dois relays Rust somam 16–24 ms (média 20 ms) → ~8–12 ms por salto, acima da meta de 5 ms, mas medido com Edge decodificando no espectador e em loopback; custo por salto isolado do relay não medido.
- Relay Rust repassa RTP sem recodificar: não adapta bitrate por filho (ponto em aberto na `map.md`).

## O que NÃO está comprovado (não usar como premissa firme)

- Estabilidade: 3 rodadas por série; 20000 kbps = rodada única.
- Rede ruim (perda/jitter): não medida; TURN local não aguenta 3 × 8 Mbps.
- Segundo PC / outra GPU (AMD, Intel, sem encoder): não medido; presenter só testado com NVENC.
- Áudio, UI nativa, app real: fora da bancada. Captura de áudio do sistema já existe em `app/src-tauri/src/sysaudio.rs`.
- Espectador nativo: nunca medido (espectador sempre Edge).
- ADR: `.scratch/app-nativo-vs-enxuto/06-adr-decisao-arquitetural.md` ainda vazio/aberto; notas 03 (WGC) e 04 (toolkit UI: Slint × egui × iced, < 50 MB) abertas.

## Código reaproveitável (POC, não produção)

- `e2e/bench/native/src/bin/presenter.rs` (~500 linhas): WGC → D3D11 video processor BGRA→NV12 → Media Foundation H.264 (NVENC) → str0m; perfil 42e01f, bitrate fixo 8000 kbps (`BITRATE`, linha 41), sinalização JSON lines por stdin/stdout.
- `e2e/bench/native/src/main.rs` (~290 linhas): relay str0m repassa RTP intacto aos filhos; pedidos de keyframe sobem ao pai (1 a cada 500 ms).
- `e2e/bench/native/Cargo.toml`: `str0m 0.25` (feature `wincrypto`), `windows 0.62`, `serde_json`.
- App atual: Tauri em `app/src-tauri/` (`main.rs`, `cli.rs`, `picker.rs`, `sysaudio.rs`); Web em `web/` (relay atual com `replaceTrack`, `web/stream.js:148`).

## Lacunas que o plano precisa cobrir

1. Bitrate adaptativo no presenter (hoje fixo) e por filho nos relays.
2. Fallback de encoder (AMF, QSV, software) e GPUs sem encoder.
3. Espectador nativo (decode + render GPU) ou manter espectador Web; interoperabilidade com Web/PWA.
4. Rede ruim e TURN; reconexão (há trabalho prévio: `docs/planos/ENTREGA-recuperar-conexao.md`).
5. Áudio, UI, picker de janela, instalador (há entregas prévias em `docs/planos/ENTREGA-*`).
6. Escrever o ADR (06) antes das fatias.

## Restrições do usuário (manter)

- Testes não podem roubar foco: headless por padrão; janela visível só com autorização explícita (`BENCH_ALLOW_VISIBLE=1`), no monitor secundário.
- Sem commit, push, PR ou Jira sem pedido explícito. Não alterar CLAUDE.md.
- Não extrapolar: registrar limites, não declarar metas cumpridas com dados parciais.
- Responder em português.

## Skills sugeridas

- `criar-projeto` — arquitetura e stack do app nativo.
- `sabatina-mp` — fechar o ADR 06 com o usuário (decisões em aberto acima).
- `modelagem-de-dominio-mp` — vocabulário (transmissor, relay, espectador, salto, árvore).
- `prototipar-mp` — se for preciso validar espectador nativo ou toolkit de UI antes de decidir.
- `escrever-para-agentes-mp` — ao redigir o plano em fatias para agentes.
