//! Native presenter for the ticket 05 benchmark (scenario 3): captures a window with
//! Windows.Graphics.Capture, converts BGRA to NV12 on the GPU (D3D11 video processor),
//! encodes H.264 on the hardware encoder through Media Foundation (NVENC on NVIDIA), and
//! sends it with str0m. No browser in the path.
//!
//! Usage: presenter <window title> | presenter --synth (headless: synthetic NV12 source with the
//! bench clock, uploaded to the GPU; no window, no capture). Env, unset = previous behavior:
//!   BENCH_ENCODER=software  Microsoft H.264 software MFT (sync), NV12 read back to the CPU
//!   BENCH_PROFILE=constrained-baseline|baseline|main  MFT profile + matching SDP profile-level-id
//! Signaling is JSON lines, same as the relay:
//! stdin {"cmd":"child","id":N} | {"from":N,"sdp":{..}} | {"cmd":"stats"}
//!       | {"cmd":"bitrate","kbps":N} | {"cmd":"resize","w":W,"h":H} (resize: --synth only);
//! stdout {"to":N,"sdp":{..}} | {"stats":{..}} | {"ready":{"w":..,"h":..,"encoder":".."}}.
#![allow(non_snake_case)]
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::mem::ManuallyDrop;
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

use windows::core::{Interface, GUID, HSTRING};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_UI4};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

pub(crate) const FPS: u32 = 60;
const BITRATE: u32 = 8_000_000;
const PT: u8 = 102;

pub(crate) fn var_u32(v: u32) -> VARIANT {
    let mut x = VARIANT::default();
    unsafe {
        let inner = &mut *x.Anonymous.Anonymous;
        inner.vt = VT_UI4;
        inner.Anonymous.ulVal = v;
    }
    x
}
pub(crate) fn var_bool(v: bool) -> VARIANT {
    let mut x = VARIANT::default();
    unsafe {
        let inner = &mut *x.Anonymous.Anonymous;
        inner.vt = VT_BOOL;
        inner.Anonymous.boolVal = windows::Win32::Foundation::VARIANT_BOOL(if v { -1 } else { 0 });
    }
    x
}

fn out(v: Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

// ── GPU: capture + color conversion ──
struct Gpu {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    vdev: ID3D11VideoDevice,
    vctx: ID3D11VideoContext,
    vp: ID3D11VideoProcessor,
    venum: ID3D11VideoProcessorEnumerator,
    bgra: ID3D11Texture2D,
    input_view: ID3D11VideoProcessorInputView,
    w: u32,
    h: u32,
}

pub(crate) fn tex_with(device: &ID3D11Device, w: u32, h: u32, fmt: DXGI_FORMAT, bind: D3D11_BIND_FLAG, init: Option<&[u8]>) -> ID3D11Texture2D {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: fmt,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    // NV12 initial data: one subresource, UV plane right after Y at pitch * height.
    let data = init.map(|d| D3D11_SUBRESOURCE_DATA { pSysMem: d.as_ptr().cast(), SysMemPitch: w, SysMemSlicePitch: 0 });
    let mut t = None;
    unsafe { device.CreateTexture2D(&desc, data.as_ref().map(|d| d as *const _), Some(&mut t)).unwrap() };
    t.unwrap()
}
fn tex(device: &ID3D11Device, w: u32, h: u32, fmt: DXGI_FORMAT, bind: D3D11_BIND_FLAG) -> ID3D11Texture2D {
    tex_with(device, w, h, fmt, bind, None)
}

impl Gpu {
    fn new(device: ID3D11Device, ctx: ID3D11DeviceContext, src_w: u32, src_h: u32) -> Gpu {
        let (w, h) = (src_w & !1, src_h & !1);
        let vdev: ID3D11VideoDevice = device.cast().unwrap();
        let vctx: ID3D11VideoContext = ctx.cast().unwrap();
        let cd = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
            InputWidth: src_w,
            InputHeight: src_h,
            OutputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
            OutputWidth: w,
            OutputHeight: h,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let venum = unsafe { vdev.CreateVideoProcessorEnumerator(&cd).unwrap() };
        let vp = unsafe { vdev.CreateVideoProcessor(&venum, 0).unwrap() };
        let bgra = tex(&device, src_w, src_h, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET);
        let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut iv = None;
        unsafe { vdev.CreateVideoProcessorInputView(&bgra, &venum, &ivd, Some(&mut iv)).unwrap() };
        Gpu { device, ctx, vdev, vctx, vp, venum, bgra, input_view: iv.unwrap(), w, h }
    }

    /// Captured BGRA texture → a fresh NV12 texture the encoder can keep.
    fn to_nv12(&self, captured: &ID3D11Texture2D) -> ID3D11Texture2D {
        let nv12 = tex(&self.device, self.w, self.h, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET);
        let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
        };
        let mut ov = None;
        unsafe {
            self.ctx.CopyResource(&self.bgra, captured);
            self.vdev.CreateVideoProcessorOutputView(&nv12, &self.venum, &ovd, Some(&mut ov)).unwrap();
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(Some(self.input_view.clone())),
                ..Default::default()
            };
            let streams = [stream];
            self.vctx.VideoProcessorBlt(&self.vp, ov.as_ref().unwrap(), 0, &streams).unwrap();
            let [mut s] = streams;
            ManuallyDrop::drop(&mut s.pInputSurface);
        }
        nv12
    }
}

