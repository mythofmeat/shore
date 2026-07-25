//! Per-room view preferences — the Matrix analog of the TUI's `:view` toggles.
//!
//! Controls which generation internals get attached to replies in a room:
//! thinking blocks, tool activity, and the usage footer. All default off, per
//! room, persisted as a JSON sidecar so they survive restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::warn;

/// What a room shows alongside replies.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomView {
    #[serde(default)]
    pub thinking: bool,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub usage: bool,
}

impl RoomView {
    pub fn get(&self, key: &str) -> Option<bool> {
        match key {
            "thinking" => Some(self.thinking),
            "tools" => Some(self.tools),
            "usage" => Some(self.usage),
            _ => None,
        }
    }

    fn set(&mut self, key: &str, value: bool) -> bool {
        match key {
            "thinking" => self.thinking = value,
            "tools" => self.tools = value,
            "usage" => self.usage = value,
            _ => return false,
        }
        true
    }
}

/// Persistent room_id → view settings.
pub struct ViewPrefs {
    rooms: HashMap<String, RoomView>,
    path: Option<PathBuf>,
}

impl ViewPrefs {
    pub const KEYS: [&'static str; 3] = ["thinking", "tools", "usage"];

    /// In-memory prefs with no persistence (tests).
    pub fn ephemeral() -> Self {
        Self {
            rooms: HashMap::new(),
            path: None,
        }
    }

    /// Load from `path`, starting empty if missing or unreadable.
    pub fn load(path: &Path) -> Self {
        let rooms = match std::fs::read_to_string(path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(rooms) => rooms,
                Err(e) => {
                    warn!(
                        "view prefs {} unreadable, starting fresh: {e}",
                        path.display()
                    );
                    HashMap::new()
                }
            },
            Err(_) => HashMap::new(),
        };
        Self {
            rooms,
            path: Some(path.to_path_buf()),
        }
    }

    pub fn room(&self, room_id: &str) -> RoomView {
        self.rooms.get(room_id).copied().unwrap_or_default()
    }

    /// Set `key` in a room. `value` of `None` toggles. Returns the new value,
    /// or `None` for an unknown key.
    pub fn set(&mut self, room_id: &str, key: &str, value: Option<bool>) -> Option<bool> {
        let mut view = self.room(room_id);
        let new_value = value.unwrap_or(!view.get(key)?);
        if !view.set(key, new_value) {
            return None;
        }
        self.rooms.insert(room_id.to_string(), view);
        self.save();
        Some(new_value)
    }

    fn save(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let json = match serde_json::to_string(&self.rooms) {
            Ok(j) => j,
            Err(e) => {
                warn!("failed to serialize view prefs: {e}");
                return;
            }
        };
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, path)) {
            warn!("failed to persist view prefs to {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_off() {
        let prefs = ViewPrefs::ephemeral();
        let view = prefs.room("!r:x");
        assert!(!view.thinking && !view.tools && !view.usage);
    }

    #[test]
    fn set_and_toggle_per_room() {
        let mut prefs = ViewPrefs::ephemeral();
        assert_eq!(prefs.set("!a:x", "thinking", Some(true)), Some(true));
        assert!(prefs.room("!a:x").thinking);
        assert!(!prefs.room("!b:x").thinking, "scoped to the room");

        // None toggles.
        assert_eq!(prefs.set("!a:x", "thinking", None), Some(false));
        assert_eq!(prefs.set("!a:x", "usage", None), Some(true));

        assert_eq!(prefs.set("!a:x", "bogus", Some(true)), None);
    }

    #[test]
    fn persistence_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");

        let mut prefs = ViewPrefs::load(&path);
        prefs.set("!a:x", "tools", Some(true));

        let reloaded = ViewPrefs::load(&path);
        assert!(reloaded.room("!a:x").tools);
        assert!(!reloaded.room("!a:x").thinking);
    }
}
