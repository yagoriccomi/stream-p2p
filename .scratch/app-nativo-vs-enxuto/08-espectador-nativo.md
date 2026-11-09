---
Type: research
Status: resolved
Blocked by: none
---

# Espectador nativo: decode e render na GPU

Pergunta: como decodificar H.264 recebido via str0m na GPU (Media Foundation/D3D11VA, por fabricante) e entregar a textura ao toolkit de UI sem cópia para CPU? Latência esperada de decode+apresentação, tratamento de perda/keyframe, e como encaixa em Slint/egui/iced.

## Resolução (2026-11-08)
str0m `MediaData` (Annex B, keyframe, `contiguous`; já reordena e faz NACK) → MS H.264 decoder MFT com D3D11 manager (NVIDIA/AMD/Intel + software automático; `CODECAPI_AVLowLatencyMode` é `VT_UI4`) → `VideoProcessorBlt` NV12→RGBA em textura compartilhada (handle NT) → D3D12 `OpenSharedHandle` → wgpu `create_texture_from_hal`; 0 cópias CPU; toolkit precisa wgpu em DX12. Perda: congela último quadro + PLI com limite. Áudio Opus via WASAPI é o relógio, sincronia por Sender Reports. Latência não medida. Ver `research/08-espectador-nativo.md`.
