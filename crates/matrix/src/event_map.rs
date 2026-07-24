//! Bidirectional map between daemon message ids and Matrix events.
//!
//! The daemon's `resolve_ref` accepts literal msg_ids, so once a Matrix event
//! is mapped to a msg_id, that id can be used directly as the `ref`/`refs`
//! argument of `edit` / `delete` / `alt` commands. The map is what lets the
//! bridge translate Matrix-native interactions (edits, redactions, reactions)
//! into daemon mutations, and daemon-side mutations back into in-place Matrix
//! updates.
//!
//! Persisted as a JSON sidecar in the matrix store directory so mappings
//! survive bridge restarts. Bounded: oldest entries fall off past
//! [`EventMap::CAP`] — old messages simply lose Matrix-side interactivity.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::warn;

/// What kind of Matrix event backs a mapping.
///
/// Matrix only lets an account edit its *own* events, so daemon-side content
/// changes can be mirrored in place only for bot-authored events (`Assistant`
/// and `MirroredUser`); the user's own events (`MatrixUser`) can at most be
/// redacted (power levels permitting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventOrigin {
    /// Character reply posted by the bot.
    Assistant,
    /// Another client's user prompt, mirrored into the room by the bot.
    MirroredUser,
    /// The Matrix user's own message.
    MatrixUser,
}

impl EventOrigin {
    /// Whether the bot authored the Matrix event (and so can edit it).
    pub fn bot_editable(self) -> bool {
        matches!(self, Self::Assistant | Self::MirroredUser)
    }
}

/// One daemon-message ↔ Matrix-event correspondence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappedEvent {
    pub msg_id: String,
    pub room_id: String,
    pub event_id: String,
    pub origin: EventOrigin,
    /// Raw daemon content as last mirrored to / seen from the room. Compared
    /// against `History` broadcasts to detect daemon-side edits worth
    /// mirroring. (Display formatting, e.g. the mirrored-prompt blockquote,
    /// is applied at render time and never stored.)
    pub content: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    entries: VecDeque<MappedEvent>,
}

/// Bounded, persistent msg_id ↔ event_id map.
///
/// Entries are kept in insertion order; lookups scan from the back because
/// recent messages are the ones users interact with. The cap keeps both the
/// scan and the sidecar file trivially small.
pub struct EventMap {
    entries: VecDeque<MappedEvent>,
    path: Option<PathBuf>,
}

impl EventMap {
    pub const CAP: usize = 2000;

    /// In-memory map with no persistence (tests, and callers that opt out).
    pub fn ephemeral() -> Self {
        Self {
            entries: VecDeque::new(),
            path: None,
        }
    }

    /// Load from `path`, starting empty if the file is missing or unreadable.
    pub fn load(path: &Path) -> Self {
        let entries = match std::fs::read_to_string(path) {
            Ok(raw) => match serde_json::from_str::<Persisted>(&raw) {
                Ok(p) => p.entries,
                Err(e) => {
                    warn!(
                        "event map {} unreadable, starting fresh: {e}",
                        path.display()
                    );
                    VecDeque::new()
                }
            },
            Err(_) => VecDeque::new(),
        };
        Self {
            entries,
            path: Some(path.to_path_buf()),
        }
    }

    /// Insert a mapping, displacing any earlier entry for the same msg_id or
    /// event_id, and evicting the oldest entries past [`Self::CAP`].
    pub fn record(&mut self, entry: MappedEvent) {
        self.entries
            .retain(|e| e.msg_id != entry.msg_id && e.event_id != entry.event_id);
        self.entries.push_back(entry);
        while self.entries.len() > Self::CAP {
            self.entries.pop_front();
        }
        self.save();
    }

    pub fn by_msg_id(&self, msg_id: &str) -> Option<&MappedEvent> {
        self.entries.iter().rev().find(|e| e.msg_id == msg_id)
    }

    pub fn by_event_id(&self, event_id: &str) -> Option<&MappedEvent> {
        self.entries.iter().rev().find(|e| e.event_id == event_id)
    }

    /// The most recently recorded assistant reply in a room.
    ///
    /// Only conversation messages are recorded in the map, so this is the
    /// room's latest character reply — the regen target.
    pub fn latest_reply_in_room(&self, room_id: &str) -> Option<&MappedEvent> {
        self.entries
            .iter()
            .rev()
            .find(|e| e.room_id == room_id && e.origin == EventOrigin::Assistant)
    }

    /// Update the recorded room content for a msg_id (after mirroring an edit).
    pub fn update_content(&mut self, msg_id: &str, content: &str) {
        if let Some(e) = self.entries.iter_mut().rev().find(|e| e.msg_id == msg_id) {
            e.content = content.to_string();
            self.save();
        }
    }

    /// Drop the mapping for a msg_id, returning it if present.
    pub fn remove_msg(&mut self, msg_id: &str) -> Option<MappedEvent> {
        let pos = self.entries.iter().position(|e| e.msg_id == msg_id)?;
        let removed = self.entries.remove(pos);
        self.save();
        removed
    }

    /// Drop the mapping for a Matrix event, returning it if present.
    pub fn remove_event(&mut self, event_id: &str) -> Option<MappedEvent> {
        let pos = self.entries.iter().position(|e| e.event_id == event_id)?;
        let removed = self.entries.remove(pos);
        self.save();
        removed
    }

