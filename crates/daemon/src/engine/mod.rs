pub(crate) mod atomic;
pub mod messages;
pub mod prompt;
pub mod segments;
pub mod tools;

use std::path::PathBuf;

use messages::MessageStore;
use segments::SegmentReader;
use shore_common::protocol::server_msg::{History, ServerMessage};
use shore_common::protocol::types::Message;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

/// Errors originating from the conversation engine.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("I/O error on {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("failed to parse {path}: {source}")]
    JsonParse {
        path: PathBuf,
        source: serde_json::Error,
    },

    #[error("failed to serialize {context}: {source}")]
    JsonSerialize {
        context: String,
        source: serde_json::Error,
    },

    #[error("message not found: {0}")]
    MessageNotFound(String),

    #[error("{0}")]
    InvalidAlt(String),

    #[error("character not found: {0}")]
    CharacterNotFound(String),
}

/// Per-character conversation engine.
///
/// Manages a single continuous conversation per character. Messages in
/// `active.jsonl` form the current context window; frozen history lives
/// in numbered segment files managed by `SegmentReader`.
///
/// State changes are broadcast as `History` messages to all connected clients.
#[derive(Debug)]
pub struct ConversationEngine {
    character_name: String,
    character_dir: PathBuf,
    messages: MessageStore,
    segments: SegmentReader,
    revision: u64,
    history_rewrite_generation: u64,
    push_tx: broadcast::Sender<ServerMessage>,
}

impl ConversationEngine {
    /// Create a new engine for the given character.
    ///
    /// `data_dir` is `$XDG_DATA_HOME/shore` (the engine derives the per-character
    /// path from `character_name`).
    pub fn new<P: AsRef<std::path::Path>>(
        character_name: String,
        data_dir: P,
        push_tx: broadcast::Sender<ServerMessage>,
    ) -> Result<Self, EngineError> {
        let character_dir = data_dir.as_ref().join(&character_name);
        info!(
            character = %character_name,
            dir = %character_dir.display(),
            "initializing conversation engine"
        );
        let messages =
            MessageStore::load(character_dir.join(shore_common::config::ACTIVE_JSONL_FILE))?;
        let segments = SegmentReader::load(&character_dir)?;
        info!(
            character = %character_name,
            active_messages = messages.message_count(),
            segments = segments.segment_count(),
            total_compacted = segments.total_message_count(),
            "engine loaded"
        );

        Ok(Self {
            character_name,
            character_dir,
            messages,
            segments,
            revision: 0,
            history_rewrite_generation: 0,
            push_tx,
        })
    }

    /// The character this engine manages.
    pub fn character_name(&self) -> &str {
        &self.character_name
    }

    /// The character data directory.
    pub fn character_dir(&self) -> &PathBuf {
        &self.character_dir
    }

    // ── Message access ───────────────────────────────────────────────────

    /// Get the active conversation messages (context window).
    pub fn messages(&self) -> &[Message] {
        self.messages.messages()
    }

    /// Number of messages in the active context window.
    pub fn message_count(&self) -> usize {
        self.messages.message_count()
    }

    /// Number of user turns in the active context window.
    pub fn turn_count(&self) -> usize {
        self.messages.turn_count()
    }

    /// Access the segment reader for historical messages.
    pub fn segments(&self) -> &SegmentReader {
        &self.segments
    }

    /// Client-visible conversation history: archived scrollback first, then
    /// the active context tail. The returned index marks where active context
    /// begins after tool-loop message merging.
    pub fn display_history(&self) -> (Vec<Message>, usize) {
        let mut archived_raw = Vec::new();
        for index in 0..self.segments.segment_count() {
            match self.segments.read_segment(index) {
                Ok(mut messages) => archived_raw.append(&mut messages),
                Err(error) => warn!(
                    character = %self.character_name,
                    segment = index,
                    error = %error,
                    "failed to load archived conversation segment for display"
                ),
            }
        }

        let mut archived = shore_common::protocol::merge::merge_tool_loop_messages(&archived_raw);
        let active_start = archived.len();
        let mut active =
            shore_common::protocol::merge::merge_tool_loop_messages(self.messages.messages());
        archived.append(&mut active);
        (archived, active_start)
    }

