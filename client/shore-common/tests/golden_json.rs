// allow-expect-in-tests doesn't reach non-#[test] helpers in integration tests.
#![expect(
    clippy::expect_used,
    reason = "golden fixture helpers intentionally fail fast when checked-in protocol JSON is malformed"
)]

use serde_json::{Value, json};
use shore_common::protocol::SWP_V1;
use shore_common::protocol::client_msg::*;
use shore_common::protocol::error::*;
use shore_common::protocol::server_msg::*;
use shore_common::protocol::types::*;

macro_rules! assert_variant {
    ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
        let $pattern = $value else {
            panic!("expected enum variant did not match");
        };
        $body
    }};
}

fn assert_golden<T>(fixture: &str) -> T
where
    T: serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug,
{
    let expected: Value = serde_json::from_str(fixture).expect("fixture is valid JSON");
    let parsed: T = serde_json::from_str(fixture).expect("fixture deserializes into T");
    let reserialized = serde_json::to_value(&parsed).expect("re-serialize");
    assert_eq!(
        whole_floats_as_integers(reserialized),
        whole_floats_as_integers(expected),
        "re-serialized JSON does not match fixture"
    );
    parsed
}

const MAX_EXACT_FLOAT_INTEGER: f64 = 9_007_199_254_740_992.0;

fn whole_floats_as_integers(value: Value) -> Value {
    match value {
        Value::Number(number) => match number.as_f64() {
            Some(float)
                if number.is_f64()
                    && float.fract() == 0.0
                    && float.abs() <= MAX_EXACT_FLOAT_INTEGER =>
            {
                format!("{float:.0}")
                    .parse::<i64>()
                    .map_or(Value::Number(number), Value::from)
            }
            _ => Value::Number(number),
        },
        Value::Array(items) => {
            Value::Array(items.into_iter().map(whole_floats_as_integers).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, item)| (key, whole_floats_as_integers(item)))
                .collect(),
        ),
        other @ (Value::Null | Value::Bool(_) | Value::String(_)) => other,
    }
}

fn field<'val>(value: &'val Value, key: &str) -> &'val Value {
    value.get(key).expect("expected JSON field")
}

const SHARED_FIXTURES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../daemon/tests/handler_captures/wire_fixtures.json"
));

fn shared_fixture(section: &str, name: Option<&str>) -> String {
    let all: Value = serde_json::from_str(SHARED_FIXTURES).expect("shared fixtures are valid JSON");
    let part = field(&all, section);
    let value = name.map_or(part, |key| field(part, key));
    serde_json::to_string(value).expect("a JSON value re-encodes")
}

fn item<T>(items: &[T], index: usize) -> &T {
    items.get(index).expect("expected item")
}

#[test]
fn server_hello_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("server_hello")));
    assert_variant!(
    msg,
    ServerMessage::Hello(h) => {
        assert_eq!(h.v, SWP_V1);
        assert_eq!(h.server_name, "shore-daemon");
        assert_eq!(h.characters.len(), 2);
        assert_eq!(item(&h.characters, 0).name, "alice");
        assert_eq!(item(&h.characters, 0).avatar, None);
        assert_eq!(item(&h.characters, 1).name, "bob");
    }
    );
}

#[test]
fn server_hello_with_avatar_golden() {
    let msg: ServerMessage =
        assert_golden(&shared_fixture("server", Some("server_hello_with_avatar")));
    assert_variant!(
    msg,
    ServerMessage::Hello(h) => {
        let avatar = item(&h.characters, 0).avatar.as_ref().expect("avatar");
        assert_eq!(avatar.mime_type, "image/png");
        assert_eq!(avatar.data, "cG5n");
    }
    );
}

