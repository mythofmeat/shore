use serde::{Deserialize, Serialize};
use shore_common::config::app::ThinkingReplay;
use shore_common::config::models::Sdk;
pub use shore_common::protocol::types::ContentBlock;

/// Per-provider knobs the sidecar's adapters consume.
///
/// Every field here has at least one reader in `llm-sidecar/src/llm/providers/`;
/// the mirror type is `ProviderOptions` in `llm-sidecar/src/llm/types.ts` and the
/// two must be changed together. This was an untyped `serde_json::Value` bag
/// until it accumulated three keys the daemon wrote and no adapter read
/// (`vertex_project`, `vertex_location`, `gemini_web_search`) — the type exists
/// so that failure mode is a compile error rather than a silent no-op.
///
/// Field names are the wire names. `skip_serializing_if` keeps absent knobs off
/// the wire entirely, so an adapter cannot distinguish "unset" from "not sent".
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ProviderOptions {
    /// Named effort (`low`/`medium`/`high`/`max`/`adaptive`) or a provider-specific
    /// string. The `off` sentinel never reaches here — it is rewritten to
    /// `thinking_enabled: false` in `LlmClient::build_request_with_resolved_key`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,

    /// Only ever `Some(false)`, meaning "explicitly disable reasoning". Adapters
    /// that can turn thinking off on an always-on model (OpenRouter's
    /// `reasoning: { effort: "none" }`) act on it; the rest omit reasoning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_enabled: Option<bool>,

    /// Explicit thinking-token budget. Mutually exclusive with named effort on
    /// the Anthropic path; the adapter decides precedence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u32>,

    /// Prompt-cache TTL (`"5m"` / `"1h"`). Anthropic-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_ttl: Option<String>,

    /// OpenRouter routing preferences, passed through verbatim as the `provider`
    /// field. Genuinely opaque — it is OpenRouter's schema, authored by the user
    /// in `models.toml`, and Shore does not interpret it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openrouter_provider: Option<serde_json::Value>,

    /// Manual Gemini generation override; `0`/absent means detect from the model
    /// id. Gates whether the adapter sends `thinkingLevel` or `thinkingBudget`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gemini_generation: Option<u32>,

    /// Z.ai `clear_thinking`. `false` is load-bearing (it is what enables the
    /// Preserved-Thinking replay path), so it is a tri-state, not a flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zai_clear_thinking: Option<bool>,

    /// Route to Z.ai's coding-subscription base URL instead of the pay-go one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zai_subscription: Option<bool>,
}

impl ProviderOptions {
    /// True when no knob is set. Callers collapse an empty bag to `None` so the
    /// key is omitted from the request rather than sent as `{}`.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// `Some(self)` unless every field is unset.
    pub fn into_non_empty(self) -> Option<Self> {
        if self.is_empty() {
            None
        } else {
            Some(self)
        }
    }

    /// Whether this request asks for reasoning at all.
    ///
    /// An explicit `thinking_enabled: false` wins over any other knob; otherwise
    /// either a positive budget or a non-empty effort turns it on.
    pub fn thinking_enabled(&self) -> bool {
        if self.thinking_enabled == Some(false) {
            return false;
        }
        self.budget_tokens.is_some_and(|b| b > 0) || self.reasoning_effort.is_some()
    }

    /// The effort recorded on ledger rows.
    ///
    /// `reasoning_effort = "off"` is rewritten to `thinking_enabled: false`
    /// before it reaches the wire, so reconstruct the `"off"` label here rather
    /// than leaving the column empty for explicitly-disabled models.
    pub fn resolved_reasoning_effort(&self) -> Option<String> {
        if let Some(effort) = self.reasoning_effort.as_ref() {
            return Some(effort.clone());
        }
        (self.thinking_enabled == Some(false)).then(|| "off".to_owned())
    }
}

