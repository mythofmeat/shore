//! Per-sdk capability matrix (issue #138).
//!
//! A **code-level** description of which settings each [`Sdk`] honors, ignores,
//! or rejects — plus the few sdk-keyed default values. It is deliberately *not*
//! a user-facing `[sdk.*]` config table: that would tempt users to set things
//! the upstream API rejects. Instead this is the single source of truth that
//!
//! * lifts the old hardcoded `cache_ttl = "1h"` Anthropic default out of
//!   [`crate::config::models::ResolvedModel::from_parts`],
//! * lets catalog resolution drop / warn on settings the wire would 400 on, and
//! * drives `shore model setting` (#130) to show only-applicable keys and
//!   reject out-of-domain values at the boundary.
//!
//! ## sdk vs provider — the tiebreak
//!
//! A model resolves to a `(provider, sdk)` pair, and the two dimensions
//! cross-cut: a provider can span sdks (`openrouter-anthropic` routes
//! `anthropic/*` via the Anthropic sdk) and an sdk spans providers. They are
//! **not** a linear chain, so each setting has a natural owner:
//!
//! * **sdk-dimension** owns behavioral defaults ([`default_value`]) and field
//!   *applicability* ([`applicability`]) — e.g. `cache_ttl` only means anything
//!   on the Anthropic sdk.
//! * **provider-dimension** owns transport + routing *values* (`base_url`,
//!   credentials, `openrouter_provider`, `vertex_*`), carried on the provider
//!   entry / `[providers.*.defaults]`.
//!
//! Collisions are rare; when they happen the precedence is, lowest to highest:
//!
//! ```text
//! sdk-dimension code default  (this module — lowest)
//!   < hardcoded provider defaults
//!     < [providers.<p>.defaults]
//!       < per-model overlay      (highest)
//! ```
//!
//! i.e. **user config always beats the sdk code default**. The cascade is
//! realized by merging the higher tiers into `ModelConfigFields` *before*
//! [`crate::config::models::ResolvedModel::from_parts`], which only fills a field from
//! [`default_value`] when it is still `None`.

use std::sync::LazyLock;

use serde::Deserialize;

use crate::config::models::Sdk;

// ── Compiled-in capability data ──────────────────────────────────────────
//
// The matrix's value tables live in `capabilities.toml`, baked into the binary
// via `include_str!` (and into the TS sidecar via a bun `.toml` import). It is
// the single source of truth; the `pub fn`s below read from it. See that file's
// header for the schema and the cross-language parity contract.
//
// Rust deliberately models only the fields it consumes (per-sdk `domain` /
// `model_override` / the claude rules); serde ignores the TS-only keys (`fold`,
// `budget`) by default.

#[expect(
    clippy::expect_used,
    reason = "capabilities.toml is compiled in via include_str!; a parse failure \
              is a build-time programmer error with no sensible runtime fallback"
)]
static CAPS: LazyLock<CapabilitiesDoc> = LazyLock::new(|| {
    toml::from_str(include_str!("../../capabilities.toml"))
        .expect("baked-in capabilities.toml must parse")
});

#[derive(Debug, Deserialize)]
struct CapabilitiesDoc {
    reasoning_effort: ReasoningEffortDoc,
    claude: ClaudeDoc,
    /// Per-model capability overlay for the OpenRouter passthrough (issue #164),
    /// keyed by a substring of the model_id. See [`reasoning_effort_domain`] and
    /// [`model_override_rejects_sampling`].
    #[serde(default)]
    model_override: Vec<ModelOverride>,
}

#[derive(Debug, Deserialize)]
struct ReasoningEffortDoc {
    anthropic: SdkEffort,
    openai: SdkEffort,
    openrouter: SdkEffort,
    gemini: SdkEffort,
    zai: SdkEffort,
    deepseek: SdkEffort,
    moonshot: SdkEffort,
}