#[test]
fn history_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("history")));
    assert_variant!(
    msg,
    ServerMessage::History(h) => {
        assert_eq!(h.messages.len(), 2);
        let first = item(&h.messages, 0);
        assert_eq!(first.msg_id, "m_001");
        assert_eq!(first.role, Role::User);
        assert_eq!(first.content, "Hello!");
        assert!(first.images.is_empty());
        assert_eq!(first.alt_index, None);
        assert_eq!(first.alt_count, None);
        let second = item(&h.messages, 1);
        assert_eq!(second.msg_id, "m_002");
        assert_eq!(second.role, Role::Assistant);
        assert_eq!(second.images.len(), 1);
        let image = item(&second.images, 0);
        assert_eq!(image.path, "/img/wave.png");
        assert_eq!(image.caption.as_deref(), Some("waving"));
        assert_eq!(second.alt_index, Some(0));
        assert_eq!(second.alt_count, Some(2));
        assert_eq!(field(&h.config, "model"), "claude-haiku-4-5-20251001");
        assert_eq!(h.selected_character.as_deref(), Some("alice"));
        assert_eq!(h.active_start, 0);
        assert_eq!(h.revision, 12);
    }
    );
}

#[test]
fn shutdown_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("shutdown")));
    assert!(matches!(msg, ServerMessage::Shutdown(_)));
}

#[test]
fn ping_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("ping")));
    assert!(matches!(msg, ServerMessage::Ping(_)));
}

#[test]
fn command_output_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("command_output")));
    assert_variant!(
    msg,
    ServerMessage::CommandOutput(co) => {
        assert_eq!(co.rid.as_deref(), Some("cmd_01"));
        assert_eq!(co.name, "list_conversations");
        let conversations = field(&co.data, "conversations")
            .as_array()
            .expect("conversations array");
        assert_eq!(field(item(conversations, 0), "id"), "c1");
    }
    );
}

#[test]
fn error_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("error")));
    assert_variant!(
    msg,
    ServerMessage::Error(e) => {
        assert_eq!(e.rid.as_deref(), Some("msg_01"));
        assert_eq!(e.code, ErrorCode::Busy);
        assert_eq!(e.message, "Engine is currently processing another request");
    }
    );
}

#[test]
fn stream_start_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("stream_start")));
    assert_variant!(
    msg,
    ServerMessage::StreamStart(s) => {
        assert_eq!(s.rid.as_deref(), Some("msg_01"));
        assert!(!s.regen);
    }
    );
}

#[test]
fn stream_chunk_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("stream_chunk")));
    assert_variant!(
    msg,
    ServerMessage::StreamChunk(c) => {
        assert_eq!(c.rid.as_deref(), Some("msg_01"));
        assert_eq!(c.text, "Hello, how can I ");
        assert_eq!(c.content_type, "text");
    }
    );
}

#[test]
fn stream_chunk_thinking_golden() {
    let msg: ServerMessage =
        assert_golden(&shared_fixture("server", Some("stream_chunk_thinking")));
    assert_variant!(
    msg,
    ServerMessage::StreamChunk(c) => {
        assert_eq!(c.rid.as_deref(), Some("msg_01"));
        assert_eq!(c.content_type, "thinking");
    }
    );
}

#[test]
fn stream_end_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("stream_end")));
    assert_variant!(
    msg,
    ServerMessage::StreamEnd(se) => {
        assert_eq!(se.rid.as_deref(), Some("msg_01"));
        assert_eq!(se.msg_id.as_deref(), Some("m_assistant_01"));
        assert_eq!(se.revision, Some(12));
        assert_eq!(se.content, "Hello, how can I help you today?");
        assert_eq!(se.metadata.tokens.input, 1234);
        assert_eq!(se.metadata.tokens.output, 567);
        assert_eq!(se.metadata.tokens.cache_read, 890);
        assert_eq!(se.metadata.tokens.cache_write, 12);
        assert_eq!(se.metadata.timing.total_ms, 2340);
        assert_eq!(se.metadata.timing.ttft_ms, 450);
        assert_eq!(se.metadata.model, "claude-haiku-4-5-20251001");
        assert!(se.is_final);
    }
    );
}

#[test]
fn phase_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("phase")));
    assert_variant!(
    msg,
    ServerMessage::Phase(p) => {
        assert_eq!(p.rid.as_deref(), Some("msg_01"));
        assert_eq!(p.phase, "thinking");
        assert_eq!(p.model.as_deref(), Some("claude-haiku-4-5-20251001"));
    }
    );
}

