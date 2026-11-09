# 15 — Cliente TURN para str0m

Ticket: [`../15-cliente-turn-rust.md`](../15-cliente-turn-rust.md). Data: 2026-11-08.
Fontes: código dos crates baixados do crates.io (turn-client-proto 0.7.3, turn-client-rustls 0.1.2, turn 0.17.3, rtc-turn 0.21.1), str0m 0.25 / is 0.12 locais, docs.rs, RFC 8656 e a documentação da Cloudflare. Nada foi compilado nem testado contra servidor.

## Recomendação

**Usar `turn-client-proto` 0.7.3 + `turn-client-rustls` 0.1.2 (MIT OR Apache-2.0).** Os dois são sans-IO, como o str0m, e cobrem UDP, TCP e TLS. Fazem Allocate, Refresh automático, CreatePermission e ChannelBind. Esforço estimado: **~300–500 linhas** de cola no laço de I/O do app, ou seja, 2 a 4 dias com os testes contra coturn e Cloudflare. É estimativa, não medição.

Reserva: `rtc-turn` 0.21.1 (webrtc-rs, sans-IO). Ele é mais usado, mas **não tem TLS** e, no código lido, o TCP não ficou demonstrado. `turn` 0.17 (webrtc-rs) foi descartado: é assíncrono (tokio, `Arc<dyn Conn>`) e não traz TLS.
Implementação própria só vale se os dois falharem no coturn. A RFC 8656 inteira (retransmissão, 401/438, nonce, ChannelData com padding no TCP) custaria semanas.

## Comparativo

| Crate | Modelo | UDP / TCP / TLS | Refresh / Perm / Channel | Licença | Manutenção (crates.io, 2026-11-08) |
|---|---|---|---|---|---|
| `turn-client-proto` + `-rustls` | sans-IO (`now: Instant` em toda chamada) | sim / sim (`tcp.rs`) / sim (crate `-rustls`; DTLS em `-dimpl`/`-openssl`) | Refresh interno no `poll`; `create_permission` e `bind_channel` explícitos; `send_to` usa canal se ele existir | MIT OR Apache-2.0 | 0.7.3 de 2026-10-06; 0.7.1→0.7.3 em 6 meses; ~28 mil downloads/90 d; MSRV 1.80 |
| `rtc-turn` (webrtc-rs/rtc) | sans-IO | UDP sim; TCP aparece só na config; TLS não | `refresh_allocations`, `update_credentials`, cap do intervalo de refresh | MIT/Apache-2.0 | 0.21.1 de 2026-10-11; ~1,76 mi/90 d |
| `turn` (webrtc-rs/webrtc) | async tokio | UDP via `Conn`; TLS não | timers internos | MIT/Apache-2.0 | 0.17.3 de 2026-11-07; ~2,1 mi/90 d |

Evidências:
- `turn-client-proto/src/lib.rs:16-25`: RFC 5766, 6062, 6156 e 8656.
- `api.rs` (trait `TurnClientApi`): `create_permission`, `bind_channel`, `send_to`, `recv`, `poll`, `poll_transmit`, `poll_event`, `delete`. Não existe `refresh` público.
- `protocol.rs:1686-1700` e `:919`: o REFRESH é enviado sozinho a partir do `poll`.
- `protocol.rs:50-56`: permissões duram 300 s, canais 600 s e há folga de 60 s antes de expirar.
- `protocol.rs:384,463`: trata STALE_NONCE reenviando.
- `protocol.rs:1534-1540`: `send_to` usa ChannelData quando o canal está vivo e Send indication quando não está.
- `turn-client-rustls/src/lib.rs:11-22`: cliente TLS sobre TCP. Não ativa provedor de criptografia; o app escolhe ring ou aws-lc-rs.
- `rtc-turn/src/client/mod.rs:115-140`: `ClientConfig` com `transport_protocol` UDP/TCP e `allocation_refresh_interval_cap`.
- `rtc-turn/src/client/mod.rs:540-560`: `update_credentials` assina de novo a alocação existente, sem 437. Útil para a credencial REST.
- `turn/src/client/mod.rs:59-69`: `conn: Arc<dyn Conn>`. `relay_conn.rs:27,87-88` tem refresh por timer, ou seja, é tokio.

## Integração com str0m

