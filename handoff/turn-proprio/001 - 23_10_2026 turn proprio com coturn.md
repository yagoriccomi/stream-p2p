# Handoff — TURN próprio (coturn em Docker)

**Data:** 23/10/2026 · **Projeto:** stream-p2p · **Estado:** só conversa e especificação, nenhum código escrito.

## Objetivo

O usuário quer **construir o próprio servidor TURN**, para não depender só do TURN da Cloudflare. A conversa explicou o papel do TURN em linguagem leiga (resumo abaixo) e fechou o que precisa ser construído. A próxima sessão implementa.

> Em uma frase: o TURN é o plano B do WebRTC. Quando dois peers não se conectam direto (NAT simétrico, CGNAT, 4G, rede corporativa), ele repassa a mídia de um para o outro. Não decide nada, não guarda nada e não consegue ler a mídia (DTLS-SRTP ponta a ponta). É ele que gasta banda.

O usuário é leigo em redes: explique as decisões em português simples (skill `perguntas-simples`).

## O que já existe no código (não refazer)

O servidor **já sabe entregar um coturn** aos clientes. Falta só o servidor TURN em si.

- [server/ice.js](../../server/ice.js)
  - `iceServers(env)`: STUN do Google + TURN vindo de `TURN_URLS`. Com `TURN_SECRET`, gera credencial no esquema REST do coturn (`use-auth-secret`): usuário `<expira>:sp2p`, senha HMAC-SHA1 em base64, validade `TURN_TTL_S` = 6 h.
  - `iceSource(env)`: se `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` existem, usa **só** a Cloudflare (cache de 24 h, renova em 12 h). Se a Cloudflare falha, cai para `iceServers(env)`, ou seja, para o coturn, se estiver configurado.
  - Testes: [server/ice.test.js](../../server/ice.test.js).
- [server/index.js](../../server/index.js) expõe `GET /ice.json`.
- [web/app.js:39](../../web/app.js) recarrega `/ice.json` a cada hora e passa a lista para `RTCPeerConnection` ([web/stream.js:94](../../web/stream.js)).
- [README.md](../../README.md), seção "TURN para fora da LAN": documenta as variáveis e traz um `turnserver.conf` mínimo de quatro linhas, insuficiente para produção.
- `npm run netsim` já usa um TURN local (o servidor de exemplo do Pion) para simular rede ruim. Ver o README.

## Decisões em aberto (perguntar ao usuário antes de implementar)

1. **Onde o coturn roda.** É o que decide tudo, porque o TURN precisa de **IP público com portas UDP abertas direto**. Não dá para usar cloudflared, ngrok ou o Render: túneis só levam HTTP e o Render não abre UDP.
   - **VPS (recomendado):** Oracle Cloud Free Tier, Hetzner, DigitalOcean etc. Conferir a franquia de tráfego de cada uma na hora.
   - **PC de casa:** só funciona sem CGNAT na operadora e com redirecionamento de portas no roteador. Verificar comparando o IP WAN do roteador com o IP visto de fora. Se forem diferentes, é CGNAT e não funciona.
2. **Domínio / subdomínio** para o TURN (ex.: `turn.<dominio>`), necessário para TLS. Sem domínio, só `turn:` por IP, sem `turns:`.
3. **Convivência com a Cloudflare.** Hoje é um **ou** outro (Cloudflare tem prioridade). Opções:
   - (a) só coturn: tirar as variáveis `CF_*`;
   - (b) coturn como reserva da Cloudflare: já funciona sem mudar código;
   - (c) **os dois na lista**, coturn primeiro e Cloudflare como reserva: exige mudar `iceSource`. É a opção recomendada se o objetivo é economizar a franquia da Cloudflare sem perder a cobertura global.

## O que construir

### 1. Infra do coturn (pasta nova sugerida: `turn/`)

