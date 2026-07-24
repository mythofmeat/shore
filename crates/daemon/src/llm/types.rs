use serde::{Deserialize, Serialize};
use shore_common::config::models::Sdk;
pub use shore_common::protocol::types::ContentBlock;

/// Request body for the daemon's llm module's POST /v1/stream and POST /v1/generate endpoints.
///
/// The daemon sends fully-resolved config per-request because the daemon's llm module is
/// zero-config — it has no model database or API key storage.
///
/// `Debug` is hand-written (below) to redact `api_key`: tracing spans
/// capture arguments via `Debug`, so a derived impl would write the key
/// verbatim to stderr/journald. Only `Debug` is redacted — `Serialize`
/// must keep the real key for sidecar transport.
#[derive(Clone, Serialize)]
pub struct LlmRequest {
    /// SDK/wire protocol to use for this request.
    pub sdk: Sdk,

    /// Provider's model identifier (e.g. "claude-sonnet-4-20250514").
    pub model: String,

    /// API key resolved from the environment variable specified in models.toml.
    pub api_key: String,

    /// Friendly configured key name, e.g. "default", "budget", or
    /// "overflow". Transient metadata for usage attribution only; never sent
    /// to providers.
    #[serde(skip)]
    pub api_key_name: Option<String>,

    /// Optional base URL override (for OpenAI-compatible providers).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,

    /// Conversation messages in LLM-native format.
    pub messages: Vec<serde_json::Value>,

    /// System prompt blocks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<serde_json::Value>,

    /// Tool definitions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<serde_json::Value>>,

    /// Maximum tokens to generate.
    pub max_tokens: u32,

    /// Sampling temperature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,

    /// Nucleus sampling top-p.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,

    /// Provider-specific options (cache_ttl, thinking, budget_tokens, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<serde_json::Value>,

    /// Provider key from models.toml (e.g. "openrouter", "deepseek", "xai").
    /// Distinct from `provider` (SDK protocol). Used for provider-specific behavior.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,

    /// Optional request ID for distributed tracing (sent as X-Request-ID header).
    #[serde(skip)]
    pub rid: Option<String>,

    /// Character name — transient, for cache forensic logging only.
    #[serde(skip)]
    pub forensic_character: Option<String>,

    /// Transient flag: this request belongs to a low-frequency, high-value
    /// background task (compaction, dreaming, heartbeat) whose payload
    /// logs should be kept on a longer retention tier than per-turn chat
    /// payloads.
    ///
    /// `debug_log::log_request` routes flagged calls to a separate
    /// `debug/api_logs_long/` subdirectory so operators can prune
    /// chat-volume payloads aggressively (e.g. 3 days) while keeping
    /// these for forensic analysis (e.g. 30 days). The flag carries no
    /// wire-format meaning and is skipped from serialization.
    #[serde(skip)]
    pub retain_long: bool,

    /// Resolved per-model cache-keepalive interval (`cache_keepalive` in
    /// `[models.*]`): `Some(interval)` to ping the prompt cache every
    /// `interval` while idle, `None` when keepalive is off for this model.
    /// Transient daemon-side scheduling hint — carries no wire meaning and is
    /// never sent to providers; the autonomy manager reads it off the cached
    /// `last_request` to drive the standalone keepalive subsystem.
    #[serde(skip)]
    pub keepalive_interval: Option<std::time::Duration>,
}

impl std::fmt::Debug for LlmRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmRequest")
            .field("sdk", &self.sdk)
            .field("model", &self.model)
            .field("api_key", &"<redacted>")
            .field("api_key_name", &self.api_key_name)
            .field("base_url", &self.base_url)
            .field("messages", &self.messages)
            .field("system", &self.system)
            .field("tools", &self.tools)
            .field("max_tokens", &self.max_tokens)
            .field("temperature", &self.temperature)
            .field("top_p", &self.top_p)
            .field("provider_options", &self.provider_options)
            .field("provider_key", &self.provider_key)
            .field("rid", &self.rid)
            .field("forensic_character", &self.forensic_character)
            .field("retain_long", &self.retain_long)
            .field("keepalive_interval", &self.keepalive_interval)
            .finish()
    }
}

