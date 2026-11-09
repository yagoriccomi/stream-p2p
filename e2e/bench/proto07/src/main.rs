//! Ticket 07: throwaway prototype. Slint 1.18 (femtovg-wgpu, wgpu 30 forced to DX12) showing a
//! web-like screen with a 1080p60 H.264 video decoded on the GPU:
//!   MS H.264 decoder MFT (D3D11, DXVA, low latency) → VideoProcessorBlt NV12→RGBA into a pool of
//!   3 D3D11 textures shared by NT handle → ID3D12Device::OpenSharedHandle → wgpu-hal
//!   texture_from_raw → wgpu::Texture → slint::Image::try_from (once per pool texture).
//! Sync: D3D11 fence (shared) signalled after the blt, waited on the wgpu D3D12 queue before Slint
//! renders; D3D12 fence signalled after Slint submits, waited by D3D11 before reusing a texture.
//!
//! Usage:
//!   proto07 encode <file> [frames=1200]   pre-encode the synthetic 1080p60 source (headless)
//!   proto07 play <file> [seconds=20]      open the window, play the file paced at 60 fps, print JSON
//! ponytail: the stream comes from a file, not from str0m; network jitter/loss are out of scope.
#![allow(dead_code, non_snake_case)]
#[path = "../../native/src/bin/presenter.rs"]
mod presenter;

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use presenter::{media_type, tex_with, Encoder, Synth, FPS};
use serde_json::json;
use slint::wgpu_30::wgpu;
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice, IDXGIResource1};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

const W: u32 = 1920;
const H: u32 = 1080;
const POOL: usize = 3;
const IV: i64 = 10_000_000 / FPS as i64;
const GENERIC_ALL: u32 = 0x1000_0000;

thread_local! {
    static IMAGES: std::cell::RefCell<Vec<slint::Image>> = const { std::cell::RefCell::new(Vec::new()) };
}

slint::slint! {
    import { LineEdit } from "std-widgets.slint";
    export component App inherits Window {
        title: "proto07 Stream P2P";
        preferred-width: 1280px;
        preferred-height: 820px;
        background: #0a0a0b;
        in property <image> video;
        in property <string> code: "abcd-ef";
        VerticalLayout {
            padding: 16px;
            spacing: 12px;
            Rectangle {
                height: 64px;
                background: #141416;
                border-radius: 12px;
                border-width: 1px;
                border-color: #2a2a30;
                HorizontalLayout {
                    padding-left: 16px;
                    padding-right: 16px;
                    alignment: space-between;
                    Text {
                        text: "STREAM P2P";
                        font-size: 28px;
                        font-weight: 900;
                        color: #f2f2f4;
                        vertical-alignment: center;
                    }
                    Text {
                        text: "● AO VIVO · " + root.code;
                        color: rgb(46, 229, 157);
                        vertical-alignment: center;
                    }
                }
            }
            Rectangle {
                background: #000000;
                border-radius: 20px;
                clip: true;
                Image {
                    width: 100%;
                    height: 100%;
                    source: root.video;
                    image-fit: contain;
                    accessible-role: image;
                    accessible-label: "Tela compartilhada";
                }
            }
            HorizontalLayout {
                spacing: 12px;
                height: 52px;
                LineEdit {
                    placeholder-text: "Seu nome";
                    accessible-label: "Seu nome";
                    text: "Yago";
                }
                Rectangle {
                    width: 180px;
                    background: touch.has-hover ? #8f1fff : #7f00ff;
                    border-radius: 12px;
                    accessible-role: button;
                    accessible-label: "Entrar";
                    touch := TouchArea { }
                    Text {
                        text: "Entrar";
                        color: #ffffff;
                        font-weight: 600;
                        font-size: 16px;
                        horizontal-alignment: center;
                        vertical-alignment: center;
                    }
                }
            }
        }
    }
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

fn cpu_s() -> f64 {
    let (mut a, mut b, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut k, &mut u).unwrap() };
    let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 1e7;
    t(k) + t(u)
}

/// (working set MB, private bytes MB)
fn mem_mb() -> (f64, f64) {
    let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
    unsafe {
        GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32).unwrap();
    }
    (c.WorkingSetSize as f64 / 1048576.0, c.PrivateUsage as f64 / 1048576.0)
}

