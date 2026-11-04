# ENTREGA — audio-permissao-apps

| Campo | Valor |
|---|---|
| **Tarefa** | `audio-permissao-apps` |
| **Plano** | [`PLANO-audio-permissao-apps.md`](PLANO-audio-permissao-apps.md) |
| **Modo** | 🔁 Loop |
| **Data** | 2026-10-23 |
| **Branch / Commits** | `fix/audio-permissao-apps-backend` (`b78aac5`), `fix/audio-permissao-apps-frontend` (`0aab2d7`, `92dd6de`) |
| **Status** | ✅ Entregue |

---

## 1. O que foi feito

No modo "Tela inteira" do app desktop, a transmissão vazava o áudio de **todos** os programas do PC (menos o próprio app) — incluindo Discord e WhatsApp, mesmo com a pessoa em chamada. Agora existe uma lista de permissão: o usuário marca, um por um, quais apps com som entram na transmissão. Por padrão todos vêm marcados (mesmo comportamento de hoje), então quem não toca em nada não percebe diferença.

## 2. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `app/src-tauri/src/sysaudio.rs` | Nova `enum Source::Allowlist(Vec<u32>)`; `list_sessions()` enumera PID+nome de apps com áudio ativo; `capture_allowlist`/`capture_single_pid` capturam N processos em threads e mixam (soma `f32` com `clamp[-1,1]`) |
| `app/src-tauri/src/main.rs` | Novo comando `list_audio_sessions`; `system_audio_start` ganhou `pids: Option<Vec<u32>>` (retrocompatível: ausente/vazio = comportamento atual) |
| `app/src-tauri/build.rs`, `app/src-tauri/capabilities/default.json` | ACL do novo comando `list_audio_sessions` |
| `app/src-tauri/Cargo.toml` | Features `Win32_System_ProcessStatus`, `Win32_System_Threading` |
| `web/index.html` | Nova seção "Áudio da tela inteira" em `dlg-setup`, visível só na aba Monitor |
| `web/app.js` | Poll de sessões ativas, renderiza `.switch` por app, persiste seleção por nome em `localStorage`, envia PIDs marcados em `system_audio_start` |
| `e2e/_audioallow.tmp.mjs` | Teste de regressão (não versionado, convenção do projeto) — mede de verdade a filtragem por PID |

## 3. Como validar

1. Build: `cd app && cargo build` (dentro de `src-tauri`) — compila limpo.
2. Abrir o app, **Configurações → Tela inteira**: a lista de apps com som aparece, tudo marcado por padrão.
3. Desmarcar um app que está tocando som e compartilhar a tela inteira: esse app não aparece no áudio de quem assiste; os outros continuam.

**Comandos:**

```bash
cd app/src-tauri && cargo build
node e2e/_audioallow.tmp.mjs
```

## 4. Verificações executadas

- [x] Build — `cargo build` limpo, sem warnings novos (`Finished dev profile [unoptimized + debuginfo] target(s) in 1m 06s`)
- [x] Teste de regressão — **medido de verdade, não deduzido.** `e2e/_audioallow.tmp.mjs` fez um processo real tocar um tom fixo pelo WASAPI, chamou `system_audio_start` com `pids=[tonePid]` (marcado) e depois com `pids=[outroPID]` (o tom continua tocando, mas fora da lista). Resultado, duas rodadas limpas consecutivas:
  ```
  marcado (pids=[tonePid])        : pico=0.13413
  desmarcado (pids=[server pid])  : pico=0.00000
  VEREDITO: LISTA DE PERMISSÃO FUNCIONA — marcado traz o som, desmarcado filtra o mesmo processo mesmo com ele tocando.
  ```
  Sanity checks embutidos: o tom é capturável pelo caminho antigo (`AllButApp`) antes de confiar na medição da allowlist; o `AudioContext` do tom seguia `running` no fim do teste (o silêncio do "desmarcado" não é porque o tom parou).
- [x] Aplicação subiu e o comportamento foi conferido — app real aberto via CDP (WebView2), não simulação
- [x] Critérios de aceite do card — todos (vazamento medido fechado; compat retroativo preservado com `pids` ausente)

> Durante o diagnóstico, um `taskkill /IM chrome.exe` rodado por engano matou todos os processos do Chrome da máquina (não só os do teste). Foi corrigido na mesma sessão: o script agora mata só os PIDs que ele mesmo lançou, nunca por nome de imagem.

## 5. ⚠️ Premissas assumidas (revisar)

| # | Premissa | Por quê | Como mudar se estiver errada |
|---|---|---|---|
| P1 | Enumeração via `AudioSessionManager`→`AudioSessionEnumerator`→`get_process_id()` | Única API nativa para sessão de áudio ativa por PID, sem nova dependência | Trocar por enumeração COM equivalente, mesmo contrato externo |
| P2 | Nome do executável via `QueryFullProcessImageNameW` | API padrão do Windows, sem dependência externa | Trocar função Win32, mesmo resultado |
| P3 | Mixagem de N processos = soma de amostras `f32` com clamp `[-1,1]` | WASAPI não tem "loopback de lista de PIDs" nativo | Se gerar distorção audível, revisar para média ponderada |
| P4 | `system_audio_start(out, window, pids: Option<Vec<u32>>)` — `None`/vazio mantém `AllButApp` | Preserva comportamento atual sem flag extra | Ajustar assinatura, mesma semântica |
| P5 | Seleção persistida por **nome do processo**, não PID | PID muda a cada execução | Trocar chave, mesmo mecanismo |
| P6 | Lista de apps atualiza por poll, não por evento nativo | Simplicidade; apps abrem/fecham com baixa frequência relativa ao diálogo aberto | Trocar por `IAudioSessionNotification` se poll se mostrar insuficiente |

## 6. Decisão visual

- **Mockup:** sim — seção nova dentro de `dlg-setup`, reusando o componente `.switch` já existente no projeto.
- **`design-de-interface-projeto`:** acionada — definiu reuso de `.switch`, seção `.section` só visível na aba Monitor, estado vazio em `muted` no padrão de `#src-hint`.

## 7. Pendências e fora de escopo

- Lista de bloqueio automática (Discord/Teams/Zoom) — rejeitada na sabatina, não implementada de propósito.
- Correção do modo "Janela" — já resolvida em commit anterior (`fd94a72`), fora de escopo aqui.
- Deduplicação quando o usuário marca manualmente pai e filho do mesmo processo — edge case raro, aceito como está.
- `e2e/_audioallow.tmp.mjs` fica **não versionado** de propósito, seguindo a convenção já existente no projeto (~40 scripts `_*.tmp.mjs`/`.tmp.ps1` descartáveis e não rastreados).
- `README.md` atualizado nesta entrega (commit `308b3af` na branch do frontend) para descrever a lista de permissão em vez do vazamento antigo.

## 8. Próximo passo natural

PRs #1 e #2 estão em rascunho/prontos para revisão, nunca mergeados — o merge é do usuário.

## 9. Rastreabilidade

- **Jira:** não aplicável — projeto sem integração Jira configurada.
- **`CLAUDE.md`:** nada novo a registrar.