impl LlmRequest {
    /// Append a task-specific instruction as an inline `role:"system"`
    /// message at the current tail of `messages`.
    ///
    /// This is the only sanctioned way to attach a task-specific system
    /// instruction to a request that will subsequently drive a tool loop
    /// (compaction, dreaming/librarian, heartbeat). The entry's INDEX in
    /// `messages` is captured at push time and stays fixed even after
    /// the tool loop pushes `assistant` + `user(tool_result)` onto the
    /// tail — which is what keeps Anthropic's content-addressed prefix
    /// cache valid across iterations.
    ///
    /// Per-adapter handling of the resulting inline `role:"system"` now lives
    /// in the TypeScript sidecar. Anthropic-family adapters merge the block
    /// into the immediately preceding user message; OpenAI-family adapters
    /// either wrap it as a user `<system_instruction>` or pass through a real
    /// mid-history `role:"system"`, depending on provider dialect. Because the
    /// slot is fixed, any merge/wrap target is fixed too.
    ///
    /// This replaces the deleted `system_suffix` field. That field was a
    /// footgun: `preprocess_request` re-expanded it into a trailing
    /// `role:"system"` at the CURRENT tail on every `generate()` call,
    /// so any caller that ran a tool loop saw the system slot drift
    /// across iterations and lost the Anthropic prefix cache. PRs #80
    /// (compaction) and #84 (dreaming + heartbeat) each fixed one
    /// caller; removing the field eliminates the bug class.
    pub fn push_inline_system<C: Into<String>>(&mut self, content: C) {
        self.messages.push(serde_json::json!({
            "role": "system",
            "content": content.into(),
        }));
    }
}

/// Token usage counts from the daemon's llm module's normalized response.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
    /// Provider-reported total cost when available (e.g. OpenRouter
    /// returns this on a `cost` field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
}

/// Timing information from the daemon's llm module's normalized response.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Timing {
    pub total_ms: u32,
    #[serde(default)]
    pub time_to_first_token_ms: u32,
}

/// A single event in the daemon's llm module's newline-delimited JSON stream.
///
/// the daemon's llm module emits these as one JSON object per line:
/// ```text
/// {"type":"start","model":"claude-sonnet-4-6"}
/// {"type":"text","text":"Hello"}
/// {"type":"thinking","text":"Let me consider..."}
/// {"type":"tool_use","id":"tool_01","name":"memory","input":{...}}
/// {"type":"done","content":"Hello","finish_reason":"end_turn","usage":{...},"timing":{...}}
/// ```
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Start {
        model: String,
    },
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ThinkingSignature {
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    Done {
        content: String,
        finish_reason: String,
        usage: Usage,
        timing: Timing,
    },
    /// A no-op keepalive emitted by the sidecar during quiet stretches (e.g. a
    /// long max-effort thinking turn where the provider sends only `ping`s,
    /// which we do not forward). Carries no data; its sole purpose is to keep
    /// bytes flowing on the daemon↔sidecar socket so the transport's idle
    /// timeout cannot fire mid-stream. The consumer ignores it.
    Ping,
    /// The provider stream failed mid-flight. Carries whatever usage the
    /// provider had accumulated before the error (e.g. Anthropic reports the
    /// cache write in `message_start`, before any output) so the ledger can
    /// record the already-billed tokens instead of zeros. The consumer turns
    /// this into [`crate::llm::LlmError::StreamErrored`] and still fails the call so
    /// the normal retry path runs.
    Error {
        #[serde(default)]
        message: String,
        #[serde(default)]
        usage: Usage,
        #[serde(default)]
        timing: Timing,
    },
}

