# 03 — Captura WGC → D3D11 → H.264 em todas as GPUs

Ticket: `../03-captura-windows-graphics-capture.md`. Base: `e2e/bench/native/src/bin/presenter.rs` (WGC → D3D11 video processor BGRA→NV12 → MFT H.264 de hardware via `MFTEnumEx(HARDWARE|SORTANDFILTER)`, `MFT_MESSAGE_SET_D3D_MANAGER`, `ICodecAPI` CBR/low-latency/sem B; testado só em RTX 4060 Ti).

## Resumo

O caminho que já existe (Media Foundation + `ICodecAPI`) cobre NVIDIA, AMD e Intel com uma única base de código. A Microsoft define um contrato de certificação que os encoders de hardware H.264 precisam cumprir, e esse contrato inclui taxa de bits média e keyframe forçado. As três fabricantes publicam MFTs H.264 de hardware. Para mudar a resolução, o mesmo MFT precisa reiniciar o stream, e o Chromium faz isso em produção. Os SDKs nativos (NVENC, AMF, VPL) dão mais controle, mas triplicam o código. Ficam para quando algum fabricante falhar nos testes.

## Comparativo

| Caminho | API em Rust | Bitrate em tempo real | Resolução em tempo real | Licença / custo |
|---|---|---|---|---|
| **MF hardware MFT** (NVIDIA/AMD/Intel) | `windows` 0.62 (já em uso) | Sim: `CODECAPI_AVEncCommonMeanBitRate` é obrigatória na certificação HCK [1]; no encoder MS "you can set the average bit rate during encoding" [1]. O Chromium faz isso sem recriar o encoder [5] | Sim, com reinício do stream no mesmo MFT: END_OF_STREAM/END_STREAMING → `SetOutputType`/`SetInputType` com o novo `MF_MT_FRAME_SIZE` → BEGIN/START. Gera IDR. Na Intel é preciso enviar `MFT_MESSAGE_COMMAND_FLUSH` antes, senão dá 0x80004005 [5] | Parte do Windows; driver da fabricante |
| **NVENC direto** | sem crate oficial; FFI do Video Codec SDK | `NvEncReconfigureEncoder` [2] | `NvEncReconfigureEncoder`, só até o `maxEncodeWidth/Height` definido na criação; recomenda `forceIDR` [2] | SDK proprietário NVIDIA |
| **AMF direto** | FFI do SDK (MIT, GPUOpen) | propriedade de rate control (`TARGET_BITRATE`); a doc não a marca explicitamente como dinâmica [3] | `FRAMESIZE` é **estática** [3]; existe `AMFComponent::ReInit(width, height)` [4] | AMF SDK |
| **Intel VPL direto** | FFI do oneVPL | `MFXVideoENCODE_Reset` | `Reset`; se precisar de nova alocação, retorna `MFX_ERR_INCOMPATIBLE_VIDEO_PARAM` e é preciso fechar e reabrir [6] | MIT |
| **SW: MS H.264 MFT** (`Mfh264enc.dll`) | `windows` (mesmo código, sem a flag HARDWARE) | Sim, desde o Windows 8 [1] | Mesmo reinício de stream | Vem com o Windows |
| **SW: OpenH264** | crate `openh264` 0.9.9 (BSD-2) [7] | não confirmado na doc da crate | Sim ("v0.6 – Encoder supports dynamic resolution") [7] | Patente coberta **só** pelo binário da Cisco baixado à parte, nunca embutido no instalador, com opção de ligar/desligar e crédito na UI; uso pessoal ou sem remuneração [8]. A feature padrão `source` compila do código-fonte e fica **sem** a cobertura de patente [7][8] |

### Latência (fontes)
- Encoder MS em software: o modo low-latency (padrão) usa slices em paralelo e "minimize[s] latency"; multi-frame "introduces more latency" [1].
- NVENC: para streaming com banda limitada, "Ultra-low latency, with CBR". Com GOP infinito, recomenda intra refresh [2].
- AMF: `USAGE_ULTRA_LOW_LATENCY` ("Video game streaming") e `LOWLATENCY_MODE`, ambas estáticas. "In low latency modes output becomes available as soon as the first submitted frame is encoded" [3].
- Números medidos: só NVENC via MF, 8–12 ms por salto (ticket 05). Não há medição em AMD, Intel ou software.

