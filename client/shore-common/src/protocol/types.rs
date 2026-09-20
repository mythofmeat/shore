use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ImageRef {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

impl PartialEq for ImageRef {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.caption == other.caption
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThinkingSignature {
    Opaque(String),
    OpenrouterDetails(String),
    ZaiReasoning(String),
}

impl ThinkingSignature {
    const OPENROUTER_PREFIX: &'static str = "orrd:";
    const ZAI_PREFIX: &'static str = "zair:";

    pub fn from_wire(s: &str) -> Self {
        if let Some(rest) = s.strip_prefix(Self::OPENROUTER_PREFIX) {
            Self::OpenrouterDetails(rest.to_owned())
        } else if let Some(rest) = s.strip_prefix(Self::ZAI_PREFIX) {
            Self::ZaiReasoning(rest.to_owned())
        } else {
            Self::Opaque(s.to_owned())
        }
    }

    pub fn to_wire(&self) -> String {
        match self {
            Self::Opaque(s) => s.clone(),
            Self::OpenrouterDetails(s) => format!("{}{s}", Self::OPENROUTER_PREFIX),
            Self::ZaiReasoning(s) => format!("{}{s}", Self::ZAI_PREFIX),
        }
    }

    pub fn as_opaque(&self) -> Option<&str> {
        match self {
            Self::Opaque(s) => Some(s),
            Self::OpenrouterDetails(_) | Self::ZaiReasoning(_) => None,
        }
    }

    pub fn is_foreign_carrier(&self) -> bool {
        self.as_opaque().is_none()
    }
}

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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum MessageOrigin {
    UserInput,
    AssistantReply,
    Autonomous,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct Message {
    pub msg_id: String,
    pub role: Role,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageRef>,
    pub content_blocks: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternatives: Vec<MessageAlternative>,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<MessageOrigin>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct MessageAlternative {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageRef>,
    pub content_blocks: Vec<ContentBlock>,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl MessageAlternative {
    pub fn normalize(&mut self) {
        self.content = derive_content_from_blocks(&self.content_blocks);
    }
}

impl Message {
    pub fn normalize(&mut self) {
        self.content = derive_content_from_blocks(&self.content_blocks);

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
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
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

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct TimingInfo {
    pub total_ms: u32,
    pub ttft_ms: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct StreamMetadata {
    pub tokens: TokenCounts,
    pub timing: TimingInfo,
    pub model: String,
}

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

pub fn derive_content_from_blocks(blocks: &[ContentBlock]) -> String {
    derive_content_from_blocks_with(blocks, true)
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CharacterAvatar {
    pub mime_type: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
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

    #[test]
    fn thinking_signature_storage_format_is_unchanged() {
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

        assert!(!ThinkingSignature::from_wire("sig_abc").is_foreign_carrier());
        assert!(ThinkingSignature::from_wire("orrd:[]").is_foreign_carrier());
        assert!(ThinkingSignature::from_wire("zair:hmm").is_foreign_carrier());
    }

    #[test]
    fn a_signature_shaped_like_a_carrier_fails_closed() {
        let collided = ThinkingSignature::Opaque("orrd:not-really".into());
        let round_tripped = ThinkingSignature::from_wire(&collided.to_wire());
        assert_ne!(round_tripped, collided);
        assert!(round_tripped.is_foreign_carrier());
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