// ── headless synthetic source: scrolling noise + the bench clock (relay.html capture()) ──
const TILE: usize = 512;
pub(crate) struct Synth {
    w: u32,
    h: u32,
    t: usize,
    tile: Vec<u8>, // TILE rows of 2*TILE bytes (row repeated), so any offset is one contiguous copy
    frame: Vec<u8>,
}

impl Synth {
    pub(crate) fn new(w: u32, h: u32) -> Synth {
        let mut seed = 0x2545_f491u32;
        let mut tile = vec![0u8; TILE * 2 * TILE];
        for y in 0..TILE {
            for x in 0..TILE {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                // 4×4 blocks like the JS source (noise drawn at 1/4 and scaled up)
                let v = if x % 4 == 0 && y % 4 == 0 { (seed >> 24) as u8 } else { 0 };
                tile[y * 2 * TILE + x] = v;
            }
        }
        for y in 0..TILE {
            for x in 0..TILE {
                let v = tile[(y & !3) * 2 * TILE + (x & !3)];
                tile[y * 2 * TILE + x] = v;
                tile[y * 2 * TILE + TILE + x] = v;
            }
        }
        Synth { w, h, t: 0, tile, frame: vec![] }
    }

    /// Next NV12 frame (tight pitch). Clock: 32 blocks on the top 1/8, 24-bit ms stamp + 0xa5.
    pub(crate) fn draw(&mut self) -> &[u8] {
        self.t += 1;
        let (w, h) = (self.w as usize, self.h as usize);
        self.frame.resize(w * h * 3 / 2, 0);
        let (ox, oy) = ((self.t * 7) % TILE, (self.t * 3) % TILE);
        for y in 0..h {
            let row = &self.tile[((y + oy) % TILE) * 2 * TILE..][ox..ox + TILE];
            let dst = &mut self.frame[y * w..(y + 1) * w];
            for chunk in dst.chunks_mut(TILE) {
                chunk.copy_from_slice(&row[..chunk.len()]);
            }
        }
        let (u, v) = (128u8.wrapping_add(((self.t * 3) % 64) as u8), 160u8.wrapping_sub(((self.t * 2) % 64) as u8));
        for p in self.frame[w * h..].chunks_mut(2) {
            p[0] = u;
            p[1] = v;
        }
        let stamp = (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u32) & 0xffffff;
        let bits = stamp | (0xa5 << 24);
        let bw = w / 32;
        for y in 0..h / 8 {
            for i in 0..32 {
                let val = if bits >> i & 1 == 1 { 235 } else { 16 };
                self.frame[y * w + i * bw..y * w + (i + 1) * bw].fill(val);
            }
        }
        for y in 0..h / 16 {
            self.frame[w * h + y * w..w * h + (y + 1) * w].fill(128);
        }
        &self.frame
    }
}

