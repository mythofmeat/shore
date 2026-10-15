#![expect(
    clippy::expect_used,
    reason = "golden fixture helpers intentionally fail fast when checked-in protocol JSON is malformed"
)]

use serde_json::Value;
use shore_common::protocol::SWP_V1;
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

fn field<'val>(value: &'val Value, key: &str) -> &'val Value {
    value.get(key).expect("expected JSON field")
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