/// A tool_use event extracted from the stream for the engine's tool loop.
#[derive(Debug, Clone)]
pub struct ToolUseEvent {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// The accumulated result after a stream completes.
#[derive(Debug, Clone)]
pub struct StreamResult {
    /// The final assembled content from the "done" event.
    pub content: String,

    /// The model that produced this response.
    pub model: String,

    /// Why the model stopped generating.
    pub finish_reason: String,

    /// Token usage from the response.
    pub usage: Usage,

    /// Timing data from the daemon's llm module.
    pub timing: Timing,

    /// Tool invocations encountered during the stream.
    pub tool_uses: Vec<ToolUseEvent>,

    /// Structured content blocks accumulated during streaming.
    ///
    /// Contains the full sequence of text, thinking, and tool_use blocks
    /// in the order they were received. Used for persistence.
    pub content_blocks: Vec<ContentBlock>,
}

/// Parameters for an image generation request.
///
/// `Debug` is hand-written to redact `api_key`, same as [`LlmRequest`].
#[derive(Clone)]
pub struct ImageGenerateParams<'val> {
    pub provider_key: &'val str,
    pub model: &'val str,
    pub api_key: &'val str,
    pub base_url: Option<&'val str>,
    pub prompt: &'val str,
    pub size: Option<&'val str>,
    pub quality: Option<&'val str>,
    pub aspect_ratio: Option<&'val str>,
    pub image_size: Option<&'val str>,
}

impl std::fmt::Debug for ImageGenerateParams<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageGenerateParams")
            .field("provider_key", &self.provider_key)
            .field("model", &self.model)
            .field("api_key", &"<redacted>")
            .field("base_url", &self.base_url)
            .field("prompt", &self.prompt)
            .field("size", &self.size)
            .field("quality", &self.quality)
            .field("aspect_ratio", &self.aspect_ratio)
            .field("image_size", &self.image_size)
            .finish()
    }
}

/// Response from the daemon's llm module's POST /v1/image/generate endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageGenerateResponse {
    pub url: String,
    pub revised_prompt: String,
    pub timing: ImageGenerateTiming,
}

/// Timing for image generation.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageGenerateTiming {
    pub total_ms: u32,
}

// ContentBlock is re-exported from shore_common::protocol::types::ContentBlock.

/// Non-streaming response from POST /v1/generate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateResponse {
    pub content: String,
    #[serde(default)]
    pub content_blocks: Vec<ContentBlock>,
    pub finish_reason: String,
    pub usage: Usage,
    pub timing: Timing,
    pub model: String,
}

