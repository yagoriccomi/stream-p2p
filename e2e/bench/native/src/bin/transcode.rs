//! Ticket 18: cost of one transcoding step in a relay node, headless (no window, no network).
//! The synthetic 1080p60 source is pre-encoded with the hardware H.264 encoder (the parent's
//! stream). Then, paced at 60 fps, each access unit goes through what a transcoding relay would do:
//! MS H.264 decoder MFT with D3D11 (DXVA) → D3D11 video processor scale to 1280x720 NV12 →
//! hardware H.264 encoder (low latency, 4 Mbps). One frame in flight; per stage ms are wall clock,
//! the scale includes waiting for the GPU (event query). Prints one JSON line.
//!
//! Usage: transcode [frames=1200]
#![allow(dead_code)]
#[path = "presenter.rs"]
mod presenter;

use std::mem::ManuallyDrop;
use std::time::{Duration, Instant};

use presenter::{media_type, tex_with, Encoder, Synth, FPS};
use serde_json::json;
use windows::core::Interface;
use windows::Win32::Foundation::{FILETIME, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

const OUT_W: u32 = 1280;
const OUT_H: u32 = 720;

fn cpu_s() -> f64 {
    let (mut a, mut b, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut k, &mut u).unwrap() };
    let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 1e7;
    t(k) + t(u)
}

/// Encoder (async MFT): wait for one access unit.
fn encode_one(enc: &mut Encoder, need: &mut u32, tex: &ID3D11Texture2D, t: i64) -> Option<Vec<u8>> {
    let deadline = Instant::now() + Duration::from_millis(500);
    while *need == 0 && Instant::now() < deadline {
        match enc.poll_event() {
            Some(e) if e == METransformNeedInput.0 as u32 => *need += 1,
            Some(_) => {}
            None => std::thread::yield_now(),
        }
    }
    *need = need.checked_sub(1)?;
    enc.feed(tex, t);
    while Instant::now() < deadline {
        match enc.poll_event() {
            Some(e) if e == METransformNeedInput.0 as u32 => *need += 1,
            Some(e) if e == METransformHaveOutput.0 as u32 => {
                if let Some((au, _)) = enc.take() {
                    return Some(au);
                }
            }
            Some(_) => {}
            None => std::thread::yield_now(),
        }
    }
    None
}

fn pct(v: &mut [f64]) -> Value3 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| (v[((v.len() - 1) as f64 * p).round() as usize] * 100.0).round() / 100.0;
    Value3 { mean: (v.iter().sum::<f64>() / v.len() as f64 * 100.0).round() / 100.0, p50: q(0.5), p95: q(0.95), max: q(1.0) }
}
struct Value3 {
    mean: f64,
    p50: f64,
    p95: f64,
    max: f64,
}
impl Value3 {
    fn json(&self) -> serde_json::Value {
        json!({"mean": self.mean, "p50": self.p50, "p95": self.p95, "max": self.max})
    }
}