// ── H.264 encoder: hardware (async MFT, D3D11 input) or MS software (sync, system memory) ──
pub(crate) struct Encoder {
    mft: IMFTransform,
    pub(crate) events: Option<IMFMediaEventGenerator>, // None: synchronous software MFT
    codec: ICodecAPI,
    ctx: ID3D11DeviceContext,
    staging: Option<ID3D11Texture2D>,
    profile: eAVEncH264VProfile,
    bitrate: u32,
    provides_samples: bool,
    out_size: u32,
    pub(crate) name: String,
}

pub(crate) fn media_type(sub: &GUID, w: u32, h: u32) -> IMFMediaType {
    unsafe {
        let t = MFCreateMediaType().unwrap();
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).unwrap();
        t.SetGUID(&MF_MT_SUBTYPE, sub).unwrap();
        t.SetUINT64(&MF_MT_FRAME_SIZE, ((w as u64) << 32) | h as u64).unwrap();
        t.SetUINT64(&MF_MT_FRAME_RATE, ((FPS as u64) << 32) | 1).unwrap();
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1).unwrap();
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).unwrap();
        t
    }
}

/// BENCH_PROFILE → MFT profile, SDP profile-level-id announced for it, label.
fn profile_from_env() -> (eAVEncH264VProfile, u32, &'static str) {
    match std::env::var("BENCH_PROFILE").as_deref() {
        Err(_) | Ok("constrained-baseline") => (eAVEncH264VProfile_ConstrainedBase, 0x42e01f, "constrained-baseline"),
        Ok("baseline") => (eAVEncH264VProfile_Base, 0x42001f, "baseline"),
        Ok("main") => (eAVEncH264VProfile_Main, 0x4d001f, "main"),
        Ok(v) => panic!("BENCH_PROFILE inválido: {v:?}"),
    }
}

fn software_from_env() -> bool {
    match std::env::var("BENCH_ENCODER").as_deref() {
        Err(_) | Ok("hardware") => false,
        Ok("software") => true,
        Ok(v) => panic!("BENCH_ENCODER inválido: {v:?}"),
    }
}

