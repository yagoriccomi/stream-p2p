//! Screen capture: Windows.Graphics.Capture of a monitor → BGRA texture → D3D11 video processor
//! (BGRA→NV12, scaled to fit 1080p) → NV12 texture for the encoder. `Synth` is the headless
//! source for tests: scrolling noise plus the bench clock (24-bit ms stamp + 0xa5 on the top 1/8).
use std::mem::ManuallyDrop;
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::{Interface, Result, BOOL};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{LPARAM, POINT, RECT};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, MonitorFromPoint, HDC, HMONITOR, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

pub const FPS: u32 = 60;
pub const MAX_W: u32 = 1920;
pub const MAX_H: u32 = 1080;

/// Largest even size within max_w×max_h with the source's aspect; never upscales.
pub fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let s = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    (((w as f64 * s) as u32) & !1, ((h as f64 * s) as u32) & !1)
}

pub fn tex(device: &ID3D11Device, w: u32, h: u32, fmt: DXGI_FORMAT, init: Option<&[u8]>) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: fmt,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    // NV12 initial data: one subresource, UV plane right after Y at pitch * height.
    let data = init.map(|d| D3D11_SUBRESOURCE_DATA { pSysMem: d.as_ptr().cast(), SysMemPitch: w, SysMemSlicePitch: 0 });
    let mut t = None;
    unsafe { device.CreateTexture2D(&desc, data.as_ref().map(|d| d as *const _), Some(&mut t))? };
    Ok(t.unwrap())
}

/// Monitor `index` in EnumDisplayMonitors order, or the primary one.
fn monitor(index: Option<usize>) -> Option<HMONITOR> {
    let Some(i) = index else { return Some(unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) }) };
    unsafe extern "system" fn push(m: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> BOOL {
        (*(list.0 as *mut Vec<HMONITOR>)).push(m);
        true.into()
    }
    let mut list: Vec<HMONITOR> = vec![];
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(push), LPARAM(&mut list as *mut _ as isize));
    }
    list.get(i).copied()
}

pub struct Screen {
    pool: Direct3D11CaptureFramePool,
    _session: GraphicsCaptureSession,
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    vdev: ID3D11VideoDevice,
    vctx: ID3D11VideoContext,
    vp: ID3D11VideoProcessor,
    venum: ID3D11VideoProcessorEnumerator,
    bgra: ID3D11Texture2D,
    input_view: ID3D11VideoProcessorInputView,
    pub w: u32,
    pub h: u32,
    pub skipped: u64,
    /// Last converted frame: WGC only delivers frames when the screen changes, so a still
    /// screen is repeated from here (keyframes for new viewers, a steady stream for the rest).
    last: Option<ID3D11Texture2D>,
    last_at: std::time::Instant,
}

/// A still screen is repeated at least this often.
pub const REPEAT: std::time::Duration = std::time::Duration::from_millis(100);

