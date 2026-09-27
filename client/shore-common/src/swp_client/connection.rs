use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpStream;
use tracing::{debug, error, trace, warn};

use crate::protocol::client_msg::{ClientHello, ClientMessage};
use crate::protocol::error::ErrorCode;
use crate::protocol::server_msg::{Error as ServerError, History, ServerHello, ServerMessage};
use crate::protocol::{MAX_WIRE_MESSAGE_SIZE, SWP_V1};

use crate::swp_client::error::{ClientError, Result};
use crate::token::TokenSource;

const HANDSHAKE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct ServerAddr(pub String);

trait AsyncReadWrite: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin> AsyncReadWrite for T {}

pub struct SWPConnection {
    reader: BufReader<Box<dyn AsyncReadWrite>>,
    read_pending: Vec<u8>,
    last_request: Option<(Option<String>, Option<String>)>,
    writer: BufWriter<Box<dyn AsyncReadWrite>>,
}

impl std::fmt::Debug for SWPConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SWPConnection").finish_non_exhaustive()
    }
}

impl SWPConnection {
    async fn open(addr: &ServerAddr) -> Result<Self> {
        debug!(addr = %addr.0, "connecting via tcp");
        let stream = TcpStream::connect(&addr.0).await.map_err(|e| {
            error!(addr = %addr.0, error = %e, "tcp connect failed");
            ClientError::Connect(format!("tcp:{}: {e}", addr.0))
        })?;
        let (r, w) = stream.into_split();
        debug!(addr = %addr.0, "tcp connected");
        Ok(Self {
            reader: BufReader::new(Box::new(tokio::io::join(r, tokio::io::sink()))),
            read_pending: Vec::new(),
            last_request: None,
            writer: BufWriter::new(Box::new(tokio::io::join(tokio::io::empty(), w))),
        })
    }

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
        client_type: T,
        client_name: N,
        character: Option<String>,
        thread: Option<String>,
        token: &TokenSource,
    ) -> Result<(Self, ServerHello, History)> {
        tokio::time::timeout(HANDSHAKE_DEADLINE, async {
            let mut conn = Self::open(addr).await?;
            let (server_hello, history) = conn
                .do_handshake(
                    client_type.into(),
                    client_name.into(),
                    character,
                    thread,
                    token.resolve(Some(&addr.0)),
                )
                .await?;
            Ok((conn, server_hello, history))
        })
        .await
        .map_err(|_| ClientError::Timeout {
            message: "connection handshake timed out".into(),
            retry_after_ms: None,
        })?
    }

    async fn do_handshake(
        &mut self,
        client_type: String,
        client_name: String,
        character: Option<String>,
        thread: Option<String>,
        token_lookup: std::result::Result<String, crate::token::TokenError>,
    ) -> Result<(ServerHello, History)> {
        debug!(client_type = %client_type, client_name = %client_name, character = ?character, thread = ?thread, "starting SWP handshake");

        let token = token_lookup.map_err(|e| ClientError::Unauthorized(e.to_string()))?;

        let server_hello = self.recv_server_hello().await?;

        let hello = ClientMessage::Hello(ClientHello {
            client_type,
            client_name,
            capabilities: vec![
                "streaming".into(),
                "history-deltas".into(),
                "multimodal-tool-results".into(),
            ],
            character,
            thread,
            token: Some(token),
        });
        self.send(&hello).await?;
        debug!("sent client hello");

        let history = self.recv_history().await?;

        debug!("SWP handshake complete");
        Ok((server_hello, history))
    }

    async fn recv_server_hello(&mut self) -> Result<ServerHello> {
        let server_hello = loop {
            match self.recv().await? {
                ServerMessage::Hello(h) => {
                    if h.v != SWP_V1 {
                        error!(
                            server_version = h.v,
                            expected = SWP_V1,
                            "protocol version mismatch"
                        );
                        return Err(ClientError::Protocol(format!(
                            "unsupported protocol version: {} (expected {})",
                            h.v, SWP_V1
                        )));
                    }
                    debug!(
                        server_name = %h.server_name,
                        characters = h.characters.len(),
                        "received server hello"
                    );
                    break h;
                }
                ServerMessage::Unknown => {
                    debug!("skipping unknown frame during handshake");
                }
                other @ (ServerMessage::History(_)
                | ServerMessage::Shutdown(_)
                | ServerMessage::Ping(_)
                | ServerMessage::CommandOutput(_)
                | ServerMessage::Error(_)
                | ServerMessage::StreamStart(_)
                | ServerMessage::StreamChunk(_)
                | ServerMessage::StreamEnd(_)
                | ServerMessage::Phase(_)
                | ServerMessage::NewMessage(_)
                | ServerMessage::ToolCall(_)
                | ServerMessage::ToolResult(_)
                | ServerMessage::SendImage(_)
                | ServerMessage::CacheWarning(_)
                | ServerMessage::ProviderWarning(_)
                | ServerMessage::ProviderFallbackWarning(_)
                | ServerMessage::UsageWarning(_)
                | ServerMessage::PlanLimitWarning(_)
                | ServerMessage::ConfigWarning(_)
                | ServerMessage::RequestFinished(_)) => {
                    error!("expected server hello, got unexpected message");
                    return Err(ClientError::Protocol(format!(
                        "expected server hello, got: {other:?}"
                    )));
                }
            }
        };
        Ok(server_hello)
    }

    async fn recv_history(&mut self) -> Result<History> {
        let history = loop {
            match self.recv().await? {
                ServerMessage::History(h) => {
                    debug!(message_count = h.messages.len(), "received history");
                    break h;
                }
                ServerMessage::Unknown => {
                    debug!("skipping unknown frame during handshake");
                }
                ServerMessage::Error(e) => {
                    error!(code = ?e.code, "daemon refused the handshake");
                    return Err(client_error_from_server(e));
                }
                other @ (ServerMessage::Hello(_)
                | ServerMessage::Shutdown(_)
                | ServerMessage::Ping(_)
                | ServerMessage::CommandOutput(_)
                | ServerMessage::StreamStart(_)
                | ServerMessage::StreamChunk(_)
                | ServerMessage::StreamEnd(_)
                | ServerMessage::Phase(_)
                | ServerMessage::NewMessage(_)
                | ServerMessage::ToolCall(_)
                | ServerMessage::ToolResult(_)
                | ServerMessage::SendImage(_)
                | ServerMessage::CacheWarning(_)
                | ServerMessage::ProviderWarning(_)
                | ServerMessage::ProviderFallbackWarning(_)
                | ServerMessage::UsageWarning(_)
                | ServerMessage::PlanLimitWarning(_)
                | ServerMessage::ConfigWarning(_)
                | ServerMessage::RequestFinished(_)) => {
                    error!("expected history, got unexpected message");
                    return Err(ClientError::Protocol(format!(
                        "expected history, got: {other:?}"
                    )));
                }
            }
        };
        Ok(history)
    }

    pub async fn send(&mut self, msg: &ClientMessage) -> Result<()> {
        let line = serde_json::to_string(msg).map_err(|e| {
            error!(error = %e, "failed to serialize client message");
            ClientError::Serialize(e)
        })?;
        trace!(bytes = line.len(), "sending message");
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            self.writer
                .write_all(line.as_bytes())
                .await
                .map_err(ClientError::Io)?;
            self.writer
                .write_all(b"\n")
                .await
                .map_err(ClientError::Io)?;
            self.writer.flush().await.map_err(ClientError::Io)?;
            Ok::<(), ClientError>(())
        })
        .await
        .map_err(|_| ClientError::Timeout {
            message: "connection write timed out".into(),
            retry_after_ms: None,
        })??;
        match msg {
            ClientMessage::Command(command) => {
                self.last_request = Some((command.rid.clone(), Some(command.name.clone())));
            }
            ClientMessage::Message(message) => {
                self.last_request = Some((message.rid.clone(), None))
            }
            ClientMessage::Regen(regen) => self.last_request = Some((regen.rid.clone(), None)),
            ClientMessage::Hello(_) | ClientMessage::Cancel(_) => {}
        }
        Ok(())
    }

    pub fn matches_last_request(&self, response: &ServerMessage) -> bool {
        let Some((rid, name)) = &self.last_request else {
            return response.request_id().is_none();
        };
        if rid.as_deref() != response.request_id() {
            return false;
        }
        if let ServerMessage::CommandOutput(output) = response {
            return name.as_deref() == Some(output.name.as_str());
        }
        true
    }

    pub async fn recv(&mut self) -> Result<ServerMessage> {
        let line = read_json_line_bounded(&mut self.reader, &mut self.read_pending).await?;
        let msg: ServerMessage = serde_json::from_str(line.trim()).map_err(|e| {
            warn!(error = %e, raw_len = line.len(), "failed to deserialize server message");
            ClientError::Deserialize(e)
        })?;
        trace!(bytes = line.len(), "received message");
        Ok(msg)
    }

    pub async fn send_message<T: Into<String>>(
        &mut self,
        text: T,
        stream: bool,
    ) -> Result<Option<String>> {
        self.send_message_with_images(text, stream, vec![]).await
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

        let rid = Some(request_id());
        let msg = ClientMessage::Message(ClientMessageBody {
            rid: rid.clone(),
            text: text.into(),
            stream,
            images,
            image_data,
            absence_seconds: None,
        });
        self.send(&msg).await?;
        Ok(rid)
    }

    pub async fn send_regen(
        &mut self,
        stream: bool,
        guidance: Option<String>,
    ) -> Result<Option<String>> {
        use crate::protocol::client_msg::Regen;
        let rid = Some(request_id());
        let msg = ClientMessage::Regen(Regen {
            rid: rid.clone(),
            stream,
            guidance,
        });
        self.send(&msg).await?;
        Ok(rid)
    }

    pub async fn send_operation<O: crate::protocol::operations::Operation>(
        &mut self,
        input: O::Input,
    ) -> Result<Option<String>> {
        let rid = Some(request_id());
        let command = O::command(input, rid.clone()).map_err(ClientError::Serialize)?;
        self.send(&ClientMessage::Command(command)).await?;
        Ok(rid)
    }

    pub async fn send_command<N: Into<String>>(
        &mut self,
        name: N,
        args: serde_json::Value,
    ) -> Result<Option<String>> {
        use crate::protocol::client_msg::Command;
        let rid = Some(request_id());
        let msg = ClientMessage::Command(Command {
            rid: rid.clone(),
            name: name.into(),
            args,
        });
        self.send(&msg).await?;
        Ok(rid)
    }
}

