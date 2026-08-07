use serde::{Deserialize, Serialize};

use crate::protocol::error::ErrorCode;
use crate::protocol::types::{CharacterInfo, Message, StreamMetadata};

/// Server hello — sent after client connects.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ServerHello {
    pub v: u32,
    pub server_name: String,
    #[serde(default)]
    pub characters: Vec<CharacterInfo>,
}

/// Full state snapshot.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct History {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub messages: Vec<Message>,
    /// Index of the first message that is still in the active prompt context.
    ///
    /// Normal push/handshake snapshots contain only active context and leave
    /// this at zero. Bounded log/history responses may include durable archive
    /// scrollback before this index; those messages are useful for humans but
    /// are no longer part of the model's active conversation context.
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

/// Server shutting down.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Shutdown {}

/// Keepalive.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Ping {}

/// Command result.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CommandOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub name: String,
    #[ts(type = "unknown")]
    pub data: serde_json::Value,
}

/// Error response.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Error {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub code: ErrorCode,
    pub message: String,
}

/// Begin streaming.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamStart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    #[serde(default)]
    pub regen: bool,
    /// Set when this frame belongs to a sub-agent's nested tool loop (the
    /// `[subagents.<name>]` name behind an `ask_<name>` call). Clients render
    /// it as attributed/nested activity; `None` is the primary model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
}

/// Partial content chunk.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamChunk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub text: String,
    #[serde(default = "default_content_type")]
    pub content_type: String,
    /// Sub-agent name when this chunk is from a nested `ask_<name>` loop; see
    /// [`StreamStart::subagent`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
}

fn default_content_type() -> String {
    "text".to_owned()
}

/// Done streaming.
///
/// A single `send`/`regen` can emit multiple `StreamEnd` frames when the
/// daemon is running a tool loop: one per LLM turn, so clients can render
/// tool calls as they happen. Only the frame with `is_final = true` marks
/// the end of the whole generation — clients that want the final aggregated
/// result (e.g. `collect_stream`) must keep reading until they see it.
/// Older servers that predate the field will serialize nothing; `serde`'s
/// default treats missing as `true`, preserving pre-tool-loop semantics.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamEnd {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    /// Persisted assistant message id for terminal stream ends.
    ///
    /// Present only after the final assistant message has been appended and
    /// persisted. Intermediate tool-use boundaries and older servers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    /// Durable history revision containing `msg_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub revision: Option<u64>,
    pub content: String,
    pub metadata: StreamMetadata,
    /// Why the model stopped: "end_turn", "tool_use", "max_tokens", etc.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub finish_reason: String,
    /// Whether this is the final `StreamEnd` for the generation. Intermediate
    /// tool-loop boundaries set this to `false`; the terminal StreamEnd sets
    /// it to `true`. Defaults to `true` so pre-field daemon frames are treated
    /// as terminal (matching historical single-turn behavior).
    #[serde(default = "default_true")]
    pub is_final: bool,
    /// Sub-agent name when this boundary is from a nested `ask_<name>` loop; see
    /// [`StreamStart::subagent`]. A sub-agent never emits a terminal
    /// (`is_final = true`) frame, so a tagged StreamEnd never ends the primary
    /// generation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Generation phase change.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Phase {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

// Canonical definition lives in `types` so it can be persisted on `Message`;
// re-exported here because clients historically import it from `server_msg`.
pub use crate::protocol::types::MessageOrigin;

/// Conversation message appended by the daemon.
///
/// The frame's `origin` lives on the flattened [`Message`] (`message.origin`).
/// Because `message` is flattened, the wire shape is byte-identical to the
/// envelope-level `origin` field this struct carried historically — only the
/// Rust-side field moved.
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

/// Tool invoked during generation.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ToolCall {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub tool_id: String,
    pub tool_name: String,
    #[ts(type = "unknown")]
    pub input: serde_json::Value,
    /// Sub-agent name when this call is from a nested `ask_<name>` loop; see
    /// [`StreamStart::subagent`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
}

/// Tool completed.
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
    /// Sub-agent name when this result is from a nested `ask_<name>` loop; see
    /// [`StreamStart::subagent`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
}

/// Server-generated image ready.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct SendImage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    /// Base64-encoded image data for wire transfer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// Sub-agent name when this image is from a nested `ask_<name>` loop; see
    /// [`StreamStart::subagent`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
}

/// Unexpected cache invalidation warning.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CacheWarning {
    pub expected_tokens: u32,
    pub message: String,
}

/// The daemon rotated from one configured provider key to another mid-request
/// because the previous key reported a credential-scoped failure (missing,
/// invalid, exhausted quota or budget, account-scoped rate limit).
///
/// Emitted only when the previous key had `warn_on_fallback = true`. The
/// payload intentionally never carries the env var value or the API key
/// itself — only the provider key, the friendly key names, the failure
/// classification, and a sanitized human-readable reason.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ProviderFallbackWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    /// Provider this fallback applies to (e.g. `"openrouter"`).
    pub provider: String,
    /// Friendly name of the key being abandoned.
    pub from_key: String,
    /// Friendly name of the key now in use.
    pub to_key: String,
    /// Stable failure tag from `CredentialFailureKind::as_str()`. Stable
    /// across releases so client-side rendering can branch on it.
    pub kind: String,
    /// HTTP status when the failure was a status-shaped error; `None` for
    /// missing-key / network / classified-by-body cases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Sanitized human-readable summary. Never contains secrets.
    pub message: String,
}

