#[derive(Default)]
pub(crate) struct StreamState {
    pub active: bool,
    pub regen: bool,
    pub phase: String,
    pub tool_name: Option<String>,
    pub subagent: Option<String>,
}

impl StreamState {
    pub(crate) fn reset(&mut self) {
        self.active = false;
        self.regen = false;
        self.phase.clear();
        self.tool_name = None;
        self.subagent = None;
    }
}
