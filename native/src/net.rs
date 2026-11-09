//! One str0m peer per viewer: the presenter offers (video H.264 + audio Opus, both sendonly, the
//! same two m-lines as web/stream.js) and the viewer answers. Signaling payload as in the web:
//! `{sdp:{type,sdp}, nid}` | `{candidate:{candidate,sdpMid,..}, nid}`.
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::media::{Direction, MediaKind, Mid};
use str0m::{Candidate, Rtc};

use crate::encode::Profile;

pub const PT_H264: u8 = 102;
pub const PT_OPUS: u8 = 111; // str0m's enable_opus PT
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10); // web/stream.js connectDeadline
const RECOVER_BASE: Duration = Duration::from_secs(1);
const RECOVER_MAX: Duration = Duration::from_secs(5);

/// Bind the IPv4 the default route uses (what a viewer on the LAN or this PC reaches), or
/// SP2P_BIND_IP. ponytail: one host candidate; more interfaces, srflx and TURN come in slice 5.
pub fn bind() -> std::io::Result<UdpSocket> {
    let ip = match std::env::var("SP2P_BIND_IP") {
        Ok(ip) => ip,
        Err(_) => UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("8.8.8.8:53").and(s.local_addr()))
            .map(|a| a.ip().to_string())
            .unwrap_or_else(|_| "127.0.0.1".into()),
    };
    let sock = UdpSocket::bind((ip.as_str(), 0))?;
    sock.set_nonblocking(true)?;
    Ok(sock)
}

/// Random 8-hex-char negotiation id (web: randomId().slice(0, 8)).
pub fn nid() -> String {
    let g = windows::core::GUID::new().unwrap_or_default();
    format!("{:08x}", g.data1)
}

pub struct Peer {
    pub id: String,
    pub rtc: Rtc,
    pub video: Mid,
    pub audio: Mid,
    pub nid: String,
    pub profile: Profile,
    pending: Option<SdpPendingOffer>,
    pub offered_at: Instant,
    pub connected: bool,
    pub tries: u32,
}

pub enum Answer {
    Ok,
    /// The viewer rejected the video format (e.g. Firefox and main/4d001f) [r19].
    Refused(String),
    /// Stale nid or no offer pending: ignored, like the web does.
    Stale,
}

impl Peer {
    /// New connection to `id` with an offer; returns the peer and the `signal` data to send.
    pub fn offer(id: &str, addr: SocketAddr, profile: Profile) -> (Peer, Value) {
        let mut b = Rtc::builder().clear_codecs().enable_opus(true, false);
        b.codec_config().add_h264(PT_H264.into(), Some((PT_H264 + 1).into()), true, profile.level_id());
        let mut rtc = b.build(Instant::now());
        rtc.add_local_candidate(Candidate::host(addr, "udp").expect("host candidate"));
        let mut api = rtc.sdp_api();
        let video = api.add_media(MediaKind::Video, Direction::SendOnly, Some("native".into()), Some("video".into()), None);
        let audio = api.add_media(MediaKind::Audio, Direction::SendOnly, Some("native".into()), Some("audio".into()), None);
        let (offer, pending) = api.apply().expect("offer with media");
        let nid = nid();
        let data = json!({"sdp": {"type": "offer", "sdp": offer.to_sdp_string()}, "nid": nid});
        let peer = Peer { id: id.into(), rtc, video, audio, nid, profile, pending: Some(pending), offered_at: Instant::now(), connected: false, tries: 0 };
        (peer, data)
    }

    /// Handles `data` of a `signal` from this viewer. Never panics on what the browser sends.
    pub fn signal(&mut self, data: &Value) -> Answer {
        if data["nid"].as_str() != Some(self.nid.as_str()) {
            return Answer::Stale;
        }
        if let Some(c) = data["candidate"]["candidate"].as_str() {
            // mDNS (.local) candidates do not parse; the pair then forms peer-reflexive.
            if let Ok(c) = Candidate::from_sdp_string(c) {
                self.rtc.add_remote_candidate(c);
            }
            return Answer::Ok;
        }
        let Some(text) = data["sdp"]["sdp"].as_str().filter(|_| data["sdp"]["type"] == "answer") else { return Answer::Stale };
        let Some(pending) = self.pending.take() else { return Answer::Stale };
        if video_rejected(text) {
            return Answer::Refused("m=video recusada (porta 0)".into());
        }
        match SdpAnswer::from_sdp_string(text) {
            Ok(a) => match self.rtc.sdp_api().accept_answer(pending, a) {
                Ok(()) => Answer::Ok,
                Err(e) => Answer::Refused(format!("{e}")),
            },
            Err(e) => Answer::Refused(format!("{e}")),
        }
    }