/// A configured usage budget crossed one or more warning thresholds.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct UsageWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    /// Configured budget name.
    pub budget: String,
    /// Human-readable warning text.
    pub message: String,
    /// Current spend for the budget window.
    pub current_cost: f64,
    /// Configured budget limit.
    pub cost_limit: f64,
    /// Fraction used, e.g. 0.8 for 80%.
    pub percent_used: f64,
    /// Newly crossed warning thresholds, as fractions.
    pub crossed_warn_at: Vec<f64>,
    /// Calendar period name.
    pub period: String,
    /// RFC3339 period start.
    pub period_start: String,
    /// RFC3339 reset/end time.
    pub reset_at: String,
    /// `reset_at` rendered in the daemon's local time as `YYYY-MM-DD HH:MM AM|PM`.
    /// Clients that surface this string verbatim should prefer it over `reset_at`
    /// (which is UTC); the structured `reset_at` stays for machine consumers.
    #[serde(default)]
    pub reset_at_display: String,
    /// `"pace"` when the warning is about a budget's pace allowance rather than
    /// its period cap; absent for the cap itself. The cost, period, and window
    /// fields always describe whichever limit tripped, so a client that ignores
    /// this still renders correct numbers — it just can't tell the two apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// All server → client message types, tagged by "type".
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
    CacheWarning(CacheWarning),
    ProviderFallbackWarning(ProviderFallbackWarning),
    UsageWarning(UsageWarning),
    /// A frame whose `type` tag matches no known variant. Produced only by
    /// deserialization (never constructed or sent by the server), so a client
    /// built against an older protocol skips message types added by a newer
    /// daemon instead of erroring the connection. Clients should treat this as
    /// a benign no-op. Re-serializing it is lossy and must be avoided.
    #[serde(other)]
    Unknown,
}

impl ServerMessage {
    /// Attach a request ID to request-scoped responses.
    ///
    /// Unsolicited push/broadcast messages intentionally ignore `rid`.
    #[must_use]
    pub fn with_rid(mut self, rid: Option<String>) -> Self {
        // Exactly one arm runs per call, so `rid` is moved into the matched
        // field rather than cloned per variant.
        match &mut self {
            ServerMessage::History(msg) => msg.rid = rid,
            ServerMessage::CommandOutput(msg) => msg.rid = rid,
            ServerMessage::Error(msg) => msg.rid = rid,
            ServerMessage::StreamStart(msg) => msg.rid = rid,
            ServerMessage::StreamChunk(msg) => msg.rid = rid,
            ServerMessage::StreamEnd(msg) => msg.rid = rid,
            ServerMessage::Phase(msg) => msg.rid = rid,
            ServerMessage::ToolCall(msg) => msg.rid = rid,
            ServerMessage::ToolResult(msg) => msg.rid = rid,
            ServerMessage::SendImage(msg) => msg.rid = rid,
            ServerMessage::ProviderFallbackWarning(msg) => msg.rid = rid,
            ServerMessage::UsageWarning(msg) => msg.rid = rid,
            ServerMessage::Hello(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::Unknown => {}
        }
        self
    }

    /// The sub-agent name tagged on this frame, if any. `None` is primary-model
    /// (or non-stream) activity. Lets clients bracket nested `ask_<name>` output
    /// by watching the tag transition on/off.
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
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::Unknown => None,
        }
    }

    /// Tag a stream/tool frame as belonging to a sub-agent's nested loop.
    ///
    /// Used by the sub-agent forwarder to attribute the messages it relays from
    /// an `ask_<name>` loop, so clients render them as nested activity. Frame
    /// types that a sub-agent loop never emits are left untouched.
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
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::Unknown => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_type_deserializes_to_unknown_variant() {
        // A frame type a future daemon adds must not fail deserialization on an
        // older client; it lands in `Unknown` so the client can skip it instead
        // of erroring the connection.
        let json = r#"{"type":"some_future_message","field":42}"#;
        let msg: ServerMessage = serde_json::from_str(json).expect("must not error");
        assert!(matches!(msg, ServerMessage::Unknown));
    }

    #[test]
    fn known_types_still_deserialize_to_their_variant() {
        // The catch-all must not shadow real variants.
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
        });
        chunk.set_subagent("research");
        assert_eq!(chunk.subagent(), Some("research"));

        // A frame type a sub-agent loop never emits is left untouched.
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
        });
        call.set_subagent("research");
        let wire = serde_json::to_string(&call).unwrap();
        assert!(wire.contains("\"subagent\":\"research\""), "wire: {wire}");
        let back: ServerMessage = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.subagent(), Some("research"));
    }

    #[test]
    fn untagged_frame_omits_subagent_on_the_wire() {
        // `skip_serializing_if` keeps the field off the wire for primary frames,
        // so the cache prefix and existing-client parsing stay unchanged.
        let call = ServerMessage::ToolCall(ToolCall {
            rid: None,
            tool_id: "t1".into(),
            tool_name: "search".into(),
            input: serde_json::json!({}),
            subagent: None,
        });
        let wire = serde_json::to_string(&call).unwrap();
        assert!(!wire.contains("subagent"), "wire: {wire}");
    }
}
