# Handoff — separação de áudio call vs. transmissão — 2026-10-23

## Contexto

Bug relatado pelo usuário: no app desktop (Tauri, Windows) do stream-p2p, quando se transmite em modo **"Tela inteira"**, a transmissão não separa o áudio de comunicação (call) do áudio de jogos/apps. Dois tipos de vazamento relatados:

1. **Apps externos de comunicação** (Discord, WhatsApp) — vazamento já documentado no projeto.
2. **Call interna do próprio app** (`VoiceMesh`) — vazamento suspeito, ainda **não confirmado por medição**.

Comportamento esperado pelo usuário: a transmissão deve levar **apenas áudio de jogos e apps**, nunca áudio de sistemas de comunicação (nem interno, nem externo).

Modo **"Janela"** (compartilhar uma janela específica) não apresentou esse problema nos testes do usuário — mas ele relatou que, em algum teste anterior, "janela nem tinha som". Isso pode ser o bug do canal Tauri reaproveitado, já corrigido no commit `fd94a72` ("fix(som): a janela compartilhada não fica mais muda") — **não confirmado se a build testada pelo usuário já tinha essa correção**.

Plataforma confirmada: app desktop. Web não testado para esse cenário.

## Estado da investigação (metodologia: `diagnosticar-bugs-mp`, ainda na Fase 3 — hipóteses, sem instrumentação)

### Arquitetura de áudio (confirmada por leitura de código)

- **Call**: `web/voice.js` (`VoiceMesh`) — malha P2P de áudio entre participantes, client-side, sem servidor.
- **Transmissão**: `web/stream.js` (`VideoNet`) — árvore P2P (presenter → relay → filhos) de vídeo+áudio. Áudio de saída vem de `getDisplayMedia` (web) ou, no app, de `web/sysaudio.js` + `app/src-tauri/src/sysaudio.rs` (loopback WASAPI nativo).
- Os dois sistemas **não se misturam no código** — são streams P2P distintos, sem mixer unindo os dois.

### Causa técnica provável (confirmada em código, não em teste)

`app/src-tauri/src/sysaudio.rs` linhas 30-34, 72-75:

```rust
// Whose sound goes out. Excluding only the app leaves any other voice chat (Discord, WhatsApp) in
// the mix, and the friend hears themselves back; a shared window narrows it to that program.
enum Source {
    AllButApp,
    Program(u32),
}
```

- Modo **"Tela inteira"** → `Source::AllButApp`: captura WASAPI de **tudo que toca no PC, exceto a árvore de processos do próprio app**. Isso inclui Discord, WhatsApp, e qualquer outro programa com som.
- Modo **"Janela"** → `Source::Program(pid)`: captura só a árvore de processos do programa compartilhado (via `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`), isolando por processo.
- A voz **interna** do app (`VoiceMesh`) toca dentro do próprio processo do app, que *deveria* já estar excluída pelo `AllButApp`. Se o usuário está ouvindo vazamento mesmo assim, há duas explicações possíveis a confirmar: (a) é apenas o Discord vazando e o usuário está atribuindo à call interna por engano; (b) há algum caminho de áudio da call interna que não passa pela exclusão de processo (ex: tocado via dispositivo de saída diferente, ou via loopback do próprio navegador/Chromium em paralelo ao WASAPI nativo).

### Documentação relevante já existente no projeto

- `docs/planos/ENTREGA-audio-do-sistema-no-app.md` — histórico da implementação do loopback WASAPI, incluindo a seção "Som só da janela compartilhada" (pedido: "A pessoa que está vendo a transmissão sempre se escuta" — resolvido parcialmente ao implementar o modo por processo para janela). Pendência registrada: "Modo tela leva tudo do PC menos o app, inclusive o Discord: para não devolver vozes, transmita a janela."
- `docs/planos/ENTREGA-som-e-volume.md` — corrige o bug "janela sem som" (canal Tauri reaproveitado ao trocar fonte, numeração de mensagens reinicia e a página trava esperando mensagens fora de ordem). Commit `fd94a72`. Reafirma a mesma pendência do modo tela.

### Ciclo de feedback disponível (já existe no projeto, reusável)