    /// When to offer again: not connected 10 s after the offer, or the connection died.
    /// Backoff 1, 2, 4, 5 s like web/stream.js recover().
    pub fn needs_retry(&self, now: Instant) -> bool {
        let dead = !self.rtc.is_alive();
        let late = !self.connected && now.duration_since(self.offered_at) >= CONNECT_TIMEOUT;
        let backoff = RECOVER_MAX.min(RECOVER_BASE * 2u32.saturating_pow(self.tries.saturating_sub(1)));
        (dead || late) && (self.tries == 0 || now.duration_since(self.offered_at) >= backoff)
    }
}

/// The answer turned the video m-line down: port 0 (RFC 3264 §6).
pub fn video_rejected(sdp: &str) -> bool {
    sdp.lines().any(|l| l.starts_with("m=video 0 "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use str0m::change::SdpOffer;

    fn addr() -> SocketAddr {
        "127.0.0.1:5000".parse().unwrap()
    }

    /// A viewer that only takes `profile` answers our offer.
    fn answer_from(offer: &Value, profile: u32) -> String {
        let mut b = Rtc::builder().clear_codecs().enable_opus(true, false);
        b.codec_config().add_h264(PT_H264.into(), None, true, profile);
        let mut rtc = b.build(Instant::now());
        rtc.add_local_candidate(Candidate::host("127.0.0.1:5001".parse().unwrap(), "udp").unwrap());
        let offer = SdpOffer::from_sdp_string(offer["sdp"]["sdp"].as_str().unwrap()).unwrap();
        rtc.sdp_api().accept_offer(offer).unwrap().to_sdp_string()
    }

    #[test]
    fn offer_has_video_and_audio_sendonly() {
        let (_, data) = Peer::offer("v1", addr(), Profile::ConstrainedBaseline);
        let sdp = data["sdp"]["sdp"].as_str().unwrap();
        assert!(sdp.contains("m=video") && sdp.contains("m=audio"));
        assert!(sdp.contains("profile-level-id=42e01f"));
        assert!(sdp.contains("opus/48000/2"));
        assert_eq!(data["nid"].as_str().unwrap().len(), 8);
    }

    #[test]
    fn accepts_matching_answer() {
        let (mut p, data) = Peer::offer("v1", addr(), Profile::ConstrainedBaseline);
        let ans = answer_from(&data, 0x42e01f);
        assert!(matches!(p.signal(&json!({"sdp": {"type": "answer", "sdp": ans}, "nid": p.nid})), Answer::Ok));
    }

    /// Firefox and main/4d001f [r19]: the answer rejects the video m-line and carries no
    /// a=ice-ufrag/pwd. The old presenter panicked here; now it is a refusal.
    #[test]
    fn firefox_like_rejection_is_a_refusal_not_a_panic() {
        let (mut p, data) = Peer::offer("v1", addr(), Profile::Main);
        let ff = "v=0\r\no=mozilla...THIS_IS_SDPARTA-99.0 1 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 1\r\n\
                  m=video 0 UDP/TLS/RTP/SAVPF 0\r\nc=IN IP4 0.0.0.0\r\na=inactive\r\na=mid:0\r\n\
                  m=audio 0 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=inactive\r\na=mid:1\r\n";
        assert!(matches!(p.signal(&json!({"sdp": {"type": "answer", "sdp": ff}, "nid": p.nid})), Answer::Refused(_)));
        // Garbage answers are refusals too, never panics.
        let (mut p, _) = Peer::offer("v2", addr(), Profile::Main);
        assert!(matches!(p.signal(&json!({"sdp": {"type": "answer", "sdp": "v=0\r\n"}, "nid": p.nid})), Answer::Refused(_)));
        let _ = data;
    }

    #[test]
    fn stale_nid_and_bad_candidates_are_ignored() {
        let (mut p, _) = Peer::offer("v1", addr(), Profile::ConstrainedBaseline);
        assert!(matches!(p.signal(&json!({"sdp": {"type": "answer", "sdp": "x"}, "nid": "other"})), Answer::Stale));
        let mdns = json!({"candidate": {"candidate": "candidate:1 1 udp 2122260223 abc.local 5000 typ host", "sdpMid": "0"}, "nid": p.nid});
        assert!(matches!(p.signal(&mdns), Answer::Ok));
    }

    #[test]
    fn retry_deadline_and_backoff() {
        let (mut p, _) = Peer::offer("v1", addr(), Profile::ConstrainedBaseline);
        let t = p.offered_at;
        assert!(!p.needs_retry(t + Duration::from_secs(9)));
        assert!(p.needs_retry(t + CONNECT_TIMEOUT));
        p.connected = true;
        assert!(!p.needs_retry(t + Duration::from_secs(60)), "connected and alive: keep");
    }
}