fn main() {
    let frames: usize = std::env::args().nth(1).map(|v| v.parse().expect("frames")).unwrap_or(1200);
    unsafe {
        windows::Win32::Media::timeBeginPeriod(1);
        CoInitializeEx(None, COINIT_MULTITHREADED).unwrap();
    }
    let (mut device, mut ctx) = (None, None);
    unsafe {
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx)).unwrap();
    }
    let (device, ctx): (ID3D11Device, ID3D11DeviceContext) = (device.unwrap(), ctx.unwrap());
    unsafe { let _ = device.cast::<ID3D11Multithread>().unwrap().SetMultithreadProtected(true); }
    let (w, h) = (1920u32, 1080u32);
    let iv = 10_000_000 / FPS as i64;

    // ── 1. the parent's stream: pre-encoded 1080p access units ──
    let mut src = Synth::new(w, h);
    let mut enc1 = Encoder::new(&device, ctx.clone(), w, h, false, eAVEncH264VProfile_ConstrainedBase);
    let mut need1 = 0;
    let mut aus = vec![];
    for i in 0..frames {
        let t = tex_with(&device, w, h, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, Some(src.draw()));
        aus.push(encode_one(&mut enc1, &mut need1, &t, i as i64 * iv).expect("1080p encode"));
    }
    let src_bytes: usize = aus.iter().map(|a| a.len()).sum();

    // ── 2. decoder: MS H.264 MFT on the same D3D11 device (DXVA) ──
    let dec: IMFTransform = unsafe { CoCreateInstance(&CLSID_MSH264DecoderMFT, None, CLSCTX_INPROC_SERVER).unwrap() };
    unsafe {
        let mut token = 0u32;
        let mut mgr = None;
        MFCreateDXGIDeviceManager(&mut token, &mut mgr).unwrap();
        let mgr = mgr.unwrap();
        mgr.ResetDevice(&device, token).unwrap();
        dec.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, mgr.as_raw() as usize).expect("decoder sem D3D11");
        std::mem::forget(mgr); // lives as long as the process
        let codec: ICodecAPI = dec.cast().unwrap();
        let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &presenter::var_bool(true));
        if let Ok(a) = dec.GetAttributes() {
            let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
        }
        dec.SetInputType(0, &media_type(&MFVideoFormat_H264, w, h), 0).unwrap();
    }
    let set_nv12 = |dec: &IMFTransform| unsafe {
        for i in 0.. {
            let t = dec.GetOutputAvailableType(0, i).expect("decoder sem NV12");
            if t.GetGUID(&MF_MT_SUBTYPE).unwrap() == MFVideoFormat_NV12 {
                dec.SetOutputType(0, &t, 0).unwrap();
                break;
            }
        }
    };
    set_nv12(&dec);
    let dxva = unsafe { dec.GetOutputStreamInfo(0).unwrap().dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0 };
    assert!(dxva, "decoder não fornece amostras D3D11 (sem DXVA)");
    unsafe {
        dec.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).unwrap();
        dec.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).unwrap();
    }

    // ── 3. scale: video processor NV12 1920x1080 → NV12 1280x720 ──
    let vdev: ID3D11VideoDevice = device.cast().unwrap();
    let vctx: ID3D11VideoContext = ctx.cast().unwrap();
    let cd = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
        InputWidth: w,
        InputHeight: h,
        OutputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
        OutputWidth: OUT_W,
        OutputHeight: OUT_H,
        Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
    };
    let venum = unsafe { vdev.CreateVideoProcessorEnumerator(&cd).unwrap() };
    let vp = unsafe { vdev.CreateVideoProcessor(&venum, 0).unwrap() };
    let src_rect = windows::Win32::Foundation::RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
    unsafe { vctx.VideoProcessorSetStreamSourceRect(&vp, 0, true, Some(&src_rect)) };
    let query = unsafe {
        let mut q = None;
        device.CreateQuery(&D3D11_QUERY_DESC { Query: D3D11_QUERY_EVENT, MiscFlags: 0 }, Some(&mut q)).unwrap();
        q.unwrap()
    };

    // ── 4. the child's encoder: 720p, 4 Mbps ──
    let mut enc2 = Encoder::new(&device, ctx.clone(), OUT_W, OUT_H, false, eAVEncH264VProfile_ConstrainedBase);
    enc2.set_bitrate(4_000_000);
    let mut need2 = 0;

    let (mut d_ms, mut s_ms, mut e_ms, mut tot) = (vec![], vec![], vec![], vec![]);
    let (mut out_bytes, mut lost, mut input_err) = (0usize, 0usize, 0usize);
    let mut delay = vec![]; // decoder: frames between this input and the frame it returned
    let warm = (FPS as usize).min(frames / 4);
    let mut next = Instant::now();
    let (mut cpu0, mut wall0) = (cpu_s(), Instant::now());
    for (i, au) in aus.iter().enumerate() {
        if i == warm {
            (cpu0, wall0) = (cpu_s(), Instant::now());
        }
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
        next += Duration::from_nanos(1_000_000_000 / FPS as u64);
        let t0 = Instant::now();
        // decode
        let sample = unsafe {
            let buf = MFCreateMemoryBuffer(au.len() as u32).unwrap();
            let mut p = std::ptr::null_mut();
            buf.Lock(&mut p, None, None).unwrap();
            std::ptr::copy_nonoverlapping(au.as_ptr(), p, au.len());
            buf.Unlock().unwrap();
            buf.SetCurrentLength(au.len() as u32).unwrap();
            let s = MFCreateSample().unwrap();
            s.AddBuffer(&buf).unwrap();
            s.SetSampleTime(i as i64 * iv).unwrap();
            if let Err(e) = dec.ProcessInput(0, &s, 0) {
                eprintln!("decoder ProcessInput {i}: {e:?}");
                input_err += 1;
            }
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
            got
        };
        let Some(sample) = sample else {
            lost += 1;
            continue;
        };
        let t1 = Instant::now();
        delay.push(i as i64 - unsafe { sample.GetSampleTime().unwrap_or(0) } / iv);
        // scale
        let out = unsafe {
            let dx: IMFDXGIBuffer = sample.GetBufferByIndex(0).unwrap().cast().unwrap();
            let mut tex: Option<ID3D11Texture2D> = None;
            dx.GetResource(&ID3D11Texture2D::IID, &mut tex as *mut _ as *mut _).unwrap();
            let slice = dx.GetSubresourceIndex().unwrap();
            let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: slice } },
            };
            let mut inv = None;
            vdev.CreateVideoProcessorInputView(tex.as_ref().unwrap(), &venum, &ivd, Some(&mut inv)).unwrap();
            let out = tex_with(&device, OUT_W, OUT_H, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, None);
            let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut ov = None;
            vdev.CreateVideoProcessorOutputView(&out, &venum, &ovd, Some(&mut ov)).unwrap();
            let streams = [D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: ManuallyDrop::new(inv), ..Default::default() }];
            vctx.VideoProcessorBlt(&vp, ov.as_ref().unwrap(), 0, &streams).unwrap();
            let [mut s] = streams;
            ManuallyDrop::drop(&mut s.pInputSurface);
            ctx.End(&query);
            // S_FALSE also maps to Ok: read the BOOL the event query fills when the GPU is done
            let mut done = 0i32;
            while ctx.GetData(&query, Some(&mut done as *mut _ as *mut _), 4, 0).is_err() || done == 0 {
                std::thread::yield_now();
            }
            out
        };
        let t2 = Instant::now();
        // encode
        let Some(au2) = encode_one(&mut enc2, &mut need2, &out, i as i64 * iv) else {
            lost += 1;
            continue;
        };
        let t3 = Instant::now();
        if i >= warm {
            let ms = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1000.0;
            d_ms.push(ms(t0, t1));
            s_ms.push(ms(t1, t2));
            e_ms.push(ms(t2, t3));
            tot.push(ms(t0, t3));
            out_bytes += au2.len();
        }
    }
    let wall = wall0.elapsed().as_secs_f64();
    let cpu = cpu_s() - cpu0;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
    let n = tot.len();
    println!("{}", json!({
        "frames": n, "warmup": warm, "lost": lost, "decoderInputErrors": input_err,
        "decoderDelayFrames": {"first": delay.first(), "last": delay.last(), "max": delay.iter().max()}, "encoder": enc2.name,
        "in": {"w": w, "h": h, "kbps": (src_bytes * 8) as f64 / (frames as f64 / FPS as f64) / 1000.0},
        "out": {"w": OUT_W, "h": OUT_H, "kbps": ((out_bytes * 8) as f64 / (n as f64 / FPS as f64) / 1000.0).round()},
        "decodeMs": pct(&mut d_ms).json(), "scaleMs": pct(&mut s_ms).json(), "encodeMs": pct(&mut e_ms).json(), "totalMs": pct(&mut tot).json(),
        "cpuCorePct": (100.0 * cpu / wall).round(), "cpuMachinePct": (100.0 * cpu / wall / cores * 10.0).round() / 10.0, "wallS": (wall * 10.0).round() / 10.0,
    }));
}
