//! Slice 1b: the "Transmitir" window. Picker (monitors + windows), 60 Hz preview of the captured
//! source and the button that runs this same exe headless (slice 1a) as a child process.
//!
//! Preview: WGC frame → BGRA copy → D3D11 video processor (scale + letterbox to PW×PH) → target:
//!   femtovg | skia : pool of D3D11 textures shared with our wgpu DX12 device (no CPU copy, as
//!                    e2e/bench/proto07), Slint redraws the whole window per frame;
//!   partial        : Slint software renderer (dirty regions only), frame read back to the CPU;
//!   swapchain      : own DXGI flip swap chain on a child HWND over the preview area; Slint only
//!                    redraws when the UI itself changes.
//! `--bench <s>`: after 3 s of warm-up, prints {"cpuCorePct", "workingSetMB", ...} and quits.
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use slint::wgpu_30::wgpu;
use slint::ComponentHandle;
use windows::core::{Interface, BOOL, PCWSTR};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureSession};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HMODULE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::capture::{self, FPS};
use crate::Args;

/// Preview size (= the preview area at 100 % scale).
const PW: u32 = 960;
const PH: u32 = 540;
const POOL: usize = 3;
const GENERIC_ALL: u32 = 0x1000_0000;
const WARMUP: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Render {
    Femtovg,
    Skia,
    Partial,
    Swapchain,
}

impl Render {
    pub fn parse(s: &str) -> Option<Render> {
        Some(match s {
            "femtovg" => Render::Femtovg,
            "skia" => Render::Skia,
            "partial" => Render::Partial,
            "swapchain" => Render::Swapchain,
            _ => return None,
        })
    }
}

