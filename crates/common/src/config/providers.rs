//! Top-level provider registry: `[providers.<name>]` config sections.
//!
//! The registry is a first-class concept that lets users configure a
//! provider once (sdk, base_url, ordered API keys, discovery) instead of
//! defining every model inline. This module is parse-only — request
//! resolution, key fallback, and discovery live in their respective
//! phases. Existing `[chat.<provider>.<model>]` static catalog entries
//! are unaffected and continue to work as before.
//!
//! Schema:
//!
//! ```toml
//! [providers.openrouter]
//! enabled = true
//! sdk = "openai"
//! base_url = "https://openrouter.ai/api/v1"
//!
//! [[providers.openrouter.keys]]
//! name = "budget"
//! env = "OPENROUTER_API_KEY_BUDGET"
//! warn_on_fallback = true
//!
//! [[providers.openrouter.keys]]
//! name = "overflow"
//! env = "OPENROUTER_API_KEY_OVERFLOW"
//!
//! [providers.openrouter.discovery]
//! enabled = true
//! ```
//!
//! Compact compatibility form (single key, no name):
//!
//! ```toml
//! [providers.openai]
//! api_key_env = "OPENAI_API_KEY"
//! ```
//!
//! When `api_key_env` is present, the registry synthesizes a single
//! `ProviderKeyEntry` named `"default"`. Combining `api_key_env` with an
//! explicit `[[keys]]` array is rejected — pick one form per provider.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::config::models::{ModelConfigFields, Sdk};

// ── Errors ──────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ProviderRegistryError {
    #[error("failed to parse [providers.{provider}]: {source}")]
    ParseEntry {
        provider: String,
        source: Box<toml::de::Error>,
    },

    #[error(
        "[providers.{provider}] declares both `api_key_env` and explicit `[[keys]]`; \
         use one form per provider"
    )]
    ConflictingKeyForms { provider: String },

    #[error("[providers.{provider}] key #{index} is missing `{field}`")]
    MissingKeyField {
        provider: String,
        index: usize,
        field: &'static str,
    },

    #[error(
        "[providers.{provider}] has duplicate key name {name:?}; \
         each key under a provider must have a unique name"
    )]
    DuplicateKeyName { provider: String, name: String },

    #[error(
        "[providers.claude_code] is no longer supported — the Claude Code transport \
         was removed; drop this section from your config"
    )]
    RemovedProvider,

    #[error(
        "[providers.{provider}.defaults] may not set transport key `{field}`; \
         set it on [providers.{provider}] directly"
    )]
    TransportInDefaults {
        provider: String,
        field: &'static str,
    },
}

// ── Discovery ───────────────────────────────────────────────────────────

/// `[providers.<name>.discovery]` sub-block.
///
/// Carries `enabled` (Phase 1) and `ignore` (Phase 6). Future
/// discovery knobs land in their own phases.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderDiscovery {
    /// Whether discovery is enabled for this provider.
    pub enabled: bool,

    /// Gitignore-style ignore patterns evaluated against an upstream
    /// model id (e.g. `"anthropic/claude-3.5-sonnet"`).
    ///
    /// Semantics:
    /// * Patterns are evaluated in order and the last match wins.
    /// * A bare pattern (no leading `!`) **hides** matched ids.
    /// * A pattern with leading `!` **un-hides** matched ids.
    /// * Models with no matching pattern stay visible (default-show).
    /// * Wildcards: `*` matches any sequence of characters within a single
    ///   id segment view (no special handling of `/`); patterns like
    ///   `meta-llama/*` and `*/free` work as written.
    ///
    /// Ignore rules only apply to discovered models; manual
    /// `[chat.<provider>.<...>]` entries are not affected.
    pub ignore: Vec<String>,
}

impl ProviderDiscovery {
    /// Whether `model_id` should be surfaced in normal model lists for
    /// this provider. Default-visible if `ignore` is empty.
    pub fn is_visible(&self, model_id: &str) -> bool {
        let mut visible = true;
        for pat in &self.ignore {
            let (negate, body) = match pat.strip_prefix('!') {
                Some(rest) => (true, rest),
                None => (false, pat.as_str()),
            };
            if glob_matches(body, model_id) {
                // Bare hides, `!` shows; last match wins.
                visible = negate;
            }
        }
        visible
    }
}

