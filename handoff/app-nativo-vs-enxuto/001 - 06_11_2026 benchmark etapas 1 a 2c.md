# Handoff — app nativo vs. Edge enxuto (ticket 05) — 06/11/2026

## Onde está o trabalho

- **Worktree:** `E:\Projetos\stream-p2p\.claude\worktrees\app-nativo-edge-benchmark-0b34a3`
- **Branch:** `claude/app-nativo-edge-benchmark-0b34a3`. Nada foi enviado ao GitHub e não há PR.
- **Commits desta branch:**

| Commit | Conteúdo |
|---|---|
| `a73c74a` | Decisões dos protótipos |
| `f290548` | Etapa 1 |
| `cc32d4c` | Etapa 2a |
| `7eef674` | Etapa 2b |
| `555e6f4` | Etapa 2c |
| `66c115f` | Relatório com a etapa 2c |
| `b2831ac` | Correção dos gráficos do relatório |

  Este handoff entra no commit seguinte.
- **Regras do usuário:**
  - Responder em português do Brasil.
  - Commitar só na branch.
  - Pode abrir PR, mas nunca fazer o merge.
  - Confirmar antes de qualquer ação destrutiva.
- **Decisões já tomadas** (não perguntar de novo):
  - `answers/2026_11_04 app-nativo-vs-enxuto 001.md`
  - `answers/2026_11_05 app-nativo-vs-enxuto 002.md`
  - Os dois arquivos estão na pasta `answers/` da worktree.
- **Mapa e tickets:** `.scratch/app-nativo-vs-enxuto/`, com `map.md` e os tickets 01 a 06.
- **Ticket 05:** `.scratch/app-nativo-vs-enxuto/05-poc-comparativo-latencia-ram.md`. É a fonte detalhada das etapas 1, 2a, 2b e 2c.

## Metas (de `answers/…001`)

- Atraso ponta a ponta menor que **100 ms**.
- Cada salto de relay acrescenta menos de **5 ms**.
- App com menos de **200 MB** de RAM.
- A versão Web/PWA continua 100 % funcional.
- Prioridade: atraso primeiro, RAM em segundo.

## Ambiente da medição

- Um único PC: RTX 4060 Ti, 16 GB de RAM, Edge 156 (o mesmo motor do WebView2), Windows 11.
- Vídeo 1080p60 a 8 Mbps, com movimento de jogo.
- Árvore: transmissor → relay 1 → relay 2 → espectador.
- O atraso é lido de um relógio de 24 bits pintado no vídeo. O erro é de um quadro (±17 ms).
- Cada medição dura 15 s, depois de 20 s de estabilização.
- Rede local limpa. A rede ruim **não foi medida**.

## Resultados — conteúdo completo do relatório

O relatório está em `e2e/bench/relatorio.html` (versão 5, no repositório). O usuário vê a versão publicada; o próximo chat não tem acesso a ela, por isso todos os números estão abaixo.

### Etapa 1 e 2a — fonte desenhada direto no navegador (canvas), sem captura de tela

Atraso medido em cada nó, em ms. A RAM é a soma da memória privada de todos os processos do nó, em MB.

| Cenário | relay 1 | relay 2 | espectador | RAM (tx / r1 / r2 / espectador) | Codificação no relay, ms por segundo |
|---|---|---|---|---|---|
| Atual: Edge decodifica e recodifica | 41 | 68 | **82** | 231 / 212 / 210 / 162 | ~355 |
| Atual com flags de memória (`BENCH_LEAN`) | 59 | 83 | 126 | 224 / 200 / 195 / 139 | ~365 |
| Edge sem recodificar (Encoded Transform) | 58 | 20 308 | 34 502 | 230 / 207 / 185 / 153 | 2–4 |
| **Relays em Rust (str0m)** | — | — | **59** (59–68 nas rodadas) | 229 / **4 / 4** / 150 | 0 |

