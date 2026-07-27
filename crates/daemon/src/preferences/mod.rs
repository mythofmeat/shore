//! Daemon-owned, durable model preferences.
//!
//! Storage layout (Phase 2):
//!
//! - `<data_dir>/preferences/models.toml` — global preferences.
//! - `<data_dir>/<character>/preferences/models.toml` — per-character.
//!
//! Schema:
//!
//! ```toml
//! [selected]
//! provider = "openrouter"
//! model_id = "anthropic/claude-sonnet-4.5"
//!
//! [defaults.sampler]
//! temperature = 1.0
//!
//! [models."openrouter:anthropic/claude-sonnet-4.5"]
//! temperature = 0.8
//! top_p = 0.95
//! reasoning_effort = "medium"
//! ```
//!
//! Per-model entries are keyed by **stable provider key + upstream
//! model_id**, joined by `:` — never by display name or short alias —
//! so preferences survive renames in the static catalog and follow the
//! same model across discovered/manual entries.
//!
//! Phase 2 deliverable: load/save + merge resolver.
//! Phase 3 wires this into the generation request path: preferences are
//! the durable source of truth, with `active_model` cached on the
//! session for the duration of a connection.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::debug;

const PREFERENCES_DIR: &str = "preferences";
const PREFERENCES_FILE: &str = "models.toml";

// ── Errors ──────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum PreferenceError {
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("failed to write {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("failed to parse {path}: {source}")]
    Parse {
        path: PathBuf,
        source: toml::de::Error,
    },

    #[error("failed to serialize preferences: {0}")]
    Serialize(#[source] toml::ser::Error),
}

// ── Sampler settings ────────────────────────────────────────────────────

/// Per-model sampler/settings overrides written by the user.
///
/// Every field is optional — `None` means "inherit from the next layer up
/// in the merge stack" (see `resolve_sampler_settings`). The complete
/// stack is described in `TODO/provider-model-rework.md`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct SamplerSettings {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    /// Reasoning effort: a string like `"low" | "medium" | "high"`, or
    /// `"off"` to explicitly disable reasoning. `None` means "inherit"
    /// (no opinion at this layer).
    pub reasoning_effort: Option<String>,
    /// Token budget for extended thinking / reasoning. Mirrors
    /// `ResolvedModel.budget_tokens` in the static catalog.
    pub budget_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub cache_ttl: Option<String>,
    /// Per-model keepalive ping cadence (`off` or a duration like `55m`).
    /// Mirrors `ModelConfigFields`/`ResolvedModel.cache_keepalive`, exposed
    /// here so it is configurable per-model at runtime. `None` inherits the
    /// sdk default resolved in `ResolvedModel::from_parts` (Anthropic → `55m`,
    /// every other sdk → `off`). It is a daemon-side scheduling cadence, not a
    /// wire field, so it is honored for any provider with a prompt cache.
    pub cache_keepalive: Option<shore_common::config::models::CacheKeepaliveSetting>,
    /// Wire SDK override (`"anthropic" | "openai" | "gemini" | "zai"`).
    /// `None` means inherit from the static catalog or provider registry.
    /// Lets users force, e.g., the Anthropic wire shape for a model that
    /// the discovery cache labelled as `openai`. Validated on write.
    pub sdk: Option<String>,
    /// Per-model override for `[memory.thinking].replay_prior_thinking`:
    /// whether to keep prior-turn extended-thinking blocks in outgoing
    /// requests. `None` inherits the global value. The quality effect is
    /// model-dependent (issue #129) — opus-4.8 is reproducibly better with
    /// it OFF while minimax-m3/glm-5.1 want it ON — so there is no
    /// opinionated default and no auto-promotion in either direction. The
    /// DeepSeek/Kimi reasoning-replay floor (`requires_reasoning_replay`) is
    /// orthogonal and still enforced regardless of this setting.
    /// `all` | `none`; legacy bool configs still deserialize (#191).
    pub replay_prior_thinking: Option<shore_common::config::app::ThinkingReplay>,

    /// Maximum tool-loop iterations per turn. `None` means **unlimited** (the
    /// default) — the loop runs until the model stops requesting tools. This
    /// is the single surface governing every agentic tool loop: interactive
    /// chat, heartbeat, compaction, and dreaming. It is a behavioral knob, not
    /// a wire/sampler value, and is honored by every sdk (not capability-gated).
    pub max_tool_iterations: Option<u32>,

    // ── Vendor knobs (per-model runtime settings) ───────────────────────
    // These mirror the same-named `ModelConfigFields`/`ResolvedModel` fields,
    // exposed here so they are configurable per-model at runtime (model > sdk >
    // provider). `shore model setting` gates each by the capability matrix, so
    // a model only ever sees the knobs its resolved sdk honors.
    /// OpenRouter provider routing object (`{ order, allow_fallbacks, ... }`).
    pub openrouter_provider: Option<toml::Value>,
    pub gemini_generation: Option<u32>,
    /// Z.AI `thinking.clear_thinking` toggle.
    pub zai_clear_thinking: Option<bool>,
    pub zai_subscription: Option<bool>,
}

impl SamplerSettings {
    /// Apply `overlay` on top of `self`: each field set in `overlay`
    /// replaces the corresponding field in `self`. Fields that are
    /// `None` in `overlay` leave `self` unchanged.
    pub fn apply_overlay(&mut self, overlay: &Self) {
        macro_rules! merge {
            ($field:ident) => {
                if overlay.$field.is_some() {
                    self.$field = overlay.$field.clone();
                }
            };
        }
        merge!(temperature);
        merge!(top_p);
        merge!(reasoning_effort);
        merge!(budget_tokens);
        merge!(max_output_tokens);
        merge!(cache_ttl);
        merge!(cache_keepalive);
        merge!(sdk);
        merge!(replay_prior_thinking);
        merge!(max_tool_iterations);
        merge!(openrouter_provider);
        merge!(gemini_generation);
        merge!(zai_clear_thinking);
        merge!(zai_subscription);
    }

    /// Returns true if every field is unset.
    pub fn is_empty(&self) -> bool {
        self.temperature.is_none()
            && self.top_p.is_none()
            && self.reasoning_effort.is_none()
            && self.budget_tokens.is_none()
            && self.max_output_tokens.is_none()
            && self.cache_ttl.is_none()
            && self.cache_keepalive.is_none()
            && self.sdk.is_none()
            && self.replay_prior_thinking.is_none()
            && self.max_tool_iterations.is_none()
            && self.openrouter_provider.is_none()
            && self.gemini_generation.is_none()
            && self.zai_clear_thinking.is_none()
            && self.zai_subscription.is_none()
    }

    /// Extract the sampler-shaped fields from a resolved static-catalog model.
    pub fn from_resolved_model(model: &shore_common::config::models::ResolvedModel) -> Self {
        Self {
            temperature: model.temperature,
            top_p: model.top_p,
            reasoning_effort: model.reasoning_effort.clone(),
            budget_tokens: model.budget_tokens,
            max_output_tokens: model.max_output_tokens,
            cache_ttl: model.cache_ttl.clone(),
            cache_keepalive: model.cache_keepalive,
            sdk: Some(model.sdk.as_str().to_owned()),
            replay_prior_thinking: model.replay_prior_thinking,
            max_tool_iterations: model.max_tool_iterations,
            openrouter_provider: model.openrouter_provider.clone(),
            gemini_generation: model.gemini_generation,
            zai_clear_thinking: model.zai_clear_thinking,
            zai_subscription: model.zai_subscription,
        }
    }
}

// ── Selected model ──────────────────────────────────────────────────────

/// `[selected]` block: which provider+model is active.
///
/// Both fields must be set for the selection to be valid. A partial
/// selection (only one of provider/model_id) is treated as "not selected".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SelectedModel {
    pub provider: Option<String>,
    pub model_id: Option<String>,
}

impl SelectedModel {
    pub fn is_set(&self) -> bool {
        self.provider.is_some() && self.model_id.is_some()
    }

    /// Return `(provider, model_id)` if both are set.
    pub fn pair(&self) -> Option<(&str, &str)> {
        match (self.provider.as_deref(), self.model_id.as_deref()) {
            (Some(p), Some(m)) => Some((p, m)),
            _ => None,
        }
    }

    /// Return the canonical preference key `provider:model_id`.
    pub fn key(&self) -> Option<String> {
        self.pair().map(|(p, m)| preference_key(p, m))
    }
}

// ── Per-model preference entry ──────────────────────────────────────────

/// `[models."<provider>:<model_id>"]` entry. Today this is just a
/// flattened `SamplerSettings`; future phases may add metadata fields
/// (last_used, pinned, etc.) but Phase 2 keeps it minimal.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ModelPreference {
    #[serde(flatten)]
    pub sampler: SamplerSettings,
}

