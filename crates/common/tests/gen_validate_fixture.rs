//! Fixture generator for the `parse_config_table` + `validate_config` port
//! (`crates/common/src/config/mod.rs`).
//!
//! Committed for the same reason as `gen_app_fixture.rs` and
//! `gen_dirs_fixture.rs`: this development environment is ephemeral, so an
//! uncommitted generator is a destroyed one. The fixture it writes is still
//! frozen — see the header it emits.
//!
//! Drives the real `shore_common::config::load_config` end to end and writes
//! `daemon/tests/config_fixtures/validate_parity.json`.
//!
//! Run with:
//!   cargo test -p shore-common --test gen_validate_fixture -- --ignored --nocapture

use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use shore_common::config::{load_config, ConfigError, LoadedConfig};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::prelude::*;
use tracing_subscriber::Layer;

// ── Warning capture ─────────────────────────────────────────────────────

/// `validate_config`'s warn-versus-reject split is its whole point, and five of
/// its six advisory paths do nothing *but* warn. Recorded through a `tracing`
/// layer rather than the `fmt` formatter, so the fixture holds the fields as
/// the code emitted them instead of one release's rendering of them.
///
/// The filter is `target == "shore_common::config"`, which is exactly `mod.rs`.
/// `models.rs` and `providers.rs` warn on this same load path — the `[chat.*]`
/// deprecation notice fires for most cases here — but those belong to their own
/// modules' parity fixtures, and folding them in would make this file fail
/// whenever an unrelated module changed its advice.
type Sink = Arc<Mutex<Vec<Value>>>;

#[derive(Debug)]
struct CaptureLayer(Sink);

#[derive(Debug, Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: Vec<(String, String)>,
}

impl FieldVisitor {
    fn put(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = Some(value);
        } else {
            self.fields.push((field.name().to_owned(), value));
        }
    }
}

impl Visit for FieldVisitor {
    // Every value `mod.rs` passes reaches the sink unquoted: `%x` records a
    // `DisplayValue` whose `Debug` forwards to `Display`, the message records
    // as `format_args!` output, and bare `&str` fields take `record_str`.
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.put(field, format!("{value:?}"));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.to_owned());
    }
}

impl<S: Subscriber> Layer<S> for CaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() != Level::WARN || meta.target() != "shore_common::config" {
            return;
        }
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let fields: Vec<Value> = visitor
            .fields
            .iter()
            .map(|(k, v)| json!([k, v]))
            .collect();
        self.0
            .lock()
            .expect("sink lock")
            .push(json!({ "message": visitor.message, "fields": fields }));
    }
}

// ── Cases ───────────────────────────────────────────────────────────────

/// The half of a successful load that `parse_config_table` and
/// `validate_config` decide.
///
/// `AppConfig`'s own deserialization is `app_parity.json`'s subject and is not
/// re-recorded here; what is recorded is what this layer adds on top — which
/// sections were lifted out of the table before `AppConfig` ever saw it, what
/// the catalog and registry were built from, and the `[defaults]` block *after*
/// `normalize_deprecated_aliases`, which runs between parse and validation.
fn ok_digest(loaded: &LoadedConfig) -> Value {
    let providers: Vec<Value> = loaded
        .providers
        .iter()
        .map(|(key, entry)| json!({ "key": key, "enabled": entry.enabled }))
        .collect();

    // `sdk` and `base_url` are the two fields the registry cascades into a
    // static `[chat.*]` entry, and they are the only visible proof that
    // `parse_config_table` handed the registry to the catalog builder at all.
    // The cascade itself is models_parity.json's subject; the wiring is this
    // file's, and nothing else here would notice it going missing.
    let chat: Vec<Value> = loaded
        .models
        .chat
        .iter()
        .map(|(key, model)| {
            json!({
                "name": key,
                "sdk": serde_json::to_value(&model.sdk).expect("serializes"),
                "base_url": model.base_url,
            })
        })
        .collect();

    json!({
        "chat": chat,
        "embedding": loaded.models.embedding.keys().collect::<Vec<_>>(),
        "image_generation": loaded.models.image_generation.keys().collect::<Vec<_>>(),
        "providers": providers,
        // Post-normalization, so `defaults.heartbeat` has already moved.
        "defaults": serde_json::to_value(&loaded.app.defaults).expect("serializes"),
        // The table kept for per-character merging is the pre-extraction one:
        // `chat`/`embedding`/`image_generation`/`providers` are still in it.
        "raw_table_keys": loaded
            .raw_table()
            .map(|t| t.keys().collect::<Vec<_>>()),
        "enabled_tools": &loaded.app.tools.enabled_tools,
        "enabled_subagents": &loaded.app.tools.enabled_subagents,
        "subagents": loaded.app.subagents.keys().collect::<Vec<_>>(),
        "mcp": loaded.app.mcp.keys().collect::<Vec<_>>(),
        "compaction_enabled": loaded.app.memory.compaction.enabled,
    })
}

