# PLANO DE EXECUÇÃO — bitrate-sob-perda

| Campo | Valor |
|---|---|
| **Tarefa** | `bitrate-sob-perda` |
| **Origem** | Pedido: "Investiga a queda de bitrate sob perda + jitter (targetBitrate, qualityLimitationReason, degradationPreference) e mede com NETSIM_ONLY=base,bad em janelas de 60 s." |
| **Tipo** | Investigação (próximo passo de `ENTREGA-piso-de-buffer.md`) |
| **Modo de execução** | 🔁 Loop (continuação, sem confirmação) |
| **Data** | 2026-10-21 |
| **Branch** | `main` (commits atômicos, sem push); experimentos sem resultado ficam fora do `main` |
| **Resultado** | ✅ **Causa medida: a variação do atraso, não a perda.** O `degradationPreference` fica `maintain-framerate`: `maintain-resolution` caiu para 1–4 fps com conteúdo de jogo, e `balanced` não mostrou vantagem. O app não muda; o netsim ganhou a medição de quem transmite, `badQueue` e `NETSIM_CONTENT=game`. Ver `ENTREGA-bitrate-sob-perda.md` |

## 1. Enunciado Canônico
- **Problema:** no cenário `bad` (150 ± 50 ms + 2% de perda), o vídeo que chega cai de ~4 Mbps para ~150–820 kbps em 720p30. Não se sabe ainda se é a estimativa de banda (BWE) de quem transmite, o encoder ou o simulador.
- **Resultado esperado:** saber a causa com números do lado de quem transmite, e mudar o app só se uma mudança melhorar o que o espectador vê.
- **Como validar:** `NETSIM_MEASURE_MS=60000 NETSIM_ONLY=base,bad npm run netsim`, com o `base` limpo como controle e a comparação intercalada.

## 2. Escopo
**Vou fazer:**
- **Medir o remetente no netsim:** a cada 1 s, ler de quem transmite a BWE (`availableOutgoingBitrate`), o alvo do encoder (`targetBitrate`), o que saiu, a resolução e o `qualityLimitationReason` (com o tempo em cada motivo). Isso vira colunas da tabela e, com `NETSIM_TRACE=1`, uma série por segundo.
- **Separar as causas:** rodar `jitter50` (só variação) e `loss2rtt300` (só perda) junto de `base` e `bad`.
- **Conferir o simulador:** medir a resolução dos timers do proxy e se a variação por pacote reordena demais para ser realista.
- **Comparar `degradationPreference`:** `maintain-framerate` (hoje), `balanced` e `maintain-resolution`, intercalados.
- Aplicar no app só o que a medição sustentar [#99].

**NÃO vou fazer** [#8]:
- Forçar um bitrate mínimo (`x-google-min-bitrate`): o proxy não limita a banda, então não dá para medir o dano numa rede congestionada de verdade.
- Trocar o codec ou mexer em FEC.
- Mudar o cenário `bad` para os números ficarem bonitos: qualquer mudança no simulador precisa vir de um defeito medido nele, e os dois modelos ficam disponíveis.

## 3. Premissas Assumidas
| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | A queda vem da BWE (controle de congestionamento do Chrome), não do encoder | O proxy não limita banda; o que reage a perda e atraso é a BWE | A coluna de alvo do encoder × enviado mostra isso |
| P2 | `degradationPreference` não muda a BWE; muda como o encoder gasta a banda que sobra (resolução ou fps) | É o que a especificação define | A medição mostra |
| P3 | Para jogos, manter os fps continua sendo a preferência do produto (`contentHint = 'motion'`) | Decisão já registrada no código | Trocar só com número melhor para o espectador [#98] |

## 4. Decisão Visual
- Sem superfície visual.

## 5. Passos Atômicos
| # | Arquivo | Mudança | Prática | Verificação |
|---|---|---|---|---|
| 1 | `e2e/netsim.js` | Amostrar o remetente a cada 1 s; colunas de BWE, alvo, motivo do limite e reenvio; `NETSIM_TRACE` | [#43][#91] | `NETSIM_ONLY=base,bad` |
| 2 | `e2e/netsim.js` | Se a medição do timer mostrar defeito no proxy, corrigir a fidelidade (documentado) | [#43] | antes × depois |
| 3 | experimentos | `jitter50`, `loss2rtt300` e as 3 `degradationPreference`, intercalados com `base` | [#99] | tabela |
| 4 | `web/stream.js` (só se a medição sustentar) | Ajuste no `tuneSender` | [#7][#99] | netsim + `npm run e2e` |
| 5 | README, ENTREGA, handoff | Números e conclusão | [#96] | leitura |

## 6. Riscos e rollback
- A carga da máquina contamina os números: o `base` vai junto em cada rodada e a rodada é descartada se ele não sair limpo.
- Mudança no simulador muda a comparação com tabelas antigas: registrar antes × depois na entrega.
- `git revert` por commit [#84].

## 7. Definição de Pronto
- A causa da queda descrita com números do remetente.
- `degradationPreference` decidida com A/B intercalado.
- `npm test`, `npm run netsim` (completo) e, se o app mudar, `npm run e2e` verdes.
