//! Native relay for the ticket 05 benchmark (scenario 3): one node of
//! presenter → relay 1 → relay 2 → viewer, with no browser and no video pipeline.
//! It receives the parent's VP8 RTP packets with str0m and writes them, untouched,
//! to every child. Key-frame requests from children go up to the parent (one every 500 ms).
//!
//! Signaling is JSON lines. stdin:  {"from":N,"sdp":{..}} | {"from":N,"candidate":{..}} |
//! {"cmd":"child","id":N} | {"cmd":"stats"}.  stdout: {"to":N,"sdp":{..}} | {"stats":{..}}.
use std::io::{BufRead, Write};
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::media::{Direction, KeyframeRequestKind, MediaKind, Mid};
use str0m::net::{Protocol, Receive};
use str0m::rtp::RtpWrite;
use str0m::bwe::{Bitrate, BweKind};
use str0m::{Candidate, Event, Input, Output, Rtc};

struct Peer {
    id: u64,
    rtc: Rtc,
    mid: Option<Mid>,
    pending: Option<SdpPendingOffer>,
}

#[derive(Default)]
struct Stats {
    pkts_in: u64,
    bytes_in: u64,
    pkts_out: u64,
    bytes_out: u64,
    key_asks: u64,
    child_plis: u64,
    /// RELAY_BWE: (ms since start, child id, estimate kbps) per EgressBitrateEstimate.
    bwe: Vec<(u64, u64, u64)>,
}

/// RELAY_BWE=<kbps>: GCC/TWCC toward children, initial and desired estimate in kbps.
/// RELAY_BWE_PACED=1 keeps the pacer (default with BWE: set_unpaced(true)).
fn bwe_kbps() -> Option<u64> {
    std::env::var("RELAY_BWE").ok().map(|v| v.parse().unwrap_or_else(|_| {
        eprintln!("Erro de configuração: RELAY_BWE inválido: {v:?}");
        std::process::exit(1);
    }))
}

fn h264_profile(value: Option<&str>) -> Result<u32, String> {
    let Some(value) = value else { return Ok(0x42e01f) };
    let invalid = || format!("SP2P_H264_PROFILE inválido: {value:?}");
    if value.len() != 6 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let profile = u32::from_str_radix(value, 16).map_err(|_| invalid())?;
    let [_, idc, iop, level] = profile.to_be_bytes();
    // str0m 0.25: packet/h264_profile.rs (parser privado). Máscaras de PROFILES
    // e níveis de H264LevelIdc; revisar junto de uma atualização da dependência.
    let supported = match idc {
        0x42 => iop & 0x0f == 0,
        0x4d => iop & 0x0f == 0 && (iop & 0x80 != 0 || iop & 0x20 == 0),
        0x58 => iop & 0x0f == 0 && iop & 0xc0 != 0x40,
        0x64 => matches!(iop, 0 | 0x0c),
        0x6e | 0x7a | 0xf4 => matches!(iop, 0 | 0x10),
        0x2c => iop == 0x10,
        _ => false,
    };
    if !supported || !matches!(level, 0 | 10 | 11 | 12 | 13 | 20 | 21 | 22 | 30 | 31 | 32 | 40 | 41 | 42 | 50 | 51 | 52) {
        return Err(invalid());
    }
    Ok(profile)
}

fn new_rtc(addr: SocketAddr, profile: u32, bwe: Option<u64>) -> Rtc {
    let mut b = Rtc::builder().set_rtp_mode(true).clear_codecs().enable_bwe(bwe.map(Bitrate::kbps));
    if std::env::var("SP2P_CODEC").as_deref() == Ok("h264") {
        b.codec_config().add_h264(102.into(), Some(103.into()), true, profile);
    } else {
        b = b.enable_vp8(true);
    }
    let mut rtc = b.build(Instant::now());
    if let Some(k) = bwe {
        rtc.bwe().set_bitrate(Bitrate::kbps(k / 10), Bitrate::kbps(k));
    }
    rtc.add_local_candidate(Candidate::host(addr, "udp").unwrap());
    rtc
}