/// The semantic half of a `ConfigError`.
///
/// `ParseApp` records the `toml` crate's `message()` rather than its `Display`
/// for the reason three earlier fixtures in this series already give: the
/// `Display` decorates the message with a line/caret frame whose shape is not
/// stable between otherwise identical failures.
fn err_digest(err: &ConfigError) -> Value {
    match err {
        ConfigError::ParseApp(source) => json!({ "kind": "parse_app", "message": source.message() }),
        ConfigError::ParseInclude { path: _, source } => {
            json!({ "kind": "parse_include", "message": source.message() })
        }
        ConfigError::ConfD { path: _, source } => {
            json!({ "kind": "conf_d", "message": source.message() })
        }
        ConfigError::ReadFile { path: _, source } => {
            json!({ "kind": "read_file", "message": source.to_string() })
        }
        ConfigError::Catalog(source) => json!({ "kind": "catalog", "message": source.to_string() }),
        ConfigError::ProviderRegistry(source) => {
            json!({ "kind": "provider_registry", "message": source.to_string() })
        }
        ConfigError::Validation(message) => json!({ "kind": "validation", "message": message }),
    }
}

/// Write `src` as `config.toml` in a fresh temp dir, load it, and record the
/// outcome plus every warning `mod.rs` emitted while doing so.
fn case(sink: &Sink, name: &str, src: &str) -> Value {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("config.toml");
    fs::write(&path, src).expect("write config.toml");

    sink.lock().expect("sink lock").clear();
    let result = load_config(Some(&path));
    let warnings = sink.lock().expect("sink lock").clone();

    let mut out = json!({ "name": name, "toml": src, "warnings": warnings });
    let obj = out.as_object_mut().expect("object");
    match &result {
        Ok(loaded) => drop(obj.insert("ok".to_owned(), ok_digest(loaded))),
        Err(err) => drop(obj.insert("err".to_owned(), err_digest(err))),
    }
    out
}

