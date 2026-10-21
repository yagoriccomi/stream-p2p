# ENTREGA-recuperar-conexao

Modo: 🔁 Loop. Plano: `PLANO-recuperar-conexao.md`. Data: 2026-10-20.

## O que mudou
| Commit | Arquivos | O quê |
|---|---|---|
| `fix(rede)` | `web/stream.js`, `web/voice.js`, `web/sw.js` | Quem oferece refaz a conexão quando ela vai a `failed` ou não conecta em 10 s, com backoff de 1, 2, 4 e 5 s. O service worker sobe para `sp2p-v4`. |
| `test(rede)` | `e2e/netsim.js` | O corte mede a volta do vídeo e da voz, e há o cenário `cut90`. |
| `docs` | `README.md`, este arquivo e o plano | Limitação removida e números medidos. |

## Como funciona
- **Vídeo:**
  - O pai observa a conexão com cada filho. Em `failed`, espera o backoff e chama `offerTo`, que cria uma conexão nova (e uma alocação nova no TURN).
  - O filho aceita a oferta pelo mesmo caminho do re-parent.
  - Se o filho é relay, ele re-oferece aos próprios filhos quando a imagem volta.
- **Voz:** o lado de id menor faz `drop` e uma oferta nova. O outro lado troca a conexão ao receber a oferta.
- **Prazo de conexão:**
  - Toda oferta tem 10 s para chegar a `connected`. Sem isso, uma oferta feita com a rede fora fica em `new` para sempre: o TURN não responde, então não há candidato, e sem candidato não há `failed`.
  - O timer não refaz uma conexão que voltou sozinha durante a espera.
- **Backoff:** 1, 2, 4 e 5 s (teto). Zera quando a conexão volta, quando o par sai da sessão ou quando a pessoa sai.

## Achados (medidos)
1. **Uma oferta feita com a rede fora nunca chega a `failed`.** No `cut90`, a primeira tentativa (com a rede ainda fora) ficou parada em `new`, e o vídeo não voltou. Por isso o prazo de 10 s.
2. **O timer pendente derrubava uma conexão que já tinha voltado.** O log do `cut90` mostrou uma re-oferta logo depois do `connected`. Agora o timer confere o estado antes de refazer.
3. **Com teto de 10 s, a voz demorava mais que o vídeo para voltar.** Prazo de 10 s + espera de 10 s davam até ~20 s depois da volta da rede. Com teto de 5 s, a volta medida ficou em 0,7–5,2 s.

## Medido (npm run netsim, 720p30, só TURN)
Tempo entre a rede voltar e o Bruno ter imagem (10 quadros novos) e voz (conexão `connected`):

| Corte | Antes | Vídeo | Voz |
|---|---|---|---|
| 3 s | 0,6–0,7 s | 0,6–0,7 s | imediata (não caiu) |
| 10 s | 0,2 s | 0,2–3,3 s | 0,1 s |
| 40 s | **não voltava** | 1,3–5,2 s | 3,0–4,6 s |
| 90 s | **não voltava** | 0,9–2,1 s | 0,7–1,7 s |

O tempo varia conforme o momento em que a rede volta: durante uma tentativa (volta em ~1 s) ou durante a espera do backoff (até 5 s + ~1 s).

Os demais cenários continuaram iguais na rodada completa:
- perdas de 1, 5 e 10% e atrasos: 30 fps;
- 150 ± 50 ms + 2% de perda: 1 congelamento de 0,3 s;
- WebSocket caído 2 s: vídeo em 2,3 s;
- servidor fora 15 s: vídeo em 3,0 s.

## Verificação
- `NETSIM_ONLY=base,cut40` e `base,cut90,cut40`: recuperam vídeo e voz.
- `npm run netsim` completo: `NETSIM OK`.
- `npm test`: 37/37.
- `npm run e2e`: `E2E OK`, incluindo re-parent e passar a vez.

## Premissas
P1–P3 do plano. P2 (teto do backoff) e P3 (prazo) mudaram na execução, pelos achados 1 e 3.

## Não feito (e por quê)
- **Pedir um novo pai ao servidor quando a conexão falha:** a árvore continua certa, só o caminho de rede caiu. Se o pai sumir de verdade, o servidor já re-pendura os filhos.
- **Piso de buffer sob jitter:** continua como pendência 3.

## Próximos passos
1. Piso de buffer proporcional ao jitter medido; validar com `NETSIM_ONLY=bad`.
2. Publicar o servidor com HTTPS e instalar com `/SERVER=https://…`.
