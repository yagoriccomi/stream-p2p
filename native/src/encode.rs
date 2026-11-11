//! H.264 encode through Media Foundation: the GPU's MFT (NVENC/AMF/QSV, async, D3D11 input) or,
//! as plan B, the Microsoft software MFT (sync, NV12 read back to system memory).
#![allow(non_snake_case)]
use std::mem::ManuallyDrop;

use windows::core::{Error, Interface, Result, GUID, HRESULT};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_UI4};

use crate::capture::FPS;

/// H.264 profile: the MFT's profile and the SDP profile-level-id announced for it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Profile {
    ConstrainedBaseline,
    Baseline,
    Main,
}

impl Profile {
    pub fn parse(s: &str) -> Option<Profile> {
        match s {
            "constrained-baseline" | "42e01f" => Some(Profile::ConstrainedBaseline),
            "baseline" | "42001f" => Some(Profile::Baseline),
            "main" | "4d001f" => Some(Profile::Main),
            _ => None,
        }
    }
    /// Level 3.1 in the fmtp; with level-asymmetry-allowed it did not cap 1080p60 in any browser [r19].
    pub fn level_id(self) -> u32 {
        match self {
            Profile::ConstrainedBaseline => 0x42e01f,
            Profile::Baseline => 0x42001f,
            Profile::Main => 0x4d001f,
        }
    }
    fn mft(self) -> eAVEncH264VProfile {
        match self {
            Profile::ConstrainedBaseline => eAVEncH264VProfile_ConstrainedBase,
            Profile::Baseline => eAVEncH264VProfile_Base,
            Profile::Main => eAVEncH264VProfile_Main,
        }
    }
}

/// The MFT's 0x8000FFFF after a bitrate change [r13]; anything else unexpected from the MFT
/// is handled the same way (drop the frame; if it repeats, recreate the encoder).
pub const E_UNEXPECTED: HRESULT = HRESULT(0x8000FFFFu32 as i32);

fn var_u32(v: u32) -> VARIANT {
    let mut x = VARIANT::default();
    unsafe {
        let inner = &mut *x.Anonymous.Anonymous;
        inner.vt = VT_UI4;
        inner.Anonymous.ulVal = v;
    }
    x
}
fn var_bool(v: bool) -> VARIANT {
    let mut x = VARIANT::default();
    unsafe {
        let inner = &mut *x.Anonymous.Anonymous;
        inner.vt = VT_BOOL;
        inner.Anonymous.boolVal = windows::Win32::Foundation::VARIANT_BOOL(if v { -1 } else { 0 });
    }
    x
}

fn media_type(sub: &GUID, w: u32, h: u32) -> Result<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetGUID(&MF_MT_SUBTYPE, sub)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, ((w as u64) << 32) | h as u64)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, ((FPS as u64) << 32) | 1)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        Ok(t)
    }
}

pub struct Encoder {
    mft: IMFTransform,
    events: Option<IMFMediaEventGenerator>, // None: synchronous software MFT
    codec: ICodecAPI,
    ctx: ID3D11DeviceContext,
    staging: Option<ID3D11Texture2D>,
    provides_samples: bool,
    out_size: u32,
    pub name: String,
    pub software: bool,
    pub bitrate: u32,
}

