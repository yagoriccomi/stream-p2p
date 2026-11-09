# 10 — Inventário de paridade Tauri + web → nativo Rust (2026-11-08)

Fonte: leitura da `main` (d198e01). Hoje a janela Tauri só carrega a página do servidor (`app/src-tauri/src/main.rs:351`); quase toda a lógica de produto está em `web/*.js`.

Legenda: **a** = Rust reaproveitável · **b** = JS/web, reescrever em Rust · **c** = servidor, não muda

| Funcionalidade | Onde | Tipo |
|---|---|---|
| Listar telas/janelas com miniatura (xcap) | `main.rs:53-84` | a |
| Picker escondido do Chromium | `picker.rs`, `main.rs:89-105`, `app.js:796` | some (captura direta WGC) |
| Captura de vídeo (`getDisplayMedia`, constraints, `contentHint`) | `app.js:805-845`, `stream.js:49,136-142` | b |
| Trocar fonte ao vivo (`replaceTrack`) | `app.js:859`, `stream.js:140-155` | b |
| Áudio do sistema WASAPI loopback | `sysaudio.rs:179`, `main.rs:117-127` | a (desacoplar de `tauri::ipc::Channel`, `sysaudio.rs:14`) |
| Ponte áudio→track (AudioWorklet, fila 30–200 ms) | `web/sysaudio.js:1-93` | b (vira buffer) |
| Áudio só da janela (HWND) | `sysaudio.rs:179`, `app.js:783` | a + b |
| Exclusão de apps do áudio | `sysaudio.rs:56-61`, `main.rs:152-159`, `app.js:622-635,763-767` | a + b |
| Listar sessões de áudio | `sysaudio.rs:147`, `main.rs:129-150`, `app.js:596-620` | a + b |
| Transmitir aos filhos (offer, codec, bitrate inicial, munge SDP) | `stream.js:18-47,83-230` | b |
| Assistir (`acceptFrom`, jitter) | `stream.js:231-262` | b |
| Repassar na árvore (recodifica) | `stream.js:263-283`, `app.js:135-140` | b |
| Montagem da árvore e cota | `server/topology.js` | c |
| Prioridade qualidade/balanceado/fps | `stream.js:11-16,181-198`, `app.js:38`, `index.html:330` | b |
| Codec preferido, atraso automático | `stream.js:199`, `app.js:1048-1096`, `server/index.js:417-433` | b + c |
| Recuperar conexão (10 s, `recover` 5 s) | `stream.js:73-127` | b |
| WS com reconexão (backoff 10 s) + voltar à sessão | `app.js:62-81` | b |
| Remoção de conexão fantasma | `server/index.js:278-290` | c |
| Heartbeat WS (ping/isAlive) | `server/index.js:468-474` | c |
| Heartbeat de status do app (2 s / 10 s) | `app.js:1166,1312-1331`, `main.rs:29,187-214` | a + b |
| Métricas (kbps, fps, RTT, rota, `srcStats`/`hopRtt`) | `stream.js:295-351`, `app.js:1113-1180` | b |
| Speedtest de upload | `app.js:693-760`, `server/index.js:61-80,122` | b + c |
| Voz (mesh, supressão ruído/eco, PTT tecla V) | `web/voice.js`, `app.js:937-949` | b |
| Mixer, volume por pessoa, boost, `setSinkId` | `web/boost.js`, `app.js:897-1000` | b |
| Chat, renomear, sair, encerrar | `app.js:409-418,526-575,1013`; `server/index.js:332-345,414` | b + c |
| Pedir/passar a vez, pausar | `app.js:157-164,385-405,865-868`; `server/index.js:347-391` | b + c |
| Moderação (silenciar, remover, banir, matriz `CAN`) | `app.js:338-354,1015-1040`; `server/session.js`, `server/index.js:392-410` | b + c |
| Criar/entrar por código | `app.js:436-510`, `cli.rs:91-95`; `server/session.js:17-95` | b + a + c |
| Copiar link de convite | `app.js:513-520` | b |
| Deep link `streamp2p://join/?code&name` | `cli.rs:117-125`, `hooks.nsh:24-28`, `app.js:463-475` | a + b |
| Link do Discord (token de dono) | `server/discord.js`, `server/index.js:322-326` | c |
| Identidade: `device` aleatório em `localStorage` + apelido (sem login) | `app.js:21`, ban em `session.js:63` | b (guardar em arquivo) |
| ICE/TURN (credencial REST, renova 1 h) | `app.js:44-60`, `server/ice.js` | b + c |
| Bandeja (ícone ao vivo, parar, silenciar mic, copiar convite) | `main.rs:167-177,357-386`, `app.js:1297-1310` | a (trocar `tauri::tray`) |
| Instância única + repassar argumentos | `main.rs:236-274,338` | a (trocar plugin por mutex) |
| Estado da janela | `main.rs:346` (plugin) | a (trocar plugin) |
| CLI (`--create/--join/--status/--stop-stream`…) com testes | `cli.rs:1-173` | a (`tauri::Url` → crate `url`) |
| Servidor configurável (`server.txt`, migração) | `main.rs:23-26,216-225` | a |
| Flags do WebView2 | `cli.rs:164-173` | some |
| Permissões IPC p/ origem remota | `main.rs:276-296`, `capabilities/default.json` | some |
| Instalador NSIS (por usuário, pt-BR, `/SERVER=`) | `tauri.conf.json` bundle, `hooks.nsh:1-33` | b (NSIS direto ou cargo-wix; reaproveita `hooks.nsh`) |
| Atualização assinada (minisign, `latest.json`) | `tauri.conf.json` updater, `app/release.mjs`, `app.js:1214-1283` | b (manter formato do `latest.json`) |
| SmartScreen | `web/download.html:41`, `README.md:46` | igual; só certificado resolve |
| PWA/service worker | `web/sw.js`, `app.js:1200-1245` | só navegador |
| `/download`, Worker que acorda o Render | `server/index.js:26`, `worker/index.js` | c |
| Bot do Discord | `server/discord*.js`, `worker/index.js` | c |

Docs: `docs/planos/ENTREGA-audio-do-sistema-no-app.md`, `ENTREGA-audio-permissao-apps.md`, `ENTREGA-telas-T01-T14.md:21`, `docs/TECNICO.md:135-213`.

## Peso da migração
- Maior bloco: WebRTC (`web/stream.js` + `web/voice.js`, ~590 linhas) e UI (`web/app.js`, 1352 linhas). str0m (ticket 02) cobre o WebRTC; voz em mesh e supressão de ruído/eco precisam de solução nativa.
- Protocolo WS (`server/index.js:307-446`) não muda; o cliente nativo fala as mesmas mensagens.
- Surpresas p/ escopo: **voz (mesh + PTT + supressão de ruído/eco)**, **mixer/boost**, **chat/moderação** fazem parte da paridade.
