# Handoff: Arquitetura de Transmissão de Tela P2P Híbrida (`stream-p2p`)

**Data:** 19/10/2026  
**Projeto:** Stream-P2P  
**Foco da Sessão:** Concepção arquitetural, viabilidade técnica, estratégias de rede mista (Mesh + Árvore/Relay), limite de conexões dinâmicas por largura de banda e sincronização de latência para aplicação de transmissão de tela de alta performance (720p30, 1080p60 e 1440p60).

---
## 1. Resumo das Decisões Arquiteturais Tomadas

* **Modelo Híbrido Avançado (Mesh + Árvore/Relay Dinâmico):** 
  * O host mede sua taxa de upload disponível na inicialização.
  * O sistema define uma cota estricta de conexões diretas (ex: para 1440p a 60fps consumindo ~15 Mbps, o host aceita no máximo 1 ou 2 conexões diretas).
  * Os espectadores excedentes entram na **rede mista (Árvore/Relay)**, conectando-se automaticamente aos peers anteriores que passam a atuar como *seeds* de retransmissão, protegendo a banda do host contra saturação.
* **Sincronização Uniforme de Latência:**
  * Para evitar desincronização entre reações de chat de voz (Discord) e vídeo, o buffer do player WebRTC em cada cliente ajusta um atraso intencional nivelado, mantendo o atraso para todos os espectadores entre **90ms e 150ms**.
* **Captação de Alta Performance (Zero-Copy):**
  * Utilização de captura direto na VRAM via APIs nativas do sistema operacional (`Windows.Graphics.Capture` / DXGI) e codificação de hardware dedicada na GPU (NVENC, AMF, QuickSync) com impacto mínimo na performance do jogo.
* **Orquestração via Bot do Discord (Compliance):**
  * Uso exclusivo da API oficial de bots do Discord apenas como camada social e de sinalização (gerador de links e controle de salas), sem violar diretrizes ou utilizar *self-bots* na infraestrutura de voz oficial.

---

## 2. Próximos Passos Recomendados para a Próxima Sessão

1. **Inicialização do Projeto (Scaffold):** Executar a criação do repositório estrutural da aplicação (Front-end Web / Cliente Nativo Tauri + Servidor de Sinalização).
2. **Desenho do Servidor de Sinalização (Node.js/WebSockets):** Implementar a lógica de roteamento e atribuição de cotas (quem conecta direto ao host vs. quem vira relay).
3. **Protótipo WebRTC (MVP):** Testar o destravamento de bitrate no SDP (`b=AS:`) para suportar os modos 720p30, 1080p60 e 1440p60.

---