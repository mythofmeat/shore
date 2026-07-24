//! Model catalog: nested `[chat.<provider>.<model>]` structure with
//! provider-level defaults cascading into per-model entries.
//!
//! The parsing mirrors V1's `_load_category_profiles()` approach:
//! for each provider table, scalar keys become provider defaults and
//! sub-table keys become model entries that inherit those defaults.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::config::capabilities;
use crate::config::duration::ConfigDuration;

// ── Cache keepalive cadence ─────────────────────────────────────────────

/// Per-model cache-keepalive cadence (`cache_keepalive` in `[models.*]`).
///
/// `"off"` disables keepalive pings for the model; any duration string
/// (`"55m"`, `"6h"`, `"30s"`) sets the interval between pings while the
/// character is idle. The duration is a *literal* ping interval — it is not
/// derived from the provider's cache TTL, and is deliberately independent of
/// the Anthropic-only `cache_ttl` wire setting (which enables 1h caching).
///
/// Unset in config resolves to the sdk default (Anthropic → `55m`, every other
/// sdk → `off`); see [`capabilities::default_value`]. The standalone daemon
/// subsystem bounds total ping time via the global `cache_keepalive_max`, so a
/// long interval here is safe even for providers with opaque cache lifetimes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheKeepaliveSetting {
    /// Keepalive pings disabled for this model.
    Off,
    /// Ping every `interval` while the character is idle.
    Every(ConfigDuration),
}

impl CacheKeepaliveSetting {
    /// Parse from a TOML string: `"off"`/`"none"`/`"disabled"`/`"0"` → [`Off`],
    /// any non-zero duration string → [`Every`].
    ///
    /// A zero-length interval (`"0s"`, `"0ms"`) is rejected: it would re-arm the
    /// timer at `now` on every tick and spin a ping loop. Use `"off"` to disable.
    ///
    /// [`Off`]: CacheKeepaliveSetting::Off
    /// [`Every`]: CacheKeepaliveSetting::Every
    pub fn parse(raw: &str) -> Result<Self, String> {
        let trimmed = raw.trim();
        match trimmed.to_ascii_lowercase().as_str() {
            "off" | "none" | "disabled" | "false" | "0" => Ok(Self::Off),
            _ => {
                let interval = ConfigDuration::parse(trimmed)?;
                if interval.as_millis() == 0 {
                    return Err(
                        "cache_keepalive interval must be > 0; use \"off\" to disable".to_owned(),
                    );
                }
                Ok(Self::Every(interval))
            }
        }
    }

    /// The resolved ping interval, or `None` when keepalive is off.
    #[must_use]
    pub fn interval(self) -> Option<std::time::Duration> {
        match self {
            Self::Off => None,
            Self::Every(d) => Some(d.as_duration()),
        }
    }
}

impl std::fmt::Display for CacheKeepaliveSetting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => f.write_str("off"),
            Self::Every(d) => write!(f, "{d}"),
        }
    }
}

impl Serialize for CacheKeepaliveSetting {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for CacheKeepaliveSetting {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

// ── SDK enum ────────────────────────────────────────────────────────────

/// SDK/wire protocol.  Distinguishes the message format from the gateway.
///
/// For example, `Anthropic` with a custom `base_url` pointing at OpenRouter
/// means "use the Anthropic message format, but send requests to OpenRouter."
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Sdk {
    #[default]
    Anthropic,
    Openai,
    /// OpenRouter's first-party SDK (`@openrouter/sdk`) — the normalized path
    /// for non-Anthropic models routed via OpenRouter (DeepSeek, Kimi, GLM,
    /// MiniMax, GPT, xAI). OpenRouter folds each vendor's bespoke reasoning
    /// shape into one typed `reasoning_details` array, round-tripped opaquely.
    Openrouter,
    Gemini,
    Zai,
    /// DeepSeek's direct API via the Vercel AI SDK provider (`@ai-sdk/deepseek`).
    /// Distinct from routing DeepSeek through OpenRouter: this hits
    /// `api.deepseek.com` directly and exposes native reasoning control
    /// (`thinking.type` enable/disable/adaptive + `reasoningEffort`).
    Deepseek,
    /// Moonshot (Kimi) direct API via the Vercel AI SDK provider
    /// (`@ai-sdk/moonshotai`). Native thinking on/off (`thinking.type` +
    /// `budgetTokens`) and cross-turn `reasoningHistory`.
    Moonshot,
}

impl<'de> Deserialize<'de> for Sdk {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "anthropic" => Ok(Sdk::Anthropic),
            "openai" => Ok(Sdk::Openai),
            "openrouter" => Ok(Sdk::Openrouter),
            "gemini" => Ok(Sdk::Gemini),
            "zai" => Ok(Sdk::Zai),
            "deepseek" => Ok(Sdk::Deepseek),
            "moonshot" | "moonshotai" => Ok(Sdk::Moonshot),
            "zhipuai" => {
                warn!(
                    "sdk = \"{s}\" is deprecated and now maps to \"openai\". \
                     Update your config to use sdk = \"openai\" instead."
                );
                Ok(Sdk::Openai)
            }
            other => Err(serde::de::Error::unknown_variant(
                other,
                &[
                    "anthropic",
                    "openai",
                    "openrouter",
                    "gemini",
                    "zai",
                    "deepseek",
                    "moonshot",
                ],
            )),
        }
    }
}

impl Sdk {
    /// Wire protocol string sent to the daemon's llm module.
    pub fn as_str(&self) -> &'static str {
        match self {
            Sdk::Anthropic => "anthropic",
            Sdk::Openai => "openai",
            Sdk::Openrouter => "openrouter",
            Sdk::Gemini => "gemini",
            Sdk::Zai => "zai",
            Sdk::Deepseek => "deepseek",
            Sdk::Moonshot => "moonshot",
        }
    }

    /// Parse a wire-protocol string back into an `Sdk`. `None` for unknown
    /// strings — the caller decides whether to fall back or error. Named
    /// `parse_wire` rather than `from_str` to avoid colliding with
    /// [`std::str::FromStr`] (which would force a stricter error type).
    pub fn parse_wire(s: &str) -> Option<Self> {
        match s {
            "anthropic" => Some(Sdk::Anthropic),
            "openai" => Some(Sdk::Openai),
            "openrouter" => Some(Sdk::Openrouter),
            "gemini" => Some(Sdk::Gemini),
            "zai" => Some(Sdk::Zai),
            "deepseek" => Some(Sdk::Deepseek),
            "moonshot" | "moonshotai" => Some(Sdk::Moonshot),
            _ => None,
        }
    }

    /// Whether this SDK's wire protocol requires the daemon to echo
    /// **unsigned** reasoning text back to the provider on the next
    /// request. Anthropic signs its thinking blocks and rejects requests
    /// that include unsigned reasoning text from a prior turn; OpenAI and
    /// Z.AI, in contrast, expect the assistant's prior `reasoning_content`
    /// to round-trip verbatim. Gemini doesn't accept reasoning replay.
    ///
    /// Centralized here so chat and heartbeat sites can derive the same
    /// value from one source — keeping the cache prefix consistent
    /// between live chat and the heartbeat tick that reuses it. A bare
    /// `match` at each call site was the kind of drift surface the
    /// 2026-05-14 refactor was set up to eliminate.
    pub fn echoes_unsigned_thinking(&self) -> bool {
        // DeepSeek/Moonshot (Kimi) hard-require prior `reasoning_content` to
        // round-trip during a tool loop; the Vercel AI SDK adapter replays it as
        // an assistant `reasoning` content part, and the OpenAI-compatible
        // adapter as assistant `reasoning_content` (gated upstream by the
        // `replay_prior_thinking` strip — see `maybe_strip_prior_thinking`).
        matches!(self, Sdk::Openai | Sdk::Zai | Sdk::Deepseek | Sdk::Moonshot)
    }

    /// Whether requests for this SDK ultimately hit Anthropic's prompt-cache
    /// machinery (so a background task that wants to reuse the chat-warmed
    /// prefix has to preserve `request.system` verbatim and attach trailing
    /// instructions as an inline `role:"system"` entry instead).
    ///
    /// True for `Anthropic`. False for OpenAI / Gemini / Z.AI — those
    /// translate an inline `role:"system"` into a mid-history
    /// `<system_instruction>` user-role (or raw `role:"system"` on Z.AI),
    /// which is a materially different wire shape than a top-level system
    /// block. Background tasks should only move their fresh-path system
    /// prompt into an inline `role:"system"` (via
    /// `LlmRequest::push_inline_system`) on SDKs where this is true.
    pub fn uses_anthropic_prompt_cache(&self) -> bool {
        matches!(self, Sdk::Anthropic)
    }
}

// ── Shared model config fields ──────────────────────────────────────────

/// The 20 configuration fields shared by provider configs, model entries,
/// and resolved models.  All fields are `Option<T>` — `None` means "inherit
/// from the next level up" (model → provider → hardcoded defaults).
///
/// The first three fields — `sdk` / `api_key_env` / `base_url` — are
/// **transport**, not behavioral overlay. With the legacy `[chat.*]` catalog
/// deprecated (#139), transport has a single authoritative home: the
/// `[providers.<name>]` registry entry. They survive on this struct only for
/// (a) the legacy static `ModelEntry` path, honored during the deprecation
/// window, and (b) `ResolvedModel`, where they hold *resolved* transport. They
/// are deliberately **not** an overlay concern: `[providers.<name>.defaults]`
/// rejects them (`providers::transport_field_in_defaults`) and the per-model
/// `[models."<provider>:<id>"]` overlay is `SamplerSettings`, which has no
/// transport fields. Don't reintroduce transport as a model/provider-default
/// overlay knob; route it through the registry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct ModelConfigFields {
    pub sdk: Option<Sdk>,
    pub api_key_env: Option<String>,
    pub base_url: Option<String>,
    pub max_context_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub budget_tokens: Option<u32>,
    pub cache_ttl: Option<String>,
    pub cache_keepalive: Option<CacheKeepaliveSetting>,
    pub openrouter_provider: Option<toml::Value>,
    pub vertex_project: Option<String>,
    pub vertex_location: Option<String>,
    pub gemini_generation: Option<u32>,
    pub gemini_web_search: Option<bool>,
    pub zai_clear_thinking: Option<bool>,
    pub zai_subscription: Option<bool>,
}