slint::slint! {
    import { ComboBox, LineEdit, Palette } from "std-widgets.slint";

    component PrimaryButton inherits Rectangle {
        in property <string> text;
        callback clicked;
        height: 44px;
        min-width: 220px;
        border-radius: 12px;
        border-width: fs.has-focus ? 2px : 0px;
        border-color: #cc99ff;
        background: ta.pressed ? #6a00d6 : ta.has-hover ? #8f1fff : #7f00ff;
        accessible-role: button;
        accessible-label: root.text;
        accessible-action-default => { root.clicked(); }
        fs := FocusScope {
            key-pressed(e) => {
                if (e.text == " " || e.text == "\n") { root.clicked(); return accept; }
                reject
            }
        }
        ta := TouchArea { clicked => { fs.focus(); root.clicked(); } }
        Text { text: root.text; color: #ffffff; font-size: 15px; font-weight: 600; horizontal-alignment: center; vertical-alignment: center; }
    }

    export component App inherits Window {
        title: "Stream P2P · Transmitir";
        background: #0a0a0b;
        min-width: 1000px;
        min-height: 820px;
        in property <image> video;
        in property <bool> has-video;
        in property <[string]> sources;
        in-out property <int> source-index;
        in-out property <string> name: "Transmissor";
        in property <bool> live;
        in property <bool> starting;
        in property <string> invite;
        in property <string> status: "Escolha o que compartilhar e clique em Começar a transmitir.";
        callback source-changed(int);
        callback toggle();
        out property <length> preview-x: preview.absolute-position.x;
        out property <length> preview-y: preview.absolute-position.y;
        init => { Palette.color-scheme = ColorScheme.dark; }
        VerticalLayout {
            padding: 20px;
            spacing: 14px;
            alignment: start;
            Rectangle {
                height: 56px;
                background: #141416;
                border-radius: 12px;
                border-width: 1px;
                border-color: #2a2a30;
                HorizontalLayout {
                    padding-left: 16px;
                    padding-right: 16px;
                    alignment: space-between;
                    Text { text: "STREAM P2P"; font-size: 24px; font-weight: 900; color: #f2f2f4; vertical-alignment: center; }
                    Text {
                        text: root.live ? "● AO VIVO" : root.starting ? "Conectando…" : "Fora do ar";
                        color: root.live ? rgb(46, 229, 157) : #a1a1aa;
                        font-weight: 600;
                        vertical-alignment: center;
                    }
                }
            }
            Text { text: "Transmitir"; font-size: 22px; font-weight: 700; color: #f2f2f4; accessible-role: text; }
            HorizontalLayout {
                spacing: 12px;
                alignment: start;
                Text { text: "O que compartilhar"; color: #a1a1aa; vertical-alignment: center; width: 150px; }
                ComboBox {
                    width: 810px;
                    model: root.sources;
                    current-index <=> root.source-index;
                    enabled: !root.live && !root.starting;
                    accessible-label: "O que compartilhar";
                    selected => { root.source-changed(self.current-index); }
                }
            }
            HorizontalLayout {
                alignment: start;
                preview := Rectangle {
                    width: 960px;
                    height: 540px;
                    background: #000000;
                    border-width: 1px;
                    border-color: #2a2a30;
                    Image {
                        width: 100%;
                        height: 100%;
                        source: root.video;
                        image-fit: contain;
                        accessible-role: image;
                        accessible-label: "Prévia do que você vai transmitir";
                    }
                    if !root.has-video: Text { text: "Sem prévia ainda"; color: #a1a1aa; }
                }
            }
            HorizontalLayout {
                spacing: 12px;
                alignment: start;
                Text { text: "Seu nome"; color: #a1a1aa; vertical-alignment: center; width: 150px; }
                LineEdit { width: 300px; text <=> root.name; placeholder-text: "Seu nome"; accessible-label: "Seu nome"; enabled: !root.live && !root.starting; }
                PrimaryButton {
                    text: root.live || root.starting ? "Parar de transmitir" : "Começar a transmitir";
                    clicked => { root.toggle(); }
                }
            }
            HorizontalLayout {
                spacing: 12px;
                alignment: start;
                Text { text: "Convite"; color: #a1a1aa; vertical-alignment: center; width: 150px; }
                LineEdit { width: 810px; read-only: true; text: root.invite; placeholder-text: "O link aparece aqui ao começar"; accessible-label: "Convite"; }
            }
            Text { text: root.status; color: #a1a1aa; wrap: word-wrap; accessible-role: text; }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Src {
    Monitor(usize),
    Window(isize),
}

impl Src {
    fn args(self) -> Vec<String> {
        match self {
            Src::Monitor(i) => vec!["--monitor".into(), i.to_string()],
            Src::Window(h) => vec!["--window".into(), h.to_string()],
        }
    }
}

/// Monitors ("Tela 1 (2560×1440)") then visible top-level windows with a title.
fn sources() -> Vec<(Src, String)> {
    let mut v = vec![];
    for (i, m) in capture::monitors().into_iter().enumerate() {
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = unsafe { GetMonitorInfoW(m, &mut mi) };
        let r = mi.rcMonitor;
        v.push((Src::Monitor(i), format!("Tela {} ({}×{})", i + 1, r.right - r.left, r.bottom - r.top)));
    }
    unsafe extern "system" fn push(h: HWND, list: LPARAM) -> BOOL {
        let list = &mut *(list.0 as *mut Vec<(Src, String)>);
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4);
        let tool = GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0;
        let owned = GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid());
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(h, &mut buf) as usize;
        if IsWindowVisible(h).as_bool() && cloaked == 0 && !tool && !owned && n > 0 {
            list.push((Src::Window(h.0 as isize), format!("Janela: {}", String::from_utf16_lossy(&buf[..n]))));
        }
        true.into()
    }
    unsafe {
        let _ = EnumWindows(Some(push), LPARAM(&mut v as *mut _ as isize));
    }
    v
}

/// Target rect of a sw×sh picture scaled to fit pw×ph, centered (letterbox / pillarbox).
fn letterbox(sw: u32, sh: u32, pw: u32, ph: u32) -> RECT {
    let s = (pw as f64 / sw as f64).min(ph as f64 / sh as f64);
    let (w, h) = (((sw as f64 * s).round() as i32).min(pw as i32), ((sh as f64 * s).round() as i32).min(ph as i32));
    let (l, t) = ((pw as i32 - w) / 2, (ph as i32 - h) / 2);
    RECT { left: l, top: t, right: l + w, bottom: t + h }
}

fn cpu_s() -> f64 {
    let (mut a, mut b, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut k, &mut u).unwrap() };
    let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 1e7;
    t(k) + t(u)
}

fn working_set_mb() -> f64 {
    let mut c = PROCESS_MEMORY_COUNTERS::default();
    unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32).unwrap() };
    c.WorkingSetSize as f64 / 1048576.0
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    loop {
        if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::yield_now();
    }
}

fn tex(d11: &ID3D11Device, w: u32, h: u32, fmt: DXGI_FORMAT, bind: u32, usage: D3D11_USAGE, cpu: u32, misc: u32) -> ID3D11Texture2D {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: fmt,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: usage,
        BindFlags: bind,
        CPUAccessFlags: cpu,
        MiscFlags: misc,
    };
    let mut t = None;
    unsafe { d11.CreateTexture2D(&desc, None, Some(&mut t)).unwrap() };
    t.unwrap()
}

/// 60 Hz cadence over a faster source (e.g. 144 Hz display ticks): a frame is taken when its
/// slot is due; slots advance by exactly 1/60 s so the average holds at 60.
struct Pace {
    next: Instant,
}

impl Pace {
    const STEP: Duration = Duration::from_nanos(1_000_000_000 / FPS as u64);
    fn take(&mut self, now: Instant) -> bool {
        if now < self.next {
            return false;
        }
        self.next = if now - self.next > Self::STEP { now + Self::STEP } else { self.next + Self::STEP };
        true
    }
}

/// GPU sync between the D3D11 writer and wgpu's D3D12 queue (pool mode), as in proto07.
struct Sync {
    f11: ID3D11Fence,
    f11_in12: ID3D12Fence,
    f12: ID3D12Fence,
    f12_in11: ID3D11Fence,
    render_done: [AtomicU64; POOL],
    /// (texture index, D3D11 fence value it is ready at), read by the render notifier.
    cur: Mutex<(usize, u64)>,
    renders: AtomicU64,
}

enum Target {
    Pool(Vec<ID3D11Texture2D>, Arc<Sync>),
    Readback(ID3D11Texture2D, ID3D11Texture2D),
    Swapchain(Option<IDXGISwapChain1>),
}

enum Msg {
    Frame,
    Source(Src),
    Hwnd(isize),
}

struct Cap {
    pool: Direct3D11CaptureFramePool,
    _session: GraphicsCaptureSession,
    bgra: ID3D11Texture2D,
    vp: ID3D11VideoProcessor,
    venum: ID3D11VideoProcessorEnumerator,
    iv: ID3D11VideoProcessorInputView,
}

impl Drop for Cap {
    fn drop(&mut self) {
        let _ = self._session.Close();
        let _ = self.pool.Close();
    }
}

fn open(src: Src, d11: &ID3D11Device, c11: &ID3D11DeviceContext, tx: &Sender<Msg>) -> windows::core::Result<Cap> {
    let item = match src {
        Src::Monitor(i) => capture::item(Some(i), None)?,
        Src::Window(h) => capture::item(None, Some(h))?,
    };
    let size = item.Size()?;
    let (sw, sh) = (size.Width as u32, size.Height as u32);
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&capture::winrt_device(d11)?, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
    let tx = Mutex::new(tx.clone());
    pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
        let _ = tx.lock().unwrap().send(Msg::Frame);
        Ok(())
    }))?;
    let session = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetIsCursorCaptureEnabled(true);
    let _ = session.SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: 10_000 }); // 1 ms; Pace caps at 60 Hz
    let vdev: ID3D11VideoDevice = d11.cast()?;
    let vctx: ID3D11VideoContext = c11.cast()?;
    let cd = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
        InputWidth: sw,
        InputHeight: sh,
        OutputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
        OutputWidth: PW,
        OutputHeight: PH,
        Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
    };
    let bgra = tex(d11, sw, sh, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET.0 as u32, D3D11_USAGE_DEFAULT, 0, 0);
    unsafe {
        let venum = vdev.CreateVideoProcessorEnumerator(&cd)?;
        let vp = vdev.CreateVideoProcessor(&venum, 0)?;
        let lb = letterbox(sw, sh, PW, PH);
        vctx.VideoProcessorSetOutputTargetRect(&vp, true, Some(&lb));
        let black = D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 } } };
        vctx.VideoProcessorSetOutputBackgroundColor(&vp, false, &black);
        let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut iv = None;
        vdev.CreateVideoProcessorInputView(&bgra, &venum, &ivd, Some(&mut iv))?;
        session.StartCapture()?;
        eprintln!("prévia: {sw}x{sh} → {PW}x{PH}");
        Ok(Cap { pool, _session: session, bgra, vp, venum, iv: iv.unwrap() })
    }
}