    pub fn current_revision(&self) -> u64 {
        self.revision
    }

    /// Generation that advances only when existing history is rewritten.
    ///
    /// Normal append-only turns keep long-lived provider subprocesses warm.
    /// Regen, compaction reloads, edits, deletes, and resets must rotate any
    /// provider state that may still remember discarded turns.
    pub fn history_rewrite_generation(&self) -> u64 {
        self.history_rewrite_generation
    }

    fn advance_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    fn advance_history_rewrite_generation(&mut self) {
        self.history_rewrite_generation = self.history_rewrite_generation.saturating_add(1);
    }

    // ── Message CRUD ────────────────────────────────────────────────────

    /// Append a message to the active conversation and broadcast a `History`
    /// snapshot so all connected clients stay in sync.
    pub fn append_message(&mut self, msg: Message) -> Result<(), EngineError> {
        debug!(character = %self.character_name, msg_id = %msg.msg_id, role = ?msg.role, "appending message");
        self.messages.append(msg)?;
        self.advance_revision();
        self.broadcast_history();
        Ok(())
    }

    /// Insert a message at its chronological position in the active
    /// conversation, then broadcast a `History` snapshot.
    ///
    /// Used when the caller may race with normal appends (e.g. a heartbeat
    /// tick that completed while a user message landed first).
    pub fn insert_message_by_timestamp(&mut self, msg: Message) -> Result<(), EngineError> {
        debug!(character = %self.character_name, msg_id = %msg.msg_id, role = ?msg.role, "inserting message by timestamp");
        self.messages.insert_by_timestamp(msg)?;
        self.advance_revision();
        self.broadcast_history();
        Ok(())
    }

    /// Edit a message in the active conversation.
    pub fn edit_message(&mut self, msg_id: &str, new_content: &str) -> Result<(), EngineError> {
        debug!(character = %self.character_name, msg_id, "editing message");
        self.messages.edit(msg_id, new_content)?;
        self.advance_history_rewrite_generation();
        self.advance_revision();
        self.broadcast_history();
        Ok(())
    }

    /// Delete a message from the active conversation.
    pub fn delete_message(&mut self, msg_id: &str) -> Result<(), EngineError> {
        debug!(character = %self.character_name, msg_id, "deleting message");
        self.messages.delete(msg_id)?;
        self.advance_history_rewrite_generation();
        self.advance_revision();
        self.broadcast_history();
        Ok(())
    }

    /// Remove every message after the last real user turn (for regen).
    pub fn truncate_after_last_user_turn(&mut self) -> Result<usize, EngineError> {
        let removed = self.messages.truncate_after_last_user_turn()?;
        if removed > 0 {
            debug!(character = %self.character_name, removed, "truncated after last user turn");
            self.advance_history_rewrite_generation();
            self.advance_revision();
            self.broadcast_history();
        }
        Ok(removed)
    }

    /// Clone messages through the last real user turn for regeneration prompts.
    pub fn messages_through_last_user_turn(&self) -> Vec<Message> {
        self.messages.messages_through_last_user_turn()
    }

    /// Capture existing alternatives for the response being regenerated.
    pub fn pending_regen_alt(&self) -> Option<messages::PendingAlt> {
        self.messages.pending_regen_alt()
    }

    /// Replace the current response tail after a successful regeneration.
    pub fn replace_after_last_user_turn(
        &mut self,
        new_messages: Vec<Message>,
    ) -> Result<usize, EngineError> {
        let removed = self.messages.replace_after_last_user_turn(new_messages)?;
        debug!(
            character = %self.character_name,
            removed,
            "replaced tail after last user turn"
        );
        self.advance_history_rewrite_generation();
        self.advance_revision();
        self.broadcast_history();
        Ok(removed)
    }

