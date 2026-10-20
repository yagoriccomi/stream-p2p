# PLANO-prototipo-testavel

Modo: 🔁 Loop. Data: 2026-10-19.

## Enunciado canônico
- **Problema:** o MVP nunca transmitiu vídeo de verdade. Só a sinalização foi testada.
- **Resultado esperado:** vídeo chega do host ao viewer direto e aos relays. Há um teste automático que prova isso e um roteiro manual para LAN.
- **Como validar:** `npm test` e `npm run e2e` verdes. Cada viewer com `videoWidth > 0` e bitrate medido pelo `getStats`.

## Escopo negativo [#8]
Fora deste plano: Tauri/NVENC (sem Rust), bot do Discord, TURN, autenticação, deploy.

## Premissas assumidas
1. O E2E troca `getDisplayMedia` por um canvas animado (`captureStream`). Assim o teste não depende de diálogo do sistema; o pipeline WebRTC testado é o mesmo [#43].
2. `puppeteer-core` entra como devDependency e usa o Chrome já instalado, sem baixar navegador [#6].
3. Na LAN, o host abre em `localhost`, porque `getDisplayMedia` exige contexto seguro. Os viewers usam `http://<IP>:3000/?room=X`, já que RTCPeerConnection funciona sem HTTPS.

## Decisão visual
- **Mockup: não.** Os ajustes são pontuais na bancada: link de convite, auto-entrada por `?room=` e linha de estatísticas.
- Cada ajuste passa pela `design-de-interface-projeto`.

## Passos
1. `web/app.js`: serializar `onmessage`. Hoje um ICE candidate pode ser processado antes de `setRemoteDescription` e ser descartado em silêncio [#92].
2. `web/app.js`: `ontrack` só re-oferece aos filhos no evento de vídeo. Hoje com áudio dispara 2× e derruba a 1ª conexão [#2].
3. `web/app.js` + `index.html`: link de convite, `?room=` auto-join e estatísticas (kbps, fps, resolução) a cada 2 s.
4. `e2e/run.js` + script `npm run e2e`: 1 host em 1440p60 com 20 Mbps e 3 viewers; checa o vídeo em todos e o kbps.
5. README com o roteiro de teste manual e de LAN.
6. `git init` e commits atômicos [#31][#32].

## Riscos / rollback
O Chrome headless pode não decodificar vídeo. Nesse caso o teste roda com `headless: false` [#84]. Não há dados nem produção envolvidos.

## Definição de pronto
`npm test` e `npm run e2e` verdes, ENTREGA escrita, commits feitos.
