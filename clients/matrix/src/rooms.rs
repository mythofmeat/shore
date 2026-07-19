use std::collections::HashMap;

/// Manages the mapping between Matrix rooms and characters.
///
/// Each character is bound to exactly one room, and each room is bound
/// to at most one character. Binding a character to a new room unbinds
/// it from the previous room (and vice versa).
#[derive(Default)]
pub struct RoomManager {
    room_to_char: HashMap<String, String>,
    char_to_room: HashMap<String, String>,
}

#[allow(dead_code)]
impl RoomManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind a room to a character (1:1 mapping, displaces old bindings).
    pub fn bind(&mut self, room_id: &str, character: &str) {
        // Remove old binding for this character
        if let Some(old_room) = self.char_to_room.remove(character) {
            self.room_to_char.remove(&old_room);
        }
        // Remove old binding for this room
        if let Some(old_char) = self.room_to_char.remove(room_id) {
            self.char_to_room.remove(&old_char);
        }
        self.room_to_char
            .insert(room_id.to_string(), character.to_string());
        self.char_to_room
            .insert(character.to_string(), room_id.to_string());
    }

    /// Remove the binding for a room.
    pub fn unbind_room(&mut self, room_id: &str) {
        if let Some(character) = self.room_to_char.remove(room_id) {
            self.char_to_room.remove(&character);
        }
    }

    /// Get the character bound to a room.
    pub fn character_for_room(&self, room_id: &str) -> Option<&str> {
        self.room_to_char.get(room_id).map(|s| s.as_str())
    }

    /// Get the room bound to a character.
    pub fn room_for_character(&self, character: &str) -> Option<&str> {
        self.char_to_room.get(character).map(|s| s.as_str())
    }

    /// Check if a room is bound to any character.
    pub fn is_bound(&self, room_id: &str) -> bool {
        self.room_to_char.contains_key(room_id)
    }

    /// Iterate over all bindings as (character, room_id) pairs.
    pub fn bindings(&self) -> impl Iterator<Item = (&str, &str)> {
        self.char_to_room
            .iter()
            .map(|(c, r)| (c.as_str(), r.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_and_lookup() {
        let mut mgr = RoomManager::new();
        mgr.bind("!room1:example.com", "Alice");

        assert_eq!(mgr.character_for_room("!room1:example.com"), Some("Alice"));
        assert_eq!(mgr.room_for_character("Alice"), Some("!room1:example.com"));
        assert!(mgr.is_bound("!room1:example.com"));
    }

    #[test]
    fn rebind_character_removes_old_room() {
        let mut mgr = RoomManager::new();
        mgr.bind("!room1:example.com", "Alice");
        mgr.bind("!room2:example.com", "Alice");

        assert_eq!(mgr.character_for_room("!room2:example.com"), Some("Alice"));
        assert_eq!(mgr.character_for_room("!room1:example.com"), None);
        assert_eq!(mgr.room_for_character("Alice"), Some("!room2:example.com"));
    }

    #[test]
    fn rebind_room_removes_old_character() {
        let mut mgr = RoomManager::new();
        mgr.bind("!room1:example.com", "Alice");
        mgr.bind("!room1:example.com", "Bob");

        assert_eq!(mgr.character_for_room("!room1:example.com"), Some("Bob"));
        assert_eq!(mgr.room_for_character("Alice"), None);
        assert_eq!(mgr.room_for_character("Bob"), Some("!room1:example.com"));
    }

    #[test]
    fn unbind_room() {
        let mut mgr = RoomManager::new();
        mgr.bind("!room1:example.com", "Alice");
        mgr.unbind_room("!room1:example.com");

        assert_eq!(mgr.character_for_room("!room1:example.com"), None);
        assert_eq!(mgr.room_for_character("Alice"), None);
        assert!(!mgr.is_bound("!room1:example.com"));
    }

    #[test]
    fn unbound_room_returns_none() {
        let mgr = RoomManager::new();
        assert_eq!(mgr.character_for_room("!nonexistent:example.com"), None);
        assert!(!mgr.is_bound("!nonexistent:example.com"));
    }

    #[test]
    fn multiple_characters_multiple_rooms() {
        let mut mgr = RoomManager::new();
        mgr.bind("!room1:example.com", "Alice");
        mgr.bind("!room2:example.com", "Bob");

        assert_eq!(mgr.character_for_room("!room1:example.com"), Some("Alice"));
        assert_eq!(mgr.character_for_room("!room2:example.com"), Some("Bob"));
        assert_eq!(mgr.room_for_character("Alice"), Some("!room1:example.com"));
        assert_eq!(mgr.room_for_character("Bob"), Some("!room2:example.com"));
    }

    #[test]
    fn bindings_iterator() {
        let mut mgr = RoomManager::new();
        mgr.bind("!room1:example.com", "Alice");
        mgr.bind("!room2:example.com", "Bob");

        let mut bindings: Vec<_> = mgr.bindings().collect();
        bindings.sort();
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0], ("Alice", "!room1:example.com"));
        assert_eq!(bindings[1], ("Bob", "!room2:example.com"));
    }

    #[test]
    fn unbind_nonexistent_is_noop() {
        let mut mgr = RoomManager::new();
        mgr.unbind_room("!nonexistent:example.com"); // should not panic
        assert!(!mgr.is_bound("!nonexistent:example.com"));
    }
}
