use crate::protocol::server_msg::ServerMessage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncDecision {
    Deliver,
    DropStale,
}

/// Dedup gate for a single connection's inbound stream.
///
/// `History` snapshots and `NewMessage` pushes carry independent meanings even
/// though they share the revision counter: a snapshot reflects the *whole*
/// conversation at a revision, while a push is *one* message at a revision. The
/// daemon emits both for the same append — `append_message` broadcasts a
/// `History` at revision N, then the handler emits the `NewMessage` also at
/// revision N — so a single shared watermark would let the snapshot suppress its
/// own paired push (`N <= N`). Clients that render from `NewMessage` (the Matrix
/// bridge's `mirror_all`) would then see nothing.
///
/// So we keep two watermarks. `snapshot_revision` drops stale `History`
/// snapshots on reconnect/reload; `message_revision` drops `NewMessage`s already
/// covered by the handshake snapshot (or redelivered). A mid-session `History`
/// never advances `message_revision`, so it can't shadow the push that follows
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SyncState {
    /// Highest revision delivered as a `NewMessage`; gates `NewMessage`.
    message_revision: u64,
    /// Highest revision delivered as a `History`; gates `History`.
    snapshot_revision: u64,
}

impl SyncState {
    pub(crate) fn new(initial_revision: u64) -> Self {
        Self {
            message_revision: initial_revision,
            snapshot_revision: initial_revision,
        }
    }

    /// Highest revision observed on either stream — for diagnostics only.
    pub(crate) fn latest_revision(&self) -> u64 {
        self.message_revision.max(self.snapshot_revision)
    }

    pub(crate) fn observe(&mut self, msg: &ServerMessage) -> SyncDecision {
        match msg {
            ServerMessage::History(history) => {
                if history.revision < self.snapshot_revision {
                    SyncDecision::DropStale
                } else {
                    self.snapshot_revision = history.revision;
                    SyncDecision::Deliver
                }
            }
            ServerMessage::NewMessage(message) => {
                if message.revision <= self.message_revision {
                    SyncDecision::DropStale
                } else {
                    self.message_revision = message.revision;
                    SyncDecision::Deliver
                }
            }
            ServerMessage::Hello(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::StreamStart(_)
            | ServerMessage::StreamChunk(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::Phase(_)
            | ServerMessage::ToolCall(_)
            | ServerMessage::ToolResult(_)
            | ServerMessage::SendImage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::Unknown => SyncDecision::Deliver,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::server_msg::{History, NewMessage};
    use crate::protocol::types::{Message, Role};

    fn message(id: &str) -> Message {
        Message {
            msg_id: id.into(),
            origin: None,
            role: Role::Assistant,
            content: "hello".into(),
            images: vec![],
            content_blocks: vec![],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn drops_stale_history_snapshots() {
        let mut sync = SyncState::new(5);
        let stale = ServerMessage::History(History {
            rid: None,
            messages: vec![message("m1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            revision: 4,
        });

        assert_eq!(sync.observe(&stale), SyncDecision::DropStale);
        assert_eq!(sync.latest_revision(), 5);
    }

    #[test]
    fn accepts_newer_history_snapshots() {
        let mut sync = SyncState::new(5);
        let newer = ServerMessage::History(History {
            rid: None,
            messages: vec![message("m1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            revision: 6,
        });

        assert_eq!(sync.observe(&newer), SyncDecision::Deliver);
        assert_eq!(sync.latest_revision(), 6);
    }

    #[test]
    fn drops_new_message_when_snapshot_already_covers_it() {
        let mut sync = SyncState::new(6);
        let message = ServerMessage::NewMessage(NewMessage {
            revision: 6,
            character: Some("alice".into()),
            message: message("m2"),
        });

        assert_eq!(sync.observe(&message), SyncDecision::DropStale);
    }

    fn new_message(revision: u64) -> ServerMessage {
        ServerMessage::NewMessage(NewMessage {
            revision,
            character: Some("alice".into()),
            message: message("m"),
        })
    }

    fn history(revision: u64) -> ServerMessage {
        ServerMessage::History(History {
            rid: None,
            messages: vec![message("m")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            revision,
        })
    }

    // Regression: `append_message` broadcasts a `History` at revision N, then the
    // handler emits the paired `NewMessage` also at revision N. The snapshot must
    // not suppress its own push, or `mirror_all` clients see nothing.
    #[test]
    fn history_does_not_shadow_paired_new_message_at_same_revision() {
        let mut sync = SyncState::new(5);

        assert_eq!(sync.observe(&history(6)), SyncDecision::Deliver);
        assert_eq!(sync.observe(&new_message(6)), SyncDecision::Deliver);

        // The next append: History(7) then NewMessage(7) both deliver too.
        assert_eq!(sync.observe(&history(7)), SyncDecision::Deliver);
        assert_eq!(sync.observe(&new_message(7)), SyncDecision::Deliver);
    }

    // A delivered `NewMessage` advances its own watermark, so a redelivered push
    // at the same revision is still dropped.
    #[test]
    fn new_message_dedupes_against_delivered_messages() {
        let mut sync = SyncState::new(5);

        assert_eq!(sync.observe(&new_message(6)), SyncDecision::Deliver);
        assert_eq!(sync.observe(&new_message(6)), SyncDecision::DropStale);
        assert_eq!(sync.observe(&new_message(7)), SyncDecision::Deliver);
    }
}
