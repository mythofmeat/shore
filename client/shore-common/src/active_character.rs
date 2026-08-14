use std::path::PathBuf;

use tracing::debug;

pub fn active_character_path() -> PathBuf {
    crate::dirs::runtime_dir().join("active_character")
}

pub fn read_active_character() -> Option<String> {
    let content = std::fs::read_to_string(active_character_path()).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        debug!("No active character in state file");
        return None;
    }
    debug!(character = trimmed, "Read active character from state file");
    Some(trimmed.to_owned())
}

pub fn write_active_character(name: &str) -> std::io::Result<()> {
    let path = active_character_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    debug!(character = name, "Writing active character to state file");
    std::fs::write(&path, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::{set_env, unset_env};

    #[test]
    fn path_ends_with_active_character() {
        assert!(active_character_path().ends_with("active_character"));
    }

    #[test]
    fn round_trip_through_the_runtime_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        set_env("SHORE_RUNTIME_DIR", tmp.path().join("shore"));
        let result = std::panic::catch_unwind(|| {
            assert!(read_active_character().is_none(), "missing file is None");

            write_active_character("alice").unwrap();
            assert_eq!(read_active_character().as_deref(), Some("alice"));

            write_active_character("bob").unwrap();
            assert_eq!(read_active_character().as_deref(), Some("bob"));

            std::fs::write(active_character_path(), "").unwrap();
            assert!(read_active_character().is_none(), "empty file is None");

            std::fs::write(active_character_path(), "  carol  \n").unwrap();
            assert_eq!(read_active_character().as_deref(), Some("carol"));
        });
        unset_env("SHORE_RUNTIME_DIR");
        result.unwrap();
    }
}
