/// Cross-phase scalars for an in-progress response.
///
/// Streaming *content* lives directly in `App.entries` as the trailing
/// `Turn` with `state: Streaming` — its blocks are mutated in place by the
/// stream handlers. This struct only holds the scalars that drive the
/// streaming header/footer (spinner, phase label, regen marker) and don't
/// belong to any one block. Accumulated text and metadata are no longer
/// tracked here: text is the turn's blocks, metadata accumulates on the turn.
#[derive(Default)]
pub(crate) struct StreamState {
    pub active: bool,
    pub regen: bool,
    pub phase: String,
    /// Name of the tool currently being called/executed.
    pub tool_name: Option<String>,
    /// Name of the sub-agent whose nested `ask_<name>` loop is currently
    /// streaming, if any. Drives sub-agent section bracketing — a tag
    /// transition pushes [`Block::SubagentBegin`]/[`Block::SubagentEnd`].
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