fn client_error_from_server(error: ServerError) -> ClientError {
    match error.code {
        ErrorCode::Unauthorized => ClientError::Unauthorized(error.message),
        ErrorCode::ProviderError => ClientError::Provider {
            message: error.message,
            retry_after_ms: error.retry_after_ms,
        },
        ErrorCode::Timeout => ClientError::Timeout {
            message: error.message,
            retry_after_ms: error.retry_after_ms,
        },
        ErrorCode::ProtocolError
        | ErrorCode::InvalidRequest
        | ErrorCode::NotFound
        | ErrorCode::Busy
        | ErrorCode::InternalError => ClientError::Protocol(error.message),
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

impl SWPConnection {
    pub fn from_raw_stream<S>(stream: S) -> Self
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let (r, w) = tokio::io::split(stream);
        Self {
            reader: BufReader::new(Box::new(tokio::io::join(r, tokio::io::sink()))),
            read_pending: Vec::new(),
            last_request: None,
            writer: BufWriter::new(Box::new(tokio::io::join(tokio::io::empty(), w))),
        }
    }

    pub async fn connect_raw<S, T: Into<String>, N: Into<String>>(
        stream: S,
        client_type: T,
        client_name: N,
        character: Option<String>,
        token: &TokenSource,
    ) -> Result<(Self, ServerHello, History)>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let mut conn = Self::from_raw_stream(stream);
        let (server_hello, history) = conn
            .do_handshake(
                client_type.into(),
                client_name.into(),
                character,
                None,
                token.resolve(None),
            )
            .await?;
        Ok((conn, server_hello, history))
    }
}

