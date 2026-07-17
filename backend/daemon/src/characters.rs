//! CharacterRegistry — multi-character engine management.
//!
//! The daemon discovers available characters from the config directory
//! (`characters/<name>/character.md`) and lazily creates ConversationEngine
//! instances per character on first request.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use shore_protocol::server_msg::ServerMessage;
use tokio::sync::{broadcast, Mutex};
use tracing::{info, warn};

use crate::engine::{ConversationEngine, EngineError};
use shore_config::{
    character_data_dir, discover_characters, load_character_config, load_character_definition,
    resolve_user_definition, LoadedConfig,
};

/// Manages multiple character engines with lazy initialization.
#[derive(Debug)]
pub struct CharacterRegistry {
    /// Config directory for discovering character definitions.
    config_dir: PathBuf,
    /// Data directory root (`$XDG_DATA_HOME/shore/`).
    data_dir: PathBuf,
    /// Broadcast sender passed to new engines.
    push_tx: broadcast::Sender<ServerMessage>,
    /// Lazily-created engines keyed by character name.
    engines: HashMap<String, Arc<Mutex<ConversationEngine>>>,
    /// Cached list of available character names (from filesystem scan).
    available: Vec<String>,
    /// Global config (base for per-character merging).
    global_config: LoadedConfig,
    /// Cached per-character configs. `Some(config)` = has override, `None` = no override file.
    char_configs: HashMap<String, Option<LoadedConfig>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeReloadSummary {
    pub available_before: usize,
    pub available_after: usize,
    pub character_discovery_changed: bool,
    pub dropped_engines: usize,
}

impl CharacterRegistry {
    /// Create a new registry by scanning the config directory for characters.
    pub fn new(
        config_dir: PathBuf,
        data_dir: PathBuf,
        push_tx: broadcast::Sender<ServerMessage>,
        global_config: LoadedConfig,
    ) -> Self {
        let available = discover_characters(&config_dir);
        for name in &available {
            let char_data_dir = character_data_dir(&data_dir, name);
            if let Err(e) = crate::memory::deferred_edits::ensure_active_prompt_snapshot(
                &char_data_dir,
                &config_dir,
                name,
            ) {
                warn!(character = %name, error = %e, "Failed to prepare character workspace");
            }
        }
        info!(
            characters = ?available,
            "Discovered {} character(s)",
            available.len()
        );

        Self {
            config_dir,
            data_dir,
            push_tx,
            engines: HashMap::new(),
            available,
            global_config,
            char_configs: HashMap::new(),
        }
    }

    /// List the names of all available characters.
    pub fn available_characters(&self) -> &[String] {
        &self.available
    }

    /// Re-scan the characters directory for changes.
    pub fn refresh(&mut self) {
        self.available = discover_characters(&self.config_dir);
        for name in &self.available {
            let char_data_dir = character_data_dir(&self.data_dir, name);
            if let Err(e) = crate::memory::deferred_edits::ensure_active_prompt_snapshot(
                &char_data_dir,
                &self.config_dir,
                name,
            ) {
                warn!(character = %name, error = %e, "Failed to prepare character workspace");
            }
        }
    }

    /// Check whether a character exists in the available list.
    pub fn has_character(&self, name: &str) -> bool {
        self.available.iter().any(|n| n == name)
    }

    /// Get the engine for a character, creating it lazily if needed.
    ///
    /// Returns an `Arc<Mutex<ConversationEngine>>` so callers can hold independent
    /// locks without blocking on the registry. The registry lock only needs to be
    /// held briefly to call this; the returned Arc stays valid after release.
    pub fn get_or_create(
        &mut self,
        name: &str,
    ) -> Result<Arc<Mutex<ConversationEngine>>, EngineError> {
        if !self.has_character(name) {
            return Err(EngineError::CharacterNotFound(name.to_owned()));
        }

        // Entry API can't be used directly with fallible init, so check + insert.
        if !self.engines.contains_key(name) {
            let engine = ConversationEngine::new(
                name.to_owned(),
                self.data_dir.clone(),
                self.push_tx.clone(),
            )?;
            info!(character = name, "Created engine for character");
            let _ignored = self
                .engines
                .insert(name.to_owned(), Arc::new(Mutex::new(engine)));
        }

        self.engines
            .get(name)
            .map(Arc::clone)
            .ok_or_else(|| EngineError::CharacterNotFound(name.to_owned()))
    }

