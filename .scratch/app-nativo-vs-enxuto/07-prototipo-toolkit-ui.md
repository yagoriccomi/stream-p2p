---
Type: prototype
Status: resolved
Blocked by: 04
---

# Protótipo mínimo do toolkit finalista

Pergunta: a finalista da 04 mostra uma tela no visual atual da web (`web/`) com um vídeo 1080p60 renderizado pela GPU, abaixo de 50 MB de RAM? Decide o toolkit.

Finalista (04): Slint 1.18 + wgpu. Verificar: RAM < 50 MB medida; se `Image::try_from` copia a textura; device wgpu compartilhado com o vídeo; Narrador lê os campos de texto. Se falhar, repetir com iced 0.14.

Do 08: usar o caminho real de vídeo (MFT decoder D3D11 → textura compartilhada → wgpu DX12), forçar o Slint em DX12, medir latência decode+apresentação e fence D3D11↔D3D12.

## Resolução (2026-11-09)

Slint 1.18 + wgpu 30 DX12 mostra 1080p60 decodificado na GPU sem cópia para CPU: MF decoder D3D11 → VideoProcessorBlt RGBA em pool compartilhado → `OpenSharedHandle` → `texture_from_raw` → `Image::try_from` (não copia), mesmo device wgpu do Slint, mesmo adaptador, fences D3D11↔D3D12 funcionando. 58,6–58,9 fps; entrada no decoder → submit do quadro p50 16,5–16,7 ms, p95 23,4–23,9 ms. UIA expõe "Seu nome" (Edit, valor) e "Entrar" (Button).
Reprovado: RAM 155 MB working set / 308 MB private com vídeo (116 / 263 só UI; 76 / 125 só do device wgpu DX12), longe de < 50 MB. CPU 85–89 % de um núcleo, quase todo do redesenho do Slint/femtovg a 60 Hz (78 % trocando só um texto).
Detalhes: `research/07-prototipo-slint.md`; resultados `e2e/bench/results/p07-*`; código `e2e/bench/proto07/`. Só NVIDIA, fonte em arquivo (sem rede).