async fn read_json_line_bounded<R>(
    reader: &mut BufReader<R>,
    pending: &mut Vec<u8>,
) -> Result<String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    loop {
        let buf = reader.fill_buf().await.map_err(ClientError::Io)?;
        if buf.is_empty() {
            if pending.is_empty() {
                debug!("EOF on connection — disconnected");
                return Err(ClientError::Disconnected);
            }
            break;
        }

        let (consume, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(pos) => match pos.checked_add(1) {
                Some(consume) => (consume, true),
                None => {
                    return Err(ClientError::Protocol(
                        "server message length exceeds addressable memory".into(),
                    ));
                }
            },
            None => (buf.len(), false),
        };

        let Some(total_len) = pending.len().checked_add(consume) else {
            return Err(ClientError::Protocol(format!(
                "server message exceeds maximum size of {MAX_WIRE_MESSAGE_SIZE} bytes"
            )));
        };

        if total_len > MAX_WIRE_MESSAGE_SIZE {
            return Err(ClientError::Protocol(format!(
                "server message exceeds maximum size of {MAX_WIRE_MESSAGE_SIZE} bytes"
            )));
        }

        let Some(chunk) = buf.get(..consume) else {
            return Err(ClientError::Protocol(
                "server message framing exceeded read buffer".into(),
            ));
        };
        pending.extend_from_slice(chunk);
        reader.consume(consume);
        if done {
            break;
        }
    }

    String::from_utf8(std::mem::take(pending))
        .map_err(|e| ClientError::Protocol(format!("server sent invalid UTF-8 framing: {e}")))
}

