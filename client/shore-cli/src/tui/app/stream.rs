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
