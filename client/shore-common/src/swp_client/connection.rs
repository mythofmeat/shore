use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpStream;
use tracing::{debug, error, trace, warn};

use crate::protocol::client_msg::{ClientHello, ClientMessage};
use crate::protocol::error::ErrorCode;
use crate::protocol::server_msg::{History, ServerHello, ServerMessage};
use crate::protocol::{MAX_WIRE_MESSAGE_SIZE, SWP_V1};

use crate::swp_client::error::{ClientError, Result};

#[derive(Debug, Clone)]
pub struct ServerAddr(pub String);

trait AsyncReadWrite: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin> AsyncReadWrite for T {}

pub struct SWPConnection {
    reader: BufReader<Box<dyn AsyncReadWrite>>,
    read_pending: Vec<u8>,
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
            writer: BufWriter::new(Box::new(tokio::io::join(tokio::io::empty(), w))),
        })
    }

    pub async fn connect<T: Into<String>, N: Into<String>>(
        addr: &ServerAddr,
        client_type: T,
        client_name: N,
        character: Option<String>,
    ) -> Result<(Self, ServerHello, History)> {
        let mut conn = Self::open(addr).await?;
        let (server_hello, history) = conn
            .do_handshake(
                client_type.into(),
                client_name.into(),
                character,
                Some(&addr.0),
            )
            .await?;
        Ok((conn, server_hello, history))
    }

    async fn do_handshake(
        &mut self,
        client_type: String,
        client_name: String,
        character: Option<String>,
        addr: Option<&str>,
    ) -> Result<(ServerHello, History)> {
        debug!(client_type = %client_type, client_name = %client_name, character = ?character, "starting SWP handshake");

        let token = crate::token::resolve_client_token(
            addr.and_then(crate::swp_client::discovery::config_dir_for_addr),
        )
        .map_err(|e| ClientError::Unauthorized(e.to_string()))?;

        let server_hello = self.recv_server_hello().await?;

        let hello = ClientMessage::Hello(ClientHello {
            client_type,
            client_name,
            capabilities: vec!["streaming".into()],
            character,
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
                | ServerMessage::ProviderFallbackWarning(_)
                | ServerMessage::UsageWarning(_)
                | ServerMessage::ConfigWarning(_)) => {
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
                    return Err(match e.code {
                        ErrorCode::Unauthorized => ClientError::Unauthorized(e.message),
                        ErrorCode::ProtocolError
                        | ErrorCode::InvalidRequest
                        | ErrorCode::NotFound
                        | ErrorCode::Busy
                        | ErrorCode::ProviderError
                        | ErrorCode::Timeout
                        | ErrorCode::InternalError => ClientError::Protocol(e.message),
                    });
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
                | ServerMessage::ProviderFallbackWarning(_)
                | ServerMessage::UsageWarning(_)
                | ServerMessage::ConfigWarning(_)) => {
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
        self.writer
            .write_all(line.as_bytes())
            .await
            .map_err(ClientError::Io)?;
        self.writer
            .write_all(b"\n")
            .await
            .map_err(ClientError::Io)?;
        self.writer.flush().await.map_err(ClientError::Io)?;
        Ok(())
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
        use crate::protocol::client_msg::{ClientMessageBody, ImageUpload};
        use base64::Engine;

        let image_data: Vec<ImageUpload> = images
            .iter()
            .filter_map(|path| {
                let bytes = std::fs::read(path).ok()?;
                let filename = std::path::Path::new(path)
                    .file_name()
                    .map_or_else(|| "image".to_owned(), |f| f.to_string_lossy().into_owned());
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                Some(ImageUpload {
                    filename,
                    data,
                    mime_type: None,
                })
            })
            .collect();

        let rid = Some(uuid_v4());
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

    pub async fn send_regen(&mut self, stream: bool) -> Result<Option<String>> {
        use crate::protocol::client_msg::Regen;
        let rid = Some(uuid_v4());
        let msg = ClientMessage::Regen(Regen {
            rid: rid.clone(),
            stream,
        });
        self.send(&msg).await?;
        Ok(rid)
    }

    pub async fn send_command<N: Into<String>>(
        &mut self,
        name: N,
        args: serde_json::Value,
    ) -> Result<Option<String>> {
        use crate::protocol::client_msg::Command;
        let rid = Some(uuid_v4());
        let msg = ClientMessage::Command(Command {
            rid: rid.clone(),
            name: name.into(),
            args,
        });
        self.send(&msg).await?;
        Ok(rid)
    }
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
            writer: BufWriter::new(Box::new(tokio::io::join(tokio::io::empty(), w))),
        }
    }

    pub async fn connect_raw<S, T: Into<String>, N: Into<String>>(
        stream: S,
        client_type: T,
        client_name: N,
        character: Option<String>,
    ) -> Result<(Self, ServerHello, History)>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let mut conn = Self::from_raw_stream(stream);
        let (server_hello, history) = conn
            .do_handshake(client_type.into(), client_name.into(), character, None)
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

fn uuid_v4() -> String {
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
    use tokio::io::AsyncWriteExt;
    use tokio::time::{Duration, timeout};

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

    #[test]
    fn uuid_v4_unique_under_concurrent_calls() {
        let mut handles = Vec::new();

        for _ in 0..8 {
            handles.push(std::thread::spawn(move || {
                let mut local = Vec::with_capacity(100);
                for _ in 0..100 {
                    local.push(uuid_v4());
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
