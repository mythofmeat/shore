use crate::protocol::server_msg::{
    ServerMessage, StreamChunk, StreamEnd, StreamStart, ToolCall, ToolResult,
};
use crate::protocol::types::StreamMetadata;
use tracing::{debug, trace, warn};

use crate::swp_client::error::{ClientError, Result};

/// Aggregate result of consuming a full stream from `send`/`regen`.
///
/// Unlike `StreamHandler`, which is a stateful frame-by-frame accumulator,
/// this is the flattened end-state: everything a caller would want after
/// the stream has ended, in one struct.
#[derive(Debug, Clone)]
pub struct StreamedResponse {
    /// Final text content (from `StreamEnd.content`, which is the canonical
    /// full text — not just concatenated chunks).
    pub text: String,
    /// Tool calls collected during the stream, in order of arrival.
    pub tool_calls: Vec<ToolCall>,
    /// Tool results collected during the stream, in order of arrival.
    pub tool_results: Vec<ToolResult>,
    /// Metadata from `StreamEnd` — tokens, timing, model.
    pub metadata: StreamMetadata,
    /// Persisted assistant message id, when provided by the server.
    pub msg_id: Option<String>,
    /// Durable history revision containing `msg_id`, when provided.
    pub revision: Option<u64>,
    /// Finish reason from `StreamEnd`.
    pub finish_reason: String,
}

/// Callbacks invoked during stream consumption.
///
/// All callbacks receive `&mut self` so they can accumulate state.
/// Implement only the callbacks you care about; defaults are no-ops.
pub trait StreamCallbacks: Send {
    /// Called when a `stream_start` is received.
    fn on_start(&mut self, _start: &StreamStart) {}

    /// Called for each `stream_chunk`.
    fn on_chunk(&mut self, _chunk: &StreamChunk) {}

    /// Called when `stream_end` is received with the final content + metadata.
    fn on_end(&mut self, _end: &StreamEnd) {}
}

/// Accumulates streaming chunks into a final string.
///
/// This is the default handler — it collects all chunk text and exposes
/// the assembled content when the stream completes.
#[derive(Debug)]
pub struct StreamHandler {
    /// Whether we are currently inside a stream sequence.
    active: bool,
    /// Is this a regen stream?
    regen: bool,
    /// Accumulated chunk text.
    chunks: Vec<String>,
    /// Final content from `stream_end`, if received.
    final_content: Option<String>,
    /// Metadata from stream_end, if received.
    metadata: Option<StreamMetadata>,
    /// Persisted assistant message id from stream_end, if received.
    msg_id: Option<String>,
    /// Durable history revision from stream_end, if received.
    revision: Option<u64>,
}

impl StreamHandler {
    pub fn new() -> Self {
        Self {
            active: false,
            regen: false,
            chunks: Vec::new(),
            final_content: None,
            metadata: None,
            msg_id: None,
            revision: None,
        }
    }

    /// Reset state for reuse.
    pub fn reset(&mut self) {
        self.active = false;
        self.regen = false;
        self.chunks.clear();
        self.final_content = None;
        self.metadata = None;
        self.msg_id = None;
        self.revision = None;
    }

    /// Whether the handler is currently inside a stream sequence.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Whether this stream is a regen.
    pub fn is_regen(&self) -> bool {
        self.regen
    }

    /// Text assembled from chunks so far.
    pub fn assembled_text(&self) -> String {
        self.chunks.join("")
    }

    /// Final content from `stream_end`, if the stream has completed.
    pub fn final_content(&self) -> Option<&str> {
        self.final_content.as_deref()
    }

    /// Metadata from `stream_end`, if the stream has completed.
    pub fn metadata(&self) -> Option<&StreamMetadata> {
        self.metadata.as_ref()
    }

    /// Persisted assistant message id from `stream_end`, if the server sent it.
    pub fn msg_id(&self) -> Option<&str> {
        self.msg_id.as_deref()
    }

    /// Durable history revision from `stream_end`, if the server sent it.
    pub fn revision(&self) -> Option<u64> {
        self.revision
    }