#[test]
fn new_message_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("new_message")));
    assert_variant!(
    msg,
    ServerMessage::NewMessage(nm) => {
        assert_eq!(nm.revision, 8);
        assert_eq!(nm.character.as_deref(), Some("Alice"));
        assert_eq!(nm.message.origin, Some(MessageOrigin::Autonomous));
        assert_eq!(nm.message.msg_id, "m_auto_01");
        assert_eq!(nm.message.role, Role::Assistant);
        assert_eq!(nm.message.content, "I noticed something interesting.");
        assert!(nm.message.images.is_empty());
        assert_eq!(nm.message.alt_index, None);
        assert_eq!(nm.message.alt_count, None);
        assert_eq!(nm.message.timestamp, "2026-01-15T10:35:00Z");
    }
    );
}

#[test]
fn new_message_with_alts_golden() {
    let msg: ServerMessage =
        assert_golden(&shared_fixture("server", Some("new_message_with_alts")));
    assert_variant!(
    msg,
    ServerMessage::NewMessage(nm) => {
        assert_eq!(nm.revision, 9);
        assert_eq!(nm.character, None);
        assert_eq!(nm.message.origin, None);
        assert_eq!(nm.message.msg_id, "m_auto_02");
        assert_eq!(nm.message.alt_index, Some(1));
        assert_eq!(nm.message.alt_count, Some(3));
    }
    );
}

#[test]
fn tool_call_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("tool_call")));
    assert_variant!(
    msg,
    ServerMessage::ToolCall(tc) => {
        assert_eq!(tc.rid.as_deref(), Some("msg_01"));
        assert_eq!(tc.tool_id, "tc_001");
        assert_eq!(tc.tool_name, "web_search");
        assert!(tc.input.is_object());
        assert_eq!(field(&tc.input, "query"), "rust serde tutorial");
        assert_eq!(field(&tc.input, "max_results"), 5);
    }
    );
}

#[test]
fn tool_result_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("tool_result")));
    assert_variant!(
    msg,
    ServerMessage::ToolResult(tr) => {
        assert_eq!(tr.rid.as_deref(), Some("msg_01"));
        assert_eq!(tr.tool_id, "tc_001");
        assert_eq!(tr.tool_name, "web_search");
        assert_eq!(tr.output, "Found 5 results for 'rust serde tutorial'");
        assert!(!tr.is_error);
    }
    );
}

#[test]
fn send_image_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("send_image")));
    assert_variant!(
    msg,
    ServerMessage::SendImage(si) => {
        assert_eq!(si.rid.as_deref(), Some("msg_01"));
        assert_eq!(si.path, "/tmp/chart.png");
        assert_eq!(si.caption.as_deref(), Some("Monthly revenue chart"));
    }
    );
}

#[test]
fn cache_warning_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("cache_warning")));
    assert_variant!(
    msg,
    ServerMessage::CacheWarning(cw) => {
        assert_eq!(cw.expected_tokens, 5000);
        assert_eq!(
            cw.message,
            "Cache miss: context was evicted, re-processing 5000 tokens"
        );
    }
    );
}

#[test]
fn usage_warning_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("usage_warning")));
    assert_variant!(
    msg,
    ServerMessage::UsageWarning(w) => {
        assert_eq!(w.rid.as_deref(), Some("msg_01"));
        assert_eq!(w.budget, "daily total");
        assert_eq!(w.period, "day");
        assert_eq!(w.crossed_warn_at, vec![0.8]);
        assert_eq!(w.scope, None);
    }
    );
}

#[test]
fn usage_warning_pace_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("usage_warning_pace")));
    assert_variant!(
    msg,
    ServerMessage::UsageWarning(w) => {
        assert_eq!(w.scope.as_deref(), Some("pace"));
        assert_eq!(w.budget, "weekly");
        assert_eq!(w.period, "day", "the pace sub-window period, not the budget's");
    }
    );
}

#[test]
fn config_warning_golden() {
    let msg: ServerMessage = assert_golden(&shared_fixture("server", Some("config_warning")));
    assert_variant!(
    msg,
    ServerMessage::ConfigWarning(w) => {
        assert_eq!(w.rid, None);
        assert_eq!(w.character.as_deref(), Some("frank"));
        assert!(w.message.contains("unknown model"));
    }
    );
}

#[test]
fn config_warning_without_a_character_golden() {
    let msg: ServerMessage =
        assert_golden(&shared_fixture("server", Some("config_warning_global")));
    assert_variant!(
    msg,
    ServerMessage::ConfigWarning(w) => {
        assert_eq!(w.character, None);
        assert_eq!(w.path, "/home/u/.config/shore/config.toml");
    }
    );
}

#[test]
fn client_hello_golden() {
    let msg: ClientMessage = assert_golden(&shared_fixture("client", Some("client_hello")));
    assert_variant!(
    msg,
    ClientMessage::Hello(h) => {
        assert_eq!(h.client_type, "tui");
        assert_eq!(h.client_name, "shore");
        assert_eq!(h.capabilities, vec!["streaming", "images"]);
    }
    );
}

#[test]
fn client_message_golden() {
    let msg: ClientMessage = assert_golden(&shared_fixture("client", Some("client_message")));
    assert_variant!(
    msg,
    ClientMessage::Message(m) => {
        assert_eq!(m.rid.as_deref(), Some("req_001"));
        assert_eq!(m.text, "Tell me about Rust");
        assert!(m.stream);
        assert_eq!(m.images, vec!["/tmp/screenshot.png"]);
        assert_eq!(m.absence_seconds, None);
    }
    );
}

#[test]
fn client_regen_golden() {
    let msg: ClientMessage = assert_golden(&shared_fixture("client", Some("client_regen")));
    assert_variant!(
    msg,
    ClientMessage::Regen(r) => {
        assert_eq!(r.rid.as_deref(), Some("req_002"));
        assert!(r.stream);
        assert_eq!(r.guidance, None);
    }
    );
}

#[test]
fn client_regen_carries_guidance() {
    let fixture = r#"{
        "type": "regen",
        "rid": "req_002",
        "stream": true,
        "guidance": "Be more concise"
    }"#;
    let msg: ClientMessage = serde_json::from_str(fixture).expect("guidance should decode");
    assert_variant!(
    msg,
    ClientMessage::Regen(r) => {
        assert_eq!(r.rid.as_deref(), Some("req_002"));
        assert!(r.stream);
        assert_eq!(r.guidance.as_deref(), Some("Be more concise"));
    }
    );
}

#[test]
fn client_command_golden() {
    let msg: ClientMessage = assert_golden(&shared_fixture("client", Some("client_command")));
    assert_variant!(
    msg,
    ClientMessage::Command(c) => {
        assert_eq!(c.rid.as_deref(), Some("req_003"));
        assert_eq!(c.name, "switch_character");
        assert!(c.args.is_object());
        assert_eq!(field(&c.args, "character"), "alice");
        assert_eq!(field(&c.args, "greeting"), true);
    }
    );
}

#[test]
fn message_object_golden() {
    let msg: Message = assert_golden(&shared_fixture("message_object", None));
    assert_eq!(msg.msg_id, "m_100");
    assert_eq!(msg.role, Role::Assistant);
    assert_eq!(msg.content, "Here is the analysis.");
    assert_eq!(msg.images.len(), 2);
    assert_eq!(item(&msg.images, 0).path, "/img/chart.png");
    assert_eq!(
        item(&msg.images, 0).caption.as_deref(),
        Some("Revenue chart")
    );
    assert_eq!(item(&msg.images, 1).path, "/img/table.png");
    assert_eq!(item(&msg.images, 1).caption, None);
    assert_eq!(msg.alt_index, Some(2));
    assert_eq!(msg.alt_count, Some(4));
    assert_eq!(msg.timestamp, "2026-03-15T14:22:00Z");
}

#[test]
fn stream_metadata_golden() {
    let meta: StreamMetadata = assert_golden(&shared_fixture("stream_metadata", None));
    assert_eq!(meta.tokens.input, 2048);
    assert_eq!(meta.tokens.output, 1024);
    assert_eq!(meta.tokens.cache_read, 512);
    assert_eq!(meta.tokens.cache_write, 256);
    assert_eq!(meta.timing.total_ms, 3500);
    assert_eq!(meta.timing.ttft_ms, 800);
    assert_eq!(meta.model, "claude-sonnet-4-6");
}

