# 11 — Interop do app nativo (str0m 0.25) com a sinalização e os pares Web

Ticket: `../11-interop-sinalizacao-web.md`. Data: 2026-11-08.
Fontes primárias: código do repo (caminhos relativos à raiz do worktree) e o código-fonte do str0m 0.25.0 / `is` 0.12.0 no registro local do cargo (`~/.cargo/registry/src/index.crates.io-*/str0m-0.25.0`, `.../is-0.12.0`).
Sem acesso à web nesta rodada: o que depende de Safari/Firefox está marcado **[não verificado]**.

## 1. Transporte da sinalização

- WebSocket no mesmo host/porta do HTTP, `wss://` se a página é https (`web/app.js:68`). Mensagens são JSON, uma por frame (`server/index.js:483-494`).
- Teto de 64 KB por mensagem (`server/index.js:11,466`).
- Rate limit por cliente: 20/s para ações e 200/s para `signal`/`vsignal` (`server/index.js:12-16,456-464,488`). Excesso devolve `error` 429.
- Ao conectar, o servidor envia `{type:'hello', id, modes}`. O `id` é um UUID novo a cada socket (`server/index.js:476,482`).
- Heartbeat: o servidor manda ping WS a cada 25 s e derruba quem não respondeu ao anterior (`server/index.js:467-474`). O cliente nativo só precisa responder com pong no nível do protocolo WS (comportamento padrão de tungstenite/ws). Não existe ping de aplicação.
- O Worker Cloudflare repassa o WebSocket sem alteração (`worker/index.js:11-13,128-129`; `upgrade` não vira página). Com o Render dormindo, o upgrade falha até o servidor acordar, então o cliente precisa de retry.
- Erros chegam como `{type:'error', op, code, reason}` (`server/index.js:175,492`).

## 2. Mensagens

**Cliente para servidor** (`server/index.js:306-452`):

| Mensagem | Campos |
|---|---|
| `create` | `name, device` |
| `join` | `code, name, device, owner?` |
| sessão | `leave`, `rename`, `chat`, `mic {on}`, `settings {patch}`, `end` |
| transmissão | `startStream {mode, uploadKbps, audio, source, latency}`, `streamState {paused, audio, mode, source}`, `stopStream`, `setLatency` |
| vez de transmitir | `requestTurn`, `cancelRequest`, `declineRequest {id}`, `passTurn {id}` |
| moderação | `mod {action, id}` |
| métricas | `hopRtt {ms, needMs?}`, `srcStats {capture, w, h, fps, kbps, codec, limit}` |
| WebRTC | `signal {to, data}` (vídeo), `vsignal {to, data}` (voz) |

**Servidor para cliente** (tratadas em `web/app.js:113-180`): `hello`, `session` (snapshot), `assigned {parent, mode, jitterMs}`, `latency`, `jitter`, `child {id}`, `childGone {id}`, `signal`/`vsignal {from, data}`, `streamEnded`, `chat`, `srcStats`, `peerLeft`, `yourTurn`, `turnRequest`, `forceMute`, `notice`, `ended`, `left`, `error`.

- O servidor só repassa `signal`/`vsignal` entre membros da mesma sessão e não lê `data` (`server/index.js:445-450`). Por isso o payload SDP/ICE é um contrato entre os pares, não com o servidor.
- `modes` são os modos de `server/topology.js:4-8`: 720p30/4000, 1080p60/8000 e 1440p60/15000 kbps.

## 3. Papéis e árvore

- O transmissor é a raiz. Sua capacidade é `floor(upload*0.8/kbps)` filhos diretos (`server/topology.js:10,19-22,35`). Cada espectador aceita até 2 filhos (`:11,67`), e a vaga é escolhida por BFS (`:46-56`).
- O pai recebe `child {id}`. O filho recebe `assigned {parent}` (`server/index.js:182-188`).
- **Quem oferece é sempre o pai** (`web/stream.js:209-228`). O relay só oferece aos próprios filhos depois de receber a trilha de vídeo do pai (`web/stream.js:246-256,263-265`).
- Se um relay sai, o servidor re-pendura os filhos: manda `assigned` + `child` ao novo pai e `childGone` ao pai antigo (`server/index.js:235-246`, `server/topology.js:80-102`).
- Re-parent acontece com uma oferta nova num pc novo. O filho aceita qualquer `offer` e fecha o `upstream` antigo (`web/stream.js:243-245,274-275`).
- **Não há renegociação.** Trocar fonte, modo, pausa ou áudio usa `replaceTrack`, `setParameters` e `track.enabled` (`web/stream.js:1-3,140-197`). Qualquer mudança de topologia cria uma conexão nova.

