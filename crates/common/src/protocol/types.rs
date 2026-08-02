use serde::{Deserialize, Serialize};

/// Role of a message participant.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
}

/// Reference to an image file.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct ImageRef {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    /// Base64-encoded image data for wire transfer. Stripped on disk storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

impl PartialEq for ImageRef {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.caption == other.caption
    }
}

/// The opaque payload a provider attaches to a thinking block so the *next*
/// request can replay that reasoning.
///
/// Three unrelated things ride this slot, because Anthropic's block shape is
/// the only one the conversation store has and the other providers' equivalents
/// have nowhere else to go:
///
/// - [`Self::Opaque`] — a real signature (Anthropic, and Gemini's
///   `thoughtSignature`). Bytes we never inspect, replayed verbatim.
/// - [`Self::OpenrouterDetails`] — OpenRouter's `reasoning_details` array,
///   JSON-encoded.
/// - [`Self::ZaiReasoning`] — Z.AI's `reasoning_content`, verbatim text.
///
/// All three are **model-bound**: replaying one to anything but its minter is
/// an HTTP 400. Only `Opaque` is ever a valid Anthropic `signature`, which is
/// why [`Self::is_foreign_carrier`] exists.
///
/// # Serialization
///
/// Serializes as a single prefixed string (`orrd:…`, `zair:…`, or the bare
/// signature) because that is the format already written to every stored
/// conversation. The prefix is this enum's wire encoding and nothing else
/// should parse it — that is the point of the type. Prefix collision is
/// possible in principle (a real signature beginning `orrd:`); it has never
/// been observed, and treating one as a carrier fails closed by refusing to
/// replay rather than sending an invalid block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThinkingSignature {
    /// Verbatim provider signature — Anthropic, or Gemini's `thoughtSignature`.
    Opaque(String),
    /// OpenRouter `reasoning_details`, JSON-encoded.
    OpenrouterDetails(String),
    /// Z.AI Preserved-Thinking `reasoning_content`, verbatim.
    ZaiReasoning(String),
}

impl ThinkingSignature {
    const OPENROUTER_PREFIX: &'static str = "orrd:";
    const ZAI_PREFIX: &'static str = "zair:";

    /// Parse the stored prefixed form.
    pub fn from_wire(s: &str) -> Self {
        if let Some(rest) = s.strip_prefix(Self::OPENROUTER_PREFIX) {
            Self::OpenrouterDetails(rest.to_owned())
        } else if let Some(rest) = s.strip_prefix(Self::ZAI_PREFIX) {
            Self::ZaiReasoning(rest.to_owned())
        } else {
            Self::Opaque(s.to_owned())
        }
    }

    /// The stored prefixed form.
    pub fn to_wire(&self) -> String {
        match self {
            Self::Opaque(s) => s.clone(),
            Self::OpenrouterDetails(s) => format!("{}{s}", Self::OPENROUTER_PREFIX),
            Self::ZaiReasoning(s) => format!("{}{s}", Self::ZAI_PREFIX),
        }
    }

    /// The verbatim signature, if this is one. `None` for the non-Anthropic
    /// carriers, which must never be sent as a `signature`.
    pub fn as_opaque(&self) -> Option<&str> {
        match self {
            Self::Opaque(s) => Some(s),
            Self::OpenrouterDetails(_) | Self::ZaiReasoning(_) => None,
        }
    }

    /// True for a carrier bound to a specific non-Anthropic wire shape. Such a
    /// block cannot cross onto the Anthropic shape no matter which upstream
    /// serves it, so replay is refused regardless of recorded provenance.
    pub fn is_foreign_carrier(&self) -> bool {
        self.as_opaque().is_none()
    }
}

/// Parsing, not wrapping: a stored string that carries a prefix becomes the
/// carrier variant it names, so no conversion path can mis-tag one as `Opaque`.
impl From<&str> for ThinkingSignature {
    fn from(s: &str) -> Self {
        Self::from_wire(s)
    }
}

impl From<String> for ThinkingSignature {
    fn from(s: String) -> Self {
        Self::from_wire(&s)
    }
}

impl Serialize for ThinkingSignature {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_wire())
    }
}

impl<'de> Deserialize<'de> for ThinkingSignature {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::from_wire(&String::deserialize(deserializer)?))
    }
}

