# 09 — Relay recodifica só para o filho com rede ruim

Pergunta: como o relay str0m 0.25 estima a banda de cada filho, quando liga/desliga a recodificação sem congelar a imagem e quanto custa (CPU/GPU, atraso) decodificar e recodificar. Simulcast/SVC entra só como comparação. Meta: < 15 ms por salto.

Base: `e2e/bench/native/src/main.rs` (modo RTP, `write_rtp` com o mesmo `seq_no`/timestamp do pai, PLI ao pai no máximo a cada 500 ms, **sem BWE**: `new_rtc` não chama `enable_bwe`).

Fontes: código do str0m 0.25.0 lido em `~/.cargo/registry/src/*/str0m-0.25.0/` (caminhos abaixo são relativos a essa pasta); IETF draft-ietf-rmcat-gcc-02; Microsoft Learn (H.264 Video Encoder, CODECAPI_AVLowLatencyMode); NVIDIA Video Codec SDK 13.0 Programming Guide e Support Matrix; W3C WebRTC-SVC (WD 14/09/2026); medição própria do ticket 05.

## 1. Estimativa de banda por filho no str0m 0.25

Cada filho já é um `Rtc` próprio, então a estimativa sai por filho sem código extra de rede.

- **Ligar:** `Rtc::builder().enable_bwe(Some(Bitrate::…))`. Sem isso o BWE fica desligado e o pacer é nulo. "This is an estimation of the send bandwidth, not receive." (`src/config.rs:470-476`; `src/session.rs:168-177`).
- **Algoritmo:** GoogCC portado do libwebrtc, baseado em TWCC: controle por atraso (trendline + AIMD), controle por perda, máquina de sondagem (probe) e detector de ALR (`src/bwe/mod.rs:1-13`).
- **Saída:** `Event::EgressBitrateEstimate(BweKind::Twcc { estimate, can_probe })`. Se o filho mandar REMB, chega também `BweKind::Remb { estimate, mid }` (`src/bwe/api.rs:8-37`; `src/session.rs:1018-1080`).
- **TWCC no SDP:** vem por padrão. Todo codec de vídeo nasce com `fb_transport_cc`, `fb_nack`, `fb_pli` e `fb_remb` ligados (`src/format/codec_config.rs:132-134`). A extensão `TransportSequenceNumber` está no conjunto padrão, id 3 (`src/rtp/ext.rs:370-375`). O número TWCC é posto em cada pacote no envio, mesmo em modo RTP (`src/session.rs:1246-1251`; `src/streams/send.rs:714-718`). `can_probe` exige BWE ligado, SRTP pronto e mídia de envio com TWCC negociado (`src/session.rs:1022-1023, 418-441`).
- **Conclusão:** usar TWCC/GCC. Não depender de REMB, porque ele só existe se o navegador filho mandar.
- **Sondagem para subir:** `rtc.bwe().set_bitrate(minimum, desired)`. "`desired` is the bitrate you would like to eventually send at. BWE tries to discover this capacity through probing" (`src/bwe/api.rs:49-92`). Sem isso, um filho em recodificação, mandando menos que a banda real, nunca prova que voltou a aguentar o original. Com `desired` = bitrate do pai, o str0m sonda com padding.
- **Armadilha de latência (pacer):** com BWE ligado, o vídeo passa por um leaky bucket a `estimate × 1,1` (`src/pacer/control.rs:3, 47-51`). Abaixo de ~12,6 Mbps o intervalo de rajada é 40 ms (`src/pacer/leaky.rs:18, 296-298`) e a fila tolera até 2 s (`src/pacer/leaky.rs:168`). Isso pode somar atraso por salto.
  - `StreamTx::set_unpaced(true)` manda a mídia direto ("Unpaced packets … are sent immediately", `src/pacer/leaky.rs:263-273`; `src/streams/send.rs:480-488`). O número TWCC continua sendo posto, então a estimativa continua.
  - Recomendo `set_unpaced(true)` no repasse e medir. O preço é perder a suavização das rajadas de keyframe.