/// One tool offered to the model, in the sidecar's provider-neutral shape.
///
/// The field names match Anthropic's spelling because that is what the daemon
/// has always emitted, but this is *not* an Anthropic tool: each adapter in
/// `llm-sidecar/src/llm/providers/` maps it to its own wire format (OpenAI's
/// `{type:"function", function:{…, parameters}}`, Gemini's
/// `functionDeclarations`, and so on). The mirror type is `ToolDefinition` in
/// `llm-sidecar/src/llm/types.ts`.
///
/// Until this was typed, `tools` was `Vec<serde_json::Value>` here and
/// `unknown[]` there, so all six adapters re-asserted the shape with an
/// unchecked cast and had drifted on what a missing `input_schema` defaults to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// Name the model calls. Unique across the whole offered surface.
    pub name: String,
    /// Model-facing description, with `{{char}}`/`{{user}}` already rendered.
    pub description: String,
    /// JSON Schema for the tool's arguments. Always an object schema — adapters
    /// forward it verbatim, and an empty `{}` is rejected by some providers.
    pub input_schema: serde_json::Value,
}

impl ToolDefinition {
    pub fn new<N, D>(name: N, description: D, input_schema: serde_json::Value) -> Self
    where
        N: Into<String>,
        D: Into<String>,
    {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
        }
    }
}

/// Where the sidecar calls back to run a tool, when it drives the loop.
///
/// The sidecar decides which tools to run; the daemon runs them, because the
/// executors hold the filesystem, the memory store, MCP, and sub-agents. Its
/// presence on a request is the switch between the two loop owners. The mirror
/// type is `ToolRpc` in `llm-sidecar/src/llm/types.ts`; the protocol is in
/// `crate::tool_rpc`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolRpc {
    /// Unix socket the daemon serves tool calls on.
    pub socket_path: String,
    /// Identifies this in-flight loop to the daemon's registry.
    pub rid: String,
}

/// Where a `thinking` block's replay payload rides on the wire.
///
/// One stored `ThinkingSignature` projects to exactly one of these fields, named
/// for the provider that reads it, so no adapter has to sniff a prefix to find
/// its own. The storage-side `orrd:`/`zair:` encoding never leaves the daemon.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReasoningCarrier {
    /// Anthropic signature / Gemini `thoughtSignature`, replayed verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// OpenRouter `reasoning_details`, replayed verbatim as the array it sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_details: Option<serde_json::Value>,
    /// Z.AI Preserved-Thinking `reasoning_content`, replayed verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl ReasoningCarrier {
    /// Project a stored signature onto the field its provider actually reads.
    ///
    /// An unparseable OpenRouter carrier yields an empty carrier: it is corrupt,
    /// and replaying something the provider will reject fails the whole request.
    pub fn from_signature(sig: &shore_common::protocol::types::ThinkingSignature) -> Self {
        use shore_common::protocol::types::ThinkingSignature as Sig;
        match sig {
            Sig::Opaque(s) => Self {
                signature: Some(s.clone()),
                ..Self::default()
            },
            Sig::OpenrouterDetails(details) => Self {
                reasoning_details: serde_json::from_str(details).ok(),
                ..Self::default()
            },
            Sig::ZaiReasoning(text) => Self {
                reasoning_content: Some(text.clone()),
                ..Self::default()
            },
        }
    }

    /// True when no carrier survived projection — the block replays nothing and
    /// Anthropic rejects it outright, so the adapter drops it.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Image bytes inlined into a message.
///
/// Images are read and resized against the daemon's cache directory, so they are
/// encoded before crossing the seam; the sidecar never touches the filesystem.
/// Single-variant because base64 is the only form the daemon sends today.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImageSource {
    Base64 { media_type: String, data: String },
}

/// One block of message content as it crosses the seam.
///
/// Deliberately *unfiltered*: every block the conversation store holds is sent,
/// including thinking blocks with no carrier and thinking minted by a different
/// model. Deciding what a given provider will accept is the adapter's job — see
/// [`WireMessage`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireBlock {
    Text {
        text: String,
    },
    Image {
        source: ImageSource,
    },
    Thinking {
        thinking: String,
        #[serde(flatten)]
        carrier: ReasoningCarrier,
    },
    RedactedThinking {
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: ToolResultContent,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
}

