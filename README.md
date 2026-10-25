# Stream P2P

Transmissão de tela P2P entre amigos, sem login. Voz em tempo real em malha; vídeo em árvore com relay e atraso igual para todos, automático (o menor que a rede de quem assiste aguenta, de 60 a 400 ms) ou fixo em Configurações. Arquitetura em `handoff_stream_p2p_architecture.md`; telas em `docs/planos/PLANO-telas-T01-T14.md`; design (identidade, telas T01–T14 e ícones) no canvas https://claude.ai/artifact/PyEQWUdc5AsX4rGRARdC8S.

## Rodar
```bash
npm install
npm test     # sessão, permissões, fila de vez, árvore, bot do Discord
npm start    # http://localhost:3000  (PORT para mudar)
```

## Fluxo
1. **Início (T01):** digite seu apelido e clique **Criar sessão**, ou cole um código para entrar.
2. **Entrar (T09):** quem abre o convite (`/?code=xxxx-xx&name=Apelido`) escolhe se entra com mic ou só ouvindo. O apelido é único na sessão; um apelido repetido devolve 409.
3. **Sessão (T03):**
   - Qualquer pessoa clica **Transmitir**. Só uma transmite por vez; as outras clicam **Pedir a vez**.
   - Na tela de fonte e qualidade (T02), escolha 720p30, 1080p60 ou 1440p60 e informe seu upload.
   - **Atraso igual para todos**: no Automático (padrão), cada pessoa que assiste mede quanto a própria rede precisa de reserva (`jitterBufferMinimumDelay`) e o servidor usa o menor atraso que não engasga para ninguém, com folga de 20 ms. Sobe na hora quando a rede piora e só desce depois de 30 s calma. Em **Configurações** dá para fixar 80, 150 ou 300 ms, e ali aparece o recomendado para a sessão; quem transmite muda ao vivo.
   - As escolhas ficam salvas neste aparelho: nome, qualidade, upload, codec, aba de fonte, som da transmissão, volumes, mic, saída, ganho, supressão de ruído, eco, apertar para falar, chat e métricas abertos ou fechados. No app, também o tamanho, a posição e se a janela estava maximizada.
   - O botão **Chat**, no rodapé, esconde o chat e a lista de pessoas, e o vídeo ocupa a largura toda. Uma bolinha avisa de mensagem nova.
   - Quem assiste abre **Métricas**, sobre o vídeo: o que sai de quem transmite (captura, resolução, fps, bitrate, codec e o que limita, CPU ou rede) ao lado do que chega (o mesmo, mais perda, congelamentos e atraso).
4. **Quem transmite (T04)** troca a fonte e a qualidade ao vivo, pausa, liga ou desliga o áudio e passa a vez sem derrubar ninguém.
5. **Áudio e papéis (T10):**
   - O áudio da transmissão e a voz têm volumes separados, e há volume por pessoa, escolha de dispositivos e aperte-para-falar (V).
   - O dono tem todos os poderes. Moderadores gerenciam a sessão, mas não banem, não nomeiam moderadores e não encerram.
6. **Erros (T05):** todo erro mostra o código HTTP e o porquê.

| Código | Quando |
|---|---|
| 400 | Dado inválido |
| 403 | Sem permissão ou banido |
| 404 | Sessão não existe |
| 409 | Apelido em uso ou já tem alguém transmitindo |
| 410 | Sessão encerrada |
| 423 | Sessão trancada |
| 429 | Mensagens demais |
| 503 | Sessão cheia (50 pessoas) ou sem vaga na árvore |