impl ReasoningEffortDoc {
    fn for_sdk(&self, sdk: &Sdk) -> &SdkEffort {
        match sdk {
            Sdk::Anthropic => &self.anthropic,
            Sdk::Openai => &self.openai,
            Sdk::Openrouter => &self.openrouter,
            Sdk::Gemini => &self.gemini,
            Sdk::Zai => &self.zai,
            Sdk::Deepseek => &self.deepseek,
            Sdk::Moonshot => &self.moonshot,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SdkEffort {
    #[serde(default)]
    domain: Vec<String>,
}

/// One per-model override entry. `reasoning_effort` and `rejects_sampling` are
/// looked up independently (each by the first matching entry that carries that
/// field), so an effort-only and a sampling-only entry never interfere.
#[derive(Debug, Deserialize)]
struct ModelOverride {
    #[serde(rename = "match")]
    match_substr: String,
    /// Overrides the per-sdk accepted `reasoning_effort` value set.
    #[serde(default)]
    reasoning_effort: Option<Vec<String>>,
    /// The underlying model rejects sampler knobs (`temperature` / `top_p`).
    #[serde(default)]
    rejects_sampling: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ClaudeDoc {
    default_adaptive: bool,
    default_enabled: bool,
    default_rejects_sampling: bool,
    #[serde(default)]
    thinking_rule: Vec<ClaudeRule>,
    #[serde(default)]
    sampler_rule: Vec<ClaudeRule>,
}

/// One ordered Claude classification rule. All present conditions must hold for
/// a match; the first matching rule in a list wins. Result fields are read per
/// list (`adaptive`/`enabled` for `thinking_rule`, `rejects_sampling` for
/// `sampler_rule`).
#[derive(Debug, Deserialize)]
struct ClaudeRule {
    contains: Option<String>,
    family: Option<String>,
    min_major: Option<u32>,
    min_minor: Option<u32>,
    max_major: Option<u32>,
    max_minor: Option<u32>,
    adaptive: Option<bool>,
    enabled: Option<bool>,
    rejects_sampling: Option<bool>,
}

// ── Applicability ───────────────────────────────────────────────────────

/// How an [`Sdk`] (for a given model) treats a configuration [`Field`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applicability {
    /// The sdk accepts and acts on the field.
    Honored,
    /// The sdk silently ignores the field (harmless, but not useful — so
    /// `shore model setting` should not offer it and a set is a soft error).
    Ignored,
    /// Sending the field causes an upstream API error (a 400). Catalog
    /// resolution drops it before it reaches the wire.
    Rejected,
}

// ── Fields ──────────────────────────────────────────────────────────────

/// The settable knobs — the non-transport subset of
/// [`crate::config::models::ModelConfigFields`]. Transport (`sdk` / `api_key_env` /
/// `base_url`) is owned by the provider entry and is intentionally absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    MaxContextTokens,
    MaxOutputTokens,
    Temperature,
    TopP,
    ReasoningEffort,
    BudgetTokens,
    CacheTtl,
    CacheKeepalive,
    OpenrouterProvider,
    GeminiGeneration,
    ZaiClearThinking,
    ZaiSubscription,
    ReplayPriorThinking,
}

impl Field {
    /// The TOML key for this field (matches the `serde` name in
    /// [`crate::config::models::ModelConfigFields`]). Used in warnings and errors.
    pub fn key(self) -> &'static str {
        match self {
            Field::MaxContextTokens => "max_context_tokens",
            Field::MaxOutputTokens => "max_output_tokens",
            Field::Temperature => "temperature",
            Field::TopP => "top_p",
            Field::ReasoningEffort => "reasoning_effort",
            Field::BudgetTokens => "budget_tokens",
            Field::CacheTtl => "cache_ttl",
            Field::CacheKeepalive => "cache_keepalive",
            Field::OpenrouterProvider => "openrouter_provider",
            Field::GeminiGeneration => "gemini_generation",
            Field::ZaiClearThinking => "zai_clear_thinking",
            Field::ZaiSubscription => "zai_subscription",
            Field::ReplayPriorThinking => "replay_prior_thinking",
        }
    }

    /// Parse a TOML key back into its [`Field`] — the inverse of [`key`]. Keys
    /// that name no matrix field (Shore-only behaviors like `max_tool_iterations`,
    /// or transport like `sdk`) return `None`, which callers treat as "no
    /// capability opinion — always applicable".
    ///
    /// [`key`]: Field::key
    pub fn from_key(key: &str) -> Option<Field> {
        let field = match key {
            "max_context_tokens" => Field::MaxContextTokens,
            "max_output_tokens" => Field::MaxOutputTokens,
            "temperature" => Field::Temperature,
            "top_p" => Field::TopP,
            "reasoning_effort" => Field::ReasoningEffort,
            "budget_tokens" => Field::BudgetTokens,
            "cache_ttl" => Field::CacheTtl,
            "cache_keepalive" => Field::CacheKeepalive,
            "openrouter_provider" => Field::OpenrouterProvider,
            "gemini_generation" => Field::GeminiGeneration,
            "zai_clear_thinking" => Field::ZaiClearThinking,
            "zai_subscription" => Field::ZaiSubscription,
            "replay_prior_thinking" => Field::ReplayPriorThinking,
            _ => return None,
        };
        Some(field)
    }
}

impl std::fmt::Display for Field {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.key())
    }
}

// ── Claude version axis ─────────────────────────────────────────────────

/// The Claude model family that carries the sampler-rejection cutoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeFamily {
    Opus,
    Sonnet,
    Haiku,
}

/// A parsed Claude model version, e.g. `claude-opus-4-8` → `{Opus, 4, 8}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeVersion {
    pub family: ClaudeFamily,
    pub major: u32,
    pub minor: u32,
}

/// Parse `{family, major, minor}` from a Claude model id, or `None` for
/// non-Claude ids. Handles both orderings (`claude-opus-4-8` and the older
/// family-after-version `claude-3-opus`), the `<gateway>/` prefix, `-`/`.`
/// separators, and a trailing `YYYYMMDD` date that must **not** be read as the
/// minor (`claude-sonnet-4-20250514` = Sonnet 4.0). A recognized family token is
/// required, so non-Claude ids (`gpt-4o`) return `None`.
///
/// This is the shared parser the `CAPS` Claude rules evaluate against; the TS
/// sidecar's `parseClaudeModel` mirrors it (kept in lockstep by the parity
/// fixtures).
pub fn parse_claude_version(model_id: &str) -> Option<ClaudeVersion> {
    // Drop a single leading `<gateway>/` segment if present, then lowercase.
    let bare = match model_id.rsplit_once('/') {
        Some((_, tail)) => tail,
        None => model_id,
    };
    let lower = bare.to_ascii_lowercase();

    // Tokenize on non-alphanumeric boundaries so we match whole words, not
    // substrings: require a distinct `claude` token (an unrelated id that merely
    // *contains* "opus"/"sonnet"/"haiku" is not a Claude model) plus a family
    // token.
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    if !tokens.contains(&"claude") {
        return None;
    }
    let family = if tokens.contains(&"opus") {
        ClaudeFamily::Opus
    } else if tokens.contains(&"sonnet") {
        ClaudeFamily::Sonnet
    } else if tokens.contains(&"haiku") {
        ClaudeFamily::Haiku
    } else {
        return None;
    };

    // major = first 1–2 digit numeric token; minor = the next such token. A run
    // of 3+ digits is a date/build stamp, not a version part — skip it.
    let mut major: Option<u32> = None;
    let mut minor: u32 = 0;
    for tok in &tokens {
        if tok.len() > 2 || !tok.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(n) = tok.parse::<u32>() else { continue };
        if major.is_none() {
            major = Some(n);
        } else {
            minor = n;
            break;
        }
    }

    Some(ClaudeVersion {
        family,
        major: major?,
        minor,
    })
}

/// Whether `family` is in a `|`-separated rule set such as `"opus|sonnet"`.
fn family_in_set(set: &str, family: ClaudeFamily) -> bool {
    let want = match family {
        ClaudeFamily::Opus => "opus",
        ClaudeFamily::Sonnet => "sonnet",
        ClaudeFamily::Haiku => "haiku",
    };
    set.split('|').any(|f| f == want)
}

/// Evaluate one [`ClaudeRule`] against a model's lowercased id + parsed version.
/// Every present condition must hold; a rule with no conditions never matches.
fn rule_matches(rule: &ClaudeRule, id_lower: &str, version: Option<ClaudeVersion>) -> bool {
    if let Some(sub) = rule.contains.as_deref() {
        if !id_lower.contains(sub) {
            return false;
        }
    }
    let needs_version =
        rule.family.is_some() || rule.min_major.is_some() || rule.max_major.is_some();
    if needs_version {
        let Some(v) = version else { return false };
        if let Some(fam) = rule.family.as_deref() {
            if !family_in_set(fam, v.family) {
                return false;
            }
        }
        if let Some(maj) = rule.min_major {
            if (v.major, v.minor) < (maj, rule.min_minor.unwrap_or(0)) {
                return false;
            }
        }
        if let Some(maj) = rule.max_major {
            if (v.major, v.minor) > (maj, rule.max_minor.unwrap_or(u32::MAX)) {
                return false;
            }
        }
    }
    rule.contains.is_some() || needs_version
}

