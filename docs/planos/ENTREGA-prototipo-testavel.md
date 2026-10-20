# ENTREGA-prototipo-testavel

Modo: 🔁 Loop. Plano: `PLANO-prototipo-testavel.md`. Data: 2026-10-19.

## Mudanças
- `web/app.js`:
  - Fila serializada de mensagens: o ICE candidate não corre mais na frente do SDP.
  - `ontrack` reenvia o stream só no evento de vídeo. Antes disparava 2× por causa do áudio e derrubava o filho.
  - Auto-entrada por `?room=`, link de convite e botão copiar.
  - Estatísticas ao vivo (`getStats`): resolução, fps, kbps, buffer.
  - Erros aparecem em destaque e também vão para o `console.error`.
- `web/index.html`: tokens de cor claro/escuro (`prefers-color-scheme`), bloco de convite e linha de estatísticas.
- `e2e/run.js` + `npm run e2e`: puppeteer-core com o Chrome instalado. A captura é um canvas animado.
- `README.md`: roteiro de teste automático, manual e LAN.

## Verificação
- `npm test`: 10/10.
- `npm run e2e`: **OK**.
  - Viewer 1 direto (buffer 120 ms), 1280×720 a 57 fps, ~1,1 Mbps.
  - Viewers 2 e 3 via relay (buffer 90 ms), 480×270 a 55 fps, ~0,4 Mbps.
  - Re-parent após a saída do relay: OK.

## Observações honestas
- Na mesma máquina o Chrome reduz a resolução: um só CPU codifica para todos, e o ramp-up dura só 6 s. Os 15 Mbps de 1440p60 **ainda não foram medidos**; isso exige PCs separados.
- O relay re-codifica no navegador, por isso a resolução cai a cada salto. A solução prevista é o cliente nativo (Tauri), que encaminha sem re-codificar.

## Próximos passos
1. Teste em 2+ PCs na LAN (roteiro no README).
2. TURN para uso fora da LAN.
3. Medir upload e RTT reais.
4. Tauri (exige instalar Rust).
5. Bot do Discord.