    /// Feed a server message into the handler.
    ///
    /// Returns `true` if the message was consumed (i.e. it was a stream message),
    /// `false` if the message is unrelated to streaming and should be handled
    /// elsewhere.
    pub fn feed(
        &mut self,
        msg: &ServerMessage,
        callbacks: Option<&mut dyn StreamCallbacks>,
    ) -> Result<bool> {
        match msg {
            ServerMessage::StreamStart(start) => {
                if self.active {
                    warn!("received stream_start while already streaming");
                    return Err(ClientError::Protocol(
                        "received stream_start while already streaming".into(),
                    ));
                }
                self.reset();
                self.active = true;
                self.regen = start.regen;
                debug!(regen = start.regen, "stream started");
                if let Some(cb) = callbacks {
                    cb.on_start(start);
                }
                Ok(true)
            }
            ServerMessage::StreamChunk(chunk) => {
                if !self.active {
                    warn!("received stream_chunk outside of a stream");
                    return Err(ClientError::Protocol(
                        "received stream_chunk outside of a stream".into(),
                    ));
                }
                trace!(bytes = chunk.text.len(), content_type = %chunk.content_type, "stream chunk");
                self.chunks.push(chunk.text.clone());
                if let Some(cb) = callbacks {
                    cb.on_chunk(chunk);
                }
                Ok(true)
            }
            ServerMessage::StreamEnd(end) => {
                if !self.active {
                    warn!("received stream_end outside of a stream");
                    return Err(ClientError::Protocol(
                        "received stream_end outside of a stream".into(),
                    ));
                }
                self.active = false;
                self.final_content = Some(end.content.clone());
                self.metadata = Some(end.metadata.clone());
                self.msg_id.clone_from(&end.msg_id);
                self.revision = end.revision;
                debug!(
                    finish_reason = %end.finish_reason,
                    model = %end.metadata.model,
                    input_tokens = end.metadata.tokens.input,
                    output_tokens = end.metadata.tokens.output,
                    total_ms = end.metadata.timing.total_ms,
                    "stream ended"
                );
                if let Some(cb) = callbacks {
                    cb.on_end(end);
                }
                Ok(true)
            }
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::Phase(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::ToolCall(_)
            | ServerMessage::ToolResult(_)
            | ServerMessage::SendImage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::Unknown => Ok(false),
        }
    }
}

impl Default for StreamHandler {
    fn default() -> Self {
        Self::new()
    }
}

/// Consume a full streaming response from a connection and return the
/// aggregated result.
///
/// This loops on `conn.recv()` until a **terminal** `StreamEnd` arrives
/// (or an error), collecting tool calls / tool results along the way. A
/// daemon-side tool loop emits one `StreamEnd` per LLM turn so streaming
/// clients can render tool calls as they happen; only the frame with
/// `is_final = true` ends the whole generation. This function spans the
/// full sequence — intermediate StreamEnds (`is_final = false`) reset the
/// handler so the next `StreamStart` is accepted, and the returned
/// `StreamedResponse` reflects the final turn's text, metadata, and
/// finish_reason with tool_call / tool_result frames aggregated across
/// every phase.
///
/// Returns an error if:
/// - The server sends an `Error` frame.
/// - The connection closes before a terminal `StreamEnd` arrives.
/// - Any protocol-level stream assembly error occurs.
///
/// Unknown frame types are logged at `debug` level and skipped without
/// raising an error — the stream continues until a terminal frame arrives.
pub async fn collect_stream(
    conn: &mut crate::swp_client::connection::SWPConnection,
) -> Result<StreamedResponse> {
    let mut handler = StreamHandler::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut tool_results: Vec<ToolResult> = Vec::new();

    let end: StreamEnd = loop {
        let msg = conn.recv().await?;

        // Try feeding stream frames first.
        let consumed = handler.feed(&msg, None)?;

        if consumed {
            // If the stream just ended, decide whether this was terminal.
            if !handler.is_active() && handler.final_content().is_some() {
                match msg {
                    ServerMessage::StreamEnd(end) => {
                        if end.is_final {
                            break end;
                        }
                        // Intermediate tool-loop boundary: the daemon will
                        // emit more frames for subsequent turns. Reset so
                        // the next StreamStart is accepted, and keep reading.
                        handler.reset();
                    }
                    // Defensive: handler.feed() today only flips !is_active +
                    // final_content().is_some() on StreamEnd. If that ever
                    // changes, surface the anomaly instead of spinning.
                    ServerMessage::Hello(_)
                    | ServerMessage::History(_)
                    | ServerMessage::Shutdown(_)
                    | ServerMessage::Ping(_)
                    | ServerMessage::CommandOutput(_)
                    | ServerMessage::Error(_)
                    | ServerMessage::StreamStart(_)
                    | ServerMessage::StreamChunk(_)
                    | ServerMessage::Phase(_)
                    | ServerMessage::NewMessage(_)
                    | ServerMessage::ToolCall(_)
                    | ServerMessage::ToolResult(_)
                    | ServerMessage::SendImage(_)
                    | ServerMessage::CacheWarning(_)
                    | ServerMessage::ProviderFallbackWarning(_)
                    | ServerMessage::UsageWarning(_)
                    | ServerMessage::Unknown => {
                        return Err(ClientError::Protocol(
                            "collect_stream: stream ended on non-StreamEnd frame".into(),
                        ));
                    }
                }
            }
            continue;
        }

        // Not a stream frame — route to the collectors or error out.
        match msg {
            ServerMessage::ToolCall(tc) => tool_calls.push(tc),
            ServerMessage::ToolResult(tr) => tool_results.push(tr),
            ServerMessage::Error(err) => {
                return Err(ClientError::Protocol(err.message));
            }
            // Benign frames we ignore mid-stream.
            ServerMessage::Ping(_)
            | ServerMessage::Phase(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::History(_)
            | ServerMessage::SendImage(_)
            | ServerMessage::UsageWarning(_) => {}
            // Anything else is a protocol surprise — log and continue.
            other @ (ServerMessage::Hello(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::StreamStart(_)
            | ServerMessage::StreamChunk(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::Unknown) => {
                tracing::debug!(?other, "collect_stream: ignoring unexpected frame");
            }
        }
    };

    Ok(StreamedResponse {
        text: end.content,
        tool_calls,
        tool_results,
        metadata: end.metadata,
        msg_id: end.msg_id,
        revision: end.revision,
        finish_reason: end.finish_reason,
    })
}
