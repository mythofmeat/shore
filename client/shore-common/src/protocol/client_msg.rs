use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ClientHello {
    pub client_type: String,
    pub client_name: String,
    #[serde(default = "unknown_build_version")]
    pub build_version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

fn unknown_build_version() -> String {
    "unknown".to_owned()
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
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Regen {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
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
    fn a_sent_message_carries_no_per_message_sampling_overrides() {
        let body = ClientMessageBody {
            rid: None,
            text: "hi".into(),
            stream: false,
            images: vec![],
            image_data: vec![],
            absence_seconds: None,
        };
        let json = serde_json::to_value(&body).unwrap();
        assert!(json.get("overrides").is_none());
        assert!(json.get("temperature").is_none());
        assert!(json.get("top_p").is_none());
        assert!(json.get("thinking_budget").is_none());
    }
}
