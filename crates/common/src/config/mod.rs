//! Directory and character-name resolution for the Shore clients.
//!
//! This module used to parse Shore's config files too. That job belongs to the
//! TypeScript daemon now (`daemon/src/config/`), which was the only thing that
//! ever consumed the result — see #29. What is left is the path logic the CLI
//! and TUI need *before* they have talked to a daemon: finding the socket,
//! naming a character, and scaffolding a new one.
//!
//! Anything here that the daemon also needs is duplicated in
//! `daemon/src/config/dirs.ts` rather than shared. The two must agree on the
//! `SHORE_*_DIR` precedence rules; they are small, and the alternative is the
//! client asking a daemon it has not connected to yet where things live.

use std::path::{Path, PathBuf};

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
    /// Workspace root: `SHORE_WORKSPACE_DIR`, when set. Each character's
    /// workspace is `<root>/<character>/`; `None` keeps every workspace inside
    /// the character's own config directory, which is the default layout.
    pub workspace: Option<PathBuf>,
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
            workspace: workspace_root(),
        }
    }
}

/// `SHORE_WORKSPACE_DIR`, or `None` for the default layout.
///
/// Used as-is, like the other `SHORE_*_DIR` overrides: no `/shore` suffix and
/// no XDG variable behind it. Unlike them, **an empty value counts as unset** —
/// they have no default but the one they compute, whereas this has a perfectly
/// good one, and an empty root would scatter every character's workspace into
/// whatever directory the process happened to start in.
pub fn workspace_root() -> Option<PathBuf> {
    std::env::var("SHORE_WORKSPACE_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
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

pub const CHARACTER_WORKSPACE_DIR: &str = "workspace";
pub const SOUL_FILE: &str = "SOUL.md";

/// Return `characters/{name}/`.
pub fn character_config_dir(config_dir: &Path, character_name: &str) -> PathBuf {
    config_dir.join("characters").join(character_name)
}

/// Return `characters/{name}/workspace/` — the default layout, where a
/// workspace lives inside the character's config directory.
pub fn character_workspace_dir(config_dir: &Path, character_name: &str) -> PathBuf {
    character_workspace_dir_in(None, config_dir, character_name)
}

/// Return `{workspace_root}/{name}/`, or the default layout when there is no
/// root. `workspace_root` is `ShoreDirs::workspace`.
pub fn character_workspace_dir_in(
    workspace_root: Option<&Path>,
    config_dir: &Path,
    character_name: &str,
) -> PathBuf {
    match workspace_root {
        Some(root) => root.join(character_name),
        None => character_config_dir(config_dir, character_name).join(CHARACTER_WORKSPACE_DIR),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn xdg_dirs_resolve() {
        let dirs = ShoreDirs::resolve();
        // Should end in /shore for all paths.
        assert!(dirs.config.ends_with("shore"));
        assert!(dirs.data.ends_with("shore"));
        assert!(dirs.runtime.ends_with("shore"));
    }

    #[test]
    fn workspace_root_replaces_the_whole_workspace_segment() {
        // Pure, and deliberately not env-driven: `ShoreDirs::resolve` reads the
        // process environment, and the tests here run in parallel.
        let root = PathBuf::from("/srv/ws");
        assert_eq!(
            character_workspace_dir_in(Some(&root), Path::new("/cfg"), "ada"),
            PathBuf::from("/srv/ws/ada")
        );
        assert_eq!(
            character_workspace_dir_in(None, Path::new("/cfg"), "ada"),
            PathBuf::from("/cfg/characters/ada/workspace")
        );
        // The two-argument helper is the no-root case, unchanged.
        assert_eq!(
            character_workspace_dir(Path::new("/cfg"), "ada"),
            character_workspace_dir_in(None, Path::new("/cfg"), "ada")
        );
    }

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
}
