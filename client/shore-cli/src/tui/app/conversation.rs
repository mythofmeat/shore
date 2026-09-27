use super::{ImageRef, Role, StreamMetadata};

#[derive(Clone, Debug)]
pub(crate) enum Block {
    Text(String),
    Thinking(String),
    ToolUse {
        tool_id: String,
        tool_name: String,
        input: serde_json::Value,
    },
    ToolResult {
        #[expect(
            dead_code,
            reason = "stored for protocol fidelity; TUI renders by tool_name"
        )]
        tool_id: String,
        tool_name: String,
        output: String,
        images: Vec<ImageRef>,
        is_error: bool,
    },
    SubagentBegin(String),
    SubagentEnd(String),
}

#[derive(Clone, Debug)]
pub(crate) struct SubagentSection {
    pub name: String,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnState {
    Complete,
    Streaming,
}

#[derive(Clone, Debug)]
pub(crate) struct Turn {
    pub role: Role,
    pub msg_id: Option<String>,
    pub blocks: Vec<Block>,
    pub images: Vec<ImageRef>,
    pub timestamp: String,
    pub state: TurnState,
    pub metadata: Option<StreamMetadata>,
}

impl Turn {
    pub(crate) fn text(
        role: Role,
        msg_id: Option<String>,
        content: String,
        images: Vec<ImageRef>,
        timestamp: String,
        metadata: Option<StreamMetadata>,
    ) -> Self {
        let blocks = if content.is_empty() {
            Vec::new()
        } else {
            vec![Block::Text(content)]
        };
        Self {
            role,
            msg_id,
            blocks,
            images,
            timestamp,
            state: TurnState::Complete,
            metadata,
        }
    }

    pub(crate) fn joined_text(&self) -> String {
        let parts: Vec<&str> = self
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Text(t) => Some(t.as_str()),
                Block::Thinking(_)
                | Block::ToolUse { .. }
                | Block::ToolResult { .. }
                | Block::SubagentBegin(_)
                | Block::SubagentEnd(_) => None,
            })
            .collect();
        parts.join("\n")
    }

    pub(crate) fn is_streaming(&self) -> bool {
        self.state == TurnState::Streaming
    }

    pub(crate) fn is_real_user_turn(&self) -> bool {
        self.role == Role::User
            && (self.blocks.is_empty()
                || self
                    .blocks
                    .iter()
                    .any(|block| !matches!(block, Block::ToolResult { .. })))
    }
}

#[derive(Clone, Debug)]
pub(crate) enum ConversationEntry {
    Turn(Turn),
    System {
        msg_id: Option<String>,
        content: String,
        count: u32,
        timestamp: String,
    },
    ArchiveBoundary {
        archived_count: usize,
    },
}

impl ConversationEntry {
    pub(crate) fn user(content: String, images: Vec<ImageRef>, timestamp: String) -> Self {
        ConversationEntry::Turn(Turn::text(
            Role::User,
            None,
            content,
            images,
            timestamp,
            None,
        ))
    }

    pub(crate) fn assistant(
        msg_id: Option<String>,
        content: String,
        images: Vec<ImageRef>,
        timestamp: String,
        metadata: Option<StreamMetadata>,
    ) -> Self {
        ConversationEntry::Turn(Turn::text(
            Role::Assistant,
            msg_id,
            content,
            images,
            timestamp,
            metadata,
        ))
    }

    pub(crate) fn msg_id(&self) -> Option<&str> {
        match self {
            ConversationEntry::Turn(turn) => turn.msg_id.as_deref(),
            ConversationEntry::System { msg_id, .. } => msg_id.as_deref(),
            ConversationEntry::ArchiveBoundary { .. } => None,
        }
    }

    pub(crate) fn as_turn(&self) -> Option<&Turn> {
        match self {
            ConversationEntry::Turn(turn) => Some(turn),
            ConversationEntry::System { .. } | ConversationEntry::ArchiveBoundary { .. } => None,
        }
    }

    pub(crate) fn as_turn_mut(&mut self) -> Option<&mut Turn> {
        match self {
            ConversationEntry::Turn(turn) => Some(turn),
            ConversationEntry::System { .. } | ConversationEntry::ArchiveBoundary { .. } => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SubagentTaskView {
    pub parent_request_id: Option<String>,
    pub task_id: String,
    pub name: String,
    pub query: String,
    pub status: String,
    pub detail: Option<String>,
    pub blocks: Vec<Block>,
    pub scroll: u16,
    pub follow: bool,
}

impl SubagentTaskView {
    pub(crate) fn new(task_id: String, name: String) -> Self {
        Self {
            parent_request_id: None,
            task_id,
            name,
            query: String::new(),
            status: "running".to_owned(),
            detail: None,
            blocks: Vec::new(),
            scroll: 0,
            follow: true,
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        self.status == "running"
    }

    pub(crate) fn selector_label(&self) -> String {
        let name = if self.name.is_empty() {
            self.task_id.as_str()
        } else {
            self.name.as_str()
        };
        if self.query.is_empty() {
            name.to_owned()
        } else {
            format!("{name} · {}", one_line(&self.query))
        }
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
