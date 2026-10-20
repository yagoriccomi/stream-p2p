# PLANO DE EXECUÇÃO — pendencias-handoff-20-10

| Campo | Valor |
|---|---|
| **Tarefa** | `pendencias-handoff-20-10` |
| **Origem** | Descrição livre: "executa o handoff de onde parou" (`handoff_stream_p2p_architecture.md`, 20/10/2026, seção 4) |
| **Tipo** | Bug + Melhoria |
| **Modo de execução** | 🔁 Loop (sem confirmação) |
| **Data** | 2026-10-20 |
| **Branch** | `main` (commits atômicos; nada de push sem pedido) |

---

## 1. Enunciado Canônico

- **Problema:** o `e2e` quebra nesta máquina Windows. O TURN só existe se cada pessoa digitar um em T11. O upload é chutado pela pessoa. O atraso por salto é um número fixo (30 ms).
- **Resultado esperado:** `npm test` e `npm run e2e` verdes aqui. O servidor entrega um TURN padrão configurado por variável de ambiente. O upload é medido em T02. O buffer de cada pessoa é calculado com o RTT medido por `getStats`.
- **Como validar:** testes unitários novos, `E2E OK`, e no e2e a latência ponta a ponta medida em cada espectador.

## 2. Escopo

**Vou fazer:**
- Corrigir a recarga da página na primeira visita (service worker).
- Pendência 5: TURN padrão vindo do servidor (`/ice.json`), com credencial temporária quando houver `TURN_SECRET`.
- Pendência 4: RTT por salto medido com `getStats` e enviado ao servidor, que recalcula os buffers ao vivo.
- Pendência 4: medição do upload em T02 (teste de envio ao servidor de sinalização), com o campo ainda editável.
- Atualizar README, handoff e entrega.