### Payload de `signal` (vídeo)

- `data = { sdp: {type, sdp}, nid }` ou `data = { candidate: RTCIceCandidateInit, nid }` (`web/stream.js:103,226,260`).
- `nid` é uma string de 8 caracteres por negociação. Resposta ou candidato com `nid` diferente do pc atual é descartado (`web/stream.js:98-99,277`). O nativo precisa gerar, guardar e conferir o `nid`.
- O candidato é o `RTCIceCandidate` serializado: `{candidate:"candidate:…", sdpMid, sdpMLineIndex, usernameFragment}`. `Candidate::from_sdp_string` do str0m espera a forma `candidate:…` (`is-0.12.0/src/candidate.rs:320-324`), então serve.
- A oferta tem 2 m-lines `sendonly`: vídeo e um áudio sempre reservado, mesmo sem áudio capturado (`web/stream.js:216-219`).
- SDP alterado pelo navegador:
  - `b=AS:<kbps>` na m-line de vídeo, na oferta e na resposta (`web/stream.js:18-20,225,259`).
  - O transmissor injeta `x-google-start-bitrate` na resposta remota que recebe (`web/stream.js:25-47,278`).
  - Um transmissor nativo ignora as duas coisas. O equivalente no str0m é `enable_bwe(Some(initial))` (`str0m-0.25.0/src/config.rs:476`).
- Codec: o transmissor Web ordena por `setCodecPreferences` conforme a configuração `codec` (`web/stream.js:199-207`). As opções são vp8, vp9, h264, av1 e h265 (`web/app.js:1044`). Um espectador nativo só responde com os codecs que habilitou, e se não houver interseção a conexão de vídeo falha.

### Payload de `vsignal` (voz, malha completa)

- `data = {sdp}` ou `data = {candidate}`, **sem `nid`** (`web/voice.js:113,151,182`).
- O par de **id menor oferece** (`web/voice.js:139`), com 1 transceiver de áudio `sendrecv` (`:110`). Uma oferta recebida derruba o pc atual e cria outro (`:172-174`).
- Na voz Web, o mic passa por um `Audio` element. No nativo é Opus `sendrecv` por par.

## 4. Reconexão

- **WebSocket:** backoff `min(10 s, 1 s·2^n)` (`web/app.js:73-81`). Ao receber `hello`, o cliente reenvia `join {code, name, device}` (`:120-123`).
  - O servidor despeja a conexão-fantasma quando nome e `device` coincidem (`server/index.js:277-288,316`). Isso evita o 409.
  - **O nativo precisa de um `device` estável e persistido**, como o UUID do `localStorage` na Web (`web/app.js:21`).
- **ICE/pc** (`docs/planos/ENTREGA-recuperar-conexao.md:12-21`, `web/stream.js:71-126`):
  - Quem oferece refaz numa conexão nova quando o estado vai a `failed` ou quando não chega a `connected` em 10 s.
  - O backoff é 1, 2, 4 e 5 s. Zera em `connected` (`web/stream.js:106,116-126`).
  - O filho não pede pai novo (`ENTREGA…:56`).
  - Em str0m não existem `connectionState` nem `failed`: o equivalente é observar `Event::IceConnectionStateChange` (`str0m-0.25.0/src/lib.rs:972`) e implementar o prazo de 10 s.
- **Métricas que o servidor espera:**
  - Todo espectador manda `hopRtt` com o RTT do par ICE selecionado no upstream (`web/app.js:1178`, `web/stream.js:308-310`).
  - O transmissor manda `srcStats` periodicamente (`web/app.js:1174`).
  - Sem `hopRtt`, a árvore usa a estimativa de 30 ms por salto (`server/topology.js:15`).

## 5. ICE / TURN

- `GET /ice.json?id=<código>` devolve `{iceServers}` (`server/index.js:123-126`). A lista é:
  - o STUN do Google;
  - um TURN próprio com credencial REST HMAC de 6 h (`server/ice.js:18-33`);
  - o TURN da Cloudflare com TTL de 24 h, sem URLs na porta 53 (`server/ice.js:38-72`).
- O cliente Web recarrega `/ice.json` a cada 1 h (`web/app.js:44-57`).
- **O str0m 0.25 não tem cliente TURN nem coleta de candidatos.** O README lista "Turn ❌" e "Network interface enum ❌" e diz que o TURN fica a cargo do usuário (`str0m-0.25.0/README.md:450-466,547-569`). Para usar relay, o nativo precisa:
  1. fazer o Allocate/Refresh/CreatePermission/ChannelBind sozinho (RFC 8656), com crate próprio ou escrito à mão;
  2. registrar o endereço alocado com `Candidate::relayed(addr, local, proto)` (`is-0.12.0/src/candidate.rs:296-322`);
  3. encapsular e desencapsular o tráfego do socket TURN.
