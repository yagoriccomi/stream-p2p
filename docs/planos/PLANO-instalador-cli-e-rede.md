# PLANO DE EXECUÇÃO — instalador-cli-e-rede

| Campo | Valor |
|---|---|
| **Tarefa** | `instalador-cli-e-rede` |
| **Origem** | Pedido: "Pode fazer o instalador. Pode instalar as dependências. O instalador deve aceitar comandos por CLI para facilitar o controle pelo Claude. Simula erros de rede e mede." |
| **Tipo** | História |
| **Modo de execução** | 🔁 Loop (continuação, sem confirmação; o usuário autorizou instalar dependências) |
| **Data** | 2026-10-20 |
| **Branch** | `main` (commits atômicos, sem push) |

## 1. Enunciado Canônico
- **Problema:** o instalador do Windows nunca foi gerado. O app só abre uma URL fixa de exemplo e não pode ser controlado por linha de comando. E não se sabe como a transmissão se comporta com rede ruim.
- **Resultado esperado:** um `.exe` NSIS que instala e desinstala em silêncio já com o servidor configurado. O app recebe comandos (entrar, criar, parar, silenciar, sair) e expõe o próprio estado. Há um teste que degrada a rede de verdade (perda, atraso, variação, queda) e mede o efeito.
- **Como validar:** instalar com `/S`, abrir com `--server … --create --name Claude`, ler o estado pela CLI, mandar `--quit`, desinstalar com `/S`. Rodar `npm run netsim` e obter a tabela de medições.

## 2. Escopo
**Vou fazer:**
- Instalar o rustup (o MSVC 2019 e o Windows SDK já existem).
- CLI do app:
  - `--server`, `--create`, `--join <código>`, `--name`;
  - `--stop-stream`, `--mute`, `--copy-invite`, `--leave`, `--show`, `--quit`, repassados à instância que já está aberta;
  - `--status`, `--help` e `--version`, que imprimem no terminal.
- Instalador: `/S`, `/D=`, além de `/SERVER=<url>`, que grava o servidor no hook do NSIS.
- Teste de rede `npm run netsim`. A mídia é forçada por um TURN local, com um proxy UDP no meio que aplica perda, atraso e variação, mais quedas do WebSocket e do servidor.

**NÃO vou fazer** [#8]:
- Bot do Discord (pedido do usuário: depois).
- Captura nativa e NVENC (pendências 2 e 3).
- Assinar o updater: a chave privada de release é do dono do projeto. O build sai sem os artefatos do updater, e o plugin continua compilado.

## 3. Premissas Assumidas
| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | O servidor do app vem, por ordem de prioridade: de `--server`, do arquivo `server.txt` (gravado pelo instalador ou pelo último `--server`) ou do padrão `http://localhost:3000` | Ainda não existe URL pública; nada fica cravado [#80] | Trocar o padrão quando o servidor for publicado |
| P2 | O estado do app vai para `%APPDATA%\app.streamp2p.desktop\status.json`, e `--status` imprime esse arquivo | Um app de interface gráfica não responde pelo stdout; um arquivo é simples e lido por qualquer ferramenta [#7] | Trocar por um pipe nomeado se precisar de comandos com resposta |
| P3 | A permissão de IPC para a URL do servidor é concedida em tempo de execução (`add_capability`) só para essa origem | A URL é dinâmica; sem isso o `__TAURI__` não funciona na página remota [#55] | — |
| P4 | `createUpdaterArtifacts` desligado até existir a chave de assinatura | Sem a chave privada o build falha | Religar quando a chave for gerada |
| P5 | A degradação de rede é feita por um proxy UDP em Node, na frente de um TURN local (`iceTransportPolicy: 'relay'` no teste). *Atualizada na execução: o TURN é o Pion (Go), porque com o `node-turn` as conexões caíam sozinhas ~30 s depois* | Funciona no Windows sem driver nem admin, e a degradação atinge pacotes reais [#45] | Não cobre o caminho direto host↔peer; esse caminho é o mesmo código WebRTC |

## 4. Decisão Visual
- Nenhuma tela nova. O app reaproveita a interface web; a CLI e o instalador não têm superfície visual nova. O NSIS segue em PT-BR, como já estava.

## 5. Passos Atômicos
| # | Arquivo | Mudança | Prática | Verificação |
|---|---|---|---|---|
| 1 | máquina | rustup estável MSVC | — | `rustc -V` |
| 2 | `app/src-tauri/*`, `web/app.js` | CLI + single-instance + status + janela criada em código | [#2][#80] | build + teste manual pela CLI |
| 3 | `app/src-tauri/tauri.conf.json`, `hooks.nsh` | `/SERVER=` no NSIS; build do `.exe` | [#77] | instalar, abrir, ler o status, sair e desinstalar em silêncio |
| 4 | `e2e/netsim.js`, `package.json` | proxy UDP + TURN + cenários + medição | [#43][#45] | tabela de medições |
| 5 | README, handoff, ENTREGA | documentar | [#96] | leitura |

## 6. Riscos e rollback
- O Tauri recusa uma URL remota sem capability → coberto pela P3. Se falhar, o app abre, mas sem bandeja nem lista de fontes.
- `git revert` por commit [#84].

## 7. Definição de Pronto
- `.exe` gerado; instalação, abertura, comandos, status e desinstalação testados por CLI.
- `npm test` e `npm run e2e` verdes.
- `npm run netsim` com números reais registrados na ENTREGA.
