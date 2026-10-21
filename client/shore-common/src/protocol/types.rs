use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct ImageRef {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl PartialEq for ImageRef {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
            && self.caption == other.caption
            && self.embed == other.embed
            && self.name == other.name
            && self.problem == other.problem
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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(untagged)]
pub enum ToolResultContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl From<String> for ToolResultContent {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<&str> for ToolResultContent {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl ToolResultContent {
    pub fn display_text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Blocks(blocks) => derive_content_from_blocks(blocks),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImageSource {
    Base64 { media_type: String, data: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, schemars::JsonSchema, ts_rs::TS)]
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
        #[schemars(with = "Option<String>")]
        signature: Option<ThinkingSignature>,
    },
    ToolUse {
        id: String,
        name: String,
        #[ts(type = "unknown")]
        input: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        thought_signature: Option<String>,
    },
    RedactedThinking {
        data: String,
    },
    Image {
        source: ImageSource,
    },
    ToolResult {
        tool_use_id: String,
        content: ToolResultContent,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

#[derive(
    Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, schemars::JsonSchema, ts_rs::TS,
)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum MessageOrigin {
    UserInput,
    AssistantReply,
    Autonomous,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, schemars::JsonSchema, ts_rs::TS)]
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
    pub fn display_images(&self) -> Vec<ImageRef> {
        let mut images = self.images.clone();
        append_inline_images(&mut images, &self.msg_id, &self.content_blocks);
        images
    }

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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct TimingInfo {
    pub total_ms: u32,
    pub ttft_ms: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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
    let mut parts: Vec<String> = Vec::new();

    for block in blocks {
        match block {
            ContentBlock::Text { text } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_owned());
                }
            }
            ContentBlock::ToolResult { content, .. } if include_tool_results => {
                let text = content.display_text();
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_owned());
                }
            }
            ContentBlock::Image { .. } => parts.push("[Image attached]".to_owned()),
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

pub fn inline_images(blocks: &[ContentBlock]) -> Vec<&ImageSource> {
    let mut images = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Image { source } => images.push(source),
            ContentBlock::ToolResult {
                content: ToolResultContent::Blocks(nested),
                ..
            } => images.extend(inline_images(nested)),
            ContentBlock::ToolResult {
                content: ToolResultContent::Text(_),
                ..
            }
            | ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::Text { .. } => {}
        }
    }
    images
}

pub fn append_inline_images(images: &mut Vec<ImageRef>, scope: &str, blocks: &[ContentBlock]) {
    use std::hash::{Hash, Hasher};
    for block in blocks {
        let ContentBlock::Image { source } = block else {
            continue;
        };
        let ImageSource::Base64 { media_type, data } = source;
        if images
            .iter()
            .any(|image| image.data.as_deref() == Some(data.as_str()))
        {
            continue;
        }
        let mut identity = std::hash::DefaultHasher::new();
        data.hash(&mut identity);
        images.push(ImageRef {
            path: format!("embedded/{scope}/{:x}", identity.finish()),
            caption: Some(format!("Embedded {} image", media_type)),
            data: Some(data.clone()),
            ..ImageRef::default()
        });
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, schemars::JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct CharacterAvatar {
    pub mime_type: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, schemars::JsonSchema, ts_rs::TS)]
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
    fn a_signature_shaped_like_a_carrier_fails_closed() {
        let collided = ThinkingSignature::Opaque("orrd:not-really".into());
        let round_tripped = ThinkingSignature::from_wire(&collided.to_wire());
        assert_ne!(round_tripped, collided);
        assert_eq!(round_tripped.as_opaque(), None);
    }
}
