# Entrega — som da janela e volume 50% padrão

## O que mudou
- **Janela sem som** (`web/sysaudio.js`): ao trocar para a janela compartilhada, o app reusava o mesmo canal do Tauri. O Rust recomeça a numeração das mensagens em 0 a cada início e a página segura as mensagens fora de ordem: depois de ~2 s, silêncio total. Agora cada início usa um canal novo [#93].
- **Volume 50% padrão** (`web/boost.js`, `web/voice.js`, `web/app.js`, `web/index.html`): 50 = o som como chega (o 100% de antes), 100 = o dobro. Até 50 toca pelo elemento de áudio como sempre; acima disso toca pelo WebAudio com ganho. O que fica salvo é o nível, então um volume escolhido antes soa igual [#3].
- **Volume por pessoa na lista** (`web/app.js`, `web/styles.css`): na aba Pessoas, cada pessoa tem um controle de volume só para você, padrão 50. O mesmo controle continua no mixer [#6].
- `server/index.js` serve `/boost.js`; `web/sw.js` vai para `sp2p-v15`.

## Como validar
- `npm test` (52 ok) e `npm run e2e` (E2E OK).
- `e2e/_boost.tmp.mjs` (não versionado): 29 checagens, incluindo voz em 100 = dobro com som, volume pela lista e transmissão em 100.
- Janela real no app (`e2e/_full3.tmp.mjs`): antes `janela2 = 0`; agora 0,06–0,13 contínuo, inclusive numa segunda troca.

## Pendências
- Modo **tela** leva tudo do PC menos o app, inclusive o Discord: para não devolver vozes, transmita a **janela**.
- Não testado ao vivo com amigos.
