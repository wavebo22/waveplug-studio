// WebSocket server on 127.0.0.1 for the WavePlug panels. Runs on its own thread: the Photoshop
// panel's commands go to the host through `on_command` (`on_disconnect` when it goes away),
// events come back through the outbox. Knows nothing about any surface.
//
// Two kinds of client (11-14, 牵手 Photoshop ⇄ Illustrator):
// - Photoshop (the WavePlug plugin): what every client was before. It never introduces itself;
//   its first message is a normal command. A new Photoshop connection replaces the old one, as
//   after the development loader's ⟳.
// - Illustrator (the WaveLayer CEP panel, ai/): its first message is {"type":"join","role":
//   "illustrator"}. It sends nothing to the host; it only talks to Photoshop through `bridge`.
//
// `{"type":"bridge","to":"photoshop"|"illustrator","msg":{…}}` from either side reaches the other
// as `{"type":"bridge","from":…,"msg":{…}}`; with nobody there the sender gets
// `{"kind":"missing"}` back (with the msg's reqId). Each side hears `{"type":"peer","role":…,
// "connected":…}` when the other comes or goes.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

use crate::protocol::{self, Command, Event};

static OUTBOX: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Queues an event for the connected Photoshop panel (dropped if none is connected).
pub fn send(ev: &Event) {
    if let Ok(mut q) = OUTBOX.lock() { q.push_back(protocol::encode(ev)); }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Photoshop,
    Illustrator,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Role::Photoshop => "photoshop",
            Role::Illustrator => "illustrator",
        }
    }
    fn parse(s: &str) -> Option<Role> {
        match s {
            "photoshop" => Some(Role::Photoshop),
            "illustrator" => Some(Role::Illustrator),
            _ => None,
        }
    }
    fn other(self) -> Role {
        match self {
            Role::Photoshop => Role::Illustrator,
            Role::Illustrator => Role::Photoshop,
        }
    }
}

/// What one text message from a client is.
#[derive(Debug, PartialEq)]
pub enum Routed {
    /// {"type":"join","role":…}
    Join(Role),
    /// for the other client: the text to give it
    Forward { to: Role, text: String },
    /// anything else: a command for the host (from Photoshop only)
    Other,
}

/// Sorts one message; `from` is who sent it (None: a new client that hasn't said yet).
pub fn route(from: Option<Role>, text: &str) -> Routed {
    // only bridge / join messages are looked into; commands go to the host as before
    if !text.contains("\"join\"") && !text.contains("\"bridge\"") {
        return Routed::Other;
    }
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Routed::Other };
    match v.get("type").and_then(Value::as_str) {
        Some("join") => v.get("role").and_then(Value::as_str).and_then(Role::parse).map(Routed::Join).unwrap_or(Routed::Other),
        Some("bridge") => {
            let sender = from.unwrap_or(Role::Photoshop);
            let to = v.get("to").and_then(Value::as_str).and_then(Role::parse).unwrap_or(sender.other());
            let msg = v.get("msg").cloned().unwrap_or(Value::Null);
            Routed::Forward { to, text: json!({ "type": "bridge", "from": sender.name(), "msg": msg }).to_string() }
        }
        _ => Routed::Other,
    }
}

/// The answer to a bridge message nobody could take.
pub fn missing(to: Role, forwarded: &str) -> String {
    let req = serde_json::from_str::<Value>(forwarded).ok().and_then(|v| v.get("msg")?.get("reqId").cloned());
    json!({ "type": "bridge", "from": "helper", "msg": { "kind": "missing", "to": to.name(), "reqId": req } }).to_string()
}

fn peer_text(role: Role, connected: bool) -> String {
    json!({ "type": "peer", "role": role.name(), "connected": connected }).to_string()
}

struct Client {
    ws: WebSocket<TcpStream>,
    role: Option<Role>,
    alive: bool,
}

impl Client {
    fn put(&mut self, text: String) {
        match self.ws.send(Message::Text(text)) {
            Ok(()) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => self.alive = false,
        }
    }
    fn flush(&mut self) {
        match self.ws.flush() {
            Ok(()) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => self.alive = false,
        }
    }
}

