# PLANO — retomada do benchmark nativo vs. Edge

Data: 2026-11-06. Modo: Loop. Origem: handoff/app-nativo-vs-enxuto/001 - 06_11_2026 benchmark etapas 1 a 2c.md.
Branch: claude/app-nativo-edge-benchmark-0b34a3.

## Enunciado
- Problema: falta medir Edge H.264 por hardware com relays Rust e explicar a resolução reduzida.
- Resultado: perfis explícitos na bancada, telemetria da captura/adaptação e registro fiel das rodadas.
- Validação: testes de configuração, compilação, verificação independente e conferência dos JSONs.

## Escopo
Itens 3 e 4 da fronteira do handoff. Não alterar produto, publicar, commitar, abrir PR nem afirmar metas cumpridas. Rede ruim, dois PCs e ADR permanecem pendentes [#8].

## Premissas
- Reutilizar bancada e dependências instaladas [#6][#7].
- Não excluir primeiras rodadas: aquecimento é hipótese não demonstrada [#99].
- Resolução real precisa constar nos resultados; tamanho solicitado da janela não garante tamanho da captura.
- Verificação em nível alto; medições de GPU sequenciais, nunca concorrentes.
- Sem Jira ou ferramenta de uso disponível nesta sessão.

## Decisão visual
Sem mudança de interface do produto ou do relatório HTML. Alteração da dimensão da janela-fonte é parâmetro experimental, não redesign. Sem mockup.

## Terreno e contratos
- e2e/bench-relay.js: configuração, processos e coleta.
- e2e/bench/relay.html: WebRTC e estatísticas.
- e2e/bench/native/src/main.rs: relay RTP str0m.
- e2e/bench/results/: preservar todas as rodadas desta sessão.
- Ticket 05: registrar limites e resultados.
Sem banco, API pública ou segredos novos. Configurações: BENCH_H264_PROFILE, SP2P_H264_PROFILE, BENCH_DEG [#80].

## Passos
1. Revisar mudanças já realizadas antes deste plano (desvio de processo registrado).
2. Validar perfis e manter native-full sempre compatível com o transmissor 42e01f.
3. Registrar configuração/resolução para interpretar futuras rodadas; testar sem adicionar framework.
4. Verificação independente da bancada e das conclusões [#34][#42].
5. Consolidar dados, pendências e entrega local.

## Fatias
| Fatia | Módulo | Nível | Dependência | Estado |
|---|---|---|---|---|
| Bancada | e2e/bench | alto | nenhuma | revisada: pronta localmente |
| Verificação | e2e/bench | alto | bancada | PASS técnico; 3 checks reexecutados pelo coordenador |
| Registro | ticket 05/docs | alto | verificação | concluído; ENTREGA-benchmark-retomada.md |

Sem PR. Estabilidade de desempenho e demais itens da fronteira não concluídos.
Uma única fatia de implementação: os arquivos compartilham protocolo e configuração.

## Testes
node --check e2e/bench-relay.js; testes Node da bancada; cargo test/build --release via manifest do crate; npm test na raiz. Verificador deve incluir comandos e saídas, sem inferir estabilidade de desempenho a partir de compilação.

## Riscos e rollback
DPI, bordas, carga da GPU e captura afetam comparabilidade. Manter todas as amostras; não juntar séries com resoluções diferentes. Sem regressão esperada no produto (bancada isolada). Rollback: reverter somente os hunks desta sessão mediante autorização; preservar JSONs [#84].

## Campanha adicional autorizada — 2026-11-06

Pedido: executar todos os testes necessários para concluir a análise. Escopo local ampliado para séries controladas; sem publicação ou alterações no produto.

1. Registrar codec negociado e largura enviada/recebida; testar a telemetria antes da GPU.
2. Executar sequencialmente três repetições de Edge/Edge, Edge/Rust e Rust/Rust, cada uma com base direta e dois relays; preservar todas as rodadas com nomes inéditos.
3. Se houver redução de resolução, executar série separada maintain-resolution para Edge/Rust, base e cadeia, três vezes.
4. Conferir dimensões, codec e FPS antes de calcular qualquer diferença; base native sem relay não força perfil 42001f. Não estimar custo quando a configuração efetiva divergir.
5. Verificação independente dos arquivos e resultados; documentar conclusão local e bloqueios.

Rede ruim: proxy TURN saturado e enlaces Rust diretos impedem comparação equivalente. Segundo PC: indisponível nesta bancada loopback; não afirmar validação remota. RAM do CLI não equivale à RAM de um app com vídeo e interface. Medições GPU nunca concorrentes [#99].

## Monitor secundário sem foco — 2026-11-06

Pedido: continuar testes no segundo monitor sem roubar foco. Manter headless por padrão e autorização explícita para captura visível. Detectar monitor não primário antes de iniciar a bancada; ausência deve abortar. Abrir Edge sem janela inicial e criar janela via CDP em background, com posição e tamanho do monitor secundário. Remover bringToFront e a fixação topmost do presenter Rust. Manter subprocessos ocultos. Testar configuração e protocolo sem GUI, compilar Rust, verificar independentemente antes de retomar medições. Validar posição e foco numa execução curta; não restaurar foco à força nem usar o monitor principal como fallback. Nova geometria de janela altera condições experimentais; não misturar com séries anteriores.

## Leitura do relógio com decoração — 2026-11-06

Diagnóstico por imagem confirmou leitura da barra em vez do relógio. Adicionar oito células de identificação após os 24 bits de tempo, na faixa já existente. Localizar verticalmente linhas binárias com essa identificação, exigir concordância em linhas adjacentes e rejeitar leituras ausentes/ambíguas como null. Manter posições horizontais proporcionais; recortes/deslocamentos horizontais grandes não são suportados e não devem ser tratados como medições válidas. Testar faixa sem decoração, deslocada, escalada, ausente, ambígua e wrap do relógio. Verificação independente antes de novas séries; dados antigos preservados, nova instrumentação em série separada. Sem alteração visual no produto.

## Controle de foco da captura — 2026-11-06

Duas detecções reais de foreground interromperam o smoke Edge. Capturas visíveis suspensas. `getDisplayMedia` ainda não define política de foco da superfície capturada; CDP background não controla essa etapa. Configurar `CaptureController.setFocusBehavior('no-focus-change')` antes de pedir captura e passar o controller. Ausência de suporte deve abortar, sem fallback que possa ativar janela. Testar ordem, opções, falta de suporte e propagação de falhas em VM, sem GUI; auditoria independente antes de considerar nova captura. Hipótese causal, não diagnóstico comprovado do evento observado; não garante foco durante launch ou outras operações.

## Caminho para validação real sem interferência — 2026-11-06

Constatação: observador de foreground só detecta, não previne; segundo monitor compartilha o foco do desktop. Capturas visíveis seguem suspensas até nova autorização.

Opções, em ordem de simplicidade:
1. **Janela autorizada com PC ocioso** (preferida): usuário escolhe horário em que não estará usando o PC e autoriza explicitamente. Condições reais (GPU, DPI, monitores). Uma série curta: smoke Edge com `no-focus-change`, depois Edge/Rust e Rust/Rust sequenciais, mesma geometria, nomes inéditos. Observador em Worker iniciado antes do primeiro launch, registrando PID/etapa, persistindo em saída anormal; hits viram dado de diagnóstico, não critério de aborto silencioso.
2. **Desktop Win32 separado** (sonda, não medição): lançar Edge/presenter em desktop não interativo não altera o foreground do usuário por construção. Risco: DWM pode não compor desktop não-input, então WGC/getDisplayMedia pode não gerar quadros. Validar só se quadros chegam; resultado de desempenho não comparável com série no desktop real.
3. **Outra máquina com GPU equivalente**: também cobre o pendente de segundo PC; depende de disponibilidade.

Descartados: VM sem GPU-PV equivalente (não valida NVENC/desempenho); restaurar foco à força (proibido).

Critérios inalterados: não juntar séries de geometria/instrumentação diferentes; latência null em leitura inválida; sem afirmar estabilidade com menos de três repetições comparáveis. Decisão entre 1–3 é do usuário; nenhuma execução visível antes dela.

## Equivalência Edge × Rust — 2026-11-07

Constatação: `relay.html` fixa `KBPS = 8000` como `maxBitrate`; Edge balanced reporta `limitação: bandwidth` ~7,6 Mbps e reduz para 804p/536p. Maintain-resolution mantém 1072p mas codifica 25 FPS. Hipótese: teto de bitrate, não a captura, limita o Edge.

1. Tornar o teto configurável (`kbps` na query, `BENCH_KBPS` na bancada, padrão 8000 inalterado; registrar no JSON). Teste de configuração sem GUI.
2. Sonda curta visível: Edge base balanced com 20000 kbps; conferir resolução, FPS e limitação reportada.
3. Se atingir 1906×1072 com ≥55 FPS: série 3× Edge base/cadeia e Rust base/cadeia no mesmo teto, nomes inéditos, observador de foco. Senão, registrar o limite da captura Edge e encerrar a busca por equivalência.
4. Verificação independente antes de atualizar a ENTREGA. Séries com teto diferente não se juntam às de 8000 kbps.

Resultado: passos 1–2 feitos; sonda 20000 kbps enviou 17,4 Mbps e ficou em 1428×804, 48 FPS. Critério do passo 3 não atingido: série não executada, busca encerrada. Sonda complementar maintain-resolution 20000: 1906×1072, 49 FPS, sem limitação; FPS coincide com a captura Edge (~49/s; rodada única). Próxima decisão do usuário: aceitar Edge 1072p/49 FPS a 20 Mbps como melhor caso e encerrar, ou investigar a captura (outra API/flags), fora do escopo atual.

## Pronto
Bancada verificada, configurações inválidas rejeitadas, resultados documentados sem promessa de estabilidade. Se hardware ou ambiente impedir comprovação, registrar limitação. Sem commit/PR nesta execução.