/// Capture thread: owns the WGC session, wakes on FrameArrived, writes the preview target.
fn worker(rx: Receiver<Msg>, tx: Sender<Msg>, d11: ID3D11Device, c11: ID3D11DeviceContext, mut target: Target, app: slint::Weak<App>, frames: Arc<AtomicU64>) {
    unsafe {
        let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
    }
    let vdev: ID3D11VideoDevice = d11.cast().unwrap();
    let vctx: ID3D11VideoContext = c11.cast().unwrap();
    let c11_4: ID3D11DeviceContext4 = c11.cast().unwrap();
    let mut cap: Option<Cap> = None;
    let mut ovs: Vec<ID3D11VideoProcessorOutputView> = vec![];
    let (mut k, mut sig) = (0usize, 0u64);
    let mut pace = Pace { next: Instant::now() };
    let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
    };
    let view = |t: &ID3D11Texture2D, venum: &ID3D11VideoProcessorEnumerator| unsafe {
        let mut ov = None;
        vdev.CreateVideoProcessorOutputView(t, venum, &ovd, Some(&mut ov)).map(|_| ov.unwrap())
    };
    while let Ok(m) = rx.recv() {
        match m {
            Msg::Source(src) => {
                cap = None;
                match open(src, &d11, &c11, &tx) {
                    Ok(c) => {
                        ovs = match &target {
                            Target::Pool(t, _) => t.iter().map(|t| view(t, &c.venum).unwrap()).collect(),
                            Target::Readback(t, _) => vec![view(t, &c.venum).unwrap()],
                            Target::Swapchain(_) => vec![],
                        };
                        cap = Some(c);
                    }
                    Err(e) => {
                        let msg = format!("Não deu para capturar isso ({e}). Escolha outra tela ou janela.");
                        let _ = app.upgrade_in_event_loop(move |a| a.set_status(msg.into()));
                    }
                }
            }
            Msg::Hwnd(h) => {
                if let Target::Swapchain(sc) = &mut target {
                    let desc = DXGI_SWAP_CHAIN_DESC1 {
                        Width: PW,
                        Height: PH,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                        BufferCount: 2,
                        Scaling: DXGI_SCALING_STRETCH,
                        SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
                        ..Default::default()
                    };
                    let f: IDXGIFactory2 = unsafe { CreateDXGIFactory1().unwrap() };
                    *sc = Some(unsafe { f.CreateSwapChainForHwnd(&d11, HWND(h as _), &desc, None, None).unwrap() });
                }
            }
            Msg::Frame => {
                let Some(c) = &cap else { continue };
                let mut frame = None;
                while let Ok(f) = c.pool.TryGetNextFrame() {
                    if let Some(old) = frame.replace(f) {
                        let _ = old.Close();
                    }
                }
                let Some(f) = frame else { continue };
                // 1 ms of slack: a 144 Hz tick lands a hair before the slot
                if !pace.take(Instant::now() + Duration::from_millis(1)) {
                    let _ = f.Close();
                    continue;
                }
                unsafe {
                    let surface = f.Surface().unwrap();
                    let t: ID3D11Texture2D = surface.cast::<IDirect3DDxgiInterfaceAccess>().unwrap().GetInterface().unwrap();
                    c11.CopyResource(&c.bgra, &t);
                    let _ = surface.Close();
                    let _ = f.Close();
                    let blt = |ov: &ID3D11VideoProcessorOutputView| {
                        let streams = [D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: std::mem::ManuallyDrop::new(Some(c.iv.clone())), ..Default::default() }];
                        let r = vctx.VideoProcessorBlt(&c.vp, ov, 0, &streams);
                        let [mut s] = streams;
                        std::mem::ManuallyDrop::drop(&mut s.pInputSurface);
                        r
                    };
                    match &target {
                        Target::Pool(_, sy) => {
                            // reuse texture k only after D3D12 finished the last render that sampled it
                            k = (k + 1) % POOL;
                            let done = sy.render_done[k].load(Ordering::Acquire);
                            if done > 0 {
                                c11_4.Wait(&sy.f12_in11, done).unwrap();
                            }
                            let _ = blt(&ovs[k]);
                            sig += 1;
                            c11_4.Signal(&sy.f11, sig).unwrap();
                            c11_4.Flush();
                            let (sy, kk, s) = (sy.clone(), k, sig);
                            let _ = app.upgrade_in_event_loop(move |a| {
                                *sy.cur.lock().unwrap() = (kk, s);
                                a.set_video(IMAGES.with(|v| v.borrow()[kk].clone()));
                                a.set_has_video(true);
                            });
                        }
                        Target::Readback(rgba, staging) => {
                            let _ = blt(&ovs[0]);
                            c11.CopyResource(staging, rgba);
                            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
                            if c11.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut m)).is_ok() {
                                let mut buf = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::new(PW, PH);
                                let dst = buf.make_mut_bytes();
                                let row = PW as usize * 4;
                                for y in 0..PH as usize {
                                    std::ptr::copy_nonoverlapping((m.pData as *const u8).add(y * m.RowPitch as usize), dst[y * row..].as_mut_ptr(), row);
                                }
                                c11.Unmap(staging, 0);
                                let _ = app.upgrade_in_event_loop(move |a| {
                                    a.set_video(slint::Image::from_rgba8(buf));
                                    a.set_has_video(true);
                                });
                            }
                        }
                        Target::Swapchain(Some(sc)) => {
                            let bb: ID3D11Texture2D = sc.GetBuffer(0).unwrap();
                            if let Ok(ov) = view(&bb, &c.venum) {
                                let _ = blt(&ov);
                            }
                            let _ = sc.Present(1, DXGI_PRESENT(0));
                        }
                        Target::Swapchain(None) => {}
                    }
                }
                frames.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