## 2. Como o GCC reage (base da histerese)

Do draft-ietf-rmcat-gcc-02:

- **Queda imediata:** "As soon as over-use has been detected, the available bandwidth estimated by the delay-based controller is decreased." `A_hat = beta·R_hat`, com beta recomendado 0,85 (§5.5). Com perda acima de 10%: `As_hat(i-1)·(1-0,5p)` (§6).
- **Subida lenta:** "During multiplicative increase, the estimate is increased by at most 8% per second" (§5.5). Abaixo de 2% de perda, +5% por resposta (§6). `response_time_ms = 100 + rtt_ms`.
- **Sobreuso:** só é sinalizado após `overuse_time_th` = 10 ms (§5.4).

Consequência: a estimativa cai em ~100–200 ms e leva segundos para subir. A histerese precisa ser assimétrica.

## 3. Ligar e desligar sem congelar

Regra proposta (números iniciais, calibrar em bancada com perda/atraso simulados; nada disso foi medido):

| Transição | Condição | Ação |
|---|---|---|
| Repasse → recodifica | `estimate < 0,9 × bitrate_entrada` por ≥ 1 s, ou perda > 10% num relatório | escolhe o degrau (ex.: 720p/540p/360p) cujo bitrate cabe em ~0,8 × estimate |
| Recodifica → repasse | `estimate ≥ 1,25 × bitrate_entrada` por ≥ 10 s, com `set_bitrate(.., desired = bitrate_entrada)` sondando | troca no próximo keyframe do pai |
| Qualquer troca | tempo mínimo no estado: 10 s | evita oscilação |
| Dentro da recodificação | bitrate do encoder segue `0,8 × estimate` | `CODECAPI_AVEncCommonMeanBitRate` muda durante a codificação no Windows 8+: "you can set the average bit rate during encoding" (MS Learn, H.264 Video Encoder) |

Troca sem congelar (faz e depois troca; nunca corta antes):

1. **Ao ligar:** o decoder do relay precisa partir de um IDR do pai. Pede PLI ao pai. Enquanto isso continua o repasse. Só passa a mandar o fluxo recodificado quando o encoder entrega o primeiro IDR, e a troca é feita na fronteira de quadro (marker).
2. **Ao desligar:** pede PLI ao pai. Continua mandando o recodificado até chegar o keyframe do pai (`detect_h264_keyframe`, público em `src/packet/mod.rs:25`). Troca exatamente nesse quadro.
3. **Numeração contínua por filho:** hoje o relay copia o `seq_no` do pai. Com troca de fonte, cada filho precisa de um contador próprio de seq (`SeqNo` estendido) e de um timestamp contínuo (offset). Senão o NACK e o jitter buffer do filho quebram. O SSRC do `StreamTx` continua o mesmo.
4. **Mudança de resolução:** o novo IDR traz SPS/PPS com outro tamanho. É o mesmo mecanismo que os SFUs usam ao trocar de camada de simulcast. Testar no Edge.
5. **PLI do filho em recodificação:** vai para o encoder local (`CODECAPI_AVEncVideoForceKeyFrame`, já usado em `presenter.rs:282`), não para o pai. Isso poupa a árvore toda.

O GOP de 10 s do transmissor (`presenter.rs:209`) não atrasa a troca, porque toda troca pede PLI. Mas cada PLI gera um keyframe grande para todos os irmãos em repasse. Daí o limite de 500 ms, que deve ficar.

## 4. Custo de decode + encode e atraso extra

**Desenho de menor custo:**

- **1 decoder por relay**, compartilhado. Ele só liga quando algum filho precisa.
- **1 encoder por degrau de resolução**, compartilhado por todos os filhos naquele degrau. Ele não é por filho.
- O caminho na GPU é o mesmo do 08 (decoder MF com D3D11) e do presenter: escala com `VideoProcessorBlt`, NV12 → encoder MF. Sem passar pela CPU.
- Empacotamento: `H264Depacketizer`/`H264Packetizer` são públicos no str0m (`src/packet/mod.rs:24`).

