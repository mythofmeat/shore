#![allow(dead_code, reason = "each test binary uses only some of these helpers")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

pub(crate) type Answer = dyn Fn(&Value, &Value) -> Vec<Value> + Send + Sync;

pub(crate) struct StandIn {
    pub(crate) addr: String,
    pub(crate) requests: Arc<AtomicUsize>,
    pub(crate) received: Arc<Mutex<Vec<Value>>>,
}

struct Asked {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    token: Option<String>,
    raw: Vec<u8>,
    body: Value,
}

fn read_request(stream: &TcpStream) -> Option<Asked> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut words = line.split_whitespace();
    let method = words.next()?.to_owned();
    let target = words.next()?.to_owned();
    let mut length = 0_usize;
    let mut chunked = false;
    let mut token = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let trimmed = header.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let (name, value) = trimmed.split_once(':')?;
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().ok()?,
            "transfer-encoding" => chunked = value.trim().eq_ignore_ascii_case("chunked"),
            "authorization" => {
                token = value.trim().strip_prefix("Bearer ").map(str::to_owned);
            }
            _ => {}
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size = String::new();
            let _read = reader.read_line(&mut size).ok()?;
            let count = usize::from_str_radix(size.trim(), 16).ok()?;
            let mut piece = vec![0_u8; count];
            reader.read_exact(&mut piece).ok()?;
            body.extend_from_slice(&piece);
            let mut end = String::new();
            let _crlf = reader.read_line(&mut end).ok()?;
            if count == 0 {
                break;
            }
        }
    } else {
        body.resize(length, 0);
        reader.read_exact(&mut body).ok()?;
    }
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let pairs = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (key.to_owned(), decoded(value)))
        .collect();
    Some(Asked {
        method,
        path: path.to_owned(),
        query: pairs,
        token,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
        raw: body,
    })
}

fn decoded(value: &str) -> String {
    let mut out = Vec::new();
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        match byte {
            b'%' => {
                let hex: String = bytes.by_ref().take(2).map(char::from).collect();
                out.push(u8::from_str_radix(&hex, 16).unwrap_or(b'?'));
            }
            b'+' => out.push(b' '),
            other => out.push(other),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(mut stream: &TcpStream, status: &str, kind: &str, version: Option<&str>, body: &str) {
    let reported = version.map_or_else(String::new, |given| format!("shore-version: {given}\r\n"));
    let _sent = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\n{reported}connection: close\r\n\r\n{body}",
        body.len()
    );
    let _flushed = stream.flush();
}

fn serve(
    stream: &TcpStream,
    characters: &[&str],
    version: Option<&str>,
    answer: &Answer,
    received: &Mutex<Vec<Value>>,
) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let Some(asked) = read_request(stream) else {
        return;
    };
    let chosen = |key: &str| {
        asked
            .query
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    let mut hello = json!({ "type": "hello", "client_type": "cli", "token": asked.token });
    if let (Some(fields), Some(character)) = (hello.as_object_mut(), chosen("character")) {
        let _set = fields.insert("character".to_owned(), json!(character));
    }
    if let (Some(fields), Some(thread)) = (hello.as_object_mut(), chosen("thread")) {
        let _set = fields.insert("thread".to_owned(), json!(thread));
    }
    if asked.method == "GET" && asked.path == "/api/hello" {
        received.lock().unwrap().push(hello.clone());
        let replies = answer(&hello, &hello);
        if let Some(refusal) = replies.iter().find(|frame| frame["type"] == "error") {
            let problem = json!({ "code": refusal["code"], "message": refusal["message"] });
            respond(
                stream,
                "401 Unauthorized",
                "application/json",
                version,
                &problem.to_string(),
            );
            return;
        }
        let history = replies
            .into_iter()
            .find(|frame| frame["type"] == "history")
            .unwrap_or_else(
                || json!({ "selected_character": characters.first(), "selected_thread": "main" }),
            );
        let body = json!({
            "server_name": "test", "server_version": version.unwrap_or("0.0.0"),
            "characters": characters.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
            "selected_character": history.get("selected_character"), "selected_thread": history.get("selected_thread"),
        });
        respond(
            stream,
            "200 OK",
            "application/json",
            version,
            &body.to_string(),
        );
        return;
    }
    let frame = if asked.path == "/api/events" {
        json!({ "type": "follow" })
    } else if let Some(name) = asked.path.strip_prefix("/api/op/") {
        match name {
            "message" | "regen" | "cancel" => {
                let mut request = asked.body.clone();
                if let Some(fields) = request.as_object_mut() {
                    let _kind = fields.insert("type".to_owned(), json!(name));
                    let _rid = fields.insert("rid".to_owned(), json!("r1"));
                }
                request
            }
            _ => json!({ "type": "command", "name": name, "args": asked.body, "rid": "r1" }),
        }
    } else {
        let frame = json!({
            "type": "web", "method": asked.method, "path": asked.path, "body": asked.body,
            "content": String::from_utf8_lossy(&asked.raw), "token": asked.token,
        });
        received.lock().unwrap().push(frame.clone());
        let replies = answer(&hello, &frame);
        let Some(reply) = replies.first() else {
            respond(stream, "204 No Content", "application/json", version, "");
            return;
        };
        let status = reply.get("status").and_then(Value::as_u64).unwrap_or(200);
        let text = reply.get("raw").and_then(Value::as_str).map_or_else(
            || {
                reply
                    .get("body")
                    .cloned()
                    .unwrap_or(Value::Null)
                    .to_string()
            },
            str::to_owned,
        );
        respond(
            stream,
            &format!("{status} Answered"),
            "application/json",
            version,
            &text,
        );
        return;
    };
    let mut recorded = frame;
    if let Some(fields) = recorded.as_object_mut() {
        let _raw = fields.insert(
            "sent".to_owned(),
            json!(String::from_utf8_lossy(&asked.raw)),
        );
    }
    received.lock().unwrap().push(recorded.clone());
    let mut lines: String = answer(&hello, &recorded)
        .iter()
        .map(|reply| format!("{reply}\n"))
        .collect();
    if recorded.get("type").and_then(Value::as_str) != Some("follow") {
        lines.push_str(&format!(
            "{}\n",
            json!({ "type": "request_finished", "rid": "r1", "outcome": "completed" })
        ));
    }
    respond(stream, "200 OK", "application/x-ndjson", version, &lines);
}

impl StandIn {
    pub(crate) fn start(
        characters: &'static [&'static str],
        version: Option<&'static str>,
        answering: impl Fn(&Value, &Value) -> Vec<Value> + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let requests = Arc::new(AtomicUsize::new(0));
        let received = Arc::new(Mutex::new(Vec::new()));
        let answer: Arc<Answer> = Arc::new(answering);
        let counted = Arc::clone(&requests);
        let recorded = Arc::clone(&received);
        let _server = std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(stream) = incoming else { return };
                let _previous = counted.fetch_add(1, Ordering::SeqCst);
                let replies = Arc::clone(&answer);
                let log = Arc::clone(&recorded);
                let _worker = std::thread::spawn(move || {
                    serve(&stream, characters, version, replies.as_ref(), &log);
                });
            }
        });
        Self {
            addr,
            requests,
            received,
        }
    }

    pub(crate) fn commands(&self, name: &str) -> Vec<Value> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.get("name").and_then(Value::as_str) == Some(name))
            .cloned()
            .collect()
    }

    pub(crate) fn frames(&self) -> Vec<Value> {
        self.received.lock().unwrap().clone()
    }
}

