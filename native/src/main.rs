//! Stream P2P native presenter (slice 1a): creates a session on the server, prints the invite and
//! streams the screen (1080p60, H.264) + system audio (Opus) to web viewers.
//!
//! native.exe --server <url> [--name N] [--monitor I] [--synth] [--audio system|tone|off]
//!            [--profile 42e01f|42001f|4d001f] [--encoder hardware|software] [--kbps N] [--upload MBPS]
//! stdout: the invite link, then JSON lines answering stdin commands (tests, and the 1b UI later):
//!   {"cmd":"stats"} | {"cmd":"bitrate","kbps":N} | {"cmd":"fault","n":N}
//! stderr: the log (catalog §2.9 plan-B messages included).
//! --ui (slice 1b): the "Transmitir" window (picker + preview); the button runs this same exe
//! headless as a child process, so the 1a path is what streams.
mod audio;
mod capture;
mod encode;
mod msvc_shim;
mod net;
mod sysaudio;
mod ui;
mod ws;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::net::SocketAddr;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use str0m::media::{Frequency, MediaTime};
use str0m::net::{Protocol, Receive};
use str0m::{Event, IceConnectionState, Input, Output};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;

use capture::{Screen, Synth, FPS, MAX_H, MAX_W};
use encode::{Encoder, Faults, Profile, E_UNEXPECTED};
use net::{Answer, Peer, PT_H264, PT_OPUS};

const MODE: &str = "1080p60";
const DEFAULT_KBPS: u32 = 8000; // server/topology.js MODES['1080p60']
const KEY_MIN_GAP: Duration = Duration::from_millis(500);

struct Args {
    server: String,
    name: String,
    monitor: Option<usize>,
    synth: bool,
    audio: String,
    profile: Profile,
    software: bool,
    kbps: u32,
    upload_mbps: f64,
    window: Option<isize>,
    ui: bool,
    render: ui::Render,
    bench: Option<u64>,
}

const USAGE: &str = "uso: native.exe --server <url> [--ui [--render femtovg|skia|partial|swapchain] [--bench <s>]] [--name <apelido>] [--monitor <n> | --window <hwnd>] [--synth] [--audio system|tone|off] [--profile 42e01f|42001f|4d001f] [--encoder hardware|software] [--kbps <n>] [--upload <Mbps>]";

fn parse_args(mut it: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut a = Args { server: String::new(), name: "Transmissor".into(), monitor: None, synth: false, audio: "system".into(), profile: Profile::ConstrainedBaseline, software: false, kbps: DEFAULT_KBPS, upload_mbps: 50.0, window: None, ui: false, render: ui::Render::Femtovg, bench: None };
    while let Some(k) = it.next() {
        let mut val = || it.next().ok_or_else(|| format!("{k} precisa de um valor\n{USAGE}"));
        match k.as_str() {
            "--server" => a.server = val()?,
            "--name" => a.name = val()?,
            "--monitor" => a.monitor = Some(val()?.parse().map_err(|_| "--monitor: número")?),
            "--window" => a.window = Some(val()?.parse().map_err(|_| "--window: HWND em decimal")?),
            "--ui" => a.ui = true,
            "--render" => {
                let v = val()?;
                a.render = ui::Render::parse(&v).ok_or_else(|| format!("--render inválido: {v}"))?
            }
            "--bench" => a.bench = Some(val()?.parse().map_err(|_| "--bench: segundos")?),
            "--synth" => a.synth = true,
            "--audio" => a.audio = val()?.to_string(),
            "--profile" => {
                let v = val()?;
                a.profile = Profile::parse(&v).ok_or_else(|| format!("--profile inválido: {v}"))?
            }
            "--encoder" => a.software = val()? == "software",
            "--kbps" => a.kbps = val()?.parse().ok().filter(|&k: &u32| (100..=100_000).contains(&k)).ok_or("--kbps: 100–100000")?,
            "--upload" => a.upload_mbps = val()?.parse().ok().filter(|&m: &f64| m > 0.0).ok_or("--upload: Mbps > 0")?,
            "-h" | "--help" => return Err(USAGE.into()),
            _ => return Err(format!("argumento desconhecido: {k}\n{USAGE}")),
        }
    }
    if a.server.is_empty() {
        return Err(USAGE.into());
    }
    if !["system", "tone", "off"].contains(&a.audio.as_str()) {
        return Err(format!("--audio inválido: {}", a.audio));
    }
    ws::ws_url(&a.server)?;
    Ok(a)
}

