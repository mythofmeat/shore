use serde::{Deserialize, Serialize};

use crate::protocol::error::ErrorCode;
use crate::protocol::operations::{ClaudePlanWindow, SegmentSummary, ThreadUnread};
use crate::protocol::types::{CharacterInfo, ContentBlock, ImageRef, Message, StreamMetadata};

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ServerHello {
    pub v: u32,
    pub server_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(default)]
    pub characters: Vec<CharacterInfo>,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct History {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<HistoryDelta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_segment: Option<SegmentSummary>,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub config: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_character: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_thread: Option<String>,
    #[serde(default)]
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct HistoryDelta {
    #[ts(type = "number")]
    pub base_revision: u64,
    pub after: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Shutdown {}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Ping {}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CommandOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub name: String,
    #[ts(type = "unknown")]
    pub data: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Error {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamStart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default)]
    pub regen: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub replaces: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_content_blocks: Option<Vec<ContentBlock>>,
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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Phase {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

pub use crate::protocol::types::MessageOrigin;

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct NewMessage {
    #[serde(default)]
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(flatten)]
    pub message: Message,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ToolResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub tool_id: String,
    pub tool_name: String,
    pub output: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<ImageRef>>", optional)]
    pub images: Vec<ImageRef>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CacheWarning {
    pub expected_tokens: u32,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ThreadsChanged {
    pub character: String,
    pub thread: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ProviderWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct PlanLimitWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub window: ClaudePlanWindow,
    pub limit: String,
    pub message: String,
    pub percent_used: f64,
    pub crossed_warn_at: Vec<f64>,
    pub limit_at: f64,
    pub over_limit: bool,
    pub resets_at: String,
    #[serde(default)]
    pub resets_at_display: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ConfigWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum RequestOutcome {
    Completed,
    Failed,
    Cancelled,
    Superseded,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct RequestAccepted {
    pub rid: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct RequestFinished {
    pub rid: String,
    pub outcome: RequestOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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
    CacheWarning(CacheWarning),
    ProviderWarning(ProviderWarning),
    ProviderFallbackWarning(ProviderFallbackWarning),
    UsageWarning(UsageWarning),
    PlanLimitWarning(PlanLimitWarning),
    ConfigWarning(ConfigWarning),
    RequestAccepted(RequestAccepted),
    RequestFinished(RequestFinished),
    ThreadsChanged(ThreadsChanged),
    ThreadUnread(ThreadUnread),
    #[serde(other)]
    #[ts(skip)]
    #[schemars(skip)]
    Unknown,
}

impl ServerMessage {
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::History(frame) => frame.rid.as_deref(),
            Self::CommandOutput(frame) => frame.rid.as_deref(),
            Self::Error(frame) => frame.rid.as_deref(),
            Self::StreamStart(frame) => frame.rid.as_deref(),
            Self::StreamChunk(frame) => frame.rid.as_deref(),
            Self::StreamEnd(frame) => frame.rid.as_deref(),
            Self::Phase(frame) => frame.rid.as_deref(),
            Self::ToolCall(frame) => frame.rid.as_deref(),
            Self::ToolResult(frame) => frame.rid.as_deref(),
            Self::SendImage(frame) => frame.rid.as_deref(),
            Self::ProviderWarning(frame) => frame.rid.as_deref(),
            Self::ProviderFallbackWarning(frame) => frame.rid.as_deref(),
            Self::UsageWarning(frame) => frame.rid.as_deref(),
            Self::PlanLimitWarning(frame) => frame.rid.as_deref(),
            Self::ConfigWarning(frame) => frame.rid.as_deref(),
            Self::RequestAccepted(frame) => Some(&frame.rid),
            Self::RequestFinished(frame) => Some(&frame.rid),
            Self::Hello(_)
            | Self::Shutdown(_)
            | Self::Ping(_)
            | Self::NewMessage(_)
            | Self::CacheWarning(_)
            | Self::ThreadsChanged(_)
            | Self::ThreadUnread(_)
            | Self::Unknown => None,
        }
    }

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
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::PlanLimitWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::RequestAccepted(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::ThreadsChanged(_)
            | ServerMessage::ThreadUnread(_)
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
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::Phase(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::PlanLimitWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::RequestAccepted(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::ThreadsChanged(_)
            | ServerMessage::ThreadUnread(_)
            | ServerMessage::Unknown => None,
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
}