thread_local! {
    static IMAGES: std::cell::RefCell<Vec<slint::Image>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// wgpu DX12 device handed to Slint, D3D11 on the same adapter, shared pool + fences (proto07).
fn wgpu_setup(pool: bool) -> (ID3D11Device, ID3D11DeviceContext, Option<Target>) {
    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle();
    idesc.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(idesc);
    let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).expect("sem adaptador DX12");
    let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("sp2p-ui"), memory_hints: wgpu::MemoryHints::MemoryUsage, ..Default::default() })).unwrap();
    let (dxgi_adapter, d3d12): (IDXGIAdapter, ID3D12Device) = unsafe {
        let a = adapter.as_hal::<wgpu::hal::api::Dx12>().unwrap();
        let d = device.as_hal::<wgpu::hal::api::Dx12>().unwrap();
        (a.as_raw().cast().unwrap(), d.raw_device().clone())
    };
    let (mut d11, mut c11) = (None, None);
    unsafe {
        D3D11CreateDevice(&dxgi_adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut d11), None, Some(&mut c11)).unwrap();
    }
    let (d11, c11): (ID3D11Device, ID3D11DeviceContext) = (d11.unwrap(), c11.unwrap());
    unsafe {
        let _ = d11.cast::<ID3D11Multithread>().unwrap().SetMultithreadProtected(true);
    }
    slint::BackendSelector::new()
        .require_wgpu_30(slint::wgpu_30::WGPUConfiguration::Manual { instance, adapter, device: device.clone(), queue: queue.clone() })
        .renderer_name(if pool && std::env::var_os("SP2P_SKIA").is_some() { "skia-wgpu" } else { "femtovg-wgpu" }.into())
        .select()
        .expect("Slint sobre wgpu");
    if !pool {
        return (d11, c11, None);
    }
    let sync = unsafe {
        let d11_5: ID3D11Device5 = d11.cast().unwrap();
        let mut f11: Option<ID3D11Fence> = None;
        d11_5.CreateFence(0, D3D11_FENCE_FLAG_SHARED, &mut f11).unwrap();
        let f11 = f11.unwrap();
        let h = f11.CreateSharedHandle(None, GENERIC_ALL, None).unwrap();
        let mut f11_in12: Option<ID3D12Fence> = None;
        d3d12.OpenSharedHandle(h, &mut f11_in12).unwrap();
        let _ = CloseHandle(h);
        let f12: ID3D12Fence = d3d12.CreateFence(0, D3D12_FENCE_FLAG_SHARED).unwrap();
        let h = d3d12.CreateSharedHandle(&f12, None, GENERIC_ALL, None).unwrap();
        let mut f12_in11: Option<ID3D11Fence> = None;
        d11_5.OpenSharedFence(h, &mut f12_in11).unwrap();
        let _ = CloseHandle(h);
        Arc::new(Sync { f11, f11_in12: f11_in12.unwrap(), f12, f12_in11: f12_in11.unwrap(), render_done: Default::default(), cur: Mutex::new((0, 0)), renders: AtomicU64::new(0) })
    };
    let mut texs = vec![];
    let mut images = vec![];
    for _ in 0..POOL {
        let misc = (D3D11_RESOURCE_MISC_SHARED.0 | D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0) as u32;
        let t = tex(&d11, PW, PH, DXGI_FORMAT_R8G8B8A8_UNORM, (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32, D3D11_USAGE_DEFAULT, 0, misc);
        unsafe {
            let h: HANDLE = t.cast::<IDXGIResource1>().unwrap().CreateSharedHandle(None, 0x8000_0000 | 1, None).unwrap();
            let mut r: Option<ID3D12Resource> = None;
            d3d12.OpenSharedHandle(h, &mut r).unwrap();
            let _ = CloseHandle(h);
            let size = wgpu::Extent3d { width: PW, height: PH, depth_or_array_layers: 1 };
            let hal = wgpu::hal::dx12::Device::texture_from_raw(r.unwrap(), wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureDimension::D2, size, 1, 1);
            let wt = device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
                hal,
                &wgpu::TextureDescriptor { label: Some("preview"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] },
                wgpu::TextureUses::UNINITIALIZED,
            );
            images.push(slint::Image::try_from(wt).expect("textura da prévia no Slint"));
        }
        texs.push(t);
    }
    IMAGES.with(|v| *v.borrow_mut() = images);
    let sy = sync.clone();
    let raw = move || unsafe { queue.as_hal::<wgpu::hal::api::Dx12>().unwrap().as_raw().clone() };
    POOL_NOTIFIER.with(|n| {
        *n.borrow_mut() = Some(Box::new(move |state: &slint::RenderingState| match state {
            slint::RenderingState::BeforeRendering => {
                let (_, ready) = *sy.cur.lock().unwrap();
                if ready > 0 {
                    unsafe { raw().Wait(&sy.f11_in12, ready).unwrap() };
                }
            }
            slint::RenderingState::AfterRendering => {
                let v = sy.renders.fetch_add(1, Ordering::Relaxed) + 1;
                unsafe { raw().Signal(&sy.f12, v).unwrap() };
                let (tex, _) = *sy.cur.lock().unwrap();
                sy.render_done[tex].store(v, Ordering::Release);
            }
            _ => {}
        }));
    });
    (d11, c11, Some(Target::Pool(texs, sync)))
}

