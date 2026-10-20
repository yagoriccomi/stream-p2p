# PLANO-telas-T01-T14

Modo: 🔁 Loop. Fonte do design: canvas "Stream P2P — Identidade, telas e ícones". Data: 2026-10-20.

Objetivo: tirar a bancada MVP (`web/index.html` com dois fieldsets) e entregar as 14 telas do canvas funcionando, sem login, só tema escuro, violeta #7F00FF como destaque.

## Base comum (pré-requisito de T01, T03, T04, T09, T10)

A bancada atual mistura "sala" com "transmissão": quem cria a sala é o host e a sala morre com ele. O design pede outra coisa: a **sessão** existe por si e qualquer pessoa transmite, uma de cada vez. Mudanças:

1. `server/session.js` (lógica pura, testada):
   - Sessão = `{ code, ownerId, members, presenterId, room, locked, autoApprove, presenterCanPass, banned, queue, endedAt }`.
   - Membro = `{ id, name, role: 'owner'|'mod'|'member', device }`.
   - Código no formato `xxxx-xx` (base36, sem 0/o/1/l).
   - Apelido: 1 a 24 caracteres, comparação sem caixa e sem acento. Repetido → 409.
   - Permissões numa tabela única `CAN[ação] = (sessão, ator, alvo) => bool`, igual à matriz "Quem pode o quê" do T10.
   - Erros sempre `{ code, reason }`: 400 dado inválido, 403 sem permissão ou bloqueado, 404 sessão não existe, 409 apelido em uso, 410 sessão encerrada, 423 sessão trancada, 429 rápido demais, 503 sessão cheia.
2. `server/topology.js` continua igual. A árvore passa a ter como raiz quem transmite, e é recriada a cada troca de vez.
3. Protocolo WebSocket novo (cliente → servidor):
   - Sessão: `create`, `join`, `rename`, `chat`.
   - Transmissão: `startStream`, `stopStream`, `streamState` (pausa, áudio, modo).
   - Vez: `requestTurn`, `passTurn`.
   - Moderação: `mod` (ações do T10), `settings` (trancar, auto-aprovar, quem transmite passa a vez), `end`.
   - Sinalização: `signal` (vídeo), `vsignal` (voz).
4. Voz: malha só de áudio entre todos os membros, sem buffer (tempo real). O vídeo continua com `jitterBufferTarget` uniforme de ~150 ms, aplicado também à faixa de áudio da transmissão (sincronia A/V).
5. Cliente: SPA em `web/` com telas trocadas por `data-screen` e módulos separados:
   - `ui.js`: telas, ícones, erros.
   - `stream.js`: WebRTC de vídeo, mantendo a lógica atual.
   - `voice.js`: malha de voz e mixer.
   - `app.js`: orquestra.
6. Teste rápido: rate limit de 20 mensagens/s por cliente → 429.

## T01 · Início
- Logo v3 (monitor com moldura violeta) e título.
- "Criar sessão": pede só o apelido e vai para a sessão como dono.
- "Entrar": campo de código tipo senha com olho (`aria-pressed`) e apelido. Envia `join`.
- `?code=` na URL preenche o código e já abre a tela Entrar (T09).
- Link "Baixar app" para a página de download do instalador (T08).
- Aceite: criar mostra a sessão com a coroa; código errado dá 404 com justificativa.

## T02 · Escolher fonte e qualidade
- Abas Monitor / Janela. No navegador, viram `displaySurface: 'monitor' | 'window'` e `selfBrowserSurface: 'exclude'`. Quem lista as fontes é o seletor do navegador.
- No app (T12), a grade lista monitores e janelas reais.
- Qualidade: 720p30, 1080p60, 1440p60, com a cota direta calculada ao vivo (`floor(upload×0,8/bitrate)`) e um aviso quando a cota der 1.
- Switch "Áudio da transmissão" (`role=switch`).
- "Começar a transmitir" → `getDisplayMedia` → `startStream`.
- Cancelar o seletor do navegador não é erro. Volta à tela sem a faixa vermelha.
- Aceite: os 3 modos, o áudio ligado/desligado e o cancelamento silencioso.

## T03 · Sessão
- Cabeçalho:
  - Logo e código oculto (••••, com olho e copiar convite).
  - Selo AO VIVO verde e "150 ms · igual para todos".
- Palco de vídeo:
  - Estado "Ninguém transmitindo" com o botão "Transmitir" (ou "Pedir a vez", se alguém já transmite).
- Lateral:
  - Pessoas: nome, papel (coroa, escudo, transmitindo), mic e o botão "Meu apelido" (renomear com 409).
  - Chat: até 500 caracteres, enviado com Enter.
- Rodapé:
  - Mic, Áudio (abre T10), Tela cheia, Configurações (T11) e Sair.
- Aceite: 2 abas trocam mensagens e veem a lista. Renomear para um nome já usado dá 409.

## T04 · Controles de quem transmite
- A barra só aparece para quem transmite, com:
  - Trocar fonte: `getDisplayMedia` novo + `replaceTrack` em todos os filhos, sem renegociar.
  - Qualidade ao vivo: `applyConstraints` + `setParameters`.
  - Pausar/Retomar: `track.enabled` + `streamState` para o selo âmbar.
  - Switch de áudio ao vivo: `track.enabled`. A faixa de áudio é reservada com `addTransceiver('audio')` mesmo se a captura vier sem áudio.
  - Passar a vez, Parar.
