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

## Som só da janela compartilhada (2026-10-23)
Pedido: "A pessoa que está vendo a transmissão sempre se escuta."
- **Causa.** O som do PC excluía só o próprio app. A voz que chega pelo Discord (ou por outro programa) entrava na transmissão e voltava para quem falou. Vocês usam os dois chats.
- **Mudança.**
  - Ao compartilhar uma janela, a página lê o HWND do rótulo da faixa (`window:<hwnd>:0`) e reinicia a captura nativa só com a árvore de processos daquele programa (`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`).
  - Tela inteira continua com o PC inteiro menos o app.
  - Se o modo da janela falhar, volta ao PC inteiro e avisa na tela.
- **Verificação.**
  - O rótulo `window:5440786:0` é a janela do Discord (o mesmo HWND do Windows), e o app abriu o modo da janela sem aviso.
  - Medição direta no Windows: o modo "só Chrome" capturou o Meet (pico 0,03) e o modo "só Discord" ficou em 0, com o Discord em silêncio. O PC inteiro menos o app tinha som (0,04).
- **Não testado.** Um amigo falando pelo Discord enquanto o jogo é transmitido.

## Um seletor só (2026-10-23)

**Pedido:** "AINDA TEM 2 TELAS DE SELEÇÃO PRA TRANSMISSÃO. UNIFICA NA MAIS BONITA". Escolha: só o nosso (tema do app).

**Como ficou:**
- A grade do app (T02) é o único seletor. Ao clicar em Transmitir, o app chama `pick_source` com a fonte e só depois o `getDisplayMedia`.
- **Por que o seletor do Chromium não some de vez:** no WebView2 não há como capturar uma fonte direto. O `getUserMedia` com `chromeMediaSourceId` trava. Então o `getDisplayMedia` sempre abre o seletor do Chromium.
- **Onde ele fica:** esse seletor não tem janela própria; é desenhado dentro da janela do app (uma `RootView` filha do `Chrome_WidgetWin_1` do WebView2). Por isso não dá para deixá-lo transparente.
- **`app/src-tauri/src/picker.rs`:**
  - tira uma foto do app antes do `getDisplayMedia`;
  - mostra essa foto numa janela por cima de tudo (topmost, em camadas, que não recebe clique nem foco);
  - pela UI Automation, escolhe a aba (Janela é a primeira, Tela inteira a última), a fonte (janela pelo título, monitor pela posição) e o botão que acende ao escolher (Compartilhar);
  - espera o seletor sumir, mais 100 ms, e tira a foto.
- **Se algo falhar:** a foto sai na hora, e o seletor do Chromium fica à vista para a escolha na mão.
- **Trocar fonte:** ao vivo, abre o nosso diálogo em modo troca (só a seção de fonte; o botão vira "Trocar fonte").

**Verificado (app release, servidor local, espectador headless):**

| Caso | Resultado |
|---|---|
| Janela do Discord | Vídeo em 1,4 s, faixa `window:5440786` (é o Discord), som só do Discord |
| Tela, monitor principal | Vídeo em 1,5 s, `screen:0` |
| Trocar fonte para o 2º monitor ao vivo | 0,7 s, `screen:1`: a ordem dos monitores do app bate com a do Chromium |
| Cobertura, por quadros gravados com `CAPTUREBLT` | Sobe em ~20–30 ms, antes do seletor, e fica ~0,6–0,8 s |

- A primeira versão tirava a foto logo após o Compartilhar, e o seletor ainda aparecia por ~60 ms (2 quadros). Agora a foto só sai depois que o seletor fecha.

**Pendências:**
- **Teste visual final com o app em primeiro plano.** Nos testes o app estava atrás de outras janelas, e o último gravado teve um vídeo por cima.
- **"Som do PC inteiro" em 2 de 6 transmissões de janela,** ambas sob carga do gravador de quadros; não reproduziu depois. A transmissão segue com o som do PC e avisa. O console agora registra o motivo (`[sp2p] som só da janela`).