type Notifier = Box<dyn FnMut(&slint::RenderingState)>;
thread_local! {
    static POOL_NOTIFIER: std::cell::RefCell<Option<Notifier>> = const { std::cell::RefCell::new(None) };
}

/// The presenter (slice 1a) as a child process; its first stdout line is the invite.
fn start(server: &str, audio: &str, name: &str, src: Src, app: slint::Weak<App>) -> std::io::Result<Child> {
    let name = if name.is_empty() { "Transmissor" } else { name };
    let mut a = vec!["--server".to_string(), server.into(), "--name".into(), name.into(), "--audio".into(), audio.into()];
    a.extend(src.args());
    let mut child = Command::new(std::env::current_exe()?).args(&a).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
    let out = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(url) = line.strip_prefix("Convite: ") {
                let url = url.to_string();
                let _ = app.upgrade_in_event_loop(move |a| {
                    a.set_invite(url.into());
                    a.set_starting(false);
                    a.set_live(true);
                    a.set_status("Ao vivo. Mande o convite para quem vai assistir.".into());
                });
            }
        }
        let _ = app.upgrade_in_event_loop(|a| {
            if a.get_live() || a.get_starting() {
                a.set_live(false);
                a.set_starting(false);
                a.set_status("A transmissão parou. Veja o motivo no registro (stderr).".into());
            }
        });
    });
    Ok(child)
}