fn stats(v: &mut [f64]) -> serde_json::Value {
    if v.is_empty() {
        return json!(null);
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| (v[((v.len() - 1) as f64 * p).round() as usize] * 100.0).round() / 100.0;
    json!({"n": v.len(), "mean": (v.iter().sum::<f64>() / v.len() as f64 * 100.0).round() / 100.0, "p50": q(0.5), "p95": q(0.95), "max": q(1.0)})
}

fn r1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

// ── encode: synthetic 1080p60 → H.264 access units, length-prefixed file ──
fn encode(path: &str, frames: usize) {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).unwrap() };
    let (mut device, mut ctx) = (None, None);
    unsafe {
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx)).unwrap();
    }
    let (device, ctx): (ID3D11Device, ID3D11DeviceContext) = (device.unwrap(), ctx.unwrap());
    let mut src = Synth::new(W, H);
    let mut enc = Encoder::new(&device, ctx, W, H, false, eAVEncH264VProfile_ConstrainedBase);
    let mut out = BufWriter::new(File::create(path).unwrap());
    let mut need = 0u32;
    let mut bytes = 0usize;
    for i in 0..frames {
        let t = tex_with(&device, W, H, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, Some(src.draw()));
        let deadline = Instant::now() + Duration::from_millis(500);
        while need == 0 {
            match enc.poll_event() {
                Some(e) if e == METransformNeedInput.0 as u32 => need += 1,
                _ => std::thread::yield_now(),
            }
            assert!(Instant::now() < deadline, "encoder timeout (input)");
        }
        need -= 1;
        enc.feed(&t, i as i64 * IV);
        let au = loop {
            match enc.poll_event() {
                Some(e) if e == METransformNeedInput.0 as u32 => need += 1,
                Some(e) if e == METransformHaveOutput.0 as u32 => {
                    if let Some((au, _)) = enc.take() {
                        break au;
                    }
                }
                _ => std::thread::yield_now(),
            }
            assert!(Instant::now() < deadline, "encoder timeout (output)");
        };
        out.write_all(&(au.len() as u32).to_le_bytes()).unwrap();
        out.write_all(&au).unwrap();
        bytes += au.len();
    }
    println!("{}", json!({"encoded": frames, "encoder": enc.name, "kbps": r1((bytes * 8) as f64 / (frames as f64 / FPS as f64) / 1000.0)}));
}

struct Shared {
    fed: Mutex<Vec<Instant>>,             // per frame index: when its AU entered the decoder
    shown: Mutex<Vec<(u64, f64, f64)>>,   // (frame, fed→render submitted ms, decoded→render submitted ms)
    render_done: [AtomicU64; POOL],       // D3D12 fence value after the last render that sampled texture k
    blt_ms: Mutex<Vec<f64>>,
    decode_ms: Mutex<Vec<f64>>,
    decoded: AtomicU64,
}

#[derive(Default)]
struct Cur {
    frame: Option<u64>,
    tex: usize,
    ready: u64,
    decoded_at: Option<Instant>,
    last_rendered: Option<u64>,
    renders: u64,
    rendered_new: u64,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("encode") => encode(&args[2], args.get(3).map(|v| v.parse().unwrap()).unwrap_or(1200)),
        Some("play") => play(&args[2], args.get(3).map(|v| v.parse().unwrap()).unwrap_or(20)),
        _ => eprintln!("usage: proto07 encode <file> [frames] | play <file> [seconds]"),
    }
}