- Faixa "Fulano pediu a vez" com "Passar a vez" / "Agora não".
- Aceite (e2e): trocar fonte mantém o vídeo nos viewers sem nova oferta, e passar a vez muda quem transmite.

## T05 · Erros (HTTP) e estados
- O componente `showError(code, reason, action)` gera um cartão com o código, o título, "Por quê:" e a ação.
- Estados neutros: Conectando, Reconectando (o WS cai e tenta de novo com backoff), Ninguém transmitindo.
- Permissões:
  - Mic negado → 403 com o passo a passo, e a pessoa segue só ouvindo.
  - Captura negada → 403 sem travar.
- Aceite: cada código do servidor tem texto em PT-BR, e nenhum erro bloqueia a sessão.

## T06 · Convite do bot
- `server/discord.js`: endpoint `POST /discord/interactions` (Interactions HTTP, sem gateway, sem dependência).
  - Verifica Ed25519 com `crypto.verify` e a chave pública em `DISCORD_PUBLIC_KEY`.
  - Responde ao PING.
  - `/stream criar` cria a sessão e devolve um embed com o botão "Entrar na sessão". O link leva `?code=…&name=<apelido no servidor>`.
- `?name=` preenche o apelido no T09, sem login.
- Aceite: teste unitário com uma chave gerada no teste (assinatura válida, inválida → 401) e o embed com o link.

## T07 · Mobile instalável (PWA)
- `manifest.webmanifest` (tema #0A0A0B, ícones SVG/PNG do logo v3), `sw.js` (cache do shell, network-first) e as rotas no servidor estático.
- Banner "Adicionar à Tela de Início": `beforeinstallprompt` no Android; dica "Compartilhar › Adicionar à Tela de Início" no iPhone.
- Layout em coluna abaixo de 720 px:
  - Abas Chat/Pessoas e botões de 48 px.
  - O botão Transmitir fica oculto quando não há `getDisplayMedia`.
- Aceite: o manifest passa no Chrome (installable) e a tela de 390 px não tem rolagem horizontal.

## T08 · Instalador do Windows
- `app/src-tauri` (Tauri 2), com o bundle NSIS:
  - Atalho na área de trabalho e no Menu Iniciar, `installMode: currentUser` e idioma PT-BR.
  - Página de opções com "Criar atalho no Menu Iniciar".
- A página `/download` (web) explica o SmartScreen e a assinatura de código.
- Limitação: só dá para gerar o `.exe` no Windows. Aqui fica o projeto configurado, e o `cargo check` só roda se houver webkit2gtk.

## T09 · Entrar
- Código com olho e apelido obrigatório, já preenchido por `?name=`.
- Erro 409 inline (`aria-invalid` + `aria-describedby`).
- "Com microfone" / "Só ouvindo".
- Painel de permissões: o mic só é pedido no clique Entrar; a captura só ao transmitir; o autoplay é liberado pelo clique.
- Aceite: um nome repetido mostra o 409 no campo e não sai da tela.

## T10 · Áudio, papéis e moderação
- Mixer:
  - Áudio da transmissão e voz da sessão em canais separados, cada um com mute.
  - Volume por pessoa (0–100%) e mute local.
  - Entrada e saída (`enumerateDevices`, `setSinkId`) e ganho do mic (WebAudio).
  - Supressão de ruído, cancelamento de eco e push-to-talk (tecla V).
- Menu do dono e dos moderadores por pessoa, filtrado pela matriz:
  - Silenciar para todos, Passar a vez, Tirar da transmissão.
  - Tornar moderador, Tornar dono, Remover, Bloquear.
- Regras: Trancar (423), Auto-aprovar pedidos, Quem transmite pode passar a vez, Encerrar para todos (410).
- Aceite: testes unitários da matriz completa. No e2e, um moderador não consegue bloquear (403).

## T11 · Configurações
- Dispositivos (os mesmos do T10).
- Encoder: preferência de codec, `setCodecPreferences` com H.264/VP9/AV1 conforme `RTCRtpSender.getCapabilities`.
- Rede: upload declarado e STUN/TURN customizado.
- Mostra o que o navegador suporta.
- Salvo em `localStorage` com try/catch.
- Aceite: trocar o codec aparece nas estatísticas (`codecId`).

## T12 · Seletor de fonte nativo (app)
- Comando Tauri `list_sources` (crate `xcap`: monitores e janelas com miniatura).
- A tela T02 usa a lista quando `window.__TAURI__` existe.
- Limitação: a captura nativa e o NVENC ficam para a etapa Rust. Aqui, o comando e a ponte de UI.

## T13 · Bandeja do sistema (app)
- `TrayIconBuilder` com o menu Parar transmissão, Silenciar mic e Copiar convite.
- O ícone fica verde quando ao vivo.
- Os eventos vão para o webview (`emit`), e o app.js responde.

## T14 · Atualização do app
- App: `tauri-plugin-updater` com o diálogo "Nova versão disponível / Reiniciar".
- Web/PWA: o `sw.js` detecta a nova versão e mostra a faixa "Nova versão disponível · Recarregar". É a mesma tela, no navegador.

## Verificação por item
- `npm test` (topologia + sessão + discord).
- `npm run e2e`:
  - Cria a sessão, 3 entram, transmissão com relay.
  - Chat, renomear com 409, trocar fonte, passar a vez.
  - Moderador recebe 403 ao bloquear.
- Revisão do diff antes de cada commit.
