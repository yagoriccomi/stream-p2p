# ENTREGA — instalador pronto para testar na rede local

Modo: 🔁 Loop. Pedido: "Instalador pronto pra testar? Senão, pode construir e testar até estar pronto." Data: 2026-10-22.

## O que não estava pronto (medido)
Com o servidor num PC da rede (`http://192.168.0.250:3000`), sem HTTPS:

1. **App: sem captura e sem microfone.**
   - A página não era contexto seguro, e o WebView2 escondia `navigator.mediaDevices`.
   - Ninguém conseguia transmitir nem falar pelo app.
   - O teste de 20/10 só usou `localhost`, que é seguro, por isso não pegou.
2. **Navegador: não entrava na sessão.**
   - `crypto.randomUUID` só existe em contexto seguro.
   - A página quebrava antes da tela de entrar.
3. **Instalador pelo Git Bash: `/SERVER=` não chegava.**
   - O MSYS converte argumentos que começam com `/`.
   - Pelo PowerShell funciona. Isso foi documentado no README.

## O que mudou
| Commit | Arquivos | O quê |
|---|---|---|
| `02b2ff1` fix(app) | `app/src-tauri/src/{cli,main}.rs` | O WebView2 abre com `--unsafely-treat-insecure-origin-as-secure=<servidor>` quando o servidor é `http://`, mantendo as flags padrão do Tauri. Função pura com teste. |
| `7d5cf64` fix(web) | `web/stream.js`, `web/app.js`, `web/stream.test.js`, `web/sw.js` | `randomId()`, que usa `crypto.getRandomValues` quando `randomUUID` não existe. Teste de unidade. O service worker foi para a v6. |
| docs | `README.md`, este arquivo | Rede local sem HTTPS e o detalhe do Git Bash. |

## Verificação
- `cargo test`: 8/8. `npm test`: 43/43.
- `npm run e2e`: E2E OK em 3 de 4 rodadas. A 1ª falhou numa asserção que não se repetiu.
- **Instalador:** `setup.exe /S /SERVER=http://192.168.0.250:3000 /D=…`, pelo PowerShell.
  - Sai com exit 0 e grava `server.txt` com o IP.
  - Dentro do app instalado, pela depuração remota do WebView2: `isSecureContext` true, `getDisplayMedia`, `getUserMedia` e `__TAURI__` presentes.
- **Transmissão pela rede local (headless, sem abrir janela):**
  - Ana usa a mesma flag do app e mede o upload (1000 Mbps na rede local).
  - Bruno, num Chrome comum em `http`, entra e recebe 1280×720, com 177 quadros em 6 s, sem erros de página.
- **Desinstalação silenciosa:** remove a pasta e o registro. O `server.txt` original foi restaurado.

## Não testado aqui
São coisas que precisam de uma pessoa na frente do PC:
- o seletor de tela de verdade do WebView2;
- o pedido de permissão do microfone no app;
- dois PCs físicos diferentes. O teste usou o IP da rede, mas na mesma máquina.

## Limitação
Trocar o servidor com `--server` com o app aberto não aplica a liberação (as flags do WebView2 valem desde a abertura). É preciso `--quit` e abrir de novo.