// ── Defaults block ──────────────────────────────────────────────────────

/// `[defaults]` block. Wraps a single `[defaults.sampler]` for now;
/// other defaults can be added later without breaking the schema.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct PreferenceDefaults {
    pub sampler: SamplerSettings,
}

// ── Top-level preferences file ──────────────────────────────────────────

/// Top-level shape of `models.toml` (global or character-scoped).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ModelPreferences {
    pub selected: SelectedModel,
    pub defaults: PreferenceDefaults,
    /// Per-model entries keyed by `<provider>:<model_id>`.
    pub models: BTreeMap<String, ModelPreference>,
}

impl ModelPreferences {
    pub fn is_empty(&self) -> bool {
        !self.selected.is_set() && self.defaults.sampler.is_empty() && self.models.is_empty()
    }

    /// Look up a model preference by `(provider, model_id)`.
    pub fn model(&self, provider: &str, model_id: &str) -> Option<&ModelPreference> {
        self.models.get(&preference_key(provider, model_id))
    }

    /// Insert or update a model preference. Removing all sampler fields
    /// followed by `set_model` does NOT delete the entry — call
    /// `clear_model` for that.
    pub fn set_model(&mut self, provider: &str, model_id: &str, pref: ModelPreference) {
        let _ignored = self.models.insert(preference_key(provider, model_id), pref);
    }

    /// Remove a per-model entry. Returns the previous value if any.
    pub fn clear_model(&mut self, provider: &str, model_id: &str) -> Option<ModelPreference> {
        self.models.remove(&preference_key(provider, model_id))
    }
}

// ── Path helpers ────────────────────────────────────────────────────────

/// Stable preference key: `<provider>:<model_id>`.
pub fn preference_key(provider: &str, model_id: &str) -> String {
    format!("{provider}:{model_id}")
}

/// Path to the global preferences file: `<data_dir>/preferences/models.toml`.
pub fn global_preferences_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PREFERENCES_DIR).join(PREFERENCES_FILE)
}

/// Path to a character's preferences file:
/// `<data_dir>/<character>/preferences/models.toml`.
pub fn character_preferences_path(data_dir: &Path, character: &str) -> PathBuf {
    data_dir
        .join(character)
        .join(PREFERENCES_DIR)
        .join(PREFERENCES_FILE)
}

// ── Load / save ─────────────────────────────────────────────────────────

/// Load preferences from `path`.
///
/// Missing file → empty defaults. Malformed TOML or unknown fields →
/// `PreferenceError::Parse` so the caller can surface a clear error
/// to the user instead of silently overwriting their settings.
pub fn load_preferences(path: &Path) -> Result<ModelPreferences, PreferenceError> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            debug!(path = %path.display(), "No preferences file; using defaults");
            return Ok(ModelPreferences::default());
        }
        Err(e) => {
            return Err(PreferenceError::Read {
                path: path.to_path_buf(),
                source: e,
            });
        }
    };

    toml::from_str::<ModelPreferences>(&content).map_err(|e| PreferenceError::Parse {
        path: path.to_path_buf(),
        source: e,
    })
}

/// Save preferences to `path`. Creates parent directories as needed.
///
/// If the on-disk representation is empty, the file is still written
/// (so users can `cat` it to see the schema). Callers can optimize this
/// later if it matters.
pub fn save_preferences(path: &Path, prefs: &ModelPreferences) -> Result<(), PreferenceError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| PreferenceError::Write {
            path: path.to_path_buf(),
            source: e,
        })?;
    }
    let body = toml::to_string_pretty(prefs).map_err(PreferenceError::Serialize)?;
    std::fs::write(path, body).map_err(|e| PreferenceError::Write {
        path: path.to_path_buf(),
        source: e,
    })
}

// ── Resolver ────────────────────────────────────────────────────────────

/// Resolve which model is selected after layering global + character.
///
/// Character beats global. A partial selection (only one of
/// provider/model_id) is ignored at that layer.
pub fn resolve_selected_model(
    global: &ModelPreferences,
    character: Option<&ModelPreferences>,
) -> Option<(String, String)> {
    if let Some(char_prefs) = character {
        if let Some((p, m)) = char_prefs.selected.pair() {
            return Some((p.to_owned(), m.to_owned()));
        }
    }
    global
        .selected
        .pair()
        .map(|(p, m)| (p.to_owned(), m.to_owned()))
}

/// Resolve sampler settings for `(provider, model_id)`.
///
/// Layer order (lowest to highest precedence):
///
/// 0. `static_default` — sampler-shaped fields from the static catalog
///    `ResolvedModel`. Pass `None` for callers that already merge the
///    static catalog separately (e.g. the chat request path applies
///    overlay on top of a `ResolvedModel` via `apply_sampler_overlay`).
///    Pass `Some(&resolved)` for display/inspection paths so the
///    effective view matches what a request would actually use.
/// 1. `global.defaults.sampler`
/// 2. `character.defaults.sampler`
/// 3. `global.models[<provider:model_id>]`
/// 4. `character.models[<provider:model_id>]`
///
/// Higher layers' set fields overwrite lower layers'. Unset (`None`)
/// fields fall through.
pub fn resolve_sampler_settings(
    global: &ModelPreferences,
    character: Option<&ModelPreferences>,
    provider: &str,
    model_id: &str,
    static_default: Option<&shore_common::config::models::ResolvedModel>,
) -> SamplerSettings {
    let mut effective = static_default
        .map(SamplerSettings::from_resolved_model)
        .unwrap_or_default();
    effective.apply_overlay(&sanitize_persisted_overlay(&global.defaults.sampler));
    if let Some(c) = character {
        effective.apply_overlay(&sanitize_persisted_overlay(&c.defaults.sampler));
    }
    if let Some(p) = global.model(provider, model_id) {
        effective.apply_overlay(&sanitize_persisted_overlay(&p.sampler));
    }
    if let Some(c) = character {
        if let Some(p) = c.model(provider, model_id) {
            effective.apply_overlay(&sanitize_persisted_overlay(&p.sampler));
        }
    }
    effective
}

/// Strip overlay fields that the patch path would silently discard, so
/// `model_settings` (inspection) shows the same values a real request
/// would use. Today this just drops an `sdk` string that `Sdk::parse_wire`
/// can't parse — a corrupted hand-edit of `models.toml` shouldn't make
/// `effective_sampler.sdk` diverge from `apply_sampler_overlay`'s result.
/// Returns a `Cow` so the no-op case (overwhelmingly common) avoids a clone.
fn sanitize_persisted_overlay(layer: &SamplerSettings) -> std::borrow::Cow<'_, SamplerSettings> {
    let bad_sdk = layer
        .sdk
        .as_deref()
        .is_some_and(|s| shore_common::config::models::Sdk::parse_wire(s).is_none());
    // `max_tool_iterations = 0` is not a valid persisted value: `None` already
    // means unlimited and `set_model_setting` rejects 0, but a hand-edited
    // `models.toml` can still carry it. Left intact, the tool loops would read
    // `Some(0)` as "cap reached before the first round" — a silent no-op that
    // diverges from the documented `None = unlimited` default. Treat 0 as unset.
    let zero_cap = layer.max_tool_iterations == Some(0);
    if !bad_sdk && !zero_cap {
        return std::borrow::Cow::Borrowed(layer);
    }
    let mut cleaned = layer.clone();
    if bad_sdk {
        cleaned.sdk = None;
    }
    if zero_cap {
        tracing::warn!("preferences carry max_tool_iterations = 0; treating as unset (unlimited)");
        cleaned.max_tool_iterations = None;
    }
    std::borrow::Cow::Owned(cleaned)
}

// ── Scope (where a sampler field came from) ─────────────────────────────

/// Where in the preference stack a sampler field landed. Surfaced in
/// `model_settings` / `model_info` so users can tell whether a value
/// is global or character-scoped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreferenceScope {
    /// Field is unset at every layer; the static catalog default is in effect.
    StaticDefault,
    /// `[defaults.sampler]` in the global preferences file.
    GlobalDefault,
    /// `[defaults.sampler]` in the character preferences file.
    CharacterDefault,
    /// `[models."<key>"]` in the global preferences file.
    GlobalModel,
    /// `[models."<key>"]` in the character preferences file.
    CharacterModel,
}