static PS_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static AI_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether Photoshop's and Illustrator's panels are connected (the app window's 总览).
pub fn connected() -> (bool, bool) {
    use std::sync::atomic::Ordering::SeqCst;
    (PS_ON.load(SeqCst), AI_ON.load(SeqCst))
}

/// A second start of this program (`--show`): asks the running one to open its window.
pub fn ask_running_to_show(tab: &str) -> bool {
    let Ok((mut ws, _)) = tungstenite::connect(format!("ws://127.0.0.1:{}", protocol::PORT)) else { return false };
    let ok = ws.send(Message::Text(json!({ "type": "show-app", "tab": tab }).to_string())).is_ok();
    let _ = ws.flush();
    let _ = ws.close(None);
    ok
}

/// Binds the port; Err means another copy is already running.
pub fn start(on_command: fn(Command), on_disconnect: fn()) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", protocol::PORT))?;
    listener.set_nonblocking(true)?;
    thread::spawn(move || run(listener, on_command, on_disconnect));
    Ok(())
}

/// A message for the client in `role`; None when that client isn't there.
fn deliver(clients: &mut [Client], role: Role, text: String) -> Option<String> {
    match clients.iter_mut().find(|c| c.role == Some(role) && c.alive) {
        Some(c) => {
            c.put(text);
            None
        }
        None => Some(text),
    }
}

