# PLANO DE EXECUÇÃO — piso-de-buffer

| Campo | Valor |
|---|---|
| **Tarefa** | `piso-de-buffer` |
| **Origem** | Pedido: "Implementa o piso de buffer proporcional ao jitter e valida com NETSIM_ONLY=bad." |
| **Tipo** | Bug (pendência 3 do handoff) |
| **Modo de execução** | 🔁 Loop (continuação, sem confirmação) |
| **Data** | 2026-10-20 |
| **Branch** | `main` (commits atômicos, sem push) |
| **Resultado** | ❌ **Piso rejeitado pela medição**: não ajudou em nenhuma medição limpa e piorou na comparação intercalada limpa (janelas de 60 s). O código ficou no branch local `experimento/piso-de-buffer`. Ver `ENTREGA-piso-de-buffer.md` |

## 1. Enunciado Canônico
- **Problema:** o buffer de cada espectador é `150 ms − atraso de chegada`, para todos verem o quadro ao mesmo tempo. Com 150 ± 50 ms de atraso, o atraso do salto já passa de 150 ms, e o buffer pedido vai a 0. O navegador fica só com o próprio buffer (~56 ms), que não absorve a variação, e aparecem congelamentos.
- **Resultado esperado:** quem recebe por um caminho com variação alta ganha um buffer mínimo proporcional ao jitter medido e para de congelar. Quem tem rede boa continua igual.
- **Como validar:** `NETSIM_ONLY=bad npm run netsim` com 0 congelamentos e buffer acima do piso. `base` e `jitter20` sem mudança. `npm test` com testes novos e `npm run e2e` verdes.

## 2. Escopo
**Vou fazer:**
- **Cliente (`web/stream.js`, `web/app.js`):** ler o `jitter` (RFC 3550) do vídeo que chega do pai e enviá-lo junto do RTT, no mesmo `hopRtt`, num campo opcional `jitter`. Clientes antigos continuam funcionando.
- **Servidor:**
  - `server/index.js` valida o campo.
  - `server/topology.js` guarda o jitter da aresta e aplica `buffer = max(piso, alvo − chegada)`, com `piso = fator × jitter`, limitado a um teto.
- **Netsim:** coluna com o jitter RTP medido, para escolher o fator com número.

**NÃO vou fazer** [#8]:
- Subir o alvo de todos para manter a sincronia (ver P1).
- Mexer no buffer da voz: é tempo real, e o NetEq do navegador já se adapta.
- Levar o piso dos filhos para a folga do relay (ver P3).

## 3. Premissas Assumidas
| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | Só quem tem o caminho ruim paga a latência extra (fica alguns ms atrás dos outros) | Congelar é muito mais visível que 50–100 ms de dessincronia numa conversa por voz; e um link ruim não deve atrasar todo mundo [#98] | Subir o `TARGET` da sala para o maior `chegada + piso` |
| P2 | Fator inicial de 3× o jitter RFC 3550, com teto de 300 ms; o valor final sai da medição | Para variação uniforme de ±50 ms, o jitter RFC 3550 dá ~33 ms; 3× ≈ 100 ms cobre a faixa | Ajustar `JITTER_FLOOR_FACTOR` [#3][#99] |
| P3 | O piso não entra na folga (`slack`) do relay | KISS [#7]: o filho com rede ruim fica atrasado em vez de adiantar o relay | Somar o piso na folga se isso aparecer em campo |

## 4. Decisão Visual
- Sem superfície visual. A linha de stats já mostra `buffer N ms`, e o valor sobe sozinho.

## 5. Passos Atômicos
| # | Arquivo | Mudança | Prática | Verificação |
|---|---|---|---|---|
| 1 | `server/topology.js`, `server/topology.test.js` | `setHopJitter` + piso em `jitterTargets` | [#2][#3][#41] | `npm test` |
| 2 | `server/index.js` | `hopRtt` aceita `jitter` (validado, 400 se inválido) | [#93] | `npm test` + netsim |
| 3 | `web/stream.js`, `web/app.js`, `web/sw.js` | `stats()` devolve `jitterMs` da chegada; `hopRtt` envia | [#6] | netsim `bad` |
| 4 | `e2e/netsim.js` | Coluna `jitter RTP ms` | [#43] | tabela |
| 5 | README, ENTREGA, handoff | Limitação atualizada e números | [#96] | leitura |

## 6. Riscos e rollback
- Um jitter mal medido infla o buffer → teto de 300 ms e validação no servidor.
- O piso pode aumentar a dessincronia entre espectadores. É medido e documentado (P1).
- `git revert` por commit [#84].

## 7. Definição de Pronto
- `bad` sem congelamentos (ou com menos, se a perda de 2% ainda causar algum), com o número registrado.
- `base`, `loss*`, `delay50` e `jitter20` com o mesmo buffer de antes.
- `npm test`, `npm run e2e` e o netsim completo verdes.