impl ModelConfigFields {
    /// Overwrite `self` fields with any non-None fields from `overlay`.
    pub fn merge_from(&mut self, overlay: &Self) {
        macro_rules! merge_opt {
            ($field:ident) => {
                if overlay.$field.is_some() {
                    self.$field = overlay.$field.clone();
                }
            };
        }
        merge_opt!(sdk);
        merge_opt!(api_key_env);
        merge_opt!(base_url);
        merge_opt!(max_context_tokens);
        merge_opt!(max_output_tokens);
        merge_opt!(temperature);
        merge_opt!(top_p);
        merge_opt!(reasoning_effort);
        merge_opt!(budget_tokens);
        merge_opt!(cache_ttl);
        merge_opt!(cache_keepalive);
        merge_opt!(openrouter_provider);
        merge_opt!(vertex_project);
        merge_opt!(vertex_location);
        merge_opt!(gemini_generation);
        merge_opt!(gemini_web_search);
        merge_opt!(zai_clear_thinking);
        merge_opt!(zai_subscription);
    }

    /// Produce a new `ModelConfigFields` where each field is taken from `self`
    /// if present, otherwise from `fallback`.
    #[must_use]
    pub fn or_fallback(&self, fallback: &Self) -> Self {
        macro_rules! or_opt {
            ($field:ident) => {
                self.$field.clone().or(fallback.$field.clone())
            };
        }
        Self {
            sdk: or_opt!(sdk),
            api_key_env: or_opt!(api_key_env),
            base_url: or_opt!(base_url),
            max_context_tokens: or_opt!(max_context_tokens),
            max_output_tokens: or_opt!(max_output_tokens),
            temperature: or_opt!(temperature),
            top_p: or_opt!(top_p),
            reasoning_effort: or_opt!(reasoning_effort),
            budget_tokens: or_opt!(budget_tokens),
            cache_ttl: or_opt!(cache_ttl),
            cache_keepalive: or_opt!(cache_keepalive),
            openrouter_provider: or_opt!(openrouter_provider),
            vertex_project: or_opt!(vertex_project),
            vertex_location: or_opt!(vertex_location),
            gemini_generation: or_opt!(gemini_generation),
            gemini_web_search: or_opt!(gemini_web_search),
            zai_clear_thinking: or_opt!(zai_clear_thinking),
            zai_subscription: or_opt!(zai_subscription),
        }
    }
}

// ── Provider config ─────────────────────────────────────────────────────

/// Provider-level configuration — the scalar keys under `[chat.<provider>]`.
///
/// All fields are optional; they cascade into every model under this provider
/// unless the model overrides them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct ProviderConfig {
    #[serde(flatten)]
    pub fields: ModelConfigFields,
}

// ── Model entry ─────────────────────────────────────────────────────────

/// Per-model configuration — sub-tables under `[chat.<provider>.<model>]`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct ModelEntry {
    /// The upstream model identifier (e.g. `"claude-opus-4-6"`).  Required.
    pub model_id: Option<String>,
    /// All overrides — None means inherit from provider.
    #[serde(flatten)]
    pub fields: ModelConfigFields,
}

// ── Resolved model ──────────────────────────────────────────────────────

/// A fully resolved model profile with all provider defaults merged in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedModel {
    /// Short name — the TOML key under the provider (e.g. `"opus"`).
    pub name: String,
    /// Qualified path (e.g. `"chat.anthropic.opus"`).
    pub qualified_name: String,
    /// Category: `"chat"`, `"tools"`, etc.
    pub category: String,
    /// Provider key (e.g. `"anthropic"`, `"openrouter"`).
    pub provider_key: String,
    /// SDK/protocol to use.
    pub sdk: Sdk,
    /// Upstream model identifier.
    pub model_id: String,
    pub api_key_env: Option<String>,
    pub base_url: Option<String>,
    pub max_context_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub budget_tokens: Option<u32>,
    pub cache_ttl: Option<String>,
    /// Per-model cache-keepalive cadence. `None` resolves to the sdk default
    /// (Anthropic → `55m`, others → `off`) in [`ResolvedModel::from_parts`].
    pub cache_keepalive: Option<CacheKeepaliveSetting>,
    pub openrouter_provider: Option<toml::Value>,
    pub vertex_project: Option<String>,
    pub vertex_location: Option<String>,
    pub gemini_generation: Option<u32>,
    pub gemini_web_search: Option<bool>,
    pub zai_clear_thinking: Option<bool>,
    pub zai_subscription: Option<bool>,
    /// Per-model override for preserving prior-turn extended-thinking blocks
    /// in outgoing requests. `None` means "inherit the global
    /// `[memory.thinking].replay_prior_thinking`". Not sourced from the static
    /// `[chat.*]` catalog — it is stamped here by the runtime preference
    /// overlay (`preferences::apply_sampler_overlay`). The quality effect is
    /// model-dependent (issue #129), so there is no opinionated default.
    pub replay_prior_thinking: Option<crate::config::app::ThinkingReplay>,
    /// Maximum tool-loop iterations per turn, governing every agentic tool
    /// loop (interactive chat, heartbeat, compaction, dreaming). `None` means
    /// **unlimited** — the loop runs until the model stops requesting tools
    /// (bounded only by per-call HTTP timeouts and, for the heartbeat, its
    /// wall-clock tick deadline). Like `replay_prior_thinking`, this is not
    /// sourced from the static `[chat.*]` catalog; it is stamped here by the
    /// runtime preference overlay (`preferences::apply_sampler_overlay`).
    pub max_tool_iterations: Option<u32>,
}

impl ResolvedModel {
    /// Build a `ResolvedModel` from metadata + merged config fields.
    ///
    /// `sdk_fallback` is used if `fields.sdk` is `None`.
    pub fn from_parts(
        name: String,
        qualified_name: String,
        category: String,
        provider_key: String,
        model_id: String,
        sdk_fallback: Sdk,
        mut fields: ModelConfigFields,
    ) -> Self {
        // Anthropic-slug auto-promotion: OpenRouter (and similar gateways)
        // accept Anthropic-shape `/v1/messages` for `anthropic/*` models, and
        // the Anthropic SDK is the only path that emits `cache_control`. If
        // the user didn't pin an SDK explicitly, route any `anthropic/*`
        // model_id through Sdk::Anthropic so caching works by default.
        let sdk = match fields.sdk.clone() {
            Some(s) => s,
            None if model_id.starts_with("anthropic/") => Sdk::Anthropic,
            None => sdk_fallback,
        };

        // Anthropic prompt caching is opt-in on the wire — `cache_control`
        // blocks are only added when `cache_ttl` is `Some` and non-empty.
        // The "1h" Anthropic default now lives in the capability layer (#138);
        // fill only when unset so user / provider config wins (set
        // `cache_ttl = ""` to disable). Matches the billing-side default in
        // crates/daemon/src/ledger/pricing.rs.
        if fields.cache_ttl.is_none() {
            fields.cache_ttl =
                capabilities::default_value(&sdk, capabilities::Field::CacheTtl).map(str::to_owned);
        }

        // Cache keepalive cadence default is also sdk-keyed (Anthropic → `55m`,
        // every other sdk → no entry, i.e. off). Fill only when unset so an
        // explicit `cache_keepalive = "off"` (or any interval) wins. This is
        // separate from `cache_ttl`: keepalive can run on any provider with a
        // cache, but is opt-in everywhere except Anthropic.
        if fields.cache_keepalive.is_none() {
            fields.cache_keepalive =
                capabilities::default_value(&sdk, capabilities::Field::CacheKeepalive)
                    .and_then(|s| CacheKeepaliveSetting::parse(s).ok());
        }

        // Drop sampler knobs the model's wire rejects (Claude >=4.7 cutoff,
        // #138) so a baked-in default never 400s. The `temperature = 1.0`
        // baseline from `base_provider_defaults` is dropped silently; an
        // explicit non-default value is dropped with a warn. `top_p` /
        // `budget_tokens` have no code default, so any present value is
        // user-set and warns.
        strip_rejected_sampler(
            &sdk,
            &model_id,
            capabilities::Field::Temperature,
            &mut fields.temperature,
            Some(&1.0),
        );
        strip_rejected_sampler(
            &sdk,
            &model_id,
            capabilities::Field::TopP,
            &mut fields.top_p,
            None,
        );
        strip_rejected_sampler(
            &sdk,
            &model_id,
            capabilities::Field::BudgetTokens,
            &mut fields.budget_tokens,
            None,
        );

        // Warn (but keep) settings the resolved sdk silently ignores — harmless
        // on the wire, but a likely misconfiguration worth surfacing.
        warn_ignored_fields(&sdk, &model_id, &fields);

        let cache_ttl = fields.cache_ttl;

        Self {
            name,
            qualified_name,
            category,
            provider_key,
            sdk,
            model_id,
            api_key_env: fields.api_key_env,
            base_url: fields.base_url,
            max_context_tokens: fields.max_context_tokens,
            max_output_tokens: fields.max_output_tokens,
            temperature: fields.temperature,
            top_p: fields.top_p,
            reasoning_effort: fields.reasoning_effort,
            budget_tokens: fields.budget_tokens,
            cache_ttl,
            cache_keepalive: fields.cache_keepalive,
            openrouter_provider: fields.openrouter_provider,
            vertex_project: fields.vertex_project,
            vertex_location: fields.vertex_location,
            gemini_generation: fields.gemini_generation,
            gemini_web_search: fields.gemini_web_search,
            zai_clear_thinking: fields.zai_clear_thinking,
            zai_subscription: fields.zai_subscription,
            // The static catalog has no `replay_prior_thinking` field; the
            // value is supplied later by the runtime preference overlay
            // (issue #129). `None` here means "inherit the global default".
            replay_prior_thinking: None,
            // Runtime-overlay-only, like `replay_prior_thinking`. `None` here
            // means "unlimited" unless a per-model preference stamps a cap.
            max_tool_iterations: None,
        }
    }
}

