# ENTREGA — som do PC pelo app, com um seletor só

Pedido: "Com áudio não transmite, ele bloqueia. Não quero 2 seleções." Data: 2026-10-23.

## Causa (medida)
- `getDisplayMedia` com `systemAudio: 'include'` falha com `NotReadableError: Could not start audio source`.
  - Acontece com janela e com tela inteira.
  - Acontece no WebView2 do app e também no Chrome comum.
  - A falha derruba a captura inteira, imagem inclusive.
- Pelo Windows direto, o loopback WASAPI do mesmo dispositivo abre sem erro (`hr=0`).
  - A saída padrão é um Logitech G733 em 7.1 (8 canais, 48 kHz, float).
  - A suspeita é a combinação do Chromium com uma saída de 8 canais. Não foi confirmado trocando para estéreo, porque isso mexe na configuração do PC.
- A correção anterior (pedir a captura de novo, sem áudio) abria um segundo seletor. Foi descartada a pedido.

## O que mudou
| Arquivo | O quê |
|---|---|
| `app/src-tauri/src/sysaudio.rs` | Loopback WASAPI convertido pelo Windows para estéreo 48 kHz f32. Exclui a árvore de processos do app (sem eco da voz) e, se esse modo falhar, usa o dispositivo inteiro. |
| `app/src-tauri/src/main.rs`, `build.rs`, `capabilities/default.json` | Comandos `system_audio_start` (canal de bytes) e `system_audio_stop`, com permissão também para o servidor configurado. |
| `web/sysaudio.js` | AudioWorklet com fila curta (30 ms para começar, 200 ms no máximo) que gera uma faixa de áudio. O `stop()` da faixa encerra a captura no app. |
| `web/app.js` | No app, pede ao seletor só a imagem e junta a faixa nativa. App antigo ou navegador seguem pelo Chromium. No navegador, o erro de áudio explica a causa e a saída. |
| `server/index.js`, `web/sw.js` | Serve `/sysaudio.js`. O service worker foi para a v7. |
| `README.md` | Seção do app. |

## Verificação
Tudo pelo terminal: o seletor foi acionado por UI Automation, sem mouse.
- `npm test`: 43/43.
- Áudio nativo sozinho: abre em 98 ms e o nível acompanha o som que toca.
- Seletor com a janela do YouTube: um seletor só, sem o botão de áudio, com faixas `video:window…:live` e `audio:…:live`.
- Ponta a ponta: o app transmitiu a tela, um Chrome headless entrou como espectador e recebeu 1920×1080 com áudio WebRTC chegando (nível de até 0,054). Nenhum erro na tela.

## Não testado
- A exclusão do som do próprio app com voz real no chat.
- Windows anterior ao 10 2004: o loopback por processo não existe lá. O código cai no dispositivo inteiro, mas isso não foi exercitado.

## Instalação no PC de teste
- O instalador `/S` da mesma versão (0.1.0) sai com código 0, mas não troca o executável.
- O `stream-p2p.exe` novo foi copiado por cima do instalado e confirmado pelo hash. O áudio nativo funcionou nele.
- Para distribuir, a versão precisa subir (0.1.1) para o instalador e o atualizador trocarem o app.
