use std::path::{Path, PathBuf};

use tracing::debug;

pub fn active_character_path() -> PathBuf {
    crate::dirs::data_dir().join("active_character")
}

fn legacy_active_character_path() -> PathBuf {
    crate::dirs::runtime_dir().join("active_character")
}

pub fn read_active_character() -> Option<String> {
    read_from(&active_character_path(), &legacy_active_character_path())
}

pub fn write_active_character(name: &str) -> std::io::Result<()> {
    write_to(&active_character_path(), name)
}

fn thread_state_path(character: &str) -> Option<PathBuf> {
    if character.is_empty()
        || character.contains('/')
        || character.contains('\\')
        || character == "."
        || character == ".."
    {
        return None;
    }
    Some(
        crate::dirs::data_dir()
            .join("active_thread")
            .join(character),
    )
}

pub fn read_active_thread(character: &str) -> Option<String> {
    let path = thread_state_path(character)?;
    let content = std::fs::read_to_string(&path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    debug!(
        character,
        thread = trimmed,
        "Read active thread from state file"
    );
    Some(trimmed.to_owned())
}

pub fn write_active_thread(character: &str, thread: &str) -> std::io::Result<()> {
    let Some(path) = thread_state_path(character) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    debug!(character, thread, "Writing active thread to state file");
    std::fs::write(path, thread)
}

fn read_from(primary: &Path, legacy: &Path) -> Option<String> {
    let content = std::fs::read_to_string(primary)
        .or_else(|_| std::fs::read_to_string(legacy))
        .ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        debug!("No active character in state file");
        return None;
    }
    debug!(character = trimmed, "Read active character from state file");
    Some(trimmed.to_owned())
}

fn write_to(path: &Path, name: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    debug!(character = name, "Writing active character to state file");
    std::fs::write(path, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Paths {
        _tmp: tempfile::TempDir,
        primary: PathBuf,
        legacy: PathBuf,
    }

    fn paths() -> Paths {
        let tmp = tempfile::TempDir::new().unwrap();
        let primary = tmp.path().join("data").join("active_character");
        let legacy = tmp.path().join("run").join("active_character");
        Paths {
            _tmp: tmp,
            primary,
            legacy,
        }
    }

    #[test]
    fn the_choice_is_kept_in_the_data_dir() {
        assert_eq!(
            active_character_path(),
            crate::dirs::data_dir().join("active_character"),
        );
        assert_eq!(
            legacy_active_character_path(),
            crate::dirs::runtime_dir().join("active_character"),
        );
    }

    #[test]
    fn round_trips_through_the_data_dir() {
        let p = paths();
        assert!(read_from(&p.primary, &p.legacy).is_none(), "missing file");

        write_to(&p.primary, "alice").unwrap();
        assert_eq!(read_from(&p.primary, &p.legacy).as_deref(), Some("alice"));

        write_to(&p.primary, "bob").unwrap();
        assert_eq!(read_from(&p.primary, &p.legacy).as_deref(), Some("bob"));

        std::fs::write(&p.primary, "").unwrap();
        assert!(read_from(&p.primary, &p.legacy).is_none(), "empty file");

        std::fs::write(&p.primary, "  carol  \n").unwrap();
        assert_eq!(read_from(&p.primary, &p.legacy).as_deref(), Some("carol"));
    }

    #[test]
    fn a_choice_left_in_the_runtime_dir_is_still_read() {
        let p = paths();
        std::fs::create_dir_all(p.legacy.parent().unwrap()).unwrap();
        std::fs::write(&p.legacy, "dana").unwrap();
        assert_eq!(read_from(&p.primary, &p.legacy).as_deref(), Some("dana"));

        write_to(&p.primary, "erin").unwrap();
        assert_eq!(
            read_from(&p.primary, &p.legacy).as_deref(),
            Some("erin"),
            "the data dir wins once it has an answer",
        );
    }
}
