<p align="center"><strong>Português</strong> · <a href="README.en.md">English</a></p>

<p align="center">
  <img src="docs/brand/readme-hero.png" alt="Stream P2P: sua tela, todo mundo ao mesmo tempo" width="100%">
</p>

<p align="center">
  <a href="https://github.com/yagoriccomi/stream-p2p/releases/latest"><img src="https://img.shields.io/github/v/release/yagoriccomi/stream-p2p?color=7f00ff&label=release" alt="Versão"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/yagoriccomi/stream-p2p?color=1f6feb&label=licen%C3%A7a" alt="Licença"></a>
  <img src="https://img.shields.io/badge/testes-node%20--test-1a7f37" alt="Testes com node --test">
  <img src="https://img.shields.io/badge/Node-24-1a7f37?logo=nodedotjs&logoColor=white" alt="Node 24">
  <img src="https://img.shields.io/badge/Windows-Tauri%202-0969da?logo=tauri&logoColor=white" alt="App para Windows com Tauri 2">
  <img src="https://img.shields.io/badge/Discord-%2Fstream-5865f2?logo=discord&logoColor=white" alt="Bot do Discord">
</p>

<p align="center">
  <a href="https://stream.yagoriccomi.com.br"><img src="https://img.shields.io/badge/Abrir_no_navegador-7f00ff?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Abrir no navegador"></a>
  <a href="https://github.com/yagoriccomi/stream-p2p/releases/latest"><img src="https://img.shields.io/badge/Baixar_para_Windows-1c1c20?style=for-the-badge&logo=github&logoColor=white" alt="Baixar para Windows"></a>
  <a href="https://stream.yagoriccomi.com.br/discord/install"><img src="https://img.shields.io/badge/P%C3%B4r_o_bot_no_Discord-1c1c20?style=for-the-badge&logo=discord&logoColor=white" alt="Pôr o bot no Discord"></a>
</p>

<p align="center">
  Uma pessoa transmite, o resto assiste e conversa por voz.<br>
  Funciona no navegador, no celular como app e no Windows com app próprio.<br>
  Ninguém cria conta: digite um apelido e mande o link.
</p>

## O que tem de bom

<img src="docs/brand/readme-features.png" alt="Sem login. Mesmo atraso para todos, de 60 a 400 ms. Voz em tempo real. Até 50 pessoas, com o vídeo em árvore e até 1440p60. App para Windows com escolha de quais apps entram no áudio. Bot do Discord com /stream criar." width="100%">

## Como funciona

<img src="docs/brand/readme-how.png" alt="O servidor só faz a sinalização. Quem transmite manda o vídeo para quem repassa (relay), que manda para quem assiste. A voz é uma malha; sem ligação direta, a mídia passa por TURN." width="100%">

## Usar agora

1. Abra [stream.yagoriccomi.com.br](https://stream.yagoriccomi.com.br), digite um apelido e clique **Criar sessão**.
2. Mande o link do convite para a galera.
3. Clique **Transmitir**, escolha a tela e a qualidade. Quem quiser a vez clica **Pedir a vez**.

No celular dá para assistir e falar: no Android, **Instalar app**; no iPhone, **Compartilhar › Adicionar à Tela de Início**.

## Instalar o app para Windows

O instalador ainda não tem assinatura de código, então o Windows mostra um aviso na primeira vez. Clique em **Mais informações** e depois em **Executar assim mesmo**. Ele instala só para o seu usuário, sem pedir administrador.

<img src="docs/brand/smartscreen.png" alt="Passo 1: clique em Mais informações. Passo 2: clique em Executar assim mesmo." width="100%">

## No Discord

| Comando | O que faz |
|---|---|
| `/stream criar` | Abre a sessão e posta o botão Entrar |
| `/stream status` | Quem está em cada sessão e quem transmite |
| `/stream convite` | Posta de novo o botão da última sessão |
| `/stream encerrar` | Encerra a última sessão que você criou ali |
| `/stream app` | Link para baixar o app para Windows |
| `/stream help` | Explica as funções e dá dicas |
| Clique direito › Apps › **Chamar para stream** | Chama a pessoa e manda o link por mensagem privada |

## Rodar na sua máquina

```bash
npm install
npm test     # sessão, permissões, fila de vez, árvore, bot do Discord
npm start    # http://localhost:3000
```

```text
server/   sinalização, sessões, árvore de vídeo, bot do Discord
web/      o site (também PWA no celular)
app/      app para Windows (Tauri 2, Rust)
worker/   porta de entrada do bot (Cloudflare Worker)
e2e/      testes com navegador e rede simulada
docs/     documentação técnica, planos, entregas e marca
```

Como testar, publicar o servidor, o app e o bot: [documentação técnica](docs/TECNICO.md).

<details>
<summary><strong>Limitações conhecidas</strong></summary>

O estado fica em memória (reiniciar o servidor encerra as sessões), o relay re-codifica no navegador e ainda não há encoder NVENC/AMF nativo. A lista completa está em [Limitações](docs/TECNICO.md#limitações).

</details>

---

<p align="center">Feito por <a href="https://github.com/yagoriccomi">Yago Riccomi</a> · licença <a href="LICENSE">GPL-3.0</a></p>
