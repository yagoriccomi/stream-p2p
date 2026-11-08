# ENTREGA LOCAL — benchmark-retomada

- Data: 2026-11-06. Modo: Loop.
- Plano: [PLANO-benchmark-retomada.md](PLANO-benchmark-retomada.md).
- Branch: claude/app-nativo-edge-benchmark-0b34a3. Sem commit, push ou PR nesta execução.
- Estado: bancada verificada; investigação de desempenho com pendências. Não é entrega integral do ticket 05.

## O que mudou

Perfis H.264 configuráveis no relay Rust; native-full preserva h264/42e01f. Configurações inválidas falham explicitamente. Falhas do processo nativo e da sinalização rejeitam esperas e permitem alcançar a limpeza, em vez de bloquear a coleta. JSONs futuros registram configuração e dimensões reportadas pelo presenter; estatísticas distinguem captura e adaptação do encoder.

## Arquivos

- `e2e/bench-relay.js`: configuração, metadados, falhas e limpeza.
- `e2e/bench/relay.html`: preferência de degradação e telemetria, sem redesign.
- `e2e/bench/native/src/main.rs`: validação do perfil conforme str0m 0.25, testes Rust.
- `e2e/bench-relay.test.js`: 13 testes de configuração, processos e sinalização.
- `e2e/bench/results/`: 13 JSONs exploratórios novos; dados antigos intactos.
- `.scratch/app-nativo-vs-enxuto/05-poc-comparativo-latencia-ram.md`: tabela completa, hipóteses e limites.
- Plano e este relatório.

## Evidências

Verificador independente: PASS técnico. Reexecutados pelo coordenador, com resultados concordantes:

```bash
git diff --check
node --unhandled-rejections=strict --test e2e/bench-relay.test.js
npm test
```

- Whitespace: exit 0; somente avisos LF/CRLF.
- Bancada: 13/13 passaram, zero falhas ou skips; inclui Rust real com perfil inválido.
- Suíte principal: 76/76 passaram, zero falhas ou skips.
- Verificador executou sintaxe JS, `cargo test` e `cargo build --release --offline --locked` em diretório temporário: exit 0. A última saída resumida não trouxe contagem Rust; a auditoria anterior registrou 2 testes do relay.
- Auditoria anterior conferiu os 13 JSONs contra a tabela e preferências aplicadas no Edge real sem captura/mídia.
- Não houve nova medição GPU após os ajustes finais. Não há comprovação audiovisual ponta a ponta da versão final nem estabilidade de desempenho.

## Resultados e premissas

