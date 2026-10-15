pub mod client_msg;
pub mod error;
pub mod operations;
#[cfg(test)]
mod schemas;
pub mod server_msg;
pub mod tool_display;
pub mod types;
pub mod web;

pub const SWP_V1: u32 = 1;

pub(crate) const MAX_WIRE_MESSAGE_SIZE: usize = 128 * 1024 * 1024;

#[cfg(test)]
mod tests {

    use crate::protocol::client_msg::*;

    use crate::protocol::types::*;

    fn field<'val>(value: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        value.get(key).expect("expected JSON field")
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
}
