# Mapa — app Windows nativo vs. Edge enxuto

## Destino
App Windows nativo em Rust, com latência < 100 ms ponta a ponta e < 5 ms por salto, RAM < 200 MB, sem quebrar Web/PWA. Ver `answers/2026_11_04 app-nativo-vs-enxuto 001.md`.

## Notas
- Relay atual repassa a faixa recebida com `replaceTrack` (`web/stream.js:148`): no Chromium isso decodifica e recodifica a cada salto.
- Captura de áudio do sistema já existe em Rust (`app/src-tauri/src/sysaudio.rs`).

## Decisões até aqui
- 01 → relay pode repassar quadros codificados no navegador; ver `01-benchmark-webrtc-encoded-transform.md`.
- 02 → biblioteca nativa recomendada: `str0m`; ver `02-bibliotecas-webrtc-nativas-rust.md`.

## Névoa
- Se o relay no navegador com Encoded Transform já bate < 5 ms por salto, o ganho do nativo fica só na ponta do transmissor (captura) e na RAM.
- Adaptação de bitrate por filho na árvore (hoje cada salto recodifica e adapta; repasse puro não adapta).