- O str0m não faz TURN. O README (`str0m-0.25.0/README.md:450-470`) diz que TURN é "similar to enumerating local network interfaces – it's a way of obtaining sockets".
- Candidato relay: `Candidate::relayed(relay_addr, local_addr, "udp")` (`is-0.12.0/src/candidate.rs:296`) e depois `rtc.add_local_candidate(...)`. Exemplo em `str0m-0.25.0/tests/ice-candidates.rs:78-82`.
- Saída: quando `Transmit.source` (`str0m-proto/src/net.rs:120-132`) for o endereço relay, chamar `turn.send_to(UDP, transmit.destination, contents, now)` e mandar o resultado pelo socket do servidor TURN.
- Entrada: bytes do socket TURN vão para `turn.recv(...)`. O `TurnRecvRet` com dados de peer é repassado ao str0m como `Receive { source: peer, destination: relay_addr, ... }`.
- Permissão e canal: criar com `create_permission(peer_ip)` e `bind_channel(peer_addr)` para cada candidato remoto ao recebê-lo. O canal economiza 36 bytes por pacote em relação ao Send indication. Isso é inferência pela RFC 8656 §3.5 e §12.
- Tempo: incluir `turn.poll(now)` e o próximo prazo no mesmo laço de timeout do str0m.

## Compatibilidade com o servidor

- **Credencial REST de `/ice.json`:**
  - `server/ice.js:18-33` monta usuário `<expira>:sp2p` e senha HMAC-SHA1 em base64.
  - Para o cliente TURN é uma credencial de longo prazo comum (`TurnCredentials::new(user, pass)`). O realm vem do 401.
  - A cada recarga de `/ice.json` (1 h) há duas opções:
    - criar uma alocação nova;
    - com `rtc-turn`, chamar `update_credentials`.
  - No `turn-client-proto` **não foi achada** forma de trocar a credencial em uma alocação viva. Como o TTL do coturn é 6 h e o da Cloudflare 24 h, basta renovar a alocação antes de expirar.
- **coturn** (`handoff/turn-proprio/001 …`):
  - portas 3478 UDP/TCP e 5349 TLS;
  - `use-auth-secret`, `fingerprint`, `stale-nonce`. O cliente já reenvia em STALE_NONCE.
  - `denied-peer-ip` com faixas privadas: na LAN, o relay não alcança o peer, o que é esperado.
- **Cloudflare** (developers.cloudflare.com/realtime/turn): 3478/udp, 443/udp, 3478/tcp, 80/tcp, 5349/tcp TLS e 443/tcp TLS. Limites por alocação: >5–10 kpps e >50–100 Mbps dão perda. Três vezes 8 Mbps cabem.
- **RFC 8656:**
  - §3.1: cliente→servidor pode ser UDP, TCP, TLS ou DTLS; servidor→peer é sempre UDP.
  - §7.1: REQUESTED-TRANSPORT é sempre UDP.
  - §6: alocação de 600 s, renovada por Refresh.
  - §3.3: permissão de 5 min.
  - §3.5: canal de 10 min.
  - Candidato relay é sempre "udp", mesmo com TURN/TLS.

## Lacunas
1. Nada compilado nem testado: falta Allocate contra o coturn do projeto e contra `turn.cloudflare.com:443` (TLS).
2. Custo de CPU/latência do TURN/TLS a 8 Mbps × 3 (pedido no map.md). Não medido.
3. Adoção do `turn-client-proto`: o README só diz que o cliente "implements some of the TURN protocol requirements"; o financiamento NLnet aponta para o librice. Não há lista de usuários em produção.
4. TCP no `rtc-turn`: só aparece na config; o framing não foi confirmado.

## Fontes
- https://docs.rs/turn-client-proto/0.7.3 , https://github.com/ystreet/turn-proto , https://docs.rs/turn-client-rustls/0.1.2
- https://docs.rs/rtc-turn/0.21.1 , https://github.com/webrtc-rs/rtc
- https://docs.rs/turn/0.17.3 , https://github.com/webrtc-rs/webrtc/tree/master/turn
- https://crates.io/api/v1/crates/{turn-client-proto,turn-client-rustls,turn,rtc-turn} (versões, datas, downloads, licença)
- https://www.rfc-editor.org/rfc/rfc8656.html
- https://developers.cloudflare.com/realtime/turn/
- Local: `~/.cargo/registry/src/*/str0m-0.25.0/README.md`, `is-0.12.0/src/candidate.rs`, `str0m-proto-0.8.0/src/net.rs`; `server/ice.js`; `handoff/turn-proprio/001 - 23_10_2026 turn proprio com coturn.md`
