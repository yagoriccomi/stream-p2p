# PLANO DE EXECUÇÃO — app-nativo

| Campo | Valor |
|---|---|
| **Tarefa** | `app-nativo` |
| **Origem** | descrição livre (mapa `.scratch/app-nativo-vs-enxuto/`) |
| **Tipo** | História |
| **Modo de execução** | 🔁 Loop no planejamento; construção fora deste mapa |
| **Data** | 2026-11-09 |
| **Branch** | `feature/app-nativo-<fatia>` (uma por fatia) |
| **ADR** | `docs/planos/ADR-app-nativo.md` |

---

## 1. Enunciado Canônico

- **Problema:** o app Tauri/WebView2 fica acima de 100 ms com captura real, cai para 534–801p e gasta ~190–228 MB (transmissor e relays Edge) [ADR §1].
- **Resultado esperado:** o executável nativo em Rust (`native/`) transmite, assiste e repassa com paridade ao Tauri e substitui o Tauri pela atualização automática.
- **Como validar:**
  - < 100 ms de ponta a ponta;
  - < 15 ms por salto;
  - RAM < 200 MB de working set por processo;
  - 1080p60 na NVIDIA;
  - paridade de [r10] marcada item a item.

## 2. Escopo

**Vou fazer:** as fatias da seção Fatias.