impl Screen {
    pub fn new(device: &ID3D11Device, ctx: &ID3D11DeviceContext, index: Option<usize>) -> Result<Screen> {
        let hmon = monitor(index).ok_or_else(|| windows::core::Error::new(windows::Win32::Foundation::E_INVALIDARG, "monitor não existe"))?;
        let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()? };
        let item: GraphicsCaptureItem = unsafe { windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?.CreateForMonitor(hmon)? };
        let size = item.Size()?;
        let (sw, sh) = (size.Width as u32, size.Height as u32);
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: 10_000 }); // 1 ms: no 60 Hz cap of its own
        session.StartCapture()?;

        let (w, h) = fit(sw, sh, MAX_W, MAX_H);
        let vdev: ID3D11VideoDevice = device.cast()?;
        let vctx: ID3D11VideoContext = ctx.cast()?;
        let cd = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
            InputWidth: sw,
            InputHeight: sh,
            OutputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
            OutputWidth: w,
            OutputHeight: h,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let venum = unsafe { vdev.CreateVideoProcessorEnumerator(&cd)? };
        let vp = unsafe { vdev.CreateVideoProcessor(&venum, 0)? };
        let bgra = tex(device, sw, sh, DXGI_FORMAT_B8G8R8A8_UNORM, None)?;
        let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut iv = None;
        unsafe { vdev.CreateVideoProcessorInputView(&bgra, &venum, &ivd, Some(&mut iv))? };
        eprintln!("captura: monitor {sw}x{sh} → {w}x{h}");
        Ok(Screen { pool, _session: session, device: device.clone(), ctx: ctx.clone(), vdev, vctx, vp, venum, bgra, input_view: iv.unwrap(), w, h, skipped: 0, last: None, last_at: std::time::Instant::now() })
    }

    /// Newest captured frame as NV12, if one arrived (older ones count as skipped), or the last
    /// one again when the screen is still for REPEAT or `key` asks for a picture now.
    /// `want` false: the encoder is busy, the frame is dropped.
    pub fn next(&mut self, want: bool, key: bool) -> Result<Option<ID3D11Texture2D>> {
        let fresh = self.fresh(want)?;
        if fresh.is_some() || !want {
            return Ok(fresh);
        }
        if key || self.last_at.elapsed() >= REPEAT {
            self.last_at = std::time::Instant::now();
            return Ok(self.last.clone());
        }
        Ok(None)
    }

    fn fresh(&mut self, want: bool) -> Result<Option<ID3D11Texture2D>> {
        let mut frame = None;
        while let Ok(f) = self.pool.TryGetNextFrame() {
            if let Some(old) = frame.replace(f) {
                self.skipped += 1;
                let _ = old.Close(); // hand the buffer back to the pool
            }
        }
        let Some(f) = frame else { return Ok(None) };
        if !want {
            self.skipped += 1;
            let _ = f.Close();
            return Ok(None);
        }
        let surface = f.Surface()?;
        let captured: ID3D11Texture2D = unsafe { surface.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()? };
        let nv12 = tex(&self.device, self.w, self.h, DXGI_FORMAT_NV12, None)?;
        let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
        };
        let mut ov = None;
        unsafe {
            self.ctx.CopyResource(&self.bgra, &captured);
            self.vdev.CreateVideoProcessorOutputView(&nv12, &self.venum, &ovd, Some(&mut ov))?;
            let streams = [D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: ManuallyDrop::new(Some(self.input_view.clone())), ..Default::default() }];
            let r = self.vctx.VideoProcessorBlt(&self.vp, ov.as_ref().unwrap(), 0, &streams);
            let [mut s] = streams;
            ManuallyDrop::drop(&mut s.pInputSurface);
            r?;
        }
        drop(captured);
        let _ = surface.Close();
        let _ = f.Close();
        // ponytail: the encoder may still read the texture we hand back on a repeat; the repeat
        // only happens 100 ms later, well after the MFT consumed it. A pool with fences if it shows.
        self.last = Some(nv12.clone());
        self.last_at = std::time::Instant::now();
        Ok(Some(nv12))
    }
}

// ── headless synthetic source (same picture as e2e/bench/relay.html capture()) ──
const TILE: usize = 512;
pub struct Synth {
    pub w: u32,
    pub h: u32,
    t: usize,
    tile: Vec<u8>, // TILE rows of 2*TILE bytes (row repeated), so any offset is one contiguous copy
    frame: Vec<u8>,
}

impl Synth {
    pub fn new(w: u32, h: u32) -> Synth {
        let mut seed = 0x2545_f491u32;
        let mut tile = vec![0u8; TILE * 2 * TILE];
        for y in 0..TILE {
            for x in 0..TILE {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
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
    pub fn draw(&mut self) -> &[u8] {
        self.t += 1;
        let (w, h) = (self.w as usize, self.h as usize);
        self.frame.resize(w * h * 3 / 2, 0);
        let (ox, oy) = ((self.t * 7) % TILE, (self.t * 3) % TILE);
        for y in 0..h {
            let row = &self.tile[((y + oy) % TILE) * 2 * TILE..][ox..ox + TILE];
            for chunk in self.frame[y * w..(y + 1) * w].chunks_mut(TILE) {
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

#[cfg(test)]
mod tests {
    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(super::fit(2560, 1440, 1920, 1080), (1920, 1080));
        assert_eq!(super::fit(1920, 1080, 1920, 1080), (1920, 1080));
        assert_eq!(super::fit(1280, 720, 1920, 1080), (1280, 720));
        assert_eq!(super::fit(3440, 1440, 1920, 1080), (1920, 802));
        assert_eq!(super::fit(1281, 721, 1920, 1080), (1280, 720));
    }
}