    /// Drop mappings in `room_id` whose msg_id is not in `live_ids`.
    ///
    /// Called with the msg_id set from a `History` broadcast. A message can
    /// leave the active history through deletion *or* compaction, and the two
    /// are indistinguishable here — so this only forgets the mapping (the
    /// Matrix copy stays). Targeted redaction happens from `delete` command
    /// outputs, which name exactly what was deleted.
    pub fn prune_missing(&mut self, room_id: &str, live_ids: &std::collections::HashSet<&str>) {
        let before = self.entries.len();
        self.entries
            .retain(|e| e.room_id != room_id || live_ids.contains(e.msg_id.as_str()));
        if self.entries.len() != before {
            self.save();
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let persisted = Persisted {
            entries: self.entries.clone(),
        };
        let json = match serde_json::to_string(&persisted) {
            Ok(j) => j,
            Err(e) => {
                warn!("failed to serialize event map: {e}");
                return;
            }
        };
        // Write-then-rename so a crash mid-write can't truncate the map.
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, path)) {
            warn!("failed to persist event map to {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn entry(msg_id: &str, event_id: &str) -> MappedEvent {
        MappedEvent {
            msg_id: msg_id.into(),
            room_id: "!room:example.com".into(),
            event_id: event_id.into(),
            origin: EventOrigin::Assistant,
            content: format!("content of {msg_id}"),
        }
    }

    #[test]
    fn record_and_lookup_both_directions() {
        let mut map = EventMap::ephemeral();
        map.record(entry("m1", "$e1"));

        assert_eq!(map.by_msg_id("m1").unwrap().event_id, "$e1");
        assert_eq!(map.by_event_id("$e1").unwrap().msg_id, "m1");
        assert!(map.by_msg_id("m2").is_none());
        assert!(map.by_event_id("$e2").is_none());
    }

    #[test]
    fn record_displaces_same_msg_id() {
        let mut map = EventMap::ephemeral();
        map.record(entry("m1", "$e1"));
        map.record(entry("m1", "$e2"));

        assert_eq!(map.by_msg_id("m1").unwrap().event_id, "$e2");
        assert!(map.by_event_id("$e1").is_none());
    }

    #[test]
    fn cap_evicts_oldest() {
        let mut map = EventMap::ephemeral();
        for i in 0..(EventMap::CAP + 10) {
            map.record(entry(&format!("m{i}"), &format!("$e{i}")));
        }
        assert!(map.by_msg_id("m0").is_none());
        assert!(map.by_msg_id(&format!("m{}", EventMap::CAP + 9)).is_some());
    }

    #[test]
    fn update_content_changes_stored_content() {
        let mut map = EventMap::ephemeral();
        map.record(entry("m1", "$e1"));
        map.update_content("m1", "new words");
        assert_eq!(map.by_msg_id("m1").unwrap().content, "new words");
    }

    #[test]
    fn remove_by_either_key() {
        let mut map = EventMap::ephemeral();
        map.record(entry("m1", "$e1"));
        map.record(entry("m2", "$e2"));

        let removed = map.remove_event("$e1").unwrap();
        assert_eq!(removed.msg_id, "m1");
        assert!(map.by_msg_id("m1").is_none());

        let removed = map.remove_msg("m2").unwrap();
        assert_eq!(removed.event_id, "$e2");
        assert!(map.by_event_id("$e2").is_none());
    }

    #[test]
    fn prune_missing_scopes_to_room() {
        let mut map = EventMap::ephemeral();
        map.record(entry("m1", "$e1"));
        map.record(entry("m2", "$e2"));
        let mut other = entry("m3", "$e3");
        other.room_id = "!other:example.com".into();
        map.record(other);

        let live: HashSet<&str> = ["m2"].into();
        map.prune_missing("!room:example.com", &live);

        assert!(map.by_msg_id("m1").is_none(), "m1 pruned");
        assert!(map.by_msg_id("m2").is_some(), "m2 still live");
        assert!(
            map.by_msg_id("m3").is_some(),
            "other room untouched by prune"
        );
    }

    #[test]
    fn latest_reply_skips_non_assistant_entries() {
        let mut map = EventMap::ephemeral();
        map.record(entry("m1", "$e1"));
        let mut user = entry("m2", "$e2");
        user.origin = EventOrigin::MatrixUser;
        map.record(user);
        let mut mirrored = entry("m3", "$e3");
        mirrored.origin = EventOrigin::MirroredUser;
        map.record(mirrored);

        let latest = map.latest_reply_in_room("!room:example.com").unwrap();
        assert_eq!(latest.msg_id, "m1");
        assert!(map.latest_reply_in_room("!other:example.com").is_none());
    }

    #[test]
    fn persistence_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("event-map.json");

        let mut map = EventMap::load(&path);
        map.record(entry("m1", "$e1"));
        map.record(entry("m2", "$e2"));

        let reloaded = EventMap::load(&path);
        assert_eq!(reloaded.by_msg_id("m1").unwrap().event_id, "$e1");
        assert_eq!(reloaded.by_event_id("$e2").unwrap().msg_id, "m2");
    }

    #[test]
    fn load_missing_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let map = EventMap::load(&dir.path().join("nope.json"));
        assert!(map.by_msg_id("m1").is_none());
    }
}