fn out(v: Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

/// Sends what the peer has queued; returns its next timeout and collects its events.
fn drain(p: &mut Peer, sock: &UdpSocket, evs: &mut Vec<Event>) -> Instant {
    loop {
        match p.rtc.poll_output() {
            Ok(Output::Timeout(t)) => return t,
            Ok(Output::Transmit(t)) => {
                let _ = sock.send_to(&t.contents, t.destination);
            }
            Ok(Output::Event(e)) => evs.push(e),
            Err(e) => {
                eprintln!("peer {}: {e:?}", p.id);
                p.rtc.disconnect();
                return Instant::now() + Duration::from_secs(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::h264_profile;

    #[test]
    fn default_only_when_absent() {
        assert_eq!(h264_profile(None).unwrap(), 0x42e01f);
        for value in ["", " 42e01f", "42e01f ", "+2e01f", "0x42e01f", "142e01f", "zzzzzz", "42e01"] {
            assert!(h264_profile(Some(value)).unwrap_err().contains("SP2P_H264_PROFILE"));
        }
    }

    #[test]
    fn profiles_and_levels_supported_by_str0m_025() {
        for value in ["42e01f", "42001f", "4D801F", "4d001f", "58c01f", "58801f", "58001f", "64001f", "640c1f", "6e001f", "6e101f", "7a001f", "7a101f", "f4001f", "f4101f", "2c101f", "42f00a", "420000", "420034"] {
            assert_eq!(h264_profile(Some(value)).unwrap(), u32::from_str_radix(value, 16).unwrap());
        }
        for value in ["000000", "ffffff", "42e11f", "4d201f", "58401f", "64101f", "6e0c1f", "2c001f", "42e009", "42e035", "42e03c"] {
            assert!(h264_profile(Some(value)).is_err(), "{value}");
        }
    }
}

fn main() {
    let profile = std::env::var("SP2P_H264_PROFILE")
        .map(Some)
        .or_else(|e| match e {
            std::env::VarError::NotPresent => Ok(None),
            _ => Err(format!("SP2P_H264_PROFILE inválido: {e}")),
        })
        .and_then(|value| h264_profile(value.as_deref()))
        .unwrap_or_else(|e| {
            eprintln!("Erro de configuração: {e}");
            std::process::exit(1);
        });
    str0m::crypto::from_feature_flags().install_process_default();
    let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
    let addr = sock.local_addr().unwrap();
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
        std::process::exit(0); // harness closed stdin
    });

    let mut parent: Option<Peer> = None;
    let mut children: Vec<Peer> = vec![];
    let mut stats = Stats::default();
    let mut last_ask = Instant::now() - Duration::from_secs(10);
    let mut want_key = false;
    let mut buf = vec![0u8; 2000];
    let bwe = bwe_kbps();
    let unpaced = std::env::var("RELAY_BWE_PACED").as_deref() != Ok("1");
    let start = Instant::now();
    let mut evs = vec![];

    loop {
        // ── signaling ──
        while let Ok(v) = rx.try_recv() {
            if let Some(cmd) = v["cmd"].as_str() {
                match cmd {
                    "child" => {
                        let id = v["id"].as_u64().unwrap();
                        let mut rtc = new_rtc(addr, profile, bwe);
                        let mut api = rtc.sdp_api();
                        let mid = api.add_media(MediaKind::Video, Direction::SendOnly, Some("relay".into()), Some("video".into()), None);
                        let (offer, pending) = api.apply().unwrap();
                        out(json!({"to": id, "sdp": {"type": "offer", "sdp": offer.to_sdp_string()}}));
                        children.push(Peer { id, rtc, mid: Some(mid), pending: Some(pending) });
                    }
                    "stats" => out(json!({"stats": {
                        "pktsIn": stats.pkts_in, "bytesIn": stats.bytes_in,
                        "pktsOut": stats.pkts_out, "bytesOut": stats.bytes_out,
                        "keyAsks": stats.key_asks, "childPlis": stats.child_plis,
                        "connected": parent.as_ref().map(|p| p.rtc.is_connected()),
                        "children": children.iter().filter(|c| c.rtc.is_connected()).count(),
                        "ms": start.elapsed().as_millis() as u64,
                        "bwe": stats.bwe.iter().map(|&(t, id, k)| json!([t, id, k])).collect::<Vec<_>>(),
                    }})),
                    _ => {}
                }
                continue;
            }
            let from = v["from"].as_u64().unwrap_or(0);
            // Browser candidates are mDNS names: the pair forms from peer-reflexive candidates.
            let Some(sdp) = v["sdp"].as_object() else { continue };
            let text = sdp["sdp"].as_str().unwrap_or_default();
            if sdp["type"] == "offer" {
                let mut rtc = new_rtc(addr, profile, None);
                let answer = rtc.sdp_api().accept_offer(SdpOffer::from_sdp_string(text).unwrap()).unwrap();
                out(json!({"to": from, "sdp": {"type": "answer", "sdp": answer.to_sdp_string()}}));
                parent = Some(Peer { id: from, rtc, mid: None, pending: None });
            } else if let Some(c) = children.iter_mut().find(|c| c.id == from) {
                if let Some(p) = c.pending.take() {
                    c.rtc.sdp_api().accept_answer(p, SdpAnswer::from_sdp_string(text).unwrap()).unwrap();
                }
            }
        }

        // ── events ──
        let mut timeout = Instant::now() + Duration::from_millis(50);
        let mut packets = vec![];
        if let Some(p) = parent.as_mut() {
            timeout = timeout.min(drain(p, &sock, &mut evs));
            for e in evs.drain(..) {
                match e {
                    Event::MediaAdded(m) => p.mid = Some(m.mid),
                    Event::RtpPacket(pkt) => {
                        stats.pkts_in += 1;
                        stats.bytes_in += pkt.payload.len() as u64;
                        packets.push(pkt);
                    }
                    _ => {}
                }
            }
        }
        for c in children.iter_mut() {
            timeout = timeout.min(drain(c, &sock, &mut evs));
            for e in evs.drain(..) {
                match e {
                    Event::KeyframeRequest(_) => {
                        stats.child_plis += 1;
                        want_key = true;
                    }
                    Event::Connected => want_key = true,
                    Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. } | BweKind::Remb { estimate, .. }) => {
                        stats.bwe.push((start.elapsed().as_millis() as u64, c.id, estimate.as_u64() / 1000));
                    }
                    _ => {}
                }
            }
        }

        // ── the forward: same payload, sequence numbers and timestamps ──
        for pkt in packets {
            for c in children.iter_mut().filter(|c| c.rtc.is_connected()) {
                let Some(mid) = c.mid else { continue };
                let Some(pt) = c.rtc.codec_config().iter().next().map(|p| p.pt()) else { continue };
                let mut api = c.rtc.direct_api();
                let Some(tx) = api.stream_tx_by_mid(mid, None) else { continue };
                if bwe.is_some() && unpaced {
                    tx.set_unpaced(true);
                }
                tx.write_rtp(
                    RtpWrite::new(pt, pkt.seq_no, pkt.header.timestamp, pkt.timestamp, pkt.payload.clone())
                        .marker(pkt.header.marker)
                        .ext_vals(pkt.header.ext_vals.clone())
                        .nackable(true),
                );
                stats.pkts_out += 1;
                stats.bytes_out += pkt.payload.len() as u64;
            }
        }
        if want_key && last_ask.elapsed() >= Duration::from_millis(500) {
            if let Some(p) = parent.as_mut() {
                if let Some(mid) = p.mid {
                    if let Some(rx) = p.rtc.direct_api().stream_rx_by_mid(mid, None) {
                        rx.request_keyframe(KeyframeRequestKind::Pli);
                        stats.key_asks += 1;
                        last_ask = Instant::now();
                        want_key = false;
                    }
                }
            }
        }
        // send what the forward queued before blocking on the socket
        for c in children.iter_mut() {
            timeout = timeout.min(drain(c, &sock, &mut evs));
            evs.clear();
        }
        if let Some(p) = parent.as_mut() {
            timeout = timeout.min(drain(p, &sock, &mut evs));
        }

        // ── network ──
        let wait = timeout
            .saturating_duration_since(Instant::now())
            .clamp(Duration::from_millis(1), Duration::from_millis(5));
        sock.set_read_timeout(Some(wait)).unwrap();
        if let Ok((n, source)) = sock.recv_from(&mut buf) {
            if let Ok(contents) = buf[..n].try_into() {
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: addr, contents });
                if let Some(p) = parent.as_mut().filter(|p| p.rtc.accepts(&input)) {
                    let _ = p.rtc.handle_input(input);
                } else if let Some(c) = children.iter_mut().find(|c| c.rtc.accepts(&input)) {
                    let _ = c.rtc.handle_input(input);
                }
            }
        }
        let now = Instant::now();
        if let Some(p) = parent.as_mut() {
            let _ = p.rtc.handle_input(Input::Timeout(now));
        }
        for c in children.iter_mut() {
            let _ = c.rtc.handle_input(Input::Timeout(now));
        }
    }
}
