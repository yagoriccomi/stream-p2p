# ENTREGA-instalador-cli-e-rede

Modo: 🔁 Loop. Plano: `PLANO-instalador-cli-e-rede.md`. Data: 2026-10-20.

## O que mudou
| Commit | Arquivos | O quê |
|---|---|---|
| `feat(app)` | `app/src-tauri/src/{cli,main}.rs`, `build.rs`, `Cargo.toml`, `capabilities/`, `permissions/`, `tauri.conf.json`, `web/app.js`, `web/ui.js`, `web/sw.js` | Linha de comando do app e instância única. O servidor vem de `--server` ou do `server.txt`. O web app grava o estado em `status.json`. |
| `feat(instalador)` | `hooks.nsh`, `tauri.conf.json` | `setup.exe /S /SERVER=<url>` grava o servidor durante a instalação. |
| `test(rede)` ×2 | `e2e/netsim.js`, `package.json` | `npm run netsim`: TURN local + proxy UDP e TCP que degradam a rede, e a medição de cada cenário. |
| `docs` | `README.md`, este arquivo | Instalação e CLI, netsim e limitações medidas. |

## Achados (medidos, não supostos)
1. **A página remota nunca pôde chamar os comandos do app.** No Tauri 2, comando de app chamado por URL remota precisa de permissão de ACL. Antes, `list_sources` e `set_tray_live` respondiam "not allowed by ACL", então o seletor nativo (T12) e o ícone ao vivo da bandeja (T13) nunca funcionaram de verdade. Agora o `build.rs` declara os comandos e a capability concede `allow-*` [#55].
2. **O build antigo do app nunca compilou.** Faltava `serde_json`, que o `generate_context!` exige.
3. **`${GetOptions}` do NSIS corta a URL na primeira `/`.** O `/SERVER=http://…` virava `http:`. Troquei por `${WordFind}`.
4. **`node-turn` não serve para teste.** O Chrome rejeita as respostas de ChannelBind dele (repete o pedido a cada ~7 s), e toda conexão via TURN cai ~30 s depois, mesmo sem falha simulada. Troquei pelo servidor de referência do Pion, que ficou estável.

## Instalador e CLI (testado nesta máquina)
| Passo | Resultado |
|---|---|
| `setup.exe /S /SERVER=http://localhost:3000 /D=%TEMP%\sp2p-install-test` | exit 0 em ~1 s; `server.txt` = `http://localhost:3000` |
| `stream-p2p.exe --version` / `--bogus` / `--mute` (app fechado) | `0.1.0` / exit 2 com a ajuda / exit 3 "não está aberto" |
| `--create --name Claude` | sessão criada em 0,9 s; `--status` mostra tela, código, papel `owner`, membros |
| `--copy-invite` | área de transferência = `http://localhost:3000/?code=…` |
| `--leave` → `--join <código> --name Claude` | tela `home` → `join`; com sessão encerrada, `lastError` = 404 "Não existe sessão com esse código" |
| `--create` com o app já aberto | a mesma instância navega e cria outra sessão (1 processo) |
| `--quit` | processo fecha; `--status` = `running: false` |
| `uninstall.exe /S` | pasta, atalho do Menu Iniciar e registro removidos |

O instalador tem 3,4 MB e aceita as flags do template do Tauri (`/S`, `/D=`, `/P`, `/NS`, `/UPDATE`) mais `/SERVER=`.

## Rede (npm run netsim, 720p30, 10 s por cenário)
Ana transmite para Bruno, e toda a mídia passa por um TURN local. A falha é aplicada no trecho TURN→navegador: um pacote de mídia é degradado uma vez, e um RTT atravessa o trecho duas vezes. Os números são da 2ª rodada; a 1ª deu valores equivalentes.

| Cenário | fps | perda RTP | NACKs | congelamentos | buffer | RTT | latência |
|---|---|---|---|---|---|---|---|
| base (só TURN) | 30 | 0% | 0 | 0 | 131 ms | 1 ms | 165 ms |
| perda 1% | 30 | 0,7% | 15 | 0 | 131 ms | 1 ms | 171 ms |
| perda 5% | 30 | 4,1% | 79 | 0 | 131 ms | 1 ms | 171 ms |
| perda 10% | 30 | 7,7% | 153 | 0 | 131 ms | 1 ms | 170 ms |
| atraso 50 ms | 30 | 0% | 0 | 0 | 91 ms | 100 ms | 189 ms |
| atraso 50 ± 20 ms | 30 | 0% | 404 | 0 | 110 ms | 103 ms | 191 ms |
| 150 ± 50 ms + perda 2% | 30 | 0,8% | 311 | 1 (0,3 s) | 56 ms | 303 ms | 207 ms |
| recuperado | 30 | 0% | 0 | 0 | 118 ms | 1 ms | 165 ms |

Leitura:
- Até 10% de perda, a retransmissão (NACK) segura 30 fps sem congelar. A perda que sobra depois das retransmissões fica em 0,7–7,7%.
- Com atraso, o servidor desconta o RTT medido do buffer para manter a sincronia: a latência sobe só ~25 ms quando o RTT sobe 100 ms.
- Com variação alta, esse desconto deixa o buffer em 56–85 ms e aparecem congelamentos de 0,3–0,7 s (na 1ª rodada foram 2, somando 0,7 s).
- A variação de ±20 ms reordena pacotes, e o receptor pede NACK para os que chegam fora de ordem. Isso explica os 400 NACKs com 0% de perda.

| Falha | Resultado |
|---|---|
| mídia cortada 3 s | volta em 0,6–0,7 s |
| mídia cortada 10 s | volta em 0,2 s (o ICE fica `disconnected` e retoma) |
| mídia cortada 40 s | **não volta**: voz e vídeo vão a `failed`, e o app não refaz a conexão. *Corrigido depois: ver `ENTREGA-recuperar-conexao.md`* |
| WebSocket do Bruno caiu 2 s | volta à sessão em 1,1 s e o vídeo em 3,5 s (a queda derruba o vídeo dele, e o servidor o pendura de novo) |
| servidor fora 15 s (para o Bruno) | volta 0,1 s depois do servidor; o vídeo, em 3,0 s. A espera depende do backoff (1, 2, 4, 8, até 10 s) |
| `/speedtest` com 503 | T02 mostra "503 · O servidor recusou o teste de upload.", sem travar |

## Verificação
- `npm test`: 37/37. `cargo test`: 7/7 (parse da CLI e URL de início).
- `npm run e2e`: `E2E OK` depois das mudanças no web app.
- `npm run netsim`: `NETSIM OK` em 2 rodadas completas e 1 rodada só de `base,cut40`.

## Premissas
P1–P5 do plano. A P5 mudou: o TURN do teste é o Pion, e não o `node-turn`, pelo achado 4.

## Não feito (e por quê)
- **Updater assinado:** a chave privada é do dono do projeto, então `createUpdaterArtifacts` fica desligado. O README diz como ligar.
- **Recuperar o vídeo depois de `failed`** e o **piso de buffer sob jitter:** são mudanças de comportamento do streaming, fora do escopo de "simula e mede". Viraram as pendências 2 e 3 do handoff.
- **Bot do Discord:** depois, como pedido.
- O `--mute` numa sessão aberta pela CLI pede o microfone ao WebView2. Isso não foi testado aqui, porque o pedido abre um diálogo do sistema.

## Próximos passos
1. `restartIce()` quando a conexão ficar `failed`, ou um novo pedido de upstream ao servidor; o `npm run netsim` com `NETSIM_ONLY=cut40` serve de teste.
2. Piso de buffer proporcional ao jitter medido; validar com `NETSIM_ONLY=bad`.
3. Publicar o servidor com HTTPS e instalar com `/SERVER=https://…`.
