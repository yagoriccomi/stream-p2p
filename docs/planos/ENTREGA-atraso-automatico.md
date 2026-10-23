# Entrega: atraso automático (2026-10-23)

Pedido: "ele pode medir automaticamente e recomendar qual usar e mudar isso nas configurações?"

## O que mudou
- `server/topology.js`: o alvo deixou de ser fixo em 150 ms. `createRoom` recebe `latency` ('auto' ou 60–400 ms);
  `setHopNeed` guarda quanto buffer a rede de cada pessoa pede; `autoTarget` calcula o menor atraso que atende todo mundo
  (+20 ms, arredondado em 10); `retarget` aplica. Relays agora encaminham cedo o bastante para o filho ter o buffer que pediu.
- `server/index.js`: `startStream` aceita `latency`; nova mensagem `setLatency` (só quem transmite); `hopRtt` aceita `needMs`;
  o servidor avisa todos com `latency` { targetMs, recommendedMs, auto } quando muda; recalcula quando alguém sai.
- `web/stream.js` / `web/app.js`: quem assiste mede `jitterBufferMinimumDelay` (ou 3× o jitter RTP) a cada 2 s e envia
  o pior dos últimos 30 s. O topo mostra "60 ms (automático) · igual para todos".
- Configurações: "Atraso da transmissão" com Automático (agora: X ms), 80, 150 e 300 ms, e o recomendado da sessão.

## Verificação
- `npm test`: 52 passam (5 testes novos de atraso).
- `e2e/run.js`: E2E OK; latência ponta a ponta 68–78 ms entre as 3 pessoas (antes ~150 ms + rede).
- `e2e/netsim.js` (só TURN, 720p30, 20 s por cenário):

| Cenário | Atraso comum | Latência | Congelamentos |
|---|---|---|---|
| base | 60 ms | 81 ms | 0 |
| 50 ± 20 ms | 150 ms | 192 ms | 0 |
| 150 ± 50 ms | 160 → 310 ms | 233–362 ms | 0 |
| limpo, 1º trecho de 20 s | 240–250 ms (segurando o pico) | 253 ms | 0 |
| limpo, depois de 30 s | 60 ms | 75 ms | 0 |

- Configurações (headless): quem assiste vê "Automático (agora: 60 ms)"; ao fixar 300 ms ao vivo, o topo muda e o buffer do
  espectador vai para 300; o texto mostra "recomendado agora é 60 ms".

## Pendências
- Ainda não testado com pessoas em redes reais diferentes (só no simulador).
- Firefox/Safari sem `jitterBufferMinimumDelay` usam 3× o jitter RTP: estimativa mais grosseira.
