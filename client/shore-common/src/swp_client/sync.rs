use crate::protocol::server_msg::ServerMessage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncDecision {
    Deliver,
    DropStale,
    Resync,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SyncState {
    selected_character: Option<String>,
    selected_thread: Option<String>,
    message_revision: u64,
    snapshot_revision: u64,
}

impl SyncState {
    pub(crate) fn new(
        initial_revision: u64,
        selected_character: Option<&str>,
        selected_thread: Option<&str>,
    ) -> Self {
        Self {
            selected_character: selected_character.map(str::to_owned),
            selected_thread: selected_thread.map(str::to_owned),
            message_revision: initial_revision,
            snapshot_revision: initial_revision,
        }
    }

    pub(crate) fn selected_character(&self) -> Option<&str> {
        self.selected_character.as_deref()
    }

    pub(crate) fn selected_thread(&self) -> Option<&str> {
        self.selected_thread.as_deref()
    }

    pub(crate) fn latest_revision(&self) -> u64 {
        self.message_revision.max(self.snapshot_revision)
    }

    pub(crate) fn observe(&mut self, msg: &ServerMessage) -> SyncDecision {
        match msg {
            ServerMessage::History(history) => {
                if let Some(delta) = &history.delta {
                    if history.selected_character != self.selected_character
                        || history.selected_thread.as_deref().unwrap_or("main")
                            != self.selected_thread.as_deref().unwrap_or("main")
                        || history.revision <= self.snapshot_revision
                    {
                        return SyncDecision::DropStale;
                    }
                    if delta.base_revision != self.snapshot_revision {
                        return SyncDecision::Resync;
                    }
                    self.snapshot_revision = history.revision;
                    return SyncDecision::Deliver;
                }

                let moved = history.selected_character != self.selected_character
                    || (history.selected_thread.is_some()
                        && history.selected_thread != self.selected_thread);
                if moved {
                    self.selected_character
                        .clone_from(&history.selected_character);
                    self.selected_thread.clone_from(&history.selected_thread);
                    self.message_revision = history.revision;
                    self.snapshot_revision = history.revision;
                    return SyncDecision::Deliver;
                }
                if history.revision < self.snapshot_revision {
                    SyncDecision::DropStale
                } else {
                    self.snapshot_revision = history.revision;
                    SyncDecision::Deliver
                }
            }
            ServerMessage::NewMessage(message) => {
                if message.character != self.selected_character
                    || message.thread.as_deref().unwrap_or("main")
                        != self.selected_thread.as_deref().unwrap_or("main")
                {
                    return SyncDecision::DropStale;
                }
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
            | ServerMessage::ProviderWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::RequestAccepted(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::Unknown => SyncDecision::Deliver,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::server_msg::{History, NewMessage};
    use crate::protocol::types::{Message, Role};

    #[test]
    fn shared_browser_sync_sequences() {
        #[derive(serde::Deserialize)]
        struct Initial {
            revision: u64,
            character: Option<String>,
            thread: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Step {
            event: ServerMessage,
            decision: String,
            latest_revision: u64,
            character: Option<String>,
            thread: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Sequence {
            name: String,
            initial: Initial,
            steps: Vec<Step>,
        }
        let sequences: Vec<Sequence> =
            serde_json::from_str(include_str!("../../../../fixtures/protocol/sync.json")).unwrap();
        for sequence in sequences {
            let mut sync = SyncState::new(
                sequence.initial.revision,
                sequence.initial.character.as_deref(),
                sequence.initial.thread.as_deref(),
            );
            for (index, step) in sequence.steps.into_iter().enumerate() {
                let observed = match sync.observe(&step.event) {
                    SyncDecision::Deliver => "deliver",
                    SyncDecision::DropStale => "drop_stale",
                    SyncDecision::Resync => "resync",
                };
                assert_eq!(observed, step.decision, "{} step {index}", sequence.name);
                assert_eq!(
                    sync.latest_revision(),
                    step.latest_revision,
                    "{} step {index}",
                    sequence.name
                );
                assert_eq!(
                    sync.selected_character(),
                    step.character.as_deref(),
                    "{} step {index}",
                    sequence.name
                );
                assert_eq!(
                    sync.selected_thread(),
                    step.thread.as_deref(),
                    "{} step {index}",
                    sequence.name
                );
            }
        }
    }

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
    fn deltas_require_a_contiguous_revision_in_the_selected_thread() {
        let mut sync = SyncState::new(5, Some("ada"), Some("main"));
        let delta = |base, revision, thread: &str| {
            serde_json::from_value::<ServerMessage>(serde_json::json!({
            "type": "history", "messages": [], "selected_character": "ada", "selected_thread": thread,
            "revision": revision, "delta": {"base_revision": base, "after": null}
        })).unwrap()
        };
        assert_eq!(sync.observe(&delta(5, 6, "side")), SyncDecision::DropStale);
        assert_eq!(sync.observe(&delta(5, 6, "main")), SyncDecision::Deliver);
        assert_eq!(sync.observe(&delta(5, 6, "main")), SyncDecision::DropStale);
        assert_eq!(sync.observe(&delta(7, 8, "main")), SyncDecision::Resync);
        assert_eq!(sync.latest_revision(), 6);
    }

    #[test]
    fn drops_stale_history_snapshots() {
        let mut sync = SyncState::new(5, Some("alice"), None);
        let stale = ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![message("m1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            selected_thread: None,
            revision: 4,
        });

        assert_eq!(sync.observe(&stale), SyncDecision::DropStale);
        assert_eq!(sync.latest_revision(), 5);
    }

    #[test]
    fn accepts_newer_history_snapshots() {
        let mut sync = SyncState::new(5, Some("alice"), None);
        let newer = ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![message("m1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            selected_thread: None,
            revision: 6,
        });

        assert_eq!(sync.observe(&newer), SyncDecision::Deliver);
        assert_eq!(sync.latest_revision(), 6);
    }

    #[test]
    fn drops_new_message_when_snapshot_already_covers_it() {
        let mut sync = SyncState::new(6, Some("alice"), None);
        let message = ServerMessage::NewMessage(NewMessage {
            rid: None,
            thread: None,
            revision: 6,
            character: Some("alice".into()),
            message: message("m2"),
        });

        assert_eq!(sync.observe(&message), SyncDecision::DropStale);
    }

    fn new_message(revision: u64) -> ServerMessage {
        ServerMessage::NewMessage(NewMessage {
            rid: None,
            thread: None,
            revision,
            character: Some("alice".into()),
            message: message("m"),
        })
    }

    #[test]
    fn foreign_thread_revision_does_not_suppress_selected_thread_messages() {
        let mut sync = SyncState::new(1, Some("alice"), Some("main"));
        let foreign = ServerMessage::NewMessage(NewMessage {
            rid: None,
            thread: Some("side".into()),
            revision: 99,
            character: Some("alice".into()),
            message: message("foreign"),
        });
        assert_eq!(sync.observe(&foreign), SyncDecision::DropStale);
        assert_eq!(sync.latest_revision(), 1);
        assert_eq!(sync.observe(&new_message(2)), SyncDecision::Deliver);
    }

    fn history(revision: u64) -> ServerMessage {
        ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![message("m")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            selected_thread: None,
            revision,
        })
    }

    #[test]
    fn history_does_not_shadow_paired_new_message_at_same_revision() {
        let mut sync = SyncState::new(5, Some("alice"), None);

        assert_eq!(sync.observe(&history(6)), SyncDecision::Deliver);
        assert_eq!(sync.observe(&new_message(6)), SyncDecision::Deliver);

        assert_eq!(sync.observe(&history(7)), SyncDecision::Deliver);
        assert_eq!(sync.observe(&new_message(7)), SyncDecision::Deliver);
    }

    #[test]
    fn new_message_dedupes_against_delivered_messages() {
        let mut sync = SyncState::new(5, Some("alice"), None);

        assert_eq!(sync.observe(&new_message(6)), SyncDecision::Deliver);
        assert_eq!(sync.observe(&new_message(6)), SyncDecision::DropStale);
        assert_eq!(sync.observe(&new_message(7)), SyncDecision::Deliver);
    }

    #[test]
    fn switching_character_resets_independent_revision_watermarks() {
        let mut sync = SyncState::new(650, Some("frank"), None);
        let switched = ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![message("y1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("Yuna".into()),
            selected_thread: None,
            revision: 12,
        });

        assert_eq!(sync.observe(&switched), SyncDecision::Deliver);
        assert_eq!(sync.latest_revision(), 12);
    }

    #[test]
    fn switching_thread_resets_the_watermark_even_when_the_new_thread_is_behind() {
        let mut sync = SyncState::new(40, Some("alice"), Some("main"));
        let switched = ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![message("e1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            selected_thread: Some("eval".into()),
            revision: 2,
        });

        assert_eq!(sync.observe(&switched), SyncDecision::Deliver);
        assert_eq!(sync.latest_revision(), 2);
        assert_eq!(sync.selected_thread(), Some("eval"));
    }

    #[test]
    fn staying_in_the_same_thread_still_drops_a_stale_snapshot() {
        let mut sync = SyncState::new(5, Some("alice"), Some("eval"));
        let stale = ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![message("m1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            selected_thread: Some("eval".into()),
            revision: 4,
        });

        assert_eq!(sync.observe(&stale), SyncDecision::DropStale);
        assert_eq!(sync.latest_revision(), 5);
    }

    #[test]
    fn a_daemon_that_names_no_thread_never_looks_like_a_move() {
        let mut sync = SyncState::new(5, Some("alice"), Some("eval"));
        let quiet = ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![message("m1")],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: Some("alice".into()),
            selected_thread: None,
            revision: 4,
        });

        assert_eq!(sync.observe(&quiet), SyncDecision::DropStale);
        assert_eq!(sync.selected_thread(), Some("eval"));
    }

    #[test]
    fn drops_new_messages_for_another_character() {
        let mut sync = SyncState::new(5, Some("alice"), None);
        let foreign = ServerMessage::NewMessage(NewMessage {
            rid: None,
            thread: None,
            revision: 99,
            character: Some("bob".into()),
            message: message("b99"),
        });

        assert_eq!(sync.observe(&foreign), SyncDecision::DropStale);
        assert_eq!(sync.latest_revision(), 5);
    }
}
