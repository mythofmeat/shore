use shore_protocol::server_msg::{ServerMessage, StreamChunk, StreamEnd, StreamStart};
use shore_protocol::types::{StreamMetadata, TimingInfo, TokenCounts};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc;
use tracing::{debug, info};

use shore_protocol::types::ContentBlock;

use super::types::{StreamEvent, StreamResult, Timing, ToolUseEvent, Usage};
use super::LlmError;

/// Consumes a newline-delimited JSON stream from shore-llm's /v1/stream
/// endpoint, relaying `StreamChunk` events (with content_type) to the
/// requesting SWP session via a direct sender, and accumulating the final
/// `StreamResult`.
#[derive(Debug)]
pub struct StreamConsumer {
    direct_tx: mpsc::Sender<ServerMessage>,
    rid: Option<String>,
}

impl StreamConsumer {
    /// Create a new stream consumer that emits to the given session sender.
    pub fn new(direct_tx: mpsc::Sender<ServerMessage>, rid: Option<String>) -> Self {
        Self { direct_tx, rid }
    }

    /// Consume a streaming response from shore-llm.
    ///
    /// Reads newline-delimited JSON events, emits `StreamStart` and
    /// `StreamChunk` to the requesting SWP session, and returns the
    /// accumulated `StreamResult` with metadata.
    ///
    /// Does NOT emit `StreamEnd` — that is the caller's responsibility, so it
    /// can be deferred until after persistence (avoiding the race where a
    /// follow-up command snapshots engine state before the freshly-streamed
    /// message has been appended). Use [`emit_stream_end`] after the message
    /// is durable.
    pub async fn consume<R: AsyncRead + Unpin>(
        &self,
        reader: &mut BufReader<R>,
        regen: bool,
    ) -> Result<StreamResult, LlmError> {
        let mut st = ConsumeState::default();

        loop {
            let mut line = String::new();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| LlmError::Provider {
                    message: format!("stream read error: {e}"),
                })?;
            if n == 0 {
                // EOF — stream ended without "done" event.
                return Err(LlmError::IncompleteStream);
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let event: StreamEvent =
                serde_json::from_str(trimmed).map_err(LlmError::Deserialize)?;

            // A mid-stream `Error` event becomes `LlmError::StreamErrored` (with
            // its partial usage) via `?`, failing the call so retry runs while
            // still handing the already-billed usage to the caller.
            if let Some(result) = self.handle_event(&mut st, event, regen).await? {
                return Ok(result);
            }
        }
    }