/// A tool result is usually text, but the generated-image replay path
/// ([`crate::handler::AssistantImageMode::ToolPair`]) returns an image block
/// plus its caption. The sidecar's mirror declared this `string` for as long as
/// it existed, which was simply wrong for that path — nothing checked it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolResultContent {
    Text(String),
    Blocks(Vec<WireBlock>),
}

impl From<String> for ToolResultContent {
    fn from(s: String) -> Self {
        Self::Text(s)
    }
}

impl WireBlock {
    /// The daemon's stored block, projected onto the wire.
    pub fn from_content_block(block: &ContentBlock) -> Self {
        match block {
            ContentBlock::Text { text } => Self::Text { text: text.clone() },
            ContentBlock::Thinking {
                thinking,
                signature,
            } => Self::Thinking {
                thinking: thinking.clone(),
                carrier: signature
                    .as_ref()
                    .map(ReasoningCarrier::from_signature)
                    .unwrap_or_default(),
            },
            ContentBlock::RedactedThinking { data } => {
                Self::RedactedThinking { data: data.clone() }
            }
            ContentBlock::ToolUse { id, name, input } => Self::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            },
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => Self::ToolResult {
                tool_use_id: tool_use_id.clone(),
                content: ToolResultContent::Text(content.clone()),
                is_error: *is_error,
            },
        }
    }

    /// Convenience for the many call sites that build a one-off text turn.
    pub fn text<T: Into<String>>(text: T) -> Self {
        Self::Text { text: text.into() }
    }
}

/// One labelled block of system prompt.
///
/// The label is **cache-load-bearing**, not decoration: the Anthropic adapter
/// anchors the system breakpoint on the last block that is not `memory_index`,
/// because that one block churns on every dreaming and compaction pass and
/// anchoring on it would invalidate the system prefix each time.
///
/// This crossed the seam as `Option<serde_json::Value>` holding an
/// Anthropic-shaped `TextBlockParam` with the label smuggled in under `_label`,
/// which the adapter then had to remember to `delete` before sending — a leak
/// one missed line away, on a field no provider has ever heard of. It also
/// carried a shape fork the type could not express: a one-block system prompt
/// serialized as a bare string, silently dropping the label.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemBlock {
    pub text: String,
    /// Provenance of this block (`system`, `character`, `user`,
    /// `tools_guidance`, `memory_index`). Never sent to a provider.
    pub label: String,
}

impl SystemBlock {
    pub fn new<T, L>(text: T, label: L) -> Self
    where
        T: Into<String>,
        L: Into<String>,
    {
        Self {
            text: text.into(),
            label: label.into(),
        }
    }

    /// The label the daemon stamps on a system prompt it assembled itself
    /// (sub-agents, the dreaming librarian) rather than from prompt files.
    pub const SYNTHETIC_LABEL: &'static str = "system";
}

/// Which side of the conversation a [`WireMessage`] came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireRole {
    User,
    Assistant,
    System,
}

