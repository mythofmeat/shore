use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const RUNTIME_STATE_FILE: &str = "runtime_state.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CharacterRuntimeState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_model: Option<String>,
}

pub fn character_runtime_state_path(character_data_dir: &Path) -> PathBuf {
    character_data_dir.join(RUNTIME_STATE_FILE)
}

pub fn load_character_runtime_state(
    character_data_dir: &Path,
) -> io::Result<CharacterRuntimeState> {
    let path = character_runtime_state_path(character_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(CharacterRuntimeState::default()),
        Err(e) => Err(e),
    }
}

pub fn save_character_runtime_state(
    character_data_dir: &Path,
    state: &CharacterRuntimeState,
) -> io::Result<()> {
    std::fs::create_dir_all(character_data_dir)?;
    let path = character_runtime_state_path(character_data_dir);
    let json = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    std::fs::write(path, json)
}

pub fn load_active_model(character_data_dir: &Path) -> Option<String> {
    load_character_runtime_state(character_data_dir)
        .ok()
        .and_then(|state| state.active_model)
}

pub fn save_active_model(
    character_data_dir: &Path,
    active_model: Option<String>,
) -> io::Result<()> {
    save_character_runtime_state(character_data_dir, &CharacterRuntimeState { active_model })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_state_defaults_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let state = load_character_runtime_state(tmp.path()).unwrap();
        assert_eq!(state, CharacterRuntimeState::default());
    }

    #[test]
    fn active_model_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        save_active_model(tmp.path(), Some("sonnet".into())).unwrap();
        assert_eq!(load_active_model(tmp.path()).as_deref(), Some("sonnet"));
    }
}