O usuário já tem uma infraestrutura de teste automatizado com **navegadores-robô** ("Ana" e "Bruno"):
- Cada robô usa um microfone de mentira com apito fixo e contínuo.
- Mede nível de áudio recebido do outro lado (número, não percepção).
- Scripts de exemplo citados: `e2e/_boost.tmp.mjs` (29 checagens — não versionado), `e2e/_full3.tmp.mjs` (teste de janela com YouTube).
- Esse padrão é a base ideal para a Fase 1 da skill `diagnosticar-bugs-mp`: montar um ciclo que (a) Ana fala pelo VoiceMesh com apito fixo, (b) app transmite Tela inteira, (c) mede se o apito aparece no stream de saída que um terceiro robô (espectador) recebe. Esse ciclo **ainda não foi construído** — é o próximo passo técnico.

## Decisões em aberto (sabatina `sabatina-mp`, rodada enviada, resposta pendente)

Rodada de 3 perguntas foi enviada ao usuário em Markdown (ferramenta `AskUserQuestion` está bloqueada nesta sessão por "don't ask mode" — tentativa falhou, ver abaixo). **Resposta ainda não recebida** quando este handoff foi escrito.

1. **[Importante] Versão testada**: a build onde o usuário viu "janela sem som" era a mais recente (pós-commit `fd94a72`) ou uma instalação antiga? Decide se o bug da janela ainda precisa de trabalho ou já está resolvido.
2. **[Bloqueante] Prova do vazamento da call interna**: o usuário já mediu (com apito fixo) se a voz do `VoiceMesh` vaza para a transmissão em Tela inteira, ou é dedução? Decide se é preciso construir um novo ciclo de teste antes de atacar a causa.
3. **[Bloqueante] Estratégia de correção preferida**: três opções apresentadas —
   - (A) Lista de permissão (usuário escolhe o que entra) — recomendada por mim, único caminho que cumpre "apenas jogos e apps" sem depender de lista de apps de comunicação sempre atualizada.
   - (B) Lista de bloqueio (excluir Discord/Teams/Zoom/WhatsApp automaticamente) — mais rápido, mas não cobre apps novos.
   - (C) Não corrigir Tela inteira; documentar e orientar uso do modo Janela.

**Nota sobre ferramenta bloqueada**: a tentativa de usar `AskUserQuestion` (via `ToolSearch` + chamada) falhou com erro de permissão ("Claude Code is running in don't ask mode"). A rodada de perguntas foi reenviada em formato Markdown na mesma mensagem. Se a próxima sessão tiver a ferramenta disponível, pode usá-la normalmente.

## Próximo passo imediato

1. Aguardar resposta do usuário às 3 perguntas acima.
2. Se confirmado que a call interna vaza (ou decidido testar antes de assumir): construir o ciclo de teste com Ana/Bruno + apito fixo + transmissão Tela inteira + medição no espectador, reaproveitando o padrão de `e2e/_boost.tmp.mjs`.
3. Implementar a estratégia de correção escolhida em `app/src-tauri/src/sysaudio.rs` (provavelmente estendendo o `enum Source` para suportar lista de permissão/bloqueio de PIDs).
4. Seguir a skill `diagnosticar-bugs-mp` a partir da Fase 1 (ciclo de feedback) — ainda não há ciclo apertado construído para este bug especificamente.

## Skills sugeridas para a próxima sessão

- `sabatina-mp` — para fechar a rodada de perguntas pendente (3 perguntas acima) e abrir novas rodadas se as respostas destravarem decisões dependentes.
- `diagnosticar-bugs-mp` — para construir o ciclo de feedback (Fase 1) assim que a call interna precisar ser confirmada/instrumentada, e seguir até a correção com teste de regressão.
- `perguntas-simples` — se o usuário pedir para consolidar decisões em aberto antes de prosseguir.

## Trabalho não relacionado nesta sessão

- Instalação/atualização de 53 skills pessoais (`-mp`, `-projeto`, `perguntas-simples`) em `C:\Users\yagor\.openclaude\skills`, concluída com sucesso (0 erros). Não é parte do trabalho de áudio do stream-p2p; mencionado aqui só para registro, sem necessidade de ação futura.