Sem relay, direto do transmissor ao espectador: 53–56 ms.

**Etapa 1 — relay de hoje e repasse sem recodificar no Edge:**
- O relay de hoje fica abaixo de 100 ms nessa rede. Cada salto custa cerca de 14 ms.
- As flags de memória economizam só 7 a 23 MB por nó.
- O repasse sem recodificar no Edge **não se sustenta**:
  - O Edge descarta, sem dar erro, quadros que não saíram do próprio codificador.
  - O caminho que ele aceita é um "codificador de fachada", a mesma técnica da criptografia ponta a ponta.
  - Esse codificador fica preso em ~30 quadros/s, e cada salto corta os quadros pela metade de novo. O atraso acumula até 34 s.
  - Hipótese: o controle de congestionamento vê quadros de ~20 bytes e segura o envio.
  - Também testei FPS máximo de 120 e de 1000, fachada de 2×2 e de 1080p e piso de banda de 6 Mbps. Nada mudou.

**Etapa 2a — relay em Rust:**
- O relay em Rust repassa ~880 pacotes/s sem perda.
- Cada salto custa cerca de 2–7 ms.
- Usa 4 MB de RAM e 3 % de CPU.

### Etapa 2b — captura real de uma janela

A "tela do jogo" é uma janela do Edge mantida sempre por cima das outras. O Edge a captura com `getDisplayMedia`, como o app faz.

| Cenário | Atraso no espectador | Sem relay (base) | Quadros/s · altura | RAM transmissor / relay | CPU do transmissor |
|---|---|---|---|---|---|
| App de hoje (Edge, VP8 no processador) | 190–243 ms | 90–111 | 32–46 · 801p | 228 / ~215 MB | 111–170 % |
| Edge transmite, relays em Rust | 115–183 ms | — | 32–49 · 801p | 227 / 3 MB | 81–146 % |
| **Tudo em Rust** (captura WGC + NVENC + str0m) | **87–103 ms** | 74–86 | **60 · 1070p** | **30 / 3 MB** | **~10 %** |

- Na versão toda em Rust, a codificação leva 4,6 ms por quadro e a conversão de cor 0,6 ms.
- Não houve nenhum travamento.
- Cada salto custa cerca de 7 ms.

### Etapa 2c — Edge com H.264 na placa de vídeo

| Cenário | Atraso no espectador | Quadros/s · altura | RAM transmissor / relay | CPU do transmissor |
|---|---|---|---|---|
| App de hoje com H.264 na placa de vídeo, relays do Edge recodificando | **97–120 ms** | 46 · 534p | 210 / ~190 MB | ~60 % |

- **Perfil básico (42e01f), o mesmo do Rust:** o Edge **não** usa a placa de vídeo e cai no codificador por software OpenH264. Resultado: 369 ms e 398p.
  - Também não funciona com `--enable-features=MediaFoundationH264CbpEncoding`.
- **Qualquer outro perfil H.264** (`BENCH_CODEC=h264any`): o Edge usa o codificador `NVIDIA H.264 Encoder MFT`.
- **Como detectar:**
  - `edge://gpu` confirma codificação por hardware até 1080p a 121 quadros/s.
  - `mediaCapabilities.encodingInfo` responde `powerEfficient: false`, então não serve para detectar.
  - `encoderImplementation` só aparece nas estatísticas quando há permissão de captura.
- **Primeira rodada instável:** em cada configuração, a primeira rodada saiu com 1 quadro/s e atrasos sem sentido, provavelmente aquecimento do codificador. As rodadas 2 e 3 repetiram 88–120 ms.
- **Repasse sem recodificar no Edge (`encoded`):** com H.264, o relay 2 não recebeu nada.
- **Leitura:** o H.264 na placa de vídeo resolve boa parte do **atraso**. A RAM e a qualidade continuam bem atrás da versão toda em Rust.

### Veredictos do relatório