/// Stable per-PC id, like the web's localStorage device: the server uses it to evict our own
/// ghost connection on reconnect instead of answering 409.
fn device_id() -> String {
    let dir = std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into())).join("stream-p2p");
    let path = dir.join("native-device.txt");
    if let Ok(id) = std::fs::read_to_string(&path) {
        if id.trim().len() >= 8 {
            return id.trim().to_string();
        }
    }
    let id = format!("{:?}", windows::core::GUID::new().unwrap_or_default()).to_lowercase();
    let _ = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, &id));
    id
}

fn out(v: Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

fn d3d() -> (ID3D11Device, ID3D11DeviceContext) {
    let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let (mut device, mut ctx) = (None, None);
        let r = unsafe { D3D11CreateDevice(None, driver, HMODULE::default(), flags, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx)) };
        if r.is_ok() {
            if driver == D3D_DRIVER_TYPE_WARP {
                eprintln!("gpu: sem dispositivo D3D11 de hardware; usando WARP (software)");
            }
            let device: ID3D11Device = device.unwrap();
            unsafe {
                if let Ok(mt) = windows::core::Interface::cast::<ID3D11Multithread>(&device) {
                    let _ = mt.SetMultithreadProtected(true);
                }
            }
            return (device, ctx.unwrap());
        }
    }
    eprintln!("erro: nenhum dispositivo Direct3D 11 disponível");
    std::process::exit(1);
}

/// Hardware MFT first; without one, the Microsoft software MFT (catalog §2.9 "sem GPU").
fn make_encoder(device: &ID3D11Device, ctx: &ID3D11DeviceContext, w: u32, h: u32, software: bool, profile: Profile, bps: u32) -> Encoder {
    let no_hw = std::env::var("SP2P_TEST_NO_HW").is_ok();
    if !software {
        match Encoder::new(device, ctx, w, h, false, profile, bps, no_hw) {
            Ok(e) => return e,
            Err(e) => eprintln!("aviso: Sua placa de vídeo não codifica vídeo ({e}). A transmissão vai usar mais processador (MFT H.264 de software)."),
        }
    }
    Encoder::new(device, ctx, w, h, true, profile, bps, false).unwrap_or_else(|e| {
        eprintln!("erro: nem o codificador H.264 de software abriu: {e}");
        std::process::exit(1);
    })
}

enum Source {
    Screen(Screen),
    Synth(Synth, Instant),
}

#[derive(Default)]
struct Counters {
    captured: u64,
    encoded: u64,
    bytes: u64,
    keys: u64,
    dropped: u64,
    faults: u64,
    recreates: u64,
    enc_ms: f64,
    max_out_gap_ms: f64,
}

