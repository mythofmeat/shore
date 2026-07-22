// Panic-hygiene lock (see [workspace.lints] in root Cargo.toml): this crate is
// cleaned, so these can never regress. Tests are exempt via clippy.toml.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::todo,
    clippy::unimplemented,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::as_conversions,
    clippy::allow_attributes,
    clippy::allow_attributes_without_reason,
    clippy::unwrap_in_result,
    clippy::panic_in_result_fn,
    clippy::let_underscore_must_use,
    clippy::clone_on_ref_ptr,
    clippy::dbg_macro,
    clippy::exit,
    clippy::mem_forget,
    clippy::match_wildcard_for_single_variants,
    clippy::wildcard_enum_match_arm,
    clippy::wildcard_imports,
    clippy::unseparated_literal_suffix,
    clippy::single_char_lifetime_names,
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::modulo_arithmetic,
    clippy::float_arithmetic,
    clippy::indexing_slicing,
    clippy::string_slice,
    clippy::str_to_string,
    clippy::undocumented_unsafe_blocks,
    clippy::multiple_unsafe_ops_per_block,
    clippy::missing_assert_message,
    clippy::shadow_same,
    clippy::shadow_reuse,
    clippy::shadow_unrelated,
    clippy::else_if_without_else,
    clippy::impl_trait_in_params,
    unsafe_code,
    elided_lifetimes_in_paths,
    unused_qualifications
)]
#![deny(
    clippy::print_stdout,
    clippy::print_stderr,
    missing_debug_implementations,
    unreachable_pub
)]

pub mod app;
pub mod binaries;
pub mod capabilities;
pub mod cron;
pub mod duration;
pub mod models;
pub mod providers;

pub use duration::ConfigDuration;

use std::path::{Path, PathBuf};

use app::AppConfig;
use cron::CronSchedule;
use models::ModelCatalog;
use providers::ProviderRegistry;
use tracing::{info, warn};

/// Errors that can occur during configuration loading.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read {path}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("failed to parse config.toml: {0}")]
    ParseApp(#[source] toml::de::Error),

    #[error("failed to parse include file {path}: {source}")]
    ParseInclude {
        path: PathBuf,
        source: toml::de::Error,
    },

    #[error("failed to parse conf.d file {path}: {source}")]
    ConfD {
        path: PathBuf,
        source: toml::de::Error,
    },

    #[error("failed to parse model catalog: {0}")]
    Catalog(Box<models::CatalogError>),

    #[error("failed to parse provider registry: {0}")]
    ProviderRegistry(#[source] providers::ProviderRegistryError),

    #[error("validation error: {0}")]
    Validation(String),
}

impl From<models::CatalogError> for ConfigError {
    fn from(e: models::CatalogError) -> Self {
        ConfigError::Catalog(Box::new(e))
    }
}

impl From<providers::ProviderRegistryError> for ConfigError {
    fn from(e: providers::ProviderRegistryError) -> Self {
        ConfigError::ProviderRegistry(e)
    }
}

/// Resolved XDG directory paths for Shore.
#[derive(Debug, Clone)]
pub struct ShoreDirs {
    /// Config directory: $XDG_CONFIG_HOME/shore/
    pub config: PathBuf,
    /// Data directory: $XDG_DATA_HOME/shore/
    pub data: PathBuf,
    /// Runtime directory: $XDG_RUNTIME_DIR/shore/
    pub runtime: PathBuf,
    /// Cache directory: $XDG_CACHE_HOME/shore/
    pub cache: PathBuf,
}

/// Resolve an XDG-style directory path with Shore-specific overrides.
///
/// Precedence: `override_var` → `xdg_var`+"/shore" → `platform_fn()`+"/shore" → `fallback`+"/shore".
/// If `fallback` is empty, `std::env::temp_dir()` is used.
fn resolve_xdg_dir(
    override_var: &str,
    xdg_var: &str,
    platform_fn: fn() -> Option<PathBuf>,
    fallback: &str,
) -> PathBuf {
    std::env::var(override_var).ok().map_or_else(
        || {
            std::env::var(xdg_var)
                .ok()
                .map(PathBuf::from)
                .or_else(platform_fn)
                .unwrap_or_else(|| {
                    if fallback.is_empty() {
                        std::env::temp_dir()
                    } else {
                        PathBuf::from(fallback)
                    }
                })
                .join("shore")
        },
        PathBuf::from,
    )
}

impl ShoreDirs {
    /// Resolve Shore directories.
    ///
    /// Priority (highest first):
    /// 1. `SHORE_CONFIG_DIR` / `SHORE_DATA_DIR` / `SHORE_RUNTIME_DIR` /
    ///    `SHORE_CACHE_DIR` — used as-is
    /// 2. `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_RUNTIME_DIR` /
    ///    `XDG_CACHE_HOME` + `/shore`
    /// 3. Platform defaults + `/shore`
    pub fn resolve() -> Self {
        Self {
            config: resolve_xdg_dir(
                "SHORE_CONFIG_DIR",
                "XDG_CONFIG_HOME",
                dirs::config_dir,
                "~/.config",
            ),
            data: resolve_xdg_dir(
                "SHORE_DATA_DIR",
                "XDG_DATA_HOME",
                dirs::data_dir,
                "~/.local/share",
            ),
            runtime: resolve_xdg_dir(
                "SHORE_RUNTIME_DIR",
                "XDG_RUNTIME_DIR",
                dirs::runtime_dir,
                "",
            ),
            cache: resolve_xdg_dir(
                "SHORE_CACHE_DIR",
                "XDG_CACHE_HOME",
                dirs::cache_dir,
                "~/.cache",
            ),
        }
    }
}

/// Convenience: resolved Shore config directory.
pub fn config_dir() -> PathBuf {
    ShoreDirs::resolve().config
}

/// Convenience: resolved Shore data directory.
pub fn data_dir() -> PathBuf {
    ShoreDirs::resolve().data
}

/// Convenience: resolved Shore runtime directory.
pub fn runtime_dir() -> PathBuf {
    ShoreDirs::resolve().runtime
}

/// Fully loaded daemon configuration.
#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub app: AppConfig,
    pub models: ModelCatalog,
    pub providers: ProviderRegistry,
    pub dirs: ShoreDirs,
    /// Raw global TOML table (after include/conf.d merging, before model extraction).
    /// Preserved for per-character config merging.
    raw_table: Option<toml::Table>,
}

impl LoadedConfig {
    /// Construct a `LoadedConfig` programmatically (no include/conf.d merging).
    ///
    /// Primarily useful for tests and integration harnesses.
    pub fn new_for_test(app: AppConfig, models: ModelCatalog, dirs: ShoreDirs) -> Self {
        Self {
            app,
            models,
            providers: ProviderRegistry::default(),
            dirs,
            raw_table: None,
        }
    }

    /// Access the raw TOML table for per-character merging.
    pub fn raw_table(&self) -> Option<&toml::Table> {
        self.raw_table.as_ref()
    }
}

/// Raw Shore TOML after `include` and `conf.d/` merging.
///
/// This lets companion binaries parse only the sections they own without
/// coupling their startup to the daemon's complete config schema.
#[derive(Debug, Clone)]
pub struct RawConfigTable {
    pub table: toml::Table,
    pub dirs: ShoreDirs,
}

pub const CHARACTER_WORKSPACE_DIR: &str = "workspace";
pub const SOUL_FILE: &str = "SOUL.md";
pub const USER_FILE: &str = "USER.md";
pub const AGENTS_FILE: &str = "AGENTS.md";
pub const TOOLS_FILE: &str = "TOOLS.md";
pub const MEMORY_DIR: &str = "memory";

/// Filename of the per-character active conversation log under
/// `<data>/<character>/`. Newline-delimited JSON, one `Message` per line.
pub const ACTIVE_JSONL_FILE: &str = "active.jsonl";

/// Per-character archived-history directory under `<data>/<character>/`.
/// Holds segment JSONL files produced by compaction.
pub const SEGMENTS_DIR: &str = "segments";

/// Per-character compaction manifest under `<data>/<character>/`. Records
/// segment ordering, message counts, and timestamps.
pub const COMPACTION_MANIFEST_FILE: &str = "compaction.json";

/// Directory under `<data>/` holding locally installed MCP servers. Relative
/// `cwd`/`command` paths in `[mcp.*]` resolve against it, so a server config
/// need not hardcode an absolute install path.
pub const PLUGINS_DIR: &str = "plugins";

/// Return `<data_dir>/plugins/` — the root for relative `[mcp.*]` paths.
pub fn plugins_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(PLUGINS_DIR)
}

/// Return `characters/{name}/`.
pub fn character_config_dir(config_dir: &Path, character_name: &str) -> PathBuf {
    config_dir.join("characters").join(character_name)
}

/// Return `characters/{name}/workspace/`.
pub fn character_workspace_dir(config_dir: &Path, character_name: &str) -> PathBuf {
    character_config_dir(config_dir, character_name).join(CHARACTER_WORKSPACE_DIR)
}

/// Return `characters/{name}/workspace/{name}`.
pub fn character_workspace_file(config_dir: &Path, character_name: &str, name: &str) -> PathBuf {
    character_workspace_dir(config_dir, character_name).join(name)
}

/// Return `characters/{name}/workspace/memory/`.
pub fn character_memory_dir(config_dir: &Path, character_name: &str) -> PathBuf {
    character_workspace_dir(config_dir, character_name).join(MEMORY_DIR)
}