/// Determine which layer last set each sampler field for `(provider, model_id)`.
/// Higher precedence wins on equal-layer ties; unset fields stay
/// `StaticDefault`.
#[derive(Debug, Clone, Default)]
pub struct SamplerScopes {
    pub temperature: Option<PreferenceScope>,
    pub top_p: Option<PreferenceScope>,
    pub reasoning_effort: Option<PreferenceScope>,
    pub budget_tokens: Option<PreferenceScope>,
    pub max_output_tokens: Option<PreferenceScope>,
    pub cache_ttl: Option<PreferenceScope>,
    pub cache_keepalive: Option<PreferenceScope>,
    pub sdk: Option<PreferenceScope>,
    pub replay_prior_thinking: Option<PreferenceScope>,
    pub max_tool_iterations: Option<PreferenceScope>,
    pub openrouter_provider: Option<PreferenceScope>,
    pub gemini_generation: Option<PreferenceScope>,
    pub zai_clear_thinking: Option<PreferenceScope>,
    pub zai_subscription: Option<PreferenceScope>,
}

pub fn resolve_sampler_scopes(
    global: &ModelPreferences,
    character: Option<&ModelPreferences>,
    provider: &str,
    model_id: &str,
    static_default: Option<&shore_common::config::models::ResolvedModel>,
) -> SamplerScopes {
    let mut scopes = SamplerScopes::default();
    let mut update = |layer: &SamplerSettings, scope: PreferenceScope| {
        macro_rules! note {
            ($field:ident) => {
                if layer.$field.is_some() {
                    scopes.$field = Some(scope);
                }
            };
        }
        note!(temperature);
        note!(top_p);
        note!(reasoning_effort);
        note!(budget_tokens);
        note!(max_output_tokens);
        note!(cache_ttl);
        note!(cache_keepalive);
        note!(sdk);
        note!(replay_prior_thinking);
        note!(max_tool_iterations);
        note!(openrouter_provider);
        note!(gemini_generation);
        note!(zai_clear_thinking);
        note!(zai_subscription);
    };
    if let Some(rm) = static_default {
        update(
            &SamplerSettings::from_resolved_model(rm),
            PreferenceScope::StaticDefault,
        );
    }
    update(
        &sanitize_persisted_overlay(&global.defaults.sampler),
        PreferenceScope::GlobalDefault,
    );
    if let Some(c) = character {
        update(
            &sanitize_persisted_overlay(&c.defaults.sampler),
            PreferenceScope::CharacterDefault,
        );
    }
    if let Some(p) = global.model(provider, model_id) {
        update(
            &sanitize_persisted_overlay(&p.sampler),
            PreferenceScope::GlobalModel,
        );
    }
    if let Some(c) = character {
        if let Some(p) = c.model(provider, model_id) {
            update(
                &sanitize_persisted_overlay(&p.sampler),
                PreferenceScope::CharacterModel,
            );
        }
    }
    scopes
}

// ── Character flow helpers ──────────────────────────────────────────────

/// Load `(global, character)` preferences for a character.
///
/// Either file may be missing — that produces empty defaults rather than
/// an error. Other I/O or parse errors propagate.
pub fn load_for_character(
    data_dir: &Path,
    character: &str,
) -> Result<(ModelPreferences, ModelPreferences), PreferenceError> {
    let global = load_preferences(&global_preferences_path(data_dir))?;
    let char_prefs = load_preferences(&character_preferences_path(data_dir, character))?;
    Ok((global, char_prefs))
}

/// Save just the character preferences file.
pub fn save_character_preferences(
    data_dir: &Path,
    character: &str,
    prefs: &ModelPreferences,
) -> Result<(), PreferenceError> {
    save_preferences(&character_preferences_path(data_dir, character), prefs)
}

/// Save just the global preferences file.
pub fn save_global_preferences(
    data_dir: &Path,
    prefs: &ModelPreferences,
) -> Result<(), PreferenceError> {
    save_preferences(&global_preferences_path(data_dir), prefs)
}

// ── Catalog bridging ────────────────────────────────────────────────────

/// Look up the resolved model that matches `(provider, model_id)` in the
/// static catalog.
///
/// This is the inverse of "save selection" for static entries only: users
/// select by short name, the catalog resolves it to a `ResolvedModel`, and
/// we persist `(provider_key, model_id)`. On reload we walk the catalog to
/// find a matching entry. Returns `None` if no static entry matches —
/// discovered-model lookups go through
/// [`resolve_active_for_character`] / [`crate::effective_catalog`].
pub fn find_static_model<'cat>(
    catalog: &'cat shore_common::config::models::ModelCatalog,
    provider: &str,
    model_id: &str,
) -> Option<&'cat shore_common::config::models::ResolvedModel> {
    catalog
        .chat
        .values()
        .find(|m| m.provider_key == provider && m.model_id == model_id)
}

/// Resolve a saved `(provider, model_id)` selection against the effective
/// catalog (static entries + discovery cache). If the cache has been
/// deleted, a previously selected provider/model pair is reconstructed
/// from the provider registry so cache deletion does not lose the selection.
///
/// `include_hidden = true`: a previously selected discovered model should
/// keep resolving across restarts even if the current `discovery.ignore`
/// list would now hide it. The user explicitly chose it; `discovery.ignore`
/// scopes listing, not restoration.
fn resolve_provider_model(
    config: &shore_common::config::LoadedConfig,
    _data_dir: &Path,
    provider: &str,
    model_id: &str,
) -> Option<shore_common::config::models::ResolvedModel> {
    if let Some(rm) = find_static_model(&config.models, provider, model_id) {
        return Some(rm.clone());
    }
    crate::effective_catalog::find_effective_model(
        config,
        &config.dirs.cache,
        &format!("{provider}:{model_id}"),
        true,
    )
    .ok()
    .or_else(|| synthesize_selected_provider_model(config, provider, model_id))
}

/// Rebuild a previously selected discovered model when its disposable
/// discovery cache has been deleted. Selection durability comes from the
/// preferences file; the provider cache only supplies richer metadata.
fn synthesize_selected_provider_model(
    config: &shore_common::config::LoadedConfig,
    provider: &str,
    model_id: &str,
) -> Option<shore_common::config::models::ResolvedModel> {
    let entry = config.providers.get(provider)?;
    if !entry.enabled {
        return None;
    }

    let mut fields = shore_common::config::models::hardcoded_provider_defaults(provider).fields;
    if let Some(sdk) = &entry.sdk {
        fields.sdk = Some(sdk.clone());
    }
    if let Some(base_url) = &entry.base_url {
        fields.base_url = Some(base_url.clone());
    }
    if let Some(api_key_env) = &entry.api_key_env {
        fields.api_key_env = Some(api_key_env.clone());
    }

    Some(shore_common::config::models::ResolvedModel::from_parts(
        model_id.to_owned(),
        // Canonical `provider:model_id` identity (#139), not the retired
        // `chat.<provider>.<model_id>` cosplay.
        format!("{provider}:{model_id}"),
        "chat".to_owned(),
        provider.to_owned(),
        model_id.to_owned(),
        shore_common::config::models::default_sdk(provider),
        fields,
    ))
}

/// Resolve the active model for a session.
///
/// Resolution order:
///
/// 1. Character preferences `[selected]` (provider, model_id) → effective
///    catalog lookup by `(provider_key, model_id)`. Discovered models
///    resolve through the discovery cache, or through the provider registry
///    if the cache was deleted.
/// 2. Global preferences `[selected]` → same lookup.
/// 3. Legacy `runtime_state.json::active_model` (string name) →
///    catalog `find_model` by name. Migration fallback for installs
///    that haven't written preferences yet.
/// 4. `app.defaults.model` from config — resolved through the effective
///    catalog, so it accepts a static alias *or* a `provider:model_id` ref.
/// 5. First chat model in the static catalog (legacy fallback; `None` for a
///    zero-`[chat.*]` config).
///
/// The legacy `runtime_state.json` is read but never written by Phase 3+
/// code — preferences are now authoritative.
pub fn resolve_active_for_character(
    config: &shore_common::config::LoadedConfig,
    data_dir: &Path,
    global: &ModelPreferences,
    character: &ModelPreferences,
    legacy_active_model: Option<&str>,
    app_default_model: Option<&str>,
) -> Option<shore_common::config::models::ResolvedModel> {
    if let Some((p, m)) = character.selected.pair() {
        if let Some(rm) = resolve_provider_model(config, data_dir, p, m) {
            return Some(rm);
        }
    }
    if let Some((p, m)) = global.selected.pair() {
        if let Some(rm) = resolve_provider_model(config, data_dir, p, m) {
            return Some(rm);
        }
    }
    if let Some(name) = legacy_active_model {
        if let Ok(rm) = config.models.find_model(name) {
            return Some(rm.clone());
        }
    }
    if let Some(name) = app_default_model {
        // `defaults.model` may be a static alias *or* a `provider:model_id`
        // reference (#139). Route through the effective catalog so a config
        // with zero `[chat.*]` entries can still name its default model.
        if let Ok(rm) =
            crate::effective_catalog::find_effective_model(config, &config.dirs.cache, name, true)
        {
            return Some(rm);
        }
    }
    config.models.first_chat_model().cloned()
}