#[test]
fn server_hello_unknown_fields_ignored() {
    let fixture = r#"{
        "type": "hello",
        "v": 1,
        "server_name": "shore-daemon",
        "characters": [],
        "extra_field": "should be ignored",
        "future_feature": 42
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("unknown fields ignored");
    assert_variant!(
    msg,
    ServerMessage::Hello(h) => {
        assert_eq!(h.v, 1);
        assert_eq!(h.server_name, "shore-daemon");
    }
    );
}

#[test]
fn client_message_unknown_fields_ignored() {
    let fixture = r#"{
        "type": "message",
        "text": "Hi",
        "stream": false,
        "images": [],
        "new_field_v2": {"nested": true}
    }"#;
    let msg: ClientMessage = serde_json::from_str(fixture).expect("unknown fields ignored");
    assert_variant!(
    msg,
    ClientMessage::Message(m) => {
        assert_eq!(m.text, "Hi");
        assert!(!m.stream);
    }
    );
}

#[test]
fn stream_chunk_unknown_fields_ignored() {
    let fixture = r#"{
        "type": "stream_chunk",
        "text": "partial",
        "content_type": "text",
        "sequence_number": 42,
        "experimental": true
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("unknown fields ignored");
    assert_variant!(
    msg,
    ServerMessage::StreamChunk(c) => {
        assert_eq!(c.text, "partial");
        assert_eq!(c.content_type, "text");
    }
    );
}

#[test]
fn tool_call_unknown_fields_ignored() {
    let fixture = r#"{
        "type": "tool_call",
        "tool_id": "tc_99",
        "tool_name": "future_tool",
        "input": {},
        "priority": "high",
        "metadata": {"source": "agent"}
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("unknown fields ignored");
    assert_variant!(
    msg,
    ServerMessage::ToolCall(tc) => {
        assert_eq!(tc.tool_id, "tc_99");
        assert_eq!(tc.tool_name, "future_tool");
    }
    );
}

#[test]
fn message_object_unknown_fields_ignored() {
    let fixture = r#"{
        "msg_id": "m_unk",
        "role": "user",
        "content": "test",
        "content_blocks": [{"type": "text", "text": "test"}],
        "images": [],
        "timestamp": "2026-01-01T00:00:00Z",
        "reactions": ["thumbs_up"],
        "thread_id": "t_001"
    }"#;
    let msg: Message = serde_json::from_str(fixture).expect("unknown fields ignored");
    assert_eq!(msg.msg_id, "m_unk");
    assert_eq!(msg.role, Role::User);
}

#[test]
fn cache_warning_unknown_fields_ignored() {
    let fixture = r#"{
        "type": "cache_warning",
        "expected_tokens": 1000,
        "message": "evicted",
        "severity": "warning",
        "cache_id": "c_123"
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("unknown fields ignored");
    assert!(matches!(msg, ServerMessage::CacheWarning(_)));
}

#[test]
fn send_image_unknown_fields_ignored() {
    let fixture = r#"{
        "type": "send_image",
        "path": "/tmp/img.png",
        "caption": "test",
        "width": 800,
        "height": 600
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("unknown fields ignored");
    assert!(matches!(msg, ServerMessage::SendImage(_)));
}

#[test]
fn message_missing_optionals() {
    let fixture = r#"{
        "msg_id": "m_opt",
        "role": "user",
        "content": "test",
        "content_blocks": [{"type": "text", "text": "test"}],
        "timestamp": "2026-01-01T00:00:00Z"
    }"#;
    let msg: Message = serde_json::from_str(fixture).expect("missing optionals");
    assert_eq!(msg.alt_index, None);
    assert_eq!(msg.alt_count, None);
    assert!(msg.images.is_empty());
}

#[test]
fn stream_chunk_missing_content_type_defaults_to_text() {
    let fixture = r#"{
        "type": "stream_chunk",
        "text": "partial output"
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("missing content_type");
    assert_variant!(
    msg,
    ServerMessage::StreamChunk(c) => {
        assert_eq!(c.content_type, "text");
    }
    );
}

#[test]
fn stream_start_missing_regen_defaults_to_false() {
    let fixture = r#"{"type": "stream_start"}"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("missing regen");
    assert_variant!(
    msg,
    ServerMessage::StreamStart(s) => {
        assert!(!s.regen);
    }
    );
}

