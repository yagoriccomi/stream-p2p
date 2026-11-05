# App nativo vs. Edge enxuto — decisões (2026-11-04)

> Reconstruído em 2026-11-05 a partir do handoff da sessão anterior; o arquivo original não foi versionado.

| # | Decisão | Escolha |
|---|---|---|
| 1 | Como decidir | Benchmark triplo sob `e2e/netsim.js`: (1) Tauri+WebView2 atual, (2) WebView2 enxuto + Encoded Transform no relay, (3) nativo Rust (WGC + NVENC/AMF + WebRTC nativo) |
| 2 | Destino do app Windows | Executável nativo em Rust, sem Chromium; Web/PWA continua 100% ativa e compatível |
| 3 | Prioridade | 1º latência (< 100 ms ponta a ponta, < 5 ms por salto de relay); 2º RAM (< 200 MB) |
| 4 | Interoperabilidade | WebRTC padrão + árvore atual; Chrome, Edge, Safari, Firefox, PWA no celular |
| 5 | Frentes | Captura na GPU (transmissor) e repasse sem decodificar (relays), em paralelo |
