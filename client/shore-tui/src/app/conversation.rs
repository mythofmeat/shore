use super::{ImageRef, Role, StreamMetadata};

/// A content block within a turn, mirroring the wire `ContentBlock`
/// (text / thinking / tool_use / tool_result). Blocks are ordered and
/// authoritative: rendering walks them in sequence, so interleaved
/// `text → tool_use → text` renders in true order under a single header.
///
/// Images are *not* a block — they live as a turn-level field, matching the
/// wire `Message.images` (which is separate from `content_blocks`).
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
        is_error: bool,
    },
    /// Opens a nested sub-agent section: the daemon delegated to an
    /// `ask_<name>` loop and the blocks that follow (until the matching
    /// [`Block::SubagentEnd`]) are that sub-agent's thinking/text/tool frames.
    SubagentBegin(String),
    /// Closes the section opened by [`Block::SubagentBegin`].
    SubagentEnd(String),
}

#[derive(Clone, Debug)]
pub(crate) struct SubagentSection {
    pub name: String,
    pub blocks: Vec<Block>,
}

/// Whether a turn is finalized or still receiving streamed deltas.
///
/// The in-flight turn is simply the last `Turn` with `state: Streaming`;
/// streaming deltas mutate its blocks in place. `StreamEnd` flips it to
/// `Complete`. No separate streaming-text entry, no phase-boundary drop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnState {
    Complete,
    Streaming,
}

/// One conversational turn: a role header plus an ordered list of blocks,
/// mirroring the wire `Message { role, content_blocks }`. One header is
/// rendered per turn, then `blocks` in order.
#[derive(Clone, Debug)]
pub(crate) struct Turn {
    pub role: Role,
    /// Used for msg_id-matched reconciliation and metadata attach.
    pub msg_id: Option<String>,
    pub blocks: Vec<Block>,
    pub images: Vec<ImageRef>,
    pub timestamp: String,
    pub state: TurnState,
    pub metadata: Option<StreamMetadata>,
}

impl Turn {
    /// A completed turn carrying a single text block (the common case for
    /// user messages and plain assistant replies).
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

    /// The turn's textual content — every `Text` block joined with newlines.
    /// Used for ref resolution (`:edit`) and tests, not rendering.
    pub(crate) fn joined_text(&self) -> String {
        let parts: Vec<&str> = self
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        parts.join("\n")
    }

    pub(crate) fn is_streaming(&self) -> bool {
        self.state == TurnState::Streaming
    }
}

/// A single entry in the conversation log. Real conversational turns are
/// `Turn`; `System` (TUI status / injected system messages) and
/// `ArchiveBoundary` are display-only markers that aren't wire turns.
#[derive(Clone, Debug)]
pub(crate) enum ConversationEntry {
    Turn(Turn),
    System {
        content: String,
        /// Count of consecutive identical entries collapsed into this one.
        /// Starts at 1; incremented by `set_status` when the same message
        /// arrives repeatedly (e.g. a reconnect storm).
        count: u32,
        timestamp: String,
    },
    ArchiveBoundary {
        archived_count: usize,
    },
}

impl ConversationEntry {
    /// Construct a completed user turn carrying a single text block.
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

    /// Construct a completed assistant turn carrying a single text block.
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

    /// Borrow the inner `Turn`, if this entry is one.
    pub(crate) fn as_turn(&self) -> Option<&Turn> {
        match self {
            ConversationEntry::Turn(turn) => Some(turn),
            _ => None,
        }
    }

    /// Mutably borrow the inner `Turn`, if this entry is one.
    pub(crate) fn as_turn_mut(&mut self) -> Option<&mut Turn> {
        match self {
            ConversationEntry::Turn(turn) => Some(turn),
            _ => None,
        }
    }
}
