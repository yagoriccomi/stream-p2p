# ADR — App Windows nativo em Rust

| Campo | Valor |
|---|---|
| Status | Aceito |
| Data | 2026-11-09 |
| Mapa | `.scratch/app-nativo-vs-enxuto/map.md` (tickets 01–20) |
| Decisões | `answers/2026_11_04 … 001`, `… 002` (worktree); `E:/Projetos/stream-p2p/answers/2026_11_08 … 003–005`, `2026_11_09 … 006–008` |
| Plano | `docs/planos/PLANO-app-nativo.md` |

Convenção: todo número traz a origem entre colchetes. `[05]` = ticket 05 do mapa; `[r07]` = `research/07-…`; `[a008#4]` = answers 008, item 4. "Não medido" é literal.

## 1. Contexto

O app Windows de hoje é Tauri + WebView2 carregando a página do servidor; quase toda a lógica está em `web/*.js` [r10]. Com captura real, o app de hoje deu 190–243 ms no espectador, 32–46 fps e 801p, com o transmissor em 228 MB e 111–170 % de CPU [05, etapa 2b]. Mesmo com H.264 por hardware no Edge, ficou em 97–120 ms, 534p46 e ~210 MB [05, etapa 2c].

A bancada 100 % Rust (WGC + NVENC via Media Foundation + str0m) deu:

- 87–103 ms ponta a ponta, 1080p60, transmissor 30 MB e ~10 % de CPU, relay 3 MB [05, 2b];
- na campanha controlada, 57–86 ms a 1906×1072 [05, 2026-11-06].

Os relays Rust repassam sem decodificar: 4 MB e 3 % de CPU, contra ~210 MB e ~100 % de um núcleo no Edge [05, 2a]. Repassar sem recodificar no navegador (Encoded Transform) não se sustenta [05, etapa 1].

