use super::ConversationEntry;

#[derive(Default)]
pub(crate) struct StreamState {
    pub active: bool,
    pub rid: Option<String>,
    pub regen: bool,
    pub replacing: Vec<String>,
    pub phase: String,
    pub tool_name: Option<String>,
}

impl StreamState {
    pub(crate) fn reset(&mut self) {
        self.active = false;
        self.rid = None;
        self.regen = false;
        self.replacing.clear();
        self.phase.clear();
        self.tool_name = None;
    }

    pub(crate) fn hides(&self, entry: &ConversationEntry) -> bool {
        self.regen
            && entry
                .msg_id()
                .is_some_and(|id| self.replacing.iter().any(|old| old == id))
    }
}