## Testar
- **Automático:** `npm run e2e` (Chrome headless; `CHROME_PATH` para outro navegador, `HEADFUL=1` para ver as janelas). O teste:
  1. Ana cria a sessão; Bruno, Caio e Dani entram pelo convite.
  2. Confere o 409, o chat e a malha de voz.
  3. Ana mede o upload em T02 (a medição não sobrescreve o que ela digitou) e transmite em 1440p60 com 20 Mbps: 1 recebe direto e vira relay dos outros 2.
  4. Cada um mede o RTT do salto. O vídeo falso traz um relógio em bits, e o teste mede a latência ponta a ponta de cada espectador: a diferença entre eles precisa ficar em até 60 ms (fica em ~30 ms).
  5. Troca a fonte ao vivo.
  6. Caio, moderador, leva 403 ao tentar banir.
  7. Ana passa a vez para Dani.
  8. O relay sai e os filhos dele são re-pendurados.
- **Rede ruim:** `npm run netsim`. Ana transmite para Bruno com a mídia forçada por um TURN local, e um proxy UDP degrada o que o TURN entrega.
  - Cenários: perda de 1, 5 e 10%; atraso de 50 ms; variação de ±20 ms; 150 ± 50 ms com 2% de perda (e cada parte separada: `jitter50` e `loss2rtt300`); cortes de 3, 10, 40 e 90 s; queda do WebSocket por 2 s; servidor fora por 15 s; `/speedtest` com 503.
  - A variação tem dois modelos:
    - o padrão sorteia um atraso por pacote, e os pacotes trocam de lugar (reordenam);
    - em `badQueue` (150 ± 50 ms + 2%), o atraso sobe e desce devagar, como uma fila que enche e esvazia, sem reordenar.
  - Mede, no espectador: fps, kbps, perda RTP, NACKs, congelamentos, buffer, RTT e latência pelo relógio no vídeo. Nos cortes, mede quanto tempo o vídeo e a voz levam para voltar.
  - Mede, em quem transmite, a cada 1 s: a banda estimada pelo controle de congestionamento (BWE), o alvo do encoder, o que saiu, a fração de reenvio, a resolução enviada e o tempo em que o encoder ficou limitado por banda ou por CPU.
  - Antes dos cenários, mede o início da transmissão: a resolução inicial e em quantos segundos chega à resolução cheia. Quem transmite começa com `x-google-start-bitrate` em metade do bitrate do modo (no máximo o upload medido × 0,8): são 3–4 s até a resolução cheia, contra 10–16 s com o padrão do navegador.
  - No Windows, o proxy pede timers de 1 ms ao sistema (`timeBeginPeriod`, pelo `koffi`). Sem isso, todo atraso sai arredondado para 15,6 ms e os pacotes saem em rajadas. A primeira linha mostra o timer medido.
  - O TURN é o servidor de referência do Pion: `go install github.com/pion/turn/v4/examples/turn-server/simple@latest`. Para outro caminho, defina `NETSIM_TURN_BIN`.
  - Variáveis:
    - `NETSIM_ONLY=base,loss5` roda só alguns cenários;
    - `NETSIM_MODE=1080p60` troca a qualidade;
    - `NETSIM_MEASURE_MS=60000` alonga a janela de 10 s (congelamentos são raros, e 10 s não bastam para comparar);
    - `NETSIM_TRACE=1` mostra, segundo a segundo, o que quem transmite mediu;
    - `NETSIM_CONTENT=game` troca a tela de teste, que é lisa e se comprime a ~1,2 Mbps, por uma textura em movimento que deixa o encoder limitado por banda, como num jogo;
    - `NETSIM_DEGRADATION=balanced` (ou `maintain-resolution`, `maintain-framerate`) força o `degradationPreference` de quem transmite, para comparar;
    - `NETSIM_START_BITRATE=<kbps>` troca o valor de início do app (`0` tira o parâmetro: padrão do navegador);
    - `NETSIM_START_IN=bad` (ou `badQueue`) começa a transmissão numa rede ruim, para medir o início quando o upload medido é otimista;
    - `NETSIM_DEBUG=1` mostra o log das páginas.
  - A carga da máquina contamina os números. Rode `base` junto (`NETSIM_ONLY=base,bad`) e descarte a rodada se o `base` não sair com jitter RTP perto de 0 e sem congelamentos.
- **Manual, LAN:** quem transmite abre em `localhost`, porque a captura exige contexto seguro. Os amigos abrem `http://<seu-IP>:3000/?code=<código>`. Fora da LAN, vale o TURN do servidor (abaixo).

