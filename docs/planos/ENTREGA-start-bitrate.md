# ENTREGA — start-bitrate

| Campo | Valor |
|---|---|
| **Tarefa** | `start-bitrate` (plano em `PLANO-start-bitrate.md`) |
| **Data** | 2026-10-21 |
| **Branch** | `main`, sem push |
| **Commits** | `094bd16` feat(video), `3083ae5` test(rede), mais o commit de docs |

## O que mudou
- **`web/stream.js`:**
  - `mungeStartBitrate(sdp, kbps)` põe `x-google-start-bitrate` no `a=fmtp` de cada codec de vídeo. Quando o codec não tem `a=fmtp`, como o VP8, a função cria a linha.
  - Quem transmite aplica o valor na resposta de cada filho direto, antes do `setRemoteDescription`. É do SDP remoto que o libwebrtc lê os parâmetros de envio (premissa P1 confirmada).
  - **Valor:** `min(kbps do modo × 0,5, upload medido × 0,8)`. Sem upload medido, nada muda.
- **`web/app.js`:** passa o upload para `video.present`.
- **`web/sw.js`:** a versão passou para `sp2p-v5`.
- **`web/stream.test.js`:** 5 testes da função. O `npm test` agora também roda `web/*.test.js`.
- **`e2e/netsim.js`:**
  - `NETSIM_START_BITRATE=<kbps>` troca o valor de início. Com `0`, o parâmetro sai e vale o padrão do Chrome.
  - `NETSIM_START_IN=bad|badQueue` começa a transmissão numa rede ruim.
  - A linha de início mostra os dois.
- **Relays não recebem o parâmetro:** não mediram o próprio upload [#8].

## Medições
Linha `início da transmissão` do netsim: 30 s a partir do clique, 3 rodadas por valor, ordem intercalada [#99]. Cada célula diz quanto tempo levou até a resolução cheia, ou em que resolução a imagem terminou, e quantos congelamentos houve por rodada.

### 1º A/B: modo cheio × padrão do Chrome (720p30)
| Rede no início | Conteúdo | Padrão do Chrome | Modo cheio (4000) |
|---|---|---|---|
| limpa | simples | cheia em 13–14 s, 0 congelamentos | cheia em 3–4 s, 0 congelamentos |
| limpa | game | começa em 180p, termina em 540p | começa em 360p, termina em 540p |
| `bad` | simples | 180–270p; 0 / 2 / 1 | 540–720p; 4 / 2 / 5 |
| `bad` | game | 0 / 2 / 6, mín. 2–3 fps | 6 / 4 / 9, mín. 7–10 fps |
| `badQueue` | simples | 4 / 3 / 1 | 9 / 3 / 12 |
| `badQueue` | game | 2 / 3 / 4, 13–15 fps | 2 / 4 / 3, 17–23 fps |

O modo cheio resolve o início numa rede limpa. Quando a rede real é pior que o upload medido, ele congela mais. Isso levou ao 2º A/B.

### 2º A/B: valores de início (720p30, conteúdo simples)
| Rede no início | Padrão | 1000 | **2000 (metade)** | 4000 |
|---|---|---|---|---|
| limpa | cheia em 10–13 s | cheia em 5–6 s | **cheia em 3–4 s** | cheia em 0–4 s |
| limpa: congelamentos | 0 | 0 | **0** | 0 |
| `bad`: congelamentos | 1 / 1 / 1 | 3 / 2 / 0 | **6 / 0 / 0** | 5 / 5 / 3 |
| `bad`: resolução | fica em 270p | 540p ou cheia em 28–30 s | **cheia em 13–18 s ou 540p** | cheia em 20–26 s |
| `badQueue`: congelamentos | 2 / 12 / 13 | 3 / 4 / 3 | **2 / 5 / 9¹** | 4 / 12 / 6 |

¹ Essa rodada começou com a banda ainda se recuperando da rodada anterior.

### 3º A/B: 1080p60 (conteúdo simples)
| Rede no início | Padrão | **4000 (metade)** | 8000 (modo cheio) |
|---|---|---|---|
| limpa | cheia em 13–16 s | **cheia em 3–4 s** | cheia em 2–4 s |
| limpa: congelamentos | 0 | **0** | 0 |
| `bad`: congelamentos | 2 / 2 / 3 (0,7–1,2 s) | **6 / 5 / 6 (1,4–1,6 s)** | 5 / 1 / 1 |
| `bad`: resolução e fps | fica em 180p, mín. 14–27 fps | **fica em 540p, mín. 54 fps** | 540p ou 270p |

## Decisão
**Metade do modo** [#99]:
- **Rede limpa:** dá o mesmo ganho do modo cheio, resolução cheia em 3–4 s em vez de 10–16 s, sem congelar, nos dois modos testados.
- **Rede ruim:** congela menos que o modo cheio em 720p.
- **Custo:** quando a transmissão começa numa rede pior que o upload medido, há mais congelamentos curtos que no padrão do Chrome, uns 1,5 s somados em 30 s. Em troca, a imagem fica em 540p em vez de 180–270p e o fps não despenca.

O 0,8 sobre o upload é a mesma folga que o servidor usa para a cota de envio direto.

## Verificação
- `npm test`: 42/42.
- `npm run e2e`: E2E OK. A negociação real passa com o SDP alterado.
- `npm run netsim` completo: NETSIM OK.
  - A linha de início mostra 2000 kbps e 360p, com resolução cheia em 4 s.
  - Todos os cenários de perda e atraso terminam em 720p, com no máximo 1 congelamento.
  - Os cortes de mídia, a queda do WebSocket e o servidor fora voltam como antes.

## Premissas
- **P1 (o Chrome lê o parâmetro do SDP remoto):** confirmada. Sem o parâmetro, o início leva 14 s; com ele, 3 s.
- **P2 (rede boa não congela):** confirmada. Nenhuma rodada limpa congelou.
- **P3 (o GCC recua numa rede ruim):** recua, mas não sem congelamentos curtos. Por isso o valor ficou em metade do modo.

## Próximos passos
- Se a medição do upload ficar velha (troca de rede), o início pode ficar otimista. Um caminho é medir de novo quando a rede mudar. Ficou fora do escopo [#8].
- Os relays seguem com o padrão do Chrome. Se eles passarem a medir o próprio upload, a mesma função serve.

## Rollback
`git revert 094bd16` [#84].