/// Tiny `*`-only glob matcher. `*` matches any (possibly empty) run of
/// characters, including `/`. Other characters match literally. Sufficient
/// for `meta-llama/*`, `*/free`, `anthropic/claude-3.5-*`, etc.
fn glob_matches(pattern: &str, s: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if let [only] = parts.as_slice() {
        return *only == s;
    }
    let Some(first) = parts.first() else {
        return s.is_empty();
    };
    let Some(last) = parts.last() else {
        return s.is_empty();
    };
    if !s.starts_with(first) || !s.ends_with(last) {
        return false;
    }
    let Some(edge_len) = first.len().checked_add(last.len()) else {
        return false;
    };
    if edge_len > s.len() {
        return false;
    }
    let mut cursor = first.len();
    let Some(end) = s.len().checked_sub(last.len()) else {
        return false;
    };
    let middle_end = parts.len().saturating_sub(1);
    let Some(middles) = parts.get(1..middle_end) else {
        return false;
    };
    for middle in middles {
        if middle.is_empty() {
            continue;
        }
        let Some(haystack) = s.get(cursor..end) else {
            return false;
        };
        match haystack.find(middle) {
            Some(idx) => {
                let Some(advance) = idx.checked_add(middle.len()) else {
                    return false;
                };
                let Some(next_cursor) = cursor.checked_add(advance) else {
                    return false;
                };
                cursor = next_cursor;
            }
            None => return false,
        }
    }
    true
}

// ── Per-key entry ───────────────────────────────────────────────────────

fn default_key_enabled() -> bool {
    true
}

/// One entry from `[[providers.<name>.keys]]`.
///
/// Resolved in configured order on every request (Phase 4). Disabled keys
/// are parsed and preserved but excluded from active credential resolution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderKeyEntry {
    /// Friendly key name surfaced in fallback warnings (e.g. `"budget"`).
    /// Must be unique within a provider.
    pub name: String,

    /// Env var that holds the actual API key value.
    pub env: String,

    /// Whether to consider this key when resolving credentials.
    #[serde(default = "default_key_enabled")]
    pub enabled: bool,

    /// If set, a fallback away from this key emits a visible client warning.
    /// Used to flag a "budget" key whose exhaustion is significant enough
    /// to surface to the user.
    #[serde(default)]
    pub warn_on_fallback: bool,
}

// ── Per-provider entry ──────────────────────────────────────────────────

fn default_provider_enabled() -> bool {
    true
}

/// One `[providers.<name>]` entry.
///
/// `enabled = false` parses but the provider is excluded from
/// runtime resolution (discovery, credential lookup, etc.). The plumbing
/// to honor this lands in Phases 4–5; Phase 1 only validates the schema.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProviderEntry {
    #[serde(default = "default_provider_enabled")]
    pub enabled: bool,

    /// Wire protocol (e.g. `"openai"`, `"anthropic"`). Optional here;
    /// downstream resolution can fall back to per-model SDK or the
    /// hardcoded `models::default_sdk(provider_key)`.
    #[serde(default)]
    pub sdk: Option<Sdk>,

    /// Base URL for the provider's HTTP API.
    #[serde(default)]
    pub base_url: Option<String>,

    /// Compact single-key form. Mutually exclusive with `keys`.
    /// Normalized into a synthetic `ProviderKeyEntry` named `"default"`.
    #[serde(default)]
    pub api_key_env: Option<String>,

    /// Ordered list of API keys to try (Phase 4 fallback order).
    /// Empty when only `api_key_env` is used or when the provider
    /// inherits credentials elsewhere.
    #[serde(default)]
    pub keys: Vec<ProviderKeyEntry>,

    #[serde(default)]
    pub discovery: ProviderDiscovery,

    /// `[providers.<name>.defaults]` — provider-wide behavioral and vendor
    /// defaults (e.g. `max_output_tokens`, `cache_ttl`, `openrouter_provider`,
    /// `vertex_*`, `gemini_*`, `zai_*`). This is the same field bag as the
    /// per-model overlay (`[models."provider:model_id"]`), applied provider-wide
    /// as the lowest user-config tier. Transport (`sdk`/`base_url`/credentials)
    /// belongs on the provider entry itself, not here — those keys are rejected
    /// (see `parse_entry`). Replaces the retired `[chat.<provider>]` scalars.
    #[serde(default)]
    pub defaults: ModelConfigFields,
}

impl Default for ProviderEntry {
    fn default() -> Self {
        Self {
            enabled: default_provider_enabled(),
            sdk: None,
            base_url: None,
            api_key_env: None,
            keys: Vec::new(),
            discovery: ProviderDiscovery::default(),
            defaults: ModelConfigFields::default(),
        }
    }
}

