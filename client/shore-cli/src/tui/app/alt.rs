use super::{ConversationEntry, ImageRef};

#[derive(Clone, Debug)]
pub(crate) struct AltChoice {
    pub index: u32,
    pub position: u32,
    pub active: bool,
    pub content: String,
    pub images: Vec<ImageRef>,
    pub timestamp: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AltPickerState {
    pub target_ref: Option<String>,
    pub msg_id: Option<String>,
    pub choices: Vec<AltChoice>,
    pub selected: usize,
    pub original_entries: Vec<ConversationEntry>,
    pub loading: bool,
}