/// Whether `model_id` is a Claude model whose wire rejects the sampler knobs
/// (`temperature` / `top_p` / `budget_tokens`). Driven by `[[claude.sampler_rule]]`.
pub fn claude_rejects_sampling(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    let version = parse_claude_version(model_id);
    for rule in &CAPS.claude.sampler_rule {
        if rule_matches(rule, &lower, version) {
            return rule
                .rejects_sampling
                .unwrap_or(CAPS.claude.default_rejects_sampling);
        }
    }
    CAPS.claude.default_rejects_sampling
}

/// Anthropic per-model thinking-mode capability `(adaptive, enabled)`, driven by
/// `[[claude.thinking_rule]]`. No Rust production code consumes this today — it
/// is the parity twin of the sidecar's `claudeThinkingCaps`, kept here so the
/// shared parser + rule table cannot silently diverge across the two languages.
pub fn claude_thinking_caps(model_id: &str) -> (bool, bool) {
    let lower = model_id.to_ascii_lowercase();
    let version = parse_claude_version(model_id);
    for rule in &CAPS.claude.thinking_rule {
        if rule_matches(rule, &lower, version) {
            return (
                rule.adaptive.unwrap_or(CAPS.claude.default_adaptive),
                rule.enabled.unwrap_or(CAPS.claude.default_enabled),
            );
        }
    }
    (CAPS.claude.default_adaptive, CAPS.claude.default_enabled)
}

// ── The matrix ──────────────────────────────────────────────────────────

/// How `sdk` (resolving `model_id`) treats `field`.
///
/// `model_id` only matters for the Claude version cutoff; for every other rule
/// it is unused. Vendor-specific knobs are `Honored` on their owning sdk and
/// `Ignored` everywhere else (harmless but pointless).
pub fn applicability(sdk: &Sdk, model_id: &str, field: Field) -> Applicability {
    match field {
        // Generic knobs every sdk understands. `cache_keepalive` is a daemon-side
        // scheduling cadence (not a wire field), meaningful for any provider with
        // a prompt cache — honored on every sdk; the sdk only changes its default
        // (see `default_value`).
        Field::MaxContextTokens | Field::MaxOutputTokens | Field::CacheKeepalive => {
            Applicability::Honored
        }

        // Most sidecar adapters map `reasoning_effort` to a graded value.
        // DeepSeek's Vercel provider exposes a graded `reasoningEffort`; Moonshot
        // (Kimi) and Z.AI (GLM) only an on/off toggle, so they are still `Honored`
        // but their domain is just `["off"]` (disable → `thinking.type =
        // "disabled"`). The accepted value set is sdk-specific — see
        // `reasoning_effort_domain`.
        Field::ReasoningEffort => match sdk {
            Sdk::Anthropic
            | Sdk::Openai
            | Sdk::Openrouter
            | Sdk::Gemini
            | Sdk::Deepseek
            | Sdk::Moonshot
            | Sdk::Zai => Applicability::Honored,
        },

        // Sampler knobs: rejected on Claude opus/sonnet >= 4.7 OR on a model a
        // `[[model_override]]` flags (the OpenRouter passthrough case — e.g. the
        // OpenAI o-series, issue #164), honored otherwise. The cutoff is
        // sdk-independent — it follows the model id, since the same model can be
        // reached via several sdks (every adapter forwards temperature/top_p
        // verbatim).
        Field::Temperature | Field::TopP => {
            if rejects_sampling(model_id) {
                Applicability::Rejected
            } else {
                Applicability::Honored
            }
        }

        // `budget_tokens` is consumed by the Anthropic, Gemini, and Moonshot
        // wires (`anthropic.ts` thinking budget / `gemini.ts` thinkingBudget /
        // Moonshot `thinking.budgetTokens`). On Anthropic it follows the same
        // Claude >=4.7 sampler cutoff; the OpenAI/OpenRouter/Z.AI/DeepSeek
        // adapters never read it, so it is `Ignored`.
        Field::BudgetTokens => match sdk {
            Sdk::Anthropic => {
                if claude_rejects_sampling(model_id) {
                    Applicability::Rejected
                } else {
                    Applicability::Honored
                }
            }
            Sdk::Gemini | Sdk::Moonshot => Applicability::Honored,
            Sdk::Openai | Sdk::Openrouter | Sdk::Zai | Sdk::Deepseek => Applicability::Ignored,
        },

        // `cache_ttl` only produces `cache_control` on the Anthropic sdk.
        Field::CacheTtl => vendor_field(sdk, &Sdk::Anthropic),

        Field::OpenrouterProvider => vendor_field(sdk, &Sdk::Openrouter),

        Field::GeminiGeneration => vendor_field(sdk, &Sdk::Gemini),

        Field::ZaiClearThinking | Field::ZaiSubscription => vendor_field(sdk, &Sdk::Zai),

        // `replay_prior_thinking` (#191) is honored wherever an adapter puts
        // surviving thinking blocks on the wire: Anthropic (verbatim
        // thinking-block round-trip), OpenAI-compatible (`reasoning_content`
        // on assistant turns — whether a given backend accepts that field is
        // per-backend; ones that reject it surface an API error), Z.AI (the
        // Preserved-Thinking carrier, composing with `zai_clear_thinking`),
        // and OpenRouter (opaque `reasoning_details` round-trip). Ignored on
        // Gemini (the adapter has no reasoning-replay wire surface) and on
        // native DeepSeek/Moonshot, where the provider contract forces full
        // replay regardless of the setting
        // (`shore_llm::requires_reasoning_replay`), so the knob can change
        // nothing.
        Field::ReplayPriorThinking => match sdk {
            Sdk::Anthropic | Sdk::Openai | Sdk::Zai | Sdk::Openrouter => Applicability::Honored,
            Sdk::Gemini | Sdk::Deepseek | Sdk::Moonshot => Applicability::Ignored,
        },
    }
}

/// `Honored` on the owning sdk, `Ignored` elsewhere.
fn vendor_field(sdk: &Sdk, owner: &Sdk) -> Applicability {
    if sdk == owner {
        Applicability::Honored
    } else {
        Applicability::Ignored
    }
}