/// Return `<data_dir>/{character}/` — the daemon's per-character runtime
/// storage root. All daemon-managed files (active.jsonl, segments,
/// compaction.json, preferences, runtime_state.json, deferred edits,
/// dreams + heartbeat logs) live under this directory.
pub fn character_data_dir(data_dir: &Path, character_name: &str) -> PathBuf {
    data_dir.join(character_name)
}

/// Return `<data_dir>/{character}/active.jsonl`.
pub fn character_active_jsonl(data_dir: &Path, character_name: &str) -> PathBuf {
    character_data_dir(data_dir, character_name).join(ACTIVE_JSONL_FILE)
}

/// Return `<data_dir>/{character}/segments/`.
pub fn character_segments_dir(data_dir: &Path, character_name: &str) -> PathBuf {
    character_data_dir(data_dir, character_name).join(SEGMENTS_DIR)
}

/// Return `<data_dir>/{character}/compaction.json`.
pub fn character_compaction_manifest(data_dir: &Path, character_name: &str) -> PathBuf {
    character_data_dir(data_dir, character_name).join(COMPACTION_MANIFEST_FILE)
}

/// Load and validate daemon configuration.
///
/// Resolution order:
/// 1. If `config_path` is provided, load config.toml from there.
/// 2. Otherwise, load from `$XDG_CONFIG_HOME/shore/config.toml`.
/// 3. If the file doesn't exist, use defaults.
///
/// The config is parsed in two phases:
/// 1. Parse as raw `toml::Table`, process `include` and `conf.d/`.
/// 2. Extract model sections (`chat`, `tools`, `embedding`, `image_generation`),
///    then deserialize the remainder into `AppConfig` (preserving `deny_unknown_fields`).
pub fn load_config(config_path: Option<&Path>) -> Result<LoadedConfig, ConfigError> {
    let raw = load_raw_config_table(config_path)?;
    parse_config_table(raw.table, raw.dirs)
}

/// Load config files into a raw merged TOML table without deserializing the
/// daemon app schema.
///
/// This preserves Shore's file semantics (`config.toml`, `include`, `conf.d/`,
/// and config-local `.env`) while allowing callers to deserialize a narrow
/// section that belongs to them.
pub fn load_raw_config_table(config_path: Option<&Path>) -> Result<RawConfigTable, ConfigError> {
    let mut dirs = ShoreDirs::resolve();

    // Determine the config directory (either from --config path or XDG).
    let config_dir = match config_path {
        Some(p) => {
            let dir = p.parent().unwrap_or(Path::new(".")).to_path_buf();
            // When a custom config path is provided, use its parent as the
            // config directory so that character lookups etc. are relative to it.
            dirs.config.clone_from(&dir);
            dir
        }
        None => dirs.config.clone(),
    };

    let config_file = match config_path {
        Some(p) => p.to_path_buf(),
        None => config_dir.join("config.toml"),
    };

    // ── Load .env from config directory ───────────────────────────────
    let env_path = config_dir.join(".env");
    if env_path.exists() {
        match dotenvy::from_path_override(&env_path) {
            Ok(()) => info!(path = %env_path.display(), "Loaded .env file"),
            Err(e) => warn!(path = %env_path.display(), error = %e, "Failed to load .env file"),
        }
    }

    // ── Phase 1: Load raw TOML table ──────────────────────────────────
    let mut table: toml::Table = if config_file.exists() {
        let content = std::fs::read_to_string(&config_file).map_err(|e| ConfigError::ReadFile {
            path: config_file.clone(),
            source: e,
        })?;
        info!(path = %config_file.display(), "Loading config.toml");
        content
            .parse::<toml::Table>()
            .map_err(ConfigError::ParseApp)?
    } else {
        info!("No config.toml found, creating default config");
        create_default_config(&config_dir);
        toml::Table::new()
    };

    // ── Process `include = [...]` ─────────────────────────────────────
    if let Some(includes) = table.remove("include") {
        if let Some(arr) = includes.as_array() {
            for item in arr {
                if let Some(rel_path) = item.as_str() {
                    let include_path = config_dir.join(rel_path);
                    if include_path.exists() {
                        let content = std::fs::read_to_string(&include_path).map_err(|e| {
                            ConfigError::ReadFile {
                                path: include_path.clone(),
                                source: e,
                            }
                        })?;
                        let include_table: toml::Table =
                            content.parse().map_err(|e| ConfigError::ParseInclude {
                                path: include_path.clone(),
                                source: e,
                            })?;
                        info!(path = %include_path.display(), "Merging include file");
                        deep_merge(&mut table, &include_table);
                    } else {
                        warn!(path = %include_path.display(), "Include file not found, skipping");
                    }
                }
            }
        }
    }

    // ── Process conf.d/ ───────────────────────────────────────────────
    let conf_d = config_dir.join("conf.d");
    load_conf_d(&conf_d, &mut table)?;

    Ok(RawConfigTable { table, dirs })
}

/// Parse a merged TOML table into a `LoadedConfig`.
///
/// Extracts model sections (`chat`, `tools`, `embedding`, `image_generation`),
/// deserializes the remainder into `AppConfig`, builds `ModelCatalog`, validates.
fn parse_config_table(
    mut table: toml::Table,
    dirs: ShoreDirs,
) -> Result<LoadedConfig, ConfigError> {
    // Preserve the raw table for per-character merging.
    let raw_table = table.clone();

    let chat_section = table.remove("chat");
    let embedding_section = table.remove("embedding");
    let image_generation_section = table.remove("image_generation");
    let providers_section = table.remove("providers");
    // NB: `[tools]` is NO LONGER removed here — it is now the tool-surface
    // config section deserialized into `AppConfig::tools`. (The old
    // `[tools.*]` model catalog was removed.)

    // Deserialize the remaining table into AppConfig.
    let mut app: AppConfig = toml::Value::Table(table)
        .try_into()
        .map_err(ConfigError::ParseApp)?;

    // Forward legacy top-level `defaults.heartbeat` / `defaults.dreaming`
    // into `defaults.background.*` with a one-time deprecation warning.
    app.defaults.normalize_deprecated_aliases();

    // Build the provider registry first so the model catalog can
    // inherit registry-level transport defaults (sdk, base_url,
    // api_key_env) into static `[chat.<provider>]` entries.
    let providers =
        ProviderRegistry::from_section(providers_section.as_ref().and_then(|v| v.as_table()))?;

    let catalog = ModelCatalog::from_sections_with_providers(
        chat_section.as_ref().and_then(|v| v.as_table()),
        embedding_section.as_ref().and_then(|v| v.as_table()),
        image_generation_section.as_ref().and_then(|v| v.as_table()),
        Some(&providers),
    )?;

    validate_config(&app, &catalog, &providers)?;

    Ok(LoadedConfig {
        app,
        models: catalog,
        providers,
        dirs,
        raw_table: Some(raw_table),
    })
}

/// Load a per-character config overlay and deep-merge it over the global config.
///
/// Reads `{config_dir}/characters/{name}/config.toml`. If the file doesn't
/// exist, returns `Ok(None)`. If it does, deep-merges the character TOML
/// over the global raw table, then runs the full two-phase parse.
pub fn load_character_config(
    global: &LoadedConfig,
    character_name: &str,
) -> Result<Option<LoadedConfig>, ConfigError> {
    let config_dir = &global.dirs.config;
    let char_config_path = config_dir
        .join("characters")
        .join(character_name)
        .join("config.toml");

    if !char_config_path.exists() {
        return Ok(None);
    }

    let content =
        std::fs::read_to_string(&char_config_path).map_err(|e| ConfigError::ReadFile {
            path: char_config_path.clone(),
            source: e,
        })?;

    let char_table: toml::Table = content.parse().map_err(|e| ConfigError::ParseInclude {
        path: char_config_path.clone(),
        source: e,
    })?;

    info!(
        character = character_name,
        path = %char_config_path.display(),
        "Merging per-character config override"
    );

    // Clone the global raw table and deep-merge the character overlay.
    let base = global.raw_table.clone().unwrap_or_default();
    let mut merged = base;
    deep_merge(&mut merged, &char_table);

    parse_config_table(merged, global.dirs.clone()).map(Some)
}

/// Recursively deep-merge `overlay` into `base`.
///
/// For table values, recurse. For all other values, overlay overwrites base.
pub fn deep_merge(base: &mut toml::Table, overlay: &toml::Table) {
    for (key, overlay_val) in overlay {
        match (base.get_mut(key), overlay_val) {
            (Some(toml::Value::Table(base_sub)), toml::Value::Table(overlay_sub)) => {
                deep_merge(base_sub, overlay_sub);
            }
            _ => {
                let _ignored = base.insert(key.clone(), overlay_val.clone());
            }
        }
    }
}

/// Load and merge all `*.toml` files from a `conf.d/` directory, sorted alphabetically.
fn load_conf_d(dir: &Path, table: &mut toml::Table) -> Result<(), ConfigError> {
    // A missing directory is fine; any other read error (permissions, I/O)
    // must surface rather than silently loading an incomplete config.
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(ConfigError::ReadFile {
                path: dir.to_path_buf(),
                source: err,
            });
        }
    };

    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().is_some_and(|ext| ext == "toml") {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    paths.sort();

    for path in paths {
        let content = std::fs::read_to_string(&path).map_err(|e| ConfigError::ReadFile {
            path: path.clone(),
            source: e,
        })?;
        let overlay: toml::Table = content.parse().map_err(|e| ConfigError::ConfD {
            path: path.clone(),
            source: e,
        })?;
        info!(path = %path.display(), "Merging conf.d file");
        deep_merge(table, &overlay);
    }

    Ok(())
}

