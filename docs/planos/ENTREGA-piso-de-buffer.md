# ENTREGA-piso-de-buffer

Modo: 🔁 Loop. Plano: `PLANO-piso-de-buffer.md`. Data: 2026-10-21.

## Resultado: o piso foi implementado, medido e **rejeitado**
O piso proporcional ao jitter não melhorou o cenário `bad` em nenhuma medição limpa, e piorou na única comparação feita com a máquina limpa. Por isso não entrou no `main`.

O código está completo e testado no branch local `experimento/piso-de-buffer` (commit `7278541`, sem push), caso alguém queira retomar.

## O que foi feito
| Onde | O quê |
|---|---|
| `experimento/piso-de-buffer` | O espectador envia o jitter RTP (RFC 3550) do vídeo junto do RTT. O servidor aplica `buffer = max(3 × jitter, alvo − chegada)`, com teto de 300 ms. Inclui 4 testes unitários (41/41). |
| `main`: `test(rede)` ×2 | O netsim ganhou: `NETSIM_MEASURE_MS` (janela configurável), as colunas `jitter RTP ms`, `alvo ms` e `atraso do proxy p99 ms`, e os cenários `jitter50` (150 ± 50 ms, sem perda) e `loss2rtt300` (150 ms + 2%, sem variação). |
| `main`: `docs` | README, este arquivo, o plano e o handoff. |

## Medido (`bad`: 150 ± 50 ms + 2% de perda, 720p30, janelas de 60 s)
### 1ª bateria: variantes em sequência, 4 rodadas cada
| Variante | Congelamentos por rodada | fps | kbps | Buffer real | Latência |
|---|---|---|---|---|---|
| Sem piso (o `main`) | 0, 1, 1, 1 | 29–30 | 228–677 | 68–257 ms | 196–428 ms |
| Piso 3 × jitter | 2, 18, 7, 0 | 18–30 | 65–307 | 219–283 ms | 426–532 ms |
| Piso fixo de 100 ms | 7, 3, 6, 1 | 22–28 | 59–223 | 234–280 ms | 422–472 ms |

Depois dessa bateria, a máquina mostrou carga intermitente (Hydra, `remoting_host`, Wallpaper Engine). Com as variantes rodando em horários diferentes, a comparação podia estar enviesada. Daí a 2ª bateria.

### 2ª bateria: sem piso e com piso alternados, 3 pares, cada rodada com `base` de controle
| Par | Controle `base` (sem falha) | Sem piso | Piso 3 × jitter |
|---|---|---|---|
| 1 | ❌ contaminado nos dois (3 e 28 congelamentos) | 17 congel., 21 fps, 448 ms | 24 congel., 18 fps, 493 ms |
| **2** | ✅ **limpo nos dois** | **3 congel. (0,7 s), 30 fps, 215 ms** | **7 congel. (2,3 s), 28 fps, 319 ms** |
| 3 | ❌ contaminado nos dois (11 e 5 congelamentos) | 17 congel., 28 fps, 283 ms | 6 congel., 28 fps, 211 ms |

**Leitura:**
- No único par com a máquina limpa, o piso dobrou os congelamentos e somou ~100 ms de latência.
- Nos pares contaminados, o resultado vai para os dois lados, ou seja, é ruído.
- Em nenhuma medição limpa o piso ajudou.

## Achados
1. **A premissa da pendência 3 não se sustentou.** O handoff dizia que o buffer caía para 56–85 ms e que isso causava congelamentos. Isso vinha de janelas de 10 s. O `jitterBufferTarget` é só um mínimo: o estimador do WebRTC continua somando o que mede, e sem piso o buffer real sobe sozinho até ~260 ms. Um piso por cima disso só acrescenta atraso.
2. **10 s não bastam para medir congelamentos.** Em 10 s, as variantes trocavam de posição entre rodadas. Daí o `NETSIM_MEASURE_MS`.
3. **A carga da máquina contamina o netsim, e o `base` é o controle que detecta isso.** Com a máquina ocupada, o `base` (sem falha simulada) mostrou até 28 congelamentos, jitter RTP de 75 ms e RTT de 118 ms. Também apareceu um RTT de 306 ms num cenário de 50 ms.
   - A coluna `atraso do proxy p99 ms` (event loop do netsim) ficou em 12–17 ms nessas rodadas, então ela **não** detecta esse tipo de contaminação. O atraso vem de outro ponto: Chrome, TURN ou o agendador do sistema.
   - Regra prática: rode `base` junto e descarte a rodada se o `base` não sair com jitter RTP perto de 0 e sem congelamentos.
4. **Em 60 s, o problema mais visível do `bad` é o bitrate.** O envio cai para ~150–820 kbps em 720p30, com ou sem piso. É o controle de congestionamento de quem transmite reagindo à perda e ao atraso variável, do lado do remetente, e não do buffer de quem recebe.
5. **O jitter RTP medido é menor que o teórico:** 19–35 ms para ±50 ms uniforme (teórico ~33 ms), e oscila entre leituras.

## Verificação
- `npm test` no `main`: 37/37. No branch do experimento: 41/41.
- `npm run netsim` completo no `main`: `NETSIM OK` duas vezes. Os números de qualidade dessas rodadas foram contaminados pela carga da máquina (achado 3), então não substituem a tabela de `ENTREGA-instalador-cli-e-rede.md`.
- Os cortes deram os mesmos números de `ENTREGA-recuperar-conexao.md`: 40 s em 5,2 / 4,6 s e 90 s em 2,1 / 2,0 s (vídeo / voz).
- O `npm run e2e` não foi rodado de novo, porque o código web do `main` não mudou desde o último `E2E OK`.

## Premissas
P1–P3 do plano. A P2 (fator 3×) foi testada e descartada, junto com o piso fixo.

## Não feito (e por quê)
- **Piso no `main`:** não melhorou em nenhuma medição limpa e piorou na única comparação limpa [#99].
- **Investigar a queda de bitrate (achado 4):** é outro problema (do lado de quem envia) e não foi pedido.

## Próximos passos
1. Investigar a queda de bitrate sob perda + jitter: olhar a evolução de `targetBitrate` e `qualityLimitationReason` no remetente durante os 60 s, e avaliar baixar a resolução em vez de segurar os fps (hoje `tuneSender` usa `degradationPreference: 'maintain-framerate'`).
2. Medir rede numa máquina sem outros programas pesados abertos, ou repetir até o `base` sair limpo.
3. Publicar o servidor com HTTPS.
