# ENTREGA-telas-T01-T14

Modo: 🔁 Loop. Plano: `PLANO-telas-T01-T14.md`. Data: 2026-10-20.

## O que foi entregue
| Tela | Onde | Estado |
|---|---|---|
| T01 Início | `web/index.html` (home), `web/app.js` | Pronto |
| T02 Fonte e qualidade | `#dlg-setup`; `web/stream.js` (`MODES`, `captureConstraints`) | Pronto. Mostra a cota de envio direto ao vivo |
| T03 Sessão | palco, pessoas, chat, rodapé | Pronto. Layout desktop e mobile |
| T04 Controles de quem transmite | `#pbar`; `VideoNet.replaceSource/setMode/setPaused/setAudio` | Pronto. Tudo muda ao vivo, sem renegociar |
| T05 Erros HTTP | `web/ui.js` (`showError`, `fieldError`); `HttpError` no servidor | Pronto. 400/403/404/409/410/423/429/503, sempre com o porquê |
| T06 Convite do bot | `server/discord.js`, `POST /discord/interactions` | Pronto. Exige criar o app no Discord (ver README) |
| T07 Mobile instalável | `manifest.webmanifest`, `sw.js`, ícones, banner de instalação | Pronto. Inclui a dica do iOS |
| T08 Instalador do Windows | `app/src-tauri/tauri.conf.json` (NSIS por usuário, Menu Iniciar, PT-BR); `web/download.html` | Configurado. Não gerado (ver limitações) |
| T09 Entrar | tela join; `?code=&name=` | Pronto. Apelido único (409) e escolha entre mic e só ouvir |
| T10 Áudio, papéis e moderação | `#dlg-audio`; `server/session.js` (`CAN`); `web/voice.js` | Pronto. A matriz de permissões é a mesma no servidor e no cliente |
| T11 Configurações | `#dlg-settings` | Pronto. Codec, upload, TURN e apoio |
| T12 Seletor nativo | `list_sources` (xcap) em `main.rs`; grade em `renderSetup` | Lista monitores e janelas. A captura ainda usa `getDisplayMedia` |
| T13 Bandeja | `TrayIconBuilder` + `set_tray_live`; evento `tray` em `app.js` | Pronto no código. Não executado |
| T14 Atualização | `sw.js` + banner (web); `tauri-plugin-updater` (app) | Web pronto. App configurado, falta a chave de assinatura |

## Verificação
- `npm test`: todos os testes de sessão, permissões, fila, árvore e Discord passam.
- `npm run e2e` (Chromium headless) termina com `E2E OK`. Cobre:
  - criar a sessão e conferir o código oculto;
  - 3 pessoas entrando pelo convite;
  - 409 com "bRúno";
  - chat;
  - malha de voz com 3 pares;
  - 1440p60 com buffers 120/90/90;
  - troca de fonte mantendo as conexões;
  - moderador sem "Bloquear" e com 403 ao tentar banir;
  - pedir a vez, aprovar e Dani transmitir;
  - re-parent quando o nó direto sai.
- App: `cargo check --target x86_64-pc-windows-msvc` passa com tudo menos o plugin de atualização. O `ring`, dependência do updater, precisa do `lib.exe` do MSVC, que não existe neste container. A listagem de fontes com xcap 0.9 foi checada separadamente e também passa.

## Correções feitas no caminho
- O e2e usa viewport 1280×800. Com 800×600 a tela caía no layout mobile e o painel Pessoas ficava oculto.
- Corrigida uma corrida na voz e no vídeo: um snapshot novo fechava o `RTCPeerConnection` enquanto `createOffer` ainda aguardava. Agora, depois de cada `await`, o código confere se a conexão ainda é a atual.
- Um relay re-pendurado não manda mais duas ofertas para o mesmo filho.

## Limitações honestas
- O instalador `.exe` não foi gerado, porque não há Windows nem MSVC aqui. Gere no Windows seguindo o README.
- Não há encoder NVENC/AMF nativo: o app usa o WebRTC do WebView2.
- A fonte escolhida em T12 ainda passa pelo seletor do sistema.
- O TURN só existe se for configurado em T11.
- O upload é declarado pela pessoa, não medido.
- Não consigo ver o saldo de créditos da sessão na nuvem, então a regra de parar com US$ 2 não pôde ser monitorada.

## Próximos passos
1. No Windows: `cd app && npm i && npm run build`; depois testar a bandeja e o updater com uma release assinada.
2. Fazer a captura nativa da fonte escolhida em T12 (via `chromeMediaSourceId` no WebView2, ou um encoder próprio).
3. Medir o upload com `getStats` em vez de pedir à pessoa.