/// Patch a `ResolvedModel` with the given sampler overlay. Returns a
/// fresh owned model — never mutates the catalog entry.
pub fn apply_sampler_overlay(
    model: &shore_common::config::models::ResolvedModel,
    overlay: &SamplerSettings,
) -> shore_common::config::models::ResolvedModel {
    let mut patched = model.clone();
    if let Some(t) = overlay.temperature {
        patched.temperature = Some(t);
    }
    if let Some(p) = overlay.top_p {
        patched.top_p = Some(p);
    }
    if let Some(ref e) = overlay.reasoning_effort {
        // "off" is the explicit-disable sentinel; it is PRESERVED here (not
        // collapsed to None) and translated by the request builder into an
        // explicit thinking-off signal (`provider_options.thinking_enabled =
        // false`). That lets the OpenRouter adapter send `reasoning.effort =
        // "none"`, so always-on reasoning models (OR-routed GLM/Kimi/DeepSeek)
        // actually get reasoning disabled on the wire — merely omitting the
        // field would leave them reasoning by default.
        patched.reasoning_effort = Some(e.clone());
    }
    if let Some(b) = overlay.budget_tokens {
        patched.budget_tokens = Some(b);
    }
    if let Some(m) = overlay.max_output_tokens {
        patched.max_output_tokens = Some(m);
    }
    if let Some(ref c) = overlay.cache_ttl {
        patched.cache_ttl = Some(c.clone());
    }
    if let Some(k) = overlay.cache_keepalive {
        patched.cache_keepalive = Some(k);
    }
    if let Some(ref s) = overlay.sdk {
        // `set_model_setting` validates the string before it reaches the
        // file; anything unparseable here would be a corrupted preferences
        // edit, so log and leave the catalog SDK in place.
        if let Some(sdk) = shore_common::config::models::Sdk::parse_wire(s) {
            patched.sdk = sdk;
        } else {
            tracing::warn!(
                model = %patched.qualified_name,
                sdk = %s,
                "preferences overlay carries unknown sdk; keeping catalog value"
            );
        }
    }
    if let Some(p) = overlay.replay_prior_thinking {
        patched.replay_prior_thinking = Some(p);
    }
    if let Some(n) = overlay.max_tool_iterations {
        patched.max_tool_iterations = Some(n);
    }
    if let Some(ref v) = overlay.openrouter_provider {
        patched.openrouter_provider = Some(v.clone());
    }
    if let Some(g) = overlay.gemini_generation {
        patched.gemini_generation = Some(g);
    }
    if let Some(c) = overlay.zai_clear_thinking {
        patched.zai_clear_thinking = Some(c);
    }
    if let Some(s) = overlay.zai_subscription {
        patched.zai_subscription = Some(s);
    }
    patched
}

/// Layer the global+character sampler overlay onto a resolved model.
///
/// Returns the model unchanged when no overlay applies. A missing
/// preferences file produces empty defaults rather than a warning; other
/// I/O or parse errors are logged with `op` (for forensics) and the raw
/// model is returned so the caller can proceed.
pub fn overlay_for_character(
    data_dir: &Path,
    character: &str,
    base: shore_common::config::models::ResolvedModel,
    op: &'static str,
) -> shore_common::config::models::ResolvedModel {
    match load_for_character(data_dir, character) {
        Ok((global_prefs, char_prefs)) => {
            let overlay = resolve_sampler_settings(
                &global_prefs,
                Some(&char_prefs),
                &base.provider_key,
                &base.model_id,
                Some(&base),
            );
            apply_sampler_overlay(&base, &overlay)
        }
        Err(e) => {
            tracing::warn!(
                character,
                op,
                error = %e,
                "preferences load failed; using raw model settings"
            );
            base
        }
    }
}

/// Resolve the model to use for a background task, with per-character
/// preference overlay (max_output_tokens, reasoning_effort, etc.) already
/// applied.
///
/// Resolution chain:
/// 1. `defaults.background.<task>` (per-task pin)
/// 2. `defaults.background.model` (blanket background pin)
/// 3. The character's currently-selected chat model (active selection
///    from preferences, then legacy `runtime_state.json`)
/// 4. `defaults.model`
/// 5. First chat model in the catalog
///
/// Steps 1–2 come from
/// [`shore_common::config::app::DefaultsConfig::resolve_background_model_name`];
/// 3–5 are the same fallback chain
/// [`resolve_chat_model_for_character`] uses, so an unset
/// `[defaults.background]` section means background tasks simply follow
/// whatever model the character is using for chat.
///
/// Returns `None` only when the catalog has no chat models at all.
///
/// Before this helper existed, every background-task site (manual
/// `/compact`, background compaction, dreaming, heartbeat override)
/// re-implemented the chain and either forgot the overlay or copy-pasted
/// it inconsistently. The missing overlay silently dropped
/// per-character `max_output_tokens`, capping responses at 4096 tokens and
/// truncating compaction XML mid-`<write>`. See commit `1b4fc03`.
pub fn resolve_background_model(
    config: &shore_common::config::LoadedConfig,
    task: shore_common::config::app::BackgroundTask,
    character: &str,
) -> Option<shore_common::config::models::ResolvedModel> {
    let op = match task {
        shore_common::config::app::BackgroundTask::Heartbeat => "heartbeat",
        shore_common::config::app::BackgroundTask::Compaction => "compaction",
        shore_common::config::app::BackgroundTask::Dreaming => "dreaming",
    };
    if let Some(name) = config.app.defaults.resolve_background_model_name(task) {
        // Resolve through the effective catalog so a background pin written as
        // `provider:model_id` resolves with no static `[chat.*]` entry (#139),
        // mirroring how `app.defaults.model` is handled in
        // `resolve_active_for_character`.
        let base = match crate::effective_catalog::find_effective_model(
            config,
            &config.dirs.cache,
            name,
            true,
        ) {
            Ok(m) => m,
            // The user *explicitly* configured a model for this task (or for
            // `defaults.background.model`) but it doesn't resolve — almost
            // always a typo. Warn loudly and fall back to the character's chat
            // model so the daemon stays up.
            Err(e) => {
                tracing::warn!(
                    op,
                    character,
                    configured_model = %name,
                    error = %e,
                    "Configured {op} model not found in catalog; falling back to active chat model",
                );
                return resolve_chat_model_for_character(config, character);
            }
        };
        return Some(overlay_for_character(
            &config.dirs.data,
            character,
            base,
            op,
        ));
    }
    // No background-specific model configured — follow the character's
    // currently-selected chat model so a `shore model <name>` swap moves
    // background work without needing a separate config knob.
    resolve_chat_model_for_character(config, character)
}