    /// Handle one decoded SSE event: relay any `StreamChunk`/`StreamStart`
    /// frame to the session, accumulate content into `st`, and return the
    /// final `StreamResult` once the terminal `Done` event arrives. A terminal
    /// `Error` event becomes `Err(LlmError::StreamErrored)`, carrying the
    /// partial usage the provider had already reported.
    async fn handle_event(
        &self,
        st: &mut ConsumeState,
        event: StreamEvent,
        regen: bool,
    ) -> Result<Option<StreamResult>, LlmError> {
        match event {
            StreamEvent::Start { model: start_model } => {
                st.model = start_model;
                st.started = true;

                // Emit stream_start to the requesting SWP session.
                let _ignored = self
                    .direct_tx
                    .send(ServerMessage::StreamStart(StreamStart {
                        subagent: None,
                        rid: self.rid.clone(),
                        regen,
                    }))
                    .await;

                debug!(model = %st.model, "Stream started");
            }

            StreamEvent::Text { text } => {
                // Flush any pending thinking before accumulating text.
                st.flush_thinking();
                st.text_buf.push_str(&text);

                // Relay as StreamChunk with content_type "text".
                let _ignored = self
                    .direct_tx
                    .send(ServerMessage::StreamChunk(StreamChunk {
                        subagent: None,
                        rid: self.rid.clone(),
                        text,
                        content_type: "text".into(),
                    }))
                    .await;
            }

            StreamEvent::Thinking { text } => {
                // Flush any pending text before accumulating thinking.
                st.flush_text();
                st.thinking_buf.push_str(&text);

                // Relay as StreamChunk with content_type "thinking".
                let _ignored = self
                    .direct_tx
                    .send(ServerMessage::StreamChunk(StreamChunk {
                        subagent: None,
                        rid: self.rid.clone(),
                        text,
                        content_type: "thinking".into(),
                    }))
                    .await;
            }

            StreamEvent::ThinkingSignature { signature } => {
                // Buffer the signature to attach when the thinking block is flushed.
                st.pending_signature = Some(signature);
            }

            StreamEvent::RedactedThinking { data } => {
                // Redacted thinking is a complete block — flush buffers and push directly.
                st.flush_text();
                st.flush_thinking();
                st.content_blocks
                    .push(ContentBlock::RedactedThinking { data });
            }

            StreamEvent::ToolUse { id, name, input } => {
                // Flush pending buffers before tool_use block.
                st.flush_text();
                st.flush_thinking();

                st.content_blocks.push(ContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });

                st.tool_uses.push(ToolUseEvent { id, name, input });
            }

            StreamEvent::Done {
                content,
                finish_reason,
                usage,
                timing,
            } => {
                // StreamEnd is emitted by the caller — see emit_stream_end.
                return Ok(Some(st.finish(content, finish_reason, usage, timing)));
            }

            // Keepalive — no payload, nothing to relay or accumulate. Reading
            // the line already reset the transport idle timer, which is the
            // whole point. Keep consuming.
            StreamEvent::Ping => {}

            // A mid-stream provider failure that still carried partial usage
            // (e.g. the Anthropic cache write reported in `message_start`).
            // Fail the call so retry runs, but hand the usage to the caller so
            // the ledger records the already-billed tokens instead of zeros.
            StreamEvent::Error {
                message,
                usage,
                timing,
            } => {
                return Err(LlmError::StreamErrored {
                    message,
                    usage: Box::new(usage),
                    timing,
                });
            }
        }

        Ok(None)
    }
}

/// Mutable accumulator threaded through SSE event handling in
/// [`StreamConsumer::consume`].
#[derive(Default)]
struct ConsumeState {
    /// Model name from the `start` event.
    model: String,
    /// Tool-use events surfaced to the caller's tool loop.
    tool_uses: Vec<ToolUseEvent>,
    /// Accumulated content blocks in arrival order.
    content_blocks: Vec<ContentBlock>,
    /// Pending text not yet flushed into `content_blocks`.
    text_buf: String,
    /// Pending thinking not yet flushed into `content_blocks`.
    thinking_buf: String,
    /// Signature buffered until the current thinking block is flushed.
    pending_signature: Option<String>,
    /// Whether a `start` event has been seen.
    started: bool,
}

impl ConsumeState {
    /// Flush accumulated text into `content_blocks`.
    fn flush_text(&mut self) {
        if !self.text_buf.is_empty() {
            self.content_blocks.push(ContentBlock::Text {
                text: std::mem::take(&mut self.text_buf),
            });
        }
    }

    /// Flush accumulated thinking into `content_blocks`, attaching any
    /// pending signature.
    fn flush_thinking(&mut self) {
        if !self.thinking_buf.is_empty() {
            self.content_blocks.push(ContentBlock::Thinking {
                thinking: std::mem::take(&mut self.thinking_buf),
                signature: self.pending_signature.take(),
            });
        }
    }

    /// Flush pending buffers and assemble the terminal [`StreamResult`] from a
    /// `done` event, draining the accumulated tool-uses and content blocks.
    fn finish(
        &mut self,
        content: String,
        finish_reason: String,
        usage: Usage,
        timing: Timing,
    ) -> StreamResult {
        self.flush_text();
        self.flush_thinking();

        info!(
            model = %self.model,
            input_tokens = usage.input_tokens,
            output_tokens = usage.output_tokens,
            cache_read = usage.cache_read_tokens,
            cache_write = usage.cache_creation_tokens,
            total_ms = timing.total_ms,
            ttft_ms = timing.time_to_first_token_ms,
            "Stream completed"
        );

        StreamResult {
            content,
            model: if self.started {
                std::mem::take(&mut self.model)
            } else {
                String::new()
            },
            finish_reason,
            usage,
            timing,
            tool_uses: std::mem::take(&mut self.tool_uses),
            content_blocks: std::mem::take(&mut self.content_blocks),
        }
    }
}