- STUN srflx também é manual. Existe `Candidate::server_reflexive` (`is-0.12.0/src/candidate.rs:256`).
- **Trickle:**
  - Há suporte, com `add_remote_candidate` e `add_local_candidate` a qualquer momento (`str0m-0.25.0/src/lib.rs:1390,1417`).
  - Os candidatos locais saem embutidos no SDP. Para mandar um candidato no meio da sessão, o nativo serializa com `to_sdp_string` (`is-0.12.0/src/candidate.rs:565`) e envia `{candidate, sdpMid, sdpMLineIndex:0}`.
  - `a=end-of-candidates` é entendido (`str0m-0.25.0/src/sdp/data.rs:251,638`).
- **mDNS:** navegadores mandam candidatos `.local`. O bench nativo já constatou que o par se forma por peer-reflexive (`e2e/bench/native/src/main.rs:182`). Isso funciona só porque o nativo é controlado e recebe a checagem. Entre redes diferentes vale o srflx/relay do navegador.
- ICE restart existe (`str0m-0.25.0/src/change/sdp.rs:485`), mas o protocolo não usa: ele sempre cria um pc novo.
- ICE-TCP: o `is` aceita candidatos tcp (`is-0.12.0/src/candidate.rs:63-65`), mas o transporte TCP fica com o app.

## 6. Mídia no str0m 0.25

- **H.264:** `enable_h264` registra os perfis 42001f, 42e01f, 4d001f e 64001f, com packetization-mode 0 e 1 (`str0m-0.25.0/src/format/codec_config.rs:388-405`).
  - O bench usa `add_h264` com o perfil 42e01f por padrão e valida a matriz de perfis do parser privado (`e2e/bench/native/src/main.rs:37-61`).
  - Safari e Firefox: o que se costuma dizer é que aceitam Constrained Baseline 42e01f com packetization-mode=1, e o Safari também High 640c1f. **[não verificado: falta fonte primária WebKit/Gecko]**. A aposta segura é 42e01f / pm=1.
- **H.265 / AV1 / VP9 / VP8:** há `enable_*` para todos (`str0m-0.25.0/src/config.rs:319-360`). O H.265 é "experimental" (`codec_config.rs:408-411`).
- **Opus:** `enable_opus(enabled, use_red)` com 48 kHz, 2 canais, `minptime=10` e `useinbandfec=1` (`codec_config.rs:303-320`). O str0m não codifica nem decodifica: o encoder Opus é por conta do app (README `:565-566`).
- **Data channel:** há suporte (`str0m-0.25.0/src/change/sdp.rs:432-459`), mas o protocolo atual **não usa nenhum**. É irrelevante para interop.
- **Renegociação:** `add_media`, `set_direction`, `stop_media` e `accept_offer`/`accept_answer` funcionam em ofertas subsequentes (`str0m-0.25.0/src/change/sdp.rs:86,176,292,375,397`). O protocolo não precisa disso.
- **Falta no str0m:**
  - jitter buffer adaptativo (README `:563`). O espectador nativo precisa implementar o equivalente de `jitterBufferTarget`, que o servidor dita via `assigned`, `jitter` e `latency` (`web/stream.js:237-241,248`), além do sync A/V.
  - API PeerConnection: estados, `getStats` com RTT do par selecionado (para `hopRtt`) e o prazo de 10 s ficam a cargo do app.
  - Equivalentes de `degradationPreference`/`maxBitrate`: são decisões do encoder do app.

## 7. Lacunas

1. Perfis H.264 aceitos por Safari (macOS/iOS) e Firefox: falta citar a fonte primária (WebKit `RTCRtpCapabilities` e Gecko/OpenH264). Também falta testar uma oferta nativa 42e01f contra o Safari iOS (PWA).
2. Cliente TURN em Rust: falta escolher e medir o crate (por exemplo `turn` do webrtc-rs) e validar contra o coturn com REST e contra a Cloudflare (TCP/TLS 443).
3. Espectador nativo com transmissor Web que prefere VP9/AV1: falta definir quais decoders o nativo terá, ou se o servidor deve forçar um codec comum quando houver um nó nativo na árvore.
4. Voz: a malha `vsignal` exige Opus encode/decode, AEC e mixer no nativo, e nada disso foi especificado.
5. Ausência de mDNS no nativo e comportamento com navegadores atrás de NAT simétrico sem TURN: nada medido.
6. Firefox não tem `jitterBufferTarget` nem `x-google-start-bitrate`. Falta medir a interop Firefox como filho de relay nativo.