/// A structured content block within a message.
///
/// Messages can contain a sequence of content blocks representing text,
/// thinking/reasoning, tool invocations, and tool results. This preserves
/// the full fidelity of what happened during generation.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(as = "Option<String>")]
        signature: Option<ThinkingSignature>,
    },
    ToolUse {
        id: String,
        name: String,
        #[ts(type = "unknown")]
        input: serde_json::Value,
    },
    RedactedThinking {
        data: String,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// How a message entered the conversation.
///
/// Persisted on [`Message`] (and echoed on `NewMessage` pushes) so that
/// history consumers can distinguish autonomous (heartbeat-initiated)
/// assistant messages from replies. `None` on a stored message means the
/// origin was not recorded (messages persisted before origin tracking, or
/// ordinary user/assistant turns where the role already implies it).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum MessageOrigin {
    UserInput,
    AssistantReply,
    Autonomous,
}

/// A chat message. One shape everywhere — no polymorphism.
///
/// `content_blocks` is the canonical content representation.
/// `content` is a derived convenience field (human-readable text summary).
/// On disk, only `content_blocks` is stored; `content` is derived on load.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct Message {
    pub msg_id: String,
    pub role: Role,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageRef>,
    #[serde(default)]
    pub content_blocks: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternatives: Vec<MessageAlternative>,
    pub timestamp: String,
    /// Provider key that minted this message's content (e.g. `"anthropic"`,
    /// `"openrouter-anthropic"`). Opaque thinking data — `thinking`
    /// signatures and `redacted_thinking` blobs — is bound to its minting
    /// provider and is not portable across a provider switch; the replay path
    /// uses this to drop blocks the active provider cannot interpret. `None`
    /// for messages persisted before provenance tracking, or for messages
    /// (user turns, system recaps) that carry no provider-bound data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    /// Model id that minted this message's content (e.g. `"claude-opus-4-6"`,
    /// `"anthropic/claude-opus-4.6"`), in the same vocabulary as the usage
    /// ledger. Unlike [`Message::provider_key`] (which drives thinking-replay
    /// portability), this is pure provenance: it lets history tooling
    /// attribute a stored turn to the model that generated it. `None` for
    /// messages persisted before model provenance tracking and for messages
    /// no model minted (user turns, system recaps).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// How this message entered the conversation. Currently only
    /// `Some(Autonomous)` is persisted (heartbeat `<sendMessage>` output);
    /// compaction's deep-idle archive uses it to keep unanswered autonomous
    /// messages visible across an archive boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<MessageOrigin>,
}

/// Stored alternate body for a regenerated assistant message.
///
/// `Message` keeps the currently selected alternative in its top-level
/// `content`/`content_blocks` fields so existing clients and prompt assembly
/// keep reading the active response. `alternatives` stores every selectable
/// candidate, including the active one.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct MessageAlternative {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageRef>,
    #[serde(default)]
    pub content_blocks: Vec<ContentBlock>,
    #[serde(default)]
    pub timestamp: String,
    /// Provider key that minted this alternative's content. A regenerated
    /// assistant body can be produced under a different provider than the
    /// original message or a sibling alternative, so each alternative carries
    /// its own provenance rather than inheriting the single
    /// [`Message::provider_key`]. The replay portability filter uses this to
    /// drop opaque thinking data the active provider cannot interpret. `None`
    /// for alternatives persisted before per-alternative provenance tracking,
    /// in which case callers fall back to [`Message::provider_key`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    /// Model id that minted this alternative's content. Like
    /// [`MessageAlternative::provider_key`], each alternative carries its own
    /// provenance because regenerated bodies can come from different models.
    /// `None` for alternatives persisted before model provenance tracking, in
    /// which case callers fall back to [`Message::model`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl MessageAlternative {
    /// Ensure `content` and `content_blocks` are consistent after
    /// deserialization, matching [`Message::normalize`].
    pub fn normalize(&mut self) {
        if self.content_blocks.is_empty() && !self.content.is_empty() {
            self.content_blocks = vec![ContentBlock::Text {
                text: self.content.clone(),
            }];
        } else if !self.content_blocks.is_empty() {
            self.content = derive_content_from_blocks(&self.content_blocks);
        } else {
            // Both empty: nothing to reconcile.
        }
    }
}