fn main() {
    let args = parse_args(std::env::args().skip(1)).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(2);
    });
    if args.ui {
        ui::run(&args); // winit needs the main thread as STA: no RoInitialize(MTA) here
        return;
    }
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        windows::Win32::Media::timeBeginPeriod(1);
        let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
    }
    str0m::crypto::from_feature_flags().install_process_default();

    let (device, ctx) = d3d();
    let mut source = if args.synth {
        Source::Synth(Synth::new(MAX_W, MAX_H), Instant::now())
    } else {
        match capture::item(args.monitor, args.window).and_then(|item| Screen::new(&device, &ctx, &item)) {
            Ok(s) => Source::Screen(s),
            Err(e) => {
                eprintln!("erro: não foi possível capturar a tela: {e}");
                std::process::exit(1);
            }
        }
    };
    let (w, h) = match &source {
        Source::Screen(s) => (s.w, s.h),
        Source::Synth(s, _) => (s.w, s.h),
    };
    let mut profile = args.profile;
    let mut enc = make_encoder(&device, &ctx, w, h, args.software, profile, args.kbps * 1000);
    eprintln!("codificador: {} ({w}x{h}@{FPS}, {} kbps, perfil {:06x})", enc.name, args.kbps, profile.level_id());
    let mut audio = audio::Audio::new(&args.audio);

    let sock = net::bind().unwrap_or_else(|e| {
        eprintln!("erro: UDP: {e}");
        std::process::exit(1);
    });
    let addr: SocketAddr = sock.local_addr().unwrap();
    eprintln!("rede: {addr} (UDP)");

    let signaling = ws::Ws::connect(&args.server).unwrap_or_else(|e| {
        eprintln!("erro: {e}");
        std::process::exit(2);
    });
    let device_id = device_id();

    let (cmd_tx, cmd_rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str(&line) {
                if cmd_tx.send(v).is_err() {
                    break;
                }
            }
        }
    });

    let start = Instant::now();
    let frame_iv = Duration::from_nanos(1_000_000_000 / FPS as u64);
    let mut me = String::new();
    let mut code: Option<String> = None;
    let mut start_sent = false;
    let mut peers: HashMap<String, Peer> = HashMap::new();
    let mut need_input = 0u32;
    let mut want_key = false;
    let mut last_key = Instant::now() - KEY_MIN_GAP;
    let mut fed_at: HashMap<i64, Instant> = HashMap::new();
    let mut c = Counters::default();
    let mut live: Vec<Value> = vec![];
    let mut watch_gap_until: Option<Instant> = None;
    let mut last_out = Instant::now();
    let mut faults = Faults::new();
    let mut inject = 0u32;
    let mut audio_next = Instant::now();
    let mut src_stats_at = Instant::now();
    let mut src_bytes = 0u64;
    let mut src_frames = 0u64;
    let mut buf = vec![0u8; 2000];

    loop {
        let mut busy = false;

        // ── signaling ──
        while let Ok(m) = signaling.rx.try_recv() {
            busy = true;
            if std::env::var("SP2P_DEBUG").is_ok() {
                eprintln!("ws <- {m}");
            }
            match m["type"].as_str().unwrap_or_default() {
                "_open" => eprintln!("servidor: conectado"),
                "_closed" => {
                    eprintln!("servidor: conexão caiu ({}); tentando de novo", m["reason"].as_str().unwrap_or("?"));
                    start_sent = false;
                    peers.clear();
                }
                "hello" => {
                    me = m["id"].as_str().unwrap_or_default().to_string();
                    match &code {
                        None => signaling.send(json!({"type": "create", "name": args.name, "device": device_id})),
                        Some(c) => signaling.send(json!({"type": "join", "code": c, "name": args.name, "device": device_id})),
                    }
                }
                "session" => {
                    let s = &m["session"];
                    let first = code.is_none();
                    code = s["code"].as_str().map(String::from).or(code);
                    if first {
                        if let Some(c) = &code {
                            println!("Convite: {}", ws::invite(&args.server, c));
                            let _ = std::io::stdout().flush();
                        }
                    }
                    if !start_sent && s["presenterId"].as_str() != Some(me.as_str()) {
                        start_sent = true;
                        signaling.send(json!({"type": "startStream", "mode": MODE, "uploadKbps": args.upload_mbps * 1000.0, "audio": args.audio != "off", "source": "monitor", "latency": "auto"}));
                        eprintln!("transmissão: iniciada ({MODE})");
                    }
                }
                "child" => {
                    let id = m["id"].as_str().unwrap_or_default().to_string();
                    let (p, data) = Peer::offer(&id, addr, profile);
                    signaling.send(json!({"type": "signal", "to": id, "data": data}));
                    eprintln!("espectador {}: oferta enviada", &id[..id.len().min(6)]);
                    peers.insert(id, p);
                }
                "childGone" => {
                    peers.remove(m["id"].as_str().unwrap_or_default());
                }
                "signal" => {
                    let from = m["from"].as_str().unwrap_or_default().to_string();
                    let Some(p) = peers.get_mut(&from) else { continue };
                    if let Answer::Refused(why) = p.signal(&m["data"]) {
                        let was = p.profile;
                        if was == Profile::ConstrainedBaseline {
                            eprintln!("espectador {}: recusou H.264 42e01f ({why}); desistindo dele", &from[..from.len().min(6)]);
                            peers.remove(&from);
                            continue;
                        }
                        // One encoder for everyone: constrained baseline decodes in any H.264 decoder,
                        // so switching the encoder keeps the other viewers working.
                        eprintln!("espectador {}: formato recusado ({:06x}: {why}), usando H.264 42e01f", &from[..from.len().min(6)], was.level_id());
                        if profile != Profile::ConstrainedBaseline {
                            profile = Profile::ConstrainedBaseline;
                            let (sw, bps) = (enc.software, enc.bitrate);
                            drop(std::mem::replace(&mut enc, make_encoder(&device, &ctx, w, h, sw, profile, bps)));
                            need_input = 0;
                            fed_at.clear();
                        }
                        let (np, data) = Peer::offer(&from, addr, profile);
                        signaling.send(json!({"type": "signal", "to": from, "data": data}));
                        peers.insert(from, np);
                        live.push(json!({"event": "fallback", "from": format!("{:06x}", was.level_id()), "to": "42e01f", "atMs": start.elapsed().as_millis() as u64}));
                    }
                }
                "streamEnded" => peers.clear(),
                "ended" => {
                    eprintln!("sessão encerrada: {}", m["reason"].as_str().unwrap_or_default());
                    return;
                }
                "error" => eprintln!("servidor: erro {} em {}: {}", m["code"], m["op"].as_str().unwrap_or("?"), m["reason"].as_str().unwrap_or_default()),
                "notice" => eprintln!("servidor: {}", m["reason"].as_str().unwrap_or_default()),
                _ => {}
            }
        }

        // ── local commands ──
        while let Ok(v) = cmd_rx.try_recv() {
            match v["cmd"].as_str().unwrap_or_default() {
                "stats" => out(json!({"stats": {
                    "w": w, "h": h, "encoder": enc.name, "software": enc.software, "profile": format!("{:06x}", profile.level_id()),
                    "bitrate": enc.bitrate, "captured": c.captured, "encoded": c.encoded, "bytes": c.bytes, "keys": c.keys,
                    "dropped": c.dropped, "faults": c.faults, "recreates": c.recreates,
                    "skipped": match &source { Source::Screen(s) => s.skipped, _ => 0 },
                    "encodeMsAvg": if c.encoded > 0 { c.enc_ms / c.encoded as f64 } else { 0.0 },
                    "peers": peers.len(), "connected": peers.values().filter(|p| p.connected).count(),
                    "audioSamples": audio.samples, "code": code, "live": live,
                }})),
                "bitrate" => {
                    let kbps = v["kbps"].as_u64().unwrap_or(0) as u32;
                    let t0 = Instant::now();
                    let r = if (100..=100_000).contains(&kbps) { enc.set_bitrate(kbps * 1000).map_err(|e| e.to_string()) } else { Err("kbps fora de 100–100000".into()) };
                    c.max_out_gap_ms = 0.0;
                    watch_gap_until = Some(Instant::now() + Duration::from_secs(1));
                    live.push(json!({"cmd": "bitrate", "kbps": kbps, "ok": r.is_ok(), "error": r.err(), "applyMs": t0.elapsed().as_secs_f64() * 1000.0, "atMs": start.elapsed().as_millis() as u64}));
                }
                "fault" => inject += v["n"].as_u64().unwrap_or(1) as u32,
                _ => {}
            }
        }

        // ── encoder ──
        let mut outputs = vec![];
        let mut failed: Option<windows::core::Error> = None;
        let mut take = |enc: &mut Encoder, outputs: &mut Vec<(Vec<u8>, i64)>, failed: &mut Option<windows::core::Error>| {
            let r = enc.take();
            if inject > 0 {
                inject -= 1;
                *failed = Some(windows::core::Error::new(E_UNEXPECTED, "falha injetada (teste)"));
                return false;
            }
            match r {
                Ok(Some(o)) => {
                    outputs.push(o);
                    true
                }
                Ok(None) => false,
                Err(e) => {
                    *failed = Some(e);
                    false
                }
            }
        };
        while let Some(t) = enc.poll_event() {
            busy = true;
            if t == windows::Win32::Media::MediaFoundation::METransformNeedInput.0 as u32 {
                need_input += 1;
            } else if t == windows::Win32::Media::MediaFoundation::METransformHaveOutput.0 as u32 {
                take(&mut enc, &mut outputs, &mut failed);
            }
        }
        if enc.sync() {
            need_input = 1;
        }

        let t0 = Instant::now();
        let nv12 = match &mut source {
            Source::Screen(s) => s.next(need_input > 0, want_key && last_key.elapsed() >= KEY_MIN_GAP).unwrap_or_else(|e| {
                eprintln!("captura: {e}");
                None
            }),
            Source::Synth(s, next) => {
                if t0 >= *next {
                    *next = (*next + frame_iv).max(t0);
                    if need_input > 0 {
                        capture::tex(&device, s.w, s.h, DXGI_FORMAT_NV12, Some(s.draw())).ok()
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };
        if let Some(nv12) = nv12 {
            busy = true;
            c.captured += 1;
            if want_key && last_key.elapsed() >= KEY_MIN_GAP {
                enc.force_key();
                c.keys += 1;
                want_key = false;
                last_key = Instant::now();
            }
            let ts = (start.elapsed().as_nanos() / 100) as i64;
            fed_at.insert(ts, t0);
            if let Err(e) = enc.feed(&nv12, ts) {
                failed = Some(e);
            }
            need_input = need_input.saturating_sub(1);
            if enc.sync() {
                while take(&mut enc, &mut outputs, &mut failed) {}
            }
        }

        // Catalog §2.9: an MFT error drops the frame; a repeat recreates the encoder (with an IDR).
        if let Some(e) = failed {
            c.faults += 1;
            c.dropped += 1;
            if faults.hit(Instant::now()) {
                eprintln!("aviso: O codificador falhou, reiniciando ({e})");
                let (sw, bps) = (enc.software, enc.bitrate);
                let t = Instant::now();
                drop(std::mem::replace(&mut enc, make_encoder(&device, &ctx, w, h, sw, profile, bps)));
                need_input = 0;
                fed_at.clear();
                c.recreates += 1;
                last_key = Instant::now();
                live.push(json!({"event": "recreate", "error": format!("{:#010x}", e.code().0), "ms": t.elapsed().as_secs_f64() * 1000.0, "atMs": start.elapsed().as_millis() as u64}));
            } else {
                eprintln!("codificador: erro {:#010x}, quadro descartado", e.code().0);
            }
        }

        for (data, ts) in outputs {
            let now = Instant::now();
            c.encoded += 1;
            c.bytes += data.len() as u64;
            src_bytes += data.len() as u64;
            src_frames += 1;
            if let Some(at) = fed_at.remove(&ts) {
                c.enc_ms += at.elapsed().as_secs_f64() * 1000.0;
            }
            if watch_gap_until.is_some_and(|u| now <= u) {
                c.max_out_gap_ms = c.max_out_gap_ms.max(now.duration_since(last_out).as_secs_f64() * 1000.0);
            } else if watch_gap_until.take().is_some() {
                if let Some(ev) = live.iter_mut().rev().find(|e| e["cmd"] == "bitrate") {
                    ev["maxEncoderGapMs"] = json!(c.max_out_gap_ms);
                }
            }
            last_out = now;
            let rtp = MediaTime::new((ts as u64) * 9 / 1000, Frequency::NINETY_KHZ); // 100 ns → 90 kHz
            for p in peers.values_mut().filter(|p| p.connected) {
                if let Some(wr) = p.rtc.writer(p.video) {
                    let _ = wr.write(PT_H264.into(), now, rtp, data.clone());
                }
            }
        }

        // ── audio: one 20 ms Opus packet per tick, on the wall clock ──
        let now = Instant::now();
        while audio_next <= now {
            busy = true;
            let pkt = audio.next();
            let rtp = MediaTime::new(audio.samples - audio::FRAME as u64, Frequency::FORTY_EIGHT_KHZ);
            for p in peers.values_mut().filter(|p| p.connected) {
                if let Some(wr) = p.rtc.writer(p.audio) {
                    let _ = wr.write(PT_OPUS.into(), now, rtp, pkt.clone());
                }
            }
            audio_next += Duration::from_millis(20);
            if now.duration_since(audio_next) > Duration::from_millis(200) {
                audio_next = now; // stalled: don't burst
            }
        }

        // ── srcStats: what leaves the presenter (web/app.js sends it too) ──
        if src_stats_at.elapsed() >= Duration::from_secs(2) && !peers.is_empty() {
            let secs = src_stats_at.elapsed().as_secs_f64();
            signaling.send(json!({"type": "srcStats", "capture": {"w": w, "h": h, "fps": FPS}, "w": w, "h": h,
                "fps": (src_frames as f64 / secs).round(), "kbps": (src_bytes as f64 * 8.0 / 1000.0 / secs).round(), "codec": "H264", "limit": "none"}));
            (src_bytes, src_frames, src_stats_at) = (0, 0, Instant::now());
        }

        // ── network ──
        let mut timeout = Instant::now() + Duration::from_millis(50);
        let drain = |p: &mut Peer, want_key: &mut bool| -> Instant {
            loop {
                match p.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => return t,
                    Ok(Output::Transmit(t)) => {
                        let _ = sock.send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(Event::Connected)) => {
                        p.connected = true;
                        p.tries = 0;
                        *want_key = true;
                        eprintln!("espectador {}: conectado", &p.id[..p.id.len().min(6)]);
                    }
                    Ok(Output::Event(Event::KeyframeRequest(_))) => *want_key = true,
                    Ok(Output::Event(Event::IceConnectionStateChange(IceConnectionState::Disconnected))) => {
                        eprintln!("espectador {}: desconectado", &p.id[..p.id.len().min(6)]);
                    }
                    Ok(Output::Event(_)) => {}
                    Err(e) => {
                        eprintln!("espectador {}: {e}", &p.id[..p.id.len().min(6)]);
                        p.rtc.disconnect();
                        return Instant::now() + Duration::from_secs(1);
                    }
                }
            }
        };
        for p in peers.values_mut() {
            timeout = timeout.min(drain(p, &mut want_key));
        }
        while let Ok((n, from)) = sock.recv_from(&mut buf) {
            busy = true;
            if let Ok(contents) = buf[..n].try_into() {
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source: from, destination: addr, contents });
                if let Some(p) = peers.values_mut().find(|p| p.rtc.accepts(&input)) {
                    let _ = p.rtc.handle_input(input);
                }
            }
        }
        let now = Instant::now();
        for p in peers.values_mut() {
            if now >= timeout || busy {
                let _ = p.rtc.handle_input(Input::Timeout(now));
            }
            drain(p, &mut want_key);
        }

        // ── re-offer to viewers that never connected or dropped (web/stream.js recover) ──
        let retry: Vec<String> = peers.values().filter(|p| p.needs_retry(now)).map(|p| p.id.clone()).collect();
        for id in retry {
            let tries = peers[&id].tries + 1;
            eprintln!("espectador {}: refazendo a conexão (tentativa {tries})", &id[..id.len().min(6)]);
            let (mut np, data) = Peer::offer(&id, addr, profile);
            np.tries = tries;
            signaling.send(json!({"type": "signal", "to": id, "data": data}));
            peers.insert(id, np);
        }

        if !busy {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Result<Args, String> {
        parse_args(v.iter().map(|s| s.to_string()))
    }

    #[test]
    fn cli() {
        let a = args(&["--server", "http://localhost:3000", "--name", "Ana"]).unwrap();
        assert_eq!((a.name.as_str(), a.kbps, a.profile, a.synth), ("Ana", 8000, Profile::ConstrainedBaseline, false));
        assert!(args(&[]).is_err());
        assert!(args(&["--server"]).is_err());
        assert!(args(&["--server", "localhost"]).is_err());
        assert!(args(&["--server", "http://x", "--profile", "high"]).is_err());
        assert!(args(&["--server", "http://x", "--kbps", "5"]).is_err());
        assert_eq!(args(&["--server", "http://x", "--profile", "main"]).unwrap().profile, Profile::Main);
        let u = args(&["--server", "http://x", "--ui", "--render", "swapchain", "--window", "1234"]).unwrap();
        assert_eq!((u.ui, u.render, u.window), (true, ui::Render::Swapchain, Some(1234)));
        assert!(args(&["--server", "http://x", "--render", "gdi"]).is_err());
    }
}