    /// Set alternate-response state on a message.
    pub fn set_alt(&mut self, msg_id: &str, index: u32, count: u32) -> Result<(), EngineError> {
        self.messages.set_alt(msg_id, index, count)?;
        self.advance_revision();
        self.broadcast_history();
        Ok(())
    }

    /// Add an alternate-response candidate to a message.
    pub fn add_alt_candidate(&mut self, msg_id: &str) -> Result<u32, EngineError> {
        let count = self.messages.add_alt_candidate(msg_id)?;
        self.advance_revision();
        self.broadcast_history();
        Ok(count)
    }

    /// Select a stored alternate response.
    pub fn select_alt(
        &mut self,
        msg_id: &str,
        index: u32,
    ) -> Result<messages::AltSelection, EngineError> {
        let selection = self.messages.select_alt(msg_id, index)?;
        self.advance_history_rewrite_generation();
        self.advance_revision();
        self.broadcast_history();
        Ok(selection)
    }

    /// Clear all messages from the active conversation and broadcast.
    pub fn reset(&mut self) -> Result<(), EngineError> {
        info!(character = %self.character_name, "resetting conversation");
        self.messages.clear()?;
        self.advance_history_rewrite_generation();
        self.advance_revision();
        self.broadcast_history();
        Ok(())
    }

    /// Reload messages and segments from disk (e.g. after compaction with retention).
    pub fn reload(&mut self) -> Result<(), EngineError> {
        info!(character = %self.character_name, "reloading engine from disk");
        self.messages = MessageStore::load(
            self.character_dir
                .join(shore_common::config::ACTIVE_JSONL_FILE),
        )?;
        self.segments = SegmentReader::load(&self.character_dir)?;
        info!(
            character = %self.character_name,
            active_messages = self.messages.message_count(),
            segments = self.segments.segment_count(),
            "engine reloaded"
        );
        self.advance_history_rewrite_generation();
        self.advance_revision();
        self.broadcast_history();
        Ok(())
    }

    // ── Internal ────────────────────────────────────────────────────────

    /// Broadcast the current History snapshot to all connected clients.
    ///
    /// Tool-loop messages are merged into single assistant turns so clients
    /// receive clean, logical messages rather than raw protocol intermediates.
    pub fn broadcast_history(&self) {
        let history = ServerMessage::History(self.history_snapshot(serde_json::json!({})));

        // Ignore send errors — means no receivers are listening.
        let _ignored = self.push_tx.send(history);
    }

    pub fn history_snapshot(&self, config: serde_json::Value) -> History {
        // Embed image data so remote clients (TUI, matrix bridge) can render
        // attachments without daemon-local filesystem access. This snapshot
        // drives both `broadcast_history` (which fires after every state
        // change and triggers a full cache rebuild on the TUI) and
        // `build_session_history_snapshot` (initial handshake / character
        // switch / post-reload re-push), so dropping embedding here makes
        // images vanish on remote clients the moment the daemon broadcasts
        // any state change.
        let mut messages =
            shore_common::protocol::merge::merge_tool_loop_messages(self.messages.messages());
        crate::handler::embed_messages_image_data(&mut messages);
        History {
            rid: None,
            messages,
            active_start: 0,
            config,
            selected_character: Some(self.character_name.clone()),
            revision: self.revision,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shore_common::protocol::types::Role;
    use tempfile::TempDir;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    fn make_engine(tmp: &TempDir) -> (ConversationEngine, broadcast::Receiver<ServerMessage>) {
        let (push_tx, push_rx) = broadcast::channel(16);
        let engine = ConversationEngine::new("TestChar".to_owned(), tmp.path(), push_tx).unwrap();
        (engine, push_rx)
    }

    fn make_msg(id: &str, role: Role, content: &str) -> Message {
        use shore_common::protocol::types::ContentBlock;
        Message {
            msg_id: id.to_owned(),
            origin: None,
            role,
            content: content.to_owned(),
            images: vec![],
            content_blocks: if content.is_empty() {
                vec![]
            } else {
                vec![ContentBlock::Text {
                    text: content.to_owned(),
                }]
            },
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".to_owned(),
        }
    }

    use crate::test_support::write_jsonl;

    #[test]
    fn engine_starts_with_empty_messages() {
        let tmp = TempDir::new().unwrap();
        let (engine, _rx) = make_engine(&tmp);
        assert!(engine.messages().is_empty());
        assert_eq!(engine.message_count(), 0);
    }

    #[test]
    fn append_and_read_messages() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, _rx) = make_engine(&tmp);

        engine
            .append_message(make_msg("m1", Role::User, "Hello"))
            .unwrap();
        assert_eq!(engine.messages().len(), 1);
        assert_eq!(engine.messages()[0].content, "Hello");
        assert_eq!(engine.message_count(), 1);
        assert_eq!(
            engine.history_rewrite_generation(),
            0,
            "append-only turns must not rotate long-lived provider state"
        );
    }

