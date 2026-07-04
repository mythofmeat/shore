// Panic-hygiene lock (see [workspace.lints] in root Cargo.toml): this crate is
// cleaned, so these can never regress. Tests are exempt via clippy.toml.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::todo,
    clippy::unimplemented,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::as_conversions,
    clippy::allow_attributes,
    clippy::allow_attributes_without_reason,
    clippy::unwrap_in_result,
    clippy::panic_in_result_fn,
    clippy::let_underscore_must_use,
    clippy::clone_on_ref_ptr,
    clippy::dbg_macro,
    clippy::exit,
    clippy::mem_forget,
    clippy::match_wildcard_for_single_variants,
    clippy::wildcard_enum_match_arm,
    clippy::wildcard_imports,
    clippy::unseparated_literal_suffix,
    clippy::single_char_lifetime_names,
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::modulo_arithmetic,
    clippy::float_arithmetic,
    clippy::indexing_slicing,
    clippy::string_slice,
    clippy::str_to_string,
    clippy::print_stdout,
    clippy::print_stderr,
    clippy::undocumented_unsafe_blocks,
    clippy::multiple_unsafe_ops_per_block,
    clippy::missing_assert_message,
    clippy::shadow_same,
    clippy::shadow_reuse,
    clippy::shadow_unrelated,
    clippy::else_if_without_else,
    clippy::impl_trait_in_params,
    unsafe_code,
    elided_lifetimes_in_paths,
    unused_qualifications
)]
#![deny(unreachable_pub)]

pub mod client_config;
pub mod conn_manager;
pub mod connection;
pub mod discovery;
pub mod error;
pub mod image_protocol;
pub mod stream;
pub mod sync;

pub use client_config::{load_client_config, ClientConfig};
pub use conn_manager::{spawn_connection, ConnCommand, ConnEvent};
pub use connection::{SWPConnection, ServerAddr};
pub use discovery::{discover, discover_config_dir, discover_data_dir, discover_or_default};
pub use error::{ClientError, DiscoveryKind, Result};
pub use image_protocol::{detect_protocol, ImageProtocol};
pub use stream::{collect_stream, StreamCallbacks, StreamHandler, StreamedResponse};
pub use sync::{SyncDecision, SyncState};

#[cfg(test)]
mod tests {
    use tokio::io::duplex;

    use shore_protocol::client_msg::ClientMessage;
    use shore_protocol::server_msg::*;
    use shore_protocol::types::*;
    use shore_protocol::{MAX_WIRE_MESSAGE_SIZE, SWP_V1};

    use crate::connection::SWPConnection;
    use crate::stream::StreamHandler;

    /// Helper: write a JSON line to a writer.
    async fn write_json_line<W: tokio::io::AsyncWriteExt + Unpin, T: serde::Serialize>(
        w: &mut W,
        val: &T,
    ) {
        let line = serde_json::to_string(val).unwrap();
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

    /// Helper: read one JSON line from a reader.
    async fn read_json_line<
        R: tokio::io::AsyncBufReadExt + Unpin,
        T: serde::de::DeserializeOwned,
    >(
        r: &mut R,
    ) -> T {
        let mut line = String::new();
        let _ignored = r.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    async fn write_raw_line<W: tokio::io::AsyncWriteExt + Unpin>(w: &mut W, line: &str) {
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

    // ── Handshake tests ──────────────────────────────────────────────

    #[tokio::test]
    async fn handshake_success() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // Server sends hello
            let server_hello = ServerMessage::Hello(ServerHello {
                v: SWP_V1,
                server_name: "test-daemon".into(),
                characters: vec![CharacterInfo::new("alice")],
            });
            write_json_line(&mut w, &server_hello).await;

            // Server reads client hello
            let client_hello: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Hello(h) = client_hello else {
                panic!("expected client hello");
            };
            assert_eq!(h.client_type, "tui");
            assert_eq!(h.client_name, "test-client");
            assert!(h.capabilities.contains(&"streaming".to_owned()));

            // Server sends history
            let history = ServerMessage::History(History {
                rid: None,
                messages: vec![Message {
                    msg_id: "m1".into(),
                    origin: None,
                    role: Role::User,
                    content: "hello".into(),
                    images: vec![],
                    content_blocks: vec![],
                    alt_index: None,
                    alt_count: None,
                    alternatives: vec![],
                    provider_key: None,
                    model: None,
                    timestamp: "2026-01-01T00:00:00Z".into(),
                }],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: Some("alice".into()),
                revision: 4,
            });
            write_json_line(&mut w, &history).await;
        });

        let (conn, server_hello, history) =
            SWPConnection::connect_raw(client_stream, "tui", "test-client", None)
                .await
                .unwrap();

        assert_eq!(server_hello.v, SWP_V1);
        assert_eq!(server_hello.server_name, "test-daemon");
        assert_eq!(server_hello.characters.len(), 1);
        assert_eq!(history.messages.len(), 1);
        assert_eq!(
            history
                .messages
                .first()
                .map(|message| message.content.as_str()),
            Some("hello")
        );
        assert_eq!(history.selected_character.as_deref(), Some("alice"));
        assert_eq!(history.revision, 4);

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_wrong_version() {
        let (client_stream, server_stream) = duplex(8192);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let bad_hello = ServerMessage::Hello(ServerHello {
                v: 999,
                server_name: "bad".into(),
                characters: vec![],
            });
            write_json_line(&mut w, &bad_hello).await;
        });

