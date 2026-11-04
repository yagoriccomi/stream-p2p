// System audio for the stream: WASAPI loopback converted by Windows to stereo 48 kHz f32.
// Chromium's own loopback (getDisplayMedia systemAudio) fails on some devices, e.g. a 7.1 headset:
// "Could not start audio source", which also drops the screen. The page turns these chunks into an
// audio track (web/sysaudio.js), so the picker only has to give the video.
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode, WaveFormat};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};

pub const RATE: usize = 48_000;
const CHANNELS: usize = 2;
const WAIT_MS: u32 = 100; // between generation checks when nothing plays
const BUFFER_HNS: i64 = 1_000_000; // 100 ms device buffer, in 100 ns units
const START_TIMEOUT: Duration = Duration::from_secs(3);
const RESCAN_TICKS: u32 = 20; // look for apps that started playing every 20 × WAIT_MS = 2 s
const MAX_LAG: usize = RATE / 5 * CHANNELS; // an app 200 ms ahead of the slowest one drops its oldest audio

// Bumped by every start and stop: a capture thread runs while its generation is current,
// so starting again (switching the source) or stopping ends the previous one.
static GENERATION: AtomicU32 = AtomicU32::new(0);
// Apps (executable name without .exe) left out of the full-screen mix. Changing it applies to a
// running capture within one tick: EXCLUDE_VER tells the mixer to look again.
static EXCLUDE: Mutex<Vec<String>> = Mutex::new(Vec::new());
static EXCLUDE_VER: AtomicU32 = AtomicU32::new(0);

#[link(name = "user32")]
extern "system" {
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
}

// Whose sound goes out. Excluding only the app leaves any other voice chat (Discord, WhatsApp) in
// the mix, and the friend hears themselves back; a shared window narrows it to that program. Mix
// captures each app with a session on its own and sums them: every app but the excluded ones
// (None), or a fixed list of PIDs (older pages that send `pids`).
enum Source {
    AllButApp,
    Program(u32),
    Mix(Option<Vec<u32>>),
}

pub struct AppAudio {
    pub name: String,
    pub sound: bool,
    pub mic: bool,
}

pub fn set_exclude(names: Vec<String>) {
    *EXCLUDE.lock().unwrap_or_else(|e| e.into_inner()) = names;
    EXCLUDE_VER.fetch_add(1, Ordering::SeqCst);
}

fn excluded(list: &[String], name: &str) -> bool {
    list.iter().any(|x| x.eq_ignore_ascii_case(name))
}

// Who is whose parent, and executable names, from one process snapshot. Process loopback always
// takes a program's whole tree, so the tree decides what a capture carries along.
struct Procs {
    parent: HashMap<u32, u32>,
    name: HashMap<u32, String>,
}

impl Procs {
    fn snapshot() -> Procs {
        let mut procs = Procs { parent: HashMap::new(), name: HashMap::new() };
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return procs };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut e).is_ok();
            while ok {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let exe = String::from_utf16_lossy(&e.szExeFile[..len]);
                let stem = match exe.len().checked_sub(4) {
                    Some(cut) if exe.is_char_boundary(cut) && exe[cut..].eq_ignore_ascii_case(".exe") => exe[..cut].to_string(),
                    _ => exe,
                };
                procs.parent.insert(e.th32ProcessID, e.th32ParentProcessID);
                procs.name.insert(e.th32ProcessID, stem);
                ok = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        procs
    }

    fn name_of(&self, pid: u32) -> String {
        self.name.get(&pid).cloned().unwrap_or_else(|| format!("PID {pid}"))
    }

    // `pid` is `root` or somewhere below it. Bounded walk: a reused parent PID can make a loop.
    fn is_under(&self, pid: u32, root: u32) -> bool {
        let mut p = pid;
        for _ in 0..64 {
            if p == root {
                return true;
            }
            match self.parent.get(&p) {
                Some(&up) if up != 0 && up != p => p = up,
                _ => return false,
            }
        }
        false
    }

    fn descendants(&self, root: u32) -> impl Iterator<Item = u32> + '_ {
        self.parent.keys().copied().filter(move |&p| p != root && self.is_under(p, root))
    }
}