**NÃO vou fazer** [#8]:
- iPhone/Safari iOS garantido [a006#3];
- assinatura de código paga [a008#2];
- SDKs NVENC/AMF/VPL diretos [03];
- simulcast/SVC [09];
- mudar o protocolo WS ou o servidor [11];
- mexer no fluxo da web, exceto o aviso do Firefox [a008#7].

## 3. Premissas Assumidas

| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | Meta de RAM contra o working set, não private bytes | 07 mediu 155 MB WS / 308 MB private; a meta só fecha no WS [#99] | Rever a meta ou trocar o caminho de render (DComp direto) |
| P2 | Uma fatia = uma sessão de agente com critério medível | Pedido do ticket 12 [#31] | Dividir a fatia em a/b |
| P3 | Medições na RTX 4060 Ti deste PC até a fatia 13 | Único hardware disponível [a002#6] | Números de AMD/Intel saem na fatia 13 |
| P4 | Bancadas `e2e/bench/native` e `proto07` são fonte de código a portar, não dependência | São protótipos descartáveis [#6] | — |
| P5 | Meta de 100 ms medida pela mediana e inclui os ~60 ms de jitter buffer que o servidor define (`server/topology.js:14`) | 1a: mediana 95–97 ms, p95 107–110 ms [Loop] | Reduzir `jitterMs` do servidor para o nativo ou cobrar o p95 |
| P6 | Congelamento de 99–122 ms ao recriar o encoder na troca de bitrate fica para a fatia 8 | Meta de 100 ms é escolhida, não medida [Loop] | Trocar bitrate sem recriar o MFT (`CODECAPI_AVEncCommonMeanBitRate`) já na 1a |
| P7 | Fatias empilhadas: cada uma parte da branch da fatia de que depende, PR contra `feature/app-nativo` | Merge é do usuário (Regra nº 6) | Rebase quando o usuário mergear a anterior |

## 4. Decisão Visual

- **Tem superfície visual?** Sim: toda a UI do app.
- **Precisa de mockup?** Não: mesmo visual e fluxo da web atual [a003#12]. `web/index.html` e `styles.css` são a referência.
- **`design-de-interface-projeto` acionada?** Na fatia 2 (tela de assistir) e na fatia 6 (voz/chat), para portar os tokens de tema para `.slint`.
- **Referência visual existente:** `web/index.html`, `web/styles.css`, `docs/design/*.html`.

## 5. Terreno

| Arquivo | Papel hoje | O que muda |
|---|---|---|
| `e2e/bench/native/src/bin/presenter.rs` | captura WGC + MFT + str0m (bancada) | portar para `native/` (fatia 1) |
| `e2e/bench/native/src/main.rs` | relay RTP + BWE (bancada) | portar (fatias 3–4) |
| `e2e/bench/native/src/bin/transcode.rs` | recodificação 1080p→720p | portar (fatia 4) |
| `e2e/bench/proto07/src/main.rs` | Slint + vídeo D3D11→wgpu | portar (fatias 1b e 2) |
| `app/src-tauri/src/sysaudio.rs` | WASAPI loopback | desacoplar e mover (fatia 1a) |
| `app/src-tauri/src/cli.rs`, `main.rs` | CLI, bandeja, instância única, deep link | portar (fatia 9) |
| `app/src-tauri/hooks.nsh`, `tauri.conf.json` | instalador/updater | base da fatia 9 |
| `web/*.js` | lógica do produto | referência de comportamento; só `app.js`/`stream.js` ganham o aviso do Firefox (fatia 14) |
| `native/` | — | criar |

**Reaproveitamento** [#6]: ver ADR §2.1 (linha "Reaproveitado do Tauri").
**Convenções locais** [#5][#13]: Rust 2021, crate `windows` 0.62, mensagens WS iguais a `server/index.js:307-446`, textos em pt-BR.

## 6. Passos Atômicos

Cada fatia tem os seus passos atômicos, detalhados pelo agente no início da sessão. A ordem e o aceite estão na seção Fatias.

## Fatias

Limites marcados com **(meta escolhida)** não vêm de medição nem de decisão do usuário: são do autor do plano e podem ser revistos. `[#n]` = prática n de `~/.openclaude/skills/executar-projeto/references/100-melhores-praticas.md`; `[a008#n]` = item n de `answers/… 008.md`.

Ordem obrigatória: transmitir primeiro, com o teste de CPU do redesenho junto [a008#8, #9]. A fatia 1 foi dividida em **1a** e **1b**. Motivo: portar o presenter com sinalização WS real, áudio do sistema e o catálogo inicial, mais as três alternativas de render (skia, redesenho parcial, swap chain), não cabe numa sessão. Cada metade é medível sozinha. Elas se encaixam numa única janela no fim da 1b.

| Fatia | Módulo | Depende de | Critério de aceite medível | Estado |
|---|---|---|---|---|
| **1a** Transmitir pelo app (sem UI rica) | `native/` (núcleo: captura, encode, str0m, cliente WS, sysaudio) | — | Cria sessão no servidor real e um espectador Chrome/Edge/Firefox recebe 1080p60 com áudio do sistema. Latência ponta a ponta < 100 ms e transmissor < 200 MB WS (bancada: 30 MB, 87–103 ms [05]). Espectador que rejeita o formato não derruba o processo e cai para 42e01f [19]. Troca de bitrate ao vivo sem congelar > 100 ms (meta escolhida) [13] | PR #4 pronto (PASS; ressalvas P5/P6) |
| **1b** Tela de transmitir + teste de CPU do redesenho | `native/ui` | 1a | Janela Slint com picker e prévia do vídeo a 60 Hz. Mede CPU de femtovg × `renderer-skia` × redesenho parcial × swap chain/DComp sob a UI, 3 rodadas cada, e escolhe uma com CPU ≤ 25 % de um núcleo (meta escolhida; hoje 85–89 % com vídeo [07]); se nenhuma chegar, registra o melhor número e abre pergunta. Narrador lê os campos (UIA) [07] | PR #5 pronto (PASS na 2ª verificação; swapchain 5–9 % CPU) |
| **2** Assistir | `native/viewer` | 1b | Recebe de transmissor web e nativo; 1080p60 decodificado na GPU com `MF_LOW_LATENCY`. Latência até o vsync medida (hoje só até o submit: p50 16,5 ms [07]). Espectador < 200 MB WS. Perda: congela + PLI ≤ 1/500 ms [08]. Áudio Opus em sincronia por Sender Reports | em execução |
| **3** Repassar intacto | `native/relay` | 2 | Nativo assiste e repassa RTP intacto a um filho web e a um nativo; < 15 ms por salto (bancada 2–7 ms [05 2a]); +RAM do repasse < 10 MB (meta escolhida; bancada 4 MB [05 2a]); reconexão sem 409 (prazo 10 s, backoff 1/2/4/5 s [11]) | aberta |
| **4** Recodificação sob demanda + realocação | `native/relay` + `server/topology.js` só se precisar de mensagem nova (precisa de pergunta antes) | 3 | Com netsim limitando um filho a 2 Mbps, só ele recebe 720p em ≤ 2 s (meta escolhida; BWE abaixo de 2 Mbps em 3,3–4,0 s [18]), sem congelar os outros; custo ≤ 15 ms por salto (medido 4,2 ms [18]). Com a GPU disputada, o filho vai para outro relay com folga ou recebe o vídeo intacto [a008#4]. BWE entre dois relays nativos coerente (hoje ausente [18]) | aberta |
| **5** TURN | `native/net` | 1a | Conecta via coturn e Cloudflare em UDP, TCP e TLS 443, com credencial de `/ice.json` renovada antes de expirar [15]. Catálogo: aviso "servidor de apoio" | em execução |
| **6** Voz, chat e moderação | `native/voice`, `native/ui` | 2 | Voz em mesh com Opus, AEC/NS do Windows e PTT V [a008#6]. Teste de eco com alto-falante: o outro lado não ouve o próprio eco (avaliação gravada). Mixer, volume por pessoa, chat, renomear, passar a vez, silenciar, remover e banir iguais à web [r10] | aberta |
| **7** Demais formatos | `native/codec` | 2, 4 | VP8, VP9 (libvpx), AV1 (MFT ou dav1d) e H.265 (MFT) assistidos a 1080p60; transmitir onde a máquina permite, e o resto cai para H.264 com aviso [a005#1]. SDP anuncia só o que a máquina faz [20] | aberta |
| **8** Catálogo de problemas | `native/ui` + todos | 1a–7 | Cada linha do ADR §2.9 tem teste que provoca o problema e confere aviso, atalho e plano B. Inclui investigar a causa do `0x8000FFFF` e a recuperação [13] | aberta |
| **9** Instalador + updater + recursos do Tauri | `native/` (bundle, bandeja, CLI, deep link, instância única) | 1b | NSIS por usuário pt-BR com `hooks.nsh`; `latest.json` + minisign no GitHub; deep link `streamp2p://join` abre o nativo; CLI com os testes de `cli.rs` passando | em execução |
| **10** Medir o GOP | `native/` (bancada) | 3, 4 | Compara GOP 10 s + PLI × 2 s × 5 s: congelamento médio após perda e banda média, 3 rodadas cada; decide o intervalo [a008#5] | aberta |
| **11** Paridade | — (checklist) | 1a–9 | Cada linha de [r10] marcada como feita ou "some", com evidência | aberta |
| **12** Migração do Tauri | `app/` (última versão) + release | 11, 13 | A última atualização do Tauri instala o nativo, migra `server.txt` e `device` e remove o Tauri. Rollback: republicar o `latest.json` do Tauri [a008#3] | aberta |
| **13** Validação AMD/Intel e segundo PC | — (HITL) | 11 | Lista de verificação e executável para o usuário; AMD e Intel com troca ao vivo e `FLUSH` na Intel [14]; dois PCs em rede real < 100 ms | aberta |
| **14** Aviso do Firefox na web | `web/` | — | Espectador Firefox vê a dica com link do app [a008#7]; testes `e2e` passam | PR #3 pronto (PASS) |

Paralelismo possível: 5 e 14 rodam a qualquer momento depois da 1a; 9 depois da 1b.

## 7. Impacto em Dados e Contratos

- **Banco de dados:** nenhum.
- **Contrato de API:** WS inalterado [11]. A realocação da fatia 4 pode exigir mensagem nova: só com pergunta antes.
- **Configuração:** `server.txt` e `device` passam de `localStorage` para um arquivo do app [r10].
- **Dados pessoais (LGPD):** apelido e `device` aleatório, como hoje; sem login.

## 8. Plano de Testes

| Nível | O que cobre | Caminho de falha coberto |
|---|---|---|
| Unidade [#41] | histerese do BWE, SDP/fallback de formato, CLI, parsing de `/ice.json` | formato recusado, credencial expirada |
| Integração [#42] | `e2e/bench-relay.js` com nós nativos e navegadores (Chrome, Edge e Firefox headless com IP de LAN) | perda/limite via `e2e/netsim.js`, TURN fora |
| E2E [#43] | sessão real no servidor: transmitir, assistir, repassar, voz | reconexão, catálogo §2.9 |

**Comando para rodar:** `cargo test` em `native/`; `node --test e2e/`; bancadas `e2e/bench-relay.js` com `BENCH_*`.

## 9. Riscos e Rollback

Ver ADR §5.

**Rollback** [#84]: até a fatia 12, o Tauri segue distribuído e nada muda para o usuário. Depois da 12, republicar o `latest.json` do Tauri.

## 10. Definição de Pronto

- [ ] Todas as fatias com estado `revisada: pronta`
- [ ] Metas: < 100 ms ponta a ponta, < 15 ms/salto, < 200 MB WS, medidas e registradas
- [ ] Build passa
- [ ] Testes novos e existentes passam [#49]
- [ ] App conferido em sessão real com navegadores
- [ ] Sem segredo em código [#37]
- [ ] Erros tratados e logados, catálogo §2.9 coberto [#92][#93]
- [ ] Commits atômicos em Conventional Commits [#31][#32]
- [ ] `docs/planos/ENTREGA-app-nativo.md` escrito
- [ ] `CLAUDE.md` atualizado se surgir regra nova