/// Resolve the user's currently-selected chat model with the sampler
/// overlay applied, mirroring what
/// [`crate::handler::MessageHandler`] would build for a fresh chat request.
///
/// Used by the heartbeat cold-rebuild path so the rebuilt request shares
/// chat's cache prefix instead of diverging on a stale `defaults.model`
/// value.
pub fn resolve_chat_model_for_character(
    config: &shore_common::config::LoadedConfig,
    character: &str,
) -> Option<shore_common::config::models::ResolvedModel> {
    let (global_prefs, char_prefs) = match load_for_character(&config.dirs.data, character) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!(
                character,
                op = "resolve_chat_model",
                error = %e,
                "preferences load failed; using empty defaults"
            );
            (ModelPreferences::default(), ModelPreferences::default())
        }
    };
    let legacy = crate::runtime_state::load_active_model(&config.dirs.data.join(character));
    let resolved = resolve_active_for_character(
        config,
        &config.dirs.data,
        &global_prefs,
        &char_prefs,
        legacy.as_deref(),
        config.app.defaults.model.as_deref(),
    )?;
    let overlay = resolve_sampler_settings(
        &global_prefs,
        Some(&char_prefs),
        &resolved.provider_key,
        &resolved.model_id,
        Some(&resolved),
    );
    Some(apply_sampler_overlay(&resolved, &overlay))
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    fn write_prefs(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("models.toml");
        std::fs::write(&path, body).unwrap();
        path
    }

    // ── Path helpers ────────────────────────────────────────────────

    #[test]
    fn preference_key_concatenates_provider_and_model_id() {
        assert_eq!(
            preference_key("openrouter", "anthropic/claude-sonnet-4.5"),
            "openrouter:anthropic/claude-sonnet-4.5"
        );
    }

    #[test]
    fn global_preferences_path_under_data_dir() {
        let p = global_preferences_path(Path::new("/tmp/shore"));
        assert_eq!(p, PathBuf::from("/tmp/shore/preferences/models.toml"));
    }

    #[test]
    fn character_preferences_path_under_character_dir() {
        let p = character_preferences_path(Path::new("/tmp/shore"), "alice");
        assert_eq!(p, PathBuf::from("/tmp/shore/alice/preferences/models.toml"));
    }

    // ── Load behavior ────────────────────────────────────────────────

    #[test]
    fn missing_file_yields_default_preferences() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.toml");
        let prefs = load_preferences(&path).unwrap();
        assert!(prefs.is_empty());
    }

    #[test]
    fn empty_file_yields_default_preferences() {
        let tmp = TempDir::new().unwrap();
        let path = write_prefs(tmp.path(), "");
        let prefs = load_preferences(&path).unwrap();
        assert!(prefs.is_empty());
    }

    #[test]
    fn full_preferences_round_trip() {
        let tmp = TempDir::new().unwrap();
        let body = r#"
[selected]
provider = "openrouter"
model_id = "anthropic/claude-sonnet-4.5"

[defaults.sampler]
temperature = 1.0

[models."openrouter:anthropic/claude-sonnet-4.5"]
temperature = 0.8
top_p = 0.95
reasoning_effort = "medium"

[models."openrouter:google/gemini-2.5-flash"]
temperature = 1.2
top_p = 0.9
reasoning_effort = "off"
"#;
        let path = write_prefs(tmp.path(), body);
        let prefs = load_preferences(&path).unwrap();

        assert_eq!(prefs.selected.provider.as_deref(), Some("openrouter"));
        assert_eq!(
            prefs.selected.model_id.as_deref(),
            Some("anthropic/claude-sonnet-4.5")
        );
        assert!(prefs.selected.is_set());
        assert_eq!(prefs.defaults.sampler.temperature, Some(1.0));
        assert_eq!(prefs.models.len(), 2);

        let sonnet = prefs
            .model("openrouter", "anthropic/claude-sonnet-4.5")
            .unwrap();
        assert_eq!(sonnet.sampler.temperature, Some(0.8));
        assert_eq!(sonnet.sampler.top_p, Some(0.95));
        assert_eq!(sonnet.sampler.reasoning_effort.as_deref(), Some("medium"));

        let gemini = prefs
            .model("openrouter", "google/gemini-2.5-flash")
            .unwrap();
        assert_eq!(gemini.sampler.reasoning_effort.as_deref(), Some("off"));
    }

    #[test]
    fn malformed_file_returns_parse_error() {
        let tmp = TempDir::new().unwrap();
        let path = write_prefs(tmp.path(), "this is not valid toml \x00 \n=");
        let err = load_preferences(&path).unwrap_err();
        assert!(matches!(err, PreferenceError::Parse { .. }));
    }

    #[test]
    fn unknown_field_at_top_level_rejected() {
        // Schema strictness — unknown fields must surface as errors so a
        // typo never silently drops user settings on a write-back.
        let tmp = TempDir::new().unwrap();
        let path = write_prefs(tmp.path(), "typo_field = true\n");
        let err = load_preferences(&path).unwrap_err();
        assert_variant!(

            err,
            PreferenceError::Parse { source, .. } => {
                assert!(
                    source.to_string().contains("unknown field"),
                    "expected unknown-field error, got: {source}"
                );
            }

        );
    }

    #[test]
    fn unknown_sampler_field_rejected() {
        let tmp = TempDir::new().unwrap();
        let path = write_prefs(
            tmp.path(),
            r#"
[models."openrouter:foo/bar"]
temperature = 0.5
typo_setting = "x"
"#,
        );
        let err = load_preferences(&path).unwrap_err();
        assert!(matches!(err, PreferenceError::Parse { .. }));
    }

    // ── Save behavior ────────────────────────────────────────────────

    #[test]
    fn save_creates_parent_directories() {
        let tmp = TempDir::new().unwrap();
        let path = tmp
            .path()
            .join("preferences")
            .join("nested")
            .join("models.toml");
        let prefs = ModelPreferences::default();
        save_preferences(&path, &prefs).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn save_then_load_round_trips_all_fields() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("models.toml");

        let mut prefs = ModelPreferences::default();
        prefs.selected.provider = Some("anthropic".into());
        prefs.selected.model_id = Some("claude-sonnet-4-5".into());
        prefs.defaults.sampler.temperature = Some(1.0);
        prefs.set_model(
            "anthropic",
            "claude-sonnet-4-5",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.7),
                    top_p: Some(0.95),
                    reasoning_effort: Some("high".into()),
                    budget_tokens: Some(8192),
                    max_output_tokens: Some(4096),
                    cache_ttl: Some("5m".into()),
                    cache_keepalive: Some(shore_common::config::models::CacheKeepaliveSetting::Off),
                    sdk: Some("anthropic".into()),
                    replay_prior_thinking: Some(shore_common::config::app::ThinkingReplay::None),
                    ..Default::default()
                },
            },
        );

        save_preferences(&path, &prefs).unwrap();
        let reloaded = load_preferences(&path).unwrap();
        assert_eq!(prefs, reloaded);
    }

    // ── Resolver: selected model ─────────────────────────────────────

    #[test]
    fn resolve_selected_returns_global_when_no_character() {
        let mut g = ModelPreferences::default();
        g.selected.provider = Some("anthropic".into());
        g.selected.model_id = Some("opus".into());
        assert_eq!(
            resolve_selected_model(&g, None),
            Some(("anthropic".into(), "opus".into()))
        );
    }

    #[test]
    fn resolve_selected_character_overrides_global() {
        let mut g = ModelPreferences::default();
        g.selected.provider = Some("anthropic".into());
        g.selected.model_id = Some("opus".into());

        let mut c = ModelPreferences::default();
        c.selected.provider = Some("openrouter".into());
        c.selected.model_id = Some("anthropic/claude-sonnet-4.5".into());

        assert_eq!(
            resolve_selected_model(&g, Some(&c)),
            Some(("openrouter".into(), "anthropic/claude-sonnet-4.5".into()))
        );
    }

    #[test]
    fn resolve_selected_character_partial_falls_back_to_global() {
        let mut g = ModelPreferences::default();
        g.selected.provider = Some("anthropic".into());
        g.selected.model_id = Some("opus".into());

        // Character has only provider set — incomplete, ignored at this layer.
        let mut c = ModelPreferences::default();
        c.selected.provider = Some("openrouter".into());

        assert_eq!(
            resolve_selected_model(&g, Some(&c)),
            Some(("anthropic".into(), "opus".into()))
        );
    }

    #[test]
    fn resolve_selected_none_when_neither_set() {
        let g = ModelPreferences::default();
        let c = ModelPreferences::default();
        assert!(resolve_selected_model(&g, Some(&c)).is_none());
    }

    // ── Resolver: sampler settings ────────────────────────────────────

    #[test]
    fn resolve_sampler_uses_global_defaults_when_no_per_model() {
        let mut g = ModelPreferences::default();
        g.defaults.sampler.temperature = Some(1.0);
        g.defaults.sampler.top_p = Some(0.9);
        let s = resolve_sampler_settings(&g, None, "anthropic", "opus", None);
        assert_eq!(s.temperature, Some(1.0));
        assert_eq!(s.top_p, Some(0.9));
    }

    #[test]
    fn resolve_sampler_per_model_overrides_global_defaults() {
        let mut g = ModelPreferences::default();
        g.defaults.sampler.temperature = Some(1.0);
        g.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.7),
                    ..Default::default()
                },
            },
        );
        let s = resolve_sampler_settings(&g, None, "anthropic", "opus", None);
        assert_eq!(s.temperature, Some(0.7));
    }

    #[test]
    fn resolve_sampler_character_overrides_global_per_model() {
        let mut g = ModelPreferences::default();
        g.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.7),
                    top_p: Some(0.9),
                    ..Default::default()
                },
            },
        );

        let mut c = ModelPreferences::default();
        c.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.5),
                    ..Default::default()
                },
            },
        );

        let s = resolve_sampler_settings(&g, Some(&c), "anthropic", "opus", None);
        // Character overrides temperature.
        assert_eq!(s.temperature, Some(0.5));
        // top_p falls through from global per-model.
        assert_eq!(s.top_p, Some(0.9));
    }

    #[test]
    fn resolve_sampler_full_layer_precedence() {
        // Build all four layers with distinct values to confirm precedence.
        let mut g = ModelPreferences::default();
        g.defaults.sampler.temperature = Some(0.1);
        g.defaults.sampler.top_p = Some(0.10);
        g.defaults.sampler.max_output_tokens = Some(100);
        g.defaults.sampler.budget_tokens = Some(1000);
        g.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.2),
                    top_p: Some(0.20),
                    ..Default::default()
                },
            },
        );

        let mut c = ModelPreferences::default();
        c.defaults.sampler.top_p = Some(0.30);
        c.defaults.sampler.max_output_tokens = Some(200);
        c.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.4),
                    ..Default::default()
                },
            },
        );

        let s = resolve_sampler_settings(&g, Some(&c), "anthropic", "opus", None);
        assert_eq!(s.temperature, Some(0.4), "char per-model wins");
        assert_eq!(s.top_p, Some(0.20), "global per-model beats char defaults");
        assert_eq!(
            s.max_output_tokens,
            Some(200),
            "char defaults beat global defaults"
        );
        assert_eq!(s.budget_tokens, Some(1000), "global defaults are floor");
    }

    #[test]
    fn resolve_sampler_static_default_is_bottom_layer() {
        // Catalog has cache_ttl + max_output_tokens; preferences have neither.
        // Display path should surface the catalog values.
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
cache_ttl = "1h"
max_output_tokens = 8192
"#,
        );
        let model = catalog.find_model("opus").unwrap();
        let g = ModelPreferences::default();
        let s = resolve_sampler_settings(&g, None, "anthropic", "claude-opus-4-6", Some(model));
        assert_eq!(s.cache_ttl.as_deref(), Some("1h"));
        assert_eq!(s.max_output_tokens, Some(8192));
    }

    #[test]
    fn resolve_sampler_preferences_override_static_default() {
        // Catalog says cache_ttl = "1h"; character pref says "5m".
        // Character pref wins.
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
cache_ttl = "1h"
max_output_tokens = 8192
"#,
        );
        let model = catalog.find_model("opus").unwrap();
        let g = ModelPreferences::default();
        let mut c = ModelPreferences::default();
        c.set_model(
            "anthropic",
            "claude-opus-4-6",
            ModelPreference {
                sampler: SamplerSettings {
                    cache_ttl: Some("5m".into()),
                    max_output_tokens: Some(32768),
                    ..Default::default()
                },
            },
        );
        let s = resolve_sampler_settings(&g, Some(&c), "anthropic", "claude-opus-4-6", Some(model));
        assert_eq!(s.cache_ttl.as_deref(), Some("5m"));
        assert_eq!(s.max_output_tokens, Some(32768));
    }

    #[test]
    fn resolve_sampler_scopes_attributes_static_default() {
        // Field set only in the catalog should report StaticDefault scope.
        // Field overridden in preferences should report the higher layer.
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
cache_ttl = "1h"
max_output_tokens = 8192
"#,
        );
        let model = catalog.find_model("opus").unwrap();
        let g = ModelPreferences::default();
        let mut c = ModelPreferences::default();
        c.set_model(
            "anthropic",
            "claude-opus-4-6",
            ModelPreference {
                sampler: SamplerSettings {
                    max_output_tokens: Some(32768),
                    ..Default::default()
                },
            },
        );
        let scopes =
            resolve_sampler_scopes(&g, Some(&c), "anthropic", "claude-opus-4-6", Some(model));
        assert_eq!(scopes.cache_ttl, Some(PreferenceScope::StaticDefault));
        assert_eq!(
            scopes.max_output_tokens,
            Some(PreferenceScope::CharacterModel)
        );
        // temperature lands on StaticDefault from the anthropic provider's
        // hardcoded baseline (temperature = 1.0). top_p has no default at
        // any layer, so it stays None.
        assert_eq!(scopes.temperature, Some(PreferenceScope::StaticDefault));
        assert_eq!(scopes.top_p, None, "unset everywhere → None");
    }

    // ── Sticky-per-model behavior ────────────────────────────────────

    #[test]
    fn switching_models_preserves_other_models_settings() {
        // Phase 2 storage invariant: setting model B's sampler must not
        // touch model A's stored sampler. Switching back to A restores
        // its settings (Phase 3 wires this into the active selection).
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("models.toml");

        let mut prefs = ModelPreferences::default();
        prefs.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.7),
                    ..Default::default()
                },
            },
        );
        prefs.set_model(
            "anthropic",
            "sonnet",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(1.2),
                    ..Default::default()
                },
            },
        );
        // Mark sonnet as selected, then change selection to opus.
        prefs.selected.provider = Some("anthropic".into());
        prefs.selected.model_id = Some("sonnet".into());
        save_preferences(&path, &prefs).unwrap();

        // Switch selection — does not modify per-model settings.
        let mut reloaded = load_preferences(&path).unwrap();
        reloaded.selected.model_id = Some("opus".into());
        save_preferences(&path, &reloaded).unwrap();

        // Switch back — both temperatures still intact.
        let final_prefs = load_preferences(&path).unwrap();
        assert_eq!(
            final_prefs
                .model("anthropic", "opus")
                .unwrap()
                .sampler
                .temperature,
            Some(0.7)
        );
        assert_eq!(
            final_prefs
                .model("anthropic", "sonnet")
                .unwrap()
                .sampler
                .temperature,
            Some(1.2)
        );
    }

    #[test]
    fn clear_model_removes_entry() {
        let mut prefs = ModelPreferences::default();
        prefs.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.7),
                    ..Default::default()
                },
            },
        );
        let removed = prefs.clear_model("anthropic", "opus");
        assert!(removed.is_some());
        assert!(prefs.model("anthropic", "opus").is_none());
    }

    // ── apply_overlay ────────────────────────────────────────────────

    #[test]
    fn apply_overlay_replaces_only_set_fields() {
        let mut base = SamplerSettings {
            temperature: Some(1.0),
            top_p: Some(0.9),
            max_output_tokens: Some(4096),
            ..Default::default()
        };
        let overlay = SamplerSettings {
            temperature: Some(0.7),
            reasoning_effort: Some("medium".into()),
            ..Default::default()
        };
        base.apply_overlay(&overlay);
        assert_eq!(base.temperature, Some(0.7));
        assert_eq!(base.top_p, Some(0.9), "preserved");
        assert_eq!(base.max_output_tokens, Some(4096), "preserved");
        assert_eq!(base.reasoning_effort.as_deref(), Some("medium"));
    }

    // ── Catalog bridging ─────────────────────────────────────────────

    fn make_catalog(toml: &str) -> shore_common::config::models::ModelCatalog {
        let table: toml::Table = toml.parse().unwrap();
        let chat = table.get("chat").and_then(|v| v.as_table());
        shore_common::config::models::ModelCatalog::from_sections(chat, None, None).unwrap()
    }

    #[test]
    fn find_static_model_locates_by_provider_and_model_id() {
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[chat.openrouter.kimi]
model_id = "kimi-k2"
"#,
        );
        let opus_m = find_static_model(&catalog, "anthropic", "claude-opus-4-6").unwrap();
        assert_eq!(opus_m.qualified_name, "chat.anthropic.opus");

        let kimi_m = find_static_model(&catalog, "openrouter", "kimi-k2").unwrap();
        assert_eq!(kimi_m.qualified_name, "chat.openrouter.kimi");

        // Wrong provider / model_id pairs return None.
        assert!(find_static_model(&catalog, "anthropic", "kimi-k2").is_none());
        assert!(find_static_model(&catalog, "openrouter", "claude-opus-4-6").is_none());
    }

    fn make_loaded_config(
        tmp: &TempDir,
        catalog: shore_common::config::models::ModelCatalog,
    ) -> shore_common::config::LoadedConfig {
        shore_common::config::LoadedConfig::new_for_test(
            shore_common::config::app::AppConfig::default(),
            catalog,
            shore_common::config::ShoreDirs {
                config: tmp.path().join("config"),
                data: tmp.path().to_path_buf(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        )
    }

    #[test]
    fn resolve_active_prefers_character_then_global_then_legacy_then_default() {
        let tmp = tempfile::tempdir().unwrap();
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[chat.anthropic.sonnet]
model_id = "claude-sonnet-4-6"

[chat.openrouter.kimi]
model_id = "kimi-k2"
"#,
        );
        let loaded = make_loaded_config(&tmp, catalog);
        let dd = tmp.path();

        // (a) Character preference wins.
        {
            let g = ModelPreferences::default();
            let mut c = ModelPreferences::default();
            c.selected.provider = Some("anthropic".into());
            c.selected.model_id = Some("claude-sonnet-4-6".into());
            let active = resolve_active_for_character(&loaded, dd, &g, &c, None, None).unwrap();
            assert_eq!(active.qualified_name, "chat.anthropic.sonnet");
        }

        // (b) Global preference falls in when character is empty.
        {
            let mut g = ModelPreferences::default();
            g.selected.provider = Some("openrouter".into());
            g.selected.model_id = Some("kimi-k2".into());
            let c = ModelPreferences::default();
            let active = resolve_active_for_character(&loaded, dd, &g, &c, None, None).unwrap();
            assert_eq!(active.qualified_name, "chat.openrouter.kimi");
        }

        // (c) Legacy runtime_state.json fallback (migration path).
        let g = ModelPreferences::default();
        let c = ModelPreferences::default();
        let active_c =
            resolve_active_for_character(&loaded, dd, &g, &c, Some("opus"), None).unwrap();
        assert_eq!(active_c.qualified_name, "chat.anthropic.opus");

        // (d) app.defaults.model fallback when no preferences and no legacy.
        let active_d =
            resolve_active_for_character(&loaded, dd, &g, &c, None, Some("kimi")).unwrap();
        assert_eq!(active_d.qualified_name, "chat.openrouter.kimi");

        // (e) First chat model is the final fallback.
        let active_e = resolve_active_for_character(&loaded, dd, &g, &c, None, None).unwrap();
        // BTreeMap iteration is lexicographic by qualified_name, so
        // "chat.anthropic.opus" comes first.
        assert_eq!(active_e.qualified_name, "chat.anthropic.opus");
    }

    #[test]
    fn resolve_active_finds_discovered_model_via_provider_cache() {
        // P1 regression coverage: a saved selection pointing at a
        // discovered-only model must restore through the discovery cache,
        // not silently fall through to the static default.
        use crate::llm::discovery::{
            cache_path, write_cache, DiscoveredModel, ProviderModelsCache, CACHE_VERSION,
        };
        use shore_common::config::providers::ProviderRegistry;

        let tmp = tempfile::tempdir().unwrap();
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let mut loaded = make_loaded_config(&tmp, catalog);
        let providers_table: toml::Table = r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
"#
        .parse()
        .unwrap();
        loaded.providers = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: "openrouter".into(),
            fetched_at: "2026-04-29T00:00:00Z".into(),
            base_url: Some("https://openrouter.ai/api/v1".into()),
            models: vec![DiscoveredModel {
                provider_key: "openrouter".into(),
                model_id: "anthropic/claude-sonnet-4.5".into(),
                display_name: None,
                sdk: "openai".into(),
                base_url: Some("https://openrouter.ai/api/v1".into()),
                created_at: None,
                owned_by: None,
                description: None,
                context_length: Some(200_000),
                max_output_tokens: Some(8192),
                supports_tools: None,
                supports_images: None,
                supports_reasoning: None,
                supports_prompt_cache: None,
                raw_provider_metadata: serde_json::Value::Null,
                discovered_at: "2026-04-29T00:00:00Z".into(),
            }],
        };
        write_cache(&cache_path(&loaded.dirs.cache, "openrouter"), &cache).unwrap();

        let g = ModelPreferences::default();
        let mut c = ModelPreferences::default();
        c.selected.provider = Some("openrouter".into());
        c.selected.model_id = Some("anthropic/claude-sonnet-4.5".into());

        let active = resolve_active_for_character(&loaded, tmp.path(), &g, &c, None, None).unwrap();
        assert_eq!(active.provider_key, "openrouter");
        assert_eq!(active.model_id, "anthropic/claude-sonnet-4.5");
        // Importantly: did NOT silently fall through to the static opus.
        assert_ne!(active.qualified_name, "chat.anthropic.opus");
    }

    #[test]
    fn resolve_active_rebuilds_selected_discovered_model_without_cache() {
        use shore_common::config::providers::ProviderRegistry;

        let tmp = tempfile::tempdir().unwrap();
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let mut loaded = make_loaded_config(&tmp, catalog);
        let providers_table: toml::Table = r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
"#
        .parse()
        .unwrap();
        loaded.providers = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let g = ModelPreferences::default();
        let mut c = ModelPreferences::default();
        c.selected.provider = Some("openrouter".into());
        c.selected.model_id = Some("anthropic/claude-sonnet-4.5".into());

        let active = resolve_active_for_character(&loaded, tmp.path(), &g, &c, None, None).unwrap();
        assert_eq!(active.provider_key, "openrouter");
        assert_eq!(active.model_id, "anthropic/claude-sonnet-4.5");
        assert_eq!(
            active.base_url.as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_ne!(active.qualified_name, "chat.anthropic.opus");
    }

    #[test]
    fn resolve_active_default_model_accepts_provider_prefixed_with_zero_statics() {
        // #139: with no `[chat.*]` catalog at all, `app.defaults.model` written
        // as `provider:model_id` must still resolve the active model through the
        // effective catalog's trusted path (transport from `[providers.*]`).
        use shore_common::config::providers::ProviderRegistry;

        let tmp = tempfile::tempdir().unwrap();
        let mut loaded =
            make_loaded_config(&tmp, shore_common::config::models::ModelCatalog::default());
        let providers_table: toml::Table = r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = false
"#
        .parse()
        .unwrap();
        loaded.providers = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let g = ModelPreferences::default();
        let c = ModelPreferences::default();
        // No preferences, no legacy state — only the `provider:model_id` default.
        let active = resolve_active_for_character(
            &loaded,
            tmp.path(),
            &g,
            &c,
            None,
            Some("openrouter:anthropic/claude-sonnet-4.5"),
        )
        .expect("provider:model_id default resolves with zero statics");
        assert_eq!(active.provider_key, "openrouter");
        assert_eq!(active.model_id, "anthropic/claude-sonnet-4.5");
        assert_eq!(
            active.qualified_name,
            "openrouter:anthropic/claude-sonnet-4.5"
        );
        assert_eq!(
            active.base_url.as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
    }

    #[test]
    fn apply_sampler_overlay_patches_resolved_model() {
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
temperature = 1.0
top_p = 0.9
max_output_tokens = 4096
"#,
        );
        let base = catalog.find_model("opus").unwrap();
        let overlay = SamplerSettings {
            temperature: Some(0.7),
            reasoning_effort: Some("high".into()),
            budget_tokens: Some(2048),
            cache_keepalive: Some(shore_common::config::models::CacheKeepaliveSetting::Off),
            ..Default::default()
        };
        let patched = apply_sampler_overlay(base, &overlay);
        assert_eq!(patched.temperature, Some(0.7), "overlaid");
        assert_eq!(patched.top_p, Some(0.9), "preserved from static");
        assert_eq!(
            patched.max_output_tokens,
            Some(4096),
            "preserved from static"
        );
        assert_eq!(patched.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(patched.budget_tokens, Some(2048));
        assert_eq!(
            patched.cache_keepalive,
            Some(shore_common::config::models::CacheKeepaliveSetting::Off),
            "overlaid keepalive wins over the sdk default"
        );
    }

    #[test]
    fn apply_sampler_overlay_patches_vendor_knobs() {
        // Per-model vendor knobs ride the same overlay onto the resolved model.
        let catalog = make_catalog(
            r#"
[chat.zai.glm]
model_id = "glm-4.6"
"#,
        );
        let base = catalog.find_model("glm").unwrap();
        // The Z.AI provider default seeds `zai_clear_thinking = false`; the
        // per-model overlay must win (model > sdk > provider).
        assert_eq!(base.zai_clear_thinking, Some(false));
        let overlay = SamplerSettings {
            zai_clear_thinking: Some(true),
            gemini_generation: Some(3),
            ..Default::default()
        };
        let patched = apply_sampler_overlay(base, &overlay);
        assert_eq!(
            patched.zai_clear_thinking,
            Some(true),
            "overlay overrides provider default"
        );
        assert_eq!(patched.gemini_generation, Some(3));
    }

    #[test]
    fn apply_sampler_overlay_stamps_replay_prior_thinking() {
        // #129: the per-model `replay_prior_thinking` override is carried
        // onto the resolved model by the overlay. The static catalog never
        // sets it (always None), so an unset overlay leaves it None — the
        // signal the request path uses to fall back to the global default.
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let base = catalog.find_model("opus").unwrap();
        assert_eq!(
            base.replay_prior_thinking, None,
            "static catalog carries no opinion"
        );

        let no_overlay = apply_sampler_overlay(base, &SamplerSettings::default());
        assert_eq!(
            no_overlay.replay_prior_thinking, None,
            "empty overlay → inherit global"
        );

        let overlay = SamplerSettings {
            replay_prior_thinking: Some(shore_common::config::app::ThinkingReplay::None),
            ..Default::default()
        };
        let patched = apply_sampler_overlay(base, &overlay);
        assert_eq!(
            patched.replay_prior_thinking,
            Some(shore_common::config::app::ThinkingReplay::None)
        );
    }

    #[test]
    fn resolve_sampler_settings_layers_replay_prior_thinking() {
        // Character-model override wins over the global default layer, and
        // the static catalog (layer 0) contributes nothing for this field.
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        );
        let base = catalog.find_model("opus").unwrap();

        let mut global = ModelPreferences::default();
        global.defaults.sampler.replay_prior_thinking =
            Some(shore_common::config::app::ThinkingReplay::All);

        let mut character = ModelPreferences::default();
        character.set_model(
            "anthropic",
            "claude-opus-4-6",
            ModelPreference {
                sampler: SamplerSettings {
                    replay_prior_thinking: Some(shore_common::config::app::ThinkingReplay::None),
                    ..Default::default()
                },
            },
        );

        let effective = resolve_sampler_settings(
            &global,
            Some(&character),
            "anthropic",
            "claude-opus-4-6",
            Some(base),
        );
        assert_eq!(
            effective.replay_prior_thinking,
            Some(shore_common::config::app::ThinkingReplay::None),
            "character per-model override beats global default"
        );

        let scopes = resolve_sampler_scopes(
            &global,
            Some(&character),
            "anthropic",
            "claude-opus-4-6",
            Some(base),
        );
        assert_eq!(
            scopes.replay_prior_thinking,
            Some(PreferenceScope::CharacterModel)
        );
    }

    #[test]
    fn apply_sampler_overlay_preserves_off_sentinel() {
        // The "off" disable sentinel is now PRESERVED on the resolved model
        // (issue #164): the request builder translates it into an explicit
        // `thinking_enabled = false` so the OpenRouter adapter can send
        // `reasoning.enabled = false` for always-on reasoning models.
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
reasoning_effort = "high"
"#,
        );
        let base = catalog.find_model("opus").unwrap();
        let overlay = SamplerSettings {
            reasoning_effort: Some("off".into()),
            ..Default::default()
        };
        let patched = apply_sampler_overlay(base, &overlay);
        assert_eq!(patched.reasoning_effort.as_deref(), Some("off"));
    }

    #[test]
    fn apply_sampler_overlay_patches_sdk() {
        // A user-set sdk override flips the resolved model's wire SDK
        // even though the static catalog had a different one.
        let catalog = make_catalog(
            r#"
[chat.openrouter.gpt-4o]
model_id = "gpt-4o"
sdk = "openai"
"#,
        );
        let base = catalog.find_model("gpt-4o").unwrap();
        assert_eq!(base.sdk, shore_common::config::models::Sdk::Openai);
        let overlay = SamplerSettings {
            sdk: Some("anthropic".into()),
            ..Default::default()
        };
        let patched = apply_sampler_overlay(base, &overlay);
        assert_eq!(patched.sdk, shore_common::config::models::Sdk::Anthropic);
    }

    #[test]
    fn resolve_sampler_settings_drops_invalid_persisted_sdk() {
        // A hand-edited models.toml with an unknown sdk string must not
        // surface through `model_settings` — `apply_sampler_overlay`
        // would silently discard it at request time, and the inspection
        // view should match. The catalog SDK wins instead.
        let catalog = make_catalog(
            r#"
[chat.openrouter.gpt-4o]
model_id = "gpt-4o"
sdk = "openai"
"#,
        );
        let base = catalog.find_model("gpt-4o").unwrap();

        let mut prefs = ModelPreferences::default();
        prefs.set_model(
            "openrouter",
            "gpt-4o",
            ModelPreference {
                sampler: SamplerSettings {
                    sdk: Some("not-a-real-sdk".into()),
                    ..Default::default()
                },
            },
        );

        let effective = resolve_sampler_settings(&prefs, None, "openrouter", "gpt-4o", Some(base));
        assert_eq!(
            effective.sdk.as_deref(),
            Some("openai"),
            "invalid persisted sdk must fall through to the catalog value"
        );

        let scopes = resolve_sampler_scopes(&prefs, None, "openrouter", "gpt-4o", Some(base));
        assert_eq!(
            scopes.sdk,
            Some(PreferenceScope::StaticDefault),
            "scope must not credit the corrupted layer that the request \
             path would silently discard"
        );
    }

    #[test]
    fn resolve_sampler_settings_treats_zero_max_tool_iterations_as_unset() {
        // `set_model_setting` rejects 0, but a hand-edited models.toml could
        // still carry `max_tool_iterations = 0`. Left intact the tool loops
        // would read it as "cap reached before the first round" — a silent
        // no-op. The load/sanitize path must coerce 0 back to None (unlimited).
        let mut prefs = ModelPreferences::default();
        prefs.set_model(
            "openrouter",
            "gpt-4o",
            ModelPreference {
                sampler: SamplerSettings {
                    max_tool_iterations: Some(0),
                    ..Default::default()
                },
            },
        );

        let effective = resolve_sampler_settings(&prefs, None, "openrouter", "gpt-4o", None);
        assert_eq!(
            effective.max_tool_iterations, None,
            "max_tool_iterations = 0 must sanitize to None (unlimited)"
        );

        let scopes = resolve_sampler_scopes(&prefs, None, "openrouter", "gpt-4o", None);
        assert_eq!(
            scopes.max_tool_iterations, None,
            "the sanitized-away zero must not be credited as a set scope"
        );
    }

    #[test]
    fn apply_sampler_overlay_ignores_unparseable_sdk() {
        // Defensive: a corrupted preferences edit that smuggled an
        // unknown sdk string in shouldn't crash — it should leave the
        // catalog's SDK in place.
        let catalog = make_catalog(
            r#"
[chat.openrouter.gpt-4o]
model_id = "gpt-4o"
sdk = "openai"
"#,
        );
        let base = catalog.find_model("gpt-4o").unwrap();
        let overlay = SamplerSettings {
            sdk: Some("not-a-real-sdk".into()),
            ..Default::default()
        };
        let patched = apply_sampler_overlay(base, &overlay);
        assert_eq!(patched.sdk, shore_common::config::models::Sdk::Openai);
    }

    #[test]
    fn apply_sampler_overlay_does_not_mutate_input() {
        let catalog = make_catalog(
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
temperature = 1.0
"#,
        );
        let base = catalog.find_model("opus").unwrap();
        let overlay = SamplerSettings {
            temperature: Some(0.5),
            ..Default::default()
        };
        let _patched = apply_sampler_overlay(base, &overlay);
        // Catalog's stored model is untouched.
        assert_eq!(catalog.find_model("opus").unwrap().temperature, Some(1.0));
    }

    #[test]
    fn resolve_sampler_scopes_reflects_top_layer() {
        let mut g = ModelPreferences::default();
        g.defaults.sampler.temperature = Some(0.1);
        g.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    top_p: Some(0.5),
                    ..Default::default()
                },
            },
        );

        let mut c = ModelPreferences::default();
        c.set_model(
            "anthropic",
            "opus",
            ModelPreference {
                sampler: SamplerSettings {
                    temperature: Some(0.7),
                    ..Default::default()
                },
            },
        );

        let scopes = resolve_sampler_scopes(&g, Some(&c), "anthropic", "opus", None);
        assert_eq!(scopes.temperature, Some(PreferenceScope::CharacterModel));
        assert_eq!(scopes.top_p, Some(PreferenceScope::GlobalModel));
        assert_eq!(scopes.max_output_tokens, None, "unset → None");
    }

    // ── Character flow helpers ───────────────────────────────────────

    #[test]
    fn load_for_character_returns_empty_when_neither_file_exists() {
        let tmp = TempDir::new().unwrap();
        let (g, c) = load_for_character(tmp.path(), "alice").unwrap();
        assert!(g.is_empty());
        assert!(c.is_empty());
    }

    #[test]
    fn save_character_preferences_then_load_for_character_round_trip() {
        let tmp = TempDir::new().unwrap();
        let mut prefs = ModelPreferences::default();
        prefs.selected.provider = Some("anthropic".into());
        prefs.selected.model_id = Some("claude-opus-4-6".into());
        save_character_preferences(tmp.path(), "alice", &prefs).unwrap();

        let (g, c) = load_for_character(tmp.path(), "alice").unwrap();
        assert!(g.is_empty(), "global untouched");
        assert_eq!(c.selected.provider.as_deref(), Some("anthropic"));
        assert_eq!(c.selected.model_id.as_deref(), Some("claude-opus-4-6"));
    }
}