        let result = SWPConnection::connect_raw(client_stream, "tui", "test", None).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("unsupported protocol version"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn handshake_unexpected_first_message() {
        let (client_stream, server_stream) = duplex(8192);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let ping = ServerMessage::Ping(Ping {});
            write_json_line(&mut w, &ping).await;
        });

        let result = SWPConnection::connect_raw(client_stream, "tui", "test", None).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("expected server hello"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn handshake_skips_unknown_frames() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // A newer daemon emits an additive frame the client predates,
            // ahead of the hello. The client must skip it, not disconnect.
            write_raw_line(&mut w, r#"{"type":"future_warning","detail":"x"}"#).await;

            let server_hello = ServerMessage::Hello(ServerHello {
                v: SWP_V1,
                server_name: "test-daemon".into(),
                characters: vec![CharacterInfo::new("alice")],
            });
            write_json_line(&mut w, &server_hello).await;

            let client_hello: ClientMessage = read_json_line(&mut reader).await;
            assert!(matches!(client_hello, ClientMessage::Hello(_)));

            // Another unknown frame ahead of history — also skipped.
            write_raw_line(&mut w, r#"{"type":"another_future_frame"}"#).await;

            let history = ServerMessage::History(History {
                rid: None,
                messages: vec![],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: Some("alice".into()),
                revision: 1,
            });
            write_json_line(&mut w, &history).await;
        });

        let (conn, server_hello, history) =
            SWPConnection::connect_raw(client_stream, "tui", "test-client", None)
                .await
                .expect("handshake should skip unknown frames and succeed");

        assert_eq!(server_hello.server_name, "test-daemon");
        assert_eq!(history.revision, 1);

        drop(conn);
        server_handle.await.unwrap();
    }

    // ── Send/receive tests ───────────────────────────────────────────

    #[tokio::test]
    async fn send_and_receive_round_trip() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // Read client message
            let msg: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Message(m) = msg else {
                panic!("expected message");
            };
            assert_eq!(m.text, "test message");
            assert!(m.stream);

            // Send a ping back
            let pong = ServerMessage::Ping(Ping {});
            write_json_line(&mut w, &pong).await;
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let rid = conn.send_message("test message", true).await.unwrap();
        assert!(rid.is_some());

        let reply = conn.recv().await.unwrap();
        assert!(matches!(reply, ServerMessage::Ping(_)));

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn send_regen_and_command() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, _w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // Read regen
            let regen_msg: ClientMessage = read_json_line(&mut reader).await;
            assert!(matches!(regen_msg, ClientMessage::Regen(_)));

