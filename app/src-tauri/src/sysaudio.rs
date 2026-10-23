// System audio for the stream: WASAPI loopback of everything playing except this app's own
// process tree (so the voice chat it plays does not echo back), converted by Windows to stereo
// 48 kHz f32. Chromium's own loopback (getDisplayMedia systemAudio) fails on some devices,
// e.g. a 7.1 headset: "Could not start audio source", which also drops the screen. The page turns
// these chunks into an audio track (web/sysaudio.js), so the picker only has to give the video.
use std::{
    collections::VecDeque,
    sync::{atomic::{AtomicU32, Ordering}, mpsc},
    thread,
    time::Duration,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

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
enum Source {
    AllButApp,
    Program(u32),
}

// `window` is the HWND of the shared window (Chromium's window source id), if one was picked.
pub fn start(out: Channel<InvokeResponseBody>, window: Option<u64>) -> Result<(), String> {
    let source = match window {
        None => Source::AllButApp,
        Some(hwnd) => {
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd as isize, &mut pid) };
            if pid == 0 {
                return Err("a janela escolhida não existe mais".into());
            }
            Source::Program(pid)
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
    // Process loopback (Windows 10 2004+): the shared program's tree only, or everything but our
    // own tree. Capturing a render device (Direction::Capture on it) is the fallback for the
    // latter, and includes our sound; a program has no fallback, the page goes back to AllButApp.
    let (pid, include_tree) = match source {
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
