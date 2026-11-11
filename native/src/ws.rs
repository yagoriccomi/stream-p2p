//! Signaling client: the server's WebSocket protocol, unchanged (server/index.js). A thread owns
//! the socket and reconnects with backoff 1/2/4/5 s; the main loop talks to it via channels and
//! sees `{"type":"_open"}` / `{"type":"_closed"}` when the link changes.
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{client_tls, Message};

const BACKOFF: [u64; 4] = [1, 2, 4, 5];

/// http(s)://host[:port][/...] → ws(s)://host[:port]/ (the WS lives at the page's host).
pub fn ws_url(server: &str) -> Result<String, String> {
    let (scheme, rest) = server.split_once("://").ok_or_else(|| format!("URL do servidor sem http:// ou https://: {server}"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() {
        return Err(format!("URL do servidor sem host: {server}"));
    }
    let ws = match scheme.to_ascii_lowercase().as_str() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        s => return Err(format!("esquema não suportado: {s}")),
    };
    Ok(format!("{ws}://{host}/"))
}

/// Invite link the web opens (web/app.js inviteLink).
pub fn invite(server: &str, code: &str) -> String {
    format!("{}/?code={code}", server.trim_end_matches('/'))
}

pub struct Ws {
    pub rx: Receiver<Value>,
    tx: Sender<Value>,
}

impl Ws {
    pub fn send(&self, v: Value) {
        let _ = self.tx.send(v);
    }

    pub fn connect(server: &str) -> Result<Ws, String> {
        let url = ws_url(server)?;
        let (in_tx, in_rx) = mpsc::channel::<Value>();
        let (out_tx, out_rx) = mpsc::channel::<Value>();
        thread::spawn(move || {
            let mut attempt = 0usize;
            loop {
                match run(&url, &in_tx, &out_rx) {
                    Ok(()) => return, // main loop went away
                    Err(e) => {
                        if in_tx.send(json!({"type": "_closed", "reason": e})).is_err() {
                            return;
                        }
                    }
                }
                let wait = BACKOFF[attempt.min(BACKOFF.len() - 1)];
                attempt += 1;
                thread::sleep(Duration::from_secs(wait));
                while out_rx.try_recv().is_ok() {} // stale messages of the dead socket
            }
        });
        Ok(Ws { rx: in_rx, tx: out_tx })
    }
}

/// One socket's life. Ok: the main loop is gone. Err: the link dropped.
fn run(url: &str, inbox: &Sender<Value>, outbox: &Receiver<Value>) -> Result<(), String> {
    let host = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or_default();
    let addr = if host.contains(':') { host.to_string() } else if url.starts_with("wss") { format!("{host}:443") } else { format!("{host}:80") };
    let tcp = TcpStream::connect(&addr).map_err(|e| format!("{addr}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    let (mut ws, _) = client_tls(url, tcp).map_err(|e| e.to_string())?;
    // Short read timeout after the handshake: one thread reads and writes.
    let timeout = Some(Duration::from_millis(5));
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(timeout),
        MaybeTlsStream::NativeTls(s) => s.get_mut().set_read_timeout(timeout),
        _ => Ok(()),
    }
    .map_err(|e| e.to_string())?;
    if inbox.send(json!({"type": "_open"})).is_err() {
        return Ok(());
    }
    loop {
        loop {
            match outbox.try_recv() {
                Ok(v) => {
                    if std::env::var("SP2P_DEBUG").is_ok() {
                        eprintln!("ws -> {v}");
                    }
                    ws.send(Message::text(v.to_string())).map_err(|e| e.to_string())?
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = ws.close(None);
                    return Ok(());
                }
            }
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Ok(v) = serde_json::from_str::<Value>(&t) {
                    if inbox.send(v).is_err() {
                        return Ok(());
                    }
                }
            }
            Ok(Message::Close(_)) => return Err("servidor fechou a conexão".into()),
            Ok(_) => {} // ping: tungstenite queues the pong, flushed by the next read/send
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                let _ = ws.flush();
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(ws_url("http://localhost:3000").unwrap(), "ws://localhost:3000/");
        assert_eq!(ws_url("https://stream-p2p.example.com/x?y").unwrap(), "wss://stream-p2p.example.com/");
        assert!(ws_url("localhost:3000").is_err());
        assert!(ws_url("ftp://x").is_err());
        assert_eq!(invite("http://localhost:3000/", "abcd-ef"), "http://localhost:3000/?code=abcd-ef");
    }
}