/// Write a starter config.toml with commented options.
fn create_default_config(config_dir: &Path) {
    if let Err(e) = std::fs::create_dir_all(config_dir) {
        warn!(error = %e, "Could not create config directory");
        return;
    }
    let content = r#"# Shore configuration
# See examples/config.toml for all available options.
#
# Characters are discovered from the characters/ directory.
# Create characters/<name>/workspace/SOUL.md to define a character.
#
# Models are referenced as `provider:model_id` against a [providers.*] entry.
# You can also use `include = ["extra.toml"]` or conf.d/*.toml for modular config.

# include = ["models.toml"]  # optional explicit includes

# [defaults]
# model = "anthropic:claude-sonnet-4-6"   # provider:model_id

# [providers.anthropic]
# api_key_env = "ANTHROPIC_API_KEY"
#
# [providers.anthropic.defaults]
# cache_ttl = "1h"

# [daemon]
# addr = "127.0.0.1:7320"
# unsafe_allow_remote_access = false  # required for non-loopback binds
# allowed_hosts = []                  # IP allowlist only; not auth/TLS
"#;
    let path = config_dir.join("config.toml");
    match std::fs::write(&path, content) {
        Ok(()) => info!(path = %path.display(), "Created default config.toml"),
        Err(e) => warn!(error = %e, "Could not write default config.toml"),
    }
}

/// Validate cross-field config constraints.
fn validate_config(
    app: &AppConfig,
    catalog: &ModelCatalog,
    providers: &ProviderRegistry,
) -> Result<(), ConfigError> {
    // Default-model references (chat) are advisory: an active model can be
    // chosen at runtime via per-character preferences and the runtime
    // resolver also accepts `provider:model_id` discovered IDs that the
    // static catalog doesn't know about. We emit a warning for refs we
    // can't resolve at config-load time, but don't block startup. Embedding
    // and image_generation stay strict — embedding swaps invalidate vector
    // stores, and image_generation profile shape is genuinely required.
    warn_on_unresolvable_model_ref(
        catalog,
        providers,
        "defaults.model",
        app.defaults.model.as_deref(),
    );
    warn_on_unresolvable_model_ref(
        catalog,
        providers,
        "defaults.background.model",
        app.defaults.background.model.as_deref(),
    );
    warn_on_unresolvable_model_ref(
        catalog,
        providers,
        "defaults.background.heartbeat",
        app.defaults.background.heartbeat.as_deref(),
    );
    warn_on_unresolvable_model_ref(
        catalog,
        providers,
        "defaults.background.compaction",
        app.defaults.background.compaction.as_deref(),
    );
    warn_on_unresolvable_model_ref(
        catalog,
        providers,
        "defaults.background.dreaming",
        app.defaults.background.dreaming.as_deref(),
    );
    warn_on_unresolvable_model_ref(
        catalog,
        providers,
        "defaults.subagent_model",
        app.defaults.subagent_model.as_deref(),
    );
    for (name, sub) in &app.subagents {
        if app.tools.enabled_subagents.iter().any(|s| s == name) {
            // An enabled sub-agent resolves its model via the
            // `subagents.<name>.model -> defaults.subagent_model -> defaults.model`
            // chain with no per-character runtime override, so an unresolvable
            // chain would surface only when `ask_<name>` is first called. Reject
            // it at load time instead of merely warning.
            let resolved = sub
                .model
                .as_deref()
                .or(app.defaults.subagent_model.as_deref())
                .or(app.defaults.model.as_deref());
            match resolved {
                Some(model) if model_ref_resolves(catalog, providers, model) => {}
                Some(model) => {
                    return Err(ConfigError::Validation(format!(
                        "subagents.{name} resolves to model \"{model}\", which is not \
                         in the static catalog and is not a `provider:model_id` ref to \
                         an enabled provider; ask_{name} would fail on first use"
                    )));
                }
                None => {
                    return Err(ConfigError::Validation(format!(
                        "subagents.{name} is enabled but resolves to no model; set \
                         subagents.{name}.model, defaults.subagent_model, or defaults.model"
                    )));
                }
            }
        } else {
            // Disabled sub-agents are never exposed, so an unresolvable model
            // is advisory only — mirror the default-ref warning above.
            warn_on_unresolvable_model_ref(
                catalog,
                providers,
                &format!("subagents.{name}.model"),
                sub.model.as_deref(),
            );
        }
    }
    validate_mcp_servers(app)?;
    validate_default_embedding(providers, app.defaults.embedding.as_deref())?;
    validate_default_image_generation(providers, app.defaults.image_generation.as_deref())?;

    validate_cron_schedule(&app.memory.dreaming.frequency)?;
    validate_usage_config(&app.usage)?;
    app.memory
        .compaction
        .validate()
        .map_err(ConfigError::Validation)?;

    Ok(())
}

/// Validate `[mcp.*]` server definitions: each must set exactly one transport
/// (`command` xor `url`). Also warns when an `enabled_tools` / `[subagents.*]`
/// pattern names an `mcp__<server>__*` server with no matching `[mcp.*]` entry,
/// which would silently grant nothing.
fn validate_mcp_servers(app: &AppConfig) -> Result<(), ConfigError> {
    for (name, server) in &app.mcp {
        match (server.command.is_some(), server.url.is_some()) {
            (true, false) | (false, true) => {}
            (true, true) => {
                return Err(ConfigError::Validation(format!(
                    "mcp.{name} sets both `command` and `url`; set exactly one transport"
                )));
            }
            (false, false) => {
                return Err(ConfigError::Validation(format!(
                    "mcp.{name} sets neither `command` nor `url`; set exactly one transport"
                )));
            }
        }
    }

    // Advisory: an `mcp__<server>__*` grant that names an undefined server.
    let referenced = app
        .tools
        .enabled_tools
        .iter()
        .chain(app.subagents.values().flat_map(|s| s.tools.iter()));
    for pattern in referenced {
        if let Some(rest) = pattern.strip_prefix("mcp__") {
            let server = rest.split("__").next().unwrap_or("");
            if !server.is_empty() && server != "*" && !app.mcp.contains_key(server) {
                warn!(
                    pattern = %pattern,
                    server = %server,
                    "tool grant references MCP server with no [mcp.{server}] definition; \
                     it will match no tools"
                );
            }
        }
    }
    Ok(())
}

fn validate_usage_config(config: &app::UsageConfig) -> Result<(), ConfigError> {
    match config.timezone.as_str() {
        "local" | "utc" => {}
        other => {
            return Err(ConfigError::Validation(format!(
                "usage.timezone must be \"local\" or \"utc\", got \"{other}\""
            )));
        }
    }

    if config.spike_warnings.multiplier <= 1.0 {
        return Err(ConfigError::Validation(
            "usage.spike_warnings.multiplier must be greater than 1.0".into(),
        ));
    }
    if config.spike_warnings.min_cost_usd < 0.0 {
        return Err(ConfigError::Validation(
            "usage.spike_warnings.min_cost_usd must be non-negative".into(),
        ));
    }

    let mut names = std::collections::HashSet::new();
    for (idx, budget) in config.budgets.iter().enumerate() {
        if budget.cost_usd <= 0.0 {
            return Err(ConfigError::Validation(format!(
                "usage.budgets[{idx}].cost_usd must be greater than 0"
            )));
        }
        for threshold in &budget.warn_at {
            if *threshold <= 0.0 {
                return Err(ConfigError::Validation(format!(
                    "usage.budgets[{idx}].warn_at values must be greater than 0"
                )));
            }
        }
        validate_budget_anchors(idx, budget)?;
        let name = if budget.name.trim().is_empty() {
            let display_index = idx.saturating_add(1);
            format!("budget {display_index}")
        } else {
            budget.name.trim().to_owned()
        };
        if !names.insert(name.clone()) {
            return Err(ConfigError::Validation(format!(
                "usage budget name \"{name}\" is duplicated"
            )));
        }
    }

    Ok(())
}

fn validate_budget_anchors(idx: usize, budget: &app::UsageBudgetConfig) -> Result<(), ConfigError> {
    use app::UsageBudgetPeriod;

    if let Some(hour) = budget.reset_hour {
        if hour > 23 {
            return Err(ConfigError::Validation(format!(
                "usage.budgets[{idx}].reset_hour must be 0-23, got {hour}"
            )));
        }
        if matches!(budget.period, UsageBudgetPeriod::Hour) {
            return Err(ConfigError::Validation(format!(
                "usage.budgets[{idx}].reset_hour is not valid for period = \"hour\""
            )));
        }
    }

    if budget.reset_day_of_week.is_some() && !matches!(budget.period, UsageBudgetPeriod::Week) {
        return Err(ConfigError::Validation(format!(
            "usage.budgets[{idx}].reset_day_of_week is only valid for period = \"week\""
        )));
    }

    if let Some(day) = budget.reset_day_of_month {
        if !(1..=31).contains(&day) {
            return Err(ConfigError::Validation(format!(
                "usage.budgets[{idx}].reset_day_of_month must be 1-31, got {day}"
            )));
        }
        if !matches!(budget.period, UsageBudgetPeriod::Month) {
            return Err(ConfigError::Validation(format!(
                "usage.budgets[{idx}].reset_day_of_month is only valid for period = \"month\""
            )));
        }
    }

    Ok(())
}