// ── sdk-keyed defaults ──────────────────────────────────────────────────

/// The canonical code-level default for `field` under `sdk`, as its TOML string
/// form, or `None` if the sdk has no default for it.
///
/// In practice the only entry is `cache_ttl = "1h"` for the Anthropic sdk —
/// prompt caching is opt-in on the wire, and defaulting it on means users get
/// caching without explicit config (set `cache_ttl = ""` to disable). This is
/// the **lowest** tier of the cascade (see the module docs): it fills a field
/// only when nothing higher set it.
pub fn default_value(sdk: &Sdk, field: Field) -> Option<&'static str> {
    match (sdk, field) {
        (Sdk::Anthropic, Field::CacheTtl) => Some("1h"),
        // Anthropic's paid 1h cache tier is worth keeping warm by default;
        // every other sdk leaves keepalive off until the user opts in (their
        // cache lifetimes are opaque and carry no cache-write surcharge to
        // amortize, so a default ping would be wasted spend — see #N).
        (Sdk::Anthropic, Field::CacheKeepalive) => Some("55m"),
        (
            Sdk::Anthropic
            | Sdk::Openai
            | Sdk::Openrouter
            | Sdk::Gemini
            | Sdk::Zai
            | Sdk::Deepseek
            | Sdk::Moonshot,
            _,
        ) => None,
    }
}

// ── Boundary validation (for #130) ──────────────────────────────────────

/// The accepted `reasoning_effort` values for `sdk`, mirroring exactly what the
/// sidecar adapters accept (anything outside the set is dropped/normalized to
/// nothing on the wire, so the boundary should reject it):
///
/// * **Anthropic** — `buildThinkingParams` named efforts `max|xhigh|high|medium|low`
///   plus `adaptive` (`providers/anthropic.ts`). Note: no `minimal`.
/// * **OpenAI / OpenRouter** — `mapReasoningEffort` accepts
///   `minimal|low|medium|high|xhigh|max`, all passed through (not folded).
///   `max` is the ceiling (OpenAI GPT-5.6+; OpenRouter remaps to the nearest
///   level a model supports).
/// * **Gemini** — `thinkingLevel` accepts `minimal|low|medium|high`.
/// * **Z.AI** — ignores `reasoning_effort` entirely (empty set; also `Ignored`
///   in [`applicability`], so [`validate`] returns `Inapplicable` before this).
///
/// A per-model override (first whose `match` is a substring of `model_id` and
/// which carries a `reasoning_effort`) wins over the per-sdk default; see
/// `[[model_override]]`.
pub fn reasoning_effort_domain(sdk: &Sdk, model_id: &str) -> &'static [String] {
    let lower = model_id.to_ascii_lowercase();
    for ov in &CAPS.model_override {
        if let Some(domain) = ov.reasoning_effort.as_deref() {
            if lower.contains(&ov.match_substr.to_ascii_lowercase()) {
                return domain;
            }
        }
    }
    &CAPS.reasoning_effort.for_sdk(sdk).domain
}

/// Whether the `reasoning_effort = "off"` disable sentinel is HONORED for this
/// sdk — i.e. some adapter actually suppresses reasoning when it sees it. This
/// mirrors the sidecar request layer (issue #164):
///   * `deepseek` / `moonshot` (Vercel AI SDK) — `thinking.type = "disabled"`.
///   * `openrouter` — `reasoning.effort = "none"` (a real off-switch for the
///     always-on vendors it fronts; a few thinking-only endpoints, e.g.
///     `kimi-k2-thinking`, reject it at runtime — a documented limitation).
///   * `anthropic` — omitting thinking params yields a non-thinking request.
///
/// For `openai` and `gemini` the native adapters have NO disable path (reasoning
/// is model-mandatory / left at the model default), so `"off"` is not honored
/// there. `zai` (GLM) DOES support disable — `thinking.type = "disabled"` — so
/// `"off"` is honored. `shore model setting` uses this to reject `"off"` where it
/// would be a silent no-op rather than letting it persist (the `"off"` sentinel
/// is otherwise absent from the graded domains, so the plain value-domain check
/// cannot gate it).
///   * `zai` — `thinking.type = "disabled"`.
pub fn supports_reasoning_off(sdk: &Sdk) -> bool {
    matches!(
        sdk,
        Sdk::Anthropic | Sdk::Deepseek | Sdk::Moonshot | Sdk::Openrouter | Sdk::Zai
    )
}

/// Whether a `[[model_override]]` marks `model_id`'s underlying model as
/// rejecting sampler knobs (`temperature` / `top_p`). This is the OpenRouter
/// passthrough analogue of the Claude version cutoff (issue #164): the
/// `openrouter` sdk fronts vendors whose reasoning-only models (e.g. the OpenAI
/// o-series) reject sampling. First match whose `rejects_sampling` is present
/// wins.
fn model_override_rejects_sampling(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    for ov in &CAPS.model_override {
        if let Some(rejects) = ov.rejects_sampling {
            if lower.contains(&ov.match_substr.to_ascii_lowercase()) {
                return rejects;
            }
        }
    }
    false
}

/// Whether `model_id`'s wire rejects sampler knobs (`temperature` / `top_p`),
/// from EITHER the Claude >=4.7 cutoff ([`claude_rejects_sampling`]) or a
/// per-model `[[model_override]]` (`model_override_rejects_sampling`, the
/// OpenRouter passthrough case). Both inputs key off the model id alone, so this
/// is sdk-independent — every adapter forwards `temperature`/`top_p` verbatim.
pub fn rejects_sampling(model_id: &str) -> bool {
    claude_rejects_sampling(model_id) || model_override_rejects_sampling(model_id)
}