#[test]
fn client_hello_missing_capabilities_defaults_to_empty() {
    let fixture = r#"{
        "type": "hello",
        "client_type": "cli",
        "client_name": "shore-cli"
    }"#;
    let msg: ClientMessage = serde_json::from_str(fixture).expect("missing capabilities");
    assert_variant!(
    msg,
    ClientMessage::Hello(h) => {
        assert!(h.capabilities.is_empty());
    }
    );
}

#[test]
fn client_message_missing_optionals() {
    let fixture = r#"{
        "type": "message",
        "text": "hello"
    }"#;
    let msg: ClientMessage = serde_json::from_str(fixture).expect("missing optionals");
    assert_variant!(
    msg,
    ClientMessage::Message(m) => {
        assert_eq!(m.rid, None);
        assert!(!m.stream);
        assert!(m.images.is_empty());
        assert_eq!(m.absence_seconds, None);
    }
    );
}

#[test]
fn client_regen_missing_optionals() {
    let fixture = r#"{
        "type": "regen"
    }"#;
    let msg: ClientMessage = serde_json::from_str(fixture).expect("missing optionals");
    assert_variant!(
    msg,
    ClientMessage::Regen(r) => {
        assert_eq!(r.rid, None);
        assert!(!r.stream);
        assert_eq!(r.guidance, None);
    }
    );
}

#[test]
fn server_hello_missing_characters_defaults_to_empty() {
    let fixture = r#"{
        "type": "hello",
        "v": 1,
        "server_name": "shore-daemon"
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("missing characters");
    assert_variant!(
    msg,
    ServerMessage::Hello(h) => {
        assert!(h.characters.is_empty());
    }
    );
}

#[test]
fn phase_missing_model() {
    let fixture = r#"{
        "type": "phase",
        "phase": "text_generation"
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("missing model");
    assert_variant!(
    msg,
    ServerMessage::Phase(p) => {
        assert_eq!(p.phase, "text_generation");
        assert_eq!(p.model, None);
    }
    );
}

#[test]
fn send_image_missing_caption() {
    let fixture = r#"{
        "type": "send_image",
        "path": "/tmp/img.png"
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("missing caption");
    assert_variant!(
    msg,
    ServerMessage::SendImage(si) => {
        assert_eq!(si.rid, None);
        assert_eq!(si.path, "/tmp/img.png");
        assert_eq!(si.caption, None);
    }
    );
}

#[test]
fn tool_result_missing_is_error_defaults_to_false() {
    let fixture = r#"{
        "type": "tool_result",
        "tool_id": "tc_def",
        "tool_name": "search",
        "output": "results"
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("missing is_error");
    assert_variant!(
    msg,
    ServerMessage::ToolResult(tr) => {
        assert_eq!(tr.rid, None);
        assert!(!tr.is_error);
    }
    );
}

#[test]
fn request_scoped_server_messages_missing_rid_default_to_none() {
    let cases = [
        r#"{"type":"command_output","name":"status","data":{"ok":true}}"#,
        r#"{"type":"error","code":"busy","message":"still working"}"#,
        r#"{"type":"stream_start","regen":false}"#,
        r#"{"type":"stream_chunk","text":"partial","content_type":"text"}"#,
        r#"{"type":"stream_end","content":"done","metadata":{"tokens":{"input":1,"output":1,"cache_read":0,"cache_write":0},"timing":{"total_ms":10,"ttft_ms":1},"model":"test"}}"#,
        r#"{"type":"phase","phase":"thinking"}"#,
        r#"{"type":"tool_call","tool_id":"t1","tool_name":"search","input":{"q":"rust"}}"#,
        r#"{"type":"tool_result","tool_id":"t1","tool_name":"search","output":"done"}"#,
        r#"{"type":"send_image","path":"/tmp/img.png"}"#,
    ];

    for fixture in cases {
        let parsed: ServerMessage = serde_json::from_str(fixture).expect("missing rid");
        match parsed {
            ServerMessage::CommandOutput(msg) => assert_eq!(msg.rid, None),
            ServerMessage::Error(msg) => assert_eq!(msg.rid, None),
            ServerMessage::StreamStart(msg) => assert_eq!(msg.rid, None),
            ServerMessage::StreamChunk(msg) => assert_eq!(msg.rid, None),
            ServerMessage::StreamEnd(msg) => {
                assert_eq!(msg.rid, None);
                assert_eq!(msg.msg_id, None);
                assert_eq!(msg.revision, None);
            }
            ServerMessage::Phase(msg) => assert_eq!(msg.rid, None),
            ServerMessage::ToolCall(msg) => assert_eq!(msg.rid, None),
            ServerMessage::ToolResult(msg) => assert_eq!(msg.rid, None),
            ServerMessage::SendImage(msg) => assert_eq!(msg.rid, None),
            ServerMessage::ProviderWarning(msg) => assert_eq!(msg.rid, None),
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::Unknown => {
                panic!("unexpected message for missing rid test");
            }
        }
    }
}