/// Validate the `provider_key` of an aux (`embedding` / `image_generation`)
/// `provider:model_id` ref against the registry.
///
/// A **disabled** provider is a hard error: it yields zero key candidates, so
/// the aux resolver (`resolve_embedder` / `resolve_image_gen_config`) can never
/// succeed — failing here keeps config load in lockstep with runtime instead of
/// passing validation and then dying at resolve time. Unlike chat refs (which
/// `warn_on_unresolvable_model_ref` only warns on, since per-character
/// preferences can override at runtime), these globals have no such override.
///
/// An **absent** provider is advisory (warn only): well-known keys resolve via
/// built-in transport defaults + the default env var, and the credential check
/// happens at runtime.
fn validate_aux_provider(
    providers: &ProviderRegistry,
    field: &str,
    provider_key: &str,
) -> Result<(), ConfigError> {
    match providers.get(provider_key) {
        Some(entry) if !entry.enabled => Err(ConfigError::Validation(format!(
            "{field} references provider \"{provider_key}\" which is disabled in \
             [providers.{provider_key}] (enabled = false); a disabled provider yields no \
             credentials, so {field} cannot resolve. Enable the provider or change {field}."
        ))),
        Some(_) => Ok(()),
        None => {
            warn!(
                field,
                provider = provider_key,
                "{field} references provider \"{provider_key}\" not configured under \
                 [providers.{provider_key}]; built-in transport defaults are used for \
                 well-known providers, otherwise set base_url/api_key_env there"
            );
            Ok(())
        }
    }
}

/// Validate `defaults.embedding`: must be a `provider:model_id` identity.
/// Shore only ships an OpenAI-compatible (hosted) embedder; there is no
/// runtime local embedder, so bundled ids are not accepted here — that kept
/// config validation in lockstep with `resolve_embedder`. The optional
/// `[embedding."provider:model_id"]` settings table is not required for the
/// default to be valid; transport resolves through `[providers.<provider>]`.
fn validate_default_embedding(
    providers: &ProviderRegistry,
    name_opt: Option<&str>,
) -> Result<(), ConfigError> {
    let Some(name) = name_opt else { return Ok(()) };
    let Some((provider_key, model_id)) = name.split_once(':') else {
        return Err(ConfigError::Validation(format!(
            "defaults.embedding \"{name}\" must be a `provider:model_id` identity \
             (transport lives on [providers.<provider>]); Shore ships only a hosted \
             OpenAI-compatible embedder, so bundled local ids are not served"
        )));
    };
    if provider_key.is_empty() || model_id.is_empty() {
        return Err(ConfigError::Validation(format!(
            "defaults.embedding \"{name}\" is not a valid `provider:model_id` identity"
        )));
    }
    validate_aux_provider(providers, "defaults.embedding", provider_key)
}

/// Validate `defaults.image_generation`: must be a `provider:model_id` identity
/// (transport lives on `[providers.<provider>]`). There is no bundled fallback.
fn validate_default_image_generation(
    providers: &ProviderRegistry,
    name_opt: Option<&str>,
) -> Result<(), ConfigError> {
    let Some(name) = name_opt else { return Ok(()) };
    let Some((provider_key, model_id)) = name.split_once(':') else {
        return Err(ConfigError::Validation(format!(
            "defaults.image_generation \"{name}\" must be a `provider:model_id` identity \
             (transport lives on [providers.<provider>])"
        )));
    };
    if provider_key.is_empty() || model_id.is_empty() {
        return Err(ConfigError::Validation(format!(
            "defaults.image_generation \"{name}\" is not a valid `provider:model_id` identity"
        )));
    }
    validate_aux_provider(providers, "defaults.image_generation", provider_key)
}

fn validate_cron_schedule(expr: &str) -> Result<(), ConfigError> {
    let _ignored = CronSchedule::parse(expr).map_err(|e| {
        ConfigError::Validation(format!(
            "memory.dreaming.frequency must be a valid five-field cron expression \
             (minute hour day-of-month month day-of-week), got {expr:?}: {e}"
        ))
    })?;
    Ok(())
}

/// Emit a warning if an optional default-model reference can't be reconciled
/// with the static catalog or the provider registry's discovery surface.
///
/// Resolves successfully (no warning) for:
/// - names present in the static `[chat.*]` / `[tools.*]` catalog; or
/// - `provider:model_id` syntax where the provider exists and is **enabled**.
///   Discovery need not be on: an enabled provider resolves a fully-qualified
///   ref via the trusted path even with discovery off (#136), so the
///   trusted-path override suppresses the warning regardless. The actual
///   lookup is the runtime resolver's job
///   (`backend/daemon/src/effective_catalog.rs`).
///
/// All other shapes (a disabled provider, an unregistered provider, or a
/// non-`provider:model_id` name absent from the catalog) log a `warn!` and
/// return — the daemon still loads, because per-character preferences can
/// override these defaults at runtime.
/// Whether a model reference resolves against the static catalog or an enabled
/// provider's trusted path — the non-warning cases of
/// [`warn_on_unresolvable_model_ref`]. Used to hard-reject enabled sub-agents
/// whose model chain cannot resolve.
fn model_ref_resolves(catalog: &ModelCatalog, providers: &ProviderRegistry, name: &str) -> bool {
    if catalog.find_model(name).is_ok() {
        return true;
    }
    if let Some((provider_key, model_id)) = name.split_once(':') {
        if !provider_key.is_empty() && !model_id.is_empty() {
            return matches!(providers.get(provider_key), Some(entry) if entry.enabled);
        }
    }
    false
}

fn warn_on_unresolvable_model_ref(
    catalog: &ModelCatalog,
    providers: &ProviderRegistry,
    field: &str,
    name_opt: Option<&str>,
) {
    let Some(name) = name_opt else { return };

    if catalog.find_model(name).is_ok() {
        return;
    }

    if let Some((provider_key, model_id)) = name.split_once(':') {
        if !provider_key.is_empty() && !model_id.is_empty() {
            match providers.get(provider_key) {
                // An enabled provider resolves a fully-qualified
                // `provider:model_id` ref via the trusted path even with
                // discovery off (#136) — no warning regardless of discovery.
                Some(entry) if entry.enabled => return,
                Some(_) => {
                    warn!(
                        field,
                        name,
                        provider = provider_key,
                        "configured default model references a disabled provider; \
                         a disabled provider is unreferenceable, but per-character \
                         preferences can override at runtime"
                    );
                    return;
                }
                None => {
                    warn!(
                        field,
                        name,
                        provider = provider_key,
                        "configured default model references provider \
                         \"{provider_key}\" which is not configured under \
                         [providers.{provider_key}]"
                    );
                    return;
                }
            }
        }
    }

    warn!(
        field,
        name,
        "configured default model \"{name}\" was not found in the static \
         catalog and is not in provider:model_id form; the daemon will \
         attempt runtime resolution and per-character preferences can \
         override this without editing config"
    );
}

/// Load character definition from `characters/{name}/workspace/SOUL.md`,
/// with a legacy fallback to `character.md`.
pub fn load_character_definition(config_dir: &Path, character_name: &str) -> Option<String> {
    let new_path = character_workspace_file(config_dir, character_name, SOUL_FILE);
    if let Ok(content) = std::fs::read_to_string(&new_path) {
        info!(character = character_name, path = %new_path.display(), "Loaded character definition");
        return Some(content);
    }

    let legacy_path = character_config_dir(config_dir, character_name).join("character.md");
    if let Ok(content) = std::fs::read_to_string(&legacy_path) {
        info!(character = character_name, path = %legacy_path.display(), "Loaded legacy character definition");
        Some(content)
    } else {
        warn!(
            character = character_name,
            path = %new_path.display(),
            "No character definition found"
        );
        None
    }
}

/// Resolve user definition from `characters/{name}/workspace/USER.md`, with a
/// legacy fallback to `characters/{name}/user.md`.
pub fn resolve_user_definition(config_dir: &Path, character_name: &str) -> Option<String> {
    let workspace_user = character_workspace_file(config_dir, character_name, USER_FILE);
    if let Ok(content) = std::fs::read_to_string(&workspace_user) {
        info!(
            character = character_name,
            "Using character-specific user definition"
        );
        return Some(content);
    }

    let legacy_user = character_config_dir(config_dir, character_name).join("user.md");
    if let Ok(content) = std::fs::read_to_string(&legacy_user) {
        info!(
            character = character_name,
            "Using legacy character-specific user definition"
        );
        return Some(content);
    }

    None
}

/// Discover available characters by scanning `characters/` directory.
///
/// Returns the names of all subdirectories under `{config_dir}/characters/`
/// that contain either `workspace/SOUL.md` or the legacy `character.md`.
pub fn discover_characters(config_dir: &Path) -> Vec<String> {
    let chars_dir = config_dir.join("characters");
    let Ok(entries) = std::fs::read_dir(&chars_dir) else {
        return vec![];
    };

    let mut names = Vec::new();
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry
                .path()
                .join(CHARACTER_WORKSPACE_DIR)
                .join(SOUL_FILE)
                .exists()
                || entry.path().join("character.md").exists()
            {
                names.push(name);
            }
        }
    }
    names.sort();
    names
}

