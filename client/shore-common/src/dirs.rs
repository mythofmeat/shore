//! Where Shore keeps things, and how the `SHORE_*_DIR` overrides resolve.
//!
//! This is the Rust counterpart of `daemon/src/config/dirs.ts`, and the two
//! must agree. It is duplicated rather than shared for the reason the whole
//! module exists: a client resolves these paths *before* it has a daemon to
//! ask — `instances.json` under the runtime dir is how it finds one at all.
//!
//! Deliberately not a config parser. The file this used to live in also loaded
//! and validated `config.toml`; that is the TypeScript daemon's job now, and
//! #29 deleted the Rust copy.

use std::path::PathBuf;

/// Resolved XDG directory paths for Shore.
///
/// Mirrors `ShoreDirs` in `daemon/src/config/dirs.ts`. Fields are kept even
/// where the clients do not read them yet, so a reader comparing the two files
/// finds the same shape on both sides.
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
///
/// Note that an override is used **as-is**: no `/shore` is appended to it.
/// Anything reimplementing this by hand gets that wrong — see #44.
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

/// Convenience: resolved Shore runtime directory.
pub fn runtime_dir() -> PathBuf {
    ShoreDirs::resolve().runtime
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_dirs_resolve() {
        let dirs = ShoreDirs::resolve();
        // Should end in /shore for all paths.
        assert!(dirs.config.ends_with("shore"));
        assert!(dirs.data.ends_with("shore"));
        assert!(dirs.runtime.ends_with("shore"));
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

    /// `SHORE_WORKSPACE_DIR` is the one override where empty means unset.
    #[test]
    fn empty_workspace_root_counts_as_unset() {
        std::env::set_var("SHORE_WORKSPACE_DIR", "");
        assert_eq!(workspace_root(), None);
        std::env::remove_var("SHORE_WORKSPACE_DIR");
    }
}
