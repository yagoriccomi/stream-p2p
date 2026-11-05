---
Type: research
Status: resolved
Blocked by: none
---

# Relay repassando quadros codificados (WebRTC Encoded Transform)

## Pergunta
O relay no navegador consegue repassar o vídeo sem decodificar e recodificar, e quanto isso economiza?

## Answer
**Sim, é viável e é a frente de maior ganho para a latência por salto.** Medição fica para a PoC (ticket 05).

1. **Hoje:** o relay faz `sender.replaceTrack(trackRecebida)` (`web/stream.js:148`). No Chromium isso passa o vídeo por decodificador + codificador em cada salto: soma tempo de codificação, buffer de decodificação e jitter buffer, e ocupa RAM/GPU com quadros crus.
2. **API:** `RTCRtpScriptTransform` é *Baseline 2025* (MDN: funciona nos navegadores atuais desde out/2025). Roda num Worker. No receptor, o transform lê `RTCEncodedVideoFrame`; no sender do filho, outro transform descarta o quadro do codificador local e escreve o quadro recebido.
3. **Pedidos de keyframe:** `RTCRtpScriptTransformer.sendKeyFrameRequest()` (lado receptor) pede keyframe ao pai; `generateKeyFrame()` (lado envio) não serve no relay, porque o codificador local não é a origem. Fluxo proposto: filho novo/perda → relay usa o **cache do último keyframe** (sugestão 4 do handoff) e, se não tiver, chama `sendKeyFrameRequest()` para subir na árvore, com limitação (1 pedido a cada ~500 ms) para evitar tempestade.
4. **Limitações a medir na PoC:**
   - O sender ainda precisa de uma faixa associada; usar uma faixa leve (canvas 2×2 parado) para o codificador local quase não gastar.
   - **Sem adaptação de bitrate por filho**: todos recebem o bitrate do pai. Filho com rede ruim não consegue degradar sozinho. Mitigação: simulcast no transmissor e o relay escolhe a camada por filho (escopo de ticket futuro).
   - Metadados (SSRC, payload type) precisam bater entre as conexões: negociar o mesmo codec em ambas (forçar via `setCodecPreferences`).
   - Safari/iOS como relay: suportado pela API, mas validar na PoC; se falhar, cair no `replaceTrack` atual (detecção por `'RTCRtpScriptTransform' in window`).
5. **Compatibilidade:** muda só o nó relay; quem só assiste continua com WebRTC padrão. Web/PWA intacta.

## Fontes
- MDN `RTCRtpScriptTransform`, `RTCRtpScriptTransformer`, guia *Using Encoded Transforms* (lidos em 2026-11-05).