/// Emit a `StreamEnd` SWP frame describing a completed stream.
///
/// Callers should invoke this after the message is durable (i.e. after
/// persistence completes for the final phase, or immediately for
/// intermediate `tool_use` phases that drive a tool loop). See the
/// `StreamConsumer::consume` docs for the rationale.
///
/// `is_final` distinguishes the terminal frame (after persistence) from
/// intermediate frames emitted at tool-loop iteration boundaries. Aggregating
/// clients like `collect_stream` use this to decide whether to keep reading.
pub async fn emit_stream_end(
    tx: &mpsc::Sender<ServerMessage>,
    rid: Option<String>,
    result: &StreamResult,
    is_final: bool,
    msg_id: Option<String>,
    revision: Option<u64>,
) {
    let metadata = StreamMetadata {
        tokens: TokenCounts {
            input: result.usage.input_tokens,
            output: result.usage.output_tokens,
            cache_read: result.usage.cache_read_tokens,
            cache_write: result.usage.cache_creation_tokens,
        },
        timing: TimingInfo {
            total_ms: result.timing.total_ms,
            ttft_ms: result.timing.time_to_first_token_ms,
        },
        model: result.model.clone(),
    };
    let _ignored = tx
        .send(ServerMessage::StreamEnd(StreamEnd {
            subagent: None,
            rid,
            msg_id,
            revision,
            content: result.content.clone(),
            metadata,
            finish_reason: result.finish_reason.clone(),
            is_final,
        }))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, DuplexStream};

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    /// Helper: set up a duplex stream pair and return (writer, reader, direct_tx, direct_rx).
    fn setup_stream_pair() -> (
        DuplexStream,
        BufReader<DuplexStream>,
        mpsc::Sender<ServerMessage>,
        mpsc::Receiver<ServerMessage>,
    ) {
        let (client_half, server_half) = tokio::io::duplex(64 * 1024);
        let client_reader = BufReader::new(client_half);
        let (direct_tx, direct_rx) = mpsc::channel(64);
        (server_half, client_reader, direct_tx, direct_rx)
    }

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    fn field<'val>(value: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        value.get(key).expect("expected JSON field")
    }

    /// A mid-stream `error` event must surface as `LlmError::StreamErrored`
    /// carrying the usage the provider had already accumulated (the Anthropic
    /// cache write from `message_start`), so the ledger records it instead of
    /// zeros. The call still fails so the normal retry path runs.
    #[tokio::test]
    async fn consume_error_event_carries_partial_usage() {
        let (mut writer, mut reader, direct_tx, _direct_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(direct_tx, None);

        let events = [
            r#"{"type":"start","model":"claude-opus-4-8"}"#,
            r#"{"type":"error","message":"connection reset","usage":{"input_tokens":2,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":19188},"timing":{"total_ms":800,"time_to_first_token_ms":0}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let err = consumer
            .consume(&mut reader, false)
            .await
            .expect_err("error event must fail the call");

        assert_variant!(
            err,
            LlmError::StreamErrored { message, usage, timing } => {
                assert_eq!(message, "connection reset");
                assert_eq!(usage.cache_creation_tokens, 19188);
                assert_eq!(usage.input_tokens, 2);
                assert_eq!(timing.total_ms, 800);
            }
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn consume_ignores_ping_keepalives() {
        let (mut writer, mut reader, direct_tx, mut direct_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(direct_tx.clone(), None);

        // Pings (sidecar keepalives during quiet stretches) are interleaved
        // around real events; the consumer must skip them entirely.
        let events = [
            r#"{"type":"start","model":"claude-test"}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"text","text":"Hi"}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"done","content":"Hi","finish_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"cache_read_tokens":0,"cache_creation_tokens":0},"timing":{"total_ms":10,"time_to_first_token_ms":5}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();
        assert_eq!(result.content, "Hi");
        assert_eq!(result.finish_reason, "end_turn");

        // Exactly StreamStart then ONE text chunk — no frame for any ping.
        assert!(matches!(
            direct_rx.recv().await.unwrap(),
            ServerMessage::StreamStart(_)
        ));
        assert_variant!(
            direct_rx.recv().await.unwrap(),
            ServerMessage::StreamChunk(chunk) => {
                assert_eq!(chunk.text, "Hi");
                assert_eq!(chunk.content_type, "text");
            }
        );
        assert!(
            direct_rx.try_recv().is_err(),
            "pings must not produce any relayed frame"
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn consume_simple_stream() {
        let (mut writer, mut reader, direct_tx, mut direct_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(direct_tx.clone(), None);

        // Write stream events from "server".
        let events = [
            r#"{"type":"start","model":"claude-test"}"#,
            r#"{"type":"text","text":"Hello "}"#,
            r#"{"type":"text","text":"world"}"#,
            r#"{"type":"done","content":"Hello world","finish_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5,"cache_read_tokens":8,"cache_creation_tokens":2},"timing":{"total_ms":150,"time_to_first_token_ms":50}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        assert_eq!(result.content, "Hello world");
        assert_eq!(result.model, "claude-test");
        assert_eq!(result.finish_reason, "end_turn");
        assert_eq!(result.usage.input_tokens, 10);
        assert_eq!(result.usage.output_tokens, 5);
        assert_eq!(result.usage.cache_read_tokens, 8);
        assert_eq!(result.timing.total_ms, 150);
        assert_eq!(result.timing.time_to_first_token_ms, 50);
        assert!(result.tool_uses.is_empty());

        // Verify direct messages.  consume() emits StreamStart + StreamChunks
        // but NOT StreamEnd (caller emits via emit_stream_end after persistence).
        let msg1 = direct_rx.recv().await.unwrap();
        assert!(matches!(
            msg1,
            ServerMessage::StreamStart(StreamStart {
                subagent: _,
                rid: None,
                regen: false
            })
        ));

        let msg2 = direct_rx.recv().await.unwrap();
        assert_variant!(

            msg2,
            ServerMessage::StreamChunk(chunk) => {
                assert_eq!(chunk.text, "Hello ");
                assert_eq!(chunk.content_type, "text");
            }

        );

        let msg3 = direct_rx.recv().await.unwrap();
        assert_variant!(

            msg3,
            ServerMessage::StreamChunk(chunk) => {
                assert_eq!(chunk.text, "world");
                assert_eq!(chunk.content_type, "text");
            }

        );

        // consume() must NOT have emitted a StreamEnd yet.
        assert!(
            direct_rx.try_recv().is_err(),
            "consume() should not emit StreamEnd; caller is responsible"
        );

        // The caller emits via emit_stream_end.
        emit_stream_end(&direct_tx, None, &result, true, None, None).await;

        let msg4 = direct_rx.recv().await.unwrap();
        assert_variant!(

            msg4,
            ServerMessage::StreamEnd(end) => {
                assert_eq!(end.content, "Hello world");
                assert_eq!(end.msg_id, None);
                assert_eq!(end.revision, None);
                assert_eq!(end.metadata.model, "claude-test");
                assert_eq!(end.metadata.tokens.input, 10);
                assert_eq!(end.metadata.tokens.cache_read, 8);
                assert_eq!(end.metadata.timing.ttft_ms, 50);
            }

        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn consume_stream_with_thinking_and_tools() {
        let (mut writer, mut reader, direct_tx, mut direct_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(direct_tx, None);

        let events = [
            r#"{"type":"start","model":"claude-test"}"#,
            r#"{"type":"thinking","text":"Let me think..."}"#,
            r#"{"type":"tool_use","id":"t1","name":"search","input":{"q":"test"}}"#,
            r#"{"type":"text","text":"Found it"}"#,
            r#"{"type":"done","content":"Found it","finish_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":10},"timing":{"total_ms":300}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        assert_eq!(result.content, "Found it");
        assert_eq!(result.tool_uses.len(), 1);
        let tool_use = item(&result.tool_uses, 0);
        assert_eq!(tool_use.id, "t1");
        assert_eq!(tool_use.name, "search");
        assert_eq!(field(&tool_use.input, "q"), "test");

        // Verify content_blocks accumulated correctly.
        assert_eq!(
            result.content_blocks.len(),
            3,
            "Should have thinking + tool_use + text blocks"
        );
        assert!(
            matches!(item(&result.content_blocks, 0), ContentBlock::Thinking { thinking, signature } if thinking == "Let me think..." && signature.is_none())
        );
        assert!(
            matches!(item(&result.content_blocks, 1), ContentBlock::ToolUse { id, name, .. } if id == "t1" && name == "search")
        );
        assert!(
            matches!(item(&result.content_blocks, 2), ContentBlock::Text { text } if text == "Found it")
        );

        // Verify thinking chunk was emitted with correct content_type.
        let _ignored = direct_rx.recv().await.unwrap(); // StreamStart
        let thinking_msg = direct_rx.recv().await.unwrap();
        assert_variant!(

            thinking_msg,
            ServerMessage::StreamChunk(chunk) => {
                assert_eq!(chunk.text, "Let me think...");
                assert_eq!(chunk.content_type, "thinking");
            }

        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn consume_stream_with_thinking_signature() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let events = [
            r#"{"type":"start","model":"claude-test"}"#,
            r#"{"type":"thinking","text":"Let me "}"#,
            r#"{"type":"thinking","text":"reason..."}"#,
            r#"{"type":"thinking_signature","signature":"sig_test_abc"}"#,
            r#"{"type":"text","text":"The answer"}"#,
            r#"{"type":"done","content":"The answer","finish_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":10},"timing":{"total_ms":300}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        assert_eq!(result.content_blocks.len(), 2);
        assert_variant!(

            item(&result.content_blocks, 0),
            ContentBlock::Thinking {
                thinking,
                signature,
            } => {
                assert_eq!(thinking, "Let me reason...");
                assert_eq!(signature.as_deref(), Some("sig_test_abc"));
            }

        );
        assert!(
            matches!(item(&result.content_blocks, 1), ContentBlock::Text { text } if text == "The answer")
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn consume_stream_with_redacted_thinking() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let events = [
            r#"{"type":"start","model":"claude-test"}"#,
            r#"{"type":"thinking","text":"Visible thinking"}"#,
            r#"{"type":"thinking_signature","signature":"sig_1"}"#,
            r#"{"type":"redacted_thinking","data":"opaque_encrypted_bytes"}"#,
            r#"{"type":"text","text":"Answer"}"#,
            r#"{"type":"done","content":"Answer","finish_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":10},"timing":{"total_ms":300}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        assert_eq!(result.content_blocks.len(), 3);
        assert_variant!(

            item(&result.content_blocks, 0),
            ContentBlock::Thinking {
                thinking,
                signature,
            } => {
                assert_eq!(thinking, "Visible thinking");
                assert_eq!(signature.as_deref(), Some("sig_1"));
            }

        );
        assert_variant!(

            item(&result.content_blocks, 1),
            ContentBlock::RedactedThinking { data } => {
                assert_eq!(data, "opaque_encrypted_bytes");
            }

        );
        assert!(
            matches!(item(&result.content_blocks, 2), ContentBlock::Text { text } if text == "Answer")
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn consume_regen_sets_flag() {
        let (mut writer, mut reader, push_tx, mut push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let server_handle = tokio::spawn(async move {
            writer
                .write_all(b"{\"type\":\"start\",\"model\":\"test\"}\n")
                .await
                .unwrap();
            writer
                .write_all(b"{\"type\":\"done\",\"content\":\"ok\",\"finish_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1},\"timing\":{\"total_ms\":10}}\n")
                .await
                .unwrap();
            writer.shutdown().await.unwrap();
        });

        let _ignored = consumer.consume(&mut reader, true).await.unwrap();

        let msg = push_rx.try_recv().unwrap();
        assert_variant!(

            msg,
            ServerMessage::StreamStart(start) => assert!(start.regen),

        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn incomplete_stream_returns_error() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        // Server sends start but closes connection without "done".
        let server_handle = tokio::spawn(async move {
            writer
                .write_all(b"{\"type\":\"start\",\"model\":\"test\"}\n")
                .await
                .unwrap();
            writer.shutdown().await.unwrap();
        });

        let err = consumer.consume(&mut reader, false).await.unwrap_err();
        assert!(matches!(err, LlmError::IncompleteStream));

        server_handle.await.unwrap();
    }

    // ── Content block accumulation tests ────────────────────────────────

    #[tokio::test]
    async fn content_blocks_merge_consecutive_text() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let events = [
            r#"{"type":"start","model":"test"}"#,
            r#"{"type":"text","text":"Hello "}"#,
            r#"{"type":"text","text":"world"}"#,
            r#"{"type":"text","text":"!"}"#,
            r#"{"type":"done","content":"Hello world!","finish_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"timing":{"total_ms":10}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        // Consecutive text chunks should be merged into a single Text block.
        assert_eq!(result.content_blocks.len(), 1);
        assert!(
            matches!(item(&result.content_blocks, 0), ContentBlock::Text { text } if text == "Hello world!")
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn content_blocks_merge_consecutive_thinking() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let events = [
            r#"{"type":"start","model":"test"}"#,
            r#"{"type":"thinking","text":"First "}"#,
            r#"{"type":"thinking","text":"thought"}"#,
            r#"{"type":"text","text":"Answer"}"#,
            r#"{"type":"done","content":"Answer","finish_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"timing":{"total_ms":10}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        // Consecutive thinking chunks merged, then text block.
        assert_eq!(result.content_blocks.len(), 2);
        assert!(
            matches!(item(&result.content_blocks, 0), ContentBlock::Thinking { thinking, signature } if thinking == "First thought" && signature.is_none())
        );
        assert!(
            matches!(item(&result.content_blocks, 1), ContentBlock::Text { text } if text == "Answer")
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn content_blocks_type_change_flushes_buffer() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        // Interleaved: text → thinking → text
        let events = [
            r#"{"type":"start","model":"test"}"#,
            r#"{"type":"text","text":"pre-thought "}"#,
            r#"{"type":"thinking","text":"hmm..."}"#,
            r#"{"type":"text","text":"post-thought"}"#,
            r#"{"type":"done","content":"pre-thought post-thought","finish_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"timing":{"total_ms":10}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        // Type change should flush: text, thinking, text → 3 blocks.
        assert_eq!(result.content_blocks.len(), 3);
        assert!(
            matches!(item(&result.content_blocks, 0), ContentBlock::Text { text } if text == "pre-thought ")
        );
        assert!(
            matches!(item(&result.content_blocks, 1), ContentBlock::Thinking { thinking, signature } if thinking == "hmm..." && signature.is_none())
        );
        assert!(
            matches!(item(&result.content_blocks, 2), ContentBlock::Text { text } if text == "post-thought")
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn content_blocks_text_only_stream() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let events = [
            r#"{"type":"start","model":"test"}"#,
            r#"{"type":"text","text":"Just text"}"#,
            r#"{"type":"done","content":"Just text","finish_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"timing":{"total_ms":10}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        assert_eq!(result.content_blocks.len(), 1);
        assert!(
            matches!(item(&result.content_blocks, 0), ContentBlock::Text { text } if text == "Just text")
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn content_blocks_empty_on_no_content() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        // Start → Done with empty content (edge case).
        let events = [
            r#"{"type":"start","model":"test"}"#,
            r#"{"type":"done","content":"","finish_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":0},"timing":{"total_ms":10}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        assert!(result.content_blocks.is_empty());

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn malformed_json_mid_stream() {
        let (mut writer, mut reader, push_tx, mut push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let server_handle = tokio::spawn(async move {
            writer
                .write_all(b"{\"type\":\"start\",\"model\":\"claude-test\"}\n")
                .await
                .unwrap();
            writer.write_all(b"NOT VALID JSON\n").await.unwrap();
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await;
        assert!(result.is_err());
        assert!(
            matches!(&result.unwrap_err(), LlmError::Deserialize(_)),
            "Expected Deserialize error"
        );

        // StreamStart should have been broadcast before the error.
        let msg = push_rx.try_recv().unwrap();
        assert!(matches!(msg, ServerMessage::StreamStart(_)));

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn thinking_signature_without_thinking_text() {
        let (mut writer, mut reader, push_tx, _push_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(push_tx, None);

        let events = [
            r#"{"type":"start","model":"claude-test"}"#,
            r#"{"type":"thinking_signature","signature":"sig_orphan"}"#,
            r#"{"type":"text","text":"Hello"}"#,
            r#"{"type":"done","content":"Hello","finish_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5},"timing":{"total_ms":100}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        // Only a text block — the orphaned signature is discarded.
        assert_eq!(result.content_blocks.len(), 1);
        assert!(
            matches!(item(&result.content_blocks, 0), ContentBlock::Text { text } if text == "Hello")
        );
        assert_eq!(result.content, "Hello");

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn broadcast_channel_no_receivers() {
        let (mut writer, mut reader, push_tx, push_rx) = setup_stream_pair();
        // Drop the only receiver — sends will silently fail.
        drop(push_rx);

        let consumer = StreamConsumer::new(push_tx, None);

        let events = [
            r#"{"type":"start","model":"claude-test"}"#,
            r#"{"type":"text","text":"Hello "}"#,
            r#"{"type":"text","text":"world"}"#,
            r#"{"type":"done","content":"Hello world","finish_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5},"timing":{"total_ms":100}}"#,
        ];

        let server_handle = tokio::spawn(async move {
            for event in events {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.write_all(b"\n").await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();
        assert_eq!(result.content, "Hello world");
        assert_eq!(result.content_blocks.len(), 1);
        assert!(
            matches!(item(&result.content_blocks, 0), ContentBlock::Text { text } if text == "Hello world")
        );

        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn consume_stream_echoes_request_id() {
        let (mut writer, mut reader, direct_tx, mut direct_rx) = setup_stream_pair();
        let consumer = StreamConsumer::new(direct_tx.clone(), Some("req_stream_01".into()));

        let server_handle = tokio::spawn(async move {
            writer
                .write_all(b"{\"type\":\"start\",\"model\":\"claude-test\"}\n")
                .await
                .unwrap();
            writer
                .write_all(b"{\"type\":\"text\",\"text\":\"Hello\"}\n")
                .await
                .unwrap();
            writer
                .write_all(b"{\"type\":\"done\",\"content\":\"Hello\",\"finish_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1},\"timing\":{\"total_ms\":10}}\n")
                .await
                .unwrap();
            writer.shutdown().await.unwrap();
        });

        let result = consumer.consume(&mut reader, false).await.unwrap();

        assert_variant!(


            direct_rx.recv().await.unwrap(),
            ServerMessage::StreamStart(msg) => {
                assert_eq!(msg.rid.as_deref(), Some("req_stream_01"));
            }


        );
        assert_variant!(

            direct_rx.recv().await.unwrap(),
            ServerMessage::StreamChunk(msg) => {
                assert_eq!(msg.rid.as_deref(), Some("req_stream_01"));
            }

        );

        // The caller emits StreamEnd, propagating the same rid.
        emit_stream_end(
            &direct_tx,
            Some("req_stream_01".into()),
            &result,
            true,
            Some("m_stream_01".into()),
            Some(42),
        )
        .await;
        assert_variant!(

            direct_rx.recv().await.unwrap(),
            ServerMessage::StreamEnd(msg) => {
                assert_eq!(msg.rid.as_deref(), Some("req_stream_01"));
                assert_eq!(msg.msg_id.as_deref(), Some("m_stream_01"));
                assert_eq!(msg.revision, Some(42));
            }

        );

        server_handle.await.unwrap();
    }
}
