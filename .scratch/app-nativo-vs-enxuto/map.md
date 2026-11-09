# Mapa — app Windows nativo em Rust

## Destino
ADR escrito (06) + plano em fatias para agentes (12) do app Windows nativo em Rust que transmite, repassa e assiste, substituindo o Tauri ao atingir paridade. Construção fora deste mapa.

## Notas
- Metas: latência < 100 ms ponta a ponta, < 15 ms por salto (afrouxada em 2026-11-08), RAM < 200 MB, Web/PWA intacta. Decisões: `answers/2026_11_04 … 001`, `… 002`, e `E:/Projetos/stream-p2p/answers/2026_11_08 app-nativo-vs-enxuto 003.md`.
- Escopo: paridade com Tauri, mesmo visual/fluxo da web, todas as GPUs + fallback software, espectador nativo, cinco formatos de vídeo como a web (H.264, VP8, VP9, AV1, H.265) ao assistir e transmitir, resolução independente por espectador via recodificação sob demanda no relay.
- Números: `docs/planos/ENTREGA-benchmark-retomada.md`; handoff `handoff/app-nativo-vs-enxuto/002 …`.
- Captura de áudio do sistema já existe em Rust (`app/src-tauri/src/sysaudio.rs`).
- Regra geral do app (answers 005): todo problema conhecido tem aviso em linguagem simples, atalho para resolver e plano B automático quando der.
- Restrições: testes sem roubar foco (exceto protótipo 07, liberado em answers 006); sem commit/push/PR sem pedido; não extrapolar dados.
- Skills: `sabatina-mp`, `modelagem-de-dominio-mp`, `criar-projeto` (no 06), `escrever-para-agentes-mp` (no 12).

## Decisões até aqui
- [01 Encoded Transform](01-benchmark-webrtc-encoded-transform.md): relay pode repassar quadros codificados no navegador.
- [02 Bibliotecas WebRTC Rust](02-bibliotecas-webrtc-nativas-rust.md): `str0m`.
- [05 PoC comparativo](05-poc-comparativo-latencia-ram.md): só Rust deu 1072p60; presenter 29 MB/9% CPU × Edge ~200 MB/62%; 8–12 ms por salto com relays Rust.
- [03 Captura e encoder](03-captura-windows-graphics-capture.md): Media Foundation único p/ NVIDIA/AMD/Intel + MS software MFT de fallback; SDKs próprios adiados; só NVIDIA medida.
- [04 Toolkit de UI nativa](04-toolkit-ui-nativa-windows.md): finalista Slint 1.18 + wgpu (reserva iced 0.14); vídeo com 1 cópia GPU, 0 CPU.
- [11 Interop com sinalização Web](11-interop-sinalizacao-web.md): protocolo WS inalterado; str0m cobre ICE/Opus/H.264; app implementa TURN, jitter buffer, prazos e RTT.
- [08 Espectador nativo](08-espectador-nativo.md): MF decoder D3D11 (todas as GPUs + software) → wgpu DX12 sem CPU; perda = congela + PLI; áudio dita o relógio.
- [09 Relay recodifica sob demanda](09-relay-recodifica-sob-demanda.md): BWE GCC/TWCC por filho sem pacing; histerese 0,9×/1,25× com troca em keyframe; 1 decoder + 1 encoder por degrau na GPU; custo não medido.
- [15 Cliente TURN](15-cliente-turn-rust.md): `turn-client-proto` + `-rustls` (sans-IO, UDP/TCP/TLS); 300–500 linhas; não testado.
- [16 Perfis H.264](16-perfis-h264-navegadores.md): `42e01f` pm=1 é comum aos quatro navegadores; nível 3.1 pode limitar 1080p60.
- [17 Codec comum na árvore](17-codec-comum-na-arvore.md): sem forçar H.264; nativo assiste e transmite os cinco formatos da web, decoder por CPU se a GPU não tiver; opção da web mantida.
- [20 Codecs além do H.264](20-codecs-alem-do-h264.md): MF+GPU para os quatro; libvpx e dav1d embutidos; AV1 encode e H.265 só com GPU/extensão; relay recodifica para H.264. Conflito com a 17 resolvido: avisa + atalho + cai para H.264.
- [13 Fallback e perfis neste PC](13-medir-fallback-e-perfis-local.md): três perfis H.264 a 1080p60 na NVIDIA; software MFT 1080p60 a ~1,5 núcleo e 91 MB; troca ao vivo sem congelar. Só este PC.
- [10 Inventário de paridade Tauri](10-inventario-paridade-tauri.md): reescrever WebRTC+voz+UI (~1900 linhas JS); reaproveitar áudio, bandeja, CLI, deep link; servidor intacto. Voz/chat/moderação entram na paridade.
- [18 Medir BWE e recodificação no relay](18-medir-bwe-e-recodificacao-relay.md): BWE+unpaced sem atraso mensurável; reage a queda em ~250 ms; recodificar 1080p→720p custa 4,2 ms/quadro (p95 ≤ 6,1) na NVIDIA, cabe em < 15 ms. Exige `MF_LOW_LATENCY`.
- [19 Firefox 1080p60](19-validar-safari-firefox-1080p60.md): 42e01f e 42001f entregam 1080p60 ao Firefox; main não negocia. iPhone fora do lançamento (answers 006).
- [07 Protótipo Slint](07-prototipo-toolkit-ui.md): vídeo 1080p60 GPU→Slint sem cópia CPU, ~59 fps, decoder→submit p50 ~16,5 ms; Narrador/UIA ok. RAM 155 MB WS / 308 MB private (meta < 50 MB reprovada; 76 MB só do device wgpu DX12) e 85–89 % de um núcleo no redesenho do Slint.
- [14 AMD/Intel](14-validar-amd-intel.md): adiado como risco; validação entra no plano (12) antes do lançamento (answers 006).