    /// Load the character definition (system prompt) for a given character.
    pub fn character_definition(&self, name: &str) -> Option<String> {
        load_character_definition(&self.config_dir, name)
    }

    /// Load the user definition for a given character (character-specific → global fallback).
    pub fn user_definition(&self, name: &str) -> Option<String> {
        resolve_user_definition(&self.config_dir, name)
    }

    /// Get the effective config for a character.
    ///
    /// Returns the per-character merged config if `characters/{name}/config.toml`
    /// exists, otherwise the global config. Results are cached.
    pub fn effective_config(&mut self, name: &str) -> &LoadedConfig {
        if !self.char_configs.contains_key(name) {
            let merged = load_character_config(&self.global_config, name);
            match merged {
                Ok(Some(config)) => {
                    info!(character = name, "Loaded per-character config override");
                    let _ignored = self.char_configs.insert(name.to_owned(), Some(config));
                }
                Ok(None) => {
                    let _ignored = self.char_configs.insert(name.to_owned(), None);
                }
                Err(e) => {
                    warn!(character = name, error = %e, "Failed to load character config, using global");
                    let _ignored = self.char_configs.insert(name.to_owned(), None);
                }
            }
        }
        self.char_configs
            .get(name)
            .and_then(|opt| opt.as_ref())
            .unwrap_or(&self.global_config)
    }

    /// Invalidate all cached per-character configs (e.g. on config_reset).
    pub fn invalidate_configs(&mut self) {
        self.char_configs.clear();
    }

    /// Store an in-memory effective config override for one character.
    ///
    /// This is used by runtime config commands. It is deliberately not written
    /// back to disk, and `config_reset` clears it by reloading registry state.
    pub fn set_runtime_effective_config(&mut self, name: &str, config: LoadedConfig) {
        let _ignored = self.char_configs.insert(name.to_owned(), Some(config));
    }

    /// Update the global config reference and invalidate per-character caches.
    pub fn set_global_config(&mut self, config: LoadedConfig) {
        self.global_config = config;
        self.char_configs.clear();
    }

    /// Reload the registry's runtime view after an explicit config refresh.
    ///
    /// This is Shore's process-level invalidation boundary: global config is
    /// replaced, character discovery is re-scanned, merged per-character config
    /// cache is dropped, and engines for removed characters are discarded.
    pub fn reload_runtime_state(&mut self, config: LoadedConfig) -> RuntimeReloadSummary {
        let available_before = self.available.clone();
        let available_after = discover_characters(&self.config_dir);
        for name in &available_after {
            let char_data_dir = character_data_dir(&self.data_dir, name);
            if let Err(e) = crate::memory::deferred_edits::ensure_active_prompt_snapshot(
                &char_data_dir,
                &self.config_dir,
                name,
            ) {
                warn!(character = %name, error = %e, "Failed to prepare character workspace");
            }
        }
        let available_after_set: HashSet<String> = available_after.iter().cloned().collect();

        let removed_engines: Vec<String> = self
            .engines
            .keys()
            .filter(|name| !available_after_set.contains(name.as_str()))
            .cloned()
            .collect();
        let dropped_engines = removed_engines.len();
        for name in removed_engines {
            let _ignored = self.engines.remove(&name);
        }

        self.global_config = config;
        self.char_configs.clear();
        self.available = available_after;

        let summary = RuntimeReloadSummary {
            available_before: available_before.len(),
            available_after: self.available.len(),
            character_discovery_changed: available_before != self.available,
            dropped_engines,
        };

        info!(
            available_before = summary.available_before,
            available_after = summary.available_after,
            character_discovery_changed = summary.character_discovery_changed,
            dropped_engines = summary.dropped_engines,
            "Reloaded character registry runtime state"
        );

        summary
    }

    /// Access the global config.
    pub fn global_config(&self) -> &LoadedConfig {
        &self.global_config
    }