Todas as rodadas foram mantidas [#99]. Aquecimento segue hipótese, não justificativa para excluir amostras. A série Edge H.264 + Rust em 534p ficou em 75–116 ms; captura maior com balanced ficou em 170–299 ms e 720/804p. Maintain-resolution em 1072p variou de 103 a 2689 ms. Não demonstra melhoria estável nem metas cumpridas.

Tamanho solicitado da janela não garante tamanho capturado. Não juntar séries de resoluções diferentes. Reutilizada bancada existente, sem dependências novas [#6][#8]. Escopo local limitado aos itens 3/4 do handoff.

## Decisão visual

Sem mudança da interface do produto ou do relatório HTML; mockup não aplicável. Dimensão da janela-fonte é parâmetro experimental.

## Campanha adicional autorizada

Após o registro inicial acima, executadas 24 medições sequenciais com a versão instrumentada: 18 balanced e seis maintain-resolution. Dados completos e limites no ticket 05, seção “Campanha controlada adicional”. Os 13 JSONs exploratórios permanecem preservados; total de 37 novos JSONs nesta retomada.

- Edge com relays Edge: cadeia 69–98 ms, 952×536, 48–51 FPS.
- Edge com relays Rust: cadeia 71–74 ms, 952×536, 48–51 FPS. Duas bases divergiram em dimensão e/ou FPS; não permitem estimar custo por salto.
- Transmissor e relays Rust: cadeia 57–86 ms, 1906×1072, 62–63 FPS medidos.
- Edge/Rust maintain-resolution: cadeia 82–90 ms, 1906×1072, 18–22 FPS; um congelamento na terceira cadeia.

Codec negociado e largura agora registrados e cobertos pelo teste de telemetria. Verificação independente da telemetria: PASS sintético; coordenador reexecutou os 12 testes filtrados e sintaxe com resultados concordantes. Auditoria independente da consolidação: PASS técnico/documental local; 24 controles e 13 exploratórios conferidos, sem divergência nas tabelas. Verificador confirmou dois testes Rust e build release offline. Coordenador reexecutou a bancada completa (13/13) e a suíte principal (76/76), sem falhas ou skips. O PASS não comprova metas integrais nem validação audiovisual do app.

Não há comparação com qualidade equivalente: dimensões, FPS e perfis variam entre caminhos. Dimensões finais não provam constância no intervalo; FPS medidos não contam necessariamente quadros únicos. Resultados curtos, locais, sem áudio; não aprovam app completo, rede ruim, segundo PC nem metas integrais. A ausência de nova medição mencionada nas evidências iniciais descreve apenas o encerramento anterior a esta campanha.

## Smoke no monitor secundário — 2026-11-06

Após autorização para retomar, executados dois testes sequenciais, base direta sem relays, com 3 s de estabilização e 3 s de medição. Arquivos preservados:

- `secondary-smoke-native-full-1794004579540.json`: captura Rust/NVIDIA, 1906×1072 no presenter, espectador com 62 FPS, zero congelamentos reportados; latência calculada de 112701 ms.
- `secondary-smoke-native-1794004598771.json`: captura Edge, espectador com 32 FPS em 804p, zero congelamentos reportados; latência calculada de 132415 ms.

A validação CDP de geometria passou. Nenhuma ativação dos PIDs dos browsers foi observada por amostragem nominal de 10 ms; isso não exclui ativações entre amostras, durante launch ou durante chamadas síncronas que bloqueiam o event loop. Não demonstra garantia absoluta de foco.

Latências suspeitas: não usar estas rodadas para comparação de desempenho. A janela normal inclui elementos do navegador; deslocamento da faixa do relógio é hipótese a verificar com imagem capturada. FPS decodificados não comprovam quadros únicos. As séries anteriores permanecem separadas.

O primeiro smoke Rust falhou com exit 101, antes da coleta: o título nativo inclui perfil e nome do Edge. Correção consulta MainWindowTitle do PID com UTF-8 e passa o título completo ao presenter; auditoria independente PARTIAL (checks técnicos aprovados, captura real fora do escopo). Busca global por título ainda permite colisões. Coordenador reexecutou sintaxe, 17 testes e transporte Unicode. Os dois smokes acima foram posteriores à auditoria.

## Diagnóstico do relógio — 2026-11-06

Rodada `secondary-clock-probe-1794004948008.json`: Rust/NVIDIA, 1906×1072, 63 FPS, zero congelamentos reportados; latência inválida de 479517 ms. Imagem recebida preservada em `secondary-clock-probe-1794004948008.png`.

Inspeção dos pixels via Edge headless: linhas y=80 até y=200, em passos de 10 pixels, apresentam 24 blocos binários com timestamp 478122. As linhas y=60 e y=70 decodificam zero. O leitor real reduz a imagem para 320×180 e lê y=11, correspondente aproximadamente a y=66 da captura original: região acima do relógio. Confirma erro de coordenada nesta rodada Rust; não comprova ainda o mesmo deslocamento na captura Edge. Não recalcular latência a partir da imagem isolada, sem instante preciso da leitura.

Nenhuma ativação dos browsers detectada pela amostragem durante a captura; limites de observação anteriores permanecem. Próximo passo: corrigir localização da faixa sem presumir altura fixa da barra, cobrir leitura com e sem decoração em teste e verificar independentemente antes de novas comparações.

## Instrumentação do relógio — 2026-11-06

Fonte agora acrescenta marcador de oito bits `0xa5` aos 24 bits do timestamp. Leitor busca verticalmente três linhas concordantes; faixa ausente ou ambígua retorna `null`. Latência exige todas as amostras válidas, respeita wrap e não tenta desenhar vídeo indisponível. Posições horizontais continuam proporcionais; recorte horizontal arbitrário não é suportado. Imagens antigas não contêm o marcador.

Verificação independente: PASS restrito ao gate técnico, sem navegador, GUI, GPU ou captura. Exercitou o renderer real em VM com rasterização em memória: 28 combinações de escala/deslocamento/timestamp, limites de contraste, marcador corrompido, linhas insuficientes, ambiguidade, wrap e uma amostra inválida entre 40. Isso não equivale a Chromium, codec ou captura real.

Coordenador reexecutou três comandos do parecer: sintaxe da bancada/testes/script HTML, `node --test e2e/bench-relay.test.js` (19/19) e `npm test` (76/76), sem falhas ou skips; resultados concordantes. Validação real da nova instrumentação Edge/Rust permanece pendente. Não reutilizar latências inválidas anteriores nem concluir estabilidade de desempenho.

## Captura com marcador e interrupção por foco — 2026-11-06

`secondary-marker-native-full-1794006336641.json`: base Rust/NVIDIA, 3 s de estabilização e 3 s de medição, 1906×1072, 62 FPS decodificados, leitura de latência de 42 ms, zero congelamentos reportados. Primeira leitura real com o marcador novo; não demonstra estabilidade. O comando externo encerrou com exit 1 sem saída diagnóstica disponível; registro de foco dessa rodada não foi recuperado. Não considerar a execução integralmente aprovada.

A tentativa Edge seguinte foi interrompida pelo observador de foco. Evidência preservada em `secondary-marker-native-1794006400595-focus.json`: exit 1, 408 amostras, duas detecções de PID de browser da bancada em foreground, maior intervalo observado de 751 ms. Não foi produzido JSON de desempenho Edge. A observação não identifica qual operação ativou a janela; launch e intervalos sem amostragem continuam pontos cegos.

Nenhum processo da bancada encontrado na conferência posterior. `snapshot.png` e resultados anteriores preservados. Capturas visíveis suspensas: investigar sem GUI antes de qualquer nova tentativa. CDP background/focus:false e geometria secundária não garantem ausência de ativação no caminho completo. Análise de desempenho permanece incompleta.

## Política de foco da captura — 2026-11-06

`present()` agora exige `CaptureController.setFocusBehavior`, define `no-focus-change` antes de `getDisplayMedia` e passa o controller ao pedido. API ausente ou falha aborta sem fallback. Caminho canvas permanece independente dessa API.

Verificação independente: PASS técnico, sem GUI, navegador, GPU ou Rust. Coordenador reexecutou sintaxe, bancada com `--test-skip-pattern="^Rust real:"` (19 testes executados e aprovados; teste Rust excluído) e suíte principal (76/76), resultados concordantes. Verificador também exercitou canvas e falha repetida do construtor em VM.

Capturas visíveis continuam suspensas. Política cobre uma possível fonte de ativação; não comprova causa do incidente nem preservação de foco no Edge real. Sem novas medições de desempenho nesta etapa.

## Disponibilidade no Edge headless — 2026-11-06

Sonda local executada no Edge `156.0.4314.58`, headless com `--disable-gpu`, página HTTP em loopback (secure context). `CaptureController`, `setFocusBehavior` e `getDisplayMedia` disponíveis como funções; construção do controller e definição prévia de `no-focus-change` aceitas. Nenhuma chamada a `getDisplayMedia`, captura ou janela visível nesta sonda; browser e servidor encerrados ao final.

A documentação de https://developer.mozilla.org/en-US/docs/Web/API/CaptureController/setFocusBehavior limita a política à decisão de foco da superfície capturada; não oferece garantia sobre launch, criação de janelas ou seletor de compartilhamento. Disponibilidade em headless não comprova preservação de foco durante captura real. Capturas visíveis continuam suspensas.

Próxima investigação sem GUI: revisar observação de foco fora do event loop da bancada, identificando PID e etapa para eliminar a lacuna de chamadas síncronas antes de planejar nova validação real. Não repetir medições visíveis automaticamente enquanto a restrição de não interferência estiver sem comprovação.

## Sonda de observação independente — 2026-11-06

Sem navegador, janela nova ou captura: `GetForegroundWindow` e `GetWindowThreadProcessId` via Koffi instalado, em `node:worker_threads`. Durante bloqueio síncrono do processo principal por `execFileSync` de 966 ms, o Worker registrou 61 amostras; 63 no total, maior intervalo de 24 ms. Um único PID foreground observado. Assertions de continuidade da amostragem e formato dos PIDs passaram. Sonda encerrada com `worker.terminate()` em finally; nenhum código da bancada alterado.

A primeira tentativa falhou porque o Worker herdou `--input-type=module` e usava `require`; diagnóstico isolado confirmou `ReferenceError`. `execArgv: []` tornou explícito o modo CommonJS da sonda e permitiu a execução. Não atribuir essa falha à API User32.

Isso demonstra continuidade da observação durante um bloqueio síncrono nesta sonda, não garantia de foco nem identificação da causa do incidente Edge. Monitoramento segue amostrado; callbacks no processo principal ainda podem atrasar a reação. Integração futura precisa iniciar antes do launch, registrar PID/etapa e persistir evidência mesmo em saída anormal. Mensagens de etapa podem atrasar durante bloqueio; não tratá-las como instante exato da ativação. Capturas visíveis permanecem suspensas; nenhuma nova medição de desempenho.

## Séries visíveis autorizadas com observador de foco — 2026-11-07

Usuário autorizou janelas visíveis. Wrapper fora do repositório (`%TEMP%/sp2p-focus-run.mjs`) roda a bancada com observador User32 em Worker iniciado antes do primeiro launch; registra transições de foreground, PIDs da bancada (polling assíncrono) e última linha de saída como etapa; persiste `<label>-focus.json` mesmo em falha. Série sequencial aborta em hit ou exit ≠ 0. Primeira tentativa abortou por falso negativo do próprio wrapper (grep sem espaço em `"hits": []`); rodada concluída preservada, script corrigido, série retomada pulando-a.

Condições comuns: monitor secundário, `BENCH_DIRECT=1`, rede boa, settle 20 s, measure 15 s, Edge 157.0.4341.42 (registrado nos JSON; sondas anteriores usaram 156.0.4314.58), RTX 4060 Ti. Edge: `getDisplayMedia` + NVIDIA H.264 Encoder MFT, perfil 42001f. Rust: presenter WGC + NVENC, 42e01f. Cadeia = dois relays Rust. 18 rodadas, todas exit 0, **0 hits**, maior intervalo de amostragem 35 ms. Resultados `focusctl-20261107-*` (+ `-focus.json`, `.log`); smoke `focusctl-smoke-edge-1794081695794`.

| Série (3×) | Latência espectador ms | FPS | Resolução recebida | Presenter RAM MB / CPU % |
|---|---|---|---|---|
| Edge base, balanced | 59 / 64 / 76 | 44–48 | 1428×804 | 208–212 / 60–71 |
| Edge cadeia, balanced | 62 / 74 / 72 | 46–48 | 952×536 (2×), 1428×804 (1×) | 204–208 / 51–67 |
| Edge base, maintain-resolution | 64 / 63 / 69 | 25 | 1906×1072 | 193–201 / 61–69 |
| Edge cadeia, maintain-resolution | 88 / 78 / 81 | 25 | 1906×1072 | 195–196 / 59–62 |
| Rust base | 39 / 42 / 40 | 59–61 | 1906×1072 | 29–30 / 9–10 |
| Rust cadeia | 63 / 62 / 56 | 60 | 1906×1072 | 29 / 8–9 |

Zero congelamentos e perda em todas. Relays Rust: 3 MB, 3–6% CPU. Espectador Edge: 139–163 MB.

Leitura, limitada a esta máquina/loopback:
- Captura Edge entrega 44–48 quadros/s (48 em 10 de 12 rodadas) de 60 pedidos; balanced reduz resolução (`limitação: bandwidth` ~7,6 Mbps); maintain-resolution mantém 1906×1072 sem limitação reportada, mas codifica 25 FPS. Nenhuma configuração Edge iguala Rust em resolução e FPS simultaneamente; diferença de latência e de custo por salto não é custo isolado do relay.
- Rust: configuração idêntica entre base e cadeia; acréscimo de latência dos dois relays 16–24 ms por par de repetições (média 20 ms). Três repetições não comprovam estabilidade.
- Presenter Rust ~7× menos RAM e ~7× menos CPU (média 9% vs 62,5%) que o presenter Edge com captura; RAM do CLI não equivale a app com interface/áudio.
- 0 hits mostra ausência de foreground da bancada nas amostras (≤35 ms), não garantia absoluta; política `no-focus-change` presente na captura Edge. Limites do observador: PIDs identificados por polling de 700 ms (processo efêmero pode escapar); transição para PID não identificado não conta como hit; falha de spawn sem `exit` deixaria o wrapper sem gravar o relatório.

## Sonda de teto de bitrate — 2026-11-07

`BENCH_KBPS` (padrão 8000, inteiro 100–100000, rejeitado em native-full cujo presenter fixa 8000) vai na URL como `kbps` e no JSON. Teste novo; bancada 20/20 sem o teste Rust real.

`kbps-probe-edge-base-20000-1794083522`: Edge base balanced, settle 15 s, measure 10 s, exit 0, 0 hits. Enviou 17427 kbps (vs ~7,6 Mbps no teto 8000), mas manteve 1428×804, `limitação: bandwidth` 13,3 s, captura 48 de 60 quadros/s, espectador 48 FPS, 99 ms. Hipótese do teto de bitrate não se confirma nesta rodada única: dobrar a taxa não restaurou 1072p nem FPS. Critério do plano (1906×1072 com ≥55 FPS) não atingido; busca por equivalência encerrada. Captura Edge ~48 quadros/s permanece o limite observado; causa (getDisplayMedia/WGC no Edge, estimador de banda) não isolada. Ressalvas: encoder seguiu limitado por banda a 87% do teto, então teto maior ou settle mais longo não estão excluídos; `BENCH_KBPS` também altera `b=AS` e `x-google-start-bitrate` (10000 vs 4000), e a sonda usou 15/10 s em vez dos 20/15 s da base. Segundos de limitação excedem a medição porque incluem o tempo de coleta das estatísticas.

`kbps-probe-edge-base-mres-20000-1794084193`: mesma base com maintain-resolution, 20000 kbps, settle 20 s/measure 15 s (iguais às séries), exit 0, 0 hits. 1906×1072 enviado e recebido, 49 quadros codificados/s (vs 25 no teto 8000), captura 49 de 60, `limitação: none`, 19408 kbps, espectador 49 FPS e 61 ms, presenter 197 MB/77% CPU. Rodada única: no teto 8000 o envio ficou no teto (8003–8022 kbps) com `limitação: none`; com 20000 o FPS dobrou, o que sugere a taxa como limite (inferência; `BENCH_KBPS` também altera `b=AS` e taxa inicial). Com 20000, o FPS coincide com a captura (~48–49 quadros/s). Ainda abaixo do critério ≥55 FPS; Rust entrega 59–61 FPS a 8000 kbps. Diferença de taxa inviabiliza comparação equivalente de latência.

## Pendências e próximo passo

Séries visíveis de 2026-11-07 cobriram base/cadeia com configuração registrada e 0 hits de foco. Falta resolução e FPS efetivos equivalentes entre Edge e Rust (Edge limitado a ~48 quadros/s de captura e 25 FPS em maintain-resolution); investigar essa limitação e repetir além de três rodadas antes de afirmar estabilidade. Rede ruim, segundo PC e ADR continuam pendentes. Relatório HTML permanece histórico, sem novos veredictos. Não concluir custo por salto ou cumprimento de metas com estas séries.

Sem Jira, alteração de CLAUDE.md, publicação ou PR. Próxima ação recomendada: medições controladas, antes de decisão arquitetural.