**Números que existem (ticket 05, 1080p60, NVENC):** conversão 0,6 ms e codificação 4,6 ms por quadro. Repasse puro: ~2–7 ms por salto.

**Números que não existem:** decode na GPU, escala, nem o conjunto. Não foram medidos.

**Soma estimada por salto recodificado** (precisa de medição; não é dado):

- remontar o quadro inteiro: o repasse manda pacote a pacote, a recodificação espera o marker;
- decode;
- escala ~0,6 ms;
- encode em resolução menor, ≤ 4,6 ms;
- empacotar;
- tudo somado ao repasse atual.

Leitura plausível: 8–14 ms, encostando na meta de 15 ms. Por isso o modo de baixa latência é obrigatório:

- `CODECAPI_AVLowLatencyMode`: "one input sample shall produce one output sample". No decoder MF H.264 ele é `VT_UI4`; nos demais, `VT_BOOL` (MS Learn).
- Sem B-frames.

**Limites de hardware:**

- GeForce aceita **12 sessões NVENC simultâneas**; as placas profissionais vão de 8 a sem limite. Para NVDEC a matriz não publica limite (NVIDIA Support Matrix). Encoder por degrau mantém isso longe do teto.
- O fallback por software (MS H.264 encoder MFT) gasta CPU. O VP8 por software do Edge saturou a CPU no 05. O fallback deve ter só 1 degrau baixo (ex.: 360p).
- Trocar a resolução no mesmo encoder: o NVENC aceita `Reconfigure` se `maxEncodeWidth/Height` foram definidos na criação, e recomenda `forceIDR` (NVIDIA guide §8.4). A doc MF não descreve troca de tamanho em uso. Por isso: **degraus fixos, um encoder por degrau**, e só o bitrate muda dinamicamente.

## 5. Comparação: simulcast / SVC

- **SVC espacial:** só VP9/AV1. "VP8, H.264, and H.265 only support temporal scalability (e.g. "L1T2", "L1T3")" (W3C WebRTC-SVC, Working Draft 14/09/2026). Fora do caminho H.264 atual.
- **Simulcast:** o transmissor codifica 2–3 resoluções. O str0m envia simulcast (CHANGELOG 0.25: "Support sending simulcast" #603), e o relay só escolhe a camada por filho no keyframe. Custo zero no relay e sem atraso extra. Os custos são:
  - upload maior do transmissor;
  - todos os relays recebem todas as camadas;
  - contraria a decisão de resolução independente por espectador com repasse intacto.
- **Temporal L1T3 em H.264 (opção intermediária):** o relay descarta a camada temporal superior (60 → 30 → 15 fps) sem decodificar e sem esperar keyframe. Corta banda sem atraso extra. Depende de o encoder suportar `CODECAPI_AVEncVideoTemporalLayerCount`, que é opcional na certificação HCK (MS Learn). Verificar no NVIDIA MFT.

## Recomendação

1. Ligar `enable_bwe` em cada filho, com `set_unpaced(true)` no repasse e `set_bitrate(min, desired = bitrate do pai)`. Usar `BweKind::Twcc` como sinal. Medir primeiro, em bancada com perda/atraso simulados, se só o BWE já soma atraso.
2. Recodificação com **decoder compartilhado + encoder por degrau fixo**, histerese assimétrica (cai em ~1 s, volta após ≥ 10 s estáveis, permanência mínima de 10 s), troca sempre num IDR, seq/timestamp reescritos por filho, e PLI do filho recodificado indo para o encoder local.
3. Antes de construir, medir decode+escala+encode na bancada 05 para confirmar < 15 ms por salto. Se estourar, olhar o descarte temporal (L1T3) como alternativa barata.