#[test]
fn protocol_version_mismatch_produces_error() {
    let fixture = r#"{
        "type": "hello",
        "v": 99,
        "server_name": "future-server",
        "characters": []
    }"#;
    let msg: ServerMessage = serde_json::from_str(fixture).expect("deserializes fine");
    assert_variant!(
    msg,
    ServerMessage::Hello(h) => {
        assert_ne!(h.v, SWP_V1);
        let err = ServerMessage::Error(Error {
            rid: None,
            code: ErrorCode::ProtocolError,
            message: format!(
                "protocol version mismatch: expected {}, got {}",
                SWP_V1, h.v
            ),
            retry_after_ms: None,
        });
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(field(&json, "type"), "error");
        assert_eq!(field(&json, "code"), "protocol_error");
        assert!(field(&json, "message")
            .as_str()
            .unwrap()
            .contains("protocol version mismatch"));
    }
    );
}

#[test]
fn protocol_error_code_golden() {
    let fixture = r#"{
        "type": "error",
        "code": "protocol_error",
        "message": "unsupported protocol version"
    }"#;
    let msg: ServerMessage = assert_golden(fixture);
    assert_variant!(
    msg,
    ServerMessage::Error(e) => {
        assert_eq!(e.code, ErrorCode::ProtocolError);
        assert_eq!(e.message, "unsupported protocol version");
    }
    );
}

#[test]
fn provider_error_retry_after_golden() {
    let fixture = r#"{
        "type": "error",
        "rid": "msg_01",
        "code": "provider_error",
        "message": "rate limited",
        "retry_after_ms": 1250
    }"#;
    let msg: ServerMessage = assert_golden(fixture);
    assert_variant!(
    msg,
    ServerMessage::Error(e) => {
        assert_eq!(e.retry_after_ms, Some(1250));
    }
    );
}

#[test]
fn all_error_codes_golden() {
    let cases = vec![
        ("protocol_error", ErrorCode::ProtocolError),
        ("invalid_request", ErrorCode::InvalidRequest),
        ("not_found", ErrorCode::NotFound),
        ("busy", ErrorCode::Busy),
        ("provider_error", ErrorCode::ProviderError),
        ("timeout", ErrorCode::Timeout),
        ("internal_error", ErrorCode::InternalError),
    ];
    for (json_str, expected_code) in cases {
        let fixture = format!(r#"{{"type": "error", "code": "{json_str}", "message": "test"}}"#);
        let msg: ServerMessage = serde_json::from_str(&fixture).expect("error code deserializes");
        assert_variant!(
            msg,
            ServerMessage::Error(e) => {
                assert_eq!(e.code, expected_code);
                let json = serde_json::to_value(&e.code).unwrap();
                assert_eq!(json.as_str().unwrap(), json_str);
            }
        );
    }
}

#[test]
fn all_roles_golden() {
    let cases = vec![
        ("user", Role::User),
        ("assistant", Role::Assistant),
        ("system", Role::System),
    ];
    for (json_str, expected_role) in cases {
        let val: Role = serde_json::from_value(json!(json_str)).expect("role deserializes");
        assert_eq!(val, expected_role);
        let serialized = serde_json::to_value(&val).unwrap();
        assert_eq!(serialized.as_str().unwrap(), json_str);
    }
}
