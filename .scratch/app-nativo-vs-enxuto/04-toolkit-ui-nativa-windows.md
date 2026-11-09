---
Type: research
Status: resolved
Blocked by: none
---

# Toolkit de UI nativa

Slint vs egui vs iced: reproduzir a UI atual com < 50 MB de RAM, incluindo vídeo do espectador renderizado por GPU.

## Resolução (2026-11-08)
Finalista: Slint 1.18 com wgpu (`unstable-wgpu-30`, fixar `~1.18`); reserva iced 0.14; egui fora. Motivos: `.slint` porta `index.html`/`styles.css` quase 1:1, GPLv3/Royalty-Free compatível, acessibilidade via AccessKit (iced não tem). Vídeo: D3D11 do decoder → 1 cópia GPU NV12→RGBA em textura compartilhada → wgpu DX12 → `slint::Image::try_from(wgpu::Texture)`; 0 cópias na CPU. Ver `research/04-toolkit-ui.md`.