## TURN para fora da LAN
O servidor entrega a lista de ICE em `/ice.json`: sempre o STUN do Google e, se configurado, um TURN. Sem TURN, quem está atrás de NAT simétrico (rede móvel, empresa, CGNAT de operadora) não recebe vídeo nem voz.

**Cloudflare TURN (recomendado, sem servidor próprio):** 1.000 GB/mês grátis, depois US$ 0,05/GB.
- `CF_TURN_KEY_ID` e `CF_TURN_API_TOKEN`: o ID e o token da chave TURN criada no painel (Realtime › TURN).
- O servidor pede à Cloudflare credenciais de 24 h e as renova a cada 12 h. A chave nunca vai para o navegador.
- Se a Cloudflare não responder, o servidor segue com a última credencial válida, ou só com STUN, e registra um aviso no log.
- Rodando local, guarde as duas no `.env` (fora do Git) e suba com `node --env-file=.env server/index.js`. No Render, elas vão nas variáveis de ambiente do serviço.

**Outro TURN (coturn ou provedor com usuário e senha):**
- `TURN_URLS`: uma ou mais URLs separadas por vírgula, por exemplo `turn:turn.seu-dominio.com:3478,turns:turn.seu-dominio.com:5349`.
- `TURN_SECRET` (recomendado): o mesmo `static-auth-secret` do coturn com `use-auth-secret`. Cada cliente recebe uma credencial que vale 6 h.
- `TURN_USERNAME` e `TURN_CREDENTIAL`: para provedores que dão usuário e senha fixos. Só valem quando não há `TURN_SECRET`.

**Os dois juntos:** o TURN próprio vai primeiro na lista e o da Cloudflare depois. O navegador prefere o primeiro, então a Cloudflare só leva a mídia quando o próprio falha.

Exemplo mínimo de `turnserver.conf` para o coturn:
```
listening-port=3478
use-auth-secret
static-auth-secret=<o mesmo valor de TURN_SECRET>
realm=seu-dominio.com
```

## Celular (T07)
É um PWA: no Android use **Instalar app**; no iPhone, **Compartilhar › Adicionar à Tela de Início**. No celular dá para assistir e falar; transmitir só pelo computador.

## Bot do Discord (T06)
Crie um app em https://discord.com/developers e defina estas variáveis:
- `DISCORD_PUBLIC_KEY`: a chave pública do app.
- `PUBLIC_URL`: a URL pública deste servidor.

Aponte **Interactions Endpoint URL** para `PUBLIC_URL/discord/interactions` e registre o comando `/stream criar`. O bot posta um botão **Entrar**, que gera um link pessoal já com o apelido que a pessoa usa no servidor.

## App para Windows (T08, T12–T14)
O app fica em `app/` e é feito com Tauri 2. A janela carrega o mesmo site e acrescenta:
- **Seletor nativo (T12):** monitores e janelas com miniatura. É o único seletor: o app responde ao seletor do Chromium por baixo, com a mesma fonte, sem que ele apareça.
  - O WebView2 desenha esse seletor dentro da janela do app. Por um instante (~0,5 s) o app fica coberto por uma foto dele mesmo, enquanto a escolha é feita por automação (UI Automation).
  - Se algo falhar, a foto sai e o seletor do Chromium fica à vista para a escolha na mão.
  - **Trocar fonte**, ao vivo, abre o mesmo seletor, só com a parte da fonte.