fn run(listener: TcpListener, on_command: fn(Command), on_disconnect: fn()) {
    let mut clients: Vec<Client> = Vec::new();
    loop {
        if let Ok((stream, _)) = listener.accept() {
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            if let Ok(ws) = tungstenite::accept(stream) {
                let _ = ws.get_ref().set_nonblocking(true);
                let mut c = Client { ws, role: None, alive: true };
                c.put(protocol::encode(&Event::Ready {
                    version: env!("CARGO_PKG_VERSION"),
                    live_root: crate::autoupdate::live_root().map(|p| crate::autoupdate::url_dir(&p)),
                    app_exe: crate::autoupdate::app_exe().map(|p| p.display().to_string()),
                }));
                // an update found before this panel connected
                if let Some(ev) = crate::autoupdate::found_event() {
                    c.put(protocol::encode(&ev));
                }
                clients.push(c);
            }
        }
        // read every client; what it says may be for the host, for the other client, or a join
        let mut forwards: Vec<(usize, Role, String)> = Vec::new();
        let mut joined: Vec<(usize, Role)> = Vec::new();
        for (i, c) in clients.iter_mut().enumerate() {
            loop {
                match c.ws.read() {
                    // a second start of this program, not a panel: open the window, say goodbye
                    Ok(Message::Text(t)) if c.role.is_none() && t.contains("\"show-app\"") => {
                        let tab = serde_json::from_str::<Value>(&t).ok().and_then(|v| v.get("tab").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
                        crate::app::open(Some(match tab.as_str() { "install" => crate::app::Tab::Install, "uninstall" => { crate::app::ask_uninstall(); crate::app::Tab::Install } _ => crate::app::Tab::Overview }));
                        c.alive = false;
                        c.role = None;
                        break;
                    }
                    Ok(Message::Text(t)) => match route(c.role, &t) {
                        Routed::Join(role) => {
                            c.role = Some(role);
                            joined.push((i, role));
                        }
                        Routed::Forward { to, text } => {
                            if c.role.is_none() {
                                c.role = Some(Role::Photoshop);
                                joined.push((i, Role::Photoshop));
                            }
                            forwards.push((i, to, text));
                        }
                        Routed::Other => {
                            if c.role.is_none() {
                                c.role = Some(Role::Photoshop);
                                joined.push((i, Role::Photoshop));
                            }
                            if c.role == Some(Role::Photoshop) {
                                if let Some(cmd) = protocol::parse(&t) { on_command(cmd); }
                            }
                        }
                    },
                    Ok(Message::Close(_)) => { c.alive = false; break; }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(_) => { c.alive = false; break; }
                }
            }
        }
        // a client that joined replaces an older one in the same role (the panel was reloaded)
        for (i, role) in joined {
            for (j, other) in clients.iter_mut().enumerate() {
                if j != i && other.role == Some(role) && other.alive {
                    other.alive = false;
                    other.role = None; // replaced: its going is not "Photoshop went away"
                }
            }
            if role == Role::Photoshop {
                if let Ok(mut q) = OUTBOX.lock() { q.clear(); }
            }
            let there = clients.iter().any(|c| c.role == Some(role.other()) && c.alive);
            clients[i].put(peer_text(role.other(), there));
            let _ = deliver(&mut clients, role.other(), peer_text(role, true));
            crate::log::line(format!("client joined as {}", role.name()));
        }
        for (from, to, text) in forwards {
            if let Some(text) = deliver(&mut clients, to, text) {
                let back = missing(to, &text);
                clients[from].put(back);
            }
        }
        // the host's events go to Photoshop
        let pending: Vec<String> = OUTBOX.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
        if !pending.is_empty() {
            if let Some(ps) = clients.iter_mut().find(|c| c.role == Some(Role::Photoshop) && c.alive) {
                for t in pending { ps.put(t); }
            }
        }
        for c in clients.iter_mut() { c.flush(); }
        {
            use std::sync::atomic::Ordering::SeqCst;
            PS_ON.store(clients.iter().any(|c| c.alive && c.role == Some(Role::Photoshop)), SeqCst);
            AI_ON.store(clients.iter().any(|c| c.alive && c.role == Some(Role::Illustrator)), SeqCst);
        }
        // the ones gone: tell the other side, and the host when it was Photoshop
        let mut gone: Vec<Role> = Vec::new();
        clients.retain(|c| {
            if c.alive { return true; }
            if let Some(r) = c.role { gone.push(r); }
            false
        });
        for role in gone {
            crate::log::line(format!("client left: {}", role.name()));
            if !clients.iter().any(|c| c.role == Some(role)) {
                let _ = deliver(&mut clients, role.other(), peer_text(role, false));
                if role == Role::Photoshop { on_disconnect(); }
            }
        }
        thread::sleep(Duration::from_millis(15));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_not_looked_into() {
        assert_eq!(route(None, r#"{"type":"hello"}"#), Routed::Other);
        assert_eq!(route(Some(Role::Photoshop), r#"{"type":"state","panel":"generate","rev":1,"sections":{"prompt":"join"}}"#), Routed::Other);
    }

    #[test]
    fn join_names_the_client() {
        assert_eq!(route(None, r#"{"type":"join","role":"illustrator"}"#), Routed::Join(Role::Illustrator));
        assert_eq!(route(None, r#"{"type":"join","role":"indesign"}"#), Routed::Other);
    }

    #[test]
    fn bridge_goes_to_the_other_side_with_its_sender() {
        let r = route(Some(Role::Illustrator), r#"{"type":"bridge","to":"photoshop","msg":{"kind":"info","reqId":"r1"}}"#);
        let Routed::Forward { to, text } = r else { panic!("{r:?}") };
        assert_eq!(to, Role::Photoshop);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["from"], "illustrator");
        assert_eq!(v["msg"]["kind"], "info");
        // without `to`: the other side
        let Routed::Forward { to, .. } = route(Some(Role::Photoshop), r#"{"type":"bridge","msg":{}}"#) else { panic!() };
        assert_eq!(to, Role::Illustrator);
    }

    #[test]
    fn nobody_there_answers_with_the_request_id() {
        let fwd = r#"{"type":"bridge","from":"illustrator","msg":{"kind":"info","reqId":"r7"}}"#;
        let v: Value = serde_json::from_str(&missing(Role::Photoshop, fwd)).unwrap();
        assert_eq!(v["msg"]["kind"], "missing");
        assert_eq!(v["msg"]["reqId"], "r7");
        assert_eq!(v["msg"]["to"], "photoshop");
    }
}
