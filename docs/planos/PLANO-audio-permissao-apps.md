# PLANO DE EXECUÇÃO — audio-permissao-apps

| Campo | Valor |
|---|---|
| **Tarefa** | `audio-permissao-apps` |
| **Origem** | Handoff `handoff/audio-call-transmissao/001 - 23_10_2026 sabatina separacao audio.md` + sabatina do usuário |
| **Tipo** | Bug (vazamento de áudio) → corrigido como melhoria de produto |
| **Modo de execução** | 🔁 Loop (sem confirmação) |
| **Data** | 2026-10-23 |
| **Branch** | `fix/audio-permissao-apps-<modulo>` (uma por fatia) |

---

## 1. Enunciado Canônico

- **Problema:** no app desktop, transmitir em modo "Tela inteira" envia o áudio de **todos** os apps do PC (menos o próprio stream-p2p), incluindo apps de comunicação como Discord/WhatsApp — já documentado como limitação conhecida no README.
- **Resultado esperado:** o usuário escolhe explicitamente, numa lista de checkboxes, quais apps com som entram no áudio da transmissão em modo "Tela inteira". Por padrão todos vêm marcados (preserva o comportamento atual até o usuário agir).
- **Como validar:** reaproveitando o ciclo de teste Ana/Bruno/apito já construído na fase de diagnóstico — um app de teste com tom fixo, desmarcado na lista, não deve aparecer no stream de saída medido pelo espectador; marcado, deve aparecer.

## 2. Escopo

**Vou fazer:**
- Enumerar processos com sessão de áudio ativa (nome + PID) e expor via novo comando Tauri.
- Adicionar painel de lista de permissão no `dlg-setup`, visível só quando a fonte é "Monitor".
- Estender `system_audio_start` para aceitar uma lista de PIDs permitidos; capturar N processos em paralelo e mixar.
- Persistir a seleção por nome de processo em `localStorage`, padrão "tudo marcado".
- Atualizar o `README.md` (seção que documenta a limitação atual).
- Teste de regressão reaproveitando `e2e/_callleak.tmp.mjs` como base.