**NÃO vou fazer (escopo negativo)** [#8]:
- Pendências 1, 2 e 3 (instalador, captura nativa, NVENC). Exigem Rust + MSVC, que não estão instalados nesta máquina. Instalar toolchain é mudança de sistema e fica para o usuário decidir.
- Pendências 6 e 7 (bot do Discord, HTTPS público). Exigem contas e deploy reais, que são ações externas.
- Reduzir a cota ao vivo quando a rede congestiona (`availableOutgoingBitrate`). Fica como próximo passo.

## 3. Premissas Assumidas

| # | Premissa | Por quê | Se estiver errada… |
|---|---|---|---|
| P1 | O `main` local estava 3 commits atrás de `origin/main`; fiz fast-forward antes de tudo | O handoff descreve `fc5fb6f`; o local não tinha modificações | Nada se perde: foi `--ff-only` |
| P2 | O TURN padrão é o do operador do servidor, via env (`TURN_URLS` + `TURN_SECRET` ou `TURN_USERNAME`/`TURN_CREDENTIAL`). Sem env, continua só STUN | Não existe TURN público confiável e gratuito; segredo fica fora do código [#37][#80] | Quem hospeda precisa subir um coturn; README explica |
| P3 | Credencial temporária no padrão REST do coturn (HMAC-SHA1, validade 6 h) | Não expõe senha fixa a todo visitante [#56] | Provedores com senha fixa usam `TURN_USERNAME`/`TURN_CREDENTIAL` |
| P4 | Upload medido por envio HTTP ao servidor de sinalização, limitado a 32 MB e 1 teste a cada 10 s por IP | `getStats` só mede depois que já há conexão; o gargalo costuma ser a última milha [#58][#65] | O número vira estimativa inicial; a pessoa pode editar |
| P5 | O relay reenvia o quadro **depois** do próprio buffer (é assim no libwebrtc). Então relay usa buffer 0 (adaptativo) e as folhas completam até 150 ms | Com o modelo antigo (150 − 30 × profundidade) os filhos de um relay somavam o buffer do pai e ficavam ~90 ms atrás | A medição de latência no e2e mostra o resultado real |
| P6 | Atraso de um salto = RTT/2 + 20 ms de decodificar e recodificar quando o pai é relay; 30 ms até medir | Estimativa conservadora; trocada pela medição assim que chega [#99] | Ajustar a constante com a medição do e2e |

## 4. Decisão Visual

- **Tem superfície visual?** Sim, só em T02: um botão "Medir" ao lado do campo de upload e o texto do resultado.
- **Precisa de mockup?** Não. É um ajuste dentro de um padrão que já existe (campo + dica + botão secundário).
- **`design-de-interface-projeto` acionada?** Sim, no passo 4.
- **Referência visual existente:** canvas https://claude.ai/artifact/PyEQWUdc5AsX4rGRARdC8S, T02.

## 5. Terreno (o que já existe)

| Arquivo | Papel hoje | O que muda |
|---|---|---|
| `web/app.js` | telas, estado, SW, ICE, T02, stats | SW, `/ice.json`, envio do RTT, medição de upload |
| `web/stream.js` | árvore de vídeo | `stats()` passa a devolver o RTT do salto de cima; jitter aplicado ao vivo |
| `server/topology.js` | cota, árvore, buffer | modelo de buffer com RTT medido |
| `server/index.js` | HTTP + WS | `/ice.json`, `/speedtest`, mensagem `hopRtt`, envio de `jitter` |
| `server/ice.js` (novo) | — | monta os `iceServers` a partir do env |
| `e2e/run.js` | e2e | buffers novos, medição de latência ponta a ponta, medição de upload |

**Reaproveitamento** [#6]: `HttpError`, rate limit por tokens, `fieldError`/`showError`, laço de stats de 2 s.
**Convenções locais** [#5][#13]: ESM, lógica pura testável separada do I/O [#30], mensagens de erro em PT-BR com código HTTP.

## 6. Passos Atômicos

| # | Arquivo | Mudança | Prática | Verificação |
|---|---|---|---|---|
| 1 | `web/app.js` | Só recarrega no `controllerchange` se já havia um SW controlando (atualização, não primeira instalação) | [#9] | `npm run e2e` passa do T01 |
| 2 | `server/ice.js`, `server/ice.test.js`, `server/index.js`, `web/app.js` | `/ice.json` com STUN + TURN do env; cliente busca ao abrir e renova a cada hora; TURN de T11 continua somando | [#80][#37][#41] | teste unitário da credencial; e2e |
| 3 | `server/topology.js`, testes, `server/index.js`, `web/stream.js`, `web/app.js`, `e2e/run.js` | Buffer por chegada estimada (relay 0, folha até 150 ms); `hopRtt` medido; servidor envia `jitter` só quando muda ≥ 5 ms | [#41][#43] | testes unitários; e2e mede latência ponta a ponta |
| 4 | `server/index.js`, `web/app.js`, `web/index.html`, `web/styles.css`, `e2e/run.js` | `POST /speedtest` + botão Medir em T02 | [#58][#65][#93] | e2e mede e preenche > 0 |
| 5 | `README.md`, handoff, `ENTREGA-…` | Documentar env de TURN e o que mudou | [#96] | leitura |

## 7. Impacto em dados/contrato

- Sem banco. Mensagens WS novas: cliente → `hopRtt { ms }`; servidor → `jitter { jitterMs }`. Rotas HTTP novas: `GET /ice.json`, `POST /speedtest`. Nada removido, cliente antigo segue funcionando.

## 8. Plano de testes

- Unidade: credencial TURN (formato e HMAC), env vazio, env inválido; modelo de buffer (direto folha, relay, filhos de relay, RTT medido, histerese, re-parent volta à estimativa).
- E2E: fluxo atual + latência ponta a ponta + medição de upload.
- Falha: `/speedtest` acima do limite → 413; repetido → 429; `hopRtt` inválido ignorado.

## 9. Riscos e rollback

- Buffers mudam para todos: se piorar, reverter o commit do passo 3 (`git revert`) [#84].
- Teste de upload consome banda do servidor: limitado por tamanho e frequência.

## 10. Definição de Pronto

- [x] `npm test` verde
- [x] `npm run e2e` → `E2E OK` nesta máquina
- [x] README com as variáveis novas
- [x] ENTREGA escrita, commits atômicos
