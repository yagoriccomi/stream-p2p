# 04 — Toolkit de UI nativa: Slint × egui × iced

Ticket: [04-toolkit-ui-nativa-windows.md](../04-toolkit-ui-nativa-windows.md). Consultado em 2026-11-08.

## Veredito

**Finalista para o protótipo (07): Slint** (`slint` 1.18.x, renderizador wgpu, feature `unstable-wgpu-30`).
Reserva: **iced 0.14** só se o 07 mostrar que a importação de textura do Slint obriga a mais uma cópia.
egui fica de fora: o modelo de modo imediato não combina com reproduzir a UI web atual.

## Comparação

| Critério | Slint 1.18.1 | egui/eframe 0.37 | iced 0.14.0 |
|---|---|---|---|
| Licença | GPLv3 **ou** Royalty-Free (apps proprietários desktop/mobile, sem embarcado) **ou** comercial [S1] | MIT OR Apache-2.0 [E1] | MIT [I1] |
| Compatível com este repo (GPLv3, `LICENSE`) | Sim, por qualquer uma das opções | Sim | Sim |
| Maturidade declarada | 1.x estável; **a API wgpu é instável**: "may be removed or changed in future minor releases" (por isso fixar `~1.18`) [S2] | 0.x | Docs: iced é "**experimental** software" e "very unforgiving" [I1] |
| Modelo de UI | Linguagem declarativa `.slint` (propriedades, bindings, estados) | Modo imediato (a UI é redesenhada a partir do código a cada quadro) | Elm (estado/mensagem/view) |
| Proximidade de HTML/CSS (`web/index.html` 381 linhas, `styles.css` 227) | Alta: árvore declarativa com layout e estilo; port quase 1:1 | Baixa: o estilo é global e o layout é manual | Média: o layout é feito em código Rust |
| Acessibilidade | AccessKit no backend winit (PR #2865, 2023) [S4]; `accessible-role`/`-label`/ações e landmarks [S5]; feature `accessibility` ligada por padrão [S3] | AccessKit; feature `accesskit` ligada por padrão [E2] | **Ausente**. Issue #552 aberta desde 2020, "help wanted" [I3]; nada sobre isso nas releases [I4] |
| Textura wgpu externa | `slint::Image::try_from(wgpu::Texture)` com o **mesmo** `Device`/`Queue` (`WGPUConfiguration::Manual` ou `set_rendering_notifier`); também dá para desenhar por baixo ou por cima da UI [S2] | `Renderer::register_native_texture`: "Texture must have the texture format `Rgba8Unorm`" [E1] | Widget `shader` (feature `wgpu`): `Program`/`Primitive`/`Pipeline` próprios, com acesso direto ao pipeline [I2] |
| wgpu | 29 ou 30 [S2] | 30 [E1] | (versão não conferida) |

O web usa `aria-*` 67 vezes em `web/index.html`. Paridade de acessibilidade elimina o iced hoje.

## Vídeo 1080p60 na GPU com o mínimo de cópias

Caminho comum aos três (todos usam wgpu no backend DX12):

1. O decodificador Media Foundation entrega uma textura D3D11 (NV12). `MF_SA_D3D11_BINDFLAGS` é só uma **dica**: o MFT "can ignore the attribute" [M1]. Por isso, conte com **uma cópia na GPU**: `VideoProcessorBlt`/`CopyResource` para uma textura própria criada com `D3D11_RESOURCE_MISC_SHARED_NTHANDLE`.
2. `ID3D12Device::OpenSharedHandle` sobre o device DX12 do wgpu (`Device::as_hal::<Dx12>()`) [W1].
3. `wgpu_hal::dx12::Device::texture_from_raw(...)` e depois `wgpu::Device::create_texture_from_hal(...)` [W1][W2]. A `drop_callback` avisa quando o recurso pode ser reutilizado [W2]. O padrão é usado em código de terceiros, como o `cef-rs` da Tauri [X1].

Diferença por toolkit no último passo:
- **Slint**: o `Image::try_from` não documenta formatos aceitos (o exemplo usa `Rgba8Unorm`) [S2]. Converta para RGBA no próprio passo 1 (o VideoProcessor faz NV12→RGBA na mesma cópia). Alternativa sem conversão: underlay via `set_rendering_notifier`, amostrando NV12 com shader próprio. **O 07 precisa verificar** se `try_from` evita cópia interna.
- **egui**: exige `Rgba8Unorm` [E1]. Mesmo custo do Slint (uma cópia com conversão).
- **iced**: o shader próprio pode amostrar NV12 direto. É o caminho tecnicamente mais curto, mas não compensa a falta de acessibilidade.

Mínimo realista nos três: **1 cópia/conversão na GPU, 0 cópias na CPU**.

## RAM < 50 MB

Nenhuma fonte primária publica a RAM de um app wgpu equivalente. **Não medido**: o 07 deve medir o working set com o vídeo ativo. O custo fixo de wgpu/DX12 e dos drivers é parecido nos três, então isso não muda a escolha.

## Riscos para o 07

- A API `unstable-wgpu-30` do Slint pode quebrar em minor: fixar `~1.18` [S2].
- Garantir o mesmo adapter (LUID) entre o device D3D11 do decoder e o device DX12 do wgpu, senão o `OpenSharedHandle` falha.
- Sincronização entre a escrita D3D11 e a leitura D3D12: usar fence ou keyed mutex.
- Acessibilidade de `TextInput` no Slint teve lacunas históricas [S6]. Testar com Narrador/Accessibility Insights.

## Fontes

- [S1] Slint, preços e licenças: https://slint.dev/pricing
- [S2] `slint::wgpu_30` (docs.rs, 1.18.1): https://docs.rs/slint/latest/slint/wgpu_30/index.html
- [S3] Features do `slint`: https://docs.rs/crate/slint/latest/features
- [S4] Slint PR #2865 "Initial AccessKit support": https://github.com/slint-ui/slint/pull/2865
- [S5] Propriedades `accessible-*`: https://docs.slint.dev/latest/docs/slint/reference/common/
- [S6] Slint issue #2895 (acessibilidade de text input): https://github.com/slint-ui/slint/issues/2895
- [E1] `egui_wgpu::Renderer` 0.37.0: https://docs.rs/egui-wgpu/latest/egui_wgpu/struct.Renderer.html
- [E2] `eframe` 0.37.0: https://docs.rs/eframe/latest/eframe/
- [I1] `iced` 0.14.0: https://docs.rs/iced/latest/iced/
- [I2] `iced::widget::shader`: https://docs.rs/iced/latest/iced/widget/shader/index.html
- [I3] iced issue #552 (acessibilidade): https://github.com/iced-rs/iced/issues/552
- [I4] Releases do iced: https://github.com/iced-rs/iced/releases
- [W1] `wgpu::Device` 30.0.1 (`create_texture_from_hal`, `as_hal`): https://docs.rs/wgpu/latest/wgpu/struct.Device.html
- [W2] `wgpu-hal` DX12 `texture_from_raw`: https://github.com/gfx-rs/wgpu/blob/trunk/wgpu-hal/src/dx12/device.rs
- [M1] Microsoft, `MF_SA_D3D11_BINDFLAGS`: https://learn.microsoft.com/en-us/windows/win32/medfound/mf-sa-d3d11-bindflags
- [X1] Exemplo de importação D3D11→D3D12→wgpu, `cef-rs`: https://github.com/tauri-apps/cef-rs/blob/02cd5a01/cef/src/osr_texture_import/d3d11.rs