impl Message {
    /// Ensure `content` and `content_blocks` are consistent after deserialization.
    ///
    /// Handles both old format (content only) and new format (content_blocks only):
    /// - Old: wraps `content` in a `Text` block
    /// - New: derives `content` from blocks
    pub fn normalize(&mut self) {
        if self.content_blocks.is_empty() && !self.content.is_empty() {
            // Legacy format: content present but no blocks.
            self.content_blocks = vec![ContentBlock::Text {
                text: self.content.clone(),
            }];
        } else if !self.content_blocks.is_empty() {
            // Canonical: derive content from blocks.
            self.content = derive_content_from_blocks(&self.content_blocks);
        } else {
            // Both empty: nothing to reconcile.
        }

        for alt in &mut self.alternatives {
            alt.normalize();
        }
        if !self.alternatives.is_empty() {
            let count = u32::try_from(self.alternatives.len()).unwrap_or(u32::MAX);
            self.alt_count = Some(count);
            let index = self.alt_index.unwrap_or(count.saturating_sub(1));
            self.alt_index = Some(index.min(count.saturating_sub(1)));
        }
    }

    /// True when this is a user-role message whose content consists
    /// entirely of `ToolResult` blocks — i.e. a synthetic tool-loop
    /// message rather than a real user turn.
    ///
    /// Used by compaction, history rendering, and turn-counting logic.
    pub fn is_tool_result_only(&self) -> bool {
        if self.role != Role::User {
            return false;
        }
        !self.content_blocks.is_empty()
            && self
                .content_blocks
                .iter()
                .all(|b| matches!(b, ContentBlock::ToolResult { .. }))
    }

    /// Serialize for disk storage, omitting the redundant `content` field
    /// and stripping inline `data` from image refs.
    ///
    /// The wire protocol (History, log command) still includes `content` via
    /// normal serde serialization. This method is only for JSONL persistence.
    pub fn serialize_for_storage(&self) -> Result<String, serde_json::Error> {
        let mut val = serde_json::to_value(self)?;
        if let Some(obj) = val.as_object_mut() {
            let _ignored = obj.remove("content");

            // Strip inline image data — storage uses paths, not embedded bytes.
            let strip_image_data = |images: Option<&mut serde_json::Value>| {
                if let Some(arr) = images.and_then(|v| v.as_array_mut()) {
                    for img in arr {
                        if let Some(img_obj) = img.as_object_mut() {
                            let _removed = img_obj.remove("data");
                        }
                    }
                }
            };

            strip_image_data(obj.get_mut("images"));

            // `alternatives` (regenerated responses) carry their own image refs,
            // which must be stripped too or they persist base64 blobs to disk.
            if let Some(alternatives) = obj.get_mut("alternatives").and_then(|v| v.as_array_mut()) {
                for alternative in alternatives {
                    if let Some(alt_obj) = alternative.as_object_mut() {
                        strip_image_data(alt_obj.get_mut("images"));
                    }
                }
            }
        }
        serde_json::to_string(&val)
    }
}

/// Token usage counts from a generation.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct TokenCounts {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
}

/// Timing information for a generation.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct TimingInfo {
    pub total_ms: u32,
    pub ttft_ms: u32,
}

/// Metadata attached to stream_end.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct StreamMetadata {
    pub tokens: TokenCounts,
    pub timing: TimingInfo,
    pub model: String,
}

/// Derive a human-readable text summary from content blocks.
///
/// Joins all `Text` block contents (trimmed), and optionally `ToolResult`
/// contents, skipping thinking, redacted thinking, and tool use blocks
/// which are not user-visible text.
///
/// When `include_tool_results` is true, this is the canonical way to produce
/// `Message.content`. When false, only `Text` blocks contribute (used for
/// merged messages where tool results are already embedded in content_blocks).
pub fn derive_content_from_blocks_with(
    blocks: &[ContentBlock],
    include_tool_results: bool,
) -> String {
    let mut parts: Vec<&str> = Vec::new();

    for block in blocks {
        match block {
            ContentBlock::Text { text } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed);
                }
            }
            ContentBlock::ToolResult { content, .. } if include_tool_results => {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed);
                }
            }
            ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => {}
        }
    }

    parts.join("\n")
}

/// Derive a human-readable text summary from content blocks (including tool results).
pub fn derive_content_from_blocks(blocks: &[ContentBlock]) -> String {
    derive_content_from_blocks_with(blocks, true)
}

