// System audio for the stream: WASAPI loopback of everything playing except this app's own
// process tree (so the voice chat it plays does not echo back), converted by Windows to stereo
// 48 kHz f32. Chromium's own loopback (getDisplayMedia systemAudio) fails on some devices,
// e.g. a 7.1 headset: "Could not start audio source", which also drops the screen. The page turns
// these chunks into an audio track (web/sysaudio.js), so the picker only has to give the video.
use std::{
    collections::VecDeque,
    ffi::OsString,
    os::windows::ffi::OsStringExt,
    sync::{atomic::{AtomicU32, Ordering}, mpsc},
    thread,
    time::Duration,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::Foundation::CloseHandle;

pub const RATE: usize = 48_000;
const CHANNELS: usize = 2;
const WAIT_MS: u32 = 100; // between generation checks when nothing plays
const BUFFER_HNS: i64 = 1_000_000; // 100 ms device buffer, in 100 ns units
const START_TIMEOUT: Duration = Duration::from_secs(3);

// Bumped by every start and stop: a capture thread runs while its generation is current,
// so starting again (switching the source) or stopping ends the previous one.
static GENERATION: AtomicU32 = AtomicU32::new(0);

#[link(name = "user32")]
extern "system" {
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
}

// Whose sound goes out. Excluding only the app leaves any other voice chat (Discord, WhatsApp) in
// the mix, and the friend hears themselves back; a shared window narrows it to that program.
// An allowlist captures N specific processes (identified by PID) and mixes them together,
// permitting precise control over which apps appear in the stream.
enum Source {
    AllButApp,
    Program(u32),
    Allowlist(Vec<u32>),
}

// Enumerate active audio sessions on the default render device. Returns (PID, executable name).
// Executable name is queried via QueryFullProcessImageNameW; if that fails (protected process),
// falls back to displaying the PID as a string.
pub fn list_sessions() -> Result<Vec<(u32, String)>, String> {
    let err = |e: wasapi::WasapiError| e.to_string();
    wasapi::initialize_mta().ok().map_err(|e| e.to_string())?;
    let device = DeviceEnumerator::new().map_err(err)?.get_default_device(&Direction::Render).map_err(err)?;
    let manager = device.get_iaudiosessionmanager().map_err(err)?;
    let enumerator = manager.get_audiosessionenumerator().map_err(err)?;
    let count = enumerator.get_count().map_err(err)?;

    let mut sessions = Vec::new();
    for i in 0..count {
        let control = enumerator.get_session(i).map_err(err)?;
        match control.get_process_id() {
            Ok(pid) if pid != std::process::id() => {
                // Try to get the executable name. If it fails, fall back to PID as string.
                let name = get_process_name(pid).unwrap_or_else(|_| format!("[PID {}]", pid));
                sessions.push((pid, name));
            }
            _ => {} // Skip our own process or query failures
        }
    }
    Ok(sessions)
}

// Query the executable name of a process by PID. Returns error if the process cannot be opened
// or the name cannot be queried (e.g., protected processes).
fn get_process_name(pid: u32) -> Result<String, String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|_| "não foi possível abrir o processo")?;
        let result = {
            let mut name_buf = vec![0u16; 260]; // MAX_PATH
            let mut size = name_buf.len() as u32;
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(name_buf.as_mut_ptr()), &mut size)
                .map_err(|_| "não foi possível consultar o nome do executável")?;
            // Decode UTF-16 string, trimming to the returned size.
            let name_os = OsString::from_wide(&name_buf[..size as usize]);
            name_os.into_string()
                .map_err(|_| "nome do executável contém caracteres inválidos")?
        };
        let _ = CloseHandle(handle);
        Ok(result)
    }
}