Metas [a001, a003#7, a007#1]:

- latência < 100 ms ponta a ponta;
- < 15 ms por salto de relay (afrouxada de 5 ms);
- RAM < 200 MB por processo do app. A meta de < 50 MB só do toolkit caiu: o protótipo 07 mediu 155 MB.

A Web/PWA continua ativa e compatível [a001#2].

## 2. Decisão

Construir um executável nativo em Rust que transmite, assiste e repassa. Ele substitui o Tauri quando atingir a paridade [a003#5, #10].

### 2.1 Stack

| Camada | Escolha | Origem |
|---|---|---|
| WebRTC | `str0m` 0.25 (sans-IO, `wincrypto`), modo RTP para o repasse | [02], [05 2a] |
| Captura | Windows.Graphics.Capture → textura D3D11 → `VideoProcessorBlt` BGRA→NV12 (0,6 ms/quadro) | [05 2b] |
| Encode | MFT de hardware via Media Foundation (NVENC/AMF/QSV) no mesmo adaptador da captura; reserva: MS H.264 software MFT | [03], [13] |
| Decode | MS decoder MFT com D3D11 manager, `MF_LOW_LATENCY` + `CODECAPI_AVLowLatencyMode` (VT_UI4) obrigatórios | [08], [18] |
| UI | Slint 1.18 (`~1.18`, `unstable-wgpu-30`, `renderer-femtovg-wgpu`, `accessibility`) + wgpu 30 só DX12, device compartilhado com o vídeo | [04], [07] |
| Vídeo na tela | NV12→RGBA em pool de 3 texturas compartilhadas → `OpenSharedHandle` → `texture_from_raw` → `Image::try_from` (sem cópia), fences D3D11↔D3D12 | [07] |
| VP8/VP9/AV1 por software | libvpx (BSD) e dav1d (BSD-2) embutidos | [20] |
| H.265 | só GPU ou MFT do Windows (extensão HEVC da Store); sem lib embutida por patente | [20] |
| TURN | `turn-client-proto` 0.7.3 + `turn-client-rustls` 0.1.2 (sans-IO, UDP/TCP/TLS); reserva `rtc-turn` 0.21.1 | [15] |
| Sinalização | protocolo WS do servidor inalterado (`signal`/`vsignal`, `device` persistido, prazo 10 s, backoff 1/2/4/5 s) | [11] |
| Áudio do sistema | reaproveitar `app/src-tauri/src/sysaudio.rs` (WASAPI loopback, exclusão de apps), desacoplado de `tauri::ipc::Channel` | [r10] |
| Voz | Opus (encode/decode no app) + AEC/NS do próprio Windows | [11], [a008#6] |
| Reaproveitado do Tauri | `cli.rs` (`tauri::Url` → `url`), bandeja, instância única (mutex), deep link `streamp2p://`, `server.txt`, `hooks.nsh` | [r10] |

### 2.2 Onde mora

Pasta nova `native/` na raiz, ao lado de `app/`. O `app/` sai depois da migração [a008#1]. As bancadas `e2e/bench/native` e `e2e/bench/proto07` continuam como referência descartável.

### 2.3 Formatos de vídeo

O nativo assiste e transmite os cinco formatos da web: H.264, VP8, VP9, AV1 e H.265. A opção de formato na web fica como está [a004].

- H.264 padrão e reserva: `42e01f;packetization-mode=1;level-asymmetry-allowed=1`, o único comum aos quatro navegadores [16].
- O Firefox recebe 1080p60 com 42e01f e 42001f (34–44 ms) e rejeita main/4d001f [19].
- O nível 3.1 não limitou nada no Firefox [19].
- O SDP só anuncia o que a máquina faz [20].
- O que não tem caminho é avisado e cai para H.264 [a005#1]: AV1 ao transmitir sem GPU recente e H.265 ao assistir sem GPU ou extensão.

### 2.4 Repasse e rede ruim

- O relay repassa RTP intacto [05 2a].
- Ele estima a banda de cada filho com `enable_bwe` + `set_unpaced(true)`, o que não somou atraso mensurável: 50,0 contra 49,7 ms [18].
- A estimativa reage a uma queda em ~250–280 ms [18].
- Abaixo de 0,9× por ~1 s, recodifica um degrau menor só para aquele filho. Volta acima de 1,25× por 10 s, troca só em keyframe e passa no mínimo 10 s em cada estado [09].
- Custo medido de 1080p60 → 720p: 4,2 ms/quadro, p95 ≤ 6,1, ~30 % de um núcleo e +15 pp de NVENC [18].
- **GPU ocupada** [a008#4]: o relay mede a própria folga. Se recodificar passar do prazo, o filho vai para outro relay com folga. Sem outro relay, limita e repassa o vídeo intacto. Com a GPU disputada, o p95 medido foi de 25–31 ms [18].
- Na perda de pacote, o espectador congela o último quadro e manda PLI, com limite de 1 a cada 500 ms subindo na árvore [08], [05 2a].
- O áudio dita o relógio [08].

### 2.5 Imagem completa (GOP)

GOP de 10 s, mais keyframe sob PLI ou quando entra um filho novo. O intervalo final depende de medição [a008#5]. Custo de keyframes grandes na árvore: não medido.

### 2.6 Distribuição

- **Instalador:** NSIS por usuário, pt-BR, reaproveitando `hooks.nsh` [r10].
- **Updater:** canal do GitHub (`releases/latest/download/latest.json`), mantendo o formato do `latest.json` e a assinatura minisign do updater [r10], [a008#2].
- **Sem assinatura de código paga:** o SmartScreen continua, com o passo a passo existente [a008#2].
- **Migração:** a última atualização do Tauri instala o nativo e remove o antigo [a008#3].

### 2.7 Fora do lançamento

- iPhone (Safari iOS/PWA) não é garantido na 1ª versão [a006#3]. A lista de verificação está em `research/19-firefox-1080p60.md`.
- AMD e Intel: risco a validar antes do lançamento [a006#4].

### 2.8 Web

Quem assiste pelo Firefox recebe uma dica de que no Chrome, no Edge ou no app fica mais leve. O Firefox mediu ~440 MB e 75–93 % de CPU a 1080p60 [19], [a008#7].

### 2.9 Catálogo de problemas conhecidos

Regra geral [a005#2]: cada problema tem aviso em linguagem simples, atalho quando houver e plano B automático quando der.

| Problema | Aviso ao usuário | Atalho | Plano B automático |
|---|---|---|---|
| Formato escolhido sem suporte neste PC (AV1 sem GPU RTX 40+/RDNA3+/Arc ao transmitir) [20] | "Seu PC não consegue enviar AV1. Mudamos para H.264." | Abrir configurações de formato | Transmite em H.264 42e01f sem parar |
| Extensão HEVC ausente (assistir H.265) [20] | "Para ver H.265 falta uma extensão gratuita do Windows." | Abrir a extensão HEVC na Microsoft Store | Pede ao pai o vídeo em H.264 (relay recodifica) |
| Sem GPU ou GPU sem encoder [03], [13] | "Sua placa de vídeo não codifica vídeo. A transmissão vai usar mais processador." | Dica de baixar resolução ou fps | MS H.264 software MFT: 1080p60 a ~1,5 núcleo e 91 MB neste PC [13] |
| Espectador rejeita o formato (hoje o presenter entra em pânico com `RemoteSdp missing a=ice-ufrag/pwd`) [19] | Nenhum para o espectador; no log: "formato recusado, usando H.264" | — | Trata a recusa sem pânico e renegocia em 42e01f |
| Erro `ProcessOutput 0x8000FFFF` do MFT após trocar o bitrate [13] | Só aparece se repetir: "O codificador falhou, reiniciando." | — | Descarta o quadro; se repetir, reinicia o stream do MFT com keyframe. Causa não investigada |
| Rede ruim de um espectador [09], [18] | Para o espectador: "Sua conexão está fraca, a qualidade foi reduzida." | Teste de velocidade | Recodifica um degrau menor só para ele; com a GPU ocupada, move para outro relay ou repassa intacto |
| GPU ocupada no relay (jogo) [18] | Para quem repassa: nenhum; no log | — | Move o filho para outro relay com folga; sem outro, repassa intacto |
| TURN fora do ar ou bloqueado [15] | "Não foi possível conectar pelo servidor de apoio. Pode ser firewall ou rede da empresa." | Tentar de novo / copiar diagnóstico | Tenta UDP, TCP e TLS 443, nessa ordem; renova a credencial de `/ice.json` antes de expirar |
| Áudio sem permissão ou dispositivo indisponível [r10] | "Não conseguimos acessar o áudio. Confira as permissões do Windows." | Abrir `ms-settings:privacy-microphone` | Transmite só vídeo e segue tentando |
| SmartScreen no instalador [r10] | Passo a passo existente ("Mais informações → Executar assim mesmo") | Página `/download` | — (só certificado resolve) |
| Navegador Firefox espectador pesado [19] | Dica na web: "No Chrome, no Edge ou no app fica mais leve." | Link de download do app | — |

A lista cresce a cada fatia do plano. Toda fatia acrescenta os problemas que descobrir.

## 3. Alternativas rejeitadas

| Alternativa | Motivo |
|---|---|
| Manter Tauri/WebView2 | 190–243 ms com captura real e transmissor 228 MB e relay ~215 MB [05 2b]; com H.264 por hardware, 534p46 [05 2c] |
| WebView2 enxuto + Encoded Transform no relay | O Edge descarta quadros repassados; a fachada não passa de ~30 fps e não funciona com H.264 [05 etapa 1, 2c] |
| `webrtc-rs` | Runtime assíncrono mais pesado, BWE parcial; fica como plano B [02] |
| `libdatachannel` | C++/OpenSSL no build, sem BWE [02] |
| SDKs NVENC/AMF/VPL diretos | Media Foundation cobre as três fabricantes com um caminho só; SDKs adiados [03] |
| egui | Fora na triagem do toolkit [04] |
| iced 0.14 | Sem acessibilidade; fica como reserva [04], [07] |
| Simulcast/SVC para rede ruim | Descartado em favor da recodificação sob demanda; L1T3 como reserva [09] |
| Forçar H.264 na árvore | Usuário quer os cinco formatos [a004#1] |
| Assinatura de código paga | Custo anual; mantido o passo a passo do SmartScreen [a008#2] |
| Biblioteca de áudio do WebRTC (APM) | Preferido o AEC/NS do Windows, mais leve [a008#6] |

## 4. Consequências

- **Reescrever:** WebRTC, voz, mixer, chat, moderação e UI (~1900 linhas JS em `web/`, soma de ~590 + 1352) [r10].
- **Reaproveitar:** áudio do sistema, bandeja, CLI, deep link e servidor configurável [r10]. Servidor e protocolo não mudam [11].
- **O app implementa** o que o str0m não traz: cliente TURN (300–500 linhas estimadas [15]), jitter buffer, estados, RTT e prazos, e Opus [11].
- **Instalador:** libvpx e dav1d entram nele [20]. Tamanho final não medido.
- **RAM:** o device wgpu DX12 sozinho custa 76 MB de working set e 123–125 MB de private (resumo e tabela do r07 divergem) [07]. O app com vídeo mediu 155 MB de working set e 308 MB de private [07]. A meta de < 200 MB é contra o working set; private bytes passa de 200 MB e fica registrado.

## 5. Riscos

| Risco | Evidência | Tratamento |
|---|---|---|
| CPU do redesenho Slint/femtovg a 60 Hz: 85–89 % de um núcleo com vídeo; 78 % só trocando texto | [07] | Fatia 1 testa `renderer-skia`, redesenho parcial ou swap chain/DirectComposition própria sob a UI [a008#9] |
| AMD e Intel não medidos (perfis, troca ao vivo, `FLUSH` na Intel) | [03], [14] | Fatia de validação antes do lançamento [a006#4] |
| Qualidade do AEC/NS do Windows varia por PC e microfone | não medido | Medir na fatia de voz; reserva: APM do WebRTC |
| BWE entre dois relays nativos ausente ou incoerente | [18] | Investigar na fatia de recodificação |
| Latência até o vsync/composição | não medida; p50 16,5 ms só até o submit [07] | Medir na fatia de assistir |
| Segundo PC e rede real entre máquinas | não validados [05], [a002#6] | Fatia antes do lançamento |
| Recodificação com a GPU disputada (p95 25–31 ms) | [18] | Realocação ou repasse intacto [a008#4] |
| TURN não testado contra coturn ou Cloudflare TLS 443 | [15] | Fatia de TURN |
| Extensões da Store ausentes, build C de libvpx/dav1d, VP9 perfil 2 (P010) | [20] | Fatia de formatos |
| Erro `0x8000FFFF` do MFT | [13] | Recuperação no catálogo; causa a investigar |
| Rede ruim não comparada com a web (proxy TURN local satura com 3 × 8 Mbps) | [05] | Fatia de segundo PC |
| Migração automática atinge todos de uma vez | [a008#3] | Fatia de migração com rollback |
