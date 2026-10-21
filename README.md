# Stream P2P

Transmissão de tela P2P entre amigos, sem login. Voz em tempo real em malha; vídeo em árvore com relay e ~150 ms de atraso uniforme. Arquitetura em `handoff_stream_p2p_architecture.md`; telas em `docs/planos/PLANO-telas-T01-T14.md`; design (identidade, telas T01–T14 e ícones) no canvas https://claude.ai/artifact/PyEQWUdc5AsX4rGRARdC8S.

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
  - Mede, no espectador: fps, kbps, perda RTP, NACKs, congelamentos, buffer, RTT e latência pelo relógio no vídeo. Nos cortes, mede quanto tempo o vídeo e a voz levam para voltar.
  - O TURN é o servidor de referência do Pion: `go install github.com/pion/turn/v4/examples/turn-server/simple@latest`. Para outro caminho, defina `NETSIM_TURN_BIN`.
  - Variáveis:
    - `NETSIM_ONLY=base,loss5` roda só alguns cenários;
    - `NETSIM_MODE=1080p60` troca a qualidade;
    - `NETSIM_MEASURE_MS=60000` alonga a janela de 10 s (congelamentos são raros, e 10 s não bastam para comparar);
    - `NETSIM_DEBUG=1` mostra o log das páginas.
  - A carga da máquina contamina os números. Rode `base` junto (`NETSIM_ONLY=base,bad`) e descarte a rodada se o `base` não sair com jitter RTP perto de 0 e sem congelamentos.
- **Manual, LAN:** quem transmite abre em `localhost`, porque a captura exige contexto seguro. Os amigos abrem `http://<seu-IP>:3000/?code=<código>`. Fora da LAN, use o TURN do servidor (abaixo) ou um TURN pessoal em **Configurações** (T11).

## TURN para fora da LAN
O servidor entrega a lista de ICE em `/ice.json`: sempre o STUN do Google e, se configurado, um TURN. Sem TURN, quem está atrás de NAT simétrico (rede móvel, empresa) não recebe vídeo nem voz.
- `TURN_URLS`: uma ou mais URLs separadas por vírgula, por exemplo `turn:turn.seu-dominio.com:3478,turns:turn.seu-dominio.com:5349`.
- `TURN_SECRET` (recomendado): o mesmo `static-auth-secret` do coturn com `use-auth-secret`. Cada cliente recebe uma credencial que vale 6 h.
- `TURN_USERNAME` e `TURN_CREDENTIAL`: para provedores que dão usuário e senha fixos. Só valem quando não há `TURN_SECRET`.

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
- **Seletor nativo (T12):** monitores e janelas com miniatura.
- **Bandeja (T13):** ícone verde ao vivo, com os itens Parar transmissão, Silenciar mic e Copiar convite.
- **Atualização (T14):** baixa e reinicia o app, nunca no meio de uma sessão.

O instalador NSIS instala por usuário, sem pedir administrador, e cria o atalho no Menu Iniciar.

Para gerar o instalador, no Windows com Rust e Node: `cd app && npm install && npm run build`. Ele sai em `app/src-tauri/target/release/bundle/nsis/`. A URL do servidor não fica no build: vem da linha de comando ou do instalador (abaixo).

Para ligar a atualização automática, gere as chaves com `npx tauri signer generate`, cole a chave pública em `plugins.updater.pubkey`, ponha `createUpdaterArtifacts: true` em `tauri.conf.json` e defina `TAURI_SIGNING_PRIVATE_KEY` no build. A chave privada nunca entra no repositório.

### Instalar e controlar pela linha de comando
Instalador (NSIS):
```
"Stream P2P_0.1.0_x64-setup.exe" /S /SERVER=http://192.168.0.10:3000
```
- `/S` instala em silêncio, por usuário, sem pedir administrador.
- `/D=<pasta>` escolhe a pasta (precisa ser o último argumento).
- `/SERVER=` grava o servidor em `%APPDATA%\app.streamp2p.desktop\server.txt`.
- Para desinstalar em silêncio: `"<pasta>\uninstall.exe" /S`.

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

## Limitações
- O upload é medido contra o servidor de sinalização antes de transmitir. Se a rede congestionar no meio da transmissão, a cota de envio direto não diminui sozinha.
- O atraso de decodificar e recodificar num relay é uma estimativa fixa (20 ms). O RTT de cada salto é medido.
- Quem é relay vê a transmissão um salto antes dos filhos (~10–30 ms), porque o navegador reenvia o quadro depois do próprio buffer.
- O estado fica em memória, então reiniciar o servidor encerra as sessões.
- Se a mídia ficar mais de ~30 s sem passar, a conexão vai a `failed`. Quem oferece (o pai no vídeo, o id menor na voz) então refaz a conexão, tentando de novo a cada 1, 2, 4 e 5 s até a rede voltar. Depois que a rede volta, vídeo e voz retornam em até ~5 s (medido pelo `npm run netsim` com cortes de 40 e 90 s). Cortes de até 10 s se recuperam sem refazer nada.
- Com 150 ± 50 ms de atraso e 2% de perda:
  - O buffer do próprio navegador sobe sozinho até ~260 ms, e há de 0 a 3 congelamentos por minuto.
  - O envio cai para algumas centenas de kbps (controle de congestionamento de quem transmite).
  - Um piso de buffer proporcional ao jitter foi testado e não ajudou: na comparação com a máquina limpa, dobrou os congelamentos. Detalhes em `docs/planos/ENTREGA-piso-de-buffer.md`.
- O relay re-codifica no navegador.
- O app usa o mesmo WebRTC do navegador; ainda não há encoder NVENC/AMF nativo.
- A fonte escolhida no seletor nativo ainda passa pelo seletor do sistema na hora de capturar.
