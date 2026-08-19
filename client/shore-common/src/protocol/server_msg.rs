use serde::{Deserialize, Serialize};

use crate::protocol::error::ErrorCode;
use crate::protocol::types::{CharacterInfo, Message, StreamMetadata};

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ServerHello {
    pub v: u32,
    pub server_name: String,
    #[serde(default)]
    pub characters: Vec<CharacterInfo>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct History {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub active_start: usize,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub config: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_character: Option<String>,
    #[serde(default)]
    #[ts(type = "number")]
    pub revision: u64,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde skip_serializing_if requires a &T predicate signature"
)]
fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Shutdown {}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Ping {}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CommandOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub name: String,
    #[ts(type = "unknown")]
    pub data: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Error {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamStart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default)]
    pub regen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamChunk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub text: String,
    #[serde(default = "default_content_type")]
    pub content_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

fn default_content_type() -> String {
    "text".to_owned()
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamEnd {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub revision: Option<u64>,
    pub content: String,
    pub metadata: StreamMetadata,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub finish_reason: String,
    #[serde(default = "default_true")]
    pub is_final: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Phase {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

pub use crate::protocol::types::MessageOrigin;

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct NewMessage {
    #[serde(default)]
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    #[serde(flatten)]
    pub message: Message,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ToolCall {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub tool_id: String,
    pub tool_name: String,
    #[ts(type = "unknown")]
    pub input: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ToolResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub tool_id: String,
    pub tool_name: String,
    pub output: String,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct SendImage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct SubagentStatus {
    pub task_id: String,
    pub character: String,
    pub name: String,
    pub query: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CacheWarning {
    pub expected_tokens: u32,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ProviderFallbackWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub provider: String,
    pub from_key: String,
    pub to_key: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct UsageWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub budget: String,
    pub message: String,
    pub current_cost: f64,
    pub cost_limit: f64,
    pub percent_used: f64,
    pub crossed_warn_at: Vec<f64>,
    pub period: String,
    pub period_start: String,
    pub reset_at: String,
    #[serde(default)]
    pub reset_at_display: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ConfigWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Hello(ServerHello),
    History(History),
    Shutdown(Shutdown),
    Ping(Ping),
    CommandOutput(CommandOutput),
    Error(Error),
    StreamStart(StreamStart),
    StreamChunk(StreamChunk),
    StreamEnd(StreamEnd),
    Phase(Phase),
    NewMessage(NewMessage),
    ToolCall(ToolCall),
    ToolResult(ToolResult),
    SendImage(SendImage),
    SubagentStatus(SubagentStatus),
    CacheWarning(CacheWarning),
    ProviderFallbackWarning(ProviderFallbackWarning),
    UsageWarning(UsageWarning),
    ConfigWarning(ConfigWarning),
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

impl ServerMessage {
    #[must_use]
    pub fn subagent(&self) -> Option<&str> {
        match self {
            ServerMessage::StreamStart(m) => m.subagent.as_deref(),
            ServerMessage::StreamChunk(m) => m.subagent.as_deref(),
            ServerMessage::StreamEnd(m) => m.subagent.as_deref(),
            ServerMessage::ToolCall(m) => m.subagent.as_deref(),
            ServerMessage::ToolResult(m) => m.subagent.as_deref(),
            ServerMessage::SendImage(m) => m.subagent.as_deref(),
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::Phase(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::SubagentStatus(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::Unknown => None,
        }
    }

    #[must_use]
    pub fn task_id(&self) -> Option<&str> {
        match self {
            ServerMessage::StreamStart(m) => m.task_id.as_deref(),
            ServerMessage::StreamChunk(m) => m.task_id.as_deref(),
            ServerMessage::StreamEnd(m) => m.task_id.as_deref(),
            ServerMessage::ToolCall(m) => m.task_id.as_deref(),
            ServerMessage::ToolResult(m) => m.task_id.as_deref(),
            ServerMessage::SendImage(m) => m.task_id.as_deref(),
            ServerMessage::SubagentStatus(m) => Some(m.task_id.as_str()),
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::Phase(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::Unknown => None,
        }
    }

    pub fn set_subagent(&mut self, name: &str) {
        let tag = || Some(name.to_owned());
        match self {
            ServerMessage::StreamStart(msg) => msg.subagent = tag(),
            ServerMessage::StreamChunk(msg) => msg.subagent = tag(),
            ServerMessage::StreamEnd(msg) => msg.subagent = tag(),
            ServerMessage::ToolCall(msg) => msg.subagent = tag(),
            ServerMessage::ToolResult(msg) => msg.subagent = tag(),
            ServerMessage::SendImage(msg) => msg.subagent = tag(),
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::Phase(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::SubagentStatus(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::Unknown => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_type_deserializes_to_unknown_variant() {
        let json = r#"{"type":"some_future_message","field":42}"#;
        let msg: ServerMessage = serde_json::from_str(json).expect("must not error");
        assert!(matches!(msg, ServerMessage::Unknown));
    }

    #[test]
    fn known_types_still_deserialize_to_their_variant() {
        let json = r#"{"type":"ping"}"#;
        let msg: ServerMessage = serde_json::from_str(json).expect("ping must parse");
        assert!(matches!(msg, ServerMessage::Ping(_)));
    }

    #[test]
    fn set_subagent_tags_stream_and_tool_frames() {
        let mut chunk = ServerMessage::StreamChunk(StreamChunk {
            rid: None,
            text: "hi".into(),
            content_type: "text".into(),
            subagent: None,
            task_id: None,
        });
        chunk.set_subagent("research");
        assert_eq!(chunk.subagent(), Some("research"));

        let mut phase = ServerMessage::Phase(Phase {
            rid: None,
            phase: "thinking".into(),
            model: None,
        });
        phase.set_subagent("research");
        assert_eq!(phase.subagent(), None);
    }

    #[test]
    fn subagent_tag_survives_wire_round_trip() {
        let mut call = ServerMessage::ToolCall(ToolCall {
            rid: None,
            tool_id: "t1".into(),
            tool_name: "search".into(),
            input: serde_json::json!({}),
            subagent: None,
            task_id: None,
        });
        call.set_subagent("research");
        let wire = serde_json::to_string(&call).unwrap();
        assert!(wire.contains("\"subagent\":\"research\""), "wire: {wire}");
        let back: ServerMessage = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.subagent(), Some("research"));
    }

    #[test]
    fn untagged_frame_omits_subagent_on_the_wire() {
        let call = ServerMessage::ToolCall(ToolCall {
            rid: None,
            tool_id: "t1".into(),
            tool_name: "search".into(),
            input: serde_json::json!({}),
            subagent: None,
            task_id: None,
        });
        let wire = serde_json::to_string(&call).unwrap();
        assert!(!wire.contains("subagent"), "wire: {wire}");
    }

    #[test]
    fn task_id_survives_wire_round_trip_and_is_omitted_when_absent() {
        let tagged = ServerMessage::StreamChunk(StreamChunk {
            rid: None,
            text: "hi".into(),
            content_type: "text".into(),
            subagent: Some("research".into()),
            task_id: Some("sa_1".into()),
        });
        let wire = serde_json::to_string(&tagged).unwrap();
        assert!(wire.contains("\"task_id\":\"sa_1\""), "wire: {wire}");
        let back: ServerMessage = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.task_id(), Some("sa_1"));

        let plain = ServerMessage::StreamChunk(StreamChunk {
            rid: None,
            text: "hi".into(),
            content_type: "text".into(),
            subagent: None,
            task_id: None,
        });
        let untagged_wire = serde_json::to_string(&plain).unwrap();
        assert!(!untagged_wire.contains("task_id"), "wire: {untagged_wire}");
    }

    #[test]
    fn subagent_status_round_trip() {
        let msg = ServerMessage::SubagentStatus(SubagentStatus {
            task_id: "sa_1".into(),
            character: "poppy".into(),
            name: "research".into(),
            query: "find the tide tables".into(),
            status: "done".into(),
            detail: None,
        });
        let wire = serde_json::to_string(&msg).unwrap();
        assert!(
            wire.contains("\"type\":\"subagent_status\""),
            "wire: {wire}"
        );
        assert!(!wire.contains("detail"), "wire: {wire}");
        let back: ServerMessage = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.task_id(), Some("sa_1"));
        let ServerMessage::SubagentStatus(status) = back else {
            panic!("expected subagent_status");
        };
        assert_eq!(status.character, "poppy");
        assert_eq!(status.status, "done");
    }
}