pub fn run(args: &Args) {
    let mode = if std::env::var_os("SP2P_SKIA").is_some() { Render::Skia } else { args.render };
    if mode == Render::Skia {
        std::env::set_var("SP2P_SKIA", "1");
    }
    let (d11, c11, target) = match mode {
        Render::Femtovg | Render::Skia => {
            let (d, c, t) = wgpu_setup(true);
            (d, c, t.unwrap())
        }
        Render::Swapchain => {
            let (d, c, _) = wgpu_setup(false);
            (d, c, Target::Swapchain(None))
        }
        Render::Partial => {
            slint::BackendSelector::new().renderer_name("software".into()).select().expect("Slint software");
            let (d, c) = crate::d3d();
            let rgba = tex(&d, PW, PH, DXGI_FORMAT_R8G8B8A8_UNORM, D3D11_BIND_RENDER_TARGET.0 as u32, D3D11_USAGE_DEFAULT, 0, 0);
            let staging = tex(&d, PW, PH, DXGI_FORMAT_R8G8B8A8_UNORM, 0, D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ.0 as u32, 0);
            (d, c, Target::Readback(rgba, staging))
        }
    };
    eprintln!("ui: renderizador {mode:?}");

    let list = sources();
    let mut list: Vec<(Src, String)> = list;
    if let Some(h) = args.window {
        if !list.iter().any(|(s, _)| *s == Src::Window(h)) {
            list.push((Src::Window(h), format!("Janela {h}")));
        }
    }
    let first = match (args.window, args.monitor) {
        (Some(h), _) => list.iter().position(|(s, _)| *s == Src::Window(h)).unwrap_or(0),
        (None, Some(m)) => list.iter().position(|(s, _)| *s == Src::Monitor(m)).unwrap_or(0),
        _ => 0,
    };
    let app = App::new().unwrap();
    let names: Vec<slint::SharedString> = list.iter().map(|(_, n)| n.into()).collect();
    app.set_sources(std::rc::Rc::new(slint::VecModel::from(names)).into());
    app.set_source_index(first as i32);
    app.set_name(args.name.clone().into());

    let renders = Arc::new(AtomicU64::new(0));
    {
        let renders = renders.clone();
        let mut pool_cb = POOL_NOTIFIER.with(|n| n.borrow_mut().take());
        let _ = app.window().set_rendering_notifier(move |state, _| {
            if let Some(cb) = pool_cb.as_mut() {
                cb(&state);
            }
            if matches!(state, slint::RenderingState::AfterRendering) {
                renders.fetch_add(1, Ordering::Relaxed);
            }
        });
    }

    let frames = Arc::new(AtomicU64::new(0));
    let (tx, rx) = channel();
    {
        let (tx, app, frames) = (tx.clone(), app.as_weak(), frames.clone());
        std::thread::spawn(move || worker(rx, tx, d11, c11, target, app, frames));
    }
    let src_of = {
        let list = list.clone();
        move |i: i32| list.get(i.max(0) as usize).map(|(s, _)| *s)
    };
    if let Some(s) = src_of(first as i32) {
        let _ = tx.send(Msg::Source(s));
    }
    {
        let (tx, src_of) = (tx.clone(), src_of.clone());
        app.on_source_changed(move |i| {
            if let Some(s) = src_of(i) {
                let _ = tx.send(Msg::Source(s));
            }
        });
    }

    let child: std::rc::Rc<std::cell::RefCell<Option<Child>>> = Default::default();
    {
        let (child, weak, server, audio) = (child.clone(), app.as_weak(), args.server.clone(), args.audio.clone());
        app.on_toggle(move || {
            let a = weak.upgrade().unwrap();
            if let Some(mut c) = child.borrow_mut().take() {
                let _ = c.kill();
                let _ = c.wait();
                a.set_live(false);
                a.set_starting(false);
                a.set_invite("".into());
                a.set_status("Transmissão encerrada.".into());
                return;
            }
            let Some(src) = src_of(a.get_source_index()) else { return };
            match start(&server, &audio, a.get_name().trim(), src, weak.clone()) {
                Ok(c) => {
                    *child.borrow_mut() = Some(c);
                    a.set_starting(true);
                    a.set_status("Criando a sessão no servidor…".into());
                }
                Err(e) => a.set_status(format!("Não deu para começar: {e}").into()),
            }
        });
    }

    // swapchain: child HWND over the preview area, moved with the layout
    let mut timers = vec![];
    if mode == Render::Swapchain {
        let t = slint::Timer::default();
        let (weak, tx) = (app.as_weak(), tx.clone());
        let mut child_hwnd: Option<HWND> = None;
        let mut last = RECT::default();
        t.start(slint::TimerMode::Repeated, Duration::from_millis(250), move || {
            let Some(a) = weak.upgrade() else { return };
            let h = match child_hwnd {
                Some(h) => h,
                None => {
                    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                    let wh = a.window().window_handle();
                    let Ok(RawWindowHandle::Win32(w)) = wh.window_handle().map(|h| h.as_raw()) else { return };
                    let parent = HWND(w.hwnd.get() as _);
                    let h = unsafe { CreateWindowExW(WINDOW_EX_STYLE(0), windows::core::w!("STATIC"), PCWSTR::null(), WS_CHILD | WS_VISIBLE | WS_DISABLED, 0, 0, PW as i32, PH as i32, Some(parent), None, None, None).unwrap() };
                    let _ = tx.send(Msg::Hwnd(h.0 as isize));
                    child_hwnd = Some(h);
                    h
                }
            };
            let s = a.window().scale_factor();
            let (x, y) = ((a.get_preview_x() * s).round() as i32 + 1, (a.get_preview_y() * s).round() as i32 + 1);
            let (w, hh) = ((PW as f32 * s).round() as i32 - 2, (PH as f32 * s).round() as i32 - 2);
            let r = RECT { left: x, top: y, right: w, bottom: hh };
            if r != last {
                last = r;
                unsafe {
                    let _ = SetWindowPos(h, None, x, y, w, hh, SWP_NOZORDER | SWP_NOACTIVATE);
                }
            }
        });
        timers.push(t);
    }

    if let Some(secs) = args.bench {
        let t = slint::Timer::default();
        let (frames, renders) = (frames.clone(), renders.clone());
        let t0 = Instant::now();
        let mut base: Option<(f64, Instant, u64, u64)> = None;
        t.start(slint::TimerMode::Repeated, Duration::from_millis(500), move || {
            if base.is_none() && t0.elapsed() >= WARMUP {
                base = Some((cpu_s(), Instant::now(), frames.load(Ordering::Relaxed), renders.load(Ordering::Relaxed)));
            }
            let Some((c0, i0, f0, r0)) = base else { return };
            let el = i0.elapsed().as_secs_f64();
            if el >= secs as f64 {
                println!("{}", json!({
                    "render": format!("{mode:?}").to_lowercase(), "seconds": (el * 10.0).round() / 10.0,
                    "cpuCorePct": ((cpu_s() - c0) / el * 1000.0).round() / 10.0,
                    "previewFps": ((frames.load(Ordering::Relaxed) - f0) as f64 / el * 10.0).round() / 10.0,
                    "uiRendersPerS": ((renders.load(Ordering::Relaxed) - r0) as f64 / el * 10.0).round() / 10.0,
                    "workingSetMB": (working_set_mb() * 10.0).round() / 10.0,
                }));
                let _ = slint::quit_event_loop();
            }
        });
        timers.push(t);
    }

    app.run().unwrap();
    if let Some(mut c) = child.borrow_mut().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    std::process::exit(0); // the capture thread and WGC callbacks die with the process
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_centers_and_fits() {
        let r = |l, t, rr, b| RECT { left: l, top: t, right: rr, bottom: b };
        assert_eq!(letterbox(2560, 1440, 960, 540), r(0, 0, 960, 540));
        assert_eq!(letterbox(1000, 1000, 960, 540), r(210, 0, 750, 540));
        assert_eq!(letterbox(3440, 1440, 960, 540), r(0, 69, 960, 471));
        assert_eq!(letterbox(640, 360, 960, 540), r(0, 0, 960, 540)); // small windows are scaled up
    }

    #[test]
    fn pace_averages_60_over_144hz_ticks() {
        let t0 = Instant::now();
        let mut p = Pace { next: t0 };
        let tick = Duration::from_nanos(1_000_000_000 / 144);
        let taken = (0..1440).filter(|&i| p.take(t0 + tick * i + Duration::from_millis(1))).count();
        assert!((598..=602).contains(&taken), "{taken}");
    }

    #[test]
    fn render_parse() {
        assert_eq!(Render::parse("skia"), Some(Render::Skia));
        assert_eq!(Render::parse("gl"), None);
    }
}
