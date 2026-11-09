---
Type: research
Status: resolved
Blocked by: none
---

# Relay recodifica só para filho com rede ruim

Decisão (answers 003 #9): relay repassa RTP intacto e recodifica em resolução menor só para o filho que não aguenta. Pergunta: como o relay str0m estima a banda de cada filho (TWCC/REMB/GCC no str0m 0.25), quando ligar/desligar a recodificação sem travar a imagem, e qual o custo (CPU/GPU, atraso extra) de decode+encode por filho? Base: `e2e/bench/native/src/main.rs`.

## Resolução (2026-11-08)
Banda por filho: `enable_bwe` no `Rtc` de cada filho (GCC+TWCC do str0m 0.25), evento `EgressBitrateEstimate::Twcc`; `set_unpaced(true)` evita rajadas de 40 ms; `set_bitrate(desired = bitrate do pai)` para sondar. Histerese assimétrica: liga recodificação < 0,9× por ~1 s; volta ao repasse > 1,25× por 10 s; mínimo 10 s por estado; troca só em keyframe (PLI ao pai), numeração/timestamp por filho; PLI de filho recodificado vai ao encoder local. Custo: 1 decoder por relay + 1 encoder por degrau fixo na GPU (GeForce: 12 sessões NVENC); sem GPU, só degrau baixo. Estimado 8–14 ms por salto recodificado, NÃO medido (só encode 4,6 ms no 05). Simulcast/SVC descartados; L1T3 como reserva. Ver `research/09-relay-recodifica.md`.