impl Encoder {
    /// Hardware MFT on `device`'s adapter, or the software MFT. `test_no_hw` pretends this PC
    /// has no GPU encoder (exercises plan B in tests).
    pub fn new(device: &ID3D11Device, ctx: &ID3D11DeviceContext, w: u32, h: u32, software: bool, profile: Profile, bitrate: u32, test_no_hw: bool) -> Result<Encoder> {
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
            let (mft, events, name) = if software {
                let mft: IMFTransform = CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER)?;
                (mft, None, "Microsoft H264 Video Encoder MFT (software)".to_string())
            } else {
                let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
                let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
                let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
                let mut n = 0u32;
                MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &mut list, &mut n)?;
                let first = if n > 0 && !test_no_hw { (*list).clone() } else { None };
                for i in 0..n as usize {
                    drop((*list.add(i)).take());
                }
                if !list.is_null() {
                    windows::Win32::System::Com::CoTaskMemFree(Some(list as *const _));
                }
                let act = first.ok_or_else(|| Error::new(MF_E_NOT_FOUND, "nenhum codificador H.264 na GPU"))?;
                let mut pname = windows::core::PWSTR::null();
                let mut len = 0u32;
                let _ = act.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut pname, &mut len);
                let name = pname.to_string().unwrap_or_default();
                if !pname.is_null() {
                    windows::Win32::System::Com::CoTaskMemFree(Some(pname.0 as *const _));
                }
                let mft: IMFTransform = act.ActivateObject()?;
                let attrs = mft.GetAttributes()?;
                attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
                let mut token = 0u32;
                let mut mgr = None;
                MFCreateDXGIDeviceManager(&mut token, &mut mgr)?;
                let mgr = mgr.unwrap();
                mgr.ResetDevice(device, token)?;
                mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, mgr.as_raw() as usize)?;
                let events: IMFMediaEventGenerator = mft.cast()?;
                (mft, Some(events), name)
            };

            let codec: ICodecAPI = mft.cast()?;
            let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &var_bool(true));
            let _ = codec.SetValue(&CODECAPI_AVEncCommonRateControlMode, &var_u32(eAVEncCommonRateControlMode_CBR.0 as u32));
            let _ = codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(bitrate));
            let _ = codec.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &var_u32(0));
            let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &var_u32(FPS * 10)); // GOP 10 s + keyframe on demand [ADR §2.5]

            let ot = media_type(&MFVideoFormat_H264, w, h)?;
            ot.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            ot.SetUINT32(&MF_MT_MPEG2_PROFILE, profile.mft().0 as u32)?;
            mft.SetOutputType(0, &ot, 0)?;
            mft.SetInputType(0, &media_type(&MFVideoFormat_NV12, w, h)?, 0)?;
            let info = mft.GetOutputStreamInfo(0)?;
            let provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Encoder { mft, events, codec, ctx: ctx.clone(), staging: None, provides_samples, out_size: info.cbSize.max(4 << 20), name, software, bitrate })
        }
    }

    pub fn set_bitrate(&mut self, bps: u32) -> Result<()> {
        unsafe { self.codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(bps))? };
        self.bitrate = bps;
        Ok(())
    }

    pub fn sync(&self) -> bool {
        self.events.is_none()
    }

    /// Non-blocking: next encoder event type, if any.
    pub fn poll_event(&self) -> Option<u32> {
        unsafe { self.events.as_ref()?.GetEvent(MF_EVENT_FLAG_NO_WAIT).ok().and_then(|e| e.GetType().ok()) }
    }

    pub fn feed(&mut self, nv12: &ID3D11Texture2D, t100ns: i64) -> Result<()> {
        unsafe {
            let buf = if self.sync() {
                self.readback(nv12)?
            } else {
                let buf = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, nv12, 0, false)?;
                let len = buf.cast::<IMF2DBuffer>()?.GetContiguousLength()?;
                buf.SetCurrentLength(len)?;
                buf
            };
            let s = MFCreateSample()?;
            s.AddBuffer(&buf)?;
            s.SetSampleTime(t100ns)?;
            s.SetSampleDuration(10_000_000 / FPS as i64)?;
            self.mft.ProcessInput(0, &s, 0)
        }
    }

    /// Software path: GPU NV12 → staging texture → tight system-memory buffer.
    unsafe fn readback(&mut self, nv12: &ID3D11Texture2D) -> Result<IMFMediaBuffer> {
        let mut d = D3D11_TEXTURE2D_DESC::default();
        nv12.GetDesc(&mut d);
        if self.staging.is_none() {
            let desc = D3D11_TEXTURE2D_DESC { Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, ..d };
            let mut t = None;
            nv12.GetDevice()?.CreateTexture2D(&desc, None, Some(&mut t))?;
            self.staging = t;
        }
        let st = self.staging.as_ref().unwrap();
        self.ctx.CopyResource(st, nv12);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(st, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        let (w, h, pitch) = (d.Width as usize, d.Height as usize, m.RowPitch as usize);
        let size = w * h * 3 / 2;
        let buf = MFCreateMemoryBuffer(size as u32)?;
        let mut p = std::ptr::null_mut();
        buf.Lock(&mut p, None, None)?;
        let src = m.pData as *const u8;
        for row in 0..h * 3 / 2 {
            std::ptr::copy_nonoverlapping(src.add(row * pitch), p.add(row * w), w); // UV rows follow Y at pitch * height
        }
        buf.Unlock()?;
        self.ctx.Unmap(st, 0);
        buf.SetCurrentLength(size as u32)?;
        Ok(buf)
    }

    /// One encoded access unit (Annex B) and its sample time in 100 ns; Ok(None) when the MFT
    /// has nothing yet. Err: the MFT failed (the caller decides on recovery).
    pub fn take(&mut self) -> Result<Option<(Vec<u8>, i64)>> {
        unsafe {
            let own = if self.provides_samples {
                None
            } else {
                let s = MFCreateSample()?;
                s.AddBuffer(&MFCreateMemoryBuffer(self.out_size)?)?;
                Some(s)
            };
            let mut db = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(own), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let r = self.mft.ProcessOutput(0, &mut db, &mut status);
            let sample = ManuallyDrop::take(&mut db[0].pSample);
            ManuallyDrop::drop(&mut db[0].pEvents);
            if let Err(e) = r {
                if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                    let t = self.mft.GetOutputAvailableType(0, 0)?;
                    self.mft.SetOutputType(0, &t, 0)?;
                    return Ok(None);
                }
                if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                    return Ok(None);
                }
                return Err(e);
            }
            let Some(sample) = sample else { return Ok(None) };
            let t = sample.GetSampleTime().unwrap_or(0);
            let buf = sample.ConvertToContiguousBuffer()?;
            let mut p = std::ptr::null_mut();
            let mut n = 0u32;
            buf.Lock(&mut p, None, Some(&mut n))?;
            let data = std::slice::from_raw_parts(p, n as usize).to_vec();
            buf.Unlock()?;
            Ok(Some((data, t)))
        }
    }

    pub fn force_key(&self) {
        unsafe {
            let _ = self.codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &var_u32(1));
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if let Some(ev) = &self.events {
                let _ = ev.cast::<IMFShutdown>().map(|s| s.Shutdown());
            }
        }
    }
}

