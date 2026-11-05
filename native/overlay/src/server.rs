// WebSocket server on 127.0.0.1 for the WavePlug panel. One client at a time (the panel); a new
// connection replaces the old one, as after the development loader's ⟳.
// Runs on its own thread: commands go to the host through `on_command` (`on_disconnect` when the
// plugin goes away), events come back through the outbox. Knows nothing about any surface.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tungstenite::{Message, WebSocket};

use crate::protocol::{self, Command, Event};

static OUTBOX: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Queues an event for the connected panel (dropped if none is connected).
pub fn send(ev: &Event) {
    if let Ok(mut q) = OUTBOX.lock() { q.push_back(protocol::encode(ev)); }
}

/// Binds the port; Err means another copy is already running.
pub fn start(on_command: fn(Command), on_disconnect: fn()) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", protocol::PORT))?;
    listener.set_nonblocking(true)?;
    thread::spawn(move || run(listener, on_command, on_disconnect));
    Ok(())
}

fn run(listener: TcpListener, on_command: fn(Command), on_disconnect: fn()) {
    let mut client: Option<WebSocket<TcpStream>> = None;
    loop {
        // a new panel connection replaces the old one
        if let Ok((stream, _)) = listener.accept() {
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            if let Ok(ws) = tungstenite::accept(stream) {
                let _ = ws.get_ref().set_nonblocking(true);
                if let Ok(mut q) = OUTBOX.lock() { q.clear(); }
                client = Some(ws);
                send(&Event::Ready { version: env!("CARGO_PKG_VERSION") });
            }
        }
        if let Some(ws) = client.as_mut() {
            let mut alive = true;
            loop {
                match ws.read() {
                    Ok(Message::Text(t)) => { if let Some(c) = protocol::parse(&t) { on_command(c); } }
                    Ok(Message::Close(_)) => { alive = false; break; }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(_) => { alive = false; break; }
                }
            }
            if alive {
                let pending: Vec<String> = OUTBOX.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
                for text in pending {
                    match ws.send(Message::Text(text)) {
                        Ok(()) => {}
                        Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                        Err(_) => { alive = false; break; }
                    }
                }
                match ws.flush() {
                    Ok(()) => {}
                    Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => alive = false,
                }
            }
            if !alive {
                client = None;
                on_disconnect();
            }
        }
        thread::sleep(Duration::from_millis(15));
    }
}