/// Drop a sampler field the resolved `(sdk, model_id)` wire rejects (#138).
/// A value equal to `silent_default` (the baked-in code default) is dropped
/// silently; any other present value is dropped with a `warn!`, since sending it
/// would be an upstream 400.
fn strip_rejected_sampler<T: PartialEq>(
    sdk: &Sdk,
    model_id: &str,
    field: capabilities::Field,
    slot: &mut Option<T>,
    silent_default: Option<&T>,
) {
    if slot.is_none()
        || capabilities::applicability(sdk, model_id, field)
            != capabilities::Applicability::Rejected
    {
        return;
    }
    if slot.as_ref() != silent_default {
        warn!(
            model = model_id,
            sdk = sdk.as_str(),
            "dropping `{}`: the `{}` wire rejects it (Claude >=4.7 cutoff or \
             per-model OpenRouter override)",
            field,
            model_id,
        );
    }
    *slot = None;
}

/// Warn (but keep) every present field the resolved sdk silently ignores
/// (#138) — harmless on the wire, but a likely misconfiguration worth
/// surfacing (e.g. `cache_ttl` on a non-Anthropic sdk, `vertex_*` off Gemini).
fn warn_ignored_fields(sdk: &Sdk, model_id: &str, fields: &ModelConfigFields) {
    use capabilities::Field;
    let checks: [(Field, bool); 8] = [
        (Field::CacheTtl, fields.cache_ttl.is_some()),
        (
            Field::OpenrouterProvider,
            fields.openrouter_provider.is_some(),
        ),
        (Field::VertexProject, fields.vertex_project.is_some()),
        (Field::VertexLocation, fields.vertex_location.is_some()),
        (Field::GeminiGeneration, fields.gemini_generation.is_some()),
        (Field::GeminiWebSearch, fields.gemini_web_search.is_some()),
        (Field::ZaiClearThinking, fields.zai_clear_thinking.is_some()),
        (Field::ZaiSubscription, fields.zai_subscription.is_some()),
    ];
    for (field, present) in checks {
        if present
            && capabilities::applicability(sdk, model_id, field)
                == capabilities::Applicability::Ignored
        {
            warn!(
                model = model_id,
                "ignoring `{}`: the `{}` sdk does not honor it",
                field,
                sdk.as_str(),
            );
        }
    }
}

// ── Auxiliary model categories (embedding / image generation) ───────────

/// Per-model category settings for an `[embedding."provider:model_id"]` table.
///
/// Identity (`provider:model_id`) is the map key; transport (`sdk`, `base_url`,
/// credentials) comes from `[providers.<provider>]`. This struct holds only the
/// category-specific knobs — `deny_unknown_fields` rejects leftover inline
/// transport/identity from the retired flat shape so the migration fails loudly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, deny_unknown_fields)]
pub struct EmbeddingSettings {
    /// Embedding vector dimensions. `None` falls back to the resolver default.
    pub dimensions: Option<u32>,
}

/// Per-model category settings for an `[image_generation."provider:model_id"]`
/// table. Identity is the map key; transport comes from `[providers.<provider>]`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ImageGenSettings {
    /// Default size for the OpenAI path (e.g. `"1024x1024"`).
    pub size: Option<String>,
    /// Optional quality hint for the OpenAI path (e.g. `"hd"`).
    pub quality: Option<String>,
    /// OpenRouter aspect ratio (e.g. `"1:1"`, `"16:9"`).
    pub aspect_ratio: Option<String>,
    /// OpenRouter image size (e.g. `"1K"`, `"2K"`, `"4K"`).
    pub image_size: Option<String>,
}

// ── Model catalog ───────────────────────────────────────────────────────

/// The parsed model catalog — replaces the old flat `ModelsConfig`.
#[derive(Debug, Clone, Default)]
pub struct ModelCatalog {
    /// Chat models keyed by short name.
    pub chat: BTreeMap<String, ResolvedModel>,
    /// Embedding category settings keyed by `provider:model_id`. Identity is the
    /// key; transport resolves through `[providers.<provider>]`.
    pub embedding: BTreeMap<String, EmbeddingSettings>,
    /// Image-generation category settings keyed by `provider:model_id`.
    pub image_generation: BTreeMap<String, ImageGenSettings>,
}

/// Errors from model catalog parsing.
#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("model \"{name}\" in [{category}.{provider}] is missing required field `model_id`")]
    MissingModelId {
        category: String,
        provider: String,
        name: String,
    },
    #[error("failed to parse model entry [{category}.{provider}.{name}]: {source}")]
    ParseEntry {
        category: String,
        provider: String,
        name: String,
        source: Box<toml::de::Error>,
    },
    #[error("ambiguous model name \"{name}\" — found in: {locations}")]
    AmbiguousName { name: String, locations: String },
    #[error("model \"{name}\" not found")]
    NotFound { name: String },
    #[error(
        "[{category}.claude_code] is no longer supported — the Claude Code transport \
         was removed; drop this section from your config"
    )]
    RemovedProvider { category: String },
    #[error(
        "[{category}.{provider}] no longer accepts provider-level scalar `{key}`; \
         move it to {target}"
    )]
    ProviderScalarRetired {
        category: String,
        provider: String,
        key: String,
        target: &'static str,
    },
    #[error(
        "[{category}.{key:?}] is not a valid `provider:model_id` settings table: {detail}. \
         Identity is the key (e.g. `[{category}.\"openai:{example}\"]`); put transport \
         (sdk/base_url/api_key_env) on [providers.<provider>] and keep only category \
         settings in the table"
    )]
    AuxProfileInvalid {
        category: String,
        key: String,
        detail: String,
        example: &'static str,
    },
}

/// Transport keys that belong on the `[providers.<name>]` entry itself rather
/// than its `[.defaults]` behavioral bag.
const TRANSPORT_SCALAR_KEYS: &[&str] = &["sdk", "api_key_env", "base_url", "keys"];

/// Dict-valued TOML keys at the provider level that are config fields,
/// NOT model sub-tables.  Mirrors V1's `_RESERVED_DICT_KEYS`.
const RESERVED_DICT_KEYS: &[&str] = &["openrouter_provider"];

impl ModelCatalog {
    /// Build a catalog from the raw TOML table (the full merged config).
    ///
    /// Extracts `chat`, `embedding`, and `image_generation` sections. See
    /// `from_sections_with_providers` for the variant that lets the
    /// `[providers.<name>]` registry cascade transport defaults (`sdk`,
    /// `base_url`, `api_key_env`) into static model entries.
    pub fn from_sections(
        chat: Option<&toml::Table>,
        embedding: Option<&toml::Table>,
        image_generation: Option<&toml::Table>,
    ) -> Result<Self, CatalogError> {
        Self::from_sections_with_providers(chat, embedding, image_generation, None)
    }

    /// Build a catalog with optional provider-registry transport overlay.
    ///
    /// When `providers` is `Some`, each `[chat.<name>]` entry inherits
    /// the registry's `sdk`, `base_url`, and `api_key_env` as defaults
    /// (lower precedence than `[chat.<name>]` scalars and per-model
    /// fields, higher than the hardcoded provider defaults). This lets
    /// custom OpenAI-compatible providers configured solely under
    /// `[providers.<name>]` route their static aliases through the
    /// correct transport without duplicating fields under `[chat.<name>]`.
    pub fn from_sections_with_providers(
        chat: Option<&toml::Table>,
        embedding: Option<&toml::Table>,
        image_generation: Option<&toml::Table>,
        providers: Option<&crate::config::providers::ProviderRegistry>,
    ) -> Result<Self, CatalogError> {
        let chat_models = match chat {
            Some(t) => parse_category("chat", t, providers)?,
            None => BTreeMap::new(),
        };

        // Embedding and image_generation are keyed by `provider:model_id`;
        // identity is the key, transport resolves through `[providers.*]`, and
        // the table body holds only category settings. The old flat shape
        // (bare alias key + inline transport) is rejected here.
        let embedding_profiles = match embedding {
            Some(t) => {
                parse_aux_section::<EmbeddingSettings>("embedding", t, "text-embedding-3-large")?
            }
            None => BTreeMap::new(),
        };
        let image_gen_profiles = match image_generation {
            Some(t) => parse_aux_section::<ImageGenSettings>("image_generation", t, "dall-e-3")?,
            None => BTreeMap::new(),
        };

        let catalog = Self {
            chat: chat_models,
            embedding: embedding_profiles,
            image_generation: image_gen_profiles,
        };
        info!(
            chat_models = catalog.chat.len(),
            "Model catalog initialized"
        );
        Ok(catalog)
    }

