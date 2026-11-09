# 16 — Perfis H.264 aceitos por Safari, Firefox, Chrome/Edge e PWA iOS

Ticket: [`../16-perfis-h264-navegadores.md`](../16-perfis-h264-navegadores.md). Data: 2026-11-08.
Fontes: código em `main` de WebKit, mozilla-firefox/firefox, webrtc.googlesource.com e chromium.googlesource.com, lido em 2026-11-08. Nada foi testado em dispositivo.

## Resposta

**Oferecer `profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1` é seguro nos quatro navegadores, para enviar e para receber.** É a única combinação que os quatro anunciam explicitamente. Também é o mínimo obrigatório da RFC 7742.

Observações:
- Manter também `42e01f` com `packetization-mode=0` na oferta não custa nada. Os quatro também anunciam essa variante, mas o Firefox só a **envia** se houver OpenH264 (GMP) instalado.
- O nível 1f (3.1) não limita a resolução enviada. Todos anunciam `level-asymmetry-allowed=1`, então cada lado envia no nível do próprio decoder. Para enviar 1080p60 a um navegador, ele precisa anunciar um nível de recepção maior. Os valores fixos do WebKit e do Firefox são 3.1. Isso **não foi verificado na prática**: falta testar 1080p60 com 42e01f contra o Safari e o Firefox.
- Constrained High (`640c1f`) só é anunciado pelo Safari. No Chrome/Edge depende da GPU, e o Firefox não o anuncia. Não usar como único perfil.

## Matriz (pt = packetization-mode)

| Navegador | Anuncia (recebe e envia) | Fonte |
|---|---|---|
| Safari macOS / iOS / PWA iOS (WebKit) | `640c1f` pt1, `42e01f` pt1, `640c1f` pt0, `42e01f` pt0, com `level-asymmetry-allowed=1` | WebKit: os codificadores e decodificadores usam as mesmas quatro entradas |
| Firefox | `42e01f` pt1 (PT 126), `42e01f` pt0 (PT 97), `42001f` pt1 e pt0 (Baseline, desligável por preferência) | Gecko JSEP |
| Chrome / Edge (libwebrtc software) | `42001f`, `42e01f`, `4d001f`, nos modos pt1 e pt0. O decoder também anuncia `f4001f` (High 4:4:4). A GPU pode acrescentar High e outros níveis. | libwebrtc `h264.cc`, Blink |

### WebKit (Safari, iOS, PWA)
- `RTCDefaultVideoEncoderFactory.m:55-75` e `RTCDefaultVideoDecoderFactory.m:50-68` listam os mesmos quatro formatos: ConstrainedHigh/ConstrainedBaseline × pt 1/0, todos com `level-asymmetry-allowed=1`.
- `RTCH264ProfileLevelId.mm:35-39`: em `WEBRTC_WEBKIT_BUILD`, o perfil é fixo em `640c1f` / `42e01f`. Assim, a consulta ao `UIDevice` do libwebrtc genérico não vale para o Safari.
- `WebKitEncoder.mm:243-247` e `WebKitDecoder.mm:278-282`: as fábricas do WebKit usam essas classes padrão, inclusive no iOS.
- `WebKitEncoder.mm:358-359`: o encoder do WebKit marca a saída H.264 como `NonInterleaved`, ou seja, pt 1.
- PWA iOS: usa o mesmo motor WebKit (toda engine no iOS é WebKit). **Não foi achada** fonte que diferencie o PWA. Inferência, não testada.
- Caminho: `Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/{objc/components/video_codec,WebKit}/`.

### Firefox
- `dom/media/webrtc/jsep/JsepCodecDescription.h:670-699`:
  - `CreateDefaultH264_0` usa `0x42E01F`, pt 0, e fica **somente recv** se `!SendingH264PacketizationModeZeroSupported()`.
  - `CreateDefaultH264_1` usa `0x42E01F`, pt 1.
- `:701-730`: as variantes Baseline usam `0x42001F`.
- `:654-664`: para Constrained Baseline, o nível vem da preferência `media.navigator.video.h264.level`. O padrão é 31 (`StaticPrefList.yaml:14472-14475`, comentário "0x42E0[1f] - level 3.1").
- `dom/media/webrtc/jsapi/DefaultCodecPreferences.cpp`:
  - `:23-42`: H.264 fica ativo se houver OpenH264 (GMP) **ou** H.264 por hardware com `media.webrtc.hw.h264.enabled`.
  - `:46-48`: o envio em pt 0 exige o GMP.
  - `:124-129`: ordem de oferta 126 (pt1), 97 (pt0), Baseline pt1 e Baseline pt0.