    /// Select a character by name or auto-select if there's only one.
    ///
    /// - If `requested` is `Some`, validates it exists.
    /// - If `None` and exactly one character is available, auto-selects it.
    /// - Otherwise returns an error.
    pub fn resolve_character(&self, requested: Option<&str>) -> Result<String, CharacterError> {
        match requested {
            Some(name) => {
                if self.has_character(name) {
                    Ok(name.to_owned())
                } else {
                    Err(CharacterError::NotFound {
                        name: name.to_owned(),
                        available: self.available.clone(),
                    })
                }
            }
            None => match self.available.as_slice() {
                [] => Err(CharacterError::NoneAvailable),
                [only] => Ok(only.clone()),
                _ => Err(CharacterError::AmbiguousSelection {
                    available: self.available.clone(),
                }),
            },
        }
    }
}

/// Errors from character resolution.
#[derive(Debug, thiserror::Error)]
pub enum CharacterError {
    #[error("character \"{name}\" not found (available: {available:?})")]
    NotFound {
        name: String,
        available: Vec<String>,
    },
    #[error("no characters available — create one at characters/<name>/workspace/SOUL.md")]
    NoneAvailable,
    #[error("multiple characters available ({available:?}) — specify one with --character or SHORE_CHARACTER")]
    AmbiguousSelection { available: Vec<String> },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Create a registry backed by a tempdir with the given character names.
    fn make_registry(tmp: &TempDir, names: &[&str]) -> CharacterRegistry {
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        for name in names {
            let char_dir = config_dir.join("characters").join(name);
            std::fs::create_dir_all(&char_dir).unwrap();
            std::fs::write(
                char_dir.join("character.md"),
                format!("{name} system prompt"),
            )
            .unwrap();
        }

        let global_config = LoadedConfig::new_for_test(
            shore_config::app::AppConfig::default(),
            shore_config::models::ModelCatalog::default(),
            shore_config::ShoreDirs {
                config: config_dir.clone(),
                data: data_dir.clone(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );

        let (tx, _rx) = broadcast::channel(16);
        CharacterRegistry::new(config_dir, data_dir, tx, global_config)
    }

    #[test]
    fn new_discovers_characters() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice", "Bob"]);
        let chars = reg.available_characters();
        assert_eq!(chars.len(), 2);
        assert!(chars.contains(&"Alice".to_owned()));
        assert!(chars.contains(&"Bob".to_owned()));
    }

    #[test]
    fn new_empty_config_dir() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &[]);
        assert!(reg.available_characters().is_empty());
    }

