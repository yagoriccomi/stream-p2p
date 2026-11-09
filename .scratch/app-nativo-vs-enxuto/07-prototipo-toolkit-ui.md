---
Type: prototype
Status: open
Blocked by: 04
---

# Protótipo mínimo do toolkit finalista

Pergunta: a finalista da 04 mostra uma tela no visual atual da web (`web/`) com um vídeo 1080p60 renderizado pela GPU, abaixo de 50 MB de RAM? Decide o toolkit.

Finalista (04): Slint 1.18 + wgpu. Verificar: RAM < 50 MB medida; se `Image::try_from` copia a textura; device wgpu compartilhado com o vídeo; Narrador lê os campos de texto. Se falhar, repetir com iced 0.14.

Do 08: usar o caminho real de vídeo (MFT decoder D3D11 → textura compartilhada → wgpu DX12), forçar o Slint em DX12, medir latência decode+apresentação e fence D3D11↔D3D12.