- **Tudo em Rust atinge as metas.**
- **Trocar para H.264 na placa de vídeo fecha o atraso, não a RAM.**
- **Relay em Rust:** 4 MB de RAM e ~2–7 ms por salto.
- **Relay de hoje:** 82 ms no canvas, mas cerca de 14 ms por salto.
- **Repasse sem recodificar no Edge:** não se sustenta.
- **Flags de memória:** ganho pequeno.

### Limites da medição

- **Rede ruim:** não medida. O TURN local não aguenta três saltos de 8 Mbps.
- **Rodadas:** só uma a três por cenário.
- **Edge isolado, não o WebView2:** o app real soma o processo de GPU e a composição da janela.
- **Etapas 1 e 2a:** o codificador por software baixou o vídeo para 720p.
- **Janela sempre por cima:** a janela capturada fica no topo durante a medição, porque o Windows para de atualizar janelas totalmente cobertas.
- **Relay em Rust:** não mostra o vídeo. No app, quem assiste e repassa ao mesmo tempo ainda precisa decodificar uma vez para a tela.

## Código da bancada

- **`e2e/bench-relay.js`** — o roteiro que roda a bancada, controlado por variáveis de ambiente:
  - `BENCH_MODE`: `decode`, `encoded`, `native` ou `native-full`.
  - `BENCH_SCREEN=1`: captura a janela real.
  - `BENCH_NORELAY=1`: sem relay, para medir a base.
  - `BENCH_CODEC`: `vp8`, `h264` (perfil 42e01f) ou `h264any`.
  - `BENCH_HEADFUL`, `BENCH_EDGEARGS`, `BENCH_LEAN`, `BENCH_DIRECT`, `BENCH_SNAPSHOT`, `BENCH_SETTLE_MS`, `BENCH_MEASURE_MS`, `BENCH_LABEL`.
- **`e2e/bench/relay.html`** — a página de cada nó no Edge.
- **`e2e/bench/native/`** — crate Rust; compilar com `cargo build --release`:
  - `src/main.rs`: o relay. Usa H.264 quando `SP2P_CODEC=h264`, senão VP8.
  - `src/bin/presenter.rs`: o transmissor nativo (WGC → NV12 → NVENC via Media Foundation → str0m).
  - Detalhes que o fizeram funcionar:
    - chamar `Close()` em cada quadro capturado;
    - manter a janela de origem como `HWND_TOPMOST`;
    - abrir o Edge de origem sem a barra de automação (`ignoreDefaultArgs`);
    - passar `--disable-features=CalculateNativeWinOcclusion`.
- **`e2e/bench/results/*.json`** — dados brutos de cada rodada.
- **Exemplo:** `BENCH_MODE=decode BENCH_SCREEN=1 BENCH_CODEC=h264any BENCH_LABEL=x node bench-relay.js`, rodado em `e2e/`.

## O que falta (fronteira)

1. **PR da branch para a `main`.** O usuário ainda não decidiu. Abrir só se pedir, e nunca fazer o merge.
2. **Medir rede ruim.** Precisa de um caminho alternativo ao TURN local, por exemplo atrasar e perder pacotes no próprio relay em Rust ou no proxy UDP.
3. **Edge com H.264 na placa de vídeo e relays em Rust.** O relay em Rust precisa aceitar outros perfis além do 42e01f.
4. **Investigar a queda do Edge para 534p e 46 quadros/s** com H.264 na placa de vídeo: captura `getDisplayMedia` ou adaptação do WebRTC?
5. **Medir entre 2 PCs.**
6. **Ticket 06 (ADR):** depende dos tickets 03 e 04 e deste ticket 05.

## Skills sugeridas

- `executar-projeto`: para retomar a execução.
- `perguntas-simples`: antes de decidir os próximos passos.
- `git-flow-projeto`: para o PR.
- `mapear-caminho-mp`: para atualizar `map.md` e avançar ao ticket 06.
- `prototipar-mp`: para novas medições.