/// Resolve a prompt template: character-specific → global → None.
///
/// Returns the template content if found, or None if no override exists
/// (caller should fall back to built-in default).
pub fn resolve_prompt_template(
    config_dir: &Path,
    character_name: &str,
    template_name: &str,
) -> Option<String> {
    // 1. Character-specific prompt override.
    let char_prompt = config_dir
        .join("characters")
        .join(character_name)
        .join("prompts")
        .join(template_name);
    if let Ok(content) = std::fs::read_to_string(&char_prompt) {
        return Some(content);
    }

    // 2. Global prompt.
    let global_prompt = config_dir.join("prompts").join(template_name);
    if let Ok(content) = std::fs::read_to_string(&global_prompt) {
        return Some(content);
    }

    // 3. Caller provides built-in default.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_value<'val>(table: &'val toml::Table, key: &str) -> &'val toml::Value {
        table.get(key).expect("table key should be present")
    }

    fn provider_key(
        keys: &[providers::ProviderKeyEntry],
        index: usize,
    ) -> &providers::ProviderKeyEntry {
        keys.get(index).expect("provider key should be present")
    }

    /// Helper: create a temp config directory with given files.
    fn setup_config_dir(files: &[(&str, &str)]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for (path, content) in files {
            let full_path = tmp.path().join(path);
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&full_path, content).unwrap();
        }
        tmp
    }

    #[test]
    fn load_unified_config() {
        let tmp = setup_config_dir(&[(
            "config.toml",
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
        )]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();

        assert_eq!(loaded.app.daemon.addr, "127.0.0.1:9999");
        assert_eq!(loaded.app.daemon.allowed_hosts, vec!["127.0.0.1"]);
        assert!(loaded.app.behavior.autonomy.enabled);
        assert!(!loaded.app.behavior.autonomy.heartbeat.enabled);
        assert_eq!(
            loaded
                .app
                .behavior
                .autonomy
                .heartbeat
                .fallback_heartbeat_interval,
            ConfigDuration::from_secs(1800)
        );
        assert!(!loaded.app.tools.tool_enabled("roll_dice"));
        assert!(loaded.app.tools.tool_enabled("search_chat_logs"));
        assert_eq!(loaded.app.advanced.max_retries, Some(5));
        assert!(!loaded.app.daemon.unsafe_allow_remote_access);

        assert_eq!(loaded.models.chat.len(), 2);
        assert!(loaded.models.find_model("sonnet").is_ok());
        assert!(loaded.models.find_model("opus").is_ok());
    }

    #[test]
    fn missing_optional_fields_get_defaults() {
        let tmp = setup_config_dir(&[("config.toml", "")]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();

        // All defaults should be filled in.
        assert!(loaded.app.defaults.stream);
        assert!(loaded.app.defaults.dreaming.is_none());
        assert!(!loaded.app.behavior.autonomy.enabled);
        assert!(loaded.app.behavior.autonomy.heartbeat.enabled);
        assert_eq!(
            loaded
                .app
                .behavior
                .autonomy
                .heartbeat
                .fallback_heartbeat_interval,
            ConfigDuration::from_secs(3600)
        );
        assert!(!loaded.app.tools.any_enabled());
        assert!(loaded.app.memory.compaction.enabled);
        assert!(!loaded.app.memory.dreaming.enabled);
        assert_eq!(loaded.app.memory.dreaming.frequency, "0 3 * * *");
        assert_eq!(loaded.app.daemon.addr, "127.0.0.1:7320"); // default
        assert!(!loaded.app.daemon.unsafe_allow_remote_access);
        assert!(loaded.app.advanced.editor.is_none());
        assert!(loaded.app.advanced.max_retries.is_none());
        assert!(loaded.app.advanced.retry_backoff.is_none());
    }

    #[test]
    fn invalid_dreaming_frequency_fails_validation() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[memory.dreaming]
frequency = "sometimes"
"#,
        )]);

        let config_path = tmp.path().join("config.toml");
        let err = load_config(Some(&config_path)).unwrap_err();
        assert!(
            err.to_string().contains("memory.dreaming.frequency"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn weekly_dreaming_frequency_passes_validation() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[memory.dreaming]
frequency = "0 6 * * 1"
"#,
        )]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        assert_eq!(loaded.app.memory.dreaming.frequency, "0 6 * * 1");
    }

    #[test]
    fn compaction_turns_not_above_keep_recent_fails_validation() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r"
[memory.compaction]
min_turns = 4
keep_recent_turns = 4
",
        )]);

        let config_path = tmp.path().join("config.toml");
        let err = load_config(Some(&config_path)).unwrap_err();
        assert!(
            err.to_string().contains("memory.compaction.min_turns"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn disabled_compaction_skips_turn_validation() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r"
[memory.compaction]
enabled = false
min_turns = 4
keep_recent_turns = 4
",
        )]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        assert!(!loaded.app.memory.compaction.enabled);
    }

    #[test]
    fn invalid_config_produces_clear_error_unknown_section() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[completely_unknown]
key = "value"
"#,
        )]);

        let config_path = tmp.path().join("config.toml");
        let err = load_config(Some(&config_path)).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("unknown field"),
            "Error should mention unknown field: {msg}"
        );
    }

    #[test]
    fn model_sections_dont_trigger_unknown_field_errors() {
        // This is the key two-phase parse test: model sections are extracted
        // before AppConfig deserialization, so they don't cause errors.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[embedding."openai:text-embedding-3-large"]
dimensions = 1024

[image_generation."gemini:gemini-3.1-flash-image-preview"]
size = "1024x1024"
"#,
        )]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        assert!(loaded.models.find_model("opus").is_ok());
        assert!(loaded
            .models
            .embedding
            .contains_key("openai:text-embedding-3-large"));
        assert!(loaded
            .models
            .image_generation
            .contains_key("gemini:gemini-3.1-flash-image-preview"));
    }

    #[test]
    fn unresolvable_default_model_warns_but_loads() {
        // defaults.model is advisory: per-character preferences and the
        // runtime resolver can supply a working model without restart, so a
        // bad ref must not block daemon startup.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
model = "nonexistent-model"
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("unresolvable defaults.model should warn, not fail");
    }

    #[test]
    fn unresolvable_default_heartbeat_warns_but_loads() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
heartbeat = "ghost-haiku"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("unresolvable heartbeat default should warn, not fail");
    }

    #[test]
    fn unresolvable_default_dreaming_warns_but_loads() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
dreaming = "no-such-model"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("unresolvable dreaming default should warn, not fail");
    }

    #[test]
    fn enabled_subagent_with_unresolvable_model_chain_fails() {
        // An enabled sub-agent has no per-character runtime override for its
        // model, so an unresolvable chain must be rejected at load instead of
        // surfacing on first `ask_<name>` use.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[tools]
enabled_subagents = ["researcher"]

[subagents.researcher]
description = "Research helper"
prompt = "You research things."
model = "ghost-model"
"#,
        )]);
        let err = load_config(Some(&tmp.path().join("config.toml")))
            .expect_err("enabled sub-agent with unresolvable model should fail to load");
        assert!(
            err.to_string().contains("subagents.researcher"),
            "error should name the offending sub-agent: {err}"
        );
    }

    #[test]
    fn enabled_subagent_resolving_via_defaults_passes() {
        // The model chain falls back to defaults.model; a resolvable fallback
        // is enough even when the sub-agent sets no model of its own.
        let tmp = setup_config_dir(&[(
            "config.toml",
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
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("sub-agent resolving via defaults.model should load");
    }

    #[test]
    fn disabled_subagent_with_unresolvable_model_warns_but_loads() {
        // A sub-agent that is defined but not enabled is never exposed, so a
        // bad model ref is advisory only.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[subagents.researcher]
description = "Research helper"
prompt = "You research things."
model = "ghost-model"
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("disabled sub-agent with unresolvable model should warn, not fail");
    }

    #[test]
    fn discovered_model_id_passes_validation() {
        // provider:model_id form should validate when the provider is
        // configured and discovery is enabled, even if the model isn't in
        // the static [chat.*] catalog. Cache lookup happens at runtime.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
model = "openrouter:anthropic/claude-opus-4.6"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[providers.openrouter.discovery]
enabled = true
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("discovered model id should validate when provider+discovery enabled");
    }

    #[test]
    fn discovered_model_id_in_background_default_passes_validation() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults.background]
heartbeat = "openrouter:anthropic/claude-opus-4.6"

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[providers.openrouter.discovery]
enabled = true
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("discovered model id in background heartbeat should validate");
    }

    #[test]
    fn discovered_model_id_with_unknown_provider_warns_but_loads() {
        // Typo in the provider key (openroute vs openrouter): we want a
        // warning, not a hard failure, since the user can correct it via
        // preferences or fix the file without the daemon refusing to start.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
model = "openroute:anthropic/claude-opus-4.6"
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("unknown provider key should warn, not fail");
    }

    #[test]
    fn invalid_default_embedding_reference() {
        // A bare alias (no colon, not a bundled local id) is rejected: the
        // default must be a `provider:model_id` identity or a bundled id.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
embedding = "missing-profile"
"#,
        )]);
        let err = load_config(Some(&tmp.path().join("config.toml"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("defaults.embedding"), "{msg}");
        assert!(msg.contains("missing-profile"), "{msg}");
    }

    #[test]
    fn provider_model_id_embedding_default_passes() {
        // A `provider:model_id` default validates without a settings overlay;
        // transport resolves through [providers.<provider>] at runtime.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
embedding = "openai:text-embedding-3-large"

[providers.openai]
api_key_env = "OPENAI_API_KEY"
"#,
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml")))
            .expect("provider:model_id embedding default should validate");
    }

    #[test]
    fn embedding_default_on_disabled_provider_is_rejected() {
        // A disabled provider yields no credentials, so the embedder can never
        // resolve — config load must fail rather than drift from runtime.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
embedding = "openai:text-embedding-3-large"

[providers.openai]
enabled = false
api_key_env = "OPENAI_API_KEY"
"#,
        )]);
        let err = load_config(Some(&tmp.path().join("config.toml"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("defaults.embedding"), "{msg}");
        assert!(msg.contains("disabled"), "{msg}");
    }

    #[test]
    fn image_generation_default_on_disabled_provider_is_rejected() {
        // Mirror of the embedding case for the second `validate_aux_provider`
        // call site and its field-specific error text.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
image_generation = "gemini:gemini-3.1-flash-image-preview"

[providers.gemini]
enabled = false
api_key_env = "GEMINI_API_KEY"
"#,
        )]);
        let err = load_config(Some(&tmp.path().join("config.toml"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("defaults.image_generation"), "{msg}");
        assert!(msg.contains("disabled"), "{msg}");
    }

    #[test]
    fn bundled_local_embedding_id_is_rejected() {
        // There is no runtime local embedder — a bundled id can never serve
        // embeddings, so it must fail config load (matching `resolve_embedder`)
        // rather than silently validate and degrade to lexical at runtime.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
embedding = "bge-large-en-v1.5"
"#,
        )]);
        let err = load_config(Some(&tmp.path().join("config.toml"))).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("defaults.embedding"), "{msg}");
        assert!(msg.contains("provider:model_id"), "{msg}");
    }

    #[test]
    fn invalid_default_image_generation_reference() {
        // A bare alias (no colon) is rejected: image_generation must be a
        // `provider:model_id` identity.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
image_generation = "missing-profile"
"#,
        )]);
        let err = load_config(Some(&tmp.path().join("config.toml"))).unwrap_err();
        assert!(err.to_string().contains("defaults.image_generation"));
    }

    #[test]
    fn valid_defaults_pass_validation() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[defaults]
