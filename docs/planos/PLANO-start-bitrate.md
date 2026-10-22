# PLANO DE EXECUÇÃO — start-bitrate

| Campo | Valor |
|---|---|
| **Tarefa** | `start-bitrate` |
| **Origem** | Pedido: "Implementa o x-google-start-bitrate a partir do upload medido e mede com a linha início da transmissão." |
| **Tipo** | Melhoria (próximo passo de `ENTREGA-bitrate-sob-perda.md`) |
| **Modo de execução** | 🔁 Loop (continuação, sem confirmação) |
| **Data** | 2026-10-21 |
| **Branch** | `main` (commits atômicos, sem push); se não melhorar, o código fica num branch local |
| **Resultado** | Feito. Valor ajustado pelo A/B para metade do modo (no máximo upload × 0,8): resolução cheia em 3–4 s em vez de 10–16 s. Ver `ENTREGA-start-bitrate.md` |

## 1. Enunciado Canônico
- **Problema:** toda transmissão começa em 180–360p e leva 13–16 s para chegar a 720p, porque o Chrome parte de uma estimativa de banda de ~300 kbps.
- **Resultado esperado:** com o upload medido em T02, o encoder já começa perto da resolução cheia, sem congelar e sem piorar uma rede ruim.
- **Como validar:** linha `início da transmissão` do netsim (resolução inicial, segundos até a cheia, fps, congelamentos), A/B intercalado com e sem, nos conteúdos simples e `game`.

## 2. Escopo
**Vou fazer:**
- **`web/stream.js`:** função pura que põe `x-google-start-bitrate` no `a=fmtp` de cada codec de vídeo (cria o `a=fmtp` quando o codec não tem, como o VP8). Quem transmite aplica na resposta recebida de cada filho direto, antes do `setRemoteDescription`.
- **Valor:** `min(bitrate do modo, upload × 0,8)`. O 0,8 é a mesma folga da cota de envio direto (`server/topology.js`).
- **`web/app.js`:** passar o upload para `video.present`.
- **Testes de unidade** da função (novo `web/stream.test.js` no `npm test`).
- **Netsim:** `NETSIM_START_BITRATE=<kbps>` troca o valor (0 tira o parâmetro: padrão do Chrome) e `NETSIM_START_IN=bad|badQueue` começa a transmissão numa rede ruim, só para o A/B.

**NÃO vou fazer** [#8]:
- Start bitrate nos relays: quem retransmite não mediu o próprio upload.
- `x-google-min-bitrate` ou `max-bitrate`: o teto já vem de `b=AS` e `maxBitrate`.
- Medir o upload de novo antes de cada transmissão.

## 3. Premissas Assumidas
| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | O Chrome lê o `x-google-start-bitrate` do SDP remoto de quem envia | É onde o libwebrtc lê os parâmetros do codec de envio | A linha de início não muda; testar no SDP local |
| P2 | Começar no bitrate do modo não congela uma rede boa | O upload medido diz que cabe | O A/B mostra congelamentos no início |
| P3 | Numa rede pior que o upload medido, o GCC recua em segundos | É o comportamento normal do GCC | Medir `bad` logo depois do início |

## 4. Decisão Visual
- Sem superfície visual.

## 5. Passos Atômicos
| # | Arquivo | Mudança | Prática | Verificação |
|---|---|---|---|---|
| 1 | `web/stream.js`, `web/stream.test.js`, `package.json` | `mungeStartBitrate` + testes | [#2][#41] | `npm test` |
| 2 | `web/stream.js`, `web/app.js`, `web/sw.js` | Quem transmite aplica na resposta de cada filho; upload passado em `present` | [#7] | netsim, linha de início |
| 3 | `e2e/netsim.js` | `NETSIM_START_BITRATE=0` desliga, para o A/B | [#43] | A/B |
| 4 | — | A/B intercalado com e sem, conteúdos simples e `game` | [#99] | tabela |
| 5 | README, ENTREGA, handoff | Números e conclusão | [#96] | leitura |

## 6. Riscos e rollback
- Upload medido maior que o real: o encoder começa alto demais e o GCC recua. É medido no `bad`, logo depois do início.
- SDP malformado quebra a negociação: a função tem testes, e o `npm run e2e` negocia de verdade.
- `git revert` por commit [#84].

## 7. Definição de Pronto
- A linha de início mostra a resolução cheia mais cedo, sem mais congelamentos, nas rodadas limpas.
- `npm test`, `npm run e2e` e `npm run netsim` completo verdes.