- **Bandeja (T13):** ícone verde ao vivo, com os itens Parar transmissão, Silenciar mic e Copiar convite.
- **Atualização (T14):** baixa e reinicia o app, nunca no meio de uma sessão.
- **Som do PC pelo app:** o app captura o áudio do Windows por conta própria (WASAPI, convertido para estéreo), fora do seletor.
  - **Janela compartilhada:** só o som do programa dela vai na transmissão. Discord, WhatsApp e o chat de voz ficam de fora, e quem fala não se ouve de volta.
  - **Tela inteira:** uma lista mostra quem tem som tocando agora, e a pessoa escolhe o que entra na transmissão (desmarcar Discord e WhatsApp evita que eles vazem). Por padrão todos vêm marcados, como antes.
  - O seletor pede só a imagem, então o áudio vem de qualquer fonte, janela inclusive.
  - O som do próprio app (a voz do chat) fica de fora, para não dar eco em quem assiste.
  - O áudio do sistema do Chromium falha em alguns aparelhos, como um headset 7.1, com "Could not start audio source", e derruba a tela junto.
  - No navegador, o erro agora explica isso e sugere desligar "Compartilhar áudio do sistema" ou usar o app.

O instalador NSIS instala por usuário, sem pedir administrador, e cria o atalho no Menu Iniciar.

Para gerar o instalador, no Windows com Rust e Node: `cd app && npm install && npm run build`. Ele sai em `app/src-tauri/target/release/bundle/nsis/`. Sem `--server` nem `/SERVER=`, o app abre o servidor público (`https://stream-p2p-k72t.onrender.com`).

**Atualização com um clique.** O app procura uma versão nova ao abrir e a cada 30 min. Quando acha, aparece o aviso "Versão X do app disponível" com o botão **Atualizar**: baixa (com a porcentagem), instala e reabre. Em **Configurações → Atualização do app** dá para procurar na hora. Só instala o que foi assinado com a chave do projeto.

Para publicar uma versão nova:
1. Suba a versão em `app/src-tauri/tauri.conf.json` e `app/src-tauri/Cargo.toml`.
2. Gere o instalador assinado: `TAURI_SIGNING_PRIVATE_KEY=~/.tauri/stream-p2p.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD= npm run build` (em `app/`).
3. Publique: `node release.mjs "o que mudou"` (em `app/`). Ele cria o release `vX.Y.Z` no GitHub com o instalador, a assinatura e o `latest.json` que o app consulta.

A chave privada fica em `~/.tauri/stream-p2p.key`, fora do repositório; a pública está em `plugins.updater.pubkey`. Sem a privada não dá para publicar atualizações que os apps instalados aceitem, então guarde uma cópia em lugar seguro.

### Instalar e controlar pela linha de comando
Instalador (NSIS):
```
"Stream P2P_0.2.0_x64-setup.exe" /S /SERVER=http://192.168.0.10:3000
```
- `/S` instala em silêncio, por usuário, sem pedir administrador.
- `/D=<pasta>` escolhe a pasta (precisa ser o último argumento).
- `/SERVER=` grava o servidor em `%APPDATA%\app.streamp2p.desktop\server.txt`.
- Para desinstalar em silêncio: `"<pasta>\uninstall.exe" /S`.
- Rode pelo PowerShell ou pelo `cmd`. O Git Bash converte argumentos que começam com `/` em caminhos, e o `/SERVER=` não chega ao instalador.

App (`stream-p2p.exe --help` mostra tudo):

| Comando | O que faz |
|---|---|
| `--server <url>` | Usa este servidor e o salva para as próximas vezes |
| `--create --name <apelido>` | Abre e cria uma sessão |
| `--join <código> [--name <apelido>]` | Abre na tela de entrar; com `--name`, já entra |
| `--stop-stream`, `--mute`, `--copy-invite`, `--leave`, `--show`, `--quit` | Comandam o app que já está aberto |
| `--status` | Imprime o estado em JSON: tela, sessão, membros, quem transmite, mic, stats e o último erro |
| `--version`, `--help` | Imprime e sai |

Códigos de saída:
- `0`: ok;
- `2`: argumento inválido;
- `3`: o app não está aberto.

Comportamento:
- Um segundo `stream-p2p.exe` repassa os argumentos ao app que já está aberto e sai.
- Quando a sessão é aberta pela linha de comando, o app entra sem pedir o microfone. `--mute` liga e desliga o microfone depois.
- O `--status` lê `status.json`, que o app atualiza a cada 2 s. Se o arquivo tiver mais de 10 s, o resultado sai com `"running": false, "stale": true`.