/// Every case, in the order they are replayed.
#[expect(
    clippy::too_many_lines,
    reason = "a flat list of parity cases; splitting it would only hide the coverage"
)]
fn cases(sink: &Sink) -> Vec<Value> {
    let mut out = Vec::new();
    let mut add = |name: &str, src: &str| out.push(case(sink, name, src));

    // ── Two-phase parse: which sections are lifted before AppConfig ─────

    add("empty config", "");

    add(
        "unified config",
        r#"
[daemon]
addr = "127.0.0.1:9999"
allowed_hosts = ["127.0.0.1"]

[behavior.autonomy]
enabled = true

[behavior.autonomy.heartbeat]
enabled = false
fallback_heartbeat_interval = "30m"

[tools]
enabled_tools = ["search_chat_logs", "read"]

[advanced]
max_retries = 5

[chat.anthropic.sonnet]
model_id = "claude-sonnet-4-6"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
    );

    add(
        "model sections are extracted, not unknown fields",
        r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[embedding."openai:text-embedding-3-large"]
dimensions = 1024

[image_generation."gemini:gemini-3.1-flash-image-preview"]
size = "1024x1024"
"#,
    );

    add(
        "providers section is extracted too",
        r#"
[providers.openai]
api_key_env = "OPENAI_API_KEY"

[providers.disabled_one]
enabled = false
api_key_env = "X"
"#,
    );

    // `[tools]` is deliberately NOT removed — it is the tool-surface section
    // of AppConfig. A port that copies the old four-section removal list
    // would silently drop the entire tool allowlist.
    add(
        "tools survives extraction alongside a chat section",
        r#"
[tools]
enabled_tools = ["read", "write"]

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
    );

    add(
        "unknown top-level section",
        r#"
[completely_unknown]
key = "value"
"#,
    );

    // The removal is unconditional but the *use* is `as_table()`, so a
    // non-table under one of the four names is lifted out and then silently
    // dropped rather than rejected. AppConfig never sees it either way.
    add("non-table chat is removed and ignored", r#"chat = "nope""#);

    add("non-table providers is removed and ignored", "providers = 1");

    add("non-table embedding is removed and ignored", "embedding = []");

    // Not in the removal list and not an AppConfig field. The `[chat.*]`
    // deprecation notice in models.rs points users at this exact spelling.
    add(
        "models section is neither extracted nor a field",
        r#"
[models."anthropic:claude-opus-4-6"]
temperature = 0.5
"#,
    );

    // AppConfig is deserialized before the registry is built, so its error
    // wins over a registry error in the same document.
    add(
        "app parse error precedes provider registry error",
        r#"
[completely_unknown]
key = "value"

[providers.claude_code]
api_key_env = "X"
"#,
    );

    add(
        "provider registry error precedes catalog error",
        r#"
[providers.claude_code]
api_key_env = "X"

[chat.claude_code.opus]
model_id = "x"
"#,
    );

    // A catalog failure on its own, so the error kind is not shadowed.
    add(
        "catalog error with no registry error",
        r"
[chat.anthropic.opus]
max_context_tokens = 1000
",
    );

    // `[[providers]]` builds an Array, not a Table, so `as_table()` yields
    // None and the whole registry is empty. Not a warning, not an error — the
    // providers the user wrote simply do not exist.
    add(
        "array-of-tables providers silently yields an empty registry",
        r#"
[[providers]]
api_key_env = "OPENAI_API_KEY"
"#,
    );

    // The registry cascades `sdk` and `base_url` into a static entry, which is
    // only visible if the catalog was built *with* the registry.
    add(
        "registry transport cascades into a static chat entry",
        r#"
[providers.custom]
sdk = "openai"
base_url = "https://example.invalid/v1"
api_key_env = "CUSTOM_KEY"

[chat.custom.house]
model_id = "house-7"
"#,
    );

    // ── defaults.* model refs: advisory, so they warn ───────────────────

    add(
        "unresolvable defaults.model warns",
        r#"
[defaults]
model = "nonexistent-model"
"#,
    );

    add(
        "resolvable defaults.model is silent",
        r#"
[defaults]
model = "opus"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
    );

    // The legacy alias is normalized *before* validation, so the field the
    // warning names is `defaults.background.heartbeat`, never the key the
    // user actually wrote.
    add(
        "legacy defaults.heartbeat warns under its normalized name",
        r#"
[defaults]
heartbeat = "ghost-haiku"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
    );

    add(
        "every defaults ref warns, in call order",
        r#"
[defaults]
model = "ghost-a"
subagent_model = "ghost-d"

[defaults.background]
model = "ghost-b"
heartbeat = "ghost-c"
compaction = "ghost-e"
"#,
    );

    add(
        "provider:model_id on an enabled provider resolves without discovery",
        r#"
[defaults]
model = "openrouter:anthropic/claude-opus-4.6"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"
"#,
    );

    add(
        "provider:model_id with discovery enabled",
        r#"
[defaults]
model = "openrouter:anthropic/claude-opus-4.6"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[providers.openrouter.discovery]
enabled = true
"#,
    );

    add(
        "provider:model_id in a background default",
        r#"
[defaults.background]
heartbeat = "openrouter:anthropic/claude-opus-4.6"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"
"#,
    );

    add(
        "provider:model_id on a disabled provider warns",
        r#"
[defaults]
model = "openrouter:anthropic/claude-opus-4.6"

[providers.openrouter]
enabled = false
api_key_env = "OPENROUTER_API_KEY"
"#,
    );

    add(
        "provider:model_id on an unregistered provider warns",
        r#"
[defaults]
model = "openroute:anthropic/claude-opus-4.6"
"#,
    );

    // An empty half is not `provider:model_id` form at all, so both fall
    // through to the generic warning rather than the provider-specific ones.
    add(
        "empty provider half falls through to the generic warning",
        r#"
[defaults]
model = ":claude-opus-4-6"
"#,
    );

    add(
        "empty model half falls through to the generic warning",
        r#"
[defaults]
model = "anthropic:"
"#,
    );

    // `split_once` takes the FIRST colon, so the model id keeps the rest.
    add(
        "multiple colons split at the first",
        r#"
[defaults]
model = "openrouter:anthropic:claude-opus-4.6"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"
"#,
    );

    // A static catalog hit short-circuits before the registry is consulted,
    // so a name that is also a catalog alias never warns.
    add(
        "catalog hit wins over provider parsing",
        r#"
[defaults]
model = "chat.anthropic.opus"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
    );

    // `Option<String>` distinguishes absent from empty: an empty string is
    // Some(""), so it is checked and warns rather than being skipped.
    add(
        "empty defaults.model is present, not absent",
        r#"
[defaults]
model = ""
"#,
    );

    // ── subagents ───────────────────────────────────────────────────────

    add(
        "enabled subagent with unresolvable model is rejected",
        r#"
[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
model = "ghost-model"
"#,
    );

    add(
        "enabled subagent resolving via defaults.model",
        r#"
[defaults]
model = "opus"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
"#,
    );

    add(
        "enabled subagent resolving via defaults.subagent_model",
        r#"
[defaults]
subagent_model = "opus"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
"#,
    );

    // The sub-agent's own model wins over both defaults, so a bad one is
    // rejected even when the fallbacks would have resolved.
    add(
        "subagent model shadows a resolvable default",
        r#"
[defaults]
model = "opus"
subagent_model = "opus"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
model = "ghost-model"
"#,
    );

    add(
        "enabled subagent with no model anywhere",
        r#"
[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
"#,
    );

    // The chain is `Option::or`, which falls through on None only. An empty
    // model string is Some(""), so it shadows a resolvable default and is
    // rejected — the fallback never runs.
    add(
        "empty subagent model does not fall through to defaults",
        r#"
[defaults]
model = "opus"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
model = ""
"#,
    );

    add(
        "disabled subagent with unresolvable model only warns",
        r#"
[subagents.researcher]
description = "Research helper"
prompt = "You research things."
model = "ghost-model"
"#,
    );

    // `defaults.subagent_model` sits between the sub-agent's own model and
    // `defaults.model`, so an unresolvable one is reached even when
    // `defaults.model` would have resolved.
    add(
        "subagent_model outranks defaults.model",
        r#"
[defaults]
model = "opus"
subagent_model = "ghost-sub"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
"#,
    );

    // `model_ref_resolves` has a second arm the warn-only paths never reach
    // through an enabled sub-agent: the `provider:model_id` trusted path.
    add(
        "enabled subagent resolving through an enabled provider",
        r#"
[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "R"
prompt = "r"
model = "openrouter:anthropic/claude-opus-4.6"
"#,
    );

    // Discovery off, provider enabled: still resolves (#136).
    add(
        "enabled subagent resolves with provider discovery off",
        r#"
[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[providers.openrouter.discovery]
enabled = false

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "R"
prompt = "r"
model = "openrouter:anthropic/claude-opus-4.6"
"#,
    );

    add(
        "enabled subagent on a disabled provider is rejected",
        r#"
[providers.openrouter]
enabled = false
api_key_env = "OPENROUTER_API_KEY"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "R"
prompt = "r"
model = "openrouter:anthropic/claude-opus-4.6"
"#,
    );

    add(
        "enabled subagent on an unregistered provider is rejected",
        r#"
[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "R"
prompt = "r"
model = "ghostprovider:some-model"
"#,
    );

    add(
        "enabled subagent with an empty provider half is rejected",
        r#"
[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "R"
prompt = "r"
model = ":anthropic/claude-opus-4.6"
"#,
    );

    // The empty *model* half is the half that matters: the provider before the
    // colon is real and enabled, so dropping the emptiness guard would let
    // `openrouter:` resolve. A trailing colon is an ordinary typo.
    add(
        "enabled subagent with an empty model half is rejected",
        r#"
[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "R"
prompt = "r"
model = "openrouter:"
"#,
    );

    // `subagents` is a BTreeMap, so the rejected one is the first in code
    // point order — not the first written.
    add(
        "two enabled bad subagents reject in map order",
        r#"
[tools]
enabled_subagents = ["zulu", "alpha"]

[subagents.zulu]
description = "Z"
prompt = "z"
model = "ghost-z"

[subagents.alpha]
description = "A"
prompt = "a"
model = "ghost-a"
"#,
    );

    // The enabled check is exact string equality, not the glob the tool
    // allowlist takes — `*` enables nothing here.
    add(
        "wildcard in enabled_subagents does not enable",
        r#"
[tools]
enabled_subagents = ["*"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
model = "ghost-model"
"#,
    );

    // A disabled sub-agent warns while an enabled one rejects; the loop is a
    // single pass, so the warning for `alpha` is emitted before `zulu` fails.
    add(
        "warn then reject within one subagent pass",
        r#"
[tools]
enabled_subagents = ["zulu"]

[subagents.alpha]
description = "A"
prompt = "a"
model = "ghost-a"

[subagents.zulu]
description = "Z"
prompt = "z"
model = "ghost-z"
"#,
    );

    // ── mcp ─────────────────────────────────────────────────────────────

    add(
        "mcp server with one transport",
        r#"
[mcp.hue]
command = "node"
"#,
    );

    add(
        "mcp server with both transports",
        r#"
[mcp.hue]
command = "node"
url = "http://x"
"#,
    );

    add(
        "mcp server with no transport",
        r#"
[mcp.hue]
args = ["--x"]
"#,
    );

    // The test is `is_some()`, not "non-empty". An empty command counts as a
    // transport and loads — a port that leaned on JavaScript truthiness would
    // reject this.
    add(
        "empty mcp command still counts as a transport",
        r#"
[mcp.hue]
command = ""
"#,
    );

    add(
        "empty mcp url alongside a command is still both",
        r#"
[mcp.hue]
command = "node"
url = ""
"#,
    );

    add(
        "two bad mcp servers reject in map order",
        r#"
[mcp.zulu]
command = "node"
url = "http://z"

[mcp.alpha]
args = []
"#,
    );

    add(
        "tool grant naming an undefined mcp server warns",
        r#"
[tools]
enabled_tools = ["mcp__hue__set_light"]
"#,
    );

    add(
        "tool grant naming a defined mcp server is silent",
        r#"
[tools]
enabled_tools = ["mcp__hue__set_light"]

[mcp.hue]
command = "node"
"#,
    );

    add(
        "mcp wildcard grant is silent",
        r#"
[tools]
enabled_tools = ["mcp__*"]
"#,
    );

    // `strip_prefix` leaves an empty rest, whose first `__` segment is empty.
    add(
        "bare mcp prefix is silent",
        r#"
[tools]
enabled_tools = ["mcp__"]
"#,
    );

    // No second `__`: the whole remainder is the server name.
    add(
        "mcp grant with no tool segment still names a server",
        r#"
[tools]
enabled_tools = ["mcp__hue"]
"#,
    );

    add(
        "subagent tool grants are checked too",
        r#"
[subagents.researcher]
description = "R"
prompt = "r"
tools = ["mcp__ghost__search"]
"#,
    );

    // The global allowlist is swept before the sub-agents' own grants, which
    // is only visible when both name a missing server.
    add(
        "global grants are swept before subagent grants",
        r#"
[tools]
enabled_tools = ["mcp__globalghost__x"]

[subagents.researcher]
description = "R"
prompt = "r"
tools = ["mcp__subghost__y"]
"#,
    );

    // The advisory sweep runs after the transport check, so a broken server
    // definition is reported and the grant warning never happens.
    add(
        "transport rejection precedes the grant sweep",
        r#"
[tools]
enabled_tools = ["mcp__ghost__search"]

[mcp.hue]
command = "node"
url = "http://x"
"#,
    );

    // ── defaults.embedding / defaults.image_generation ──────────────────

    add(
        "bare alias embedding default is rejected",
        r#"
[defaults]
embedding = "missing-profile"
"#,
    );

    add(
        "bundled local embedding id is rejected",
        r#"
[defaults]
embedding = "bge-large-en-v1.5"
"#,
    );

    add(
        "provider:model_id embedding default passes",
        r#"
[defaults]
embedding = "openai:text-embedding-3-large"

[providers.openai]
api_key_env = "OPENAI_API_KEY"
"#,
    );

    add(
        "embedding default on an unregistered provider only warns",
        r#"
[defaults]
embedding = "openai:text-embedding-3-large"
"#,
    );

    add(
        "embedding default on a disabled provider is rejected",
        r#"
[defaults]
embedding = "openai:text-embedding-3-large"

[providers.openai]
enabled = false
api_key_env = "OPENAI_API_KEY"
"#,
    );

    add(
        "embedding default with an empty provider half",
        r#"
[defaults]
embedding = ":text-embedding-3-large"
"#,
    );

    add(
        "embedding default with an empty model half",
        r#"
[defaults]
embedding = "openai:"
"#,
    );

    add(
        "bare alias image_generation default is rejected",
        r#"
[defaults]
image_generation = "missing-profile"
"#,
    );

    add(
        "image_generation default on a disabled provider is rejected",
        r#"
[defaults]
image_generation = "gemini:gemini-3.1-flash-image-preview"

[providers.gemini]
enabled = false
api_key_env = "GEMINI_API_KEY"
"#,
    );

    add(
        "image_generation default with an empty model half",
        r#"
[defaults]
image_generation = "gemini:"
"#,
    );

    // embedding is validated before image_generation.
    add(
        "both aux defaults bad reports embedding",
        r#"
[defaults]
embedding = "bad-a"
image_generation = "bad-b"
"#,
    );

    add(
        "all valid defaults",
        r#"
[defaults]
model = "opus"
heartbeat = "opus"
embedding = "openai:text-embedding-3-large"
image_generation = "gemini:gemini-3.1-flash-image-preview"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[providers.openai]
api_key_env = "OPENAI_API_KEY"

[providers.gemini]
api_key_env = "GEMINI_API_KEY"

[embedding."openai:text-embedding-3-large"]
dimensions = 1024

[image_generation."gemini:gemini-3.1-flash-image-preview"]
size = "1024x1024"
"#,
    );

    // ── usage ───────────────────────────────────────────────────────────

    add(
        "usage timezone utc",
        r#"
[usage]
timezone = "utc"
"#,
    );

    add(
        "usage timezone is case sensitive",
        r#"
[usage]
timezone = "UTC"
"#,
    );

    add(
        "usage timezone unknown",
        r#"
[usage]
timezone = "Europe/London"
"#,
    );

    add(
        "spike multiplier equal to one is rejected",
        r#"
[usage.spike_warnings]
multiplier = 1.0
"#,
    );

    add(
        "spike multiplier just above one passes",
        r#"
[usage.spike_warnings]
multiplier = 1.0001
"#,
    );

    add(
        "spike min_cost_usd negative is rejected",
        r#"
[usage.spike_warnings]
multiplier = 2.0
min_cost_usd = -0.01
"#,
    );

    add(
        "spike min_cost_usd zero passes",
        r#"
[usage.spike_warnings]
multiplier = 2.0
min_cost_usd = 0.0
"#,
    );

    // Every numeric guard here is a float comparison, and NaN fails all of
    // them — `nan <= 1.0` is false, so a NaN multiplier passes the "must be
    // greater than 1.0" check. Pinned because it is the kind of thing a port
    // "fixes" by accident.
    add(
        "NaN spike multiplier passes every guard",
        r"
[usage.spike_warnings]
multiplier = nan
min_cost_usd = nan
",
    );

    add(
        "infinite spike multiplier passes",
        r"
[usage.spike_warnings]
multiplier = inf
",
    );

    add(
        "negative infinite min_cost_usd is rejected",
        r"
[usage.spike_warnings]
multiplier = 2.0
min_cost_usd = -inf
",
    );

    add(
        "budget cost_usd zero is rejected",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 0.0
"#,
    );

    // Negative zero is `<= 0.0`, so it is rejected like any other zero.
    add(
        "budget cost_usd negative zero is rejected",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = -0.0
"#,
    );

    add(
        "NaN budget cost_usd passes",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = nan
warn_at = [nan]
"#,
    );

    add(
        "empty warn_at passes",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
warn_at = []
"#,
    );

    add(
        "budget warn_at zero is rejected",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
warn_at = [0.8, 0.0]
"#,
    );

    add(
        "budget warn_at above one is allowed",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
warn_at = [0.8, 1.5]
"#,
    );

    add(
        "reset_hour 24 is rejected",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
reset_hour = 24
"#,
    );

    // The field is unsigned, so an out-of-range low value is a parse error
    // rather than a validation one.
    add(
        "negative reset_hour is a parse error",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
reset_hour = -1
"#,
    );

    add(
        "reset_hour 23 passes",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
reset_hour = 23
"#,
    );

    add(
        "reset_hour on an hourly budget is rejected",
        r#"
[[usage.budgets]]
name = "hourly"
period = "hour"
cost_usd = 5.0
reset_hour = 6
"#,
    );

    // Range is checked before the period pairing, so 24 on an hourly budget
    // reports the range.
    add(
        "reset_hour range precedes the period check",
        r#"
[[usage.budgets]]
name = "hourly"
period = "hour"
cost_usd = 5.0
reset_hour = 24
"#,
    );

    add(
        "reset_day_of_week outside a weekly budget is rejected",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
reset_day_of_week = "thursday"
"#,
    );

    add(
        "reset_day_of_week on a weekly budget passes",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
reset_day_of_week = "thursday"
"#,
    );

    add(
        "unknown weekday is a parse error, not a validation error",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 10.0
reset_day_of_week = "funday"
"#,
    );

    add(
        "reset_day_of_month 0 is rejected",
        r#"
[[usage.budgets]]
name = "monthly"
period = "month"
cost_usd = 5.0
reset_day_of_month = 0
"#,
    );

    add(
        "reset_day_of_month 32 is rejected",
        r#"
[[usage.budgets]]
name = "monthly"
period = "month"
cost_usd = 5.0
reset_day_of_month = 32
"#,
    );

    add(
        "reset_day_of_month outside a monthly budget is rejected",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
reset_day_of_month = 15
"#,
    );

    add(
        "anchored month budget",
        r#"
[[usage.budgets]]
name = "monthly"
period = "month"
cost_usd = 5.0
reset_day_of_month = 15
reset_hour = 6
"#,
    );

    add(
        "pace shorter than the period passes",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
pace_period = "day"
"#,
    );

    add(
        "pace equal to the period is rejected",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
pace_period = "week"
"#,
    );

    add(
        "pace longer than the period is rejected",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
pace_period = "month"
"#,
    );

    add(
        "pace_action without pace_period is rejected",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
pace_action = "block"
"#,
    );

    add(
        "pace_warn_at without pace_period is rejected",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
pace_warn_at = [0.8]
"#,
    );

    // pace_action is checked before pace_warn_at when neither has a period.
    add(
        "pace_action precedes pace_warn_at",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
pace_action = "block"
pace_warn_at = [0.8]
"#,
    );

    add(
        "pace_warn_at non-positive is rejected",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
pace_period = "day"
pace_warn_at = [0.5, 0.0]
"#,
    );

    add(
        "empty pace_warn_at with a pace_period passes",
        r#"
[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 5.0
pace_period = "day"
pace_warn_at = []
"#,
    );

    // Anchors are validated before pace, so an anchored-and-paced budget with
    // both wrong reports the anchor.
    add(
        "anchor check precedes pace check",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0
reset_day_of_week = "thursday"
pace_period = "month"
"#,
    );

    add(
        "duplicate budget names",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0

[[usage.budgets]]
name = "daily"
period = "week"
cost_usd = 50.0
"#,
    );

    // A blank name becomes "budget <1-based index>", so two blanks at
    // different indexes do not collide.
    add(
        "two blank budget names do not collide",
        r#"
[[usage.budgets]]
period = "day"
cost_usd = 5.0

[[usage.budgets]]
period = "week"
cost_usd = 50.0
"#,
    );

    // But a literal "budget 1" collides with the blank at index 0.
    add(
        "explicit name collides with a blank name's placeholder",
        r#"
[[usage.budgets]]
period = "day"
cost_usd = 5.0

[[usage.budgets]]
name = "budget 1"
period = "week"
cost_usd = 50.0
"#,
    );

    // Names are trimmed before the uniqueness check.
    add(
        "budget names are trimmed before comparison",
        r#"
[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 5.0

[[usage.budgets]]
name = "  daily  "
period = "week"
cost_usd = 50.0
"#,
    );

    // Rust's `str::trim` takes the Unicode `White_Space` property, which does
    // NOT include U+FEFF. JavaScript's `String.prototype.trim` does strip it,
    // so a port that reached for the built-in would find a collision here that
    // the daemon does not.
    // Written as a TOML `\u` escape rather than a literal, so the case is
    // readable and cannot be destroyed by an editor normalizing the file.
    add(
        "a zero-width no-break space is not trimmed from a budget name",
        r#"
[[usage.budgets]]
name = "\uFEFFdaily"
period = "day"
cost_usd = 5.0

[[usage.budgets]]
name = "daily"
period = "week"
cost_usd = 50.0
"#,
    );

    // The mirror: U+0085 IS `White_Space` in Rust and is NOT stripped by
    // JavaScript's built-in, so this one collides for the daemon and would not
    // for a port using `.trim()`.
    add(
        "a next-line character is trimmed from a budget name",
        r#"
[[usage.budgets]]
name = "\u0085daily"
period = "day"
cost_usd = 5.0

[[usage.budgets]]
name = "daily"
period = "week"
cost_usd = 50.0
"#,
    );

    // A whitespace-only name is blank, so it takes the placeholder.
    add(
        "whitespace-only budget name is blank",
        r#"
[[usage.budgets]]
name = "   "
period = "day"
cost_usd = 5.0

[[usage.budgets]]
name = "budget 1"
period = "week"
cost_usd = 50.0
"#,
    );

    // Per-budget checks run to completion for budget 0 before budget 1 is
    // looked at, so the earlier index wins even for a different fault.
    add(
        "earlier budget index reports first",
        r#"
[[usage.budgets]]
name = "a"
period = "day"
cost_usd = 5.0
reset_hour = 99

[[usage.budgets]]
name = "b"
period = "day"
cost_usd = -1.0
"#,
    );

    // ── memory.compaction ───────────────────────────────────────────────

    add(
        "compaction min_turns not above keep_recent_turns",
        r"
[memory.compaction]
min_turns = 4
keep_recent_turns = 4
",
    );

    add(
        "disabled compaction skips turn validation",
        r"
[memory.compaction]
enabled = false
min_turns = 4
keep_recent_turns = 4
",
    );

    // Compaction is the last check, so a usage fault in the same document
    // wins over it.
    add(
        "usage check precedes compaction check",
        r#"
[usage]
timezone = "nope"

[memory.compaction]
min_turns = 4
keep_recent_turns = 4
"#,
    );

    // ── whole-function ordering ─────────────────────────────────────────

    // Everything is wrong at once. The reported fault pins the order of the
    // top-level checks: subagents, then mcp, then embedding, then
    // image_generation, then usage, then compaction.
    add(
        "every check fails at once",
        r#"
[defaults]
model = "ghost"
embedding = "bad-embed"
image_generation = "bad-image"

[tools]
enabled_subagents = ["researcher"]

[usage]
timezone = "nope"

[subagents.researcher]
description = "R"
prompt = "r"
model = "ghost-model"

[mcp.hue]
command = "node"
url = "http://x"

[memory.compaction]
min_turns = 4
keep_recent_turns = 4
"#,
    );

    // Same document with the sub-agent fixed: mcp is next.
    add(
        "mcp is next after subagents",
        r#"
[defaults]
embedding = "bad-embed"
image_generation = "bad-image"

[usage]
timezone = "nope"

[mcp.hue]
command = "node"
url = "http://x"

[memory.compaction]
min_turns = 4
keep_recent_turns = 4
"#,
    );

    // And with mcp fixed: embedding.
    add(
        "embedding is next after mcp",
        r#"
[defaults]
embedding = "bad-embed"
image_generation = "bad-image"

[usage]
timezone = "nope"

[memory.compaction]
min_turns = 4
keep_recent_turns = 4
"#,
    );

    // And with the aux defaults fixed: usage.
    add(
        "usage is next after the aux defaults",
        r#"
[usage]
timezone = "nope"

[memory.compaction]
min_turns = 4
keep_recent_turns = 4
"#,
    );

    // The advisory warnings all run *before* any hard check, so a document
    // that fails validation still emits them.
    add(
        "warnings are emitted before a rejection",
        r#"
[defaults]
model = "ghost-a"

[usage]
timezone = "nope"
"#,
    );

    out
}

// ── Fixture ─────────────────────────────────────────────────────────────

fn header() -> Value {
    json!([
        "Parity fixture for `parse_config_table` + `validate_config` — the",
        "assembly and cross-field validation half of",
        "crates/common/src/config/mod.rs.",
        "",
        "GENERATED from `main`. `shore-common` compiles at HEAD, so this pins",
        "current behaviour, the same provenance as app_parity.json,",
        "models_parity.json and dirs_parity.json.",
        "",
        "Driven through the real `shore_common::config::load_config`, so each",
        "case exercises the whole chain: raw table -> section extraction ->",
        "AppConfig -> deprecated-alias normalization -> ProviderRegistry ->",
        "ModelCatalog -> validate_config. Ports to the parse/validate half of",
        "daemon/src/config/loader.ts and validate.ts.",
        "",
        "The generator IS committed, at",
        "crates/common/tests/gen_validate_fixture.rs, on the reasoning recorded",
        "in 0b7b4261: development happens in ephemeral containers, so an",
        "uncommitted generator is a destroyed one.",
        "",
        "That does NOT make this file regenerable. It is FROZEN: nothing",
        "regenerates it. A later diff against it is a defect in the TypeScript,",
        "not a fixture that needs updating. Re-running the generator to make a",
        "red replay go green is the exact failure the freeze exists to stop.",
        "",
        "WARNINGS are recorded, not just errors. validate_config's whole job is",
        "deciding which bad reference blocks startup and which only warns, and",
        "five of its six advisory paths have no other observable effect — a port",
        "that dropped them would pass an outcome-only replay unchanged. Each",
        "entry holds the rendered message and the structured fields in emission",
        "order, captured from a `tracing` layer filtered to",
        "target == \"shore_common::config\". That filter is exactly mod.rs:",
        "models.rs and providers.rs also warn on this load path (the `[chat.*]`",
        "deprecation notice fires for most cases here) and belong to their own",
        "fixtures.",
        "",
        "`ok` records what THIS layer decides, not the whole parsed config:",
        "AppConfig's deserialization is app_parity.json's subject. What is here",
        "is which sections were lifted out of the table before AppConfig saw it,",
        "what the catalog and registry were built from, the raw table kept for",
        "per-character merging, and `[defaults]` AFTER normalization.",
        "",
        "Error messages are the semantic half only. A `toml` parse error's",
        "Display adds a line/caret frame whose shape is not stable between",
        "otherwise identical failures, so `message()` is recorded instead — the",
        "same cut app_parity.json, dirs_parity.json and models_parity.json make.",
        "",
        "ORDERING CASES ARE LOAD-BEARING. Roughly a dozen cases here are",
        "documents with more than one fault, and exist only to pin which fault",
        "is reported. They cover the top-level order (subagents, mcp, embedding,",
        "image_generation, usage, compaction), the per-budget order (cost,",
        "warn_at, anchors, pace, name), the anchor order (hour range before hour",
        "period), and the BTreeMap iteration that decides which of two bad",
        "sub-agents or two bad MCP servers is named. None of it is reachable",
        "from a single-fault case.",
    ])
}

#[test]
#[ignore = "fixture generator; run explicitly"]
fn generate() {
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    tracing_subscriber::registry()
        .with(CaptureLayer(Arc::clone(&sink)))
        .init();

    let fixture = json!({
        "_header": header(),
        "cases": cases(&sink),
    });

    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../daemon/tests/config_fixtures/validate_parity.json");
    fs::create_dir_all(out.parent().expect("has parent")).expect("mkdir");
    fs::write(
        &out,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&fixture).expect("json")
        ),
    )
    .expect("write fixture");
    println!("wrote {} ({} cases)", out.display(), {
        let Value::Object(map) = &fixture else {
            unreachable!()
        };
        map["cases"].as_array().expect("array").len()
    });
}