- `JsepCodecDescription.h:1400-1413` (`ParametersMatch`): o pt precisa ser igual e o *subprofile* também (CB ≠ Baseline). Por isso uma oferta nativa só com `42001f` não casa com o codec `42e01f` do Firefox, e casa apenas com as entradas Baseline.

### Chrome / Edge
- `modules/video_coding/codecs/h264/h264.cc:85-109`: `SupportedH264Codecs` lista Baseline, ConstrainedBaseline e Main no nível 3.1, com pt 1 e 0. O comentário diz: "We only support encoding Constrained Baseline Profile". A pt 0 é obrigatória e a pt 1 é preferida.
- `:112-126`: o decoder acrescenta PredictiveHigh444.
- `:46-52`: tudo depende de `WEBRTC_USE_H264`, que o Chrome liga.
- `media/base/codec_comparators.cc:57,100-101`: o casamento de H.264 exige o mesmo profile **e** a mesma pt. Sem o parâmetro, a pt vale 0.
- `media/base/sdp_video_format_utils.cc:129-170`: com assimetria permitida nos dois lados, a resposta usa o nível **local**.
- Blink `rtc_video_encoder_factory.cc:110-145` e `rtc_video_decoder_factory.cc:120-150`: os perfis por hardware são somados conforme a GPU. O decoder declara pt 0 e 1 (`:305`).
- Edge: é Chromium, mas **não foi lida** fonte específica do Edge. Pressupõe-se igual ao Chrome.

### Norma
- RFC 7742 §5: navegadores MUST implementar VP8 e H.264 Constrained Baseline.
- RFC 7742 §6.2: MUST suportar CB Level 1.2, SHOULD Constrained High 1.3, pt 1 é MUST e `profile-level-id` é MUST no SDP.

## Implicações para o nativo (str0m)
- O str0m `enable_h264` já registra 42001f, 42e01f, 4d001f e 64001f com pt 0 e 1 (`research/11-interop.md`). O bench usa 42e01f, que casa com os quatro navegadores.
- O encoder MF do nativo precisa emitir um bitstream **Constrained Baseline** de fato (sem B-frames e sem CABAC) quando o perfil negociado for 42e0xx. Enviar High dentro de 42e01f pode falhar no decoder do Firefox via OpenH264. Isso é inferência, não testada.
- Se quiser High no Safari/Chrome, ofereça `640c1f` **além** de 42e01f, nunca no lugar.

## Lacunas
1. Nenhum teste real: 42e01f nativo contra o Safari iOS (PWA), contra o Firefox sem GMP baixado e contra o Edge.
2. O nível efetivo de recepção do Safari/Firefox para 1080p60 (o 3.1 nominal limita a 720p30 pela norma) e se o decoder rejeita fluxo acima do nível. Não verificado.
3. Firefox em Windows sem OpenH264 e sem H.264 por hardware ligado: o H.264 some da oferta. A frequência disso não foi medida.

## Fontes
- WebKit `webkit_sdk/objc/components/video_codec/RTCDefaultVideoEncoderFactory.m`, `RTCDefaultVideoDecoderFactory.m`, `RTCH264ProfileLevelId.mm`; `webkit_sdk/WebKit/WebKitEncoder.mm`, `WebKitDecoder.mm` — https://github.com/WebKit/WebKit/tree/main/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk
- Firefox `dom/media/webrtc/jsep/JsepCodecDescription.h`, `dom/media/webrtc/jsapi/DefaultCodecPreferences.cpp`, `modules/libpref/init/StaticPrefList.yaml` — https://github.com/mozilla-firefox/firefox
- libwebrtc `modules/video_coding/codecs/h264/h264.cc`, `media/base/codec_comparators.cc`, `media/base/sdp_video_format_utils.cc`, `api/video_codecs/h264_profile_level_id.cc` — https://webrtc.googlesource.com/src/
- Chromium `third_party/blink/renderer/platform/peerconnection/rtc_video_{encoder,decoder}_factory.cc` — https://chromium.googlesource.com/chromium/src/
- RFC 7742 — https://www.rfc-editor.org/rfc/rfc7742.html
