use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ClientHello {
    pub client_type: String,
    pub client_name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct MessageOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_budget: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ImageUpload {
    pub filename: String,
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ClientMessageBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub text: String,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_data: Vec<ImageUpload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub absence_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<MessageOverrides>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Regen {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default)]
    pub stream: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Command {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub name: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub args: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Cancel {}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
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
