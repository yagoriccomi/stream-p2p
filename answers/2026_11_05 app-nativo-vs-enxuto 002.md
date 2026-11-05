# Decisões — app-nativo-vs-enxuto — 2026-11-05

**Contexto:** protótipos do ticket 05 para medir a diferença de desempenho entre a versão atual, a versão enxuta no Edge e a versão 100% Rust.
**Modo:** levantar

| # | Peso | Pergunta | Decisão | Consequência |
|---|---|---|---|---|
| 1 | Bloqueante | Quais versões montar | As 3, em etapas: atual + enxuta primeiro, depois a nativa | Primeiros números em horas; a nativa entra na mesma tabela depois |
| 2 | Importante | Escopo da versão nativa | Captura WGC + NVENC + repasse RTP com str0m, sem interface (CLI) | Mede o ganho no transmissor e nos saltos; quem assiste continua no navegador |
| 3 | Importante | Tamanho da árvore | Transmissor → 2 relays → espectador | Mostra o acúmulo de atraso por salto |
| 4 | Importante | Vídeo de teste | 1080p 60 FPS com movimento | Caso mais exigente |
| 5 | Importante | Rede | Rodada com rede perfeita + rodada com perda e atraso (netsim) | Melhor caso e comportamento sob rede ruim |
| 6 | Detalhe | Onde rodar | Tudo neste PC (RTX 4060 Ti, 16 GB) no dia a dia; checagem final em 2 PCs com a vencedora | Medição automática e repetível; validação real no fim |
| 7 | Detalhe | Formato do resultado | Página com gráficos | Fácil de mostrar; a tabela crua fica nos dados da página |

**Confirmações:** metas de `answers/2026_11_04 app-nativo-vs-enxuto 001.md` (< 100 ms ponta a ponta, < 5 ms por salto, < 200 MB) continuam valendo.
**Premissas:** nenhuma.
**Ainda em aberto:** nenhuma.