// PIDs with an audio session on any active device of `direction`; `only_active` keeps the ones
// whose stream is running right now (an expired session is never kept).
fn session_pids(direction: &Direction, only_active: bool) -> Result<Vec<u32>, String> {
    let err = |e: wasapi::WasapiError| e.to_string();
    let devices = DeviceEnumerator::new().map_err(err)?.get_device_collection(direction).map_err(err)?;
    let mut pids = Vec::new();
    for device in &devices {
        let Ok(device) = device else { continue };
        let Ok(sessions) = device.get_iaudiosessionmanager().and_then(|m| m.get_audiosessionenumerator()) else { continue };
        for i in 0..sessions.get_count().unwrap_or(0) {
            let Ok(control) = sessions.get_session(i) else { continue };
            let keep = match control.get_state() {
                Ok(SessionState::Active) => true,
                Ok(SessionState::Inactive) => !only_active,
                _ => false,
            };
            if let (true, Ok(pid)) = (keep, control.get_process_id()) {
                if pid != 0 && !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
    }
    Ok(pids)
}

// Apps using sound or the microphone right now, one line per executable name, without this app
// (its WebView2 processes play the voice chat and use the mic).
pub fn list_sessions() -> Result<Vec<AppAudio>, String> {
    wasapi::initialize_mta().ok().map_err(|e| e.to_string())?;
    let procs = Procs::snapshot();
    let me = std::process::id();
    let mut apps: Vec<AppAudio> = Vec::new();
    for (direction, mic) in [(Direction::Render, false), (Direction::Capture, true)] {
        for pid in session_pids(&direction, true)? {
            if procs.is_under(pid, me) {
                continue;
            }
            let name = procs.name_of(pid);
            let i = match apps.iter().position(|a| a.name.eq_ignore_ascii_case(&name)) {
                Some(i) => i,
                None => {
                    apps.push(AppAudio { name, sound: false, mic: false });
                    apps.len() - 1
                }
            };
            if mic {
                apps[i].mic = true;
            } else {
                apps[i].sound = true;
            }
        }
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    Ok(apps)
}

// `window` is the HWND of the shared window (Chromium's window source id), if one was picked; it
// wins over the rest. `exclude` (app names) mixes every app but those; `pids` is the older fixed
// list. Neither: everything but this app, in one loopback.
pub fn start(out: Channel<InvokeResponseBody>, window: Option<u64>, pids: Option<Vec<u32>>, exclude: Option<Vec<String>>) -> Result<(), String> {
    let source = match (window, exclude, pids) {
        (Some(hwnd), _, _) => {
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd as isize, &mut pid) };
            if pid == 0 {
                return Err("a janela escolhida não existe mais".into());
            }
            Source::Program(pid)
        }
        (None, Some(names), _) => {
            set_exclude(names);
            Source::Mix(None)
        }
        (None, None, Some(pids)) if !pids.is_empty() => Source::Mix(Some(pids)),
        _ => Source::AllButApp,
    };
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (ready, started) = mpsc::channel();
    thread::spawn(move || {
        if let Err(e) = capture(gen, source, &out, &ready) {
            let _ = ready.send(Err(e)); // ignored once started: the page sees the chunks stop
        }
    });
    started.recv_timeout(START_TIMEOUT).map_err(|_| "o áudio do sistema não respondeu".to_string())?
}

pub fn stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn capture(gen: u32, source: Source, out: &Channel<InvokeResponseBody>, ready: &mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    let err = |e: wasapi::WasapiError| e.to_string();
    wasapi::initialize_mta().ok().map_err(|e| e.to_string())?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, RATE, CHANNELS, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: BUFFER_HNS };

    // Process loopback (Windows 10 2004+): the shared program's tree only, or everything but our
    // own tree. Capturing a render device (Direction::Capture on it) is the fallback for the
    // latter, and includes our sound; a program has no fallback, the page goes back to AllButApp.
    let (pid, include_tree) = match source {
        Source::Mix(fixed) => return capture_mix(gen, fixed, &format, &mode, out, ready),
        Source::Program(pid) => (pid, true),
        Source::AllButApp => (std::process::id(), false),
    };
    let client = match AudioClient::new_application_loopback_client(pid, include_tree)
        .and_then(|mut c| c.initialize_client(&format, &Direction::Capture, &mode).map(|_| c))
    {
        Ok(c) => c,
        Err(e) if include_tree => return Err(format!("som da janela: {e}")),
        Err(e) => {
            eprintln!("sysaudio: loopback por processo falhou ({e}); usando o dispositivo inteiro");
            let device = DeviceEnumerator::new().map_err(err)?.get_default_device(&Direction::Render).map_err(err)?;
            let mut c = device.get_iaudioclient().map_err(err)?;
            c.initialize_client(&format, &Direction::Capture, &mode).map_err(err)?;
            c
        }
    };
    let event = client.set_get_eventhandle().map_err(err)?;
    let reader = client.get_audiocaptureclient().map_err(err)?;
    client.start_stream().map_err(err)?;
    let _ = ready.send(Ok(()));

    let mut chunk = VecDeque::new();
    while GENERATION.load(Ordering::SeqCst) == gen {
        if event.wait_for_event(WAIT_MS).is_err() {
            continue; // nothing plays, nothing arrives: the page fills the gap with silence
        }
        while reader.get_next_packet_size().map_err(err)?.unwrap_or(0) > 0 {
            let before = chunk.len();
            let info = reader.read_from_device_to_deque(&mut chunk).map_err(err)?;
            if info.flags.silent {
                chunk.range_mut(before..).for_each(|b| *b = 0);
            }
        }
        if !chunk.is_empty() && out.send(InvokeResponseBody::Raw(chunk.drain(..).collect())).is_err() {
            break; // the page went away
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

// One app in the mix: its capture thread sends f32 samples, `buf` holds what was not mixed yet.
// Dropping it tells the thread to end, even while that app is silent and sends nothing.
struct Input {
    pid: u32,
    rx: mpsc::Receiver<Vec<f32>>,
    buf: VecDeque<f32>,
    stop: Arc<AtomicBool>,
}

impl Drop for Input {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

// Every app with a session gets its own process loopback, and this sums them. Each app's packets
// are queued in order and only the part every playing app has is mixed: the earlier mixer summed
// an app's second packet of a tick over its first, which is what distorted the sound.
fn capture_mix(gen: u32, fixed: Option<Vec<u32>>, format: &WaveFormat, mode: &StreamMode, out: &Channel<InvokeResponseBody>, ready: &mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    let mut inputs: Vec<Input> = Vec::new();
    let mut seen_ver = EXCLUDE_VER.load(Ordering::SeqCst);
    rescan(gen, &fixed, &mut inputs, format, mode);
    let _ = ready.send(Ok(())); // no app playing yet is fine: silence until one does
    let mut tick = 1u32;
    while GENERATION.load(Ordering::SeqCst) == gen {
        thread::sleep(Duration::from_millis(WAIT_MS as u64));
        let ver = EXCLUDE_VER.load(Ordering::SeqCst);
        if ver != seen_ver || tick % RESCAN_TICKS == 0 {
            seen_ver = ver;
            rescan(gen, &fixed, &mut inputs, format, mode);
        }
        tick = tick.wrapping_add(1);

        inputs.retain_mut(|i| loop {
            match i.rx.try_recv() {
                Ok(samples) => i.buf.extend(samples),
                Err(mpsc::TryRecvError::Empty) => break true,
                Err(mpsc::TryRecvError::Disconnected) => break false, // that app closed
            }
        });
        let n = inputs.iter().map(|i| i.buf.len()).filter(|&l| l > 0).min().unwrap_or(0);
        if n == 0 {
            continue; // nothing plays: the page fills the gap with silence
        }
        let mut mixed = vec![0f32; n];
        for i in &mut inputs {
            let take = n.min(i.buf.len());
            for (m, s) in mixed.iter_mut().zip(i.buf.drain(..take)) {
                *m += s;
            }
            let excess = i.buf.len().saturating_sub(MAX_LAG);
            i.buf.drain(..excess);
        }
        let bytes: Vec<u8> = mixed.iter().flat_map(|s| s.clamp(-1.0, 1.0).to_le_bytes()).collect();
        if out.send(InvokeResponseBody::Raw(bytes)).is_err() {
            break; // the page went away
        }
    }
    Ok(())
}

// Brings the inputs in line with who has a session now and with EXCLUDE. A capture takes the
// app's whole process tree, so an app whose tree holds this app or an excluded one (say a launcher
// that started Discord) stays out, and an app already under a captured one is not taken twice.
fn rescan(gen: u32, fixed: &Option<Vec<u32>>, inputs: &mut Vec<Input>, format: &WaveFormat, mode: &StreamMode) {
    let procs = Procs::snapshot();
    let me = std::process::id();
    let exclude = if fixed.is_some() { Vec::new() } else { EXCLUDE.lock().unwrap_or_else(|e| e.into_inner()).clone() };
    let blocked = |pid: u32| {
        procs.is_under(pid, me)
            || excluded(&exclude, &procs.name_of(pid))
            || procs.descendants(pid).any(|d| d == me || excluded(&exclude, &procs.name_of(d)))
    };
    inputs.retain(|i| !blocked(i.pid));

    let candidates = match fixed {
        Some(pids) => pids.clone(),
        None => session_pids(&Direction::Render, false).unwrap_or_else(|e| {
            eprintln!("sysaudio: lista de sessões falhou: {e}");
            Vec::new()
        }),
    };
    for pid in candidates {
        if pid == 0 || inputs.iter().any(|i| procs.is_under(pid, i.pid)) || blocked(pid) {
            continue;
        }
        inputs.retain(|i| !procs.is_under(i.pid, pid)); // this one's tree already has them
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let (format, mode, flag) = (format.clone(), *mode, stop.clone());
        thread::spawn(move || {
            if let Err(e) = capture_app(gen, pid, &format, &mode, &tx, &flag) {
                eprintln!("sysaudio: captura do PID {pid} parou: {e}");
            }
        });
        inputs.push(Input { pid, rx, buf: VecDeque::new(), stop });
    }
}

// One app's process loopback (its whole tree, same as a shared window), samples sent to the mixer.
fn capture_app(gen: u32, pid: u32, format: &WaveFormat, mode: &StreamMode, tx: &mpsc::Sender<Vec<f32>>, stop: &AtomicBool) -> Result<(), String> {
    let err = |e: wasapi::WasapiError| e.to_string();
    wasapi::initialize_mta().ok().map_err(|e| e.to_string())?;
    let mut client = AudioClient::new_application_loopback_client(pid, true).map_err(err)?;
    client.initialize_client(format, &Direction::Capture, mode).map_err(err)?;
    let event = client.set_get_eventhandle().map_err(err)?;
    let reader = client.get_audiocaptureclient().map_err(err)?;
    client.start_stream().map_err(err)?;

    let mut chunk: VecDeque<u8> = VecDeque::new();
    while GENERATION.load(Ordering::SeqCst) == gen && !stop.load(Ordering::SeqCst) {
        if event.wait_for_event(WAIT_MS).is_err() {
            continue; // nothing plays on this app right now
        }
        while reader.get_next_packet_size().map_err(err)?.unwrap_or(0) > 0 {
            let before = chunk.len();
            let info = reader.read_from_device_to_deque(&mut chunk).map_err(err)?;
            if info.flags.silent {
                chunk.range_mut(before..).for_each(|b| *b = 0);
            }
        }
        let whole = chunk.len() / 4 * 4;
        let bytes: Vec<u8> = chunk.drain(..whole).collect();
        let samples: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        if !samples.is_empty() && tx.send(samples).is_err() {
            break; // the mixer let go of this app
        }
    }
    let _ = client.stop_stream();
    Ok(())
}