/// When to give up on the current MFT: one failure drops the frame; a second one within
/// `window_ms` recreates the encoder [ADR §2.9, r13].
pub struct Faults {
    last: Option<std::time::Instant>,
}

impl Faults {
    pub const WINDOW: std::time::Duration = std::time::Duration::from_secs(2);
    pub fn new() -> Faults {
        Faults { last: None }
    }
    /// Records a failure at `now`; true means "recreate the encoder".
    pub fn hit(&mut self, now: std::time::Instant) -> bool {
        let repeat = self.last.is_some_and(|t| now.duration_since(t) <= Self::WINDOW);
        self.last = if repeat { None } else { Some(now) };
        repeat
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn profiles() {
        assert_eq!(Profile::parse("main").unwrap().level_id(), 0x4d001f);
        assert_eq!(Profile::parse("42e01f"), Some(Profile::ConstrainedBaseline));
        assert_eq!(Profile::parse("high"), None);
    }

    #[test]
    fn one_fault_drops_two_recreate() {
        let t = Instant::now();
        let mut f = Faults::new();
        assert!(!f.hit(t));
        assert!(f.hit(t + Duration::from_millis(100)));
        assert!(!f.hit(t + Duration::from_millis(200)), "after a recreate the count starts over");
        assert!(!f.hit(t + Duration::from_secs(10)), "far apart: two isolated drops");
    }
}