    /// Look up a model by short name or qualified name.
    ///
    /// Qualified names (`"chat.anthropic.opus"`) are tried first.
    /// Short names (`"opus"`) search across all categories and error
    /// on ambiguity.
    pub fn find_model(&self, name: &str) -> Result<&ResolvedModel, CatalogError> {
        debug!(name, "Looking up model in catalog");

        // 1. Try qualified name match.
        for model in self.chat.values() {
            if model.qualified_name == name {
                debug!(
                    name,
                    qualified_name = name,
                    "Model resolved by qualified name"
                );
                return Ok(model);
            }
        }

        // 2. Try short name match.
        let mut matches: Vec<&ResolvedModel> = Vec::new();
        for model in self.chat.values() {
            if model.name == name {
                matches.push(model);
            }
        }

        // Both miss arms return a descriptive `CatalogError`; the caller owns
        // the severity decision. Don't `warn!` here — this lookup is also used
        // as a speculative probe (e.g. `effective_catalog::find_effective_model`
        // tries the static catalog first, then falls back to discovery), where
        // a miss is expected and not worth a warning. Terminal callers that
        // treat a miss as a real misconfiguration log it themselves with
        // context (see `resolve_background_model`, `apply_heartbeat_model_override`).
        match matches.as_slice() {
            [] => {
                debug!(name, "Model not found in static catalog");
                Err(CatalogError::NotFound {
                    name: name.to_owned(),
                })
            }
            [only] => {
                debug!(
                    name,
                    qualified_name = only.qualified_name,
                    "Model resolved by short name"
                );
                Ok(*only)
            }
            _ => {
                let locations: Vec<&str> =
                    matches.iter().map(|m| m.qualified_name.as_str()).collect();
                debug!(
                    name,
                    locations = locations.join(", "),
                    "Ambiguous model name — found in multiple providers"
                );
                Err(CatalogError::AmbiguousName {
                    name: name.to_owned(),
                    locations: locations.join(", "),
                })
            }
        }
    }

    /// Get the first chat model, if any.
    pub fn first_chat_model(&self) -> Option<&ResolvedModel> {
        self.chat.values().next()
    }

    /// Iterate all chat model qualified names (e.g. `"chat.anthropic.opus"`).
    pub fn chat_model_names(&self) -> impl Iterator<Item = &str> {
        self.chat.keys().map(String::as_str)
    }
}

// ── Category parser ─────────────────────────────────────────────────────

/// Parse a category section (`[chat]` or `[tools]`) from raw TOML.
///
/// Parses the `[<category>.<provider>.<model>]` static model sub-tables for a
/// category, returning the resolved models keyed by qualified name.
///
/// Provider-level defaults no longer live here — they were rehomed onto
/// `[providers.<provider>.defaults]` (#137). Scalar keys directly under
/// `[<category>.<provider>]` are therefore rejected with a migration error.
fn parse_category(
    category: &str,
    section: &toml::Table,
    providers: Option<&crate::config::providers::ProviderRegistry>,
) -> Result<BTreeMap<String, ResolvedModel>, CatalogError> {
    let mut models = BTreeMap::new();
    debug!(
        category,
        providers = section.len(),
        "Parsing model category"
    );

    for (provider_key, provider_value) in section {
        // The Claude Code transport was removed; reject leftover
        // `[chat.claude_code.*]` / `[tools.claude_code.*]` sections explicitly
        // so the breaking change surfaces as a clear config error rather than
        // silently routing through `default_sdk("claude_code") == Openai`.
        if provider_key == "claude_code" {
            return Err(CatalogError::RemovedProvider {
                category: category.to_owned(),
            });
        }

        let Some(provider_table) = provider_value.as_table() else {
            warn!(
                category,
                key = provider_key,
                "Skipping non-table key in [{category}]"
            );
            continue;
        };

        // Provider-level scalars under `[<category>.<provider>]` were retired in
        // favor of `[providers.<provider>.defaults]`. Reject any leftover so a
        // stale config fails loudly instead of silently dropping (e.g.) routing.
        for (k, v) in provider_table {
            if !v.is_table() || RESERVED_DICT_KEYS.contains(&k.as_str()) {
                let target = if TRANSPORT_SCALAR_KEYS.contains(&k.as_str()) {
                    "the matching [providers.<name>] entry"
                } else {
                    "[providers.<name>.defaults]"
                };
                return Err(CatalogError::ProviderScalarRetired {
                    category: category.to_owned(),
                    provider: provider_key.clone(),
                    key: k.clone(),
                    target,
                });
            }
        }

        // Cascade order (lowest → highest precedence):
        //   1. hardcoded provider defaults
        //   2. `[providers.<provider>]` registry transport (sdk + base_url)
        //   3. `[providers.<provider>.defaults]` behavioral/vendor defaults
        //   4. `[<category>.<provider>.<model>]` per-model fields (below)
        //
        // Credentials (`api_key_env` and the named-key list) intentionally
        // do NOT cascade through this path; the registry's compact
        // `api_key_env` is folded into `keys[]` at parse time, and the
        // credential resolver reads that list directly. Overlaying a
        // single env name back onto the static model would defeat the
        // multi-key fallback machinery.
        let mut provider_config = hardcoded_defaults(provider_key);

        if let Some(registry) = providers {
            if let Some(entry) = registry.get(provider_key) {
                let registry_overlay = ModelConfigFields {
                    sdk: entry.sdk.clone(),
                    base_url: entry.base_url.clone(),
                    ..ModelConfigFields::default()
                };
                provider_config.fields.merge_from(&registry_overlay);
                provider_config.fields.merge_from(&entry.defaults);
            }
        }

        // ── Extract model sub-tables ────────────────────────────────
        for (model_name, model_value) in provider_table {
            // Scalars and reserved dict keys are rejected above; only model
            // sub-tables remain here.
            if !model_value.is_table() || RESERVED_DICT_KEYS.contains(&model_name.as_str()) {
                continue;
            }

            let entry: ModelEntry =
                model_value
                    .clone()
                    .try_into()
                    .map_err(|e| CatalogError::ParseEntry {
                        category: category.to_owned(),
                        provider: provider_key.clone(),
                        name: model_name.clone(),
                        source: Box::new(e),
                    })?;

            let model_id = entry.model_id.ok_or_else(|| CatalogError::MissingModelId {
                category: category.to_owned(),
                provider: provider_key.clone(),
                name: model_name.clone(),
            })?;

            let merged = entry.fields.or_fallback(&provider_config.fields);
            let resolved = ResolvedModel::from_parts(
                model_name.clone(),
                format!("{category}.{provider_key}.{model_name}"),
                category.to_owned(),
                provider_key.clone(),
                model_id,
                default_sdk(provider_key),
                merged,
            );

            let qualified = format!("{category}.{provider_key}.{model_name}");
            debug!(
                category,
                provider = provider_key,
                model = model_name,
                qualified,
                "Resolved model entry"
            );
            let _ignored = models.insert(qualified, resolved);
        }
    }

    // Deprecation window (#139): `[chat.*]` / `[tools.*]` static catalogs are no
    // longer the primary model-definition mechanism. Identity is now
    // `provider:model_id`, transport lives in `[providers.<p>]`, and behavioral
    // knobs live in `[models."<p>:<id>"]`. We still honor the static entries this
    // cycle, but warn once per non-empty category so configs migrate before the
    // entries are physically removed.
    if !models.is_empty() {
        warn!(
            category,
            entries = models.len(),
            "`[{category}.*]` is deprecated and will be removed: define models via \
             `[providers.<provider>]` and select them as `provider:model_id`; move \
             behavioral overrides to `[models.\"<provider>:<model_id>\"]`. The static \
             entries are still honored this release."
        );
    }

    debug!(category, models = models.len(), "Category parsing complete");
    Ok(models)
}

// ── Auxiliary category parser ───────────────────────────────────────────

/// Parse an auxiliary category section (`[embedding]` or `[image_generation]`)
/// keyed by `provider:model_id`. Each value table holds only category settings
/// (`T`); transport and identity are derived from the key plus `[providers.*]`
/// at resolution time. The retired flat shape — a bare alias key, or inline
/// transport/identity fields in the table body — is rejected with a clear
/// migration error.
fn parse_aux_section<T>(
    category: &str,
    section: &toml::Table,
    example: &'static str,
) -> Result<BTreeMap<String, T>, CatalogError>
where
    T: serde::de::DeserializeOwned,
{
    let mut out = BTreeMap::new();
    for (key, value) in section {
        // The new shape requires a `provider:model_id` identity key with both
        // halves non-empty. A bare alias (no colon) is the retired flat shape;
        // `:model` / `provider:` are malformed.
        match key.split_once(':') {
            Some((provider, model_id)) if !provider.is_empty() && !model_id.is_empty() => {}
            Some(_) => {
                return Err(CatalogError::AuxProfileInvalid {
                    category: category.to_owned(),
                    key: key.clone(),
                    detail: "both the provider and model_id halves of the \
                             `provider:model_id` key must be non-empty"
                        .to_owned(),
                    example,
                });
            }
            None => {
                return Err(CatalogError::AuxProfileInvalid {
                    category: category.to_owned(),
                    key: key.clone(),
                    detail: "the key must be a `provider:model_id` identity, not a bare alias"
                        .to_owned(),
                    example,
                });
            }
        }
        if !value.is_table() {
            return Err(CatalogError::AuxProfileInvalid {
                category: category.to_owned(),
                key: key.clone(),
                detail: "the value must be a settings table".to_owned(),
                example,
            });
        }
        // `deny_unknown_fields` on `T` rejects leftover inline transport/identity
        // (`model_id`/`provider`/`api_key_env`/`base_url`/`sdk`) from the old
        // shape, as well as misspelled settings.
        let settings: T = value.clone().try_into().map_err(|e: toml::de::Error| {
            CatalogError::AuxProfileInvalid {
                category: category.to_owned(),
                key: key.clone(),
                detail: e.message().to_owned(),
                example,
            }
        })?;
        let _ignored = out.insert(key.clone(), settings);
    }
    Ok(out)
}