model = "opus"
heartbeat = "opus"
dreaming = "opus"
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
        )]);
        let _ignored = load_config(Some(&tmp.path().join("config.toml"))).unwrap();
    }

    #[test]
    fn no_config_files_uses_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        assert_eq!(loaded.app, AppConfig::default());
        assert!(loaded.models.chat.is_empty());
    }

    // ── Include tests ─────────────────────────────────────────────────

    #[test]
    fn include_files_merged() {
        let tmp = setup_config_dir(&[
            (
                "config.toml",
                r#"
include = ["models.toml"]

[defaults]
model = "opus"
"#,
            ),
            (
                "models.toml",
                r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
            ),
        ]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        assert!(loaded.models.find_model("opus").is_ok());
    }

    #[test]
    fn missing_include_file_is_warning_not_error() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
include = ["nonexistent.toml"]
"#,
        )]);

        let config_path = tmp.path().join("config.toml");
        // Should succeed — missing include is a warning, not an error.
        let loaded = load_config(Some(&config_path)).unwrap();
        assert!(loaded.models.chat.is_empty());
    }

    // ── conf.d tests ──────────────────────────────────────────────────

    #[test]
    fn conf_d_files_merged_alphabetically() {
        let tmp = setup_config_dir(&[
            ("config.toml", ""),
            (
                "conf.d/01-chat.toml",
                r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
            ),
            (
                "conf.d/02-more.toml",
                r#"
[chat.openrouter.mistral]
model_id = "mistralai/mistral-small"
"#,
            ),
        ]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        assert!(loaded.models.find_model("opus").is_ok());
        assert!(loaded.models.find_model("mistral").is_ok());
    }

    #[test]
    fn conf_d_overrides_base_config() {
        let tmp = setup_config_dir(&[
            (
                "config.toml",
                r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
api_key_env = "BASE_KEY"
"#,
            ),
            (
                "conf.d/override.toml",
                r#"
[chat.anthropic.opus]
api_key_env = "OVERRIDE_KEY"
"#,
            ),
        ]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        let opus = loaded.models.find_model("opus").unwrap();
        assert_eq!(opus.api_key_env.as_deref(), Some("OVERRIDE_KEY"));
    }

    #[test]
    fn conf_d_nonexistent_dir_is_fine() {
        let tmp = setup_config_dir(&[("config.toml", "")]);
        // No conf.d/ directory — should not error.
        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        assert!(loaded.models.chat.is_empty());
    }

    #[test]
    fn merge_order_conf_d_over_include_over_base() {
        let tmp = setup_config_dir(&[
            (
                "config.toml",
                r#"
include = ["include.toml"]

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
temperature = 0.1
"#,
            ),
            (
                "include.toml",
                r"
[chat.anthropic.opus]
temperature = 0.5
",
            ),
            (
                "conf.d/final.toml",
                r"
[chat.anthropic.opus]
temperature = 0.9
",
            ),
        ]);

        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path)).unwrap();
        let opus = loaded.models.find_model("opus").unwrap();
        // conf.d overrides include which overrides base.
        assert_eq!(opus.temperature, Some(0.9));
    }

    // ── Deep merge ────────────────────────────────────────────────────

    #[test]
    fn deep_merge_scalars_overwritten() {
        let mut base = r#"key = "a""#.parse::<toml::Table>().unwrap();
        let overlay = r#"key = "b""#.parse::<toml::Table>().unwrap();
        deep_merge(&mut base, &overlay);
        assert_eq!(table_value(&base, "key").as_str(), Some("b"));
    }

    #[test]
    fn deep_merge_tables_recursive() {
        let mut base = r"
[section]
a = 1
b = 2
"
        .parse::<toml::Table>()
        .unwrap();

        let overlay = r"
[section]
b = 3
c = 4
"
        .parse::<toml::Table>()
        .unwrap();

        deep_merge(&mut base, &overlay);
        let section = table_value(&base, "section").as_table().unwrap();
        assert_eq!(table_value(section, "a").as_integer(), Some(1)); // preserved
        assert_eq!(table_value(section, "b").as_integer(), Some(3)); // overwritten
        assert_eq!(table_value(section, "c").as_integer(), Some(4)); // added
    }

    // ── Character / prompt tests ──────────────────────────────────────

    #[test]
    fn character_definition_loaded() {
        let tmp = setup_config_dir(&[(
            "characters/TestChar/workspace/SOUL.md",
            "You are TestChar, a helpful assistant.",
        )]);

        let def = load_character_definition(tmp.path(), "TestChar");
        assert_eq!(
            def.as_deref(),
            Some("You are TestChar, a helpful assistant.")
        );
    }

    #[test]
    fn user_definition_character_specific_overrides_global() {
        let tmp = setup_config_dir(&[(
            "characters/TestChar/workspace/USER.md",
            "Character-specific user definition",
        )]);

        let def = resolve_user_definition(tmp.path(), "TestChar");
        assert_eq!(def.as_deref(), Some("Character-specific user definition"));
    }

    #[test]
    fn user_definition_uses_legacy_character_file() {
        let tmp = setup_config_dir(&[(
            "characters/TestChar/user.md",
            "Legacy character-specific user definition",
        )]);

        let def = resolve_user_definition(tmp.path(), "TestChar");
        assert_eq!(
            def.as_deref(),
            Some("Legacy character-specific user definition")
        );
    }

    #[test]
    fn discover_characters_finds_valid_chars() {
        let tmp = setup_config_dir(&[
            ("characters/Alice/workspace/SOUL.md", "Alice character"),
            ("characters/Bob/character.md", "Bob character"),
            ("characters/EmptyDir/.gitkeep", ""), // no character.md
        ]);

        let chars = discover_characters(tmp.path());
        assert_eq!(chars, vec!["Alice", "Bob"]);
    }

    #[test]
    fn prompt_template_resolution_order() {
        let tmp = setup_config_dir(&[
            (
                "characters/TestChar/prompts/system.md",
                "Character system prompt",
            ),
            ("prompts/system.md", "Global system prompt"),
            ("prompts/compact.md", "Global compact prompt"),
        ]);

        // Character-specific wins.
        let char_specific = resolve_prompt_template(tmp.path(), "TestChar", "system.md");
        assert_eq!(char_specific.as_deref(), Some("Character system prompt"));

        // Falls back to global.
        let global_fallback = resolve_prompt_template(tmp.path(), "TestChar", "compact.md");
        assert_eq!(global_fallback.as_deref(), Some("Global compact prompt"));

        // Returns None if no file exists.
        let missing = resolve_prompt_template(tmp.path(), "TestChar", "nonexistent.md");
        assert!(missing.is_none());
    }

    #[test]
    fn xdg_dirs_resolve() {
        let dirs = ShoreDirs::resolve();
        // Should end in /shore for all paths.
        assert!(dirs.config.ends_with("shore"));
        assert!(dirs.data.ends_with("shore"));
        assert!(dirs.runtime.ends_with("shore"));
    }

    // ── Per-character config override tests ───────────────────────────

    #[test]
    fn character_config_override_merges_over_global() {
        let tmp = setup_config_dir(&[
            (
                "config.toml",
                r#"
[defaults]
model = "sonnet"

[behavior.autonomy]
enabled = false

[behavior.autonomy.heartbeat]
fallback_heartbeat_interval = "1h"

[chat.anthropic.sonnet]
model_id = "claude-sonnet-4-6"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
            ),
            ("characters/Alice/character.md", "You are Alice."),
            (
                "characters/Alice/config.toml",
                r#"
[defaults]
model = "opus"

[behavior.autonomy]
enabled = true

[behavior.autonomy.heartbeat]
fallback_heartbeat_interval = "30m"
"#,
            ),
        ]);

        let config_path = tmp.path().join("config.toml");
        let global = load_config(Some(&config_path)).unwrap();

        // Global config should be unchanged.
        assert_eq!(global.app.defaults.model.as_deref(), Some("sonnet"));
        assert!(!global.app.behavior.autonomy.enabled);
        assert_eq!(
            global
                .app
                .behavior
                .autonomy
                .heartbeat
                .fallback_heartbeat_interval,
            ConfigDuration::from_secs(3600)
        );

        // Character config should override specific keys.
        let alice = load_character_config(&global, "Alice").unwrap().unwrap();
        assert_eq!(alice.app.defaults.model.as_deref(), Some("opus"));
        assert!(alice.app.behavior.autonomy.enabled);
        assert_eq!(
            alice
                .app
                .behavior
                .autonomy
                .heartbeat
                .fallback_heartbeat_interval,
            ConfigDuration::from_secs(1800)
        );

        // Models should still be available (inherited from global).
        assert!(alice.models.find_model("sonnet").is_ok());
        assert!(alice.models.find_model("opus").is_ok());
    }

    #[test]
    fn character_config_no_override_returns_none() {
        let tmp = setup_config_dir(&[
            ("config.toml", ""),
            ("characters/Bob/character.md", "You are Bob."),
        ]);

        let config_path = tmp.path().join("config.toml");
        let global = load_config(Some(&config_path)).unwrap();

        assert!(load_character_config(&global, "Bob").unwrap().is_none());
    }

    #[test]
    fn character_config_adds_models() {
        let tmp = setup_config_dir(&[
            (
                "config.toml",
                r#"
[chat.anthropic.sonnet]
model_id = "claude-sonnet-4-6"
"#,
            ),
            ("characters/Alice/character.md", "You are Alice."),
            (
                "characters/Alice/config.toml",
                r#"
[defaults]
model = "opus"

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
max_output_tokens = 16384
"#,
            ),
        ]);

        let config_path = tmp.path().join("config.toml");
        let global = load_config(Some(&config_path)).unwrap();
        assert!(global.models.find_model("opus").is_err());

        let alice = load_character_config(&global, "Alice").unwrap().unwrap();
        assert!(alice.models.find_model("sonnet").is_ok());
        assert!(alice.models.find_model("opus").is_ok());
        assert_eq!(
            alice.models.find_model("opus").unwrap().max_output_tokens,
            Some(16384)
        );
    }

    // ── .env loading tests ────────────────────────────────────────────

    #[test]
    fn dotenv_file_loaded_into_env() {
        let tmp = setup_config_dir(&[
            ("config.toml", ""),
            (".env", "SHORE_TEST_DOTENV_VAR_1234=hello_from_dotenv"),
        ]);

        let config_path = tmp.path().join("config.toml");
        let _loaded = load_config(Some(&config_path)).unwrap();

        assert_eq!(
            std::env::var("SHORE_TEST_DOTENV_VAR_1234").ok().as_deref(),
            Some("hello_from_dotenv"),
        );
        // Clean up.
        std::env::remove_var("SHORE_TEST_DOTENV_VAR_1234");
    }

    #[test]
    fn no_dotenv_file_is_fine() {
        // No .env file — load_config should still succeed.
        let tmp = setup_config_dir(&[("config.toml", "")]);
        let config_path = tmp.path().join("config.toml");
        let loaded = load_config(Some(&config_path));
        assert!(loaded.is_ok());
    }

    // ── create_default_config tests ─────────────────────────────────

    #[test]
    fn create_default_config_creates_file() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("newdir");
        // Directory doesn't exist yet — create_default_config should create it.
        create_default_config(&sub);

        let config_path = sub.join("config.toml");
        assert!(config_path.exists(), "config.toml should be created");

        let content = std::fs::read_to_string(&config_path).unwrap();
        assert!(content.contains("Shore configuration"));
        assert!(content.contains("[defaults]"));
        assert!(content.contains("[providers.anthropic]"));
        // The starter template must not teach deprecated syntax.
        assert!(!content.contains("[chat."));
    }

    #[test]
    fn create_default_config_via_load_when_missing() {
        // load_config with no existing config.toml should create default.
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.toml");
        assert!(!config_path.exists());

        let loaded = load_config(Some(&config_path)).unwrap();
        // Should produce defaults (empty app config).
        assert!(loaded.app.defaults.model.is_none());

        // The default config should now exist on disk.
        assert!(config_path.exists());
    }

    // ── XDG override env var tests ──────────────────────────────────

    #[test]
    fn xdg_override_shore_config_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let custom = tmp.path().join("my_config");
        std::fs::create_dir_all(&custom).unwrap();

        // Set SHORE_CONFIG_DIR override — should be used as-is (no "/shore" suffix).
        std::env::set_var("SHORE_CONFIG_DIR", &custom);
        let dir = resolve_xdg_dir(
            "SHORE_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            dirs::config_dir,
            "~/.config",
        );
        std::env::remove_var("SHORE_CONFIG_DIR");

        assert_eq!(dir, custom, "SHORE_CONFIG_DIR should be used as-is");
    }

    #[test]
    fn xdg_fallback_appends_shore() {
        // No override set — fallback path should have /shore appended.
        let unique = format!("SHORE_TEST_NO_OVERRIDE_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_NO_{}", std::process::id());
        // Ensure neither env var is set.
        std::env::remove_var(&unique);
        std::env::remove_var(&xdg_unique);

        let dir = resolve_xdg_dir(
            &unique,
            &xdg_unique,
            || None, // no platform dir
            "/tmp/shore_fallback_test",
        );
        assert_eq!(dir, PathBuf::from("/tmp/shore_fallback_test/shore"));
    }

    #[test]
    fn xdg_empty_fallback_uses_temp_dir() {
        let unique = format!("SHORE_TEST_EMPTY_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_EMPTY_{}", std::process::id());
        std::env::remove_var(&unique);
        std::env::remove_var(&xdg_unique);

        let dir = resolve_xdg_dir(&unique, &xdg_unique, || None, "");
        // Should use std::env::temp_dir() + "/shore"
        assert!(dir.ends_with("shore"));
        assert!(dir.parent().unwrap().exists(), "parent should be temp_dir");
    }

    #[test]
    fn character_config_with_conf_d_models() {
        // Simulates: global config defines model in conf.d, character overrides default model.
        let tmp = setup_config_dir(&[
            (
                "config.toml",
                r#"
[defaults]
model = "kimi"
"#,
            ),
            (
                "conf.d/models.toml",
                r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[chat.openrouter.kimi]
model_id = "kimi-k2"
"#,
            ),
            ("characters/qifei/character.md", "You are qifei."),
            (
                "characters/qifei/config.toml",
                r#"
[defaults]
model = "chat.anthropic.opus"
"#,
            ),
        ]);

        let config_path = tmp.path().join("config.toml");
        let global = load_config(Some(&config_path)).unwrap();
        assert_eq!(global.app.defaults.model.as_deref(), Some("kimi"));

        let qifei = load_character_config(&global, "qifei").unwrap().unwrap();
        assert_eq!(
            qifei.app.defaults.model.as_deref(),
            Some("chat.anthropic.opus")
        );
        // conf.d models should still be available after merge.
        assert!(qifei.models.find_model("opus").is_ok());
        assert!(qifei.models.find_model("kimi").is_ok());
    }

    // ── Provider registry integration ────────────────────────────────

    #[test]
    fn empty_config_has_empty_provider_registry() {
        let tmp = setup_config_dir(&[("config.toml", "")]);
        let loaded = load_config(Some(&tmp.path().join("config.toml"))).unwrap();
        assert!(loaded.providers.is_empty());
    }

    #[test]
    fn existing_static_chat_config_loads_with_no_providers_section() {
        // Regression guard: static `[chat.X.Y]` config must continue to work
        // exactly as before, with an empty provider registry alongside it.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"

[chat.anthropic.sonnet]
model_id = "claude-sonnet-4-6"
"#,
        )]);
        let loaded = load_config(Some(&tmp.path().join("config.toml"))).unwrap();
        assert!(loaded.providers.is_empty());
        assert!(loaded.models.find_model("opus").is_ok());
        assert!(loaded.models.find_model("sonnet").is_ok());
    }

    #[test]
    fn provider_registry_loads_alongside_static_chat() {
        // Phase 1 deliverable: both can coexist; the registry parses but
        // does not yet alter resolution.
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[providers.openrouter]
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

[chat.anthropic.opus]
model_id = "claude-opus-4-6"
"#,
        )]);
        let loaded = load_config(Some(&tmp.path().join("config.toml"))).unwrap();

        let or = loaded.providers.get("openrouter").unwrap();
        assert!(or.enabled);
        assert_eq!(or.base_url.as_deref(), Some("https://openrouter.ai/api/v1"));
        assert_eq!(or.keys.len(), 2);
        assert_eq!(provider_key(&or.keys, 0).name, "budget");
        assert!(or.discovery.enabled);

        // Static catalog continues to work.
        assert!(loaded.models.find_model("opus").is_ok());
    }

    #[test]
    fn compact_api_key_env_form_loads() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[providers.openai]