impl ProviderEntry {
    /// Iterate the provider's keys in configured order, including disabled ones.
    /// After parsing, this is the canonical key list (compact `api_key_env`
    /// has been folded in already).
    pub fn keys(&self) -> &[ProviderKeyEntry] {
        &self.keys
    }

    /// Iterate only the enabled keys, in configured order.
    pub fn enabled_keys(&self) -> impl Iterator<Item = &ProviderKeyEntry> {
        self.keys.iter().filter(|k| k.enabled)
    }
}

// ── Registry ────────────────────────────────────────────────────────────

/// Parsed `[providers]` section: provider key → entry.
///
/// Iteration order is the BTreeMap's lexicographic order over provider
/// names, which matches the existing model catalog's behavior.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProviderRegistry {
    providers: BTreeMap<String, ProviderEntry>,
}

impl ProviderRegistry {
    /// Build a registry from the raw `providers` section, if present.
    pub fn from_section(section: Option<&toml::Table>) -> Result<Self, ProviderRegistryError> {
        let Some(table) = section else {
            return Ok(Self::default());
        };

        let mut providers = BTreeMap::new();
        for (name, value) in table {
            if name == "claude_code" {
                return Err(ProviderRegistryError::RemovedProvider);
            }
            let entry = parse_entry(name, value.clone())?;
            let _ignored = providers.insert(name.clone(), entry);
        }
        Ok(Self { providers })
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    pub fn len(&self) -> usize {
        self.providers.len()
    }

    pub fn get(&self, provider_key: &str) -> Option<&ProviderEntry> {
        self.providers.get(provider_key)
    }

    /// Iterate `(provider_key, entry)` pairs in lexicographic order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &ProviderEntry)> {
        self.providers.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// Iterate only enabled providers.
    pub fn enabled(&self) -> impl Iterator<Item = (&str, &ProviderEntry)> {
        self.iter().filter(|(_, e)| e.enabled)
    }
}

// ── Parsing ─────────────────────────────────────────────────────────────

fn parse_entry(provider: &str, value: toml::Value) -> Result<ProviderEntry, ProviderRegistryError> {
    let mut entry: ProviderEntry =
        value
            .try_into()
            .map_err(|e| ProviderRegistryError::ParseEntry {
                provider: provider.to_owned(),
                source: Box::new(e),
            })?;

    // Transport lives on the provider entry itself, not under `[.defaults]`.
    // Reject it there so there is exactly one home for sdk/base_url/credentials
    // (and no silent second source once `[chat.*]` is gone).
    if let Some(field) = transport_field_in_defaults(&entry.defaults) {
        return Err(ProviderRegistryError::TransportInDefaults {
            provider: provider.to_owned(),
            field,
        });
    }

    // Reject the "both forms" case explicitly — silent precedence between
    // compact and named-key forms invites surprise. Pick one per provider.
    if entry.api_key_env.is_some() && !entry.keys.is_empty() {
        return Err(ProviderRegistryError::ConflictingKeyForms {
            provider: provider.to_owned(),
        });
    }

    // Validate explicit `[[keys]]` entries (name and env are non-empty,
    // names are unique within the provider).
    let mut seen = std::collections::HashSet::new();
    for (idx, key) in entry.keys.iter().enumerate() {
        if key.name.is_empty() {
            return Err(ProviderRegistryError::MissingKeyField {
                provider: provider.to_owned(),
                index: idx,
                field: "name",
            });
        }
        if key.env.is_empty() {
            return Err(ProviderRegistryError::MissingKeyField {
                provider: provider.to_owned(),
                index: idx,
                field: "env",
            });
        }
        if !seen.insert(key.name.clone()) {
            return Err(ProviderRegistryError::DuplicateKeyName {
                provider: provider.to_owned(),
                name: key.name.clone(),
            });
        }
    }

    // Fold compact `api_key_env` into a synthetic `default` key so
    // downstream consumers only ever see the named-key form.
    if let Some(env) = entry.api_key_env.take() {
        entry.keys.push(ProviderKeyEntry {
            name: "default".into(),
            env,
            enabled: true,
            warn_on_fallback: false,
        });
    }

    Ok(entry)
}

/// Returns the name of the first transport field set in a `[.defaults]` block,
/// if any. Transport (`sdk`/`base_url`/`api_key_env`) belongs on the provider
/// entry, not in its behavioral-defaults bag.
fn transport_field_in_defaults(defaults: &ModelConfigFields) -> Option<&'static str> {
    if defaults.sdk.is_some() {
        Some("sdk")
    } else if defaults.base_url.is_some() {
        Some("base_url")
    } else if defaults.api_key_env.is_some() {
        Some("api_key_env")
    } else {
        None
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_table(s: &str) -> toml::Table {
        s.parse::<toml::Table>().unwrap()
    }

    fn registry_from(s: &str) -> ProviderRegistry {
        let table = parse_table(s);
        let providers = table.get("providers").and_then(|v| v.as_table());
        ProviderRegistry::from_section(providers).unwrap()
    }

    fn key(keys: &[ProviderKeyEntry], index: usize) -> &ProviderKeyEntry {
        keys.get(index).expect("provider key should be present")
    }

    #[test]
    fn empty_section_yields_empty_registry() {
        let r = ProviderRegistry::from_section(None).unwrap();
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn full_named_key_form() {
        let r = registry_from(
            r#"
[providers.openrouter]
enabled = true
sdk = "openai"
base_url = "https://openrouter.ai/api/v1"

[[providers.openrouter.keys]]
name = "budget"
env = "OPENROUTER_API_KEY_BUDGET"
warn_on_fallback = true

[[providers.openrouter.keys]]
name = "overflow"
env = "OPENROUTER_API_KEY_OVERFLOW"

[providers.openrouter.discovery]
enabled = true
"#,
        );

        let or = r.get("openrouter").expect("openrouter present");
        assert!(or.enabled);
        assert_eq!(or.sdk, Some(Sdk::Openai));
        assert_eq!(or.base_url.as_deref(), Some("https://openrouter.ai/api/v1"));
        assert!(or.api_key_env.is_none(), "compact form folded");
        assert_eq!(or.keys.len(), 2);
        let budget = key(&or.keys, 0);
        assert_eq!(budget.name, "budget");
        assert_eq!(budget.env, "OPENROUTER_API_KEY_BUDGET");
        assert!(budget.enabled);
        assert!(budget.warn_on_fallback);
        let overflow = key(&or.keys, 1);
        assert_eq!(overflow.name, "overflow");
        assert_eq!(overflow.env, "OPENROUTER_API_KEY_OVERFLOW");
        assert!(!overflow.warn_on_fallback);
        assert!(or.discovery.enabled);
    }

    #[test]
    fn keys_preserve_configured_order() {
        let r = registry_from(
            r#"
[[providers.openrouter.keys]]
name = "first"
env = "A"

[[providers.openrouter.keys]]
name = "second"
env = "B"

[[providers.openrouter.keys]]
name = "third"
env = "C"
"#,
        );
        let names: Vec<&str> = r
            .get("openrouter")
            .unwrap()
            .keys()
            .iter()
            .map(|k| k.name.as_str())
            .collect();
        assert_eq!(names, vec!["first", "second", "third"]);
    }

    #[test]
    fn compact_api_key_env_form_synthesizes_default_key() {
        let r = registry_from(
            r#"
[providers.openai]
api_key_env = "OPENAI_API_KEY"
"#,
        );
        let p = r.get("openai").unwrap();
        assert!(p.enabled, "default enabled");
        assert!(p.api_key_env.is_none(), "compact form folded into keys[]");
        assert_eq!(p.keys.len(), 1);
        let default = key(&p.keys, 0);
        assert_eq!(default.name, "default");
        assert_eq!(default.env, "OPENAI_API_KEY");
        assert!(default.enabled);
        assert!(!default.warn_on_fallback);
    }

    #[test]
    fn provider_enabled_defaults_to_true() {
        let r = registry_from(
            r#"
[providers.openai]
api_key_env = "OPENAI_API_KEY"
"#,
        );
        assert!(r.get("openai").unwrap().enabled);
    }

    #[test]
    fn disabled_provider_parses_but_filtered_from_enabled() {
        let r = registry_from(
            r#"
[providers.disabled_provider]
enabled = false
api_key_env = "FOO"

[providers.active_provider]
api_key_env = "BAR"
"#,
        );
        assert_eq!(r.len(), 2, "disabled provider still in registry");
        let enabled_names: Vec<&str> = r.enabled().map(|(name, _)| name).collect();
        assert_eq!(enabled_names, vec!["active_provider"]);
    }

    #[test]
    fn disabled_keys_parsed_but_filtered_from_enabled_keys() {
        let r = registry_from(
            r#"
[[providers.openrouter.keys]]
name = "active"
env = "A"

[[providers.openrouter.keys]]
name = "off"
env = "B"
enabled = false

[[providers.openrouter.keys]]
name = "also_active"
env = "C"
"#,
        );
        let p = r.get("openrouter").unwrap();
        assert_eq!(p.keys().len(), 3, "disabled keys preserved");
        let enabled: Vec<&str> = p.enabled_keys().map(|k| k.name.as_str()).collect();
        assert_eq!(enabled, vec!["active", "also_active"]);
    }

    #[test]
    fn warn_on_fallback_defaults_to_false() {
        let r = registry_from(
            r#"
[[providers.openrouter.keys]]
name = "k"
env = "E"
"#,
        );
        let openrouter = r.get("openrouter").unwrap();
        assert!(!key(&openrouter.keys, 0).warn_on_fallback);
    }

    #[test]
    fn discovery_enabled_defaults_to_false() {
        let r = registry_from(
            r#"
[providers.openrouter]
api_key_env = "K"
"#,
        );
        assert!(!r.get("openrouter").unwrap().discovery.enabled);
    }

    #[test]
    fn rejects_both_compact_and_named_key_forms() {
        let table = parse_table(
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"

[[providers.openrouter.keys]]
name = "explicit"
env = "OTHER"
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        assert!(matches!(
            err,
            ProviderRegistryError::ConflictingKeyForms { ref provider }
                if provider == "openrouter"
        ));
    }

    #[test]
    fn parses_provider_defaults_block() {
        let table = parse_table(
            r#"
[providers.or-anthropic]
sdk = "anthropic"
api_key_env = "OR_KEY"

[providers.or-anthropic.defaults]
max_output_tokens = 8192
openrouter_provider = { order = ["Anthropic"] }
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let registry = ProviderRegistry::from_section(providers).unwrap();
        let entry = registry.get("or-anthropic").unwrap();
        assert_eq!(entry.defaults.max_output_tokens, Some(8192));
        assert!(entry.defaults.openrouter_provider.is_some());
        // Transport stays on the entry, not in defaults.
        assert_eq!(entry.sdk, Some(Sdk::Anthropic));
        assert!(entry.defaults.sdk.is_none());
    }

    #[test]
    fn rejects_transport_in_defaults() {
        let table = parse_table(
            r#"
[providers.acme]
[providers.acme.defaults]
base_url = "https://nope.example.com/v1"
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        assert!(matches!(
            err,
            ProviderRegistryError::TransportInDefaults { ref provider, field }
                if provider == "acme" && field == "base_url"
        ));
    }

    #[test]
    fn rejects_duplicate_key_names() {
        let table = parse_table(
            r#"
[[providers.openrouter.keys]]
name = "dup"
env = "A"

[[providers.openrouter.keys]]
name = "dup"
env = "B"
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        assert!(matches!(
            err,
            ProviderRegistryError::DuplicateKeyName { ref name, .. } if name == "dup"
        ));
    }

    #[test]
    fn rejects_key_with_missing_env() {
        // toml `name = "x"` without `env` triggers serde missing-field, which
        // surfaces as ParseEntry. (We don't reach the post-deserialize
        // empty-string branch in normal config — that catches programmatic
        // construction errors.)
        let table = parse_table(
            r#"
[[providers.openrouter.keys]]
name = "k"
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        assert!(
            matches!(err, ProviderRegistryError::ParseEntry { .. }),
            "expected parse error, got {err:?}"
        );
    }

    #[test]
    fn rejects_unknown_provider_field() {
        let table = parse_table(
            r#"
[providers.openrouter]
api_key_env = "K"
typo_field = true
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        let ProviderRegistryError::ParseEntry { source, .. } = err else {
            panic!("expected ParseEntry");
        };
        assert!(
            source.to_string().contains("unknown field"),
            "expected unknown-field error, got: {source}"
        );
    }

    #[test]
    fn rejects_unknown_key_field() {
        let table = parse_table(
            r#"
[[providers.openrouter.keys]]
name = "k"
env = "E"
typo = "bad"
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        let ProviderRegistryError::ParseEntry { source, .. } = err else {
            panic!("expected ParseEntry");
        };
        assert!(source.to_string().contains("unknown field"));
    }

    #[test]
    fn rejects_unknown_discovery_field() {
        let table = parse_table(
            r#"
[providers.openrouter]
api_key_env = "K"

[providers.openrouter.discovery]
enabled = true
typo_field = "oops"
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        let ProviderRegistryError::ParseEntry { source, .. } = err else {
            panic!("expected ParseEntry");
        };
        assert!(source.to_string().contains("unknown field"));
    }

    #[test]
    fn rejects_removed_claude_code_provider() {
        let table = parse_table(
            r#"
[providers.claude_code]
api_key_env = "K"
"#,
        );
        let providers = table.get("providers").and_then(|v| v.as_table());
        let err = ProviderRegistry::from_section(providers).unwrap_err();
        assert!(matches!(err, ProviderRegistryError::RemovedProvider));
    }

    #[test]
    fn ignore_defaults_to_empty() {
        let r = registry_from(
            r#"
[providers.openrouter]
api_key_env = "K"
"#,
        );
        assert!(r.get("openrouter").unwrap().discovery.ignore.is_empty());
    }

    #[test]
    fn glob_matcher_basics() {
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("*", ""));
        assert!(glob_matches("anthropic/*", "anthropic/claude-3.5-sonnet"));
        assert!(!glob_matches("anthropic/*", "openai/gpt-4o"));
        assert!(glob_matches("*/free", "x/free"));
        assert!(glob_matches("*/free", "meta-llama/free"));
        assert!(!glob_matches("*/free", "meta-llama/llama-3-free"));
        assert!(!glob_matches("*/free", "no-slash-here"));
        assert!(glob_matches("*free", "meta-llama/llama-3-free"));
        assert!(glob_matches("exact-id", "exact-id"));
        assert!(!glob_matches("exact-id", "other-id"));
        // Multi-wildcard
        assert!(glob_matches("a*b*c", "axxxbyyyc"));
        assert!(glob_matches("a*b*c", "abc"));
        assert!(!glob_matches("a*b*c", "axc"));
    }

    #[test]
    fn ignore_default_is_show_all() {
        let d = ProviderDiscovery::default();
        assert!(d.is_visible("anything"));
        assert!(d.is_visible("anthropic/claude"));
    }

    #[test]
    fn ignore_simple_hide() {
        let d = ProviderDiscovery {
            enabled: true,
            ignore: vec!["meta-llama/*".into()],
        };
        assert!(!d.is_visible("meta-llama/llama-3-405b"));
        assert!(d.is_visible("anthropic/claude-3.5-sonnet"));
    }

    #[test]
    fn ignore_show_only_some_via_star_then_negate() {
        // "*" hides everything, "!anthropic/*" reveals only Anthropic.
        let d = ProviderDiscovery {
            enabled: true,
            ignore: vec!["*".into(), "!anthropic/*".into()],
        };
        assert!(d.is_visible("anthropic/claude-3.5-sonnet"));
        assert!(!d.is_visible("openai/gpt-4o"));
        assert!(!d.is_visible("meta-llama/llama-3"));
    }

    #[test]
    fn ignore_last_match_wins() {
        // First pattern hides Anthropic, second un-hides one specific id.
        let d = ProviderDiscovery {
            enabled: true,
            ignore: vec!["anthropic/*".into(), "!anthropic/claude-3.5-sonnet".into()],
        };
        assert!(d.is_visible("anthropic/claude-3.5-sonnet"));
        assert!(!d.is_visible("anthropic/claude-3-haiku"));
    }

    #[test]
    fn ignore_negate_then_hide() {
        // Inverted: show all then hide a subset — hide wins because last.
        let d = ProviderDiscovery {
            enabled: true,
            ignore: vec!["!anthropic/*".into(), "anthropic/claude-3-haiku".into()],
        };
        assert!(d.is_visible("anthropic/claude-3.5-sonnet"));
        assert!(!d.is_visible("anthropic/claude-3-haiku"));
    }

    #[test]
    fn ignore_parses_gitignore_style_patterns() {
        let r = registry_from(
            r#"
[providers.openrouter]
api_key_env = "K"

[providers.openrouter.discovery]
enabled = true
ignore = [
  "*",
  "!anthropic/*",
  "!openai/*",
]
"#,
        );
        let v = &r.get("openrouter").unwrap().discovery.ignore;
        assert_eq!(v, &vec!["*", "!anthropic/*", "!openai/*"]);
    }

    #[test]
    fn multiple_providers_iterate_in_lexicographic_order() {
        let r = registry_from(
            r#"
[providers.openrouter]
api_key_env = "OR"

[providers.anthropic]
api_key_env = "ANTH"

[providers.gemini]
api_key_env = "GEM"
"#,
        );
        let names: Vec<&str> = r.iter().map(|(k, _)| k).collect();
        assert_eq!(names, vec!["anthropic", "gemini", "openrouter"]);
    }
}
