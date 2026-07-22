//! Locating the suite's helper binaries.
//!
//! `shore-llm-sidecar` and `shore-matrix` are spawned by other Shore processes,
//! never typed by a human, so packaged installs deliberately keep them out of
//! `$PATH`. Every process that spawns one resolves it the same way:
//!
//! 1. the binary's `SHORE_*_BIN` environment override, set by the packaged
//!    systemd unit,
//! 2. `$PATH`, then a sibling of the running executable — how a `cargo build`
//!    checkout finds it without any packaging,
//! 3. the packaged libexec directories ([`LIBEXEC_DIRS`]).
//!
//! A missing binary is not an error here: the daemon degrades to running
//! without the sidecar or the bridge, so callers decide what absence means.

use std::path::{Path, PathBuf};

/// Environment override naming the `shore-matrix` binary.
pub const MATRIX_BIN_ENV: &str = "SHORE_MATRIX_BIN";

/// Environment override naming the `shore-llm-sidecar` binary.
pub const LLM_SIDECAR_BIN_ENV: &str = "SHORE_LLM_SIDECAR_BIN";

/// Where packaged installs put helper binaries, deliberately off `$PATH`.
/// Searched in order, so a `/usr/local` install wins over a distro package.
pub const LIBEXEC_DIRS: [&str; 2] = ["/usr/local/lib/shore", "/usr/lib/shore"];

/// Outcome of a helper-binary lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// The binary, if any searched location held one.
    pub path: Option<PathBuf>,
    /// Set when the environment override named something that is not a file.
    /// The search continued past it; callers should say so, since a typo'd
    /// override that silently resolved elsewhere is confusing to debug.
    pub ignored_override: Option<PathBuf>,
}

/// Resolve helper binary `name`, letting `env_var` override the search.
pub fn resolve(name: &str, env_var: &str) -> Resolved {
    let mut ignored_override = None;
    if let Some(raw) = std::env::var_os(env_var) {
        let overridden = PathBuf::from(raw);
        if overridden.is_file() {
            return Resolved {
                path: Some(overridden),
                ignored_override: None,
            };
        }
        ignored_override = Some(overridden);
    }
    Resolved {
        path: search(name),
        ignored_override,
    }
}

/// Human-readable list of the searched locations, for error messages.
pub fn searched_locations(env_var: &str) -> String {
    format!(
        "{env_var}, PATH, next to the running binary, or {}",
        LIBEXEC_DIRS.join(" / ")
    )
}

fn search(name: &str) -> Option<PathBuf> {
    if let Ok(on_path) = which::which(name) {
        return Some(on_path);
    }
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|candidate| candidate.is_file());
    if let Some(found) = sibling {
        return Some(found);
    }
    LIBEXEC_DIRS
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test uses its own env var name: tests share one process, and a
    /// shared var would race.
    fn set_override(env_var: &str, value: &Path) {
        std::env::set_var(env_var, value);
    }

    #[test]
    fn override_pointing_at_a_file_wins() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("shore-helper-wins");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        set_override("SHORE_TEST_BIN_WINS", &binary);

        let resolved = resolve("shore-helper-wins", "SHORE_TEST_BIN_WINS");

        assert_eq!(resolved.path, Some(binary), "override should be honored");
        assert_eq!(
            resolved.ignored_override, None,
            "a usable override is not an ignored one"
        );
    }

    #[test]
    fn missing_override_target_is_reported_and_search_continues() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("shore-helper-absent");
        set_override("SHORE_TEST_BIN_ABSENT", &absent);

        let resolved = resolve(
            "shore-helper-definitely-not-installed",
            "SHORE_TEST_BIN_ABSENT",
        );

        assert_eq!(
            resolved.ignored_override,
            Some(absent),
            "callers need to know the override was skipped"
        );
        assert_eq!(
            resolved.path, None,
            "no other location holds this fictional binary"
        );
    }

    #[test]
    fn a_directory_is_not_a_binary() {
        let dir = tempfile::tempdir().unwrap();
        set_override("SHORE_TEST_BIN_DIR", dir.path());

        let resolved = resolve(
            "shore-helper-definitely-not-installed",
            "SHORE_TEST_BIN_DIR",
        );

        assert_eq!(
            resolved.ignored_override,
            Some(dir.path().to_path_buf()),
            "a directory override must not be spawned as a program"
        );
    }

    #[test]
    fn unset_override_searches_without_complaint() {
        let resolved = resolve(
            "shore-helper-definitely-not-installed",
            "SHORE_TEST_BIN_NEVER_SET",
        );

        assert_eq!(resolved.path, None, "nothing should match");
        assert_eq!(
            resolved.ignored_override, None,
            "an unset override is not an ignored one"
        );
    }

    #[test]
    fn searched_locations_names_the_override_and_libexec_dirs() {
        let described = searched_locations(MATRIX_BIN_ENV);

        assert!(
            described.contains(MATRIX_BIN_ENV),
            "message should name the env var: {described}"
        );
        assert!(
            described.contains("/usr/lib/shore"),
            "message should name the libexec dirs: {described}"
        );
    }
}