fn play(path: &str, seconds: u64) {
    unsafe {
        windows::Win32::Media::timeBeginPeriod(1);
        // main thread: no COM init here, winit needs it as STA (OleInitialize)
        MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap();
    }
    let t_start = Instant::now();
    let mut stages: Vec<(&str, f64, f64)> = vec![];
    let mut stage = |n: &'static str| { let m = mem_mb(); stages.push((n, r1(m.0), r1(m.1))); };
    stage("start");
    // ── wgpu: DX12 only; our device is handed to Slint (WGPUConfiguration::Manual) ──
    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle();
    idesc.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(idesc);
    let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).expect("no DX12 adapter");
    let info = adapter.get_info();
    let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("proto07"), memory_hints: wgpu::MemoryHints::MemoryUsage, ..Default::default() })).unwrap();

    let (dxgi_adapter, d3d12): (IDXGIAdapter, ID3D12Device) = unsafe {
        let a = adapter.as_hal::<wgpu::hal::api::Dx12>().unwrap();
        let d = device.as_hal::<wgpu::hal::api::Dx12>().unwrap();
        (a.as_raw().cast().unwrap(), d.raw_device().clone())
    };
    let luid12 = unsafe { d3d12.GetAdapterLuid() };
    stage("wgpuDx12Device");

    // ── D3D11 on the same adapter (required by OpenSharedHandle) ──
    let (mut d11, mut c11) = (None, None);
    unsafe {
        D3D11CreateDevice(&dxgi_adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut d11), None, Some(&mut c11)).unwrap();
    }
    let (d11, c11): (ID3D11Device, ID3D11DeviceContext) = (d11.unwrap(), c11.unwrap());
    unsafe { let _ = d11.cast::<ID3D11Multithread>().unwrap().SetMultithreadProtected(true); }
    let luid11 = unsafe { d11.cast::<IDXGIDevice>().unwrap().GetAdapter().unwrap().GetDesc().unwrap().AdapterLuid };
    stage("d3d11Device");
    let same_adapter = luid11.LowPart == luid12.LowPart && luid11.HighPart == luid12.HighPart;

    // ── fences: f11 (D3D11 → D3D12: frame ready), f12 (D3D12 → D3D11: render done) ──
    let d11_5: ID3D11Device5 = d11.cast().unwrap();
    let c11_4: ID3D11DeviceContext4 = c11.cast().unwrap();
    let (f11, f11_in12, f12, f12_in11) = unsafe {
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
        (f11, f11_in12.unwrap(), f12, f12_in11.unwrap())
    };

    // ── video processor NV12 1080p → RGBA 1080p ──
    let vdev: ID3D11VideoDevice = d11.cast().unwrap();
    let cd = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
        InputWidth: W,
        InputHeight: H,
        OutputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
        OutputWidth: W,
        OutputHeight: H,
        Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
    };
    let venum = unsafe { vdev.CreateVideoProcessorEnumerator(&cd).unwrap() };
    let fmt = unsafe { venum.CheckVideoProcessorFormat(DXGI_FORMAT_R8G8B8A8_UNORM).unwrap() };
    assert!(fmt & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 != 0, "video processor cannot output R8G8B8A8_UNORM");
    let vp = unsafe { vdev.CreateVideoProcessor(&venum, 0).unwrap() };
    unsafe { c11.cast::<ID3D11VideoContext>().unwrap().VideoProcessorSetStreamSourceRect(&vp, 0, true, Some(&RECT { left: 0, top: 0, right: W as i32, bottom: H as i32 })) };

    // ── pool: D3D11 shared RGBA → D3D12 resource → wgpu texture → slint image (once each) ──
    let mut ovs = vec![];
    let mut images = vec![];
    for k in 0..POOL {
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: W,
                Height: H,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: (D3D11_RESOURCE_MISC_SHARED.0 | D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0) as u32,
            };
            let mut t = None;
            d11.CreateTexture2D(&desc, None, Some(&mut t)).unwrap();
            let t: ID3D11Texture2D = t.unwrap();
            let h: HANDLE = t.cast::<IDXGIResource1>().unwrap().CreateSharedHandle(None, 0x8000_0000 | 1 /* DXGI_SHARED_RESOURCE_READ | WRITE */, None).unwrap();
            let mut r: Option<ID3D12Resource> = None;
            d3d12.OpenSharedHandle(h, &mut r).unwrap();
            let _ = CloseHandle(h);
            let size = wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 };
            let hal = wgpu::hal::dx12::Device::texture_from_raw(r.unwrap(), wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureDimension::D2, size, 1, 1);
            let wt = device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
                hal,
                &wgpu::TextureDescriptor {
                    label: Some("video"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                },
                wgpu::TextureUses::UNINITIALIZED,
            );
            images.push(slint::Image::try_from(wt).unwrap_or_else(|e| panic!("Image::try_from {k}: {e}")));
            let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut ov = None;
            vdev.CreateVideoProcessorOutputView(&t, &venum, &ovd, Some(&mut ov)).unwrap();
            ovs.push(ov.unwrap());
        }
    }

    stage("fencesVpPool");
    // ── Slint on our wgpu device ──
    slint::BackendSelector::new()
        .require_wgpu_30(slint::wgpu_30::WGPUConfiguration::Manual { instance: instance.clone(), adapter: adapter.clone(), device: device.clone(), queue: queue.clone() })
        .select()
        .expect("slint wgpu backend");
    let app = App::new().unwrap();
    IMAGES.with(|v| *v.borrow_mut() = images.clone());
    stage("slintApp");

    let shared = Arc::new(Shared {
        fed: Mutex::new(vec![]),
        shown: Mutex::new(vec![]),
        render_done: Default::default(),
        blt_ms: Mutex::new(vec![]),
        decode_ms: Mutex::new(vec![]),
        decoded: AtomicU64::new(0),
    });
    let cur = Arc::new(Mutex::new(Cur::default()));
    let device_shared = Arc::new(AtomicU64::new(0));
    {
        let (cur, shared, f11_in12, f12, device, queue12, device_shared) = (cur.clone(), shared.clone(), f11_in12.clone(), f12.clone(), device.clone(), queue.clone(), device_shared.clone());
        app.window()
            .set_rendering_notifier(move |state, api| {
                let slint::GraphicsAPI::WGPU30 { device: d, .. } = api else { return };
                let raw = || unsafe { queue12.as_hal::<wgpu::hal::api::Dx12>().unwrap().as_raw().clone() };
                match state {
                    slint::RenderingState::RenderingSetup => device_shared.store((*d == device) as u64, Ordering::Relaxed),
                    slint::RenderingState::BeforeRendering => {
                        let c = cur.lock().unwrap();
                        if c.ready > 0 {
                            unsafe { raw().Wait(&f11_in12, c.ready).unwrap() };
                        }
                    }
                    slint::RenderingState::AfterRendering => {
                        let now = Instant::now();
                        let mut c = cur.lock().unwrap();
                        c.renders += 1;
                        let v = c.renders;
                        unsafe { raw().Signal(&f12, v).unwrap() };
                        shared.render_done[c.tex].store(v, Ordering::Release);
                        if let Some(f) = c.frame {
                            if c.last_rendered != Some(f) {
                                c.last_rendered = Some(f);
                                c.rendered_new += 1;
                                let fed = shared.fed.lock().unwrap().get(f as usize).copied();
                                if let (Some(fed), Some(dec)) = (fed, c.decoded_at) {
                                    shared.shown.lock().unwrap().push((f, (now - fed).as_secs_f64() * 1000.0, (now - dec).as_secs_f64() * 1000.0));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            })
            .unwrap();
    }

    // ── decode thread, paced at 60 fps from the file; starts after 3 s of UI alone ──
    let stop = Arc::new(AtomicBool::new(false));
    let decode_start = Duration::from_secs(3);
    {
        let (shared, cur, app_weak, path, stop) = (shared.clone(), cur.clone(), app.as_weak(), path.to_string(), stop.clone());
        let (f11, f12_in11, c11_4, d11, vp, venum) = (f11.clone(), f12_in11.clone(), c11_4.clone(), d11.clone(), vp.clone(), venum.clone());
        let ovs = ovs.clone();
        std::thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).unwrap();
            std::thread::sleep(decode_start);
            let dec: IMFTransform = CoCreateInstance(&CLSID_MSH264DecoderMFT, None, CLSCTX_INPROC_SERVER).unwrap();
            let mut token = 0u32;
            let mut mgr = None;
            MFCreateDXGIDeviceManager(&mut token, &mut mgr).unwrap();
            let mgr = mgr.unwrap();
            mgr.ResetDevice(&d11, token).unwrap();
            dec.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, mgr.as_raw() as usize).expect("decoder sem D3D11");
            let codec: ICodecAPI = dec.cast().unwrap();
            let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &presenter::var_u32(1)); // VT_UI4 on this decoder
            if let Ok(a) = dec.GetAttributes() {
                let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
            }
            dec.SetInputType(0, &media_type(&MFVideoFormat_H264, W, H), 0).unwrap();
            let set_nv12 = |dec: &IMFTransform| {
                for i in 0.. {
                    let t = dec.GetOutputAvailableType(0, i).expect("decoder sem NV12");
                    if t.GetGUID(&MF_MT_SUBTYPE).unwrap() == MFVideoFormat_NV12 {
                        dec.SetOutputType(0, &t, 0).unwrap();
                        break;
                    }
                }
            };
            set_nv12(&dec);
            assert!(dec.GetOutputStreamInfo(0).unwrap().dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0, "decoder sem DXVA");
            dec.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).unwrap();
            dec.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).unwrap();
            let vdev: ID3D11VideoDevice = d11.cast().unwrap();
            let vctx: ID3D11VideoContext = c11_4.cast().unwrap();

            let mut rd = BufReader::new(File::open(&path).unwrap());
            let mut next = Instant::now();
            let (mut sig, mut k) = (0u64, 0usize);
            for i in 0u64.. {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let mut len = [0u8; 4];
                if rd.read_exact(&mut len).is_err() {
                    break;
                }
                let mut au = vec![0u8; u32::from_le_bytes(len) as usize];
                rd.read_exact(&mut au).unwrap();
                std::thread::sleep(next.saturating_duration_since(Instant::now()));
                next += Duration::from_nanos(1_000_000_000 / FPS as u64);
                let t0 = Instant::now();
                shared.fed.lock().unwrap().push(t0);
                let buf = MFCreateMemoryBuffer(au.len() as u32).unwrap();
                let mut p = std::ptr::null_mut();
                buf.Lock(&mut p, None, None).unwrap();
                std::ptr::copy_nonoverlapping(au.as_ptr(), p, au.len());
                buf.Unlock().unwrap();
                buf.SetCurrentLength(au.len() as u32).unwrap();
                let s = MFCreateSample().unwrap();
                s.AddBuffer(&buf).unwrap();
                s.SetSampleTime(i as i64 * IV).unwrap();
                if std::env::var_os("P07_NODECODE").is_some() {
                    k = (k + 1) % POOL;
                    let (cur, app_weak) = (cur.clone(), app_weak.clone());
                    let _ = slint::invoke_from_event_loop(move || { cur.lock().unwrap().tex = k; if let Some(app) = app_weak.upgrade() { if std::env::var_os("P07_TEXTONLY").is_some() { app.set_code(format!("{i}").into()); } else { app.set_video(IMAGES.with(|v| v.borrow()[k].clone())); } } });
                    continue;
                }
                let _ = dec.ProcessInput(0, &s, 0);
                let mut got = None;
                for _ in 0..4 {
                    let mut db = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(None), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
                    let mut st = 0u32;
                    let r = dec.ProcessOutput(0, &mut db, &mut st);
                    let s = ManuallyDrop::take(&mut db[0].pSample);
                    ManuallyDrop::drop(&mut db[0].pEvents);
                    match r {
                        Ok(()) => {
                            got = s;
                            break;
                        }
                        Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => set_nv12(&dec),
                        Err(_) => break,
                    }
                }
                let Some(sample) = got else { continue };
                let frame = (sample.GetSampleTime().unwrap_or(0) / IV) as u64;
                let t1 = Instant::now();
                // reuse texture k only after D3D12 finished the last render that sampled it
                k = (k + 1) % POOL;
                let done = shared.render_done[k].load(Ordering::Acquire);
                if done > 0 {
                    c11_4.Wait(&f12_in11, done).unwrap();
                }
                let dx: IMFDXGIBuffer = sample.GetBufferByIndex(0).unwrap().cast().unwrap();
                let mut tex: Option<ID3D11Texture2D> = None;
                dx.GetResource(&ID3D11Texture2D::IID, &mut tex as *mut _ as *mut _).unwrap();
                let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: dx.GetSubresourceIndex().unwrap() } },
                };
                let mut inv = None;
                vdev.CreateVideoProcessorInputView(tex.as_ref().unwrap(), &venum, &ivd, Some(&mut inv)).unwrap();
                let streams = [D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: ManuallyDrop::new(inv), ..Default::default() }];
                vctx.VideoProcessorBlt(&vp, &ovs[k], 0, &streams).unwrap();
                let [mut st] = streams;
                ManuallyDrop::drop(&mut st.pInputSurface);
                sig += 1;
                c11_4.Signal(&f11, sig).unwrap();
                c11_4.Flush();
                let t2 = Instant::now();
                shared.decode_ms.lock().unwrap().push((t1 - t0).as_secs_f64() * 1000.0);
                shared.blt_ms.lock().unwrap().push((t2 - t1).as_secs_f64() * 1000.0);
                shared.decoded.fetch_add(1, Ordering::Relaxed);
                let (cur, app_weak) = (cur.clone(), app_weak.clone());
                let _ = slint::invoke_from_event_loop(move || {
                    {
                        let mut c = cur.lock().unwrap();
                        c.frame = Some(frame);
                        c.tex = k;
                        c.ready = sig;
                        c.decoded_at = Some(t1);
                    }
                    if std::env::var_os("P07_NOSET").is_some() { return; }
                    if let Some(app) = app_weak.upgrade() {
                        app.set_video(IMAGES.with(|v| v.borrow()[k].clone()));
                    }
                });
            }
        });
    }

    // ── sampler: RAM/CPU once per second; quit after `seconds` of video ──
    let samples = Arc::new(Mutex::new(vec![]));
    let ui_only = Arc::new(Mutex::new((0.0f64, 0.0f64, 0.0f64)));
    let snap: Arc<Mutex<Option<(usize, usize, f64, f64)>>> = Arc::new(Mutex::new(None));
    let timer = slint::Timer::default();
    {
        let (samples, ui_only, stop, snap, snap_weak) = (samples.clone(), ui_only.clone(), stop.clone(), snap.clone(), app.as_weak());
        let end = decode_start + Duration::from_secs(seconds);
        let mut cpu0 = (cpu_s(), Instant::now());
        timer.start(slint::TimerMode::Repeated, Duration::from_secs(1), move || {
            let el = t_start.elapsed();
            let m = mem_mb();
            let (c, t) = (cpu_s(), Instant::now());
            let pct = 100.0 * (c - cpu0.0) / (t - cpu0.1).as_secs_f64();
            cpu0 = (c, t);
            if el < decode_start {
                *ui_only.lock().unwrap() = (m.0, m.1, pct);
            } else if el > decode_start + Duration::from_secs(2) {
                samples.lock().unwrap().push((m.0, m.1, pct));
            }
            if el >= end {
                if let Some(app) = snap_weak.upgrade() {
                    if let Ok(b) = app.window().take_snapshot() {
                        let (w, h) = (b.width() as usize, b.height() as usize);
                        let px = b.as_slice();
                        let mut lum: Vec<u32> = vec![];
                        for y in (h / 4..h * 3 / 4).step_by(7) { for x in (w / 4..w * 3 / 4).step_by(7) { let p = px[y * w + x]; lum.push(p.r as u32 + p.g as u32 + p.b as u32); } }
                        let mean = lum.iter().sum::<u32>() as f64 / lum.len() as f64;
                        let var = lum.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / lum.len() as f64;
                        *snap.lock().unwrap() = Some((w, h, r1(mean / 3.0), r1(var.sqrt() / 3.0)));
                    }
                }
                stop.store(true, Ordering::Relaxed);
                let _ = slint::quit_event_loop();
            }
        });
    }
    app.show().unwrap();
    slint::run_event_loop().unwrap();
    let wall_video = t_start.elapsed().saturating_sub(decode_start).as_secs_f64();
    let _ = app.hide();

    let warm = FPS as u64; // skip the first second of video
    let shown: Vec<_> = shared.shown.lock().unwrap().iter().copied().filter(|s| s.0 >= warm).collect();
    let mut e2e: Vec<f64> = shown.iter().map(|s| s.1).collect();
    let mut present: Vec<f64> = shown.iter().map(|s| s.2).collect();
    let samples = samples.lock().unwrap().clone();
    let mut ws: Vec<f64> = samples.iter().map(|s| s.0).collect();
    let mut pb: Vec<f64> = samples.iter().map(|s| s.1).collect();
    let mut cpu: Vec<f64> = samples.iter().map(|s| s.2).collect();
    let cpu_mean = cpu.iter().sum::<f64>() / cpu.len().max(1) as f64;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    let c = cur.lock().unwrap();
    let ui = *ui_only.lock().unwrap();
    println!("{}", json!({
        "adapter": info.name, "backend": format!("{:?}", info.backend),
        "sameAdapterLuid": same_adapter, "slintUsesOurWgpuDevice": device_shared.load(Ordering::Relaxed) == 1,
        "videoWallS": r1(wall_video), "noSet": std::env::var_os("P07_NOSET").is_some(),
        "snapshotVideoArea": snap.lock().unwrap().map(|s| json!({"w": s.0, "h": s.1, "meanLuma": s.2, "stdLuma": s.3})),
        "decoded": shared.decoded.load(Ordering::Relaxed), "renders": c.renders, "renderedNewFrames": c.rendered_new,
        "presentedFps": r1(c.rendered_new as f64 / wall_video),
        "decodeMs": stats(&mut shared.decode_ms.lock().unwrap().clone()),
        "bltSignalMs": stats(&mut shared.blt_ms.lock().unwrap().clone()),
        "fedToRenderSubmittedMs": stats(&mut e2e),
        "decodedToRenderSubmittedMs": stats(&mut present),
        "ramUiOnlyMB": {"workingSet": r1(ui.0), "private": r1(ui.1)}, "cpuUiOnlyCorePct": r1(ui.2),
        "stagesMB": stages.iter().map(|s| json!({"stage": s.0, "workingSet": s.1, "private": s.2})).collect::<Vec<_>>(),
        "ramVideoMB": {"workingSet": stats(&mut ws), "private": stats(&mut pb)},
        "cpuCorePct": stats(&mut cpu), "cpuMachinePct": r1(cpu_mean / cores),
    }));
    std::process::exit(0);
}
