# PLANO DE EXECUÇÃO — recuperar-conexao

| Campo | Valor |
|---|---|
| **Tarefa** | `recuperar-conexao` |
| **Origem** | Pedido: "Implementa a recuperação do vídeo e da voz quando a conexão vai a failed e valida com NETSIM_ONLY=cut40." |
| **Tipo** | Bug (pendência 2 do handoff) |
| **Modo de execução** | 🔁 Loop (continuação, sem confirmação) |
| **Data** | 2026-10-20 |
| **Branch** | `main` (commits atômicos, sem push) |

## 1. Enunciado Canônico
- **Problema:** com mais de ~30 s sem mídia, o consentimento do ICE expira e a conexão de vídeo e de voz vai a `failed`. Nada refaz a conexão: o espectador fica sem imagem e sem voz até sair e entrar de novo.
- **Resultado esperado:** quando a rede volta, vídeo e voz voltam sozinhos em poucos segundos, sem ação de ninguém.
- **Como validar:** `NETSIM_ONLY=cut40 npm run netsim` mostra "vídeo N ms, voz N ms" no lugar de "não recuperou". O `npm run e2e` continua dando `E2E OK`.

## 2. Escopo
**Vou fazer:**
- **Vídeo (`web/stream.js`):** quando a conexão com um filho vai a `failed`, o pai faz uma oferta nova numa conexão nova. O filho já aceita qualquer oferta (é o mesmo caminho do re-parent).
- **Voz (`web/voice.js`):** quem tem o id menor (quem já faz a oferta) refaz a conexão. O outro lado já troca a conexão ao receber a oferta.
- **Backoff** entre as tentativas, zerado quando a conexão volta.
- **Netsim:** medir a volta da voz, além da do vídeo.

**NÃO vou fazer** [#8]:
- `restartIce()`. Uma conexão nova também renova a alocação no TURN e reaproveita o caminho já testado do re-parent.
- Pedir um novo pai ao servidor. A árvore não mudou; só o caminho de rede caiu.
- Piso de buffer sob jitter (pendência 3).

## 3. Premissas Assumidas
| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | Quem oferece é quem refaz: o pai no vídeo e o id menor na voz | Assim os dois lados nunca oferecem ao mesmo tempo, a mesma regra que já vale para a primeira oferta [#6] | Glare (as duas ofertas se cruzam) → o `nid` e o `drop` já descartam a oferta velha |
| P2 | Backoff de 1, 2, 4 e 5 s (teto) | O prazo de conexão já espaça as tentativas, e um teto curto faz a mídia voltar mais rápido quando a rede volta. *Ajustada na execução: o teto era 10 s* | Ajustar `RECOVER_*` em `stream.js` [#3] |
| P3 | Prazo de 10 s para conectar cada oferta. *Acrescentada na execução* | Com a rede fora, a oferta nova não ganha candidato via TURN e fica em `new` para sempre: nunca chega a `failed` (medido com `cut90`) | Rede lenta que leve mais de 10 s para conectar → tenta de novo |

## 4. Decisão Visual
- Sem superfície visual. O app já mostra a conexão caindo e voltando pelo vídeo e pelo log.

## 5. Passos Atômicos
| # | Arquivo | Mudança | Prática | Verificação |
|---|---|---|---|---|
| 1 | `web/stream.js`, `web/voice.js`, `web/sw.js` | `recover()` com backoff, `connectDeadline()`, e o timer ignora a conexão que voltou sozinha | [#2][#3][#6][#9] | netsim `cut40` e `cut90` |
| 2 | `e2e/netsim.js` | Mede a volta da voz, conta os quadros por conexão e adiciona o cenário `cut90` | [#43] | `NETSIM OK` |
| 3 | README, ENTREGA, handoff | Limitação removida e números medidos | [#96] | leitura |

## 6. Riscos e rollback
- Uma re-oferta derruba uma conexão que ia voltar sozinha → o timer confere `connectionState` antes de refazer.
- Um relay que recebe uma oferta nova re-oferece aos filhos (comportamento de re-parent), o que dá um corte curto neles.
- `git revert` por commit [#84].

## 7. Definição de Pronto
- `cut40` e `cut90` recuperam vídeo e voz.
- `npm test`, `npm run e2e` e o `npm run netsim` completo verdes.