**NÃO vou fazer (escopo negativo)** [#8]:
- Lista de bloqueio automática (Discord/Teams/Zoom) — rejeitada na sabatina.
- Corrigir o modo "Janela" — já resolvido no commit `fd94a72`, fora de escopo aqui.
- Deduplicar captura quando o usuário seleciona manualmente pai e filho do mesmo processo (edge case raro, aceito como está).
- Suporte a plataforma não-Windows para esta função (já é `#[cfg(windows)]` no projeto).

## 3. Premissas Assumidas

| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | Enumerar apps via `AudioSessionManager`→`AudioSessionEnumerator`→`AudioSessionControl::get_process_id()` (crate `wasapi` já usado no projeto) | É a única API nativa para sessão de áudio ativa por PID; evita nova dependência [#4][#6] | Troca por outra enumeração COM equivalente, mesmo contrato externo |
| P2 | Nome do executável a partir do PID via `QueryFullProcessImageNameW` (crate `windows`, feature `Win32_System_ProcessStatus`) | API padrão do Windows para isso, sem nova dependência externa | Troca de função Win32, mesmo resultado |
| P3 | Captura multi-processo = N `AudioClient` em threads paralelas, mixados por soma de amostras `f32` com clamp `[-1,1]` | WASAPI não tem "loopback de lista de PIDs" nativo; é a única forma de somar N processos | Se a mixagem gerar artefato audível, revisar para média ponderada em vez de soma pura |
| P4 | Contrato novo: `system_audio_start(out, window, pids: Option<Vec<u32>>)` — `None`/vazio mantém `AllButApp` (compat retroativo) | Preserva comportamento atual sem flag extra [#28] | Ajustar assinatura, mesma semântica |
| P5 | Seleção persistida em `localStorage` por **nome do processo**, não PID (PID muda a cada execução) | Consistente com o padrão já usado pelo app (`sp2p.audio`) | Troca de chave, mesmo mecanismo |
| P6 | Painel de seleção fica dentro de `dlg-setup`, nova seção "Áudio da tela inteira", oculta quando a aba de fonte é "Janela" | Mockup aprovado via `design-de-interface-projeto`, reaproveita `.switch` existente [#13][#6] | Reposicionar painel, mesmo componente |
| P7 | Lista de apps atualiza por poll (não há evento nativo de "sessão de áudio criada/destruída" simples de assinar) | Simplicidade [#7]; apps abrem/fecham com baixa frequência relativa ao diálogo aberto | Trocar por `IAudioSessionNotification` se poll se mostrar insuficiente |

## 4. Decisão Visual

- **Tem superfície visual?** Sim.
- **Precisa de mockup?** Sim — tela nova dentro de diálogo existente.
- **`design-de-interface-projeto` acionada?** Sim — definiu: reusar componente `.switch` (nome do app + toggle), seção nova `.section` só visível com aba Monitor, estado vazio com texto `muted` no padrão de `#src-hint`, nunca tela em branco.
- **Referência visual existente:** `dlg-audio` (`mix-row`), `dlg-setup` (`.switch #q-audio`, `.src-grid`).

## 5. Terreno (o que já existe)

| Arquivo | Papel hoje | O que muda |
|---|---|---|
| `app/src-tauri/src/sysaudio.rs` | Captura 1 processo (ou `AllButApp`) | Captura N processos selecionados, mixados |
| `app/src-tauri/src/main.rs` | Comando `system_audio_start(out, window)`; novo comando ausente | `system_audio_start` ganha `pids`; novo comando `list_audio_sessions` |
| `app/src-tauri/build.rs` | Lista `COMMANDS` para ACL | Adiciona `list_audio_sessions` |
| `app/src-tauri/capabilities/default.json` | Permissões `allow-*` | Adiciona `allow-list-audio-sessions` |
| `app/src-tauri/Cargo.toml` | Features Win32 sem `ProcessStatus`/`Threading` | Adiciona as duas features |
| `web/app.js` | `appSystemAudio()` chama `system_audio_start(out, window)` | Passa lista de PIDs selecionados; novo fluxo de carregar/renderizar sessões |
| `web/index.html` | `dlg-setup` sem seção de apps | Nova seção "Áudio da tela inteira" com lista de `.switch` |
| `README.md` | Documenta limitação atual (tudo menos o app) | Atualiza para descrever a lista de permissão |

**Reaproveitamento** [#6]: componente `.switch` existente, padrão de poll já usado em outras telas do app, ciclo de teste Ana/Bruno/apito da fase de diagnóstico (`e2e/_callleak.tmp.mjs`).
**Convenções locais a seguir** [#5][#13]: comentários de cabeçalho explicando o "porquê" (padrão de todo o código já lido), erros sempre `Result<_, String>` com mensagem em português para o usuário, `#[cfg(windows)]` / `#[cfg(not(windows))]` espelhado em todo comando novo.

## 6. Passos Atômicos

| # | Arquivo alvo | O que muda (1 frase) | Prática | Como verificar |
|---|---|---|---|---|
| 1 | `app/src-tauri/Cargo.toml` | Adiciona features `Win32_System_ProcessStatus`, `Win32_System_Threading` | `[#4]` | `cargo check` compila |
| 2 | `app/src-tauri/src/sysaudio.rs` | Novo `pub fn list_sessions() -> Result<Vec<(u32, String)>, String>` (PID + nome) | `[#1][#13]` | Chamada manual retorna processos com som tocando no momento |
| 3 | `app/src-tauri/src/sysaudio.rs` | `enum Source` ganha variante `Allowlist(Vec<u32>)`; `capture()` mixa N `AudioClient` | `[#13]` | Teste de regressão (passo 8) mede silêncio/som por app selecionado |
| 4 | `app/src-tauri/src/main.rs` | Novo comando `list_audio_sessions`; `system_audio_start` recebe `pids: Option<Vec<u32>>` | `[#28]` | `cargo check`; chamada manual via CDP retorna lista |
| 5 | `app/src-tauri/build.rs` + `capabilities/default.json` | ACL do novo comando | `[#13]` | App sobe sem erro de permissão no IPC |
| 6 | `web/index.html` | Seção "Áudio da tela inteira" no `dlg-setup`, oculta fora da aba Monitor | `[#7][#13]` conforme mockup | Visual confere com o mockup aprovado |
| 7 | `web/app.js` | Carrega sessões via poll, renderiza `.switch` por app, persiste seleção em `localStorage` por nome, envia PIDs marcados em `system_audio_start` | `[#6]` | Teste e2e (passo 8) confirma seleção refletida na captura |
| 8 | `e2e/` (novo script baseado em `_callleak.tmp.mjs`) | Teste de regressão: app de teste com tom fixo desmarcado não vaza; marcado, vaza | `[#43]` | Script roda e os dois casos passam |
| 9 | `README.md` | Atualiza a seção que descreve a limitação do modo Tela inteira | `[#98]` | Leitura humana confere consistência |

## 7. Impacto em Dados e Contratos

- **Banco de dados:** nenhum.
- **Contrato de API:** `system_audio_start` ganha parâmetro opcional `pids` (retrocompatível — ausente/vazio = comportamento atual). Novo comando `list_audio_sessions` [#28].
- **Configuração:** nenhuma variável de ambiente nova.
- **Dados pessoais (LGPD):** nomes de processos locais do próprio usuário, nunca saem da máquina — nenhum impacto.

## 8. Plano de Testes

| Nível | O que cobre | Caminho de falha coberto |
|---|---|---|
| Manual/CDP | `list_audio_sessions` retorna PID+nome correto com app de teste tocando som | Lista vazia quando nada toca som |
| E2E (Ana/Bruno + app de teste) | App desmarcado não aparece no áudio da transmissão; marcado, aparece | Regressão do vazamento documentado (Discord/WhatsApp) |
| E2E (regressão) | Modo Tela inteira sem nenhuma seleção explícita ainda transmite tudo (compat) | Quebra do comportamento padrão esperado |

**Comando para rodar:** script novo em `e2e/`, mesmo padrão de `node e2e/_callleak.tmp.mjs` (ad-hoc, fora de `npm run e2e`).

## 9. Riscos e Rollback

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Mixagem por soma de N streams gera estouro/distorção audível | Média | Qualidade de áudio ruim na transmissão | Clamp `[-1,1]` por amostra; revisar para normalização se necessário |
| Threads de captura desincronizadas introduzem latência/jitter | Média | Áudio fora de sincronia com vídeo | Mesmo padrão de buffer/evento já usado hoje (100ms), por thread |
| `QueryFullProcessImageNameW` falha para processo elevado/protegido | Baixa | Nome não aparece, só PID | Fallback: mostrar PID como nome quando a consulta falhar |

**Rollback** [#84]: reverter para `Source::AllButApp` é um parâmetro (`pids: None`), sem precisar reverter commit — a UI nova pode ser ocultada por feature flag simples de CSS/JS se necessário.

## Fatias

| Fatia | Nível | Depende de | Branch | Estado |
|---|---|---|---|---|
| Backend Rust (sysaudio + IPC) | alto (general-purpose/opus — `alto.agent.md` não registrado como subagent_type nesta instalação) | nada | `fix/audio-permissao-apps-backend` | revisada: pronta ([PR #1](https://github.com/yagoriccomi/stream-p2p/pull/1)) |
| Frontend (UI lista de permissão) | alto | Backend Rust (contrato de API) | `fix/audio-permissao-apps-frontend` | revisada: pronta ([PR #2](https://github.com/yagoriccomi/stream-p2p/pull/2); coordenador completou a ligação `pids` que a fatia deixou pendente, commit `92dd6de`) |

## 10. Definição de Pronto

- [x] Todos os passos da seção 6 executados
- [x] Vazamento de apps externos (Discord/WhatsApp) não ocorre mais quando desmarcados — medido, não deduzido (`e2e/_audioallow.tmp.mjs`: marcado pico=0.134, desmarcado pico=0.000, tom confirmado tocando o tempo todo)
- [x] Build Rust (`cargo check`/build Tauri) passa
- [x] Testes novos e existentes passam [#49]
- [x] App subiu e o comportamento foi conferido de verdade via CDP + robôs Ana/Bruno
- [x] Sem segredo em código [#37]
- [x] Erros tratados e logados no nível certo [#92][#93]
- [x] Commits atômicos com Conventional Commits [#31][#32]
- [x] `docs/planos/ENTREGA-audio-permissao-apps.md` escrito
- [x] `README.md` atualizado (commit `308b3af`, branch frontend)
- [x] PRs abertos em rascunho, nunca mergeados
