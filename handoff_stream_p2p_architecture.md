# Handoff: Stream P2P

**Data:** 20/10/2026
**Estado:** MVP web funcionando de ponta a ponta. App Windows (Tauri 2) escrito e checado para Windows, mas ainda não compilado.
**Design:** canvas https://claude.ai/artifact/PyEQWUdc5AsX4rGRARdC8S (versão 23), com a identidade, as telas T01–T14 e os ícones.
**Documentos:** plano em `docs/planos/PLANO-telas-T01-T14.md`; entrega e verificação em `docs/planos/ENTREGA-telas-T01-T14.md`; como rodar em `README.md`.

---

## 1. Decisões de produto (fechadas)

- **Identidade:**
  - Nome "Stream P2P"; só tema escuro.
  - Cores: destaque violeta #7F00FF, ao vivo verde #2EE59D, erro vermelho #FF4D4D.
  - Fontes Archivo, Inter e JetBrains Mono.
  - Logo: símbolo de play em rede dentro de um monitor com moldura violeta.
- **Sem login:**
  - O apelido é obrigatório e único na sessão, sem diferenciar maiúsculas nem acentos. Repetido dá 409.
  - O apelido pode ser trocado dentro da sessão.
  - O link do bot do Discord já vem com o apelido que a pessoa usa no servidor.
- **Código da sessão:** no formato `xxxx-xx`, oculto por padrão, revelado no ícone de olho.
- **Transmissão:**
  - Qualquer pessoa transmite, uma por vez. As outras pedem a vez.
  - Fonte, qualidade, áudio e pausa mudam ao vivo.
  - As fontes se dividem nas categorias Monitor e Janela.
- **Latência:** a voz é em tempo real. O vídeo tem ~150 ms de atraso uniforme para todos, com o áudio da transmissão sincronizado ao vídeo.
- **Áudio:** o áudio da transmissão e a voz têm volumes separados. Há volume por pessoa, escolha de dispositivos e aperte-para-falar (V).
- **Papéis:**

  | Papel | O que pode |
  |---|---|
  | Dono | Tudo |
  | Moderador | Gerir a sessão: trancar, expulsar, silenciar para todos, parar ou passar a vez. Não bane, não nomeia moderadores, não passa a coroa e não encerra a sessão |
  | Quem transmite | Passar a vez (opção ligada por padrão) |

- **Erros:** sempre com código HTTP e justificativa.

  | Código | Quando |
  |---|---|
  | 400 | Dado inválido |
  | 403 | Sem permissão ou banido |
  | 404 | Sessão não existe |
  | 409 | Apelido em uso ou conflito de vez |
  | 410 | Sessão encerrada |
  | 423 | Sessão trancada |
  | 429 | Mais de 20 mensagens por segundo |
  | 503 | Sessão cheia (50 pessoas) ou sem vaga na árvore |

- **Plataformas:**
  - PWA com "Adicionar à Tela de Início". No celular dá para assistir e falar.
  - App Windows com instalador por usuário e atalho no Menu Iniciar.

## 2. Arquitetura (implementada)

- **Sinalização:** feita em `server/index.js` com Node 22, HTTP com lista branca de arquivos e WebSocket (`ws`). O estado fica em memória.
- **Sessão:** a lógica é pura e testada em `server/session.js`. A sessão existe independente de haver transmissão.
- **Permissões:** a matriz `CAN` também é servida ao cliente como `/session.js`. Assim a interface só mostra as ações que o servidor vai aceitar.
- **Vídeo em árvore** (`server/topology.js` + `web/stream.js`):
  - A cota de envio direto é `floor(upload × 0.8 / bitrate do modo)`.
  - Quem excede a cota recebe via relay (no máximo 2 filhos por nó). Quando um relay sai, os filhos dele são re-pendurados.
  - O buffer de cada um é 150 ms − 30 ms × profundidade.
  - Modos: 720p30 a 4 Mbps, 1080p60 a 8 Mbps, 1440p60 a 15 Mbps. O bitrate é destravado com `b=AS:` e `maxBitrate`.
  - Mudanças ao vivo nunca renegociam:
    - troca de fonte: `replaceTrack`;
    - qualidade: `applyConstraints` + `setParameters`;
    - pausa e áudio: `track.enabled`.
    - A linha de áudio já fica reservada desde a primeira oferta.
- **Voz** (`web/voice.js`):
  - Malha só de áudio; o id menor faz a oferta.
  - Ligar o mic ou trocar de dispositivo é um `replaceTrack`.
  - O ganho do mic passa por WebAudio.
  - O volume por pessoa usa elementos de áudio, e a saída é escolhida com `setSinkId`.
- **Discord** (`server/discord.js`):
  - Usa Interactions por HTTP, com verificação Ed25519.
  - O comando `/stream criar` posta um botão **Entrar**, que devolve um link pessoal `?code=&name=<apelido no servidor>`.
  - Variáveis de ambiente: `DISCORD_PUBLIC_KEY` e `PUBLIC_URL`.
- **App** (`app/src-tauri`, Tauri 2):
  - A janela carrega o próprio site.
  - Comandos `list_sources` (monitores e janelas com miniatura, via xcap) e `set_tray_live`.
  - Bandeja com Parar transmissão, Silenciar mic e Copiar convite.
  - Instalador NSIS por usuário, em PT-BR, com `tauri-plugin-updater`.

## 3. Verificação

- `npm test`: 27 de 27 passando.
- `npm run e2e` (Chromium headless, 4 pessoas) termina com `E2E OK`. Cobre:
  - criar a sessão e entrar pelo convite;
  - o 409 com "bRúno";
  - chat e voz em malha;
  - 1440p60 com buffers de 120, 90 e 90 ms;
  - troca de fonte ao vivo;
  - 403 do moderador ao tentar banir;
  - passar a vez;
  - re-parent quando o nó direto sai.
- App: `cargo check --target x86_64-pc-windows-msvc` passa. A exceção é o plugin de atualização, cuja dependência `ring` exige o `lib.exe` do MSVC.

## 4. Pendências e próximos passos

1. **No Windows:** gerar o instalador e testar a bandeja e o updater.
   1. Troque `stream-p2p.example.com` pela URL real em `tauri.conf.json` e em `capabilities/default.json`.
   2. Gere as chaves com `npx tauri signer generate` e cole a chave pública em `pubkey`.
   3. Rode `cd app && npm i && npm run build`.
2. **Captura nativa da fonte escolhida em T12.** Hoje ainda abre o seletor do sistema. Caminhos: `chromeMediaSourceId` no WebView2, ou captura própria com Windows.Graphics.Capture.
3. **Codificação pela GPU (NVENC, AMF ou QuickSync).** O plano original era captura zero-copy na VRAM; hoje o app usa o WebRTC do WebView2.
4. **Medir o upload e o RTT por salto com `getStats`,** em vez de pedir o upload à pessoa.
5. **TURN padrão para fora da LAN.** Hoje só existe se for configurado em Configurações (T11).
6. **Bot do Discord:** criar o app no Discord, registrar `/stream criar` e apontar o endpoint para `PUBLIC_URL/discord/interactions`.
7. **Publicar o servidor com HTTPS,** que a captura e o PWA exigem.
