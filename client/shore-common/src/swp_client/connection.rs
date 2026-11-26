use futures_util::StreamExt as _;
use serde::Deserialize;
use tracing::{debug, trace, warn};

use crate::protocol::client_msg::ClientMessage;
use crate::protocol::server_msg::{History, ServerHello, ServerMessage};
use crate::protocol::web::{WebHello, WebTransfer};
use crate::protocol::{MAX_WIRE_MESSAGE_SIZE, SWP_V1};

use crate::swp_client::error::{ClientError, Result};
use crate::token::TokenSource;

const HELLO_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
const STREAM_TYPE: &str = "application/x-ndjson";
const UPLOAD_CHUNK: usize = 1_048_576;
pub const DEFAULT_WEB_PORT: u16 = 7340;

#[derive(Debug, Clone)]
pub struct ServerAddr(pub String);

impl ServerAddr {
    pub fn base_url(&self) -> String {
        let trimmed = self.0.trim().trim_end_matches('/');
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_owned()
        } else {
            format!("http://{trimmed}")
        }
    }

    pub fn origin(&self) -> String {
        let base = self.base_url();
        reqwest::Url::parse(&base).map_or(base, |url| url.origin().ascii_serialization())
    }
}

#[derive(Debug)]
struct FrameStream {
    response: reqwest::Response,
    pending: Vec<u8>,
    ended: bool,
    limit: usize,
}

fn utf8(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes)
        .map_err(|e| ClientError::Protocol(format!("server sent invalid UTF-8 framing: {e}")))
}

impl FrameStream {
    fn new(response: reqwest::Response) -> Self {
        Self::bounded(response, MAX_WIRE_MESSAGE_SIZE)
    }

    fn bounded(response: reqwest::Response, limit: usize) -> Self {
        Self {
            response,
            pending: Vec::new(),
            ended: false,
            limit,
        }
    }

