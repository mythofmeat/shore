use std::ops::Range;

use shore_common::protocol::types::Message;

use super::ConversationEntry;

#[derive(Default)]
pub(crate) struct StreamState {
    pub active: bool,
    pub rid: Option<String>,
    pub regen: bool,
    pub phase: String,
    pub tool_name: Option<String>,
}

impl StreamState {
    pub(crate) fn reset(&mut self) {
        self.active = false;
        self.rid = None;
        self.regen = false;
        self.phase.clear();
        self.tool_name = None;
    }
}

#[derive(Default)]
pub(crate) struct Replaced {
    pub ids: Vec<String>,
    pub tail: Range<usize>,
    pub replacement: Option<String>,
}

impl Replaced {
    pub(crate) fn tail_of(entries: &[ConversationEntry]) -> Self {
        let start = entries
            .iter()
            .rposition(|entry| match entry {
                ConversationEntry::Turn(turn) => turn.is_real_user_turn(),
                ConversationEntry::System { .. } => false,
            })
            .map_or(0, |index| index.saturating_add(1));
        Self {
            ids: entries
                .iter()
                .skip(start)
                .filter_map(|entry| entry.msg_id().map(str::to_owned))
                .collect(),
            tail: start..entries.len(),
            replacement: None,
        }
    }

    pub(crate) fn replaces(&self, id: &str) -> bool {
        self.ids.iter().any(|old| old == id)
    }

    pub(crate) fn hides(&self, index: usize, entry: &ConversationEntry) -> bool {
        match entry.msg_id() {
            Some(id) => self.replaces(id),
            None => self.tail.contains(&index),
        }
    }

    pub(crate) fn rebuilt_from(&mut self, index: usize, messages: &[Message]) {
        let landed = self.replacement.as_ref().is_some_and(|replacement| {
            messages
                .iter()
                .any(|message| &message.msg_id == replacement)
        });
        if landed {
            *self = Self::default();
        } else {
            self.tail.end = self.tail.end.min(index);
        }
    }
}
