# ENTREGA-bitrate-sob-perda

Modo: 🔁 Loop. Plano: `PLANO-bitrate-sob-perda.md`. Data: 2026-10-21.

## Resultado
- **Causa medida:** o envio cai pela **variação do atraso**, não pela perda.
  - Com só 2% de perda, a banda estimada volta a ~5 Mbps.
  - Com variação, o controle de congestionamento de quem transmite (GCC) recua para ~1 Mbps, porque reordena e pede reenvio à toa, ou para ~100–300 kbps, porque lê a variação como fila enchendo.
- **`degradationPreference`:** fica `maintain-framerate`. O app não muda [#99][#98].
  - `maintain-resolution` venceu com a tela lisa, mas com conteúdo de jogo caiu para **1–4 fps com 0,9–2,1 s de latência** em todas as rodadas válidas.
  - `balanced` não mostrou vantagem medida.
- **Netsim:** agora mede quem transmite e o início da transmissão. Também ganhou:
  - timers de 1 ms no Windows;
  - variação em fila (`badQueue`);
  - conteúdo pesado (`NETSIM_CONTENT=game`);
  - o knob `NETSIM_DEGRADATION` para repetir o A/B.

## Medido: o que derruba a banda (720p30, janelas de 60 s, remetente amostrado a cada 1 s)
Referência: com a rede limpa, o conteúdo de teste (tela animada simples) só precisa de ~1,2 Mbps em 720p30. O teto de 4 Mbps nunca é usado, então "cair de 4 Mbps" não era a comparação certa.

### Rodada 2 (timers de 1 ms, modelo padrão de variação)
| Cenário | BWE | Alvo do encoder | Recebido | Reenvio | Resolução | Limitado por banda | Congelamentos |
|---|---|---|---|---|---|---|---|
| `base` | 5,5 Mbps | 4,0 Mbps | 1,19 Mbps | 0% | 720p | 12% (fim da rampa) | 0 |
| `bad` (150 ± 50 ms + 2%) | 943 kbps | 460 kbps | 884 kbps | **29,6%** | 720p | 0% | 8 |
| `jitter50` (só variação) | 1,42 Mbps | 629 kbps | 1,20 Mbps | **30,6%** | 720p | 0% | 0 |
| `loss2rtt300` (só perda) | 4,8 Mbps | 3,1 Mbps | 2,14 Mbps | 1,2% | 720p | 0% | 2 |

### Rodada 3 (variação em fila, sem reordenar)
| Cenário | BWE | Alvo do encoder | Recebido | Reenvio | Resolução | Limitado por banda | Congelamentos | Latência |
|---|---|---|---|---|---|---|---|---|
| `bad` em fila | 123 kbps | 48 kbps | 114 kbps | 1,7% | 180p, 20 fps | 91% | 8 | 423 ms |
| `jitter50` em fila | 172 kbps | 100 kbps | 92 kbps | 0% | 180p, 18 fps | 100% | 14 | 720 ms |

### A/B do `degradationPreference`, conteúdo simples (3 rodadas intercaladas por preferência)
Cada célula é a faixa das 3 rodadas. O `base` saiu limpo (30 fps, ~1,3 Mbps, 0 congelamentos) em 8 das 9 rodadas. A exceção foi a 1ª do `maintain-framerate`: 24 fps e 3 congelamentos, com a rede limpa, ou seja, ruído da máquina.

| Preferência | Início (rede limpa) | `bad` (variação padrão) | `badQueue` (variação em fila) |
|---|---|---|---|
| `maintain-framerate` (hoje) | 360p → 720p em 13–16 s | 720p, 25–30 fps, 630–951 kbps, 3–5 congel. | 180p, 16–21 fps, 71–125 kbps, 7–9 congel., 379–436 ms |
| `balanced` | 360p → 720p em 13–15 s | 270–720p, 14–30 fps, 273–985 kbps, 3–5 congel. | 270p, 11–15 fps, 136–226 kbps, 3–10 congel., 300–432 ms |
| `maintain-resolution` | **720p desde o 1º segundo** | 720p, 14–30 fps, 243–990 kbps, 1–5 congel. | 720p, **7–14 fps**, 108–203 kbps, 0–9 congel., 351–552 ms |

Leitura:
- No `bad` padrão as três empatam dentro do ruído, como o achado 3 previa: o encoder quase não fica limitado por banda ali.
- No `badQueue`, cada uma troca uma coisa por outra. O `maintain-framerate` segura mais fps (16–21) em 180p. O `maintain-resolution` segura 720p, mas cai para 7–14 fps. O contador de congelamentos não vê isso: 7 fps contínuos não contam como congelamento.
- Viés: essa tela é lisa e se comprime a ~1,2 Mbps, então 720p "cabe" em 200 kbps com pouca perda visível. Num jogo isso não vale. Por isso o A/B foi repetido com conteúdo pesado (abaixo).

### A/B do `degradationPreference`, conteúdo pesado (`NETSIM_CONTENT=game`)
O conteúdo pesado é uma textura detalhada em pan, como a câmera de um jogo, com luz mudando a cada quadro e partículas. Nele, o encoder bate no teto de 4 Mbps mesmo com a rede limpa.

Foram 3 rodadas por preferência, intercaladas e com a ordem girando a cada rodada. Três rodadas foram descartadas porque o `base` saiu sujo (1,7–4,4% de perda RTP e 13–32 congelamentos com a rede limpa): `balanced` 2 e 3, e `maintain-framerate` 3. Sobraram 2 rodadas do `maintain-framerate`, 1 do `balanced` e 3 do `maintain-resolution`.

| Preferência | Início e `base` (rede limpa) | `bad` (variação padrão) | `badQueue` (variação em fila) |
|---|---|---|---|
| `maintain-framerate` (hoje) | começa em 180–360p e fica em 360–540p; 30 fps, QP 46–67 | **30 fps**, 180p, ~1,1 Mbps, QP 89–92, 7–11 congel., ~205 ms | 8–13 fps, 180p, 126–197 kbps, 1–4 congel., 270–395 ms |
| `balanced` | começa em 180p e fica em 540p; 30 fps, QP 67 | 25 fps, 360p, 2,4 Mbps, QP 93, 5 congel., 248 ms | 9 fps, 180p, 325 kbps, 3 congel., 388 ms |
| `maintain-resolution` | 720p desde o início; 30 fps, QP 82 | **1–2 fps**, 720p, ~1 Mbps, QP 106, 5–9 congel., **860–1.480 ms** | **1–4 fps**, 720p, QP 106, 0–3 congel., **960–2.115 ms** |

Leitura:
- **`maintain-resolution` quebra com conteúdo de jogo.** O QP fica no teto (106): o encoder não consegue comprimir mais e passa a descartar quadros. Os quadros que sobram se acumulam, e a latência chega a 2 s. Com 1–4 fps, o contador de congelamentos subestima o dano. Rejeitado.
- **`maintain-framerate` faz o que promete:** 30 fps no `bad`, pagando com resolução (180p). Para jogos, essa é a troca certa (P3).
- **`balanced`:** a única rodada válida ficou entre os dois (25 fps em 360p, 5 congelamentos). Uma rodada não basta para trocar a preferência do produto.
- Na rede limpa, com esse conteúdo, nem o `maintain-framerate` chega a 720p: o teto de 4 Mbps não basta para 720p30 com partículas aleatórias. É um conteúdo extremo de propósito, então isso não vira mudança no modo de qualidade.

## Achados
1. **A perda de 2% não é o problema.** Sozinha (`loss2rtt300`), a banda estimada volta a ~5 Mbps em ~40 s, e só ~1% do que sai é reenvio.
2. **A variação é que derruba a banda, e de dois jeitos diferentes, conforme o modelo:**
   - **Pacotes reordenados (modelo padrão):** cada pacote sorteia o próprio atraso, então pacotes enviados a 2,5 ms de distância chegam até 100 ms trocados. O receptor pede de novo os que "faltam" (1.300–1.600 NACKs por minuto sem nenhuma perda), e 30% do que sai é reenvio inútil. A banda estimada fica presa em ~1 Mbps, e o encoder recebe menos da metade dela.
   - **Atraso em fila (sem reordenar):** o atraso que sobe e desce 100 ms em 200 ms é o sinal que o controle de congestionamento do Chrome (GCC) usa para "a fila está enchendo". Ele recua até ~100 kbps, e o vídeo cai para 180p, 13–20 fps, com 400–700 ms de latência.
   - Os dois são extremos: caminhos reais quase não reordenam, e uma fila que oscila desse jeito é congestionamento pesado. O app não controla o GCC; o que ele controla é como o encoder gasta a banda que sobra.
3. **`qualityLimitationReason` mostra quando o `degradationPreference` importa.** No `bad` padrão, o motivo fica em `none` o tempo todo: o encoder mantém 720p30 e só aumenta a compressão de cada quadro, então a preferência não age. Ela age no `bad` em fila (91–100% limitado por banda) e no início da transmissão.
4. **O início da transmissão tem uma rampa.** Mesmo com a rede limpa, o encoder começa em 270p (pela estimativa inicial de banda do Chrome, ~300 kbps) e sobe 270p → 360p → 540p → 720p em 8–15 s. Na 1ª rodada, cada troca derrubou o envio para 5 fps por 1–2 s. Antes, essa rampa caía dentro da janela do `base`; agora ela é medida à parte.
5. **O proxy do netsim arredondava todo atraso para 15,6 ms.** No Windows, os timers do Node só disparam a cada 15,6 ms (`setTimeout(3)` levava 15,5 ms). Com `timeBeginPeriod(1)` caem para ~1 ms. Os números do `bad` quase não mudaram (BWE 929 → 943 kbps), mas o `base` ficou limpo, e a coluna "atraso do proxy p99" caiu de 23 para 12 ms: parte do que ela mostrava antes era o próprio tick.
6. **Para jogo, `maintain-framerate` continua certo.** Ele é a única preferência que manteve 30 fps sob variação. `maintain-resolution` só pareceu bom porque a tela de teste era lisa.

## O que mudou
| Commit | O que faz |
|---|---|
| `test(rede): netsim pede timers de 1 ms ao Windows e mede o próprio timer` | `timeBeginPeriod(1)` pelo `koffi` (devDependency); a 1ª linha mostra o timer medido |
| `test(rede): netsim mede quem transmite e o início da transmissão` | BWE, alvo, enviado, reenvio, resolução, QP e motivo do limite a cada 1 s; linha `início da transmissão`; `NETSIM_TRACE=1` |
| `test(rede): netsim com variação em fila (badQueue)` | Segundo modelo de variação, sem reordenar |
| `test(rede): netsim com conteúdo pesado (NETSIM_CONTENT=game)` | Tela que deixa o encoder limitado por banda |
| `test(rede): NETSIM_DEGRADATION força o degradationPreference` | Knob para repetir o A/B |

O app (`web/`) não mudou.

## Como repetir
```bash
NETSIM_MEASURE_MS=60000 NETSIM_ONLY=base,bad,badQueue npm run netsim
NETSIM_CONTENT=game NETSIM_DEGRADATION=balanced NETSIM_MEASURE_MS=60000 NETSIM_ONLY=base,bad,badQueue npm run netsim
```
Descarte a rodada se o `base` não sair com 30 fps e 0 congelamentos.

## Verificação
- `npm test`: 37/37.
- `npm run netsim` completo (janelas de 10 s): **NETSIM OK**. Timer do proxy em 1,0 ms; `base` limpo (30 fps, 0 congelamentos); início em 360p → 720p em 13 s; cortes de 3, 10, 40 e 90 s recuperados (vídeo em até 6,0 s, voz em até 5,2 s). Em 10 s, o `loss2rtt300` ainda aparece em 270p: a banda leva ~40 s para voltar, por isso a comparação usa 60 s.
- Cada um dos 5 commits passa no `node --check`. Desfeitos em ordem, eles reconstroem o `HEAD` anterior byte a byte.
- `npm run e2e` não foi rodado: o app não mudou.

## Próximos passos
1. **Rampa do início:** toda transmissão começa em 180–360p e leva 13–16 s para chegar a 720p, porque o Chrome parte de uma estimativa de ~300 kbps. Vale medir `x-google-start-bitrate` no SDP, partindo do upload medido em T02, com a linha `início da transmissão` como métrica.
2. **`balanced` com mais rodadas limpas:** a única rodada válida com conteúdo pesado ficou entre as outras duas. Só vale trocar com 3 ou mais rodadas limpas mostrando menos congelamentos e fps parecidos.
3. **Rede real:** os dois modelos de variação do netsim são extremos. Uma medição numa rede móvel de verdade diria qual dos dois está mais perto.