pub(crate) fn origin_of(addr: &str) -> String {
    let bare = addr.trim_end_matches('/');
    if bare.contains("://") {
        bare.to_owned()
    } else {
        format!("http://{bare}")
    }
}

pub(crate) fn shore_in(home: &std::path::Path, addr: &str) -> Command {
    std::fs::create_dir_all(home.join("config")).unwrap();
    std::fs::write(
        home.join("config").join("sign-ins.toml"),
        format!("{:?} = \"test-token\"\n", origin_of(addr)),
    )
    .unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_shore"));
    let _isolated = command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("TZ", "UTC")
        .env("SHORE_CONFIG_DIR", home.join("config"))
        .env("SHORE_DATA_DIR", home.join("data"))
        .env("SHORE_RUNTIME_DIR", home.join("runtime"))
        .env("SHORE_CACHE_DIR", home.join("cache"))
        .args(["--addr", addr]);
    command
}

pub(crate) fn asked(data: Value, args: &[&str]) -> (Output, Vec<Value>) {
    asked_of(None, data, args)
}

pub(crate) fn asked_of(
    version: Option<&'static str>,
    data: Value,
    args: &[&str],
) -> (Output, Vec<Value>) {
    let daemon = StandIn::start(&["ada"], version, move |_, frame| {
        if frame["type"] == "hello" {
            return vec![
                json!({ "type": "history", "selected_character": "ada", "selected_thread": "main" }),
            ];
        }
        vec![
            json!({ "type": "command_output", "name": frame["name"], "rid": frame["rid"], "data": data }),
        ]
    });
    let home = tempfile::tempdir().unwrap();
    let output = shore_in(home.path(), &daemon.addr)
        .args(args)
        .output()
        .unwrap();
    let frames = daemon
        .frames()
        .into_iter()
        .filter(|frame| frame["type"] != "hello")
        .collect();
    (output, frames)
}

pub(crate) fn at<'value>(value: &'value Value, path: &[&str]) -> &'value Value {
    path.iter()
        .try_fold(value, |inner, key| inner.get(*key))
        .unwrap_or(&Value::Null)
}

pub(crate) fn nth(values: &[Value], index: usize) -> &Value {
    values.get(index).unwrap_or(&Value::Null)
}

pub(crate) fn printed(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

pub(crate) fn sent(frames: &[Value]) -> Vec<(Option<&str>, Option<&Value>)> {
    frames
        .iter()
        .map(|frame| (frame.get("name").and_then(Value::as_str), frame.get("args")))
        .collect()
}