// `window` is the HWND of the shared window (Chromium's window source id), if one was picked.
// `pids` is an optional list of PIDs to capture. When None or empty, behaves like AllButApp.
// When set, captures only the specified processes and mixes them together.
pub fn start(out: Channel<InvokeResponseBody>, window: Option<u64>, pids: Option<Vec<u32>>) -> Result<(), String> {
    let source = match window {
        Some(hwnd) => {
            // Window mode takes precedence over pids: if a window is selected, use it.
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd as isize, &mut pid) };
            if pid == 0 {
                return Err("a janela escolhida não existe mais".into());
            }
            Source::Program(pid)
        }
        None => {
            // Check if pids list is non-empty; if so, use Allowlist mode.
            if let Some(pids_list) = pids {
                if !pids_list.is_empty() {
                    Source::Allowlist(pids_list)
                } else {
                    Source::AllButApp
                }
            } else {
                Source::AllButApp
            }
        }
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

    match source {
        Source::Allowlist(pids) => {
            // Allowlist mode: capture from multiple processes and mix their audio streams.
            // Each process runs in its own capture thread; capture_allowlist mixes them.
            capture_allowlist(gen, pids, &format, &mode, out, ready)
        }
        _ => {
            // Single-source mode (AllButApp or Program): use the original single-client approach.
            // Process loopback (Windows 10 2004+): the shared program's tree only, or everything but our
            // own tree. Capturing a render device (Direction::Capture on it) is the fallback for the
            // latter, and includes our sound; a program has no fallback, the page goes back to AllButApp.
            let (pid, include_tree) = match source {
                Source::Program(pid) => (pid, true),
                Source::AllButApp => (std::process::id(), false),
                Source::Allowlist(_) => unreachable!(),
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
    }
}

// Capture from an allowlist of PIDs and mix the audio streams together. One thread per PID
// opens its own application-loopback client (same include_tree=true path a shared window
// uses) and pushes raw f32 frames into its own channel; this function only mixes. Threads are
// independent (each with its own 100 ms device buffer) rather than one shared clock, so streams
// can drift slightly relative to each other — accepted for a first version, see PLANO-audio-
// permissao-apps.md risk table.
fn capture_allowlist(gen: u32, pids: Vec<u32>, format: &WaveFormat, mode: &StreamMode, out: &Channel<InvokeResponseBody>, ready: &mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    let mut receivers = Vec::with_capacity(pids.len());
    let (started_tx, started_rx) = mpsc::channel::<Result<u32, (u32, String)>>();
    for pid in pids {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        receivers.push(rx);
        let format = format.clone();
        let mode = *mode;
        let started_tx = started_tx.clone();
        thread::spawn(move || {
            if let Err(e) = capture_single_pid(gen, pid, &format, &mode, &tx, &started_tx) {
                eprintln!("sysaudio: captura do PID {pid} parou: {e}");
            }
        });
    }
    drop(started_tx); // each clone above is dropped with its thread; this one closes the channel once they all do

    // A PID whose app closed right before Start (or that never had a loopback client to begin
    // with) just drops out of the mix instead of failing every other selected app.
    let mut ok = 0;
    for _ in 0..receivers.len() {
        match started_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(_)) => ok += 1,
            Ok(Err((pid, e))) => eprintln!("sysaudio: PID {pid} não pôde ser capturado: {e}"),
            Err(_) => break, // a thread never reported back in time; counts as failed below
        }
    }
    if ok == 0 {
        return Err("nenhum dos apps selecionados pôde ser capturado".into());
    }
    let _ = ready.send(Ok(()));

    // Mix: every WAIT_MS, drain whatever each PID produced since the last tick and sum same-
    // index f32 samples with a clamp (same cadence and stereo f32 format as the single-source
    // path, so web/sysaudio.js sees no difference in the bytes it gets).
    while GENERATION.load(Ordering::SeqCst) == gen {
        thread::sleep(Duration::from_millis(WAIT_MS as u64));
        let mut mixed: Vec<f32> = Vec::new();
        for rx in &receivers {
            while let Ok(data) = rx.try_recv() {
                for (i, s) in data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).enumerate() {
                    if i >= mixed.len() {
                        mixed.push(0.0);
                    }
                    mixed[i] = (mixed[i] + s).clamp(-1.0, 1.0);
                }
            }
        }
        if !mixed.is_empty() {
            let bytes: Vec<u8> = mixed.iter().flat_map(|s| s.to_le_bytes()).collect();
            if out.send(InvokeResponseBody::Raw(bytes)).is_err() {
                break; // the page went away
            }
        }
    }
    Ok(())
}

// Capture audio from a single process loopback (include_tree=true, same as a shared window) and
// push its raw f32 frames to `tx` for capture_allowlist to mix. Reports its own startup result on
// `started` before looping, so a PID that can no longer be captured is detected up front.
fn capture_single_pid(gen: u32, pid: u32, format: &WaveFormat, mode: &StreamMode, tx: &mpsc::Sender<Vec<u8>>, started: &mpsc::Sender<Result<u32, (u32, String)>>) -> Result<(), String> {
    let err = |e: wasapi::WasapiError| e.to_string();
    let setup = || -> Result<_, String> {
        wasapi::initialize_mta().ok().map_err(|e| e.to_string())?;
        let mut client = AudioClient::new_application_loopback_client(pid, true).map_err(err)?;
        client.initialize_client(format, &Direction::Capture, mode).map_err(err)?;
        let event = client.set_get_eventhandle().map_err(err)?;
        let reader = client.get_audiocaptureclient().map_err(err)?;
        client.start_stream().map_err(err)?;
        Ok((client, event, reader))
    };
    let (client, event, reader) = match setup() {
        Ok(v) => v,
        Err(e) => {
            let _ = started.send(Err((pid, e.clone())));
            return Err(e);
        }
    };
    let _ = started.send(Ok(pid));

    let mut chunk = VecDeque::new();
    while GENERATION.load(Ordering::SeqCst) == gen {
        if event.wait_for_event(WAIT_MS).is_err() {
            continue; // nothing plays on this process right now
        }
        while reader.get_next_packet_size().map_err(err)?.unwrap_or(0) > 0 {
            let before = chunk.len();
            let info = reader.read_from_device_to_deque(&mut chunk).map_err(err)?;
            if info.flags.silent {
                chunk.range_mut(before..).for_each(|b| *b = 0);
            }
        }
        if !chunk.is_empty() && tx.send(chunk.drain(..).collect()).is_err() {
            break; // the mixer stopped listening (generation changed)
        }
    }
    let _ = client.stop_stream();
    Ok(())
}
