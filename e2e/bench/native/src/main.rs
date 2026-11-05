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
}

fn new_rtc(addr: SocketAddr) -> Rtc {
    let mut rtc = Rtc::builder()
        .set_rtp_mode(true)
        .clear_codecs()
        .enable_vp8(true)
        .build(Instant::now());
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

fn main() {
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
    let mut evs = vec![];

    loop {
        // ── signaling ──
        while let Ok(v) = rx.try_recv() {
            if let Some(cmd) = v["cmd"].as_str() {
                match cmd {
                    "child" => {
                        let id = v["id"].as_u64().unwrap();
                        let mut rtc = new_rtc(addr);
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
                let mut rtc = new_rtc(addr);
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