impl Encoder {
    pub(crate) fn new(device: &ID3D11Device, ctx: ID3D11DeviceContext, w: u32, h: u32, software: bool, profile: eAVEncH264VProfile) -> Encoder {
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap();
            let (mft, events, name) = if software {
                let mft: IMFTransform = CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER).unwrap();
                (mft, None, "Microsoft H264 Video Encoder MFT (software)".to_string())
            } else {
                let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
                let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
                let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
                let mut n = 0u32;
                MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &mut list, &mut n).unwrap();
                assert!(n > 0, "no hardware H.264 encoder");
                let act = (*list).clone().unwrap();
                let mut name = windows::core::PWSTR::null();
                let mut len = 0u32;
                let _ = act.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len);
                let name = name.to_string().unwrap_or_default();
                let mft: IMFTransform = act.ActivateObject().unwrap();
                let attrs = mft.GetAttributes().unwrap();
                attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).unwrap();
                let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);

                let mut token = 0u32;
                let mut mgr = None;
                MFCreateDXGIDeviceManager(&mut token, &mut mgr).unwrap();
                let mgr = mgr.unwrap();
                mgr.ResetDevice(device, token).unwrap();
                mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, mgr.as_raw() as usize).unwrap();
                let events: IMFMediaEventGenerator = mft.cast().unwrap();
                (mft, Some(events), name)
            };

            let codec: ICodecAPI = mft.cast().unwrap();
            let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &var_bool(true));
            let _ = codec.SetValue(&CODECAPI_AVEncCommonRateControlMode, &var_u32(eAVEncCommonRateControlMode_CBR.0 as u32));
            let _ = codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(BITRATE));
            let _ = codec.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &var_u32(0));
            let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &var_u32(FPS * 10));

            let mut e = Encoder { mft, events, codec, ctx, staging: None, profile, bitrate: BITRATE, provides_samples: false, out_size: 0, name };
            e.start(w, h);
            e
        }
    }

    /// Media types for w×h, then begin streaming (also the second half of a live resize).
    fn start(&mut self, w: u32, h: u32) {
        unsafe {
            let ot = media_type(&MFVideoFormat_H264, w, h);
            ot.SetUINT32(&MF_MT_AVG_BITRATE, self.bitrate).unwrap();
            ot.SetUINT32(&MF_MT_MPEG2_PROFILE, self.profile.0 as u32).unwrap();
            self.mft.SetOutputType(0, &ot, 0).unwrap();
            self.mft.SetInputType(0, &media_type(&MFVideoFormat_NV12, w, h), 0).unwrap();

            let info = self.mft.GetOutputStreamInfo(0).unwrap();
            self.provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            self.out_size = info.cbSize.max(4 << 20);
            self.staging = None;
            self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).unwrap();
            self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).unwrap();
        }
    }

    /// Live resize on the same MFT (research/03: flush → end → new types → begin), then IDR.
    fn restart(&mut self, w: u32, h: u32) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
        self.start(w, h);
        self.force_key();
    }

    pub(crate) fn set_bitrate(&mut self, bps: u32) -> bool {
        let ok = unsafe { self.codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(bps)).is_ok() };
        if ok {
            self.bitrate = bps;
        }
        ok
    }

    fn sync(&self) -> bool {
        self.events.is_none()
    }

    /// Non-blocking: next encoder event type, if any.
    pub(crate) fn poll_event(&self) -> Option<u32> {
        unsafe { self.events.as_ref()?.GetEvent(MF_EVENT_FLAG_NO_WAIT).ok().map(|e| e.GetType().unwrap()) }
    }

    pub(crate) fn feed(&mut self, nv12: &ID3D11Texture2D, t100ns: i64) {
        unsafe {
            let buf = if self.sync() {
                self.readback(nv12)
            } else {
                let buf = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, nv12, 0, false).unwrap();
                let len = buf.cast::<IMF2DBuffer>().unwrap().GetContiguousLength().unwrap();
                buf.SetCurrentLength(len).unwrap();
                buf
            };
            let s = MFCreateSample().unwrap();
            s.AddBuffer(&buf).unwrap();
            s.SetSampleTime(t100ns).unwrap();
            s.SetSampleDuration(10_000_000 / FPS as i64).unwrap();
            if let Err(e) = self.mft.ProcessInput(0, &s, 0) {
                eprintln!("ProcessInput: {e:?}");
            }
        }
    }

    /// Software path: GPU NV12 → staging texture → tight system-memory buffer.
    unsafe fn readback(&mut self, nv12: &ID3D11Texture2D) -> IMFMediaBuffer {
        let mut d = D3D11_TEXTURE2D_DESC::default();
        nv12.GetDesc(&mut d);
        if self.staging.is_none() {
            let desc = D3D11_TEXTURE2D_DESC { Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, ..d };
            let mut t = None;
            nv12.GetDevice().unwrap().CreateTexture2D(&desc, None, Some(&mut t)).unwrap();
            self.staging = t;
        }
        let st = self.staging.as_ref().unwrap();
        self.ctx.CopyResource(st, nv12);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(st, 0, D3D11_MAP_READ, 0, Some(&mut m)).unwrap();
        let (w, h, pitch) = (d.Width as usize, d.Height as usize, m.RowPitch as usize);
        let size = w * h * 3 / 2;
        let buf = MFCreateMemoryBuffer(size as u32).unwrap();
        let mut p = std::ptr::null_mut();
        buf.Lock(&mut p, None, None).unwrap();
        let src = m.pData as *const u8;
        for row in 0..h * 3 / 2 {
            // UV rows follow the Y rows at pitch * height
            std::ptr::copy_nonoverlapping(src.add(row * pitch), p.add(row * w), w);
        }
        buf.Unlock().unwrap();
        self.ctx.Unmap(st, 0);
        buf.SetCurrentLength(size as u32).unwrap();
        buf
    }

    /// One encoded access unit (Annex B) and its sample time, in 100 ns.
    pub(crate) fn take(&mut self) -> Option<(Vec<u8>, i64)> {
        unsafe {
            let own = if self.provides_samples {
                None
            } else {
                let s = MFCreateSample().unwrap();
                s.AddBuffer(&MFCreateMemoryBuffer(self.out_size).unwrap()).unwrap();
                Some(s)
            };
            let mut db = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(own), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let r = self.mft.ProcessOutput(0, &mut db, &mut status);
            let sample = ManuallyDrop::take(&mut db[0].pSample);
            ManuallyDrop::drop(&mut db[0].pEvents);
            if let Err(e) = r {
                if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                    let t = self.mft.GetOutputAvailableType(0, 0).unwrap();
                    self.mft.SetOutputType(0, &t, 0).unwrap();
                } else if e.code() != MF_E_TRANSFORM_NEED_MORE_INPUT {
                    eprintln!("ProcessOutput: {e:?}");
                }
                return None;
            }
            let sample = sample?;
            let t = sample.GetSampleTime().unwrap_or(0);
            let buf = sample.ConvertToContiguousBuffer().unwrap();
            let mut p = std::ptr::null_mut();
            let mut n = 0u32;
            buf.Lock(&mut p, None, Some(&mut n)).unwrap();
            let data = std::slice::from_raw_parts(p, n as usize).to_vec();
            buf.Unlock().unwrap();
            Some((data, t))
        }
    }

    fn force_key(&self) {
        unsafe {
            let _ = self.codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &var_u32(1));
        }
    }
}