### Cópia para a CPU
- Hardware MFT + `IMFDXGIDeviceManager`: a textura NV12 vai direto, sem cópia (já é assim no presenter). O Chromium só envia o device manager se o `MFT_ENUM_ADAPTER_LUID` do MFT for igual ao adaptador do device. Se falhar, cai para caminho não-D3D [5]. **Notebook híbrido**: o WGC e o encoder precisam estar no mesmo adaptador. Hoje o presenter não confere isso.
- Fallback software (MS MFT ou OpenH264): é **obrigatório** ler a textura de volta (staging NV12 → `Map`). Isso é inferência: o encoder MS só lista formatos de sistema [1]. Custo esperado de alguns ms a 1080p, não medido.

### Peculiaridades de fabricante já documentadas (Chromium [5])
- NVIDIA: o MFT é **pulado para constrained-baseline** (crbug 1088650). O presenter usa justamente `eAVEncH264VProfile_ConstrainedBase` e funcionou na bancada, mas o Chromium evita esse caso. Testar Baseline/Main.
- Intel: exige `FLUSH` antes de trocar a resolução. Também quer o número de camadas explícito.
- Intel/NVIDIA: keyframe só na camada T0 quando há SVC (não se aplica sem camadas temporais).
- Taxa de quadros: o Chromium **não** muda o fps depois da inicialização, porque isso reinicia o stream e gera keyframe. Em vez disso, escala a bitrate proporcionalmente.

## Recomendação

1. **Manter Media Foundation como caminho único** para NVIDIA, AMD e Intel. Generalizar o `presenter.rs`:
   - trocar `unwrap` por tratamento de erro;
   - escolher o MFT pelo `MFT_ENUM_ADAPTER_LUID` igual ao adaptador da captura;
   - bitrate: `SetValue(CODECAPI_AVEncCommonMeanBitRate)` a quente;
   - resolução: sequência de reinício do stream do Chromium (FLUSH → END → tipos → BEGIN), no mesmo MFT, com keyframe;
   - fps: fixo, ajustado pela bitrate.
2. **Fallback software = MFT H.264 da Microsoft** (o mesmo código, só que com `MFT_ENUM_FLAG_SYNCMFT`, mais readback NV12). Não adiciona dependência, licença nem download separado. Usar OpenH264 só se o MFT MS faltar (por exemplo, Windows N sem Media Feature Pack; não verificado aqui), e nesse caso com o binário da Cisco baixado em tempo de execução.
3. **SDKs nativos (NVENC/AMF/VPL): adiar.** Adotar só se o teste em hardware real mostrar que o MFT de alguma fabricante falha em latência ou na troca de resolução.
4. **Pendente de medição** (sem dado, não extrapolar):
   - AMD e Intel reais: latência por salto e troca de resolução;
   - fallback software a 1080p60: CPU e ms;
   - o comportamento do NVIDIA MFT com ConstrainedBaseline fora da 4060 Ti.

## Fontes
1. Microsoft Learn, H.264 Video Encoder (propriedades, CBR, multithreading, HCK): https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder
2. NVIDIA Video Codec SDK 13.0, NVENC Programming Guide (`NvEncReconfigureEncoder`, D3D11, low latency): https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html
3. AMD AMF, AMF_Video_Encode_API.md: https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/doc/AMF_Video_Encode_API.md
4. AMD AMF, `Component.h` (`ReInit`): https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/public/include/components/Component.h
5. Chromium, `media_foundation_video_encode_accelerator_win.cc`: https://chromium.googlesource.com/chromium/src/+/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc
6. Intel VPL, Encoding procedures (`MFXVideoENCODE_Reset`): https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_encoding.html
7. crate `openh264` 0.9.9: https://docs.rs/openh264/latest/openh264/
8. Cisco OpenH264 Binary License: https://www.openh264.org/BINARY_LICENSE.txt
9. Microsoft Learn, Handling Stream Changes ("Encoders should only accept an input type that matches the currently configured output type"): https://learn.microsoft.com/en-us/windows/win32/medfound/handling-stream-changes