api_key_env = "OPENAI_API_KEY"
"#,
        )]);
        let loaded = load_config(Some(&tmp.path().join("config.toml"))).unwrap();
        let p = loaded.providers.get("openai").unwrap();
        assert_eq!(p.keys.len(), 1, "compact form folded into a single key");
        let default = provider_key(&p.keys, 0);
        assert_eq!(default.name, "default");
        assert_eq!(default.env, "OPENAI_API_KEY");
    }

    #[test]
    fn provider_registry_via_conf_d() {
        // Provider sections must merge through conf.d like every other
        // top-level section.
        let tmp = setup_config_dir(&[
            ("config.toml", ""),
            (
                "conf.d/providers.toml",
                r#"
[providers.openrouter]
sdk = "openai"

[[providers.openrouter.keys]]
name = "main"
env = "OR_KEY"
"#,
            ),
        ]);
        let loaded = load_config(Some(&tmp.path().join("config.toml"))).unwrap();
        assert!(loaded.providers.get("openrouter").is_some());
    }

    #[test]
    fn provider_registry_parse_error_propagates() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[providers.openrouter]
api_key_env = "A"

[[providers.openrouter.keys]]
name = "explicit"
env = "B"
"#,
        )]);
        let err = load_config(Some(&tmp.path().join("config.toml"))).unwrap_err();
        assert!(matches!(err, ConfigError::ProviderRegistry(_)));
        assert!(err.to_string().contains("api_key_env"));
    }

    #[test]
    fn per_model_api_key_env_cascades_into_resolved_model() {
        // A per-model `api_key_env` under [chat.<provider>.<model>] cascades
        // into ResolvedModel.api_key_env. (Provider-level scalars under
        // [chat.<provider>] were retired in favor of [providers.*] in #137.)
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-6"
api_key_env = "MY_LEGACY_KEY"
"#,
        )]);
        let loaded = load_config(Some(&tmp.path().join("config.toml"))).unwrap();
        let opus = loaded.models.find_model("opus").unwrap();
        assert_eq!(opus.api_key_env.as_deref(), Some("MY_LEGACY_KEY"));
    }

    /// `examples/config.toml` is the documented entry point for new
    /// users. Drift between it and the parser is a real regression, so
    /// load it through the full two-phase loader and assert the bundled
    /// example reaches a valid `LoadedConfig`. New commented-out
    /// snippets in the example file are exercised via the per-section
    /// tests below.
    #[test]
    fn bundled_example_config_parses() {
        const EXAMPLE: &str = include_str!("../../../examples/config.toml");
        let tmp = setup_config_dir(&[("config.toml", EXAMPLE)]);
        let loaded = load_config(Some(&tmp.path().join("config.toml")))
            .expect("examples/config.toml must parse end-to-end");
        // The committed example is provider-first (#139): [defaults].model is a
        // canonical `provider:model_id` ref and the matching provider is in the
        // registry, so the default resolves without any static [chat.*] entry.
        // Both sides being live is what protects users from copy/paste rot.
        assert_eq!(
            loaded.app.defaults.model.as_deref(),
            Some("anthropic:claude-sonnet-4-6")
        );
        let (provider, _model_id) = loaded
            .app
            .defaults
            .model
            .as_deref()
            .and_then(|m| m.split_once(':'))
            .expect("default model is in provider:model_id form");
        let entry = loaded
            .providers
            .get(provider)
            .expect("default model's provider is registered");
        assert!(entry.enabled, "default model's provider must be enabled");
        // The example leads with the provider-first model; no static catalog.
        assert!(loaded.models.chat.is_empty());
    }

    /// The Phase 9 OpenRouter budget/overflow + discovery snippet
    /// documented in `examples/config.toml` must continue to parse,
    /// even though it is commented out by default. Inline a copy here
    /// (uncommented) so an accidental rename of a parser field is
    /// caught immediately.
    #[test]
    fn documented_provider_snippet_parses() {
        let tmp = setup_config_dir(&[(
            "config.toml",
            r#"
[providers.openai]
api_key_env = "OPENAI_API_KEY"

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
ignore = [
  "*",
  "!anthropic/*",
  "!openai/*",
  "!google/gemini-*",
]

[chat.openrouter.sonnet]
model_id = "anthropic/claude-sonnet-4.5"
cache_ttl = "1h"
max_output_tokens = 16384

[defaults]
model = "sonnet"
"#,
        )]);
        let loaded = load_config(Some(&tmp.path().join("config.toml"))).unwrap();

        // Provider registry shape.
        let or = loaded
            .providers
            .get("openrouter")
            .expect("openrouter present");
        assert!(or.enabled);
        assert_eq!(or.keys.len(), 2);
        let budget = provider_key(&or.keys, 0);
        assert_eq!(budget.name, "budget");
        assert!(budget.warn_on_fallback);
        assert_eq!(provider_key(&or.keys, 1).name, "overflow");
        assert!(or.discovery.enabled);
        assert_eq!(or.discovery.ignore.len(), 4);

        // Compact form folds into a synthetic "default" key.
        let openai = loaded.providers.get("openai").unwrap();
        assert_eq!(openai.keys.len(), 1);
        assert_eq!(provider_key(&openai.keys, 0).name, "default");

        // Static alias still drives [defaults].model validation.
        let sonnet = loaded.models.find_model("sonnet").unwrap();
        assert_eq!(sonnet.model_id, "anthropic/claude-sonnet-4.5");
        assert_eq!(sonnet.cache_ttl.as_deref(), Some("1h"));
    }

    fn budget_with_period(period: app::UsageBudgetPeriod) -> app::UsageBudgetConfig {
        app::UsageBudgetConfig {
            name: "test".into(),
            period,
            cost_usd: 1.0,
            warn_at: vec![0.8, 1.0],
            limit: app::UsageBudgetAction::Warn,
            character: None,
            provider: None,
            api_key: None,
            model: None,
            call_type: None,
            usage_kind: Vec::new(),
            allow_compaction_over_budget: None,
            reset_hour: None,
            reset_day_of_week: None,
            reset_day_of_month: None,
        }
    }

    fn usage_with_one_budget(budget: app::UsageBudgetConfig) -> app::UsageConfig {
        app::UsageConfig {
            timezone: "local".into(),
            allow_compaction_over_budget: true,
            budgets: vec![budget],
            spike_warnings: app::UsageSpikeWarningsConfig::default(),
        }
    }

    #[test]
    fn reset_hour_on_hour_period_rejected() {
        let mut b = budget_with_period(app::UsageBudgetPeriod::Hour);
        b.reset_hour = Some(6);
        let err = validate_usage_config(&usage_with_one_budget(b)).unwrap_err();
        assert!(format!("{err}").contains("reset_hour is not valid for period"));
    }

    #[test]
    fn reset_hour_out_of_range_rejected() {
        let mut b = budget_with_period(app::UsageBudgetPeriod::Day);
        b.reset_hour = Some(24);
        let err = validate_usage_config(&usage_with_one_budget(b)).unwrap_err();
        assert!(format!("{err}").contains("reset_hour must be 0-23"));
    }

    #[test]
    fn reset_day_of_week_on_day_period_rejected() {
        let mut b = budget_with_period(app::UsageBudgetPeriod::Day);
        b.reset_day_of_week = Some(app::BudgetWeekday::Thursday);
        let err = validate_usage_config(&usage_with_one_budget(b)).unwrap_err();
        assert!(format!("{err}").contains("reset_day_of_week is only valid for period = \"week\""));
    }

    #[test]
    fn reset_day_of_month_out_of_range_rejected() {
        let mut b = budget_with_period(app::UsageBudgetPeriod::Month);
        b.reset_day_of_month = Some(32);
        let err = validate_usage_config(&usage_with_one_budget(b)).unwrap_err();
        assert!(format!("{err}").contains("reset_day_of_month must be 1-31"));
    }

    #[test]
    fn reset_day_of_month_on_week_period_rejected() {
        let mut b = budget_with_period(app::UsageBudgetPeriod::Week);
        b.reset_day_of_month = Some(15);
        let err = validate_usage_config(&usage_with_one_budget(b)).unwrap_err();
        assert!(
            format!("{err}").contains("reset_day_of_month is only valid for period = \"month\"")
        );
    }

    fn app_with_mcp(server: app::McpServerConfig) -> AppConfig {
        let mut app = AppConfig::default();
        let _ = app.mcp.insert("hue".to_owned(), server);
        app
    }

    #[test]
    fn mcp_server_with_both_transports_rejected() {
        let err = validate_mcp_servers(&app_with_mcp(app::McpServerConfig {
            command: Some("node".to_owned()),
            args: vec![],
            env: std::collections::BTreeMap::default(),
            cwd: None,
            url: Some("http://x".to_owned()),
        }))
        .unwrap_err();
        assert!(format!("{err}").contains("set exactly one transport"));
    }

    #[test]
    fn mcp_server_with_no_transport_rejected() {
        let err = validate_mcp_servers(&app_with_mcp(app::McpServerConfig {
            command: None,
            args: vec![],
            env: std::collections::BTreeMap::default(),
            cwd: None,
            url: None,
        }))
        .unwrap_err();
        assert!(format!("{err}").contains("set exactly one transport"));
    }

    #[test]
    fn mcp_server_with_single_transport_passes() {
        validate_mcp_servers(&app_with_mcp(app::McpServerConfig {
            command: Some("node".to_owned()),
            args: vec![],
            env: std::collections::BTreeMap::default(),
            cwd: None,
            url: None,
        }))
        .unwrap();
    }

    #[test]
    fn anchored_month_budget_accepted() {
        let mut b = budget_with_period(app::UsageBudgetPeriod::Month);
        b.reset_day_of_month = Some(15);
        b.reset_hour = Some(6);
        validate_usage_config(&usage_with_one_budget(b)).unwrap();
    }

    #[test]
    fn unknown_weekday_string_rejected_at_parse() {
        let toml_str = r#"
[usage]

[[usage.budgets]]
name = "weekly"
period = "week"
cost_usd = 10.0
reset_day_of_week = "funday"
"#;
        let err = toml::from_str::<AppConfig>(toml_str).unwrap_err();
        assert!(
            format!("{err}").contains("funday") || format!("{err}").contains("unknown variant")
        );
    }
}