/// One conversation turn as it crosses the seam.
///
/// This was `serde_json::Value`, with the daemon projecting each block to
/// provider-shaped JSON before sending. That put three genuinely provider-side
/// decisions on the side that cannot see the provider: which SDKs accept
/// carrier-less thinking, whether thinking minted by another model is safe to
/// replay, and how much prior thinking to strip. The sidecar declared a
/// `WireMessage` type for the same bytes and had no way to check it against
/// anything. Both sides now name the same type, and the adapter makes those
/// three calls itself.
///
/// `provider_key`/`model` are the provenance those decisions need: a thinking
/// block's opaque payload is only replayable to the model that minted it, and
/// provider alone is too coarse because one aggregator key fronts many families.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireMessage {
    pub role: WireRole,
    pub content: Vec<WireBlock>,
    /// Provider key that minted any thinking in `content`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    /// Model id that minted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl WireMessage {
    /// A turn with no thinking provenance — a synthesized prompt, a tool-result
    /// continuation, or any turn the daemon authored rather than a model.
    pub fn new(role: WireRole, content: Vec<WireBlock>) -> Self {
        Self {
            role,
            content,
            provider_key: None,
            model: None,
        }
    }

    /// A single-text-block turn.
    pub fn text<T: Into<String>>(role: WireRole, text: T) -> Self {
        Self::new(role, vec![WireBlock::text(text)])
    }

    /// Attach the provenance of the model that produced this turn.
    #[must_use]
    pub fn minted_by(mut self, provider_key: Option<String>, model: Option<String>) -> Self {
        self.provider_key = provider_key;
        self.model = model;
        self
    }
}

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

    /// Conversation messages, unfiltered. The adapter decides what its provider
    /// will accept — see [`WireMessage`].
    pub messages: Vec<WireMessage>,

    /// System prompt blocks, in order. Empty means no system prompt.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub system: Vec<SystemBlock>,

    /// Tool surface offered for this request, in offer order.
    ///
    /// Order is part of Anthropic's cache prefix, so it must be stable across
    /// turns; the daemon fixes it in `tools::assemble_tool_surface` and adapters
    /// forward it unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,

    /// Maximum tokens to generate.
    pub max_tokens: u32,

    /// Sampling temperature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,

    /// Nucleus sampling top-p.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,

    /// Per-provider knobs. `None` and an all-unset [`ProviderOptions`] are the
    /// same thing on the wire; construct via [`ProviderOptions::into_non_empty`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,

    /// Provider key from models.toml (e.g. "openrouter", "deepseek", "xai").
    /// Distinct from `provider` (SDK protocol). Used for provider-specific behavior.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,

    /// How much prior-turn thinking to replay (`all` | `none`).
    ///
    /// Applied by the adapter, not here: the strip is a provider-wire decision
    /// (some providers hard-require replay and override the setting outright),
    /// and applying it at send time is what makes the keepalive ping and the
    /// chat request project identically by construction rather than by
    /// discipline.
    pub replay_prior_thinking: ThinkingReplay,

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
    /// Set when the sidecar drives the tool loop for this request. See
    /// [`ToolRpc`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_rpc: Option<ToolRpc>,

    /// Dispatch rounds a sidecar-driven loop may run. `None` is unlimited, so
    /// the model ending cleanly is the only exit. Mirrors the cap the daemon's
    /// own loop enforces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_iterations: Option<u32>,

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
            .field("replay_prior_thinking", &self.replay_prior_thinking)
            .field("rid", &self.rid)
            .field("forensic_character", &self.forensic_character)
            .field("retain_long", &self.retain_long)
            .field("tool_rpc", &self.tool_rpc)
            .field("max_tool_iterations", &self.max_tool_iterations)
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
        self.messages
            .push(WireMessage::text(WireRole::System, content));
    }

    /// Append a completed assistant turn, stamped with the provenance of the
    /// model that produced it.
    ///
    /// Every tool loop in the daemon — chat, heartbeat, compaction, dreaming —
    /// needs this between iterations, and each had its own copy. They had
    /// already drifted: the heartbeat's lacked the `content` fallback, so a
    /// response that arrived as plain text with no blocks vanished from its
    /// history. One implementation, so a fifth loop cannot drift again.
    ///
    /// A turn with neither blocks nor text is not appended: the API rejects an
    /// empty content array, which would fail every later call in the loop.
    pub fn push_assistant_turn(&mut self, resp: &GenerateResponse) {
        let content: Vec<WireBlock> = if resp.content_blocks.is_empty() {
            if resp.content.trim().is_empty() {
                return;
            }
            vec![WireBlock::text(resp.content.clone())]
        } else {
            resp.content_blocks
                .iter()
                .map(WireBlock::from_content_block)
                .collect()
        };
        self.messages.push(
            WireMessage::new(WireRole::Assistant, content)
                .minted_by(self.provider_key.clone(), Some(self.model.clone())),
        );
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
    /// A verbatim provider signature (Anthropic, Gemini `thoughtSignature`).
    ThinkingSignature {
        signature: String,
    },
    /// OpenRouter's `reasoning_details` for the thinking block being streamed.
    ///
    /// A sibling of `thinking_signature` rather than a flavor of it: it is not
    /// a signature, and conflating the two is what put a `orrd:`-prefixed
    /// string in the signature slot for every adapter to sniff for.
    ReasoningDetails {
        details: serde_json::Value,
    },
    /// Z.AI's Preserved-Thinking `reasoning_content`, verbatim.
    ReasoningContent {
        reasoning: String,
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
    use serde_json::json;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    #[test]
    fn thinking_disabled_when_no_knob_is_set() {
        assert!(!ProviderOptions::default().thinking_enabled());
    }

    #[test]
    fn thinking_follows_budget_and_effort() {
        let zero_budget = ProviderOptions {
            budget_tokens: Some(0),
            ..Default::default()
        };
        assert!(!zero_budget.thinking_enabled());

        let budget = ProviderOptions {
            budget_tokens: Some(4096),
            ..Default::default()
        };
        assert!(budget.thinking_enabled());

        let effort = ProviderOptions {
            reasoning_effort: Some("high".into()),
            ..Default::default()
        };
        assert!(effort.thinking_enabled());
    }

    #[test]
    fn explicit_disable_beats_every_other_knob() {
        // `reasoning_effort = "off"` arrives here as `thinking_enabled: false`.
        // It must win even when a budget is also set, or accounting tags the
        // call as a thinking call and the cache tracker's warm/cold baseline
        // is fed a reasoning flag the provider never saw.
        let disabled = ProviderOptions {
            thinking_enabled: Some(false),
            budget_tokens: Some(4096),
            ..Default::default()
        };
        assert!(!disabled.thinking_enabled());
    }

    #[test]
    fn unrelated_knobs_do_not_imply_thinking() {
        let cache_only = ProviderOptions {
            cache_ttl: Some("1h".into()),
            ..Default::default()
        };
        assert!(!cache_only.thinking_enabled());
    }

    #[test]
    fn resolved_effort_distinguishes_off_from_absent() {
        let high = ProviderOptions {
            reasoning_effort: Some("high".into()),
            ..Default::default()
        };
        assert_eq!(high.resolved_reasoning_effort().as_deref(), Some("high"));

        // "explicitly off" and "provider has no effort surface" read a cache
        // miss very differently, so they must not collapse to the same row.
        let off = ProviderOptions {
            thinking_enabled: Some(false),
            ..Default::default()
        };
        assert_eq!(off.resolved_reasoning_effort().as_deref(), Some("off"));

        assert_eq!(ProviderOptions::default().resolved_reasoning_effort(), None);
    }

    #[test]
    fn empty_options_stay_off_the_wire() {
        assert_eq!(ProviderOptions::default().into_non_empty(), None);

        let set = ProviderOptions {
            cache_ttl: Some("5m".into()),
            ..Default::default()
        };
        assert!(set.clone().into_non_empty().is_some());

        // Absent knobs must not serialize, or an adapter cannot tell "unset"
        // from "sent as null".
        let json = serde_json::to_value(&set).expect("serialize");
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 1);
        assert_eq!(obj.get("cache_ttl"), Some(&serde_json::json!("5m")));
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
            messages: vec![WireMessage::text(WireRole::User, "Hello")],
            system: Vec::new(),
            tools: None,
            max_tokens: 4096,
            temperature: Some(0.7),
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
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
            system: Vec::new(),
            tools: None,
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
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
                WireMessage::text(WireRole::User, "cached user"),
                WireMessage::text(WireRole::Assistant, "cached assistant"),
            ],
            system: Vec::new(),
            tools: None,
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
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
        assert_eq!(last.role, WireRole::System);
        assert_eq!(last.content, vec![WireBlock::text("be brief")]);
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

    // -----------------------------------------------------------------------
    // Cross-language shape parity
    // -----------------------------------------------------------------------

    /// Every wire type, every enum variant, and every optional field in both
    /// its present and absent form.
    ///
    /// Serialized by serde from the real types, so the emitted JSON *is* the
    /// bytes the sidecar receives — a renamed field, a changed tag, or a new
    /// option shows up here without anyone remembering to write it down.
    /// Anthropic signature / Gemini `thoughtSignature`.
    fn carrier_signature() -> ReasoningCarrier {
        ReasoningCarrier {
            signature: Some("sig_abc".into()),
            ..Default::default()
        }
    }

    /// OpenRouter `reasoning_details`.
    fn carrier_openrouter() -> ReasoningCarrier {
        ReasoningCarrier {
            reasoning_details: Some(json!([{"type": "reasoning.text", "text": "r"}])),
            ..Default::default()
        }
    }

    /// Z.AI Preserved-Thinking `reasoning_content`.
    fn carrier_zai() -> ReasoningCarrier {
        ReasoningCarrier {
            reasoning_content: Some("preserved".into()),
            ..Default::default()
        }
    }

    fn wire_shape_census() -> serde_json::Value {
        json!({
            "wire_role": [WireRole::User, WireRole::Assistant, WireRole::System],
            "thinking_replay": [ThinkingReplay::All, ThinkingReplay::None],
            "system_block": SystemBlock::new("You are a character.", "character"),
            "tool_definition": ToolDefinition::new(
                "read",
                "Read a file.",
                json!({"type": "object", "properties": {}}),
            ),
            "provider_options": {
                // Absent knobs are omitted, not sent as null: `undefined`
                // unambiguously means "not configured" on the far side.
                "empty": ProviderOptions::default(),
                "full": ProviderOptions {
                    reasoning_effort: Some("high".into()),
                    thinking_enabled: Some(false),
                    budget_tokens: Some(4096),
                    cache_ttl: Some("1h".into()),
                    openrouter_provider: Some(json!({"order": ["anthropic"]})),
                    gemini_generation: Some(3),
                    zai_clear_thinking: Some(false),
                    zai_subscription: Some(true),
                },
            },
            "reasoning_carrier": {
                "empty": ReasoningCarrier::default(),
                "signature": carrier_signature(),
                "openrouter": carrier_openrouter(),
                "zai": carrier_zai(),
            },
            // The tool-call protocol is hand-written on both sides, so it is
            // pinned here for the same reason the wire types are.
            "tool_rpc": {
                // Tagged: confusing a turn for a tool result would persist an
                // assistant turn as tool output.
                "request_tool": crate::tool_rpc::SidecarRequest::Tool(
                    crate::tool_rpc::ToolCallRequest {
                        rid: "rid_1".into(),
                        tool_id: "tu_1".into(),
                        name: "read".into(),
                        input: json!({"path": "/tmp/x"}),
                    },
                ),
                "request_turn": crate::tool_rpc::SidecarRequest::Turn(
                    crate::tool_rpc::TurnRequest {
                        rid: "rid_1".into(),
                        content_blocks: vec![ContentBlock::Text {
                            text: "let me look".into(),
                        }],
                    },
                ),
                // A tool that ran, and a call that never reached a loop. The
                // outcome is untagged, so these two shapes are the only thing
                // distinguishing them on the wire.
                "outcome_ran": crate::tool_rpc::ToolCallOutcome::Ok(
                    crate::tool_rpc::ToolCallResponse {
                        output: "file body".into(),
                        is_error: false,
                    },
                ),
                "outcome_failed": crate::tool_rpc::ToolCallOutcome::Ok(
                    crate::tool_rpc::ToolCallResponse {
                        output: "no such file".into(),
                        is_error: true,
                    },
                ),
                "outcome_unreachable": crate::tool_rpc::ToolCallOutcome::Err(
                    crate::tool_rpc::ToolCallError {
                        error: "no in-flight loop for rid rid_1".into(),
                    },
                ),
            },
            "wire_block": wire_block_census(),
            "wire_message": {
                "bare": WireMessage::text(WireRole::User, "hi"),
                "with_provenance": WireMessage::text(WireRole::Assistant, "hello")
                    .minted_by(Some("anthropic".into()), Some("claude-opus-4-8".into())),
            },
        })
    }

    /// Every [`WireBlock`] variant, split out only to keep the census readable.
    fn wire_block_census() -> serde_json::Value {
        json!({
                "text": WireBlock::Text { text: "hello".into() },
                "image": WireBlock::Image {
                    source: ImageSource::Base64 {
                        media_type: "image/png".into(),
                        data: "iVBORw0KGgo=".into(),
                    },
                },
                // The carrier is `#[serde(flatten)]`: its fields sit alongside
                // `thinking`, they are not nested under a `carrier` key.
                "thinking_uncarried": WireBlock::Thinking {
                    thinking: "private chain".into(),
                    carrier: ReasoningCarrier::default(),
                },
                "thinking_signature": WireBlock::Thinking {
                    thinking: "t".into(),
                    carrier: carrier_signature(),
                },
                "thinking_openrouter": WireBlock::Thinking {
                    thinking: "t".into(),
                    carrier: carrier_openrouter(),
                },
                "thinking_zai": WireBlock::Thinking {
                    thinking: "t".into(),
                    carrier: carrier_zai(),
                },
                "redacted_thinking": WireBlock::RedactedThinking {
                    data: "opaque".into(),
                },
                "tool_use": WireBlock::ToolUse {
                    id: "tu_1".into(),
                    name: "read".into(),
                    input: json!({"path": "/tmp/x"}),
                },
                "tool_result_text": WireBlock::ToolResult {
                    tool_use_id: "tu_1".into(),
                    content: ToolResultContent::Text("ok".into()),
                    is_error: false,
                },
                // Anthropic's block-shaped tool result, used by the
                // generated-image replay path. The mirror typed this `string`
                // for as long as it existed.
                "tool_result_blocks": WireBlock::ToolResult {
                    tool_use_id: "tu_2".into(),
                    content: ToolResultContent::Blocks(vec![
                        WireBlock::Text { text: "a cat".into() },
                        WireBlock::Image {
                            source: ImageSource::Base64 {
                                media_type: "image/png".into(),
                                data: "iVBORw0KGgo=".into(),
                            },
                        },
                    ]),
                    is_error: false,
                },
                // `is_error` is skipped when false, so it appears only here.
                "tool_result_error": WireBlock::ToolResult {
                    tool_use_id: "tu_3".into(),
                    content: ToolResultContent::Text("boom".into()),
                    is_error: true,
                },
        })
    }

    /// Pins the serialized shape of every type the sidecar hand-mirrors.
    ///
    /// The mirrors are six TypeScript interfaces whose doc comments say "the two
    /// must change together" and which nothing checked. Drift here is
    /// asymmetric: the sidecar's side is pinned by the vendor SDK types it feeds,
    /// with a compiler behind it, so it is the Rust half that goes quietly stale
    /// — or did, until this.
    ///
    /// The fixture is *generated*, not hand-written, which is the whole point: a
    /// hand-written one would still say what the types used to look like. Adding
    /// a field here fails this test until the fixture is regenerated, and the
    /// regenerated fixture then fails
    /// `llm-sidecar/tests/wire_parity.test.ts` until the mirror is updated too.
    ///
    /// Regenerate with `SHORE_REGENERATE_FIXTURES=1 cargo test -p shore-daemon
    /// wire_shape_matches_shared_fixture`, then read the diff: it is exactly
    /// what the sidecar will now receive.
    #[test]
    fn wire_shape_matches_shared_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/wire_parity.json"
        );
        let census = wire_shape_census();
        let rendered = format!("{}\n", serde_json::to_string_pretty(&census).unwrap());

        if std::env::var_os("SHORE_REGENERATE_FIXTURES").is_some() {
            std::fs::write(path, &rendered).unwrap();
            return;
        }

        let on_disk = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            rendered, on_disk,
            "wire shape changed. The sidecar mirrors these types by hand; \
             regenerate with SHORE_REGENERATE_FIXTURES=1 and update \
             llm-sidecar/src/llm/types.ts to match."
        );
    }
}