// ── network ──
struct Child {
    id: u64,
    rtc: Rtc,
    mid: Mid,
    pending: Option<SdpPendingOffer>,
}

fn drain(c: &mut Child, sock: &UdpSocket, want_key: &mut bool) -> Instant {
    loop {
        match c.rtc.poll_output() {
            Ok(Output::Timeout(t)) => return t,
            Ok(Output::Transmit(t)) => {
                let _ = sock.send_to(&t.contents, t.destination);
            }
            Ok(Output::Event(Event::KeyframeRequest(_))) | Ok(Output::Event(Event::Connected)) => *want_key = true,
            Ok(Output::Event(_)) => {}
            Err(e) => {
                eprintln!("child {}: {e:?}", c.id);
                c.rtc.disconnect();
                return Instant::now() + Duration::from_secs(1);
            }
        }
    }
}

fn main() {
    let title = std::env::args().nth(1).expect("window title or --synth");
    let synth_mode = title == "--synth";
    let software = software_from_env();
    let (profile, profile_id, profile_name) = profile_from_env();
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        windows::Win32::Media::timeBeginPeriod(1);
        RoInitialize(RO_INIT_MULTITHREADED).unwrap();
    }
    str0m::crypto::from_feature_flags().install_process_default();

    // D3D11 device shared by capture, converter and encoder.
    let (mut device, mut ctx) = (None, None);
    unsafe {
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx)).unwrap();
    }
    let (device, ctx): (ID3D11Device, ID3D11DeviceContext) = (device.unwrap(), ctx.unwrap());
    unsafe { let _ = device.cast::<ID3D11Multithread>().unwrap().SetMultithreadProtected(true); }

    // Window capture (default) or the headless synthetic source.
    let mut synth = None;
    let mut capture = None;
    let (mut w, mut h);
    if synth_mode {
        (w, h) = (1920, 1080);
        synth = Some(Synth::new(w, h));
    } else {
        let winrt_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>().unwrap()).unwrap().cast().unwrap() };
        let hwnd = unsafe { FindWindowW(None, &HSTRING::from(title.as_str())) }.expect("window not found");
        let item: GraphicsCaptureItem = unsafe { windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().unwrap().CreateForWindow(hwnd).unwrap() };
        let size = item.Size().unwrap();
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size).unwrap();
        let session: GraphicsCaptureSession = pool.CreateCaptureSession(&item).unwrap();
        let _ = session.SetIsCursorCaptureEnabled(false);
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: 10_000 }); // 1 ms: no 60 Hz cap of its own
        session.StartCapture().unwrap();
        let gpu = Gpu::new(device.clone(), ctx.clone(), size.Width as u32, size.Height as u32);
        (w, h) = (gpu.w, gpu.h);
        capture = Some((pool, session, gpu));
    }
    let mut enc = Encoder::new(&device, ctx, w, h, software, profile);
    out(json!({"ready": {"w": w, "h": h, "encoder": enc.name, "profile": profile_name, "profileLevelId": format!("{profile_id:06x}"), "software": software, "source": if synth_mode { "synth" } else { "window" }}}));

    // SP2P_BIND_IP: Firefox ignores 127.0.0.1 host candidates, so its bench binds the LAN IP.
    let sock = UdpSocket::bind((std::env::var("SP2P_BIND_IP").unwrap_or("127.0.0.1".into()).as_str(), 0)).unwrap();
    sock.set_nonblocking(true).unwrap();
    let addr: SocketAddr = sock.local_addr().unwrap();
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
        std::process::exit(0);
    });

    let start = Instant::now();
    let frame_iv = Duration::from_nanos(1_000_000_000 / FPS as u64);
    let mut next_frame = Instant::now();
    let mut children: Vec<Child> = vec![];
    let mut need_input = 0u32;
    let mut want_key = false;
    let mut last_key = Instant::now() - Duration::from_secs(10);
    let mut fed_at: HashMap<i64, Instant> = HashMap::new();
    let (mut captured, mut encoded, mut skipped, mut bytes, mut keys) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut enc_ms, mut cap_ms) = (0f64, 0f64);
    let mut live: Vec<Value> = vec![]; // live changes: command and result
    let mut resize_at: Option<Instant> = None;
    let mut buf = vec![0u8; 2000];

    loop {
        let mut busy = false;
        // signaling
        while let Ok(v) = rx.try_recv() {
            if let Some(cmd) = v["cmd"].as_str() {
                match cmd {
                    "child" => {
                        let id = v["id"].as_u64().unwrap();
                        let mut b = Rtc::builder().clear_codecs();
                        b.codec_config().add_h264(PT.into(), Some((PT + 1).into()), true, profile_id);
                        let mut rtc = b.build(Instant::now());
                        rtc.add_local_candidate(Candidate::host(addr, "udp").unwrap());
                        let mut api = rtc.sdp_api();
                        let mid = api.add_media(MediaKind::Video, Direction::SendOnly, Some("native".into()), Some("video".into()), None);
                        let (offer, pending) = api.apply().unwrap();
                        out(json!({"to": id, "sdp": {"type": "offer", "sdp": offer.to_sdp_string()}}));
                        children.push(Child { id, rtc, mid, pending: Some(pending) });
                    }
                    "stats" => out(json!({"stats": {
                        "captured": captured, "encoded": encoded, "skipped": skipped, "bytes": bytes, "keys": keys,
                        "encodeMsAvg": if encoded > 0 { enc_ms / encoded as f64 } else { 0.0 },
                        "convertMsAvg": if captured > 0 { cap_ms / captured as f64 } else { 0.0 },
                        "w": w, "h": h, "encoder": enc.name, "bitrate": enc.bitrate, "live": live,
                        "children": children.iter().filter(|c| c.rtc.is_connected()).count(),
                    }})),
                    "bitrate" => {
                        let kbps = v["kbps"].as_u64().unwrap_or(0) as u32;
                        let t0 = Instant::now();
                        let ok = kbps >= 100 && enc.set_bitrate(kbps * 1000);
                        live.push(json!({"cmd": "bitrate", "kbps": kbps, "ok": ok, "applyMs": t0.elapsed().as_secs_f64() * 1000.0, "atMs": start.elapsed().as_millis() as u64}));
                    }
                    "resize" => {
                        let (nw, nh) = (v["w"].as_u64().unwrap_or(0) as u32 & !1, v["h"].as_u64().unwrap_or(0) as u32 & !1);
                        let Some(s) = synth.as_mut().filter(|_| nw >= 64 && nh >= 64) else {
                            live.push(json!({"cmd": "resize", "ok": false, "error": "só --synth, mínimo 64×64"}));
                            continue;
                        };
                        let t0 = Instant::now();
                        enc.restart(nw, nh);
                        (s.w, s.h, w, h) = (nw, nh, nw, nh);
                        need_input = 0; // flushed; the MFT asks again
                        fed_at.clear();
                        keys += 1;
                        last_key = Instant::now();
                        resize_at = Some(t0);
                        live.push(json!({"cmd": "resize", "w": nw, "h": nh, "ok": true, "restartMs": t0.elapsed().as_secs_f64() * 1000.0, "atMs": start.elapsed().as_millis() as u64}));
                    }
                    _ => {}
                }
                continue;
            }
            let from = v["from"].as_u64().unwrap_or(0);
            let Some(sdp) = v["sdp"].as_object() else { continue };
            if sdp["type"] == "answer" {
                if let Some(c) = children.iter_mut().find(|c| c.id == from) {
                    if let Some(p) = c.pending.take() {
                        c.rtc.sdp_api().accept_answer(p, SdpAnswer::from_sdp_string(sdp["sdp"].as_str().unwrap()).unwrap()).unwrap();
                    }
                }
            }
        }

        // encoder events (async MFT); the sync MFT is drained right after each input
        let mut outputs = vec![];
        while let Some(t) = enc.poll_event() {
            busy = true;
            if t == METransformNeedInput.0 as u32 {
                need_input += 1;
            } else if t == METransformHaveOutput.0 as u32 {
                outputs.extend(enc.take());
            }
        }
        if enc.sync() {
            need_input = 1;
        }

        // source: newest captured frame, or one synthetic frame per 1/60 s
        let mut nv12 = None;
        let t0 = Instant::now();
        if let Some(s) = synth.as_mut() {
            if t0 >= next_frame {
                next_frame = (next_frame + frame_iv).max(t0);
                busy = true;
                captured += 1;
                if need_input > 0 {
                    let (sw, sh) = (s.w, s.h);
                    nv12 = Some(tex_with(&device, sw, sh, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, Some(s.draw())));
                } else {
                    skipped += 1;
                }
            }
        } else if let Some((pool, _, gpu)) = capture.as_ref() {
            let mut frame = None;
            while let Ok(f) = pool.TryGetNextFrame() {
                if let Some(old) = frame.replace(f) {
                    skipped += 1;
                    let _ = old.Close(); // hand the buffer back to the pool
                }
            }
            if let Some(f) = frame {
                busy = true;
                captured += 1;
                if need_input > 0 {
                    let surface = f.Surface().unwrap();
                    let tex: ID3D11Texture2D = unsafe { surface.cast::<IDirect3DDxgiInterfaceAccess>().unwrap().GetInterface().unwrap() };
                    nv12 = Some(gpu.to_nv12(&tex));
                    drop(tex);
                    let _ = surface.Close();
                    let _ = f.Close();
                } else {
                    skipped += 1;
                    let _ = f.Close();
                }
            }
        }
        if let Some(nv12) = nv12 {
            cap_ms += t0.elapsed().as_secs_f64() * 1000.0;
            if want_key && last_key.elapsed() >= Duration::from_millis(500) {
                enc.force_key();
                keys += 1;
                want_key = false;
                last_key = Instant::now();
            }
            let ts = (start.elapsed().as_nanos() / 100) as i64;
            fed_at.insert(ts, t0);
            enc.feed(&nv12, ts);
            need_input -= 1;
            if enc.sync() {
                while let Some(o) = enc.take() {
                    outputs.push(o);
                }
            }
        }

        for (data, ts) in outputs {
            encoded += 1;
            bytes += data.len() as u64;
            if let Some(at) = fed_at.remove(&ts) {
                enc_ms += at.elapsed().as_secs_f64() * 1000.0;
            }
            if let Some(t) = resize_at.take() {
                live.push(json!({"event": "firstOutputAfterResize", "ms": t.elapsed().as_secs_f64() * 1000.0}));
            }
            let now = Instant::now();
            let rtp = MediaTime::new((ts as u64) * 9 / 1000, Frequency::NINETY_KHZ); // 100 ns → 90 kHz
            for c in children.iter_mut().filter(|c| c.rtc.is_connected()) {
                if let Some(w) = c.rtc.writer(c.mid) {
                    let _ = w.write(PT.into(), now, rtp, data.clone());
                }
            }
        }

        // network
        let mut timeout = Instant::now() + Duration::from_millis(50);
        for c in children.iter_mut() {
            timeout = timeout.min(drain(c, &sock, &mut want_key));
        }
        while let Ok((n, source)) = sock.recv_from(&mut buf) {
            busy = true;
            if let Ok(contents) = buf[..n].try_into() {
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: addr, contents });
                if let Some(c) = children.iter_mut().find(|c| c.rtc.accepts(&input)) {
                    let _ = c.rtc.handle_input(input);
                }
            }
        }
        let now = Instant::now();
        for c in children.iter_mut() {
            if now >= timeout || busy {
                let _ = c.rtc.handle_input(Input::Timeout(now));
            }
            drain(c, &sock, &mut want_key);
        }
        if !busy {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

#[allow(dead_code)]
fn _codec_check() -> Codec {
    Codec::H264
}