- `turn/docker-compose.yml` com a imagem oficial `coturn/coturn` (fixar a tag de versão), `network_mode: host` (mapear milhares de portas UDP pelo Docker é lento e frágil) e `restart: unless-stopped`.
- `turn/turnserver.conf` de produção:
  - `listening-port=3478` e `tls-listening-port=5349`. Considerar também 443/TCP com TLS para redes que só deixam sair HTTPS, se a porta estiver livre na VPS.
  - `min-port=49152` / `max-port=65535` (faixa de relay; pode ser reduzida, ex.: 49152–50151, para facilitar o firewall).
  - `use-auth-secret` + `static-auth-secret` lido de variável/arquivo **fora do Git**. Mesmo valor de `TURN_SECRET` no servidor de sinalização.
  - `realm=<dominio>`.
  - `external-ip=<ip-publico>/<ip-privado>`: obrigatório em VPS atrás de NAT 1:1, como a Oracle e a AWS.
  - `cert=` / `pkey=` (Let's Encrypt, via certbot ou acme.sh no host, montado como volume somente leitura). Renovação automática e reload do coturn.
  - **Segurança (obrigatório):** `no-multicast-peers`, `no-cli`, `fingerprint`, `stale-nonce`, `no-tlsv1`, `no-tlsv1_1`, e `denied-peer-ip` para todas as faixas privadas, loopback e link-local (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, `::1`, `fc00::/7`, `fe80::/10`). Sem isso, o TURN vira porta de entrada para a rede interna da VPS.
  - **Limites:** `user-quota`, `total-quota` e `max-bps` / `bps-capacity`, para um vazamento de credencial não esgotar a banda.
  - Log em stdout (`log-file=stdout`), sem `verbose` em produção.
- `turn/.env.example` com os nomes das variáveis, sem valores reais.
- Script ou guia do firewall da VPS (ufw/iptables **e** a security list do provedor, já que a Oracle tem as duas): 3478 UDP+TCP, 5349 TCP (e UDP para DTLS, opcional), faixa de relay UDP.

### 2. Servidor de sinalização ([server/ice.js](../../server/ice.js))

- Só se o usuário escolher a opção 3(c): `iceSource` passa a devolver STUN + coturn + Cloudflare juntos, coturn antes. Manter o comportamento atual quando só um dos dois está configurado.
- Atualizar [server/ice.test.js](../../server/ice.test.js) para cobrir: só coturn, só Cloudflare, os dois, e a Cloudflare caindo com o coturn presente.
- Conferir que `TURN_TTL_S` (6 h) segue compatível com o refresh de 1 h do cliente.

### 3. Documentação

- Reescrever "TURN para fora da LAN" no [README.md](../../README.md): passo a passo da VPS, das portas, do certificado e de onde colocar `TURN_URLS` / `TURN_SECRET` no Render. Remover o `turnserver.conf` de quatro linhas e apontar para `turn/turnserver.conf`.

## Critérios de aceite

1. O coturn sobe com `docker compose up -d` na máquina escolhida e reinicia sozinho.
2. Com `TURN_URLS` e `TURN_SECRET` no Render, `/ice.json` devolve o coturn com credencial temporária (o segredo nunca aparece na resposta).
3. A página "Trickle ICE" (webrtc.github.io/samples) mostra candidatos `relay` com uma credencial gerada pelo servidor.
4. Uma transmissão real funciona com `iceTransportPolicy: 'relay'` forçado nos dois lados (vídeo + voz), de preferência com um dos peers no 4G.
5. Credencial expirada é recusada. Tentativa de relay para IP privado é recusada (`denied-peer-ip`).
6. `npm test` passa (incluindo `server/ice.test.js`).

## Cuidados

- **Nada de segredo no Git:** `static-auth-secret`, `TURN_SECRET` e o token da Cloudflare ficam em `.env` local e nas variáveis do Render.
- Estimativa de banda: cada espectador servido pelo relay custa a taxa do vídeo **na entrada e na saída** da VPS (ex.: 3 Mbps × 1 h ≈ 1,35 GB de saída por espectador). Comparar com a franquia do provedor.
- A árvore de trabalho tem **mudanças não commitadas de outra frente** (`app/src-tauri/*`, `web/app.js`, `web/styles.css`, `web/sw.js`, `app/src-tauri/src/picker.rs`) e vários `e2e/_*.tmp.*`. Não misturar com este trabalho. Usar branch própria e commitar só os arquivos do TURN.

## Skills sugeridas

- `perguntas-simples`: fechar as três decisões em aberto com o usuário, em linguagem leiga, antes de tudo.
- `executar-projeto`: planejar e tocar a implementação (infra + `ice.js` + docs).
- `seguranca-projeto`: revisar o `turnserver.conf` (faixas negadas, quotas, TLS, segredo).
- `testes-projeto` / `tdd-mp`: a mudança em `iceSource`, se houver.
- `documentar-projeto`: a seção do README.
- `git-flow-projeto`: branch e commits separados das mudanças pendentes.

## Referências

- Arquitetura geral: [handoff_stream_p2p_architecture.md](../../handoff_stream_p2p_architecture.md)
- Commit que trouxe o TURN da Cloudflare: `7d5b28a feat(server): TURN da Cloudflare com credenciais temporárias`
- Planos e entregas anteriores: [docs/planos/](../../docs/planos/) (em especial `PLANO-instalador-cli-e-rede.md`)
