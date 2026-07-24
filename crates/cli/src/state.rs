//! Client-side state files for persisting the active character and model.
//!
//! Both selections are stored as plain text files in the Shore runtime
//! directory (`$XDG_RUNTIME_DIR/shore/active_character`,
//! `$XDG_RUNTIME_DIR/shore/active_model`). This is ephemeral state — cleared
//! on reboot — which matches the intent: these selections are session-level,
//! not permanent config.

use std::path::PathBuf;

use tracing::debug;

/// Return the directory used for Shore runtime state.
fn runtime_dir() -> PathBuf {
    shore_common::config::runtime_dir()
}

/// Return the path to the active character state file.
pub(crate) fn state_file_path() -> PathBuf {
    runtime_dir().join("active_character")
}

/// Return the path to the active model state file.
pub(crate) fn model_state_file_path() -> PathBuf {
    runtime_dir().join("active_model")
}

/// Read the active character from the state file.
///
/// Returns `None` if the file doesn't exist, is empty, or is unreadable.
pub(crate) fn read_active_character() -> Option<String> {
    let content = std::fs::read_to_string(state_file_path()).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        debug!("No active character in state file");
        None
    } else {
        debug!(character = trimmed, "Read active character from state file");
        Some(trimmed.to_owned())
    }
}

/// Write the active character to the state file.
///
/// Creates parent directories if needed.
pub(crate) fn write_active_character(name: &str) -> std::io::Result<()> {
    let path = state_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    debug!(character = name, "Writing active character to state file");
    std::fs::write(&path, name)
}

/// Read the active model name from the state file.
///
/// Returns `None` if the file doesn't exist, is empty, or is unreadable.
pub(crate) fn read_active_model() -> Option<String> {
    let content = std::fs::read_to_string(model_state_file_path()).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        debug!("No active model in state file");
        None
    } else {
        debug!(model = trimmed, "Read active model from state file");
        Some(trimmed.to_owned())
    }
}

/// Remove the active model state file (treated as "no preference").
///
/// Missing file is not an error: we only care that the file is gone
/// afterwards.
pub(crate) fn clear_active_model() -> std::io::Result<()> {
    let path = model_state_file_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Resolve the character name to display in output (transcript headers,
/// status lines, etc.).
///
/// Priority, highest first:
/// 1. Name the daemon reported as selected on this connection.
/// 2. Name the client requested (CLI flag / env / state file).
/// 3. Literal fallback `"Assistant"`.
///
/// The daemon's answer wins because it is authoritative: the client may
/// have sent no character and let the daemon auto-select, in which case
/// only the daemon knows what got attached.
pub(crate) fn resolve_display_character(
    daemon_selected: Option<&str>,
    requested: Option<&str>,
) -> String {
    daemon_selected
        .filter(|s| !s.is_empty())
        .or(requested.filter(|s| !s.is_empty()))
        .unwrap_or("Assistant")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_display_character_prefers_daemon_answer() {
        // Regression for #5: the CLI relied solely on the local state file
        // to label assistant messages, so any user who hadn't stamped the
        // state file saw "Assistant" even though the daemon clearly knew
        // which character it was streaming.
        assert_eq!(
            resolve_display_character(Some("sable"), None),
            "sable".to_owned(),
        );
        assert_eq!(
            resolve_display_character(Some("sable"), Some("ignored")),
            "sable".to_owned(),
            "daemon answer must override a stale request",
        );
    }

    #[test]
    fn resolve_display_character_falls_back_to_request() {
        assert_eq!(
            resolve_display_character(None, Some("aria")),
            "aria".to_owned(),
        );
    }

    #[test]
    fn resolve_display_character_final_fallback() {
        assert_eq!(
            resolve_display_character(None, None),
            "Assistant".to_owned(),
        );
        assert_eq!(
            resolve_display_character(Some(""), Some("")),
            "Assistant".to_owned(),
            "empty strings should be treated as absent",
        );
    }

    #[test]
    fn state_file_path_ends_with_active_character() {
        let path = state_file_path();
        assert!(
            path.ends_with("active_character"),
            "state_file_path should end with 'active_character', got: {path:?}"
        );
    }

    #[test]
    fn model_state_file_path_ends_with_active_model() {
        let path = model_state_file_path();
        assert!(
            path.ends_with("active_model"),
            "model_state_file_path should end with 'active_model', got: {path:?}"
        );
    }

    /// All env-var-dependent state tests are in one test to avoid
    /// `SHORE_RUNTIME_DIR` races across parallel test threads.
    #[test]
    fn read_write_state_lifecycle() {
        let tmp = tempfile::TempDir::new().unwrap();
        let runtime = tmp.path().join("shore");

        std::env::set_var("SHORE_RUNTIME_DIR", &runtime);
        let result = std::panic::catch_unwind(|| {
            // ── character ─────────────────────────────────────────────
            // 1. Missing file → None.
            assert!(
                read_active_character().is_none(),
                "missing file should return None"
            );

            // 2. Write and read back.
            write_active_character("alice").unwrap();
            assert_eq!(read_active_character().as_deref(), Some("alice"));

            // 3. Overwrite.
            write_active_character("bob").unwrap();
            assert_eq!(read_active_character().as_deref(), Some("bob"));

            // 4. Empty file → None.
            std::fs::write(state_file_path(), "").unwrap();
            assert!(
                read_active_character().is_none(),
                "empty file should return None"
            );

            // 5. Whitespace trimming.
            std::fs::write(state_file_path(), "  carol  \n").unwrap();
            assert_eq!(read_active_character().as_deref(), Some("carol"));

            // ── model ─────────────────────────────────────────────────
            // Phase 3+: CLI no longer writes the model mirror. The
            // reader is kept as a one-release migration fallback so an
            // upgraded daemon can pick up a stale runtime file. Test
            // simulates that by writing the file directly via fs::write.

            // 1. Missing file → None.
            assert!(
                read_active_model().is_none(),
                "missing file should return None"
            );

            // 2. Pre-existing legacy file is read back.
            std::fs::create_dir_all(model_state_file_path().parent().unwrap()).unwrap();
            std::fs::write(model_state_file_path(), "gpt-4o").unwrap();
            assert_eq!(read_active_model().as_deref(), Some("gpt-4o"));

            // 3. Whitespace trimming.
            std::fs::write(model_state_file_path(), "  opus  \n").unwrap();
            assert_eq!(read_active_model().as_deref(), Some("opus"));

            // 4. Clear removes the file.
            clear_active_model().unwrap();
            assert!(
                !model_state_file_path().exists(),
                "clear_active_model should remove the state file"
            );
            assert!(read_active_model().is_none());

            // 5. Clearing when missing is a no-op, not an error.
            clear_active_model().unwrap();
        });
        std::env::remove_var("SHORE_RUNTIME_DIR");
        result.unwrap();
    }
}