    #[test]
    fn has_character_true_and_false() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice"]);
        assert!(reg.has_character("Alice"));
        assert!(!reg.has_character("Bob"));
    }

    #[test]
    fn resolve_explicit_valid() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice"]);
        assert_eq!(reg.resolve_character(Some("Alice")).unwrap(), "Alice");
    }

    #[test]
    fn resolve_explicit_invalid() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice"]);
        let err = reg.resolve_character(Some("Bob")).unwrap_err();
        assert!(matches!(err, CharacterError::NotFound { .. }));
        // Error message should mention the requested name and available characters.
        let msg = err.to_string();
        assert!(msg.contains("Bob"));
        assert!(msg.contains("Alice"));
    }

    #[test]
    fn resolve_none_single_auto_select() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice"]);
        assert_eq!(reg.resolve_character(None).unwrap(), "Alice");
    }

    #[test]
    fn resolve_none_empty() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &[]);
        assert!(matches!(
            reg.resolve_character(None).unwrap_err(),
            CharacterError::NoneAvailable
        ));
    }

    #[test]
    fn resolve_none_ambiguous() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice", "Bob"]);
        let err = reg.resolve_character(None).unwrap_err();
        assert!(matches!(err, CharacterError::AmbiguousSelection { .. }));
    }

    #[test]
    fn get_or_create_caches_engine() {
        let tmp = TempDir::new().unwrap();
        let mut reg = make_registry(&tmp, &["Alice"]);

        // First call creates the engine.
        let name1 = reg
            .get_or_create("Alice")
            .unwrap()
            .blocking_lock()
            .character_name()
            .to_owned();
        // Second call returns the same engine (cached).
        let name2 = reg
            .get_or_create("Alice")
            .unwrap()
            .blocking_lock()
            .character_name()
            .to_owned();
        assert_eq!(name1, "Alice");
        assert_eq!(name2, "Alice");
    }

    #[test]
    fn get_or_create_unknown_errors() {
        let tmp = TempDir::new().unwrap();
        let mut reg = make_registry(&tmp, &["Alice"]);
        assert!(reg.get_or_create("Bob").is_err());
    }

    #[test]
    fn refresh_picks_up_new_character() {
        let tmp = TempDir::new().unwrap();
        let mut reg = make_registry(&tmp, &["Alice"]);
        assert_eq!(reg.available_characters().len(), 1);

        // Add a new character directory.
        let bob_dir = tmp.path().join("config").join("characters").join("Bob");
        std::fs::create_dir_all(&bob_dir).unwrap();
        std::fs::write(bob_dir.join("character.md"), "Bob prompt").unwrap();

        reg.refresh();
        assert_eq!(reg.available_characters().len(), 2);
        assert!(reg.has_character("Bob"));
    }

    #[test]
    fn character_definition_loads_content() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice"]);
        let def = reg.character_definition("Alice").unwrap();
        assert_eq!(def, "Alice system prompt");
    }

    #[test]
    fn user_definition_loads_character_specific() {
        let tmp = TempDir::new().unwrap();
        let reg = make_registry(&tmp, &["Alice"]);

        // No user.md yet → None (or global fallback, which doesn't exist).
        assert!(reg.user_definition("Alice").is_none());

        // Write character-specific user.md.
        let user_path = tmp
            .path()
            .join("config")
            .join("characters")
            .join("Alice")
            .join("user.md");
        std::fs::write(&user_path, "Alice user context").unwrap();
        assert_eq!(reg.user_definition("Alice").unwrap(), "Alice user context");
    }

    #[tokio::test]
    async fn reload_runtime_state_refreshes_characters_and_config_cache() {
        let tmp = TempDir::new().unwrap();
        let mut reg = make_registry(&tmp, &["Alice"]);

        let alice_dir = tmp.path().join("config").join("characters").join("Alice");
        std::fs::write(
            alice_dir.join("config.toml"),
            "[defaults]\nstream = false\n",
        )
        .unwrap();

        assert!(!reg.effective_config("Alice").app.defaults.stream);
        let old_engine = reg.get_or_create("Alice").unwrap();

        let bob_dir = tmp.path().join("config").join("characters").join("Bob");
        std::fs::create_dir_all(&bob_dir).unwrap();
        std::fs::write(bob_dir.join("character.md"), "Bob prompt").unwrap();
        std::fs::write(alice_dir.join("config.toml"), "[defaults]\nstream = true\n").unwrap();

        let summary = reg.reload_runtime_state(reg.global_config().clone());
        assert_eq!(summary.available_before, 1);
        assert_eq!(summary.available_after, 2);
        assert_eq!(summary.dropped_engines, 0);
        assert!(reg.has_character("Bob"));
        assert!(reg.effective_config("Alice").app.defaults.stream);

        assert!(Arc::ptr_eq(
            &old_engine,
            &reg.get_or_create("Alice").unwrap()
        ));
    }

    #[test]
    fn reload_runtime_state_drops_engines_for_removed_characters() {
        let tmp = TempDir::new().unwrap();
        let mut reg = make_registry(&tmp, &["Alice"]);
        let _ignored = reg.get_or_create("Alice").unwrap();

        std::fs::remove_dir_all(tmp.path().join("config").join("characters").join("Alice"))
            .unwrap();

        let summary = reg.reload_runtime_state(reg.global_config().clone());
        assert_eq!(summary.available_before, 1);
        assert_eq!(summary.available_after, 0);
        assert_eq!(summary.dropped_engines, 1);
        assert!(!reg.has_character("Alice"));
        assert!(reg.get_or_create("Alice").is_err());
    }
}