// ── Provider defaults ───────────────────────────────────────────────────

/// Shared baseline for all known providers.
fn base_provider_defaults() -> ModelConfigFields {
    ModelConfigFields {
        temperature: Some(1.0),
        max_output_tokens: Some(8192),
        max_context_tokens: Some(200_000),
        ..Default::default()
    }
}

/// Hardcoded provider defaults (ported from V1 `PROVIDER_DEFAULTS`).
///
/// Public so the effective-catalog merger (Phase 7) can synthesize
/// `ResolvedModel` records for discovered and trusted models as the lowest
/// (code-level) tier, below `[providers.<provider>.defaults]`.
pub fn hardcoded_provider_defaults(provider_key: &str) -> ProviderConfig {
    hardcoded_defaults(provider_key)
}

fn hardcoded_defaults(provider_key: &str) -> ProviderConfig {
    let fields = match provider_key {
        "anthropic" => ModelConfigFields {
            sdk: Some(Sdk::Anthropic),
            api_key_env: Some("ANTHROPIC_API_KEY".into()),
            ..base_provider_defaults()
        },
        "openrouter" => ModelConfigFields {
            // Non-Anthropic OpenRouter models route through the first-party
            // `@openrouter/sdk` adapter (the sidecar's normalized path that
            // folds each vendor's reasoning shape into one `reasoning_details`
            // array). Claude-over-OpenRouter uses a separate `openrouter-anthropic`
            // provider with an explicit `sdk = "anthropic"`.
            sdk: Some(Sdk::Openrouter),
            api_key_env: Some("OPENROUTER_API_KEY".into()),
            base_url: Some("https://openrouter.ai/api/v1".into()),
            ..base_provider_defaults()
        },
        "deepseek" => ModelConfigFields {
            // Native DeepSeek via the Vercel AI SDK provider (`@ai-sdk/deepseek`),
            // which adds reasoning control (thinking on/off/adaptive +
            // reasoningEffort) over the old plain OpenAI-compatible path.
            sdk: Some(Sdk::Deepseek),
            api_key_env: Some("DEEPSEEK_API_KEY".into()),
            base_url: Some("https://api.deepseek.com/v1".into()),
            ..base_provider_defaults()
        },
        "moonshot" | "moonshotai" => ModelConfigFields {
            // Native Moonshot (Kimi) via the Vercel AI SDK provider
            // (`@ai-sdk/moonshotai`): native thinking on/off + reasoningHistory.
            sdk: Some(Sdk::Moonshot),
            api_key_env: Some("MOONSHOT_API_KEY".into()),
            base_url: Some("https://api.moonshot.ai/v1".into()),
            ..base_provider_defaults()
        },
        "gemini" => ModelConfigFields {
            sdk: Some(Sdk::Gemini),
            api_key_env: Some("GEMINI_API_KEY".into()),
            ..base_provider_defaults()
        },
        "xai" => ModelConfigFields {
            sdk: Some(Sdk::Openai),
            api_key_env: Some("XAI_API_KEY".into()),
            base_url: Some("https://api.x.ai/v1".into()),
            ..base_provider_defaults()
        },
        "zhipuai" => ModelConfigFields {
            sdk: Some(Sdk::Openai),
            api_key_env: Some("ZAI_API_KEY".into()),
            base_url: Some("https://open.bigmodel.cn/api/paas/v4".into()),
            ..base_provider_defaults()
        },
        "zai" => ModelConfigFields {
            sdk: Some(Sdk::Zai),
            api_key_env: Some("ZAI_API_KEY".into()),
            zai_clear_thinking: Some(false),
            ..base_provider_defaults()
        },
        "nanogpt" => ModelConfigFields {
            sdk: Some(Sdk::Openai),
            api_key_env: Some("NANOGPT_API_KEY".into()),
            base_url: Some("https://nano-gpt.com/api/v1".into()),
            ..base_provider_defaults()
        },
        "opencode-go" => ModelConfigFields {
            // OpenCode Go is a flat-rate subscription gateway that serves open
            // models across two wire dialects behind one key: most via the
            // OpenAI `/chat/completions` path (DeepSeek, Kimi, GLM, MiMo, …) and
            // MiniMax/Qwen via the Anthropic `/messages` path. Deliberately
            // leave `sdk` unset so the per-model SDK that discovery stamps
            // (`map_entry` auto-map: qwen/minimax → anthropic, else → openai)
            // wins via `disc.sdk` in `build_resolved_from_provider`, rather than
            // a blanket provider default. Subscription billing means these calls
            // are excluded from usage budgets (see `is_subscription_provider`).
            api_key_env: Some("OPENCODE_API_KEY".into()),
            base_url: Some("https://opencode.ai/zen/go/v1".into()),
            ..base_provider_defaults()
        },
        _ => ModelConfigFields::default(),
    };
    ProviderConfig { fields }
}

/// Default SDK for a provider key (used when neither hardcoded nor TOML specifies one).
pub fn default_sdk(provider_key: &str) -> Sdk {
    match provider_key {
        "anthropic" => Sdk::Anthropic,
        // OpenRouter's non-Anthropic models route through the first-party
        // `@openrouter/sdk` adapter by default (`anthropic/*` model_ids are
        // still auto-promoted to Sdk::Anthropic in `from_parts`).
        "openrouter" => Sdk::Openrouter,
        "gemini" => Sdk::Gemini,
        "zai" => Sdk::Zai,
        "deepseek" => Sdk::Deepseek,
        "moonshot" | "moonshotai" => Sdk::Moonshot,
        // Everything else (xai, zhipuai, custom) defaults to the direct
        // OpenAI-compatible path.
        _ => Sdk::Openai,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
#[expect(
    clippy::indexing_slicing,
    reason = "tests index catalog maps by keys they just inserted; a missing key should fail the test loudly"
)]
mod tests {
    use super::*;

    /// Helper: parse a TOML string as a table.
    fn parse_table(s: &str) -> toml::Table {
        s.parse::<toml::Table>().unwrap()
    }

    #[test]
    fn cache_keepalive_parse_off_sentinels_and_durations() {
        for off in ["off", "none", "disabled", "false", "0", "OFF", "  off  "] {
            assert_eq!(
                CacheKeepaliveSetting::parse(off).unwrap(),
                CacheKeepaliveSetting::Off,
                "{off:?} should be Off"
            );
        }
        assert_eq!(
            CacheKeepaliveSetting::parse("55m").unwrap(),
            CacheKeepaliveSetting::Every(ConfigDuration::from_secs(3300))
        );
        assert_eq!(
            CacheKeepaliveSetting::parse("6h").unwrap(),
            CacheKeepaliveSetting::Every(ConfigDuration::from_secs(21_600))
        );
    }

    #[test]
    fn cache_keepalive_rejects_zero_and_garbage() {
        // Zero-length intervals would re-arm at `now` and spin — rejected; `off`
        // is the explicit disable.
        for zero in ["0s", "0ms", "0m", "0h"] {
            assert!(
                CacheKeepaliveSetting::parse(zero).is_err(),
                "{zero:?} must be rejected"
            );
        }
        assert!(CacheKeepaliveSetting::parse("soon").is_err());
        assert!(CacheKeepaliveSetting::parse("-5m").is_err());
    }

    #[test]
    fn cache_keepalive_round_trips_through_display() {
        for s in ["off", "55m", "6h", "30s"] {
            let parsed = CacheKeepaliveSetting::parse(s).unwrap();
            assert_eq!(
                CacheKeepaliveSetting::parse(&parsed.to_string()).unwrap(),
                parsed,
                "{s:?} round-trip"
            );
        }
    }

    // ── parse_category ──────────────────────────────────────────────

    #[test]
    fn parse_single_provider_single_model() {
        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
sdk = "anthropic"
api_key_env = "MY_KEY"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        assert_eq!(models.len(), 1);

        let opus = &models["chat.anthropic.opus"];
        assert_eq!(opus.name, "opus");
        assert_eq!(opus.qualified_name, "chat.anthropic.opus");
        assert_eq!(opus.category, "chat");
        assert_eq!(opus.provider_key, "anthropic");
        assert_eq!(opus.sdk, Sdk::Anthropic);
        assert_eq!(opus.model_id, "claude-opus-4-6");
        assert_eq!(opus.api_key_env.as_deref(), Some("MY_KEY"));
    }