pub fn request_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("rid_{nanos:016x}_{seq:04x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::{Duration, timeout};

    #[test]
    fn provider_and_timeout_frames_keep_their_semantics() {
        let provider = client_error_from_server(ServerError {
            rid: None,
            code: ErrorCode::ProviderError,
            message: "rate limited".into(),
            retry_after_ms: Some(1_250),
        });
        assert!(matches!(
            provider,
            ClientError::Provider {
                ref message,
                retry_after_ms: Some(1_250),
            } if message == "rate limited"
        ));

        let timeout = client_error_from_server(ServerError {
            rid: None,
            code: ErrorCode::Timeout,
            message: "request deadline exceeded".into(),
            retry_after_ms: None,
        });
        assert!(matches!(
            timeout,
            ClientError::Timeout {
                ref message,
                retry_after_ms: None,
            } if message == "request deadline exceeded"
        ));
    }

    #[tokio::test]
    async fn cancelled_receive_keeps_the_partial_frame() {
        let (client_stream, mut server_stream) = tokio::io::duplex(256);
        let mut conn = SWPConnection::from_raw_stream(client_stream);

        server_stream
            .write_all(br#"{"type":"stream_chunk","text":"hel"#)
            .await
            .unwrap();

        assert!(
            timeout(Duration::from_millis(10), conn.recv())
                .await
                .is_err()
        );

        server_stream
            .write_all(b"lo\",\"content_type\":\"text\"}\n")
            .await
            .unwrap();

        let msg = timeout(Duration::from_secs(1), conn.recv())
            .await
            .unwrap()
            .unwrap();
        let ServerMessage::StreamChunk(chunk) = msg else {
            panic!("expected stream chunk");
        };
        assert_eq!(chunk.text, "hello");
    }

    #[tokio::test]
    async fn unreadable_attachment_prevents_the_entire_message_send() {
        let temp = tempfile::tempdir().unwrap();
        let readable = temp.path().join("readable.png");
        std::fs::write(&readable, b"image bytes").unwrap();
        let unreadable = temp.path().join("missing.png");
        let paths = vec![
            readable.to_string_lossy().into_owned(),
            unreadable.to_string_lossy().into_owned(),
        ];
        let (client_stream, mut server_stream) = tokio::io::duplex(1024);
        let mut conn = SWPConnection::from_raw_stream(client_stream);

        let error = conn
            .send_message_with_images("keep every image", true, paths)
            .await
            .unwrap_err();

        assert!(
            matches!(
                error,
                ClientError::AttachmentRead { ref path, .. }
                    if path == &unreadable.to_string_lossy()
            ),
            "the failure should name the unreadable attachment: {error}"
        );
        assert!(
            timeout(Duration::from_millis(10), server_stream.read_u8())
                .await
                .is_err(),
            "no partial message should reach the daemon"
        );
    }

    #[test]
    fn uuid_v4_unique_under_concurrent_calls() {
        let mut handles = Vec::new();

        for _ in 0..8 {
            handles.push(std::thread::spawn(move || {
                let mut local = Vec::with_capacity(100);
                for _ in 0..100 {
                    local.push(request_id());
                }
                local
            }));
        }

        let mut all_ids = std::collections::HashSet::new();
        for h in handles {
            for id in h.join().unwrap() {
                assert!(
                    all_ids.insert(id.clone()),
                    "Duplicate request ID generated under concurrency: {id}"
                );
            }
        }
        assert_eq!(all_ids.len(), 800);
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::{ClientError, HANDSHAKE_DEADLINE, SWPConnection, ServerAddr};
    use crate::token::TokenSource;

    #[tokio::test(start_paused = true)]
    async fn a_daemon_that_never_sends_hello_reaches_the_handshake_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = ServerAddr(listener.local_addr().unwrap().to_string());
        let started = tokio::time::Instant::now();
        let attempt = tokio::spawn(async move {
            SWPConnection::connect_in_thread(
                &address,
                "test",
                "test",
                None,
                None,
                &TokenSource::Given("test-token".into()),
            )
            .await
        });
        let (_silent, _) = listener.accept().await.unwrap();
        let result = tokio::time::timeout(HANDSHAKE_DEADLINE * 6, attempt)
            .await
            .expect("connect_in_thread must enforce its own deadline, not hang")
            .unwrap();
        let elapsed = started.elapsed();
        assert!(
            elapsed >= HANDSHAKE_DEADLINE
                && elapsed <= HANDSHAKE_DEADLINE + std::time::Duration::from_secs(1),
            "the deadline is {HANDSHAKE_DEADLINE:?}, but the attempt ended after {elapsed:?}"
        );
        assert!(
            matches!(result, Err(ClientError::Timeout { .. })),
            "a silent daemon must end in the handshake deadline"
        );
    }
}