    #[test]
    fn history_rewrite_generation_advances_only_for_rewrites() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, _rx) = make_engine(&tmp);

        engine
            .append_message(make_msg("m1", Role::User, "Hello"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "Hi"))
            .unwrap();
        assert_eq!(engine.history_rewrite_generation(), 0);

        let _ignored = engine.truncate_after_last_user_turn().unwrap();
        assert_eq!(engine.history_rewrite_generation(), 1);

        engine.edit_message("m1", "Hello again").unwrap();
        assert_eq!(engine.history_rewrite_generation(), 2);

        engine.delete_message("m1").unwrap();
        assert_eq!(engine.history_rewrite_generation(), 3);
    }

    #[test]
    fn state_changes_broadcast_history() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut rx) = make_engine(&tmp);

        // append_message broadcasts.
        engine
            .append_message(make_msg("m1", Role::User, "Hi"))
            .unwrap();
        let msg = rx.try_recv().unwrap();
        assert_variant!(

            msg,
            ServerMessage::History(h) => {
                assert_eq!(h.revision, 1);
                assert_eq!(h.messages.len(), 1);
                assert_eq!(h.messages[0].content, "Hi");
            }

        );

        // edit_message broadcasts.
        engine.edit_message("m1", "Hello").unwrap();
        let edit_msg = rx.try_recv().unwrap();
        assert_variant!(

            edit_msg,
            ServerMessage::History(h) => {
                assert_eq!(h.revision, 2);
                assert_eq!(h.messages[0].content, "Hello");
            }

        );

        // delete_message broadcasts.
        engine.delete_message("m1").unwrap();
        let delete_msg = rx.try_recv().unwrap();
        assert_variant!(

            delete_msg,
            ServerMessage::History(h) => {
                assert_eq!(h.revision, 3);
                assert!(h.messages.is_empty());
            }

        );
    }

    #[test]
    fn history_snapshot_embeds_image_data_for_remote_clients() {
        // Remote clients (TUI, matrix bridge) clear their image cache on every
        // History broadcast and rebuild from `images[].data`. If embedding is
        // dropped here, any state-change broadcast wipes attachments off the
        // remote client's screen even though the daemon still has the file.
        use base64::Engine as _;
        use shore_common::protocol::types::ImageRef;

        let tmp = TempDir::new().unwrap();
        let img_path = tmp.path().join("remote-client-image.bin");
        let bytes = b"image bytes visible over swp";
        std::fs::write(&img_path, bytes).unwrap();

        let (mut engine, _rx) = make_engine(&tmp);
        let mut msg = make_msg("m1", Role::Assistant, "an image");
        msg.images.push(ImageRef {
            path: img_path.to_string_lossy().to_string(),
            caption: Some("remote".into()),
            data: None,
        });
        engine.append_message(msg).unwrap();

        let history = engine.history_snapshot(serde_json::json!({}));
        let data = history.messages[0].images[0].data.as_deref().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap(),
            bytes
        );
    }

    #[test]
    fn display_history_includes_archived_segments_before_active_tail() {
        let tmp = TempDir::new().unwrap();
        let character_dir = tmp.path().join("TestChar");
        let segments_dir = character_dir.join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();

        let archived = vec![
            make_msg("m1", Role::User, "archived question"),
            make_msg("m2", Role::Assistant, "archived answer"),
        ];
        write_jsonl(&segments_dir.join("0001.jsonl"), &archived);
        let manifest = segments::CompactionManifest {
            segments: vec![segments::SegmentEntry {
                file: "0001.jsonl".into(),
                message_count: archived.len(),
                compacted_at: "2026-01-01T00:00:00Z".into(),
            }],
            total_compacted_messages: archived.len(),
        };
        std::fs::write(
            character_dir.join("compaction.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let active = vec![make_msg("m3", Role::User, "active question")];
        write_jsonl(&character_dir.join("active.jsonl"), &active);

        let (engine, _rx) = make_engine(&tmp);
        let (messages, active_start) = engine.display_history();
        let ids: Vec<&str> = messages.iter().map(|msg| msg.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2", "m3"]);
        assert_eq!(active_start, 2);
    }

    #[test]
    fn history_snapshot_stays_active_only_even_with_archived_segments() {
        let tmp = TempDir::new().unwrap();
        let character_dir = tmp.path().join("TestChar");
        let segments_dir = character_dir.join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();

        let archived = vec![make_msg("m1", Role::User, "archived question")];
        write_jsonl(&segments_dir.join("0001.jsonl"), &archived);
        let manifest = segments::CompactionManifest {
            segments: vec![segments::SegmentEntry {
                file: "0001.jsonl".into(),
                message_count: archived.len(),
                compacted_at: "2026-01-01T00:00:00Z".into(),
            }],
            total_compacted_messages: archived.len(),
        };
        std::fs::write(
            character_dir.join("compaction.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let active = vec![make_msg("m2", Role::User, "active question")];
        write_jsonl(&character_dir.join("active.jsonl"), &active);

        let (engine, _rx) = make_engine(&tmp);
        let history = engine.history_snapshot(serde_json::json!({}));
        let ids: Vec<&str> = history
            .messages
            .iter()
            .map(|msg| msg.msg_id.as_str())
            .collect();
        assert_eq!(ids, vec!["m2"]);
        assert_eq!(history.active_start, 0);
    }

    #[test]
    fn reset_clears_messages_and_broadcasts() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut rx) = make_engine(&tmp);

        engine
            .append_message(make_msg("m1", Role::User, "Hello"))
            .unwrap();
        let _ignored = rx.try_recv(); // drain append broadcast

        engine.reset().unwrap();
        assert!(engine.messages().is_empty());

        let msg = rx.try_recv().unwrap();
        assert_variant!(

            msg,
            ServerMessage::History(h) => {
                assert_eq!(h.revision, 2);
                assert!(h.messages.is_empty());
            }

        );
    }

    #[test]
    fn data_persisted_to_active_jsonl() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, _rx) = make_engine(&tmp);

        engine
            .append_message(make_msg("m1", Role::User, "Hello"))
            .unwrap();

        // Verify active.jsonl exists at the expected path.
        let active_path = tmp.path().join("TestChar").join("active.jsonl");
        assert!(active_path.exists());
    }

    #[test]
    fn engine_reloads_messages() {
        let tmp = TempDir::new().unwrap();

        // First engine instance — add messages.
        {
            let (push_tx, _) = broadcast::channel(16);
            let mut engine =
                ConversationEngine::new("ReloadChar".to_owned(), tmp.path(), push_tx).unwrap();
            engine
                .append_message(make_msg("m1", Role::User, "Persisted"))
                .unwrap();
        }

        // Second engine instance — should reload.
        let (push_tx, _) = broadcast::channel(16);
        let engine = ConversationEngine::new("ReloadChar".to_owned(), tmp.path(), push_tx).unwrap();

        assert_eq!(engine.messages().len(), 1);
        assert_eq!(engine.messages()[0].content, "Persisted");
    }
}