impl GenerateResponse {
    /// Extract concatenated text from content blocks, falling back to the
    /// `content` field when no structured blocks are present.
    pub fn extract_text(&self) -> String {
        if self.content_blocks.is_empty() {
            self.content.clone()
        } else {
            self.content_blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    ContentBlock::Thinking { .. }
                    | ContentBlock::ToolUse { .. }
                    | ContentBlock::RedactedThinking { .. }
                    | ContentBlock::ToolResult { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    fn field<'val>(value: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        value.get(key).expect("expected JSON field")
    }

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    #[test]
    fn serialize_request_omits_none_fields() {
        let req = LlmRequest {
            sdk: Sdk::Anthropic,
            model: "claude-sonnet-4-20250514".into(),
            api_key: "sk-test".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![serde_json::json!({"role": "user", "content": "Hello"})],
            system: None,
            tools: None,
            max_tokens: 4096,
            temperature: Some(0.7),
            top_p: None,
            provider_options: None,
            provider_key: None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert!(!json.as_object().unwrap().contains_key("base_url"));
        assert!(!json.as_object().unwrap().contains_key("system"));
        assert!(!json.as_object().unwrap().contains_key("tools"));
        assert!(!json.as_object().unwrap().contains_key("top_p"));
        assert!(!json.as_object().unwrap().contains_key("provider_options"));
        assert_eq!(field(&json, "temperature"), 0.7);
        assert_eq!(field(&json, "max_tokens"), 4096);
    }

    /// Tracing spans capture arguments via `Debug`; the key must never
    /// appear there. Serialization, by contrast, must carry the real key
    /// to the sidecar. See issue #240.
    #[test]
    fn debug_redacts_api_key_but_serialize_keeps_it() {
        let req = LlmRequest {
            sdk: Sdk::Anthropic,
            model: "claude-sonnet-4-20250514".into(),
            api_key: "sk-super-secret".into(),
            api_key_name: Some("default".into()),
            base_url: None,
            messages: vec![],
            system: None,
            tools: None,
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
        };
        let debug = format!("{req:?}");
        assert!(!debug.contains("sk-super-secret"));
        assert!(debug.contains("<redacted>"));
        // The friendly key name is attribution metadata, not a secret.
        assert!(debug.contains("default"));

        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(field(&json, "api_key"), "sk-super-secret");
    }

    #[test]
    fn debug_redacts_image_params_api_key() {
        let params = ImageGenerateParams {
            provider_key: "openai",
            model: "gpt-image-1",
            api_key: "sk-super-secret",
            base_url: None,
            prompt: "a narwhal",
            size: None,
            quality: None,
            aspect_ratio: None,
            image_size: None,
        };
        let debug = format!("{params:?}");
        assert!(!debug.contains("sk-super-secret"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn push_inline_system_appends_role_system_at_tail() {
        let mut req = LlmRequest {
            sdk: Sdk::Anthropic,
            model: "m".into(),
            api_key: "k".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![
                serde_json::json!({"role": "user", "content": "cached user"}),
                serde_json::json!({"role": "assistant", "content": "cached assistant"}),
            ],
            system: None,
            tools: None,
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
        };
        let prefix = req.messages.clone();
        req.push_inline_system("be brief");

        // The prefix is byte-preserved; the system entry lands at a fixed
        // index after it. This is the invariant that keeps Anthropic's
        // content-addressed prefix cache valid across tool-loop rounds.
        assert_eq!(req.messages.get(..prefix.len()), Some(prefix.as_slice()));
        assert_eq!(req.messages.len(), prefix.len().saturating_add(1));
        let last = req.messages.last().unwrap();
        assert_eq!(field(last, "role"), "system");
        assert_eq!(field(last, "content"), "be brief");
    }

    #[test]
    fn deserialize_stream_start() {
        let json = r#"{"type":"start","model":"claude-sonnet-4-6"}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::Start { model } => assert_eq!(model, "claude-sonnet-4-6"),

        );
    }

    #[test]
    fn deserialize_stream_text() {
        let json = r#"{"type":"text","text":"Hello world"}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::Text { text } => assert_eq!(text, "Hello world"),

        );
    }

    #[test]
    fn deserialize_stream_thinking() {
        let json = r#"{"type":"thinking","text":"Let me consider..."}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::Thinking { text } => assert_eq!(text, "Let me consider..."),

        );
    }

    #[test]
    fn deserialize_stream_tool_use() {
        let json = r#"{"type":"tool_use","id":"tool_01","name":"memory","input":{"q":"test"}}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::ToolUse { id, name, input } => {
                assert_eq!(id, "tool_01");
                assert_eq!(name, "memory");
                assert_eq!(field(&input, "q"), "test");
            }

        );
    }

    #[test]
    fn deserialize_stream_done() {
        let json = r#"{
            "type": "done",
            "content": "Hello there",
            "finish_reason": "end_turn",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "cache_read_tokens": 80,
                "cache_creation_tokens": 20
            },
            "timing": {
                "total_ms": 1500,
                "time_to_first_token_ms": 200
            }
        }"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::Done {
                content,
                finish_reason,
                usage,
                timing,
            } => {
                assert_eq!(content, "Hello there");
                assert_eq!(finish_reason, "end_turn");
                assert_eq!(usage.input_tokens, 100);
                assert_eq!(usage.output_tokens, 50);
                assert_eq!(usage.cache_read_tokens, 80);
                assert_eq!(usage.cache_creation_tokens, 20);
                assert_eq!(timing.total_ms, 1500);
                assert_eq!(timing.time_to_first_token_ms, 200);
            }

        );
    }

    #[test]
    fn deserialize_done_with_missing_cache_fields() {
        let json = r#"{
            "type": "done",
            "content": "Hi",
            "finish_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5},
            "timing": {"total_ms": 100}
        }"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::Done { usage, timing, .. } => {
                assert_eq!(usage.cache_read_tokens, 0);
                assert_eq!(usage.cache_creation_tokens, 0);
                assert_eq!(timing.time_to_first_token_ms, 0);
            }

        );
    }

    #[test]
    fn deserialize_generate_response() {
        let json = r#"{
            "content": "Response text",
            "finish_reason": "end_turn",
            "usage": {"input_tokens": 50, "output_tokens": 25},
            "timing": {"total_ms": 800, "time_to_first_token_ms": 0},
            "model": "claude-sonnet-4-6"
        }"#;
        let resp: GenerateResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.content, "Response text");
        assert_eq!(resp.model, "claude-sonnet-4-6");
        assert_eq!(resp.usage.input_tokens, 50);
        // content_blocks defaults to empty when absent.
        assert!(resp.content_blocks.is_empty());
    }

    #[test]
    fn deserialize_generate_response_with_content_blocks() {
        let json = r#"{
            "content": "I'll check the weather.",
            "content_blocks": [
                {"type": "text", "text": "I'll check the weather."},
                {"type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": {"city": "NYC"}}
            ],
            "finish_reason": "tool_use",
            "usage": {"input_tokens": 50, "output_tokens": 25},
            "timing": {"total_ms": 800},
            "model": "claude-sonnet-4-6"
        }"#;
        let resp: GenerateResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.finish_reason, "tool_use");
        assert_eq!(resp.content_blocks.len(), 2);
        assert_variant!(

            item(&resp.content_blocks, 0),
            ContentBlock::Text { text } => assert_eq!(text, "I'll check the weather."),

        );
        assert_variant!(

            item(&resp.content_blocks, 1),
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "toolu_01");
                assert_eq!(name, "get_weather");
                assert_eq!(field(input, "city"), "NYC");
            }

        );
    }

    #[test]
    fn deserialize_generate_response_with_thinking() {
        let json = r#"{
            "content": "The answer is 42.",
            "content_blocks": [
                {"type": "thinking", "thinking": "Let me think..."},
                {"type": "text", "text": "The answer is 42."}
            ],
            "finish_reason": "end_turn",
            "usage": {"input_tokens": 30, "output_tokens": 15},
            "timing": {"total_ms": 500},
            "model": "claude-sonnet-4-6"
        }"#;
        let resp: GenerateResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.content_blocks.len(), 2);
        assert_variant!(

            item(&resp.content_blocks, 0),
            ContentBlock::Thinking {
                thinking,
                signature,
            } => {
                assert_eq!(thinking, "Let me think...");
                assert!(signature.is_none());
            }

        );
    }

    #[test]
    fn deserialize_stream_thinking_signature() {
        let json = r#"{"type":"thinking_signature","signature":"sig_abc123"}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::ThinkingSignature { signature } => {
                assert_eq!(signature, "sig_abc123");
            }

        );
    }

    #[test]
    fn deserialize_stream_redacted_thinking() {
        let json = r#"{"type":"redacted_thinking","data":"opaque_encrypted_data"}"#;
        let event: StreamEvent = serde_json::from_str(json).unwrap();
        assert_variant!(

            event,
            StreamEvent::RedactedThinking { data } => {
                assert_eq!(data, "opaque_encrypted_data");
            }

        );
    }
}
