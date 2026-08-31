pub mod client_msg;
pub mod error;
pub mod server_msg;
pub mod tool_display;
pub mod types;

pub const SWP_V1: u32 = 1;

pub(crate) const MAX_WIRE_MESSAGE_SIZE: usize = 128 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::protocol::client_msg::*;
    use crate::protocol::error::*;
    use crate::protocol::server_msg::*;
    use crate::protocol::types::*;
    use crate::protocol::{MAX_WIRE_MESSAGE_SIZE, SWP_V1};

    fn round_trip<T: serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug>(
        val: &T,
    ) -> (serde_json::Value, T) {
        let json = serde_json::to_value(val).expect("serialize");
        let back: T = serde_json::from_value(json.clone()).expect("deserialize");
        (json, back)
    }

    fn field<'val>(value: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        value.get(key).expect("expected JSON field")
    }

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    #[test]
    fn protocol_version_constant() {
        assert_eq!(SWP_V1, 1);
    }

    #[test]
    fn wire_message_size_constant() {
        assert_eq!(MAX_WIRE_MESSAGE_SIZE, 128 * 1024 * 1024);
    }

    #[test]
    fn client_hello_round_trip() {
        let msg = ClientMessage::Hello(ClientHello {
            client_type: "tui".into(),
            client_name: "shore".into(),
            capabilities: vec!["streaming".into()],
            character: None,
            token: Some("s3cret".into()),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "hello");
        assert_eq!(field(&json, "client_type"), "tui");
        assert_eq!(field(&json, "token"), "s3cret");
    }

    #[test]
    fn a_tokenless_hello_still_parses() {
        let json = serde_json::json!({
            "type": "hello",
            "client_type": "tui",
            "client_name": "old-client",
        });
        let msg: ClientMessage = serde_json::from_value(json).expect("parses");
        match msg {
            ClientMessage::Hello(h) => assert_eq!(h.token, None),
            ClientMessage::Message(_)
            | ClientMessage::Regen(_)
            | ClientMessage::Command(_)
            | ClientMessage::Cancel(_) => panic!("Expected Hello"),
        }
    }

    #[test]
    fn client_message_round_trip() {
        let msg = ClientMessage::Message(ClientMessageBody {
            rid: Some("msg_01".into()),
            text: "Hello world".into(),
            stream: true,
            images: vec![],
            image_data: vec![],
            absence_seconds: None,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "message");
        assert_eq!(field(&json, "text"), "Hello world");
        assert_eq!(field(&json, "stream"), true);
    }

    #[test]
    fn client_regen_round_trip() {
        let msg = ClientMessage::Regen(Regen {
            rid: Some("regen_01".into()),
            stream: true,
            guidance: Some("consult memory".into()),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "regen");
        assert_eq!(field(&json, "guidance"), "consult memory");
    }

    #[test]
    fn client_command_round_trip() {
        let msg = ClientMessage::Command(Command {
            rid: Some("cmd_01".into()),
            name: "switch_character".into(),
            args: json!({"name": "alice"}),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "command");
        assert_eq!(field(&json, "name"), "switch_character");
        assert_eq!(field(field(&json, "args"), "name"), "alice");
    }

    #[test]
    fn server_hello_round_trip() {
        let msg = ServerMessage::Hello(ServerHello {
            v: SWP_V1,
            server_name: "shore-daemon".into(),
            characters: vec![CharacterInfo::new("alice")],
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "hello");
        assert_eq!(field(&json, "v"), 1);
    }

    #[test]
    fn server_history_round_trip() {
        let msg = ServerMessage::History(History {
            rid: None,
            messages: vec![Message {
                msg_id: "m1".into(),
                origin: None,
                role: Role::User,
                content: "hi".into(),
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
            config: json!({}),
            selected_character: Some("alice".into()),
            revision: 7,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "history");
        let messages = field(&json, "messages").as_array().expect("messages array");
        assert_eq!(field(item(messages, 0), "role"), "user");
        assert_eq!(field(&json, "selected_character"), "alice");
        assert_eq!(field(&json, "revision"), 7);
    }

    #[test]
    fn server_request_history_round_trip() {
        let msg = ServerMessage::History(History {
            rid: Some("cmd_switch_01".into()),
            messages: vec![],
            active_start: 0,
            config: json!({}),
            selected_character: Some("alice".into()),
            revision: 8,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "history");
        assert_eq!(field(&json, "rid"), "cmd_switch_01");
        assert_eq!(field(&json, "revision"), 8);
    }

    #[test]
    fn server_shutdown_round_trip() {
        let msg = ServerMessage::Shutdown(Shutdown {});
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "shutdown");
    }

    #[test]
    fn server_ping_round_trip() {
        let msg = ServerMessage::Ping(Ping {});
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "ping");
    }

    #[test]
    fn server_command_output_round_trip() {
        let msg = ServerMessage::CommandOutput(CommandOutput {
            rid: Some("cmd_01".into()),
            name: "status".into(),
            data: json!({"ok": true}),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "command_output");
        assert_eq!(field(&json, "rid"), "cmd_01");
        assert_eq!(field(&json, "name"), "status");
    }

    #[test]
    fn server_error_round_trip() {
        let msg = ServerMessage::Error(Error {
            rid: Some("msg_01".into()),
            code: ErrorCode::Busy,
            message: "engine busy".into(),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "error");
        assert_eq!(field(&json, "rid"), "msg_01");
        assert_eq!(field(&json, "code"), "busy");
    }

    #[test]
    fn server_stream_start_round_trip() {
        let msg = ServerMessage::StreamStart(StreamStart {
            subagent: None,
            task_id: None,
            rid: Some("msg_01".into()),
            regen: false,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "stream_start");
        assert_eq!(field(&json, "rid"), "msg_01");
        assert_eq!(field(&json, "regen"), false);
    }

    #[test]
    fn server_stream_chunk_round_trip() {
        let msg = ServerMessage::StreamChunk(StreamChunk {
            subagent: None,
            task_id: None,
            rid: Some("msg_01".into()),
            text: "partial".into(),
            content_type: "text".into(),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "stream_chunk");
        assert_eq!(field(&json, "rid"), "msg_01");
        assert_eq!(field(&json, "content_type"), "text");
    }

    #[test]
    fn server_stream_chunk_thinking() {
        let msg = ServerMessage::StreamChunk(StreamChunk {
            subagent: None,
            task_id: None,
            rid: Some("msg_01".into()),
            text: "hmm...".into(),
            content_type: "thinking".into(),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "rid"), "msg_01");
        assert_eq!(field(&json, "content_type"), "thinking");
    }

    #[test]
    fn server_stream_end_round_trip() {
        let msg = ServerMessage::StreamEnd(StreamEnd {
            subagent: None,
            task_id: None,
            rid: Some("msg_01".into()),
            msg_id: None,
            revision: None,
            content: "full response".into(),
            terminal_content_blocks: Some(vec![ContentBlock::Text {
                text: "full response".into(),
            }]),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 1234,
                    output: 567,
                    cache_read: 890,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 2340,
                    ttft_ms: 450,
                },
                model: "claude-haiku-4-5-20251001".into(),
            },
            finish_reason: "end_turn".into(),
            is_final: true,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "stream_end");
        assert_eq!(field(&json, "rid"), "msg_01");
        assert!(json.get("msg_id").is_none());
        assert!(json.get("revision").is_none());
        assert_eq!(
            field(&json, "terminal_content_blocks"),
            &serde_json::json!([{"type": "text", "text": "full response"}])
        );
        let metadata = field(&json, "metadata");
        let tokens = field(metadata, "tokens");
        let timing = field(metadata, "timing");
        assert_eq!(field(tokens, "input"), 1234);
        assert_eq!(field(tokens, "cache_read"), 890);
        assert_eq!(field(timing, "total_ms"), 2340);
        assert_eq!(field(timing, "ttft_ms"), 450);
        assert_eq!(field(metadata, "model"), "claude-haiku-4-5-20251001");
    }

    #[test]
    fn server_phase_round_trip() {
        for phase_val in &["thinking", "text_generation", "tool_use"] {
            let msg = ServerMessage::Phase(Phase {
                rid: Some("msg_01".into()),
                phase: phase_val.to_string(),
                model: Some("test-model".into()),
            });
            let (json, _back) = round_trip(&msg);
            assert_eq!(field(&json, "type"), "phase");
            assert_eq!(field(&json, "rid"), "msg_01");
            assert_eq!(field(&json, "phase"), *phase_val);
        }
    }

    #[test]
    fn server_new_message_round_trip() {
        let msg = ServerMessage::NewMessage(NewMessage {
            revision: 3,
            character: Some("Alice".into()),
            message: Message {
                msg_id: "m2".into(),
                origin: Some(MessageOrigin::Autonomous),
                role: Role::Assistant,
                content: "autonomous msg".into(),
                images: vec![],
                content_blocks: vec![],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                provider_key: None,
                model: None,
                timestamp: "2026-01-01T00:00:01Z".into(),
            },
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "new_message");
        assert_eq!(field(&json, "character"), "Alice");
        assert_eq!(field(&json, "origin"), "autonomous");
        assert_eq!(field(&json, "msg_id"), "m2");
        assert_eq!(field(&json, "revision"), 3);
    }

    #[test]
    fn server_tool_call_round_trip() {
        let msg = ServerMessage::ToolCall(ToolCall {
            subagent: None,
            task_id: None,
            rid: Some("msg_01".into()),
            tool_id: "t1".into(),
            tool_name: "search".into(),
            input: json!({"query": "rust serde"}),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "tool_call");
        assert_eq!(field(&json, "rid"), "msg_01");
        let input = field(&json, "input");
        assert_eq!(field(input, "query"), "rust serde");
        assert!(input.is_object());
    }

    #[test]
    fn server_tool_result_round_trip() {
        let msg = ServerMessage::ToolResult(ToolResult {
            subagent: None,
            task_id: None,
            rid: Some("msg_01".into()),
            tool_id: "t1".into(),
            tool_name: "search".into(),
            output: "found 5 results".into(),
            is_error: false,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "tool_result");
        assert_eq!(field(&json, "rid"), "msg_01");
    }

    #[test]
    fn server_send_image_round_trip() {
        let msg = ServerMessage::SendImage(SendImage {
            subagent: None,
            task_id: None,
            rid: Some("msg_01".into()),
            path: "/tmp/img.png".into(),
            caption: Some("generated chart".into()),
            data: None,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "send_image");
        assert_eq!(field(&json, "rid"), "msg_01");
        assert_eq!(field(&json, "path"), "/tmp/img.png");
        assert_eq!(field(&json, "caption"), "generated chart");
    }

    #[test]
    fn server_cache_warning_round_trip() {
        let msg = ServerMessage::CacheWarning(CacheWarning {
            expected_tokens: 5000,
            message: "cache miss".into(),
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "cache_warning");
        assert_eq!(field(&json, "expected_tokens"), 5000);
    }

    #[test]
    fn server_usage_warning_round_trip() {
        let msg = ServerMessage::UsageWarning(UsageWarning {
            rid: Some("msg_01".into()),
            budget: "daily total".into(),
            message: "Usage budget \"daily total\" reached 80% ($8.00/$10.00).".into(),
            current_cost: 8.0,
            cost_limit: 10.0,
            percent_used: 0.8,
            crossed_warn_at: vec![0.8],
            period: "day".into(),
            period_start: "2026-05-18T00:00:00Z".into(),
            reset_at: "2026-05-19T00:00:00Z".into(),
            reset_at_display: "2026-05-19 10:00 AM".into(),
            scope: None,
        });
        let (json, _back) = round_trip(&msg);
        assert_eq!(field(&json, "type"), "usage_warning");
        assert_eq!(field(&json, "rid"), "msg_01");
        assert_eq!(field(&json, "budget"), "daily total");
    }

    #[test]
    fn message_with_all_fields() {
        let msg = Message {
            msg_id: "m3".into(),
            origin: None,
            role: Role::Assistant,
            content: "response".into(),
            images: vec![ImageRef {
                path: "/img/a.png".into(),
                caption: Some("photo".into()),
                data: None,
            }],
            content_blocks: vec![],
            alt_index: Some(0),
            alt_count: Some(1),
            alternatives: vec![MessageAlternative {
                content: "response".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "response".into(),
                }],
                timestamp: "2026-01-01T00:00:00Z".into(),
                provider_key: Some("openrouter".into()),
                model: Some("anthropic/claude-opus-4.6".into()),
            }],
            timestamp: "2026-01-01T00:00:00Z".into(),
            provider_key: Some("anthropic".into()),
            model: Some("claude-opus-4-6".into()),
        };
        let (json, back) = round_trip(&msg);
        assert_eq!(field(&json, "alt_index"), 0);
        assert_eq!(field(&json, "alt_count"), 1);
        assert_eq!(field(&json, "model"), "claude-opus-4-6");
        let alternatives = field(&json, "alternatives")
            .as_array()
            .expect("alternatives array");
        let images = field(&json, "images").as_array().expect("images array");
        assert_eq!(field(item(alternatives, 0), "content"), "response");
        assert_eq!(
            field(item(alternatives, 0), "model"),
            "anthropic/claude-opus-4.6"
        );
        assert_eq!(field(item(images, 0), "path"), "/img/a.png");
        assert_eq!(back.alt_index, Some(0));
        assert_eq!(back.alt_count, Some(1));
        assert_eq!(back.alternatives.len(), 1);
        assert_eq!(back.model.as_deref(), Some("claude-opus-4-6"));
    }

    #[test]
    fn message_without_alts_omits_fields() {
        let msg = Message {
            msg_id: "m4".into(),
            origin: None,
            role: Role::User,
            content: "hi".into(),
            images: vec![],
            content_blocks: vec![],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert!(json.get("alt_index").is_none());
        assert!(json.get("alt_count").is_none());
        assert!(json.get("alternatives").is_none());
        assert!(json.get("provider_key").is_none());
        assert!(json.get("model").is_none());
    }

    #[test]
    fn stream_metadata_nested_structure() {
        let meta = StreamMetadata {
            tokens: TokenCounts {
                input: 100,
                output: 50,
                cache_read: 0,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 1000,
                ttft_ms: 200,
            },
            model: "test".into(),
        };
        let (json, _back) = round_trip(&meta);
        let tokens = field(&json, "tokens");
        let timing = field(&json, "timing");
        assert!(tokens.is_object());
        assert!(timing.is_object());
        assert_eq!(field(tokens, "input"), 100);
        assert_eq!(field(timing, "ttft_ms"), 200);
    }

    #[test]
    fn error_code_all_variants() {
        let codes = [
            ErrorCode::ProtocolError,
            ErrorCode::InvalidRequest,
            ErrorCode::NotFound,
            ErrorCode::Busy,
            ErrorCode::ProviderError,
            ErrorCode::Timeout,
            ErrorCode::InternalError,
        ];
        let expected = [
            "protocol_error",
            "invalid_request",
            "not_found",
            "busy",
            "provider_error",
            "timeout",
            "internal_error",
        ];
        for (code, exp) in codes.iter().zip(expected.iter()) {
            let json = serde_json::to_value(code).unwrap();
            assert_eq!(json.as_str().unwrap(), *exp);
        }
    }

    #[test]
    fn character_info_round_trip() {
        let info = CharacterInfo::new("alice");
        let (json, back) = round_trip(&info);
        assert!(json.get("avatar").is_none());
        assert_eq!(back.name, "alice");
        assert_eq!(back.avatar, None);
    }

    #[test]
    fn character_info_avatar_round_trip() {
        let info = CharacterInfo {
            name: "alice".into(),
            avatar: Some(CharacterAvatar {
                mime_type: "image/png".into(),
                data: "AQID".into(),
            }),
        };
        let (json, back) = round_trip(&info);
        assert_eq!(field(field(&json, "avatar"), "mime_type"), "image/png");
        assert_eq!(back.avatar.unwrap().data, "AQID");
    }

    #[test]
    fn role_serialization() {
        assert_eq!(serde_json::to_value(Role::User).unwrap(), "user");
        assert_eq!(serde_json::to_value(Role::Assistant).unwrap(), "assistant");
        assert_eq!(serde_json::to_value(Role::System).unwrap(), "system");
    }

    #[test]
    fn content_block_text_round_trip() {
        let block = ContentBlock::Text {
            text: "hello world".into(),
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(field(&json, "type"), "text");
        assert_eq!(field(&json, "text"), "hello world");
        let back: ContentBlock = serde_json::from_value(json).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn content_block_thinking_round_trip() {
        let block = ContentBlock::Thinking {
            thinking: "Let me consider...".into(),
            signature: None,
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(field(&json, "type"), "thinking");
        assert_eq!(field(&json, "thinking"), "Let me consider...");
        let back: ContentBlock = serde_json::from_value(json).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn content_block_thinking_with_signature_round_trip() {
        let block = ContentBlock::Thinking {
            thinking: "Let me consider...".into(),
            signature: Some("sig_abc123".into()),
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(field(&json, "type"), "thinking");
        assert_eq!(field(&json, "thinking"), "Let me consider...");
        assert_eq!(field(&json, "signature"), "sig_abc123");
        let back: ContentBlock = serde_json::from_value(json).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn content_block_redacted_thinking_round_trip() {
        let block = ContentBlock::RedactedThinking {
            data: "opaque_data_abc".into(),
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(field(&json, "type"), "redacted_thinking");
        assert_eq!(field(&json, "data"), "opaque_data_abc");
        let back: ContentBlock = serde_json::from_value(json).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn content_block_thinking_without_signature_compat() {
        let json = json!({"type": "thinking", "thinking": "old block"});
        let block: ContentBlock = serde_json::from_value(json).unwrap();
        let ContentBlock::Thinking {
            thinking,
            signature,
        } = block
        else {
            panic!("Expected Thinking");
        };
        assert_eq!(thinking, "old block");
        assert!(signature.is_none());
    }

    #[test]
    fn content_block_tool_use_round_trip() {
        let block = ContentBlock::ToolUse {
            id: "tu_123".into(),
            name: "check_time".into(),
            input: json!({"timezone": "UTC"}),
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(field(&json, "type"), "tool_use");
        assert_eq!(field(&json, "id"), "tu_123");
        assert_eq!(field(&json, "name"), "check_time");
        assert_eq!(field(field(&json, "input"), "timezone"), "UTC");
        let back: ContentBlock = serde_json::from_value(json).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn content_block_tool_result_round_trip() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "tu_123".into(),
            content: "2026-03-27T12:00:00Z".into(),
            is_error: false,
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(field(&json, "type"), "tool_result");
        assert_eq!(field(&json, "tool_use_id"), "tu_123");
        assert_eq!(field(&json, "content"), "2026-03-27T12:00:00Z");
        let back: ContentBlock = serde_json::from_value(json).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn content_block_tool_result_with_error() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "tu_456".into(),
            content: "Tool not found".into(),
            is_error: true,
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(field(&json, "is_error"), true);
        let back: ContentBlock = serde_json::from_value(json).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn content_block_tool_result_is_error_defaults_false() {
        let json = json!({"type": "tool_result", "tool_use_id": "tu_1", "content": "ok"});
        let block: ContentBlock = serde_json::from_value(json).unwrap();
        let ContentBlock::ToolResult { is_error, .. } = block else {
            panic!("Expected ToolResult");
        };
        assert!(!is_error);
    }

    #[test]
    fn message_with_content_blocks_round_trip() {
        let msg = Message {
            msg_id: "m_test".into(),
            origin: None,
            role: Role::Assistant,
            content: "The time is noon.".into(),
            images: vec![],
            content_blocks: vec![
                ContentBlock::Thinking {
                    thinking: "User wants the time.".into(),
                    signature: None,
                },
                ContentBlock::ToolUse {
                    id: "tu_1".into(),
                    name: "check_time".into(),
                    input: json!({}),
                },
                ContentBlock::Text {
                    text: "The time is noon.".into(),
                },
            ],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&msg).unwrap();
        let blocks = field(&json, "content_blocks").as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(field(item(blocks, 0), "type"), "thinking");
        assert_eq!(field(item(blocks, 1), "type"), "tool_use");
        assert_eq!(field(item(blocks, 2), "type"), "text");
        let back: Message = serde_json::from_value(json).unwrap();
        assert_eq!(back.content_blocks.len(), 3);
        assert_eq!(back.content_blocks, msg.content_blocks);
    }

    #[test]
    fn message_always_includes_content_blocks() {
        let msg = Message {
            msg_id: "m_old".into(),
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
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert!(
            json.get("content_blocks").is_some(),
            "content_blocks should always be serialized"
        );
    }

    #[test]
    fn old_message_json_without_content_blocks_deserializes() {
        let json = json!({
            "msg_id": "m_legacy",
            "role": "assistant",
            "content": "old message",
            "timestamp": "2025-01-01T00:00:00Z"
        });
        let msg: Message = serde_json::from_value(json).unwrap();
        assert!(msg.content_blocks.is_empty());
        assert_eq!(msg.content, "old message");
    }
}