            // Read command
            let command_msg: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Command(c) = command_msg else {
                panic!("expected command");
            };
            assert_eq!(c.name, "switch_character");
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let _regen_sent = conn.send_regen(true, None).await.unwrap();
        let _command_sent = conn
            .send_command("switch_character", serde_json::json!({"name": "alice"}))
            .await
            .unwrap();

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn recv_on_eof_returns_disconnected() {
        let (client_stream, server_stream) = duplex(8192);
        drop(server_stream); // close immediately

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let result = conn.recv().await;
        assert!(result.is_err());
        assert!(
            format!("{}", result.unwrap_err()).contains("disconnected"),
            "expected disconnected error"
        );
    }

    #[tokio::test]
    async fn recv_rejects_oversized_server_message() {
        let (client_stream, server_stream) = duplex(MAX_WIRE_MESSAGE_SIZE + 4096);

        let server_handle = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let oversized = ServerMessage::Error(Error {
                rid: None,
                code: shore_protocol::error::ErrorCode::InternalError,
                message: "x".repeat(MAX_WIRE_MESSAGE_SIZE + 1),
            });
            let line = serde_json::to_string(&oversized).unwrap();
            write_raw_line(&mut w, &line).await;
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let result = conn.recv().await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("maximum size"),
            "expected explicit framing limit error, got: {err}"
        );

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_rejects_oversized_server_hello() {
        let (client_stream, server_stream) = duplex(MAX_WIRE_MESSAGE_SIZE + 4096);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let oversized = serde_json::json!({
                "type": "hello",
                "v": SWP_V1,
                "server_name": "x".repeat(MAX_WIRE_MESSAGE_SIZE + 1),
                "characters": [],
            });
            write_raw_line(&mut w, &serde_json::to_string(&oversized).unwrap()).await;
        });

        let result = SWPConnection::connect_raw(client_stream, "tui", "test-client", None).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("maximum size"),
            "expected explicit framing limit error, got: {err}"
        );
    }

    // ── StreamHandler tests ──────────────────────────────────────────

    #[test]
    fn stream_handler_assembles_chunks() {
        let mut handler = StreamHandler::new();

        let start = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            rid: None,
            regen: false,
        });
        assert!(handler.feed(&start, None).unwrap());
        assert!(handler.is_active());
        assert!(!handler.is_regen());

        let chunk1 = ServerMessage::StreamChunk(StreamChunk {
            subagent: None,
            rid: None,
            text: "Hello ".into(),
            content_type: "text".into(),
        });
        assert!(handler.feed(&chunk1, None).unwrap());

        let chunk2 = ServerMessage::StreamChunk(StreamChunk {
            subagent: None,
            rid: None,
            text: "world!".into(),
            content_type: "text".into(),
        });
        assert!(handler.feed(&chunk2, None).unwrap());

        assert_eq!(handler.assembled_text(), "Hello world!");

        let end = ServerMessage::StreamEnd(StreamEnd {
            subagent: None,
            rid: None,
            msg_id: None,
            revision: None,
            content: "Hello world!".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 10,
                    output: 5,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 100,
                    ttft_ms: 20,
                },
                model: "test-model".into(),
            },
            finish_reason: "end_turn".into(),
            is_final: true,
        });
        assert!(handler.feed(&end, None).unwrap());
        assert!(!handler.is_active());
        assert_eq!(handler.final_content(), Some("Hello world!"));
        assert_eq!(handler.metadata().unwrap().model, "test-model");
    }

    #[test]
    fn stream_handler_regen_flag() {
        let mut handler = StreamHandler::new();

        let start = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            rid: None,
            regen: true,
        });
        let _ignored = handler.feed(&start, None).unwrap();
        assert!(handler.is_regen());
    }

    #[test]
    fn stream_handler_ignores_non_stream_messages() {
        let mut handler = StreamHandler::new();
        let ping = ServerMessage::Ping(Ping {});
        assert!(!handler.feed(&ping, None).unwrap());
    }

    #[test]
    fn stream_handler_error_on_chunk_without_start() {
        let mut handler = StreamHandler::new();
        let chunk = ServerMessage::StreamChunk(StreamChunk {
            subagent: None,
            rid: None,
            text: "oops".into(),
            content_type: "text".into(),
        });
        let result = handler.feed(&chunk, None);
        assert!(result.is_err());
    }

    #[test]
    fn stream_handler_error_on_end_without_start() {
        let mut handler = StreamHandler::new();
        let end = ServerMessage::StreamEnd(StreamEnd {
            subagent: None,
            rid: None,
            msg_id: None,
            revision: None,
            content: String::new(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 0,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 0,
                    ttft_ms: 0,
                },
                model: String::new(),
            },
            finish_reason: "end_turn".into(),
            is_final: true,
        });
        let result = handler.feed(&end, None);
        assert!(result.is_err());
    }

    #[test]
    fn stream_handler_error_on_double_start() {
        let mut handler = StreamHandler::new();
        let start = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            rid: None,
            regen: false,
        });
        let _ignored = handler.feed(&start, None).unwrap();

        let start2 = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            rid: None,
            regen: false,
        });
        let result = handler.feed(&start2, None);
        assert!(result.is_err());
    }

    #[test]
    fn stream_handler_callbacks_invoked() {
        use std::sync::{Arc, Mutex};

        struct TestCallbacks {
            started: Arc<Mutex<bool>>,
            chunk_count: Arc<Mutex<u32>>,
            ended: Arc<Mutex<bool>>,
        }

        impl crate::stream::StreamCallbacks for TestCallbacks {
            fn on_start(&mut self, _start: &StreamStart) {
                *self.started.lock().unwrap() = true;
            }
            fn on_chunk(&mut self, _chunk: &StreamChunk) {
                *self.chunk_count.lock().unwrap() += 1;
            }
            fn on_end(&mut self, _end: &StreamEnd) {
                *self.ended.lock().unwrap() = true;
            }
        }

        let started = Arc::new(Mutex::new(false));
        let chunk_count = Arc::new(Mutex::new(0_u32));
        let ended = Arc::new(Mutex::new(false));

        let mut cb = TestCallbacks {
            started: Arc::clone(&started),
            chunk_count: Arc::clone(&chunk_count),
            ended: Arc::clone(&ended),
        };

        let mut handler = StreamHandler::new();

        let start = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            rid: None,
            regen: false,
        });
        let _fed_start = handler.feed(&start, Some(&mut cb)).unwrap();
        assert!(*started.lock().unwrap());

        let chunk = ServerMessage::StreamChunk(StreamChunk {
            subagent: None,
            rid: None,
            text: "hi".into(),
            content_type: "text".into(),
        });
        let _fed_chunk = handler.feed(&chunk, Some(&mut cb)).unwrap();
        let _fed_chunk_again = handler.feed(&chunk, Some(&mut cb)).unwrap();
        assert_eq!(*chunk_count.lock().unwrap(), 2);

        let end = ServerMessage::StreamEnd(StreamEnd {
            subagent: None,
            rid: None,
            msg_id: None,
            revision: None,
            content: "hihi".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 1,
                    output: 1,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 10,
                    ttft_ms: 5,
                },
                model: "m".into(),
            },
            finish_reason: "end_turn".into(),
            is_final: true,
        });
        let _fed_end = handler.feed(&end, Some(&mut cb)).unwrap();
        assert!(*ended.lock().unwrap());
    }

    #[test]
    fn stream_handler_reset_allows_reuse() {
        let mut handler = StreamHandler::new();

        // First stream
        let start = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            rid: None,
            regen: false,
        });
        let _fed_start = handler.feed(&start, None).unwrap();
        let chunk = ServerMessage::StreamChunk(StreamChunk {
            subagent: None,
            rid: None,
            text: "first".into(),
            content_type: "text".into(),
        });
        let _fed_chunk = handler.feed(&chunk, None).unwrap();
        let end = ServerMessage::StreamEnd(StreamEnd {
            subagent: None,
            rid: None,
            msg_id: None,
            revision: None,
            content: "first".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 1,
                    output: 1,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 10,
                    ttft_ms: 5,
                },
                model: "m".into(),
            },
            finish_reason: "end_turn".into(),
            is_final: true,
        });
        let _fed_end = handler.feed(&end, None).unwrap();

        // Second stream — feed automatically resets on stream_start
        let start2 = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            rid: None,
            regen: true,
        });
        let _fed_start2 = handler.feed(&start2, None).unwrap();
        assert!(handler.is_active());
        assert!(handler.is_regen());
        assert_eq!(handler.assembled_text(), "");
    }

    // ── Discovery tests ──────────────────────────────────────────────

    #[test]
    fn discovery_instances_path_uses_xdg() {
        // Save and restore env
        let orig = std::env::var("XDG_RUNTIME_DIR").ok();
        std::env::set_var("XDG_RUNTIME_DIR", "/tmp/test-xdg");
        let path = crate::discovery::instances_path();
        assert_eq!(path.to_str().unwrap(), "/tmp/test-xdg/shore/instances.json");
        // Restore
        match orig {
            Some(v) => std::env::set_var("XDG_RUNTIME_DIR", v),
            None => std::env::remove_var("XDG_RUNTIME_DIR"),
        }
    }

    // ── ClientConfig tests ──────────────────────────────────────────

    #[test]
    fn client_config_parses_tcp_address() {
        let toml = r#"default_address = "192.168.1.50:7320""#;
        let cfg: crate::client_config::ClientConfig = toml::from_str(toml).unwrap();
        assert_eq!(cfg.default_address.as_deref(), Some("192.168.1.50:7320"));
    }

    #[test]
    fn client_config_empty_file() {
        let cfg: crate::client_config::ClientConfig = toml::from_str("").unwrap();
        assert!(cfg.default_address.is_none());
    }

    #[test]
    fn client_config_rejects_unknown_fields() {
        let toml = r#"unknown_field = "oops""#;
        let result = toml::from_str::<crate::client_config::ClientConfig>(toml);
        assert!(result.is_err());
    }

    // ── collect_stream tests ─────────────────────────────────────────

    #[tokio::test]
    async fn collect_stream_aggregates_full_response() {
        use crate::stream::{collect_stream, StreamedResponse};
        use shore_protocol::server_msg::*;
        use shore_protocol::types::*;

        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            // Send a complete stream sequence.
            write_json_line(
                &mut w,
                &ServerMessage::StreamStart(StreamStart {
                    subagent: None,
                    rid: None,
                    regen: false,
                }),
            )
            .await;
            write_json_line(
                &mut w,
                &ServerMessage::StreamChunk(StreamChunk {
                    subagent: None,
                    rid: None,
                    text: "partial ".into(),
                    content_type: "text".into(),
                }),
            )
            .await;
            write_json_line(
                &mut w,
                &ServerMessage::StreamChunk(StreamChunk {
                    subagent: None,
                    rid: None,
                    text: "text".into(),
                    content_type: "text".into(),
                }),
            )
            .await;
            write_json_line(
                &mut w,
                &ServerMessage::StreamEnd(StreamEnd {
                    subagent: None,
                    rid: None,
                    msg_id: None,
                    revision: None,
                    content: "partial text".into(),
                    metadata: StreamMetadata {
                        tokens: TokenCounts {
                            input: 10,
                            output: 5,
                            cache_read: 0,
                            cache_write: 0,
                        },
                        timing: TimingInfo {
                            total_ms: 100,
                            ttft_ms: 20,
                        },
                        model: "test-model".into(),
                    },
                    finish_reason: "end_turn".into(),
                    is_final: true,
                }),
            )
            .await;
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let response: StreamedResponse = collect_stream(&mut conn).await.unwrap();

        assert_eq!(response.text, "partial text");
        assert!(response.tool_calls.is_empty());
        assert!(response.tool_results.is_empty());
        assert_eq!(response.metadata.model, "test-model");
        assert_eq!(response.finish_reason, "end_turn");

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn collect_stream_propagates_server_error() {
        use crate::stream::collect_stream;
        use shore_protocol::server_msg::*;

        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            write_json_line(
                &mut w,
                &ServerMessage::Error(Error {
                    rid: None,
                    code: shore_protocol::error::ErrorCode::InternalError,
                    message: "llm blew up".into(),
                }),
            )
            .await;
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let result = collect_stream(&mut conn).await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("llm blew up"));

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn collect_stream_propagates_eof_as_disconnected() {
        use crate::stream::collect_stream;

        let (client_stream, server_stream) = duplex(8192);
        drop(server_stream);

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let result = collect_stream(&mut conn).await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("disconnected"));
    }

    /// Regression: collect_stream must span a daemon-side tool loop.
    ///
    /// The daemon emits one StreamEnd per LLM turn so that streaming clients
    /// can render intermediate tool calls. Only the terminal StreamEnd has
    /// `is_final = true`. Aggregating callers (shore-mcp's `send` tool, etc.)
    /// must keep reading past non-final StreamEnds — otherwise they return
    /// the intermediate "Let me search memory—" text, miss the ToolCall
    /// and ToolResult frames entirely, and surface the wrong finish_reason.
    #[tokio::test]
    async fn collect_stream_spans_tool_loop_to_final_end() {
        use crate::stream::{collect_stream, StreamedResponse};

        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(write_tool_loop_script(server_stream));

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let response: StreamedResponse = collect_stream(&mut conn).await.unwrap();

        // The aggregated response must be the FINAL turn's text, not the
        // intermediate preface.
        assert_eq!(response.text, "Of course — her name is Maya.");
        assert_eq!(response.finish_reason, "end_turn");
        assert_eq!(response.metadata.model, "turn-2");

        // Tool frames emitted between the two StreamEnds must be captured.
        assert_eq!(
            response.tool_calls.len(),
            1,
            "one ToolCall frame must be collected"
        );
        assert_eq!(
            response
                .tool_calls
                .first()
                .map(|tool_call| tool_call.tool_name.as_str()),
            Some("memory_search")
        );
        assert_eq!(
            response.tool_results.len(),
            1,
            "one ToolResult frame must be collected"
        );
        assert_eq!(
            response
                .tool_results
                .first()
                .map(|tool_result| tool_result.tool_id.as_str()),
            Some("toolu_01")
        );

        drop(conn);
        server_handle.await.unwrap();
    }

    #[expect(
        clippy::too_many_lines,
        reason = "test script builds many wire frames inline"
    )]
    async fn write_tool_loop_script(server_stream: tokio::io::DuplexStream) {
        fn meta(model: &str) -> StreamMetadata {
            StreamMetadata {
                tokens: TokenCounts {
                    input: 1,
                    output: 1,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 1,
                    ttft_ms: 1,
                },
                model: model.into(),
            }
        }
        let (_r, mut w) = tokio::io::split(server_stream);

        // Turn 1: preface text, then finish with an intermediate StreamEnd.
        write_json_line(
            &mut w,
            &ServerMessage::StreamStart(StreamStart {
                subagent: None,
                rid: None,
                regen: false,
            }),
        )
        .await;
        write_json_line(
            &mut w,
            &ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                rid: None,
                text: "Let me search memory—".into(),
                content_type: "text".into(),
            }),
        )
        .await;
        write_json_line(
            &mut w,
            &ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                rid: None,
                msg_id: None,
                revision: None,
                content: "Let me search memory—".into(),
                metadata: meta("turn-1"),
                finish_reason: "tool_use".into(),
                is_final: false,
            }),
        )
        .await;

        // Tool phase: the daemon emits one ToolCall and one ToolResult.
        write_json_line(
            &mut w,
            &ServerMessage::ToolCall(ToolCall {
                subagent: None,
                rid: None,
                tool_id: "toolu_01".into(),
                tool_name: "memory_search".into(),
                input: serde_json::json!({"query": "sister"}),
            }),
        )
        .await;
        write_json_line(
            &mut w,
            &ServerMessage::ToolResult(ToolResult {
                subagent: None,
                rid: None,
                tool_id: "toolu_01".into(),
                tool_name: "memory_search".into(),
                output: "Your sister's name is Maya.".into(),
                is_error: false,
            }),
        )
        .await;

        // Turn 2: the final LLM response, with is_final=true.
        write_json_line(
            &mut w,
            &ServerMessage::StreamStart(StreamStart {
                subagent: None,
                rid: None,
                regen: false,
            }),
        )
        .await;
        write_json_line(
            &mut w,
            &ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                rid: None,
                text: "Of course — her name is Maya.".into(),
                content_type: "text".into(),
            }),
        )
        .await;
        write_json_line(
            &mut w,
            &ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                rid: None,
                msg_id: None,
                revision: None,
                content: "Of course — her name is Maya.".into(),
                metadata: meta("turn-2"),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        )
        .await;
    }
}