    async fn next_line(&mut self) -> Result<Option<String>> {
        loop {
            if let Some(at) = self.pending.iter().position(|&byte| byte == b'\n') {
                let text = utf8(self.pending.drain(..=at).collect())?;
                if text.trim().is_empty() {
                    continue;
                }
                return Ok(Some(text));
            }
            if self.ended {
                if self.pending.iter().all(u8::is_ascii_whitespace) {
                    return Ok(None);
                }
                return utf8(std::mem::take(&mut self.pending)).map(Some);
            }
            match self.response.chunk().await.map_err(transport)? {
                Some(bytes) => {
                    let total = self.pending.len().checked_add(bytes.len());
                    if total.is_none_or(|size| size > self.limit) {
                        return Err(ClientError::Protocol(format!(
                            "server message exceeds maximum size of {} bytes",
                            self.limit
                        )));
                    }
                    self.pending.extend_from_slice(&bytes);
                }
                None => self.ended = true,
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct Problem {
    code: String,
    message: String,
    #[serde(default)]
    retry_after_ms: Option<u64>,
}

fn transport(error: reqwest::Error) -> ClientError {
    if error.is_connect() {
        let place = error.url().map_or_else(String::new, |url| {
            format!("{} ", url.origin().ascii_serialization())
        });
        ClientError::Connect(format!(
            "nothing answered at {place}({error}). The CLI talks to the daemon's web listener, port {DEFAULT_WEB_PORT} unless changed; the old TCP port 7320 is gone"
        ))
    } else if error.is_timeout() {
        ClientError::Timeout {
            message: error.to_string(),
            retry_after_ms: None,
        }
    } else {
        ClientError::Connect(error.to_string())
    }
}

async fn refusal(response: reqwest::Response, origin: &str) -> ClientError {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let Ok(problem) = serde_json::from_str::<Problem>(&text) else {
        return ClientError::Refused(format!("the daemon answered HTTP {status}"));
    };
    match problem.code.as_str() {
        "unauthorized" => ClientError::Unauthorized(format!(
            "{}. Sign in with `shore sign-in {origin}`",
            problem.message.trim_end_matches('.')
        )),
        "provider_error" => ClientError::Provider {
            message: problem.message,
            retry_after_ms: problem.retry_after_ms,
        },
        "timeout" => ClientError::Timeout {
            message: problem.message,
            retry_after_ms: problem.retry_after_ms,
        },
        _ => ClientError::Refused(problem.message),
    }
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("shore/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| ClientError::Connect(e.to_string()))
}

fn version_of(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get("shore-version")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn selection(character: Option<&String>, thread: Option<&String>) -> Vec<(&'static str, String)> {
    let mut query = Vec::new();
    if let Some(name) = character.filter(|name| !name.is_empty()) {
        query.push(("character", name.clone()));
    }
    if let Some(name) = thread.filter(|name| !name.is_empty()) {
        query.push(("thread", name.clone()));
    }
    query
}

fn hello_deadline() -> ClientError {
    ClientError::Timeout {
        message: "the daemon did not answer in time".into(),
        retry_after_ms: None,
    }
}

#[derive(Debug)]
pub struct SWPConnection {
    http: reqwest::Client,
    base: String,
    origin: String,
    token: String,
    character: Option<String>,
    thread: Option<String>,
    request: Option<FrameStream>,
    events: Option<FrameStream>,
    last_command: Option<String>,
}

impl SWPConnection {
    pub async fn connect<T: Into<String>, N: Into<String>>(
        addr: &ServerAddr,
        client_type: T,
        client_name: N,
        character: Option<String>,
        token: &TokenSource,
    ) -> Result<(Self, ServerHello, History)> {
        Self::connect_in_thread(addr, client_type, client_name, character, None, token).await
    }

    pub async fn connect_in_thread<T: Into<String>, N: Into<String>>(
        addr: &ServerAddr,
        _client_type: T,
        _client_name: N,
        character: Option<String>,
        thread: Option<String>,
        token: &TokenSource,
    ) -> Result<(Self, ServerHello, History)> {
        let base = addr.base_url();
        let origin = addr.origin();
        let credential = token
            .resolve(&origin)
            .map_err(|e| ClientError::Unauthorized(e.to_string()))?;
        let http = http_client()?;
        debug!(base = %base, character = ?character, thread = ?thread, "asking the daemon who it serves");
        let asked = http
            .get(format!("{base}/api/hello"))
            .query(&selection(character.as_ref(), thread.as_ref()))
            .bearer_auth(&credential)
            .send();
        let response = tokio::time::timeout(HELLO_DEADLINE, asked)
            .await
            .map_err(|_| hello_deadline())?
            .map_err(transport)?;
        super::daemon_version::note_daemon_version(version_of(&response).as_deref());
        if !response.status().is_success() {
            return Err(refusal(response, &origin).await);
        }
        let hello: WebHello = response.json().await.map_err(|e| {
            ClientError::Protocol(format!("the daemon's hello could not be read: {e}"))
        })?;
        let history = History {
            delta: None,
            rid: None,
            messages: Vec::new(),
            previous_segment: None,
            config: serde_json::json!({}),
            selected_character: hello.selected_character.clone(),
            selected_thread: hello.selected_thread.clone(),
            revision: 0,
        };
        let server_hello = ServerHello {
            v: SWP_V1,
            server_name: hello.server_name,
            server_version: Some(hello.server_version),
            characters: hello.characters,
        };
        let conn = Self {
            http,
            base,
            origin,
            token: credential,
            character: hello.selected_character,
            thread: hello.selected_thread,
            request: None,
            events: None,
            last_command: None,
        };
        Ok((conn, server_hello, history))
    }

    pub async fn probe(addr: &ServerAddr, deadline: std::time::Duration) -> Result<ServerHello> {
        let base = addr.base_url();
        let asked = http_client()?.get(format!("{base}/api/hello")).send();
        let response = tokio::time::timeout(deadline, asked)
            .await
            .map_err(|_| hello_deadline())?
            .map_err(transport)?;
        let Some(version) = version_of(&response) else {
            return Err(ClientError::Protocol(format!(
                "something answered at {base}, but it isn't a Shore daemon"
            )));
        };
        super::daemon_version::note_daemon_version(Some(&version));
        Ok(ServerHello {
            v: SWP_V1,
            server_name: "shore-daemon".into(),
            server_version: Some(version),
            characters: Vec::new(),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub async fn hello(&self, character: Option<&str>, thread: Option<&str>) -> Result<WebHello> {
        let chosen = selection(
            character.map(str::to_owned).as_ref(),
            thread.map(str::to_owned).as_ref(),
        );
        let response = self
            .http
            .get(self.url("/api/hello"))
            .query(&chosen)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(transport)?;
        self.checked(response).await?.json().await.map_err(|e| {
            ClientError::Protocol(format!("the daemon's hello could not be read: {e}"))
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    async fn checked(&self, response: reqwest::Response) -> Result<reqwest::Response> {
        if response.status().is_success() {
            Ok(response)
        } else {
            Err(refusal(response, &self.origin).await)
        }
    }

    pub async fn send(&mut self, msg: &ClientMessage) -> Result<Option<String>> {
        let (name, body) = match msg {
            ClientMessage::Hello(_) => {
                return Err(ClientError::Protocol("a request can't be a hello".into()));
            }
            ClientMessage::Command(command) => (
                command.name.clone(),
                if command.args.is_null() {
                    serde_json::json!({})
                } else {
                    command.args.clone()
                },
            ),
            ClientMessage::Message(_) | ClientMessage::Regen(_) | ClientMessage::Cancel(_) => {
                let mut value = serde_json::to_value(msg).map_err(ClientError::Serialize)?;
                let kind = value
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if let Some(fields) = value.as_object_mut() {
                    _ = fields.remove("type");
                    _ = fields.remove("rid");
                }
                (kind, value)
            }
        };
        trace!(operation = %name, "sending request");
        let sent = self
            .http
            .post(self.url(&format!("/api/op/{name}")))
            .query(&selection(self.character.as_ref(), self.thread.as_ref()))
            .bearer_auth(&self.token)
            .header(reqwest::header::ACCEPT, STREAM_TYPE)
            .json(&body)
            .send()
            .await
            .map_err(transport)?;
        let response = self.checked(sent).await?;
        self.last_command = match msg {
            ClientMessage::Command(command) => Some(command.name.clone()),
            ClientMessage::Hello(_)
            | ClientMessage::Message(_)
            | ClientMessage::Regen(_)
            | ClientMessage::Cancel(_) => None,
        };
        let rid = response
            .headers()
            .get("shore-request")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        self.request = Some(FrameStream::new(response));
        Ok(rid)
    }

    pub async fn follow(&mut self) -> Result<()> {
        let response = self
            .http
            .get(self.url("/api/events"))
            .query(&selection(self.character.as_ref(), self.thread.as_ref()))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(transport)?;
        self.events = Some(FrameStream::new(self.checked(response).await?));
        Ok(())
    }

    pub fn matches_last_request(&self, response: &ServerMessage) -> bool {
        let ServerMessage::CommandOutput(output) = response else {
            return true;
        };
        self.last_command.as_deref() == Some(output.name.as_str())
    }

    pub async fn recv(&mut self) -> Result<ServerMessage> {
        let line = 'read: {
            if let Some(stream) = self.request.as_mut() {
                if let Some(line) = stream.next_line().await? {
                    break 'read line;
                }
                self.request = None;
            }
            let Some(stream) = self.events.as_mut() else {
                return Err(ClientError::Disconnected);
            };
            if let Some(line) = stream.next_line().await? {
                break 'read line;
            }
            self.events = None;
            return Err(ClientError::Disconnected);
        };
        let msg: ServerMessage = serde_json::from_str(line.trim()).map_err(|e| {
            warn!(error = %e, raw_len = line.len(), "failed to deserialize server message");
            ClientError::Deserialize(e)
        })?;
        trace!(bytes = line.len(), "received message");
        Ok(msg)
    }

    pub async fn send_message_with_images<T: Into<String>>(
        &mut self,
        text: T,
        stream: bool,
        images: Vec<String>,
    ) -> Result<Option<String>> {
        use crate::protocol::client_msg::ClientMessageBody;

        let image_data = images
            .iter()
            .map(|path| read_image_upload(path))
            .collect::<Result<Vec<_>>>()?;

        let msg = ClientMessage::Message(ClientMessageBody {
            rid: None,
            text: text.into(),
            stream,
            images,
            image_data,
            absence_seconds: None,
        });
        self.send(&msg).await
    }

    pub async fn send_regen(
        &mut self,
        stream: bool,
        another_take: bool,
        reason: Option<String>,
        tags: Vec<String>,
    ) -> Result<Option<String>> {
        use crate::protocol::client_msg::Regen;
        let msg = ClientMessage::Regen(Regen {
            rid: None,
            stream,
            another_take,
            reason,
            tags,
        });
        self.send(&msg).await
    }

    pub async fn send_operation<O: crate::protocol::operations::Operation>(
        &mut self,
        input: O::Input,
    ) -> Result<Option<String>> {
        let command = O::command(input, None).map_err(ClientError::Serialize)?;
        self.send(&ClientMessage::Command(command)).await
    }

    pub async fn send_command<N: Into<String>>(
        &mut self,
        name: N,
        args: serde_json::Value,
    ) -> Result<Option<String>> {
        use crate::protocol::client_msg::Command;
        let msg = ClientMessage::Command(Command {
            rid: None,
            name: name.into(),
            args,
        });
        self.send(&msg).await
    }

    pub async fn post_web<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<Option<T>> {
        let sent = self
            .http
            .post(self.url(path))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(transport)?;
        let response = self.checked(sent).await?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        response.json().await.map(Some).map_err(|e| {
            ClientError::Protocol(format!(
                "the daemon's answer to {path} could not be read: {e}"
            ))
        })
    }

    pub async fn upload<R: std::io::Read + Send + 'static>(
        &self,
        mut source: R,
        mut progress: Box<dyn FnMut(usize) + Send>,
    ) -> Result<WebTransfer> {
        let chunks = futures_util::stream::unfold(Some(0_usize), move |state| {
            let mut buffer = vec![0_u8; UPLOAD_CHUNK];
            let next = state.and_then(|sent| match source.read(&mut buffer) {
                Ok(0) => None,
                Ok(read) => {
                    buffer.truncate(read);
                    let total = sent.saturating_add(read);
                    progress(total);
                    Some((Ok::<_, std::io::Error>(buffer), Some(total)))
                }
                Err(error) => Some((Err(error), None)),
            });
            std::future::ready(next)
        });
        let response = self
            .http
            .post(self.url("/api/transfers"))
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(reqwest::Body::wrap_stream(chunks))
            .send()
            .await
            .map_err(transport)?;
        self.checked(response).await?.json().await.map_err(|e| {
            ClientError::Protocol(format!(
                "the daemon's answer to an upload could not be read: {e}"
            ))
        })
    }

    pub async fn download<W: std::io::Write, F: FnMut(usize)>(
        &self,
        transfer: &str,
        target: &mut W,
        mut progress: F,
    ) -> Result<usize> {
        let response = self
            .http
            .get(self.url(&format!("/api/transfers/{transfer}")))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(transport)?;
        let mut body = self.checked(response).await?.bytes_stream();
        let mut received = 0_usize;
        while let Some(chunk) = body.next().await {
            let bytes = chunk.map_err(transport)?;
            target.write_all(&bytes).map_err(ClientError::Io)?;
            received = received.saturating_add(bytes.len());
            progress(received);
        }
        Ok(received)
    }
}

pub fn read_image_upload(path: &str) -> Result<crate::protocol::client_msg::ImageUpload> {
    use base64::Engine;

    let bytes = std::fs::read(path).map_err(|source| ClientError::AttachmentRead {
        path: path.to_owned(),
        source,
    })?;
    let filename = std::path::Path::new(path).file_name().map_or_else(
        || "image".to_owned(),
        |file| file.to_string_lossy().into_owned(),
    );
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(crate::protocol::client_msg::ImageUpload {
        filename,
        data,
        mime_type: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, chunks: Vec<&'static str>) -> reqwest::Response {
        let body = reqwest::Body::wrap_stream(futures_util::stream::iter(
            chunks
                .into_iter()
                .map(|chunk| Ok::<_, std::io::Error>(chunk.as_bytes().to_vec())),
        ));
        reqwest::Response::from(http::Response::builder().status(status).body(body).unwrap())
    }

    #[test]
    fn an_address_without_a_scheme_means_http_and_its_origin_drops_a_default_port() {
        let base = |given: &str| ServerAddr(given.into()).base_url();
        let origin = |given: &str| ServerAddr(given.into()).origin();
        assert_eq!(base(" desk:7340/ "), "http://desk:7340", "bare means http");
        assert_eq!(
            base("https://shore.example/"),
            "https://shore.example",
            "https stays"
        );
        assert_eq!(base("http://desk"), "http://desk", "http stays");
        assert_eq!(
            origin("https://shore.example:443/"),
            "https://shore.example",
            "default port"
        );
        assert_eq!(origin("desk:7340"), "http://desk:7340", "other ports stay");
        assert_eq!(
            origin("http://[::"),
            "http://[::",
            "an unparsable address is kept as given"
        );
    }

    #[tokio::test]
    async fn lines_are_read_across_chunks_blank_ones_skipped_and_an_unterminated_last_one_kept() {
        let mut frames = FrameStream::bounded(
            response(200, vec!["{\"a\"", ":1}\n\n  \n{\"b\":2}\n", "{\"c\":3}"]),
            64,
        );
        assert_eq!(
            frames.next_line().await.unwrap().as_deref(),
            Some("{\"a\":1}\n"),
            "joined"
        );
        assert_eq!(
            frames.next_line().await.unwrap().as_deref(),
            Some("{\"b\":2}\n"),
            "blank lines skipped"
        );
        assert_eq!(
            frames.next_line().await.unwrap().as_deref(),
            Some("{\"c\":3}"),
            "kept"
        );
        assert!(frames.next_line().await.unwrap().is_none(), "then the end");
        let mut trailing = FrameStream::bounded(response(200, vec!["{}\n", "  \n "]), 64);
        assert!(trailing.next_line().await.unwrap().is_some(), "a line");
        assert!(
            trailing.next_line().await.unwrap().is_none(),
            "white space at the end is nothing"
        );
    }

    #[tokio::test]
    async fn a_line_exactly_at_the_size_limit_is_read_and_one_byte_more_is_refused() {
        let mut fits = FrameStream::bounded(response(200, vec!["12345\n"]), 6);
        assert_eq!(
            fits.next_line().await.unwrap().as_deref(),
            Some("12345\n"),
            "at the limit"
        );
        let mut over = FrameStream::bounded(response(200, vec!["123456\n"]), 6);
        let refused = over.next_line().await.unwrap_err().to_string();
        assert!(refused.contains("maximum size of 6 bytes"), "{refused}");
        let mut broken = FrameStream::bounded(
            reqwest::Response::from(http::Response::new(reqwest::Body::from(vec![
                0xff_u8, b'\n',
            ]))),
            6,
        );
        assert!(
            broken
                .next_line()
                .await
                .unwrap_err()
                .to_string()
                .contains("invalid UTF-8"),
            "bytes that aren't UTF-8 are refused"
        );
    }

    #[tokio::test]
    async fn a_refusal_becomes_the_error_its_code_names() {
        let refused = |status, body| refusal(response(status, vec![body]), "https://shore.example");
        let unauthorized =
            refused(401, r#"{"code":"unauthorized","message":"Not signed in."}"#).await;
        assert_eq!(
            unauthorized.to_string(),
            "Not signed in. Sign in with `shore sign-in https://shore.example`",
            "says how to sign in"
        );
        let provider = refused(
            502,
            r#"{"code":"provider_error","message":"down","retry_after_ms":5}"#,
        )
        .await;
        assert!(
            matches!(provider, ClientError::Provider { ref message, retry_after_ms: Some(5) } if message == "down"),
            "{provider:?}"
        );
        let timeout = refused(
            504,
            r#"{"code":"timeout","message":"slow","retry_after_ms":7}"#,
        )
        .await;
        assert!(
            matches!(timeout, ClientError::Timeout { ref message, retry_after_ms: Some(7) } if message == "slow"),
            "{timeout:?}"
        );
        let other = refused(404, r#"{"code":"not_found","message":"No thread named x"}"#).await;
        assert!(
            matches!(other, ClientError::Refused(ref message) if message == "No thread named x"),
            "{other:?}"
        );
        let garbled = refused(502, "<html>").await;
        assert_eq!(
            garbled.to_string(),
            "the daemon answered HTTP 502 Bad Gateway",
            "not JSON"
        );
    }

    #[test]
    fn a_selection_names_only_the_character_and_thread_that_are_given() {
        let name = |text: &str| Some(text.to_owned());
        assert_eq!(
            selection(name("ada").as_ref(), name("garden").as_ref()),
            [
                ("character", "ada".to_owned()),
                ("thread", "garden".to_owned())
            ],
            "both"
        );
        assert_eq!(
            selection(name("").as_ref(), name("garden").as_ref()),
            [("thread", "garden".to_owned())],
            "an empty character is none"
        );
        assert_eq!(
            selection(name("ada").as_ref(), name("").as_ref()),
            [("character", "ada".to_owned())],
            "an empty thread is none"
        );
        assert!(selection(None, None).is_empty(), "nothing");
    }

    #[test]
    fn only_the_output_of_the_command_last_sent_is_taken_as_its_answer() {
        let conn = SWPConnection {
            http: http_client().unwrap(),
            base: "http://desk:7340".into(),
            origin: "http://desk:7340".into(),
            token: "t".into(),
            character: None,
            thread: None,
            request: None,
            events: None,
            last_command: Some("status".into()),
        };
        let output = |name: &str| {
            ServerMessage::CommandOutput(crate::protocol::server_msg::CommandOutput {
                rid: None,
                name: name.into(),
                data: serde_json::Value::Null,
            })
        };
        assert!(conn.matches_last_request(&output("status")), "its own");
        assert!(
            !conn.matches_last_request(&output("log")),
            "another command's"
        );
        assert!(
            conn.matches_last_request(&ServerMessage::Unknown),
            "every other frame"
        );
        assert_eq!(conn.origin(), "http://desk:7340", "its origin");
        assert_eq!(
            conn.url("/api/hello"),
            "http://desk:7340/api/hello",
            "its urls"
        );
    }
}