/// Why a setting was rejected at the boundary.
#[derive(Debug, thiserror::Error)]
pub enum CapabilityError {
    #[error("`{field}` is not applicable to the `{sdk}` sdk for this model")]
    Inapplicable { field: Field, sdk: &'static str },

    #[error("`{field}` value {value:?} is out of domain; allowed: {allowed}")]
    OutOfDomain {
        field: Field,
        value: String,
        allowed: String,
    },
}

/// Validate that `value` is an acceptable setting for `field` on `sdk` /
/// `model_id`. Used by `shore model setting` (#130) to reject at the boundary.
///
/// * A non-[`Applicability::Honored`] field is [`CapabilityError::Inapplicable`]
///   (you cannot usefully set a field the sdk ignores or rejects).
/// * A `Honored` field whose value falls outside its domain is
///   [`CapabilityError::OutOfDomain`].
pub fn validate(
    sdk: &Sdk,
    model_id: &str,
    field: Field,
    value: &toml::Value,
) -> Result<(), CapabilityError> {
    match applicability(sdk, model_id, field) {
        Applicability::Honored => {}
        Applicability::Ignored | Applicability::Rejected => {
            return Err(CapabilityError::Inapplicable {
                field,
                sdk: sdk.as_str(),
            });
        }
    }

    // Value-domain checks. Only `reasoning_effort` has a closed string domain
    // today, and it is sdk-specific; other honored fields accept any well-typed
    // value.
    if field == Field::ReasoningEffort {
        if let Some(effort) = value.as_str() {
            let domain = reasoning_effort_domain(sdk, model_id);
            if !domain.iter().any(|v| v == effort) {
                return Err(CapabilityError::OutOfDomain {
                    field,
                    value: effort.to_owned(),
                    allowed: domain.join(", "),
                });
            }
        }
    }

    // `cache_keepalive` accepts the `off` sentinel or a duration *string*.
    // Non-string TOML values (`30`, `false`) only fail at the next config load,
    // so reject them here too rather than persisting an unloadable setting.
    if field == Field::CacheKeepalive {
        let allowed = || "off, or a duration string like 55m / 6h / 30s".to_owned();
        let Some(raw) = value.as_str() else {
            return Err(CapabilityError::OutOfDomain {
                field,
                value: value.to_string(),
                allowed: allowed(),
            });
        };
        if crate::config::models::CacheKeepaliveSetting::parse(raw).is_err() {
            return Err(CapabilityError::OutOfDomain {
                field,
                value: raw.to_owned(),
                allowed: allowed(),
            });
        }
    }

    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ver(id: &str) -> Option<ClaudeVersion> {
        parse_claude_version(id)
    }

    #[test]
    fn from_key_round_trips_every_field() {
        for field in [
            Field::MaxContextTokens,
            Field::MaxOutputTokens,
            Field::Temperature,
            Field::TopP,
            Field::ReasoningEffort,
            Field::BudgetTokens,
            Field::CacheTtl,
            Field::CacheKeepalive,
            Field::OpenrouterProvider,
            Field::GeminiGeneration,
            Field::ZaiClearThinking,
            Field::ZaiSubscription,
            Field::ReplayPriorThinking,
        ] {
            assert_eq!(Field::from_key(field.key()), Some(field), "{field}");
        }
    }

    #[test]
    fn from_key_is_none_for_non_matrix_keys() {
        // Shore-only behaviors and transport name no capability field — callers
        // treat `None` as "always applicable".
        for key in ["max_tool_iterations", "sdk", "nonsense"] {
            assert_eq!(Field::from_key(key), None, "{key}");
        }
    }

    #[test]
    fn replay_prior_thinking_applicability_tracks_adapter_replay_surfaces() {
        // Honored wherever an adapter transmits surviving thinking blocks;
        // Ignored where no adapter surface exists (gemini) or where the
        // provider floor forces full replay regardless of the setting
        // (native deepseek/moonshot — `requires_reasoning_replay`).
        for sdk in [Sdk::Anthropic, Sdk::Openai, Sdk::Zai, Sdk::Openrouter] {
            assert_eq!(
                applicability(&sdk, "any-model", Field::ReplayPriorThinking),
                Applicability::Honored,
                "{sdk:?}"
            );
        }
        for sdk in [Sdk::Gemini, Sdk::Deepseek, Sdk::Moonshot] {
            assert_eq!(
                applicability(&sdk, "any-model", Field::ReplayPriorThinking),
                Applicability::Ignored,
                "{sdk:?}"
            );
        }
    }

    #[test]
    fn parses_dash_and_dot_minor_separators() {
        assert_eq!(
            ver("claude-opus-4-7"),
            Some(ClaudeVersion {
                family: ClaudeFamily::Opus,
                major: 4,
                minor: 7
            })
        );
        assert_eq!(
            ver("claude-opus-4.8"),
            Some(ClaudeVersion {
                family: ClaudeFamily::Opus,
                major: 4,
                minor: 8
            })
        );
        assert_eq!(
            ver("claude-sonnet-4-6"),
            Some(ClaudeVersion {
                family: ClaudeFamily::Sonnet,
                major: 4,
                minor: 6
            })
        );
    }

    #[test]
    fn strips_gateway_prefix() {
        assert_eq!(
            ver("anthropic/claude-opus-4.8"),
            Some(ClaudeVersion {
                family: ClaudeFamily::Opus,
                major: 4,
                minor: 8
            })
        );
    }

    #[test]
    fn requires_a_claude_token_not_a_substring() {
        // An unrelated id that merely *contains* a family word is not Claude.
        assert_eq!(ver("opus-writer-v2"), None);
        assert_eq!(ver("some-haiku-poet"), None);
        assert_eq!(ver("sonnet-composer-3"), None);
        // A real Claude id (either ordering) still parses.
        assert!(ver("claude-opus-4-8").is_some());
        assert!(ver("claude-3-opus-20240229").is_some());
    }

    #[test]
    fn rejects_non_claude_and_pre_4_ids() {
        // Non-Claude ids have no recognized family token.
        assert_eq!(ver("gpt-5.5"), None);
        assert_eq!(ver("deepseek-chat"), None);
        // Pre-4 Claude ids (both orderings) now parse, but stay below the
        // sampler cutoff — they still honor sampling.
        assert_eq!(
            ver("anthropic/claude-3.5-sonnet"),
            Some(ClaudeVersion {
                family: ClaudeFamily::Sonnet,
                major: 3,
                minor: 5
            })
        );
        assert_eq!(
            ver("anthropic/claude-3-haiku"),
            Some(ClaudeVersion {
                family: ClaudeFamily::Haiku,
                major: 3,
                minor: 0
            })
        );
        assert!(!claude_rejects_sampling("anthropic/claude-3.5-sonnet"));
        assert!(!claude_rejects_sampling("anthropic/claude-3-haiku"));
    }

    #[test]
    fn sampling_cutoff_boundary() {
        assert!(claude_rejects_sampling("claude-opus-4-7"));
        assert!(claude_rejects_sampling("claude-opus-4.8"));
        assert!(claude_rejects_sampling("claude-sonnet-4-7"));
        // Below the cutoff.
        assert!(!claude_rejects_sampling("claude-sonnet-4-6"));
        assert!(!claude_rejects_sampling("claude-opus-4-6"));
        // Haiku is exempt at every version.
        assert!(!claude_rejects_sampling("claude-haiku-4-8"));
    }

    #[test]
    fn dated_dot_zero_release_is_not_misread_as_a_minor() {
        // `claude-sonnet-4-20250514` is Sonnet *4.0* with a `YYYYMMDD` stamp —
        // the date must NOT be parsed as minor `20250514` (which would wrongly
        // trip the >=4.7 cutoff). It is below the cutoff and honors sampling.
        assert_eq!(ver("claude-sonnet-4-20250514").unwrap().minor, 0);
        assert!(!claude_rejects_sampling("claude-sonnet-4-20250514"));
        // A real minor *plus* a date still parses the minor correctly.
        assert_eq!(ver("claude-opus-4-1-20250805").unwrap().minor, 1);
        // A dated major-5 release still rejects (above the cutoff).
        assert!(claude_rejects_sampling("claude-opus-5-20260101"));
    }

    #[test]
    fn thinking_caps_match_legacy_classification() {
        // Parity twin of the sidecar `claudeThinkingCaps`: (adaptive, enabled).
        assert_eq!(claude_thinking_caps("claude-opus-4-8"), (true, false)); // adaptive-only
        assert_eq!(claude_thinking_caps("claude-opus-4-5"), (false, true)); // enabled-only
        assert_eq!(claude_thinking_caps("claude-sonnet-4-5"), (false, true));
        assert_eq!(claude_thinking_caps("claude-haiku-4-8"), (false, true));
        assert_eq!(
            claude_thinking_caps("claude-3-opus-20240229"),
            (false, true)
        ); // <=3
        assert_eq!(claude_thinking_caps("claude-opus-4-6"), (true, true)); // permissive
        assert_eq!(claude_thinking_caps("claude-sonnet-4-7"), (true, true)); // permissive (sonnet, not opus)
        assert_eq!(claude_thinking_caps("claude-opus-5-20260101"), (true, true)); // permissive (major 5)
        assert_eq!(
            claude_thinking_caps("claude-opus-4-8-mythos"),
            (true, false)
        ); // mythos special-case
    }

    #[test]
    fn cross_language_parity_fixture() {
        // Shared with the TS sidecar (`tests/capabilities_parity.test.ts`): both
        // must agree with these expected values, keeping the two parser + rule
        // reimplementations in lockstep.
        #[derive(Deserialize)]
        struct Doc {
            case: Vec<Case>,
        }
        #[derive(Deserialize)]
        struct Case {
            model: String,
            is_claude: bool,
            rejects_sampling: bool,
            adaptive: Option<bool>,
            enabled: Option<bool>,
        }
        let doc: Doc =
            toml::from_str(include_str!("../../capability_parity_fixture.toml")).unwrap();
        for c in doc.case {
            assert_eq!(
                parse_claude_version(&c.model).is_some(),
                c.is_claude,
                "is_claude mismatch for {}",
                c.model
            );
            assert_eq!(
                rejects_sampling(&c.model),
                c.rejects_sampling,
                "rejects_sampling mismatch for {}",
                c.model
            );
            if let (Some(a), Some(e)) = (c.adaptive, c.enabled) {
                assert_eq!(
                    claude_thinking_caps(&c.model),
                    (a, e),
                    "thinking_caps mismatch for {}",
                    c.model
                );
            }
        }
    }

    #[test]
    fn capabilities_toml_loads() {
        // The baked-in file must parse and carry the expected sdk domains.
        assert!(reasoning_effort_domain(&Sdk::Anthropic, "claude-opus-4-8")
            .iter()
            .any(|v| v == "adaptive"));
        assert_eq!(reasoning_effort_domain(&Sdk::Zai, "glm-5"), ["off"]);
    }

    #[test]
    fn sampler_fields_rejected_only_past_cutoff() {
        // temperature/top_p are forwarded by every adapter, so the Claude >=4.7
        // cutoff applies regardless of sdk.
        for field in [Field::Temperature, Field::TopP] {
            assert_eq!(
                applicability(&Sdk::Anthropic, "claude-opus-4-8", field),
                Applicability::Rejected
            );
            assert_eq!(
                applicability(&Sdk::Anthropic, "claude-sonnet-4-6", field),
                Applicability::Honored
            );
            assert_eq!(
                applicability(&Sdk::Openrouter, "anthropic/claude-opus-4.8", field),
                Applicability::Rejected
            );
        }
    }

    #[test]
    fn budget_tokens_only_on_anthropic_and_gemini() {
        // Anthropic: follows the same >=4.7 cutoff.
        assert_eq!(
            applicability(&Sdk::Anthropic, "claude-opus-4-8", Field::BudgetTokens),
            Applicability::Rejected
        );
        assert_eq!(
            applicability(&Sdk::Anthropic, "claude-sonnet-4-6", Field::BudgetTokens),
            Applicability::Honored
        );
        // Gemini honors it (thinkingBudget).
        assert_eq!(
            applicability(&Sdk::Gemini, "gemini-2.5-pro", Field::BudgetTokens),
            Applicability::Honored
        );
        // OpenAI/OpenRouter/Z.AI adapters never read budget_tokens → Ignored.
        for sdk in [Sdk::Openai, Sdk::Openrouter, Sdk::Zai] {
            assert_eq!(
                applicability(&sdk, "anthropic/claude-opus-4.8", Field::BudgetTokens),
                Applicability::Ignored,
                "{sdk:?} should ignore budget_tokens"
            );
        }
    }

    #[test]
    fn cache_ttl_only_honored_on_anthropic() {
        assert_eq!(
            applicability(&Sdk::Anthropic, "claude-opus-4-8", Field::CacheTtl),
            Applicability::Honored
        );
        for sdk in [Sdk::Openai, Sdk::Openrouter, Sdk::Gemini, Sdk::Zai] {
            assert_eq!(
                applicability(&sdk, "whatever", Field::CacheTtl),
                Applicability::Ignored
            );
        }
    }

    #[test]
    fn vendor_knobs_owned_by_their_sdk() {
        assert_eq!(
            applicability(&Sdk::Openrouter, "x", Field::OpenrouterProvider),
            Applicability::Honored
        );
        assert_eq!(
            applicability(&Sdk::Anthropic, "x", Field::OpenrouterProvider),
            Applicability::Ignored
        );
        assert_eq!(
            applicability(&Sdk::Gemini, "x", Field::GeminiGeneration),
            Applicability::Honored
        );
        assert_eq!(
            applicability(&Sdk::Zai, "x", Field::ZaiClearThinking),
            Applicability::Honored
        );
        assert_eq!(
            applicability(&Sdk::Openai, "x", Field::ZaiClearThinking),
            Applicability::Ignored
        );
    }

    #[test]
    fn default_value_is_anthropic_cache_ttl_only() {
        assert_eq!(default_value(&Sdk::Anthropic, Field::CacheTtl), Some("1h"));
        assert_eq!(default_value(&Sdk::Openai, Field::CacheTtl), None);
        assert_eq!(default_value(&Sdk::Anthropic, Field::Temperature), None);
    }

    #[test]
    fn validate_accepts_honored_in_domain() {
        assert!(validate(
            &Sdk::Anthropic,
            "claude-opus-4-8",
            Field::CacheTtl,
            &toml::Value::String("5m".into())
        )
        .is_ok());
        assert!(validate(
            &Sdk::Openai,
            "gpt-5.5",
            Field::ReasoningEffort,
            &toml::Value::String("high".into())
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_inapplicable() {
        let cache_ttl_err = validate(
            &Sdk::Openai,
            "gpt-5.5",
            Field::CacheTtl,
            &toml::Value::String("1h".into()),
        )
        .unwrap_err();
        assert!(matches!(
            cache_ttl_err,
            CapabilityError::Inapplicable { .. }
        ));

        // Sampler on a past-cutoff Claude model is Rejected → Inapplicable.
        let sampler_err = validate(
            &Sdk::Anthropic,
            "claude-opus-4-8",
            Field::Temperature,
            &toml::Value::Float(0.5),
        )
        .unwrap_err();
        assert!(matches!(sampler_err, CapabilityError::Inapplicable { .. }));
    }

    #[test]
    fn validate_cache_keepalive_boundary() {
        // Honored on every sdk; accepts `off` and durations, rejects zero,
        // garbage, and non-string values.
        let ok =
            |v: toml::Value| validate(&Sdk::Deepseek, "deepseek-v4", Field::CacheKeepalive, &v);
        assert!(ok(toml::Value::String("off".into())).is_ok());
        assert!(ok(toml::Value::String("6h".into())).is_ok());
        assert!(matches!(
            ok(toml::Value::String("0s".into())),
            Err(CapabilityError::OutOfDomain { .. })
        ));
        assert!(matches!(
            ok(toml::Value::String("whenever".into())),
            Err(CapabilityError::OutOfDomain { .. })
        ));
        // Non-string TOML values are rejected at the boundary rather than
        // deferred to the next config load.
        assert!(matches!(
            ok(toml::Value::Integer(30)),
            Err(CapabilityError::OutOfDomain { .. })
        ));
        assert!(matches!(
            ok(toml::Value::Boolean(false)),
            Err(CapabilityError::OutOfDomain { .. })
        ));
    }

    #[test]
    fn validate_rejects_out_of_domain_reasoning_effort() {
        // A genuinely-bogus value is rejected on every honored sdk.
        let err = validate(
            &Sdk::Openai,
            "gpt-5.5",
            Field::ReasoningEffort,
            &toml::Value::String("turbo".into()),
        )
        .unwrap_err();
        assert!(matches!(err, CapabilityError::OutOfDomain { .. }));
    }

    #[test]
    fn reasoning_effort_domain_is_sdk_specific() {
        let eff = |v: &str| toml::Value::String(v.into());

        // OpenAI/OpenRouter accept minimal..max; `max` is the real ceiling
        // (OpenAI GPT-5.6+; OpenRouter accepts it and remaps per-model).
        for sdk in [Sdk::Openai, Sdk::Openrouter] {
            for v in ["minimal", "low", "medium", "high", "xhigh", "max"] {
                assert!(
                    validate(&sdk, "gpt-5.5", Field::ReasoningEffort, &eff(v)).is_ok(),
                    "{sdk:?} should accept {v}"
                );
            }
        }

        // Anthropic accepts adaptive/xhigh/max but NOT minimal.
        assert!(validate(
            &Sdk::Anthropic,
            "claude-opus-4-8",
            Field::ReasoningEffort,
            &eff("adaptive")
        )
        .is_ok());
        assert!(validate(
            &Sdk::Anthropic,
            "claude-opus-4-8",
            Field::ReasoningEffort,
            &eff("max")
        )
        .is_ok());
        assert!(matches!(
            validate(
                &Sdk::Anthropic,
                "claude-opus-4-8",
                Field::ReasoningEffort,
                &eff("minimal")
            ),
            Err(CapabilityError::OutOfDomain { .. })
        ));

        // Gemini's set stops at high.
        assert!(matches!(
            validate(
                &Sdk::Gemini,
                "gemini-2.5-pro",
                Field::ReasoningEffort,
                &eff("max")
            ),
            Err(CapabilityError::OutOfDomain { .. })
        ));

        // Z.AI (GLM) honors only `off` (→ thinking.type=disabled); a graded level
        // is out of domain.
        assert!(validate(&Sdk::Zai, "glm-5", Field::ReasoningEffort, &eff("off")).is_ok());
        assert!(matches!(
            validate(&Sdk::Zai, "glm-5", Field::ReasoningEffort, &eff("high")),
            Err(CapabilityError::OutOfDomain { .. })
        ));
    }

    #[test]
    fn gemini_3_1_pro_rejects_minimal_via_model_override() {
        // Gemini 3.1 Pro exposes thinkingLevel low|medium|high only; `minimal` is
        // a Flash / Flash-Lite / Flash-Image level (issue #166, grounded in the
        // Gemini 3 developer guide). The Pro-specific override drops it from the
        // sdk default. Uses the real registry id `google/gemini-3.1-pro-preview`.
        let eff = |v: &str| toml::Value::String(v.into());
        let pro = "google/gemini-3.1-pro-preview";
        let domain = reasoning_effort_domain(&Sdk::Gemini, pro);
        assert!(!domain.iter().any(|v| v == "minimal"));
        for v in ["low", "medium", "high"] {
            assert!(
                validate(&Sdk::Gemini, pro, Field::ReasoningEffort, &eff(v)).is_ok(),
                "gemini-3.1-pro should accept {v}"
            );
        }
        assert!(matches!(
            validate(&Sdk::Gemini, pro, Field::ReasoningEffort, &eff("minimal")),
            Err(CapabilityError::OutOfDomain { .. })
        ));

        // The Pro-specific match must NOT catch Flash 3.1 ids — Flash / Flash-Lite
        // / Flash-Image keep `minimal` (it is in fact their default thinkingLevel).
        for flash in [
            "google/gemini-3.1-flash-image-preview",
            "google/gemini-3.1-flash-lite",
            "gemini-3.5-flash",
        ] {
            assert!(
                reasoning_effort_domain(&Sdk::Gemini, flash)
                    .iter()
                    .any(|v| v == "minimal"),
                "{flash} must keep `minimal`"
            );
        }
    }

    #[test]
    fn openrouter_per_vendor_reasoning_domains() {
        // Issue #164: OR-routed vendors resolve their effort domain by model id,
        // not by the generic `openrouter` sdk default (minimal..xhigh).
        let dom = |id: &str| reasoning_effort_domain(&Sdk::Openrouter, id).to_vec();

        // Gemini: drops `xhigh` (thinkingLevel has no xhigh); Pro override still
        // wins for Pro ids (no `minimal`).
        assert_eq!(
            dom("google/gemini-2.5-flash"),
            ["minimal", "low", "medium", "high"]
        );
        assert_eq!(dom("google/gemini-3.1-pro"), ["low", "medium", "high"]);

        // Grok (enum effort): low|medium|high only.
        assert_eq!(dom("x-ai/grok-4.3"), ["low", "medium", "high"]);

        // No-tier / budget-mapped OR vendors keep the generic set (OR maps
        // effort→budget ratio), matching the #166 audit. Kimi is the issue's own
        // example — its native reasoning is on/off, not graded.
        let generic = ["minimal", "low", "medium", "high", "xhigh", "max"];
        assert_eq!(dom("moonshotai/kimi-k2.6"), generic);
        assert_eq!(dom("deepseek/deepseek-v4-pro"), generic);
        assert_eq!(dom("z-ai/glm-5.1"), generic);
        assert_eq!(dom("some-vendor/mystery-model"), generic);
    }

    #[test]
    fn openrouter_o_series_rejects_sampling_via_override() {
        // OR-routed OpenAI o-series reject temperature/top_p → Rejected, so
        // `shore model setting` hides them and `from_parts` strips them.
        for id in ["openai/o1-mini", "openai/o3", "openai/o4-mini"] {
            for field in [Field::Temperature, Field::TopP] {
                assert_eq!(
                    applicability(&Sdk::Openrouter, id, field),
                    Applicability::Rejected,
                    "{id} {field} should be Rejected"
                );
            }
        }

        // GPT-5 supports temperature — NOT in the reject list (distinct from the
        // o-series); samplers stay Honored.
        for field in [Field::Temperature, Field::TopP] {
            assert_eq!(
                applicability(&Sdk::Openrouter, "openai/gpt-5", field),
                Applicability::Honored,
                "gpt-5 {field} should stay Honored"
            );
        }

        // The override path is sdk-independent (keys off the model id) and does
        // not disturb the Claude cutoff.
        assert!(rejects_sampling("openai/o3"));
        assert!(!rejects_sampling("openai/gpt-5"));
        assert!(rejects_sampling("claude-opus-4-8"));
    }

    #[test]
    fn native_deepseek_moonshot_reasoning_capabilities() {
        // Issue #164: native DeepSeek/Moonshot via the Vercel AI SDK providers.
        // DeepSeek has two distinct effort levels, high|max; per the docs
        // low/medium fold to high and xhigh folds to max, so only the two real
        // levels are in the domain. https://api-docs.deepseek.com/guides/thinking_mode
        let ds = reasoning_effort_domain(&Sdk::Deepseek, "deepseek-reasoner");
        assert_eq!(ds, ["high", "max"]);
        assert_eq!(
            applicability(&Sdk::Deepseek, "deepseek-reasoner", Field::ReasoningEffort),
            Applicability::Honored
        );
        // Moonshot reasoning is on/off: Honored with the single accepted value
        // `off` (disable). `off` validates; a graded level is out of domain.
        assert_eq!(
            reasoning_effort_domain(&Sdk::Moonshot, "kimi-k2-thinking"),
            ["off"]
        );
        assert_eq!(
            applicability(&Sdk::Moonshot, "kimi-k2-thinking", Field::ReasoningEffort),
            Applicability::Honored
        );
        let eff = |v: &str| toml::Value::String(v.into());
        assert!(validate(
            &Sdk::Moonshot,
            "kimi-k2-thinking",
            Field::ReasoningEffort,
            &eff("off")
        )
        .is_ok());
        assert!(matches!(
            validate(
                &Sdk::Moonshot,
                "kimi-k2-thinking",
                Field::ReasoningEffort,
                &eff("high")
            ),
            Err(CapabilityError::OutOfDomain { .. })
        ));
        // Moonshot consumes budget_tokens (thinking.budgetTokens); DeepSeek does not.
        assert_eq!(
            applicability(&Sdk::Moonshot, "kimi-k2-thinking", Field::BudgetTokens),
            Applicability::Honored
        );
        assert_eq!(
            applicability(&Sdk::Deepseek, "deepseek-reasoner", Field::BudgetTokens),
            Applicability::Ignored
        );
    }

    #[test]
    fn supports_reasoning_off_only_for_disable_capable_sdks() {
        // Issue #164 (CodeRabbit): the `off` sentinel is honored only where an
        // adapter actually suppresses reasoning. Z.AI honors it via
        // `thinking.type = "disabled"`; native openai/gemini have no disable
        // path, so `off` must NOT slip past validation there.
        for sdk in [
            Sdk::Anthropic,
            Sdk::Deepseek,
            Sdk::Moonshot,
            Sdk::Openrouter,
            Sdk::Zai,
        ] {
            assert!(supports_reasoning_off(&sdk), "{sdk:?} should honor off");
        }
        for sdk in [Sdk::Openai, Sdk::Gemini] {
            assert!(!supports_reasoning_off(&sdk), "{sdk:?} must not honor off");
        }
    }

    #[test]
    fn validate_rejects_sampler_on_or_o_series() {
        let err = validate(
            &Sdk::Openrouter,
            "openai/o3-mini",
            Field::Temperature,
            &toml::Value::Float(0.5),
        )
        .unwrap_err();
        assert!(matches!(err, CapabilityError::Inapplicable { .. }));
    }
}
