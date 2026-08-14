use std::path::PathBuf;

pub(crate) use shore_common::active_character::{read_active_character, write_active_character};
use tracing::debug;

fn runtime_dir() -> PathBuf {
    shore_common::dirs::runtime_dir()
}

pub(crate) fn model_state_file_path() -> PathBuf {
    runtime_dir().join("active_model")
}

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

pub(crate) fn clear_active_model() -> std::io::Result<()> {
    let path = model_state_file_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

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
    use crate::test_env::{set_env, unset_env};

    #[test]
    fn resolve_display_character_prefers_daemon_answer() {
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
    fn model_state_file_path_ends_with_active_model() {
        let path = model_state_file_path();
        assert!(
            path.ends_with("active_model"),
            "model_state_file_path should end with 'active_model', got: {path:?}"
        );
    }

    #[test]
    fn read_write_state_lifecycle() {
        let tmp = tempfile::TempDir::new().unwrap();
        let runtime = tmp.path().join("shore");

        set_env("SHORE_RUNTIME_DIR", &runtime);
        let result = std::panic::catch_unwind(|| {
            write_active_character("alice").unwrap();
            assert_eq!(read_active_character().as_deref(), Some("alice"));

            assert!(
                read_active_model().is_none(),
                "missing file should return None"
            );

            std::fs::create_dir_all(model_state_file_path().parent().unwrap()).unwrap();
            std::fs::write(model_state_file_path(), "gpt-4o").unwrap();
            assert_eq!(read_active_model().as_deref(), Some("gpt-4o"));

            std::fs::write(model_state_file_path(), "  opus  \n").unwrap();
            assert_eq!(read_active_model().as_deref(), Some("opus"));

            clear_active_model().unwrap();
            assert!(
                !model_state_file_path().exists(),
                "clear_active_model should remove the state file"
            );
            assert!(read_active_model().is_none());

            clear_active_model().unwrap();
        });
        unset_env("SHORE_RUNTIME_DIR");
        result.unwrap();
    }
}
