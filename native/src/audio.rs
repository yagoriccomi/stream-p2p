//! Stream audio: system sound (WASAPI loopback, sysaudio.rs) or a test tone → Opus 48 kHz stereo,
//! one 20 ms packet per tick. Gaps are filled with silence so the viewer's clock keeps running.
use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver};

use opus1::{Application, Bitrate, Channels, OpusEncoder, SampleRate};

pub const RATE: usize = crate::sysaudio::RATE;
pub const FRAME: usize = RATE / 50; // 20 ms per channel
const CH: usize = 2;
const MAX_QUEUE: usize = RATE / 5 * CH; // >200 ms behind: drop the oldest (clock drift, stalls)
const KBPS: u32 = 128;

pub enum Source {
    System(Receiver<Vec<f32>>),
    Tone(usize),
    Off,
}

pub struct Audio {
    src: Source,
    queue: VecDeque<f32>,
    enc: OpusEncoder,
    pub samples: u64, // per channel, sent so far: the RTP clock
    pkt: Vec<u8>,
}

impl Audio {
    /// `kind`: "system" | "tone" | "off". System audio failing is not fatal (catalog §2.9):
    /// the stream goes on with video and silence, and the log says why.
    pub fn new(kind: &str) -> Audio {
        let src = match kind {
            "tone" => Source::Tone(0),
            "off" => Source::Off,
            _ => {
                let (tx, rx) = mpsc::channel();
                match crate::sysaudio::start(tx, None, None, None) {
                    Ok(()) => {
                        eprintln!("áudio: som do sistema (loopback, sem o próprio app)");
                        Source::System(rx)
                    }
                    Err(e) => {
                        eprintln!("áudio: não conseguimos acessar o áudio ({e}); transmitindo só vídeo");
                        Source::Off
                    }
                }
            }
        };
        let mut enc = OpusEncoder::new(SampleRate::Hz48000, Channels::Stereo, Application::Audio).expect("opus");
        enc.set_bitrate(Bitrate::BitsPerSecond(std::num::NonZeroU32::new(KBPS * 1000).unwrap()));
        Audio { src, queue: VecDeque::new(), enc, samples: 0, pkt: vec![0; 1500] }
    }

    /// Next 20 ms Opus packet.
    pub fn next(&mut self) -> Vec<u8> {
        let mut pcm = vec![0f32; FRAME * CH];
        match &mut self.src {
            Source::System(rx) => {
                while let Ok(chunk) = rx.try_recv() {
                    self.queue.extend(chunk);
                }
                let excess = self.queue.len().saturating_sub(MAX_QUEUE);
                self.queue.drain(..excess);
                for (d, s) in pcm.iter_mut().zip(self.queue.drain(..self.queue.len().min(FRAME * CH))) {
                    *d = s;
                }
            }
            Source::Tone(n) => {
                for f in pcm.chunks_mut(CH) {
                    let v = (*n as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin() * 0.2;
                    f.fill(v);
                    *n += 1;
                }
            }
            Source::Off => {}
        }
        self.samples += FRAME as u64;
        let n = self.enc.encode(&pcm, FRAME, &mut self.pkt).unwrap_or(0);
        self.pkt[..n].to_vec()
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        if matches!(self.src, Source::System(_)) {
            crate::sysaudio::stop();
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn tone_encodes_20ms_packets() {
        let mut a = super::Audio::new("tone");
        let p = a.next();
        assert!(p.len() > 10, "opus packet: {} bytes", p.len());
        assert_eq!(a.samples, 960);
    }
}
