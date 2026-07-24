use serde::{Deserialize, Serialize};

/// Client hello — sent once after connect.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ClientHello {
    pub client_type: String,
    pub client_name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Which character this client wants to talk to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
}

/// One-shot parameter overrides for a single message.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct MessageOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    /// Enable extended thinking with the given budget (in tokens).
    /// `Some(n)` enables thinking with budget `n`; omitted = use model default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget: Option<u32>,
}

/// A base64-encoded image uploaded by the client.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageUpload {
    pub filename: String,
    /// Base64-encoded image file bytes.
    pub data: String,
    /// Declared media type (e.g. `image/png`). Optional: bridges whose source
    /// protocol carries a media type but no reliable filename extension
    /// (Matrix `info.mimetype`) should set it. The daemon also sniffs magic
    /// bytes, so this is a fallback, not a requirement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// Send a user message.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ClientMessageBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub text: String,
    #[serde(default)]
    pub stream: bool,
    /// Legacy: file paths (only works when client and server share a filesystem).
    #[serde(default)]
    pub images: Vec<String>,
    /// Preferred: base64-encoded image data (works across machines).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_data: Vec<ImageUpload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub absence_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<MessageOverrides>,
}

/// Regenerate last response.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Regen {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default)]
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
}

/// Execute a server command.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Command {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub name: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// Cancel an in-progress generation.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Cancel {}

/// All client → server message types, tagged by "type".
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Hello(ClientHello),
    Message(ClientMessageBody),
    Regen(Regen),
    Command(Command),
    Cancel(Cancel),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field<'val>(value: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        value.get(key).expect("expected JSON field")
    }

    #[test]
    fn cancel_serialization_roundtrip() {
        let msg = ClientMessage::Cancel(Cancel {});
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(field(&json, "type"), "cancel");

        let roundtrip: ClientMessage = serde_json::from_value(json).unwrap();
        assert!(matches!(roundtrip, ClientMessage::Cancel(_)));
    }

    #[test]
    fn message_overrides_with_values() {
        let overrides = MessageOverrides {
            temperature: Some(0.8),
            top_p: Some(0.95),
            thinking_budget: Some(4096),
        };
        let json = serde_json::to_value(&overrides).unwrap();
        assert_eq!(field(&json, "temperature"), 0.8);
        assert_eq!(field(&json, "top_p"), 0.95);
        assert_eq!(field(&json, "thinking_budget"), 4096);
    }

    #[test]
    fn message_overrides_none_fields_omitted() {
        let overrides = MessageOverrides::default();
        let json = serde_json::to_value(&overrides).unwrap();
        assert!(json.get("temperature").is_none());
        assert!(json.get("top_p").is_none());
        assert!(json.get("thinking_budget").is_none());
    }

    #[test]
    fn message_overrides_partial_fields() {
        let overrides = MessageOverrides {
            temperature: Some(0.5),
            top_p: None,
            thinking_budget: None,
        };
        let json = serde_json::to_value(&overrides).unwrap();
        assert_eq!(field(&json, "temperature"), 0.5);
        assert!(json.get("top_p").is_none());
    }

    #[test]
    fn client_message_body_with_overrides_roundtrip() {
        let body = ClientMessageBody {
            rid: Some("r1".into()),
            text: "hello".into(),
            stream: true,
            images: vec![],
            image_data: vec![],
            absence_seconds: None,
            overrides: Some(MessageOverrides {
                temperature: Some(0.7),
                top_p: None,
                thinking_budget: Some(2048),
            }),
        };
        let msg = ClientMessage::Message(body);
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(field(&json, "type"), "message");
        let overrides = field(&json, "overrides");
        assert_eq!(field(overrides, "temperature"), 0.7);
        assert_eq!(field(overrides, "thinking_budget"), 2048);
        assert!(overrides.get("top_p").is_none());

        let roundtrip: ClientMessage = serde_json::from_value(json).unwrap();
        let ClientMessage::Message(b) = roundtrip else {
            panic!("wrong variant");
        };
        let o = b.overrides.unwrap();
        assert_eq!(o.temperature, Some(0.7));
        assert_eq!(o.thinking_budget, Some(2048));
        assert_eq!(o.top_p, None);
    }

    #[test]
    fn client_message_body_without_overrides() {
        let body = ClientMessageBody {
            rid: None,

            text: "hi".into(),
            stream: false,
            images: vec![],
            image_data: vec![],
            absence_seconds: None,
            overrides: None,
        };
        let json = serde_json::to_value(&body).unwrap();
        assert!(json.get("overrides").is_none());
    }
}