## Ainda não especificado
- Erro `ProcessOutput 0x8000FFFF` do MFT após troca de bitrate (13): causa e recuperação.
- Intervalo de keyframe do transmissor (hoje GOP 10 s) × PLI e custo de keyframes grandes na árvore.
- TURN: testar o cliente (15) contra coturn e Cloudflare TLS 443; nenhum TURN local aguenta 3 × 8 Mbps.
- Validação em segundo PC (rede real entre máquinas).
- Instalador, assinatura e atualização automática do executável nativo.
- Migração dos usuários Tauri → nativo (quando e como trocar).
- Presenter entra em pânico quando o espectador rejeita o formato (`RemoteSdp missing a=ice-ufrag/pwd`, 19 com main/4d001f): precisa recusar e cair para 42e01f (answers 005).
- Espectador Firefox gastou ~440 MB / 75–93 % CPU a 1080p60 (19): decode por software? Afeta quem assiste pela web no Firefox.
- Firefox ignora candidatos 127.0.0.1: testes locais com Firefox exigem IP de LAN (19).
- BWE entre dois relays nativos veio ausente/incoerente (18): causa não investigada.
- Recodificação com GPU disputada (jogo/captura) chegou a p95 25–31 ms (18): prioridade/limite de filhos recodificados.
- CPU do Slint/femtovg-wgpu a 60 Hz: 78–89 % de um núcleo só redesenhando (07). Testar `renderer-skia`, região de redesenho parcial ou vídeo em swap chain/DirectComposition própria sob a UI. Primeira fatia do plano (12), answers 007.
- RAM: meta do toolkit subiu para < 200 MB (answers 007); 76 MB WS só do device wgpu DX12 (07).
- Latência até o vsync/composição (Present a 144 Hz) não medida no 07; só até o submit.
- Áudio no pipeline nativo (Opus, sincronia com vídeo) e voz em mesh com supressão de ruído/eco/PTT (WebRTC APM nativo?).

## Fora de escopo
- Construir o app (o mapa para no plano).