/// Base64-encoded character avatar for clients that cannot read the daemon's
/// local config filesystem.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct CharacterAvatar {
    pub mime_type: String,
    pub data: String,
}

/// Information about a character.
#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../llm-sidecar/src/protocol/")]
pub struct CharacterInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<CharacterAvatar>,
}

impl CharacterInfo {
    pub fn new<N: Into<String>>(name: N) -> Self {
        Self {
            name: name.into(),
            avatar: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field<'val>(value: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        value.get(key).expect("expected JSON field")
    }

    #[test]
    fn thinking_signature_storage_format_is_unchanged() {
        // Every stored conversation already holds these as prefixed strings.
        // The enum is an in-memory shape, not a format change — if this test
        // fails, existing histories stop round-tripping.
        let cases = [
            (ThinkingSignature::Opaque("sig_abc".into()), "\"sig_abc\""),
            (
                ThinkingSignature::OpenrouterDetails(r#"[{"index":0}]"#.into()),
                r#""orrd:[{\"index\":0}]""#,
            ),
            (
                ThinkingSignature::ZaiReasoning("step 1".into()),
                "\"zair:step 1\"",
            ),
        ];
        for (sig, expected_json) in cases {
            let json = serde_json::to_string(&sig).expect("serialize");
            assert_eq!(json, expected_json);
            let back: ThinkingSignature = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, sig);
        }
    }

    #[test]
    fn carrier_prefixes_classify_on_load() {
        assert_eq!(
            ThinkingSignature::from_wire("sig_abc").as_opaque(),
            Some("sig_abc")
        );
        assert_eq!(
            ThinkingSignature::from_wire("orrd:[]"),
            ThinkingSignature::OpenrouterDetails("[]".into())
        );
        assert_eq!(
            ThinkingSignature::from_wire("zair:hmm"),
            ThinkingSignature::ZaiReasoning("hmm".into())
        );

        // Only a real signature may be sent as one; the carriers must not.
        assert!(!ThinkingSignature::from_wire("sig_abc").is_foreign_carrier());
        assert!(ThinkingSignature::from_wire("orrd:[]").is_foreign_carrier());
        assert!(ThinkingSignature::from_wire("zair:hmm").is_foreign_carrier());
    }

    #[test]
    fn a_signature_shaped_like_a_carrier_fails_closed() {
        // The prefix is the wire encoding, so a genuine Anthropic signature
        // beginning `orrd:` would be read back as a carrier. Never observed,
        // and the consequence is refusing to replay a valid block rather than
        // sending an invalid one — which is the direction to fail in.
        let collided = ThinkingSignature::Opaque("orrd:not-really".into());
        let round_tripped = ThinkingSignature::from_wire(&collided.to_wire());
        assert_ne!(round_tripped, collided);
        assert!(round_tripped.is_foreign_carrier());
    }

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    #[test]
    fn derive_content_empty_blocks() {
        assert_eq!(derive_content_from_blocks(&[]), "");
    }

    #[test]
    fn derive_content_text_only() {
        let blocks = vec![ContentBlock::Text {
            text: "hello world".into(),
        }];
        assert_eq!(derive_content_from_blocks(&blocks), "hello world");
    }

    #[test]
    fn derive_content_trims_whitespace() {
        let blocks = vec![ContentBlock::Text {
            text: "\n\n".into(),
        }];
        assert_eq!(derive_content_from_blocks(&blocks), "");
    }

    #[test]
    fn derive_content_tool_result() {
        let blocks = vec![ContentBlock::ToolResult {
            tool_use_id: "t1".into(),
            content: "2026-03-29T10:00:00Z".into(),
            is_error: false,
        }];
        assert_eq!(derive_content_from_blocks(&blocks), "2026-03-29T10:00:00Z");
    }

    #[test]
    fn derive_content_skips_thinking_and_tool_use() {
        let blocks = vec![
            ContentBlock::Thinking {
                thinking: "Let me think...".into(),
                signature: None,
            },
            ContentBlock::ToolUse {
                id: "t1".into(),
                name: "check_time".into(),
                input: serde_json::json!({}),
            },
            ContentBlock::RedactedThinking {
                data: "opaque".into(),
            },
            ContentBlock::Text {
                text: "The answer".into(),
            },
        ];
        assert_eq!(derive_content_from_blocks(&blocks), "The answer");
    }

    #[test]
    fn derive_content_multiple_text_blocks() {
        let blocks = vec![
            ContentBlock::Text {
                text: "first".into(),
            },
            ContentBlock::Text {
                text: "second".into(),
            },
        ];
        assert_eq!(derive_content_from_blocks(&blocks), "first\nsecond");
    }

    // ── normalize() ──────────────────────────────────────────────────

    fn make_msg(content: &str, blocks: Vec<ContentBlock>) -> Message {
        Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::User,
            content: content.into(),
            images: vec![],
            content_blocks: blocks,
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn normalize_legacy_wraps_content_in_text_block() {
        let mut msg = make_msg("hello world", vec![]);
        msg.normalize();
        assert_eq!(msg.content_blocks.len(), 1);
        assert!(
            matches!(item(&msg.content_blocks, 0), ContentBlock::Text { text } if text == "hello world")
        );
        assert_eq!(msg.content, "hello world");
    }

    #[test]
    fn normalize_canonical_derives_content_from_blocks() {
        let mut msg = make_msg(
            "",
            vec![ContentBlock::Text {
                text: "derived".into(),
            }],
        );
        msg.normalize();
        assert_eq!(msg.content, "derived");
        assert_eq!(msg.content_blocks.len(), 1);
    }

    #[test]
    fn normalize_both_empty_is_noop() {
        let mut msg = make_msg("", vec![]);
        msg.normalize();
        assert_eq!(msg.content, "");
        assert!(msg.content_blocks.is_empty());
    }

    // ── serialize_for_storage() ─────────────────────────────────────

    #[test]
    fn serialize_for_storage_omits_content_field() {
        let msg = make_msg(
            "should be removed",
            vec![ContentBlock::Text {
                text: "canonical".into(),
            }],
        );
        let json_str = msg.serialize_for_storage().unwrap();
        let val: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(
            val.get("content").is_none(),
            "content field should be omitted"
        );
        assert!(val.get("content_blocks").is_some());
    }

    #[test]
    fn serialize_for_storage_roundtrips_other_fields() {
        let msg = make_msg(
            "ignored",
            vec![ContentBlock::Text {
                text: "hello".into(),
            }],
        );
        let json_str = msg.serialize_for_storage().unwrap();
        let val: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(field(&val, "msg_id"), "m1");
        assert_eq!(field(&val, "role"), "user");
        assert_eq!(field(&val, "timestamp"), "2026-01-01T00:00:00Z");
    }

    #[test]
    fn serialize_for_storage_strips_inline_image_data_everywhere() {
        let mut msg = make_msg(
            "ignored",
            vec![ContentBlock::Text {
                text: "active".into(),
            }],
        );
        msg.images = vec![ImageRef {
            path: "/img/top.png".into(),
            caption: None,
            data: Some("TOPDATA".into()),
        }];
        msg.alternatives = vec![MessageAlternative {
            content: "alt".into(),
            images: vec![ImageRef {
                path: "/img/alt.png".into(),
                caption: None,
                data: Some("ALTDATA".into()),
            }],
            content_blocks: vec![],
            timestamp: "2026-01-01T00:00:00Z".into(),
            provider_key: None,
            model: None,
        }];

        let json_str = msg.serialize_for_storage().unwrap();
        assert!(
            !json_str.contains("TOPDATA"),
            "top-level image data must be stripped"
        );
        assert!(
            !json_str.contains("ALTDATA"),
            "alternative image data must be stripped"
        );
        // Image paths are retained — storage references files by path.
        assert!(json_str.contains("/img/alt.png"));
    }

    // ── derive_content_from_blocks_with ─────────────────────────────

    #[test]
    fn derive_content_excludes_tool_results_when_flag_false() {
        let blocks = vec![
            ContentBlock::Text {
                text: "hello".into(),
            },
            ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "result".into(),
                is_error: false,
            },
        ];
        assert_eq!(derive_content_from_blocks_with(&blocks, false), "hello");
        assert_eq!(
            derive_content_from_blocks_with(&blocks, true),
            "hello\nresult"
        );
    }

    #[test]
    fn derive_content_mixed_text_and_tool_result() {
        let blocks = vec![
            ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "tool output".into(),
                is_error: false,
            },
            ContentBlock::ToolResult {
                tool_use_id: "t2".into(),
                content: "more output".into(),
                is_error: false,
            },
        ];
        assert_eq!(
            derive_content_from_blocks(&blocks),
            "tool output\nmore output"
        );
    }
}