    #[test]
    fn openrouter_provider_defaults_to_openrouter_sdk() {
        let table = parse_table(
            r#"
[openrouter.deepseek]
model_id = "deepseek/deepseek-v4"

[openrouter.glm]
model_id = "z-ai/glm-5.1"
sdk = "zai"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();

        // Non-Anthropic OpenRouter model → first-party OpenRouter SDK by default.
        assert_eq!(models["chat.openrouter.deepseek"].sdk, Sdk::Openrouter);
        // An explicit per-model `sdk` pin is always honored over the default.
        assert_eq!(models["chat.openrouter.glm"].sdk, Sdk::Zai);
    }

    #[test]
    fn anthropic_slug_auto_promotes_when_sdk_unset() {
        // A provider with no hardcoded SDK + an `anthropic/*` model_id and no
        // explicit `sdk` auto-promotes to the Anthropic SDK (cache_control
        // path). This is the seam `openrouter-anthropic` relies on.
        let table = parse_table(
            r#"
[myrouter.claude]
model_id = "anthropic/claude-sonnet-4-6"
api_key_env = "MY_KEY"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        assert_eq!(models["chat.myrouter.claude"].sdk, Sdk::Anthropic);
    }

    #[test]
    fn openrouter_sdk_wire_string_round_trips() {
        assert_eq!(default_sdk("openrouter"), Sdk::Openrouter);
        assert_eq!(Sdk::Openrouter.as_str(), "openrouter");
        assert_eq!(Sdk::parse_wire("openrouter"), Some(Sdk::Openrouter));
    }

    #[test]
    fn provider_defaults_cascade_into_models() {
        // `[providers.<provider>.defaults]` behavioral defaults cascade into
        // static models, and a per-model field still overrides them (#137).
        use crate::config::providers::ProviderRegistry;

        let providers_table: toml::Table = r#"
[providers.anthropic.defaults]
max_context_tokens = 65536
cache_ttl = "1h"
"#
        .parse()
        .unwrap();
        let registry = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"

[anthropic.sonnet]
model_id = "claude-sonnet-4-6"
cache_ttl = "5m"
"#,
        );
        let models = parse_category("chat", &table, Some(&registry)).unwrap();

        // opus inherits the provider defaults
        let opus = &models["chat.anthropic.opus"];
        assert_eq!(opus.max_context_tokens, Some(65536));
        assert_eq!(opus.cache_ttl.as_deref(), Some("1h"));

        // sonnet overrides cache_ttl but still inherits max_context_tokens
        let sonnet = &models["chat.anthropic.sonnet"];
        assert_eq!(sonnet.max_context_tokens, Some(65536));
        assert_eq!(sonnet.cache_ttl.as_deref(), Some("5m"));
    }

    #[test]
    fn hardcoded_defaults_apply_when_no_toml_scalars() {
        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.anthropic.opus"];

        // Should get hardcoded anthropic defaults.
        assert_eq!(opus.sdk, Sdk::Anthropic);
        assert_eq!(opus.api_key_env.as_deref(), Some("ANTHROPIC_API_KEY"));
        assert_eq!(opus.temperature, Some(1.0));
        assert_eq!(opus.max_output_tokens, Some(8192));
        assert_eq!(opus.max_context_tokens, Some(200_000));
        // Anthropic SDK auto-enables prompt caching at 1h.
        assert_eq!(opus.cache_ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn anthropic_sdk_auto_enables_cache_ttl_via_explicit_sdk_override() {
        // Custom provider key with explicit `sdk = "anthropic"` — the
        // hardcoded `"anthropic"` provider-key path isn't involved, so this
        // pins that the default fires off the resolved SDK, not the key.
        let table = parse_table(
            r#"
[my_anthropic_proxy.opus]
model_id = "claude-opus-4-6"
sdk = "anthropic"
api_key_env = "MY_KEY"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.my_anthropic_proxy.opus"];
        assert_eq!(opus.sdk, Sdk::Anthropic);
        assert_eq!(opus.cache_ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn non_anthropic_sdk_does_not_get_default_cache_ttl() {
        let table = parse_table(
            r#"
[openrouter.foo]
model_id = "anthropic/claude-opus-4.6"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let foo = &models["chat.openrouter.foo"];
        // openrouter -> Sdk::Openrouter via hardcoded_defaults (non-Anthropic),
        // so it still gets no automatic "1h" cache_ttl.
        assert_eq!(foo.sdk, Sdk::Openrouter);
        assert_eq!(foo.cache_ttl, None);
    }

    #[test]
    fn explicit_empty_cache_ttl_disables_anthropic_caching() {
        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
cache_ttl = ""
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.anthropic.opus"];
        // Explicit empty string survives — the runtime treats it as disabled.
        assert_eq!(opus.cache_ttl.as_deref(), Some(""));
    }

    #[test]
    fn explicit_cache_ttl_overrides_anthropic_default() {
        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
cache_ttl = "5m"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.anthropic.opus"];
        assert_eq!(opus.cache_ttl.as_deref(), Some("5m"));
    }

    #[test]
    fn claude_4_7_plus_drops_baked_temperature_default() {
        // `base_provider_defaults` bakes `temperature = 1.0` into every
        // anthropic model; for Claude >=4.7 it must not reach the wire (#138).
        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-8"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.anthropic.opus"];
        assert_eq!(opus.temperature, None, "baked 1.0 dropped silently");
        assert_eq!(opus.top_p, None);
        assert_eq!(opus.budget_tokens, None);
    }

    #[test]
    fn claude_4_7_plus_drops_explicit_sampler_values() {
        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-8"
temperature = 0.5
top_p = 0.9
budget_tokens = 2048
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.anthropic.opus"];
        assert_eq!(opus.temperature, None, "explicit value dropped (would 400)");
        assert_eq!(opus.top_p, None);
        assert_eq!(opus.budget_tokens, None);
    }

    #[test]
    fn claude_below_cutoff_keeps_sampler_values() {
        // sonnet-4.6 is below the 4.7 cutoff: the baked temperature default and
        // an explicit top_p both survive.
        let table = parse_table(
            r#"
[anthropic.sonnet]
model_id = "claude-sonnet-4-6"
top_p = 0.9
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let sonnet = &models["chat.anthropic.sonnet"];
        assert_eq!(
            sonnet.temperature,
            Some(1.0),
            "baked default kept below cutoff"
        );
        assert_eq!(sonnet.top_p, Some(0.9));
    }

    #[test]
    fn sampler_cutoff_follows_model_id_across_sdks() {
        // An `anthropic/*` slug under a non-Anthropic provider is still gated by
        // the model id, not the sdk.
        let table = parse_table(
            r#"
[openrouter.opus]
model_id = "anthropic/claude-opus-4-8"
temperature = 0.3
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.openrouter.opus"];
        // openrouter's hardcoded default pins `Sdk::Openrouter` (so the
        // `anthropic/*` auto-promotion doesn't fire), yet the sampler cutoff
        // still applies: it follows the model id, not the sdk.
        assert_eq!(opus.sdk, Sdk::Openrouter);
        assert_eq!(opus.temperature, None);
    }

    #[test]
    fn openrouter_o_series_drops_explicit_sampler_values() {
        // Issue #164: an OR-routed OpenAI o-series model rejects samplers via a
        // `[[model_override]]`, so `from_parts` strips an explicit temperature
        // just like the Claude >=4.7 cutoff does.
        let table = parse_table(
            r#"
[openrouter.o3]
model_id = "openai/o3-mini"
temperature = 0.3
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let o3 = &models["chat.openrouter.o3"];
        assert_eq!(o3.sdk, Sdk::Openrouter);
        assert_eq!(o3.temperature, None, "o-series sampler dropped (would 400)");
    }

    #[test]
    fn provider_registry_transport_cascades_into_static_models() {
        // Regression pin: a custom OpenAI-compatible provider configured
        // only under `[providers.<name>]` should propagate sdk and
        // base_url into static `[chat.<name>]` aliases, so the request
        // routes through the right transport without users duplicating
        // those fields under `[chat.<name>]`. Credentials cascade
        // through the provider key resolver instead, not through this
        // overlay (see the `_credentials_do_not_cascade` test).
        use crate::config::providers::ProviderRegistry;

        let providers_table: toml::Table = r#"
[providers.acme]
sdk = "openai"
base_url = "https://acme.example.com/v1"
"#
        .parse()
        .unwrap();
        let registry = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let table = parse_table(
            r#"
[acme.fast]
model_id = "acme/fast"
"#,
        );
        let models = parse_category("chat", &table, Some(&registry)).unwrap();

        let fast = &models["chat.acme.fast"];
        assert_eq!(fast.sdk, Sdk::Openai);
        assert_eq!(
            fast.base_url.as_deref(),
            Some("https://acme.example.com/v1")
        );
    }

    #[test]
    fn provider_registry_credentials_do_not_cascade_into_static_models() {
        // The registry's compact `api_key_env` is folded into `keys[]`
        // at parse time. Overlaying a single env name back onto the
        // static model would bypass the multi-key fallback resolver,
        // so credentials must stay out of the transport cascade.
        use crate::config::providers::ProviderRegistry;

        let providers_table: toml::Table = r#"
[providers.acme]
sdk = "openai"
base_url = "https://acme.example.com/v1"
api_key_env = "ACME_KEY"
"#
        .parse()
        .unwrap();
        let registry = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let table = parse_table(
            r#"
[acme.fast]
model_id = "acme/fast"
"#,
        );
        let models = parse_category("chat", &table, Some(&registry)).unwrap();

        let fast = &models["chat.acme.fast"];
        // sdk and base_url cascade.
        assert_eq!(fast.sdk, Sdk::Openai);
        assert_eq!(
            fast.base_url.as_deref(),
            Some("https://acme.example.com/v1")
        );
        // api_key_env stays None — the credential resolver reads
        // `[providers.acme].keys` directly.
        assert!(fast.api_key_env.is_none());
    }

    #[test]
    fn provider_defaults_override_hardcoded_defaults() {
        // `[providers.<provider>.defaults]` behavioral scalars win over the
        // hardcoded provider baseline, and unset fields fall through to it.
        use crate::config::providers::ProviderRegistry;

        let providers_table: toml::Table = r"
[providers.anthropic.defaults]
temperature = 0.5
"
        .parse()
        .unwrap();
        let registry = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let models = parse_category("chat", &table, Some(&registry)).unwrap();
        let opus = &models["chat.anthropic.opus"];

        assert_eq!(opus.temperature, Some(0.5));
        // max_output_tokens still from the hardcoded baseline.
        assert_eq!(opus.max_output_tokens, Some(8192));
    }

    #[test]
    fn provider_level_scalar_under_chat_is_rejected() {
        // Provider-level scalars under `[chat.<provider>]` were retired in
        // favor of `[providers.<provider>.defaults]` (#137); a leftover one
        // fails loudly. Reserved dict keys (e.g. `openrouter_provider`) count.
        let table = parse_table(
            r#"
[anthropic]
openrouter_provider = {order = ["Vertex AI"]}

[anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let err = parse_category("chat", &table, None).unwrap_err();
        let CatalogError::ProviderScalarRetired {
            category,
            provider,
            key,
            ..
        } = err
        else {
            panic!("expected ProviderScalarRetired, got {err:?}");
        };
        assert_eq!(category, "chat");
        assert_eq!(provider, "anthropic");
        assert_eq!(key, "openrouter_provider");
    }

    #[test]
    fn rejects_removed_claude_code_provider_key() {
        let table = parse_table(
            r#"
[claude_code.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let err = parse_category("chat", &table, None).unwrap_err();
        let CatalogError::RemovedProvider { category } = err else {
            panic!("expected RemovedProvider, got {err:?}");
        };
        assert_eq!(category, "chat");
    }

    #[test]
    fn missing_model_id_is_error() {
        let table = parse_table(
            r"
[anthropic.opus]
temperature = 0.5
",
        );
        let err = parse_category("chat", &table, None).unwrap_err();
        assert!(matches!(err, CatalogError::MissingModelId { .. }));
    }

    #[test]
    fn multiple_providers() {
        let table = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"

[openrouter.gemini-pro]
model_id = "google/gemini-3.1-pro-preview"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models["chat.anthropic.opus"].sdk, Sdk::Anthropic);
        assert_eq!(models["chat.openrouter.gemini-pro"].sdk, Sdk::Openrouter); // openrouter default
    }

    // ── ModelCatalog ────────────────────────────────────────────────

    #[test]
    fn find_model_by_short_name() {
        let chat = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let catalog = ModelCatalog::from_sections(Some(&chat), None, None).unwrap();
        let model = catalog.find_model("opus").unwrap();
        assert_eq!(model.model_id, "claude-opus-4-6");
    }

    #[test]
    fn find_model_by_qualified_name() {
        let chat = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let catalog = ModelCatalog::from_sections(Some(&chat), None, None).unwrap();
        let model = catalog.find_model("chat.anthropic.opus").unwrap();
        assert_eq!(model.name, "opus");
    }

    #[test]
    fn find_model_ambiguous_across_providers() {
        let chat = parse_table(
            r#"
[openrouter.fast]
model_id = "or-fast"

[anthropic.fast]
model_id = "an-fast"
"#,
        );
        let catalog = ModelCatalog::from_sections(Some(&chat), None, None).unwrap();

        // Ambiguous short name (same alias under two providers).
        let err = catalog.find_model("fast").unwrap_err();
        assert!(matches!(err, CatalogError::AmbiguousName { .. }));

        // Qualified names still disambiguate.
        let or_model = catalog.find_model("chat.openrouter.fast").unwrap();
        assert_eq!(or_model.model_id, "or-fast");
        let an_model = catalog.find_model("chat.anthropic.fast").unwrap();
        assert_eq!(an_model.model_id, "an-fast");
    }

    #[test]
    fn find_model_not_found() {
        let catalog = ModelCatalog::default();
        let err = catalog.find_model("nonexistent").unwrap_err();
        assert!(matches!(err, CatalogError::NotFound { .. }));
    }

    #[test]
    fn empty_sections_produce_empty_catalog() {
        let catalog = ModelCatalog::from_sections(None, None, None).unwrap();
        assert!(catalog.chat.is_empty());
        assert!(catalog.embedding.is_empty());
        assert!(catalog.image_generation.is_empty());
    }

    #[test]
    fn embedding_and_image_gen_parsed_by_provider_model_id() {
        // New shape: keyed by `provider:model_id`, body holds only category
        // settings; transport lives on `[providers.*]`.
        let embedding = parse_table(
            r#"
["openai:text-embedding-3-large"]
dimensions = 1024
"#,
        );
        let image_gen = parse_table(
            r#"
["gemini:gemini-3.1-flash-image-preview"]
size = "1024x1024"
quality = "hd"
"#,
        );
        let catalog =
            ModelCatalog::from_sections(None, Some(&embedding), Some(&image_gen)).unwrap();
        assert_eq!(
            catalog.embedding["openai:text-embedding-3-large"].dimensions,
            Some(1024)
        );
        let img = &catalog.image_generation["gemini:gemini-3.1-flash-image-preview"];
        assert_eq!(img.size.as_deref(), Some("1024x1024"));
        assert_eq!(img.quality.as_deref(), Some("hd"));
    }

    #[test]
    fn aux_bare_alias_key_is_rejected() {
        // A colon-less key is the retired flat alias shape.
        let embedding = parse_table(
            r"
[text-large]
dimensions = 1024
",
        );
        let err = ModelCatalog::from_sections(None, Some(&embedding), None).unwrap_err();
        let CatalogError::AuxProfileInvalid { category, key, .. } = err else {
            panic!("expected AuxProfileInvalid, got {err:?}");
        };
        assert_eq!(category, "embedding");
        assert_eq!(key, "text-large");
    }

    #[test]
    fn aux_malformed_identity_key_is_rejected() {
        // Both halves of `provider:model_id` must be non-empty.
        for key in [":model", "provider:"] {
            let embedding = parse_table(&format!("[\"{key}\"]\ndimensions = 1024\n"));
            let err = ModelCatalog::from_sections(None, Some(&embedding), None).unwrap_err();
            let CatalogError::AuxProfileInvalid { detail, .. } = err else {
                panic!("expected AuxProfileInvalid for {key:?}, got {err:?}");
            };
            assert!(
                detail.contains("non-empty"),
                "expected non-empty-halves detail for {key:?}, got: {detail}"
            );
        }
    }

    #[test]
    fn aux_inline_transport_is_rejected() {
        // Inline transport/identity in the body is the retired flat shape;
        // `deny_unknown_fields` surfaces it as a migration error.
        let embedding = parse_table(
            r#"
["openai:text-embedding-3-large"]
model_id = "text-embedding-3-large"
api_key_env = "EMBED_KEY"
dimensions = 1024
"#,
        );
        let err = ModelCatalog::from_sections(None, Some(&embedding), None).unwrap_err();
        assert!(
            matches!(err, CatalogError::AuxProfileInvalid { .. }),
            "expected AuxProfileInvalid, got {err:?}"
        );
    }

    #[test]
    fn no_cross_provider_clobbering_same_short_name() {
        // Regression for SHA 99354fd: two providers with the same short model
        // name must produce distinct catalog entries, not overwrite each other.
        let chat = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"

[openrouter.opus]
model_id = "anthropic/claude-opus-4-6"
"#,
        );
        let catalog = ModelCatalog::from_sections(Some(&chat), None, None).unwrap();

        // Both entries must exist under their qualified names.
        assert_eq!(catalog.chat.len(), 2);
        assert!(catalog.chat.contains_key("chat.anthropic.opus"));
        assert!(catalog.chat.contains_key("chat.openrouter.opus"));

        // Each must carry the correct provider-specific model_id.
        assert_eq!(
            catalog.chat["chat.anthropic.opus"].model_id,
            "claude-opus-4-6"
        );
        assert_eq!(
            catalog.chat["chat.openrouter.opus"].model_id,
            "anthropic/claude-opus-4-6"
        );

        // Looking up by qualified name returns the correct one.
        let anthr = catalog.find_model("chat.anthropic.opus").unwrap();
        assert_eq!(anthr.model_id, "claude-opus-4-6");
        assert_eq!(anthr.provider_key, "anthropic");

        let orouter = catalog.find_model("chat.openrouter.opus").unwrap();
        assert_eq!(orouter.model_id, "anthropic/claude-opus-4-6");
        assert_eq!(orouter.provider_key, "openrouter");

        // Short name "opus" is ambiguous — must not silently return one.
        let err = catalog.find_model("opus").unwrap_err();
        assert!(matches!(err, CatalogError::AmbiguousName { .. }));
    }

    #[test]
    fn first_chat_model() {
        let chat = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let catalog = ModelCatalog::from_sections(Some(&chat), None, None).unwrap();
        assert!(catalog.first_chat_model().is_some());

        let empty = ModelCatalog::default();
        assert!(empty.first_chat_model().is_none());
    }

    // ── Sdk ─────────────────────────────────────────────────────────

    #[test]
    fn sdk_serialization() {
        assert_eq!(serde_json::to_value(Sdk::Anthropic).unwrap(), "anthropic");
        assert_eq!(serde_json::to_value(Sdk::Openai).unwrap(), "openai");
        assert_eq!(serde_json::to_value(Sdk::Gemini).unwrap(), "gemini");
        assert_eq!(serde_json::to_value(Sdk::Zai).unwrap(), "zai");
    }

    #[test]
    fn sdk_deserialization_from_toml() {
        #[derive(Deserialize)]
        struct T {
            sdk: Sdk,
        }
        let anthropic: T = toml::from_str("sdk = \"anthropic\"").unwrap();
        assert_eq!(anthropic.sdk, Sdk::Anthropic);
        let openai: T = toml::from_str("sdk = \"openai\"").unwrap();
        assert_eq!(openai.sdk, Sdk::Openai);
    }

    // ── ModelConfigFields ────────────────────────────────────────────

    #[test]
    fn merge_from_overwrites_some_fields() {
        let mut base = ModelConfigFields {
            sdk: Some(Sdk::Anthropic),
            api_key_env: Some("BASE_KEY".into()),
            max_output_tokens: Some(1024),
            temperature: Some(0.5),
            ..Default::default()
        };
        let overlay = ModelConfigFields {
            max_output_tokens: Some(4096),
            top_p: Some(0.9),
            ..Default::default()
        };
        base.merge_from(&overlay);

        // Overwritten by overlay.
        assert_eq!(base.max_output_tokens, Some(4096));
        assert_eq!(base.top_p, Some(0.9));
        // Preserved from base (overlay had None).
        assert_eq!(base.sdk, Some(Sdk::Anthropic));
        assert_eq!(base.api_key_env.as_deref(), Some("BASE_KEY"));
        assert_eq!(base.temperature, Some(0.5));
    }

    #[test]
    fn merge_from_none_overlay_is_noop() {
        let mut base = ModelConfigFields {
            sdk: Some(Sdk::Openai),
            max_output_tokens: Some(2048),
            ..Default::default()
        };
        let empty = ModelConfigFields::default();
        base.merge_from(&empty);

        assert_eq!(base.sdk, Some(Sdk::Openai));
        assert_eq!(base.max_output_tokens, Some(2048));
    }

    #[test]
    fn or_fallback_prefers_self() {
        let primary = ModelConfigFields {
            max_output_tokens: Some(1024),
            temperature: Some(0.3),
            ..Default::default()
        };
        let fallback = ModelConfigFields {
            max_output_tokens: Some(4096),
            temperature: Some(0.9),
            api_key_env: Some("FALLBACK_KEY".into()),
            ..Default::default()
        };
        let result = primary.or_fallback(&fallback);

        assert_eq!(result.max_output_tokens, Some(1024), "self value wins");
        assert_eq!(result.temperature, Some(0.3), "self value wins");
        assert_eq!(
            result.api_key_env.as_deref(),
            Some("FALLBACK_KEY"),
            "fallback fills gap"
        );
    }

    #[test]
    fn or_fallback_both_none_stays_none() {
        let a = ModelConfigFields::default();
        let b = ModelConfigFields::default();
        let result = a.or_fallback(&b);
        assert!(result.max_output_tokens.is_none());
        assert!(result.sdk.is_none());
    }

    // ── chat_model_names ───────────────────────────────────────────

    #[test]
    fn chat_model_names_returns_qualified_names() {
        let table = parse_table(
            r#"
[anthropic.sonnet]
model_id = "claude-sonnet-4-6"

[anthropic.opus]
model_id = "claude-opus-4-6"

[openrouter.kimi]
model_id = "kimi-k2"
"#,
        );
        let catalog = ModelCatalog::from_sections(Some(&table), None, None).unwrap();

        let mut names: Vec<&str> = catalog.chat_model_names().collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "chat.anthropic.opus",
                "chat.anthropic.sonnet",
                "chat.openrouter.kimi"
            ]
        );
    }

    #[test]
    fn chat_model_names_empty_catalog() {
        let catalog = ModelCatalog::from_sections(None, None, None).unwrap();
        assert_eq!(catalog.chat_model_names().count(), 0);
    }

    #[test]
    fn same_short_name_across_providers_both_findable() {
        let chat = parse_table(
            r#"
[anthropic.opus]
model_id = "claude-opus-4-6"

[openrouter.opus]
model_id = "anthropic/claude-opus-4.6"
"#,
        );
        let catalog = ModelCatalog::from_sections(Some(&chat), None, None).unwrap();

        // Both findable by qualified name.
        let a = catalog.find_model("chat.anthropic.opus").unwrap();
        assert_eq!(a.model_id, "claude-opus-4-6");
        let b = catalog.find_model("chat.openrouter.opus").unwrap();
        assert_eq!(b.model_id, "anthropic/claude-opus-4.6");

        // Short name is ambiguous.
        let err = catalog.find_model("opus").unwrap_err();
        assert!(matches!(err, CatalogError::AmbiguousName { .. }));
    }

    #[test]
    fn sdk_as_str() {
        assert_eq!(Sdk::Anthropic.as_str(), "anthropic");
        assert_eq!(Sdk::Openai.as_str(), "openai");
        assert_eq!(Sdk::Gemini.as_str(), "gemini");
        assert_eq!(Sdk::Zai.as_str(), "zai");
        assert_eq!(Sdk::Deepseek.as_str(), "deepseek");
        assert_eq!(Sdk::Moonshot.as_str(), "moonshot");
        // parse_wire round-trips every as_str form.
        for sdk in [
            Sdk::Anthropic,
            Sdk::Openai,
            Sdk::Openrouter,
            Sdk::Gemini,
            Sdk::Zai,
            Sdk::Deepseek,
            Sdk::Moonshot,
        ] {
            assert_eq!(Sdk::parse_wire(sdk.as_str()), Some(sdk));
        }
    }

    #[test]
    fn sdk_deserialize_legacy_variants() {
        // "zhipuai" is still a legacy alias → Openai with a deprecation warning.
        let sdk: Sdk = toml::from_str::<ModelConfigFields>("sdk = \"zhipuai\"")
            .unwrap()
            .sdk
            .unwrap();
        assert_eq!(sdk, Sdk::Openai);
    }

    #[test]
    fn sdk_deserialize_native_deepseek_moonshot() {
        // Issue #164: "deepseek" is now a first-class sdk (Vercel AI SDK
        // adapter), no longer the deprecated alias for Openai. "moonshot" /
        // "moonshotai" both resolve to the Moonshot sdk.
        let sdk = |s: &str| toml::from_str::<ModelConfigFields>(s).unwrap().sdk.unwrap();
        assert_eq!(sdk("sdk = \"deepseek\""), Sdk::Deepseek);
        assert_eq!(sdk("sdk = \"moonshot\""), Sdk::Moonshot);
        assert_eq!(sdk("sdk = \"moonshotai\""), Sdk::Moonshot);
    }

    #[test]
    fn deepseek_moonshot_provider_defaults() {
        // The hardcoded provider defaults route both vendors to their native
        // Vercel AI SDK adapters (not the old OpenAI-compatible path).
        assert_eq!(default_sdk("deepseek"), Sdk::Deepseek);
        assert_eq!(default_sdk("moonshot"), Sdk::Moonshot);
        let ds = hardcoded_provider_defaults("deepseek").fields;
        assert_eq!(ds.sdk, Some(Sdk::Deepseek));
        assert_eq!(ds.api_key_env.as_deref(), Some("DEEPSEEK_API_KEY"));
        let ms = hardcoded_provider_defaults("moonshot").fields;
        assert_eq!(ms.sdk, Some(Sdk::Moonshot));
        assert_eq!(ms.api_key_env.as_deref(), Some("MOONSHOT_API_KEY"));
    }

    #[test]
    fn openrouter_model_with_anthropic_sdk_override() {
        // The key use case: OpenRouter provider with sdk = "anthropic"
        // for Claude models.
        let table = parse_table(
            r#"
[openrouter]

[openrouter.claude-opus]
model_id = "anthropic/claude-opus-4.6"
sdk = "anthropic"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.openrouter.claude-opus"];

        // SDK should be overridden to Anthropic
        assert_eq!(opus.sdk, Sdk::Anthropic);
        // Provider key should still be "openrouter"
        assert_eq!(opus.provider_key, "openrouter");
        // Should inherit OpenRouter's base_url
        assert_eq!(
            opus.base_url.as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        // Should inherit OpenRouter's API key env
        assert_eq!(opus.api_key_env.as_deref(), Some("OPENROUTER_API_KEY"));
    }

    #[test]
    fn anthropic_slug_auto_promotes_to_anthropic_sdk() {
        // Custom provider key with no hardcoded default and no explicit
        // `sdk = `. Any model_id matching `anthropic/*` should still resolve
        // to Sdk::Anthropic so cache_control markers reach the wire.
        let table = parse_table(
            r#"
[openrouter-anthropic.opus]
model_id = "anthropic/claude-opus-4.6"

[openrouter-anthropic.non-anthropic]
model_id = "openai/gpt-5"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();

        let opus = &models["chat.openrouter-anthropic.opus"];
        assert_eq!(opus.sdk, Sdk::Anthropic);
        // cache_ttl defaults to "1h" once promoted.
        assert_eq!(opus.cache_ttl.as_deref(), Some("1h"));

        // Non-anthropic slug under the same provider stays on the fallback
        // (Sdk::Openai for unknown provider keys).
        let other = &models["chat.openrouter-anthropic.non-anthropic"];
        assert_eq!(other.sdk, Sdk::Openai);
    }

    #[test]
    fn explicit_sdk_wins_over_anthropic_slug_auto_promotion() {
        // Explicit `sdk = "openai"` on an `anthropic/*` model_id must be
        // respected (e.g. for testing the chat-completions path).
        let table = parse_table(
            r#"
[openrouter-anthropic.opus-via-openai]
model_id = "anthropic/claude-opus-4.6"
sdk = "openai"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.openrouter-anthropic.opus-via-openai"];
        assert_eq!(opus.sdk, Sdk::Openai);
    }

    #[test]
    fn anthropic_model_with_openrouter_base_url_override() {
        // Alternative config style: anthropic provider with manual overrides.
        let table = parse_table(
            r#"
[anthropic.opus-via-or]
model_id = "anthropic/claude-opus-4.6"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
"#,
        );
        let models = parse_category("chat", &table, None).unwrap();
        let opus = &models["chat.anthropic.opus-via-or"];

        assert_eq!(opus.sdk, Sdk::Anthropic);
        assert_eq!(opus.provider_key, "anthropic");
        assert_eq!(
            opus.base_url.as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(opus.api_key_env.as_deref(), Some("OPENROUTER_API_KEY"));
    }
}
