---
Type: research
Status: resolved
Blocked by: none
---

# Biblioteca WebRTC nativa para o app em Rust

## Pergunta
Entre `str0m`, `webrtc-rs` e `libdatachannel`, qual usar no motor de mídia nativo para Windows?

## Answer
**Recomendação: `str0m`.**

| Critério | str0m | webrtc-rs (`webrtc` 0.21) | libdatachannel (via bindings) |
|---|---|---|---|
| Arquitetura | Sans-IO, sem threads internas | Assíncrona (tokio), núcleo Sans-IO `rtc` | C++, threads próprias |
| Repasse de RTP bruto | **Sim, `rtp_mode`** (`Event::RtpPacket`, `write_rtp`, `request_keyframe`) | Sim (track RTP local) | Sim (media tracks) |
| BWE / TWCC | Sim | Parcial (interceptors) | Não embutido |
| Simulcast | Sim | Sim | Limitado |
| Codecs | H264, VP8, VP9, Opus | Amplo | Agnóstico (só empacota) |
| Windows | Testado em x64 e ARM64 MSVC, cripto `wincrypto` | Sim | Sim, exige toolchain C++/OpenSSL |
| Maturidade | Ativo, usado em SFUs em produção | Ativo, 1.0 ainda em andamento | Maduro |

**Por quê:** Sans-IO dá controle total do laço de eventos (menos latência e RAM, sem runtime tokio pesado), o `rtp_mode` é exatamente o repasse sem decodificar exigido pela decisão 5, tem BWE para a ponta do transmissor e compila puro em Rust no Windows (sem dependência C++).

**Riscos:** AV1 não listado (não é exigência hoje); API Sans-IO exige escrever o laço de socket (custo de implementação aceito). Plano B: `webrtc-rs`.

## Fontes
- README github.com/algesten/str0m e github.com/webrtc-rs/webrtc (lidos em 2026-11-05).
