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
  3. Ana transmite em 1440p60 com 20 Mbps: 1 recebe direto (buffer de 120 ms) e 2 via relay (90 ms).
  4. Troca a fonte ao vivo.
  5. Caio, moderador, leva 403 ao tentar banir.
  6. Ana passa a vez para Dani.
  7. O relay sai e os filhos dele são re-pendurados.
- **Manual, LAN:** quem transmite abre em `localhost`, porque a captura exige contexto seguro. Os amigos abrem `http://<seu-IP>:3000/?code=<código>`. Fora da LAN, configure um TURN em **Configurações** (T11).

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

Para gerar o instalador, no Windows com Rust e Node:
1. Troque `https://stream-p2p.example.com` em `app/src-tauri/tauri.conf.json` e em `app/src-tauri/capabilities/default.json` pela URL do seu servidor.
2. Gere as chaves com `npx tauri signer generate` e cole a chave pública em `plugins.updater.pubkey`.
3. Rode `cd app && npm install && npm run build`. O instalador sai em `app/src-tauri/target/release/bundle/nsis/`.

A página `/download` explica a instalação para quem baixa.

## Limitações
- O upload é declarado pela pessoa, não medido.
- O estado fica em memória, então reiniciar o servidor encerra as sessões.
- O relay re-codifica no navegador.
- O app usa o mesmo WebRTC do navegador; ainda não há encoder NVENC/AMF nativo.
- A fonte escolhida no seletor nativo ainda passa pelo seletor do sistema na hora de capturar.