A página `/download` explica a instalação para quem baixa.

### Servidor público (Render)
O servidor público está em https://stream-p2p-k72t.onrender.com: serviço `stream-p2p` no Render, plano free, região Virginia.
- **Build e start:** `npm ci --omit=dev` e `npm start`, com `NODE_VERSION=24` e `PUBLIC_URL` igual a essa URL.
- **Deploy automático:** cada push no `main` faz um novo deploy. O servidor reinicia, e as sessões abertas (que ficam só na memória) caem.
- **Plano free:** o serviço dorme depois de um tempo sem acesso, e o primeiro acesso depois disso leva perto de 1 min.
- **Instalar o app apontando para ele:** `.\Stream-P2P_0.1.0_x64-setup.exe /SERVER=https://stream-p2p-k72t.onrender.com`.
- **Sem TURN configurado:** quem estiver atrás de uma rede muito fechada (alguns 4G e redes corporativas) pode não conseguir conectar. Ver "TURN para fora da LAN".

### Servidor na rede local, sem HTTPS
- **No app:** o servidor configurado (`/SERVER=` ou `--server`) é tratado como origem segura. Captura de tela e microfone funcionam em `http://192.168.x.x:3000`.
  - Trocar o servidor com `--server` enquanto o app está aberto não aplica essa liberação. Feche o app (`--quit`) e abra de novo.
- **No navegador**, por `http://` com IP:
  - a pessoa entra, assiste e usa o chat;
  - o navegador não libera microfone nem captura fora de HTTPS ou `localhost`. Para falar ou transmitir, use o app.

## Limitações
- O upload é medido contra o servidor de sinalização antes de transmitir. Se a rede congestionar no meio da transmissão, a cota de envio direto não diminui sozinha.
- O atraso de decodificar e recodificar num relay é uma estimativa fixa (20 ms). O RTT de cada salto é medido.
- Quem é relay vê a transmissão um salto antes dos filhos (~10–30 ms), porque o navegador reenvia o quadro depois do próprio buffer.
- O estado fica em memória, então reiniciar o servidor encerra as sessões.
- Se a mídia ficar mais de ~30 s sem passar, a conexão vai a `failed`. Quem oferece (o pai no vídeo, o id menor na voz) então refaz a conexão, tentando de novo a cada 1, 2, 4 e 5 s até a rede voltar. Depois que a rede volta, vídeo e voz retornam em até ~5 s (medido pelo `npm run netsim` com cortes de 40 e 90 s). Cortes de até 10 s se recuperam sem refazer nada.
- Com 150 ± 50 ms de atraso e 2% de perda:
  - O buffer do próprio navegador sobe sozinho até ~260 ms, e há de 0 a 3 congelamentos por minuto.
  - O envio cai para ~1 Mbps ou menos. A causa é a variação do atraso, não a perda: o controle de congestionamento de quem transmite (GCC) a lê como fila enchendo, ou como pacotes fora de ordem que pede de novo. Só com a perda, a banda volta a ~5 Mbps.
  - O app mantém os fps e baixa a resolução (`maintain-framerate`). Com conteúdo de jogo, manter a resolução derrubou o vídeo para 1–4 fps com até 2 s de latência. Detalhes em `docs/planos/ENTREGA-bitrate-sob-perda.md`.
  - Um piso de buffer proporcional ao jitter foi testado e não ajudou: na comparação com a máquina limpa, dobrou os congelamentos. Detalhes em `docs/planos/ENTREGA-piso-de-buffer.md`.
- O relay re-codifica no navegador.
- O app usa o mesmo WebRTC do navegador; ainda não há encoder NVENC/AMF nativo.
- O seletor único depende dos nomes internos do seletor do Chromium (`TabbedPaneTab`, `DesktopMediaSourceView`, `MdTextButton`). Se uma versão do WebView2 mudar esses nomes, o seletor do Chromium volta a aparecer, sem quebrar a transmissão.
