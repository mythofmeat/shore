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

/// What to do when nothing above has answered.
///
/// This replaces a pair of string literals — `"~/.config"` and
/// `"~/.local/share"` — that read as though they did something and never had.
/// Nothing expands a tilde, so `PathBuf::from("~/.config").join("shore")` is a
/// *relative* path whose first component is a directory literally named `~`,
/// created wherever the process happened to start.
#[derive(Debug, Clone, Copy)]
enum LastResort {
    /// `std::env::temp_dir()`. Correct for `runtime`, and only for `runtime`:
    /// the `dirs` crate offers no platform default for `XDG_RUNTIME_DIR`, so
    /// this arm is taken routinely, and a directory that means "ephemeral" is
    /// the one place ephemeral storage is the right answer.
    TempDir,
    /// Nothing is correct, so refuse.
    ///
    /// A process that can find no home directory has nowhere right to put a
    /// user's config, data or cache, and inventing somewhere is the worse of
    /// the two failures: `./~/.config/shore` looks like it worked, is silently
    /// per-working-directory, and only surfaces when someone wonders where
    /// their characters went.
    ///
    /// Reaching this is hard, which is why it never bit. Unsetting `HOME` is
    /// not enough — `dirs::config_dir()` falls through to the passwd database
    /// and still answers. It needs no `HOME` *and* no passwd entry for the uid:
    /// a container run as `--user 1001:1001` against an image whose passwd only
    /// knows uid 1000. `Dockerfile` creates `shore` as uid 1000 and sets
    /// `SHORE_CONFIG_DIR`, so the supported configuration never gets here; a
    /// `docker run --user` overriding it can.
    Refuse,
}

/// Resolve an XDG-style directory path with Shore-specific overrides.
///
/// Precedence: `override_var` → `xdg_var`+"/shore" → `platform_fn()`+"/shore" →
/// `last_resort`.
///
/// Note that an override is used **as-is**: no `/shore` is appended to it.
/// Anything reimplementing this by hand gets that wrong — see #44.
///
/// # Panics
///
/// With [`LastResort::Refuse`], when every source above is exhausted. There is
/// no `Result` here because there is no caller that could do anything useful
/// with one: this runs before a client has parsed an argument, and every path
/// it would go on to touch is downstream of the answer.
#[expect(
    clippy::panic,
    reason = "no home directory means nowhere correct to write; the alternative is \
              a relative directory named `~` that looks like it worked (#45)"
)]
fn resolve_xdg_dir(
    override_var: &str,
    xdg_var: &str,
    platform_fn: fn() -> Option<PathBuf>,
    last_resort: LastResort,
) -> PathBuf {
    std::env::var(override_var).ok().map_or_else(
        || {
            std::env::var(xdg_var)
                .ok()
                .map(PathBuf::from)
                .or_else(platform_fn)
                .unwrap_or_else(|| match last_resort {
                    LastResort::TempDir => std::env::temp_dir(),
                    LastResort::Refuse => panic!(
                        "shore cannot determine a home directory: ${xdg_var} is unset and this \
                         user has no home (no $HOME and no passwd entry for the uid). Set \
                         ${override_var} to an explicit path, or ${xdg_var}, or run as a user \
                         the passwd database knows."
                    ),
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
                LastResort::Refuse,
            ),
            data: resolve_xdg_dir(
                "SHORE_DATA_DIR",
                "XDG_DATA_HOME",
                dirs::data_dir,
                LastResort::Refuse,
            ),
            runtime: resolve_xdg_dir(
                "SHORE_RUNTIME_DIR",
                "XDG_RUNTIME_DIR",
                dirs::runtime_dir,
                LastResort::TempDir,
            ),
            cache: resolve_xdg_dir(
                "SHORE_CACHE_DIR",
                "XDG_CACHE_HOME",
                dirs::cache_dir,
                LastResort::Refuse,
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
            LastResort::Refuse,
        );
        std::env::remove_var("SHORE_CONFIG_DIR");

        assert_eq!(dir, custom, "SHORE_CONFIG_DIR should be used as-is");
    }

    #[test]
    fn xdg_platform_dir_appends_shore() {
        // No override and no XDG var — the platform answer gets /shore.
        let unique = format!("SHORE_TEST_NO_OVERRIDE_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_NO_{}", std::process::id());
        std::env::remove_var(&unique);
        std::env::remove_var(&xdg_unique);

        let dir = resolve_xdg_dir(
            &unique,
            &xdg_unique,
            || Some(PathBuf::from("/tmp/shore_fallback_test")),
            LastResort::Refuse,
        );
        assert_eq!(dir, PathBuf::from("/tmp/shore_fallback_test/shore"));
    }

    #[test]
    fn runtime_falls_back_to_the_temp_dir() {
        let unique = format!("SHORE_TEST_EMPTY_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_EMPTY_{}", std::process::id());
        std::env::remove_var(&unique);
        std::env::remove_var(&xdg_unique);

        let dir = resolve_xdg_dir(&unique, &xdg_unique, || None, LastResort::TempDir);
        assert!(dir.ends_with("shore"));
        assert!(dir.parent().unwrap().exists(), "parent should be temp_dir");
    }

    /// The hole this replaced: with everything exhausted the old code returned
    /// the *relative* path `~/.config/shore`, so a process with no home wrote a
    /// directory named `~` into whatever it happened to be started from.
    #[test]
    #[should_panic(expected = "cannot determine a home directory")]
    fn no_home_anywhere_refuses_rather_than_inventing_a_tilde_directory() {
        let unique = format!("SHORE_TEST_NOHOME_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_NOHOME_{}", std::process::id());
        std::env::remove_var(&unique);
        std::env::remove_var(&xdg_unique);

        let _ = resolve_xdg_dir(&unique, &xdg_unique, || None, LastResort::Refuse);
    }

    /// An override is still honoured when there is no home at all — the escape
    /// hatch the panic message points at has to actually work.
    #[test]
    fn an_override_is_enough_on_its_own() {
        let unique = format!("SHORE_TEST_OVERRIDE_ONLY_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_OVERRIDE_ONLY_{}", std::process::id());
        std::env::set_var(&unique, "/srv/shore");
        std::env::remove_var(&xdg_unique);

        let dir = resolve_xdg_dir(&unique, &xdg_unique, || None, LastResort::Refuse);
        std::env::remove_var(&unique);

        assert_eq!(dir, PathBuf::from("/srv/shore"));
    }

    /// `SHORE_WORKSPACE_DIR` is the one override where empty means unset.
    #[test]
    fn empty_workspace_root_counts_as_unset() {
        std::env::set_var("SHORE_WORKSPACE_DIR", "");
        assert_eq!(workspace_root(), None);
        std::env::remove_var("SHORE_WORKSPACE_DIR");
    }
}
