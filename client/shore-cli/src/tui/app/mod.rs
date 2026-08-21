use ratatui::text::Line;
use shore_common::protocol::types::{CharacterInfo, ImageRef, Role, StreamMetadata, TokenCounts};

use crate::tui::images::ImageCache;

mod alt;
mod cache;
mod conversation;
mod input;
mod notifications;
mod stream;
mod usage;

pub(crate) use alt::*;
pub(crate) use cache::*;
pub(crate) use conversation::*;
pub(crate) use input::*;
pub(crate) use notifications::*;
pub(crate) use stream::*;
pub(crate) use usage::*;

#[derive(Clone)]
pub(crate) struct PendingEditPrefill {
    pub rid: String,
    pub msg_ref: String,
}

#[derive(Clone)]
pub(crate) struct PaletteConfirmation {
    pub command: String,
    pub prompt: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
}

#[derive(Default, Clone)]
pub(crate) enum PaletteMode {
    #[default]
    Top,
    Submenu(SubmenuState),
    ValueEditor(ValueEditorState),
}

#[derive(Clone)]
pub(crate) struct SubmenuState {
    pub parent: String,
    pub saved_cmd_text: String,
    pub saved_cmd_cursor: usize,
}

#[derive(Clone)]
pub(crate) struct ValueEditorState {
    pub key: String,
    pub kind: ValueEditorKind,
    pub saved_cmd_text: String,
    pub saved_cmd_cursor: usize,
}

#[derive(Clone)]
pub(crate) enum ValueEditorKind {
    Slider {
        min: f64,
        max: f64,
        step: f64,
        current: f64,
        typed: Option<String>,
        dirty: bool,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct EffectiveSamplerField {
    pub value: Option<String>,
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct EffectiveSamplerSnapshot {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub temperature: EffectiveSamplerField,
    pub top_p: EffectiveSamplerField,
    pub reasoning_effort: EffectiveSamplerField,
    pub budget_tokens: EffectiveSamplerField,
    pub max_output_tokens: EffectiveSamplerField,
    pub cache_ttl: EffectiveSamplerField,
    pub cache_keepalive: EffectiveSamplerField,
    pub sdk: EffectiveSamplerField,
    pub replay_prior_thinking: EffectiveSamplerField,
    pub max_tool_iterations: EffectiveSamplerField,
    pub openrouter_provider: EffectiveSamplerField,
    pub gemini_generation: EffectiveSamplerField,
    pub zai_clear_thinking: EffectiveSamplerField,
    pub zai_subscription: EffectiveSamplerField,
    pub applicability: std::collections::BTreeMap<String, String>,
    pub reasoning_effort_domain: Vec<String>,
}

impl EffectiveSamplerSnapshot {
    pub(crate) fn from_model_settings(data: &serde_json::Value) -> Option<Self> {
        let sampler = data.get("effective_sampler")?;
        let scopes = data.get("scopes");
        Some(Self {
            model: data
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            provider: data
                .get("provider")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            model_id: data
                .get("model_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            temperature: Self::field(sampler, scopes, "temperature"),
            top_p: Self::field(sampler, scopes, "top_p"),
            reasoning_effort: Self::field(sampler, scopes, "reasoning_effort"),
            budget_tokens: Self::field(sampler, scopes, "budget_tokens"),
            max_output_tokens: Self::field(sampler, scopes, "max_output_tokens"),
            cache_ttl: Self::field(sampler, scopes, "cache_ttl"),
            cache_keepalive: Self::field(sampler, scopes, "cache_keepalive"),
            sdk: Self::field(sampler, scopes, "sdk"),
            replay_prior_thinking: Self::field(sampler, scopes, "replay_prior_thinking"),
            max_tool_iterations: Self::field(sampler, scopes, "max_tool_iterations"),
            openrouter_provider: Self::field(sampler, scopes, "openrouter_provider"),
            gemini_generation: Self::field(sampler, scopes, "gemini_generation"),
            zai_clear_thinking: Self::field(sampler, scopes, "zai_clear_thinking"),
            zai_subscription: Self::field(sampler, scopes, "zai_subscription"),
            applicability: data
                .get("applicability")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                        .collect()
                })
                .unwrap_or_default(),
            reasoning_effort_domain: data
                .get("reasoning_effort_domain")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    pub(crate) fn key_honored(&self, key: &str) -> bool {
        match self.applicability.get(key).map(String::as_str) {
            Some(label) => label == "honored" || label == "always",
            None => true,
        }
    }

    fn field(
        sampler: &serde_json::Value,
        scopes: Option<&serde_json::Value>,
        key: &str,
    ) -> EffectiveSamplerField {
        EffectiveSamplerField {
            value: sampler
                .get(key)
                .map(Self::display_json_value)
                .or_else(|| Some("unset".into())),
            scope: scopes
                .and_then(|s| s.get(key))
                .and_then(|v| v.as_str())
                .map(str::to_owned),
        }
    }

    fn display_json_value(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::Null => "unset".into(),
            serde_json::Value::Bool(v) => v.to_string(),
            serde_json::Value::Number(v) => v.to_string(),
            serde_json::Value::String(v) => v.clone(),
            other @ (serde_json::Value::Array(_) | serde_json::Value::Object(_)) => {
                other.to_string()
            }
        }
    }

    pub(crate) fn field_for_key(&self, key: &str) -> Option<&EffectiveSamplerField> {
        match key {
            "temperature" => Some(&self.temperature),
            "top_p" => Some(&self.top_p),
            "reasoning_effort" => Some(&self.reasoning_effort),
            "budget_tokens" => Some(&self.budget_tokens),
            "max_output_tokens" => Some(&self.max_output_tokens),
            "cache_ttl" => Some(&self.cache_ttl),
            "cache_keepalive" => Some(&self.cache_keepalive),
            "sdk" => Some(&self.sdk),
            "replay_prior_thinking" => Some(&self.replay_prior_thinking),
            "max_tool_iterations" => Some(&self.max_tool_iterations),
            "openrouter_provider" => Some(&self.openrouter_provider),
            "gemini_generation" => Some(&self.gemini_generation),
            "zai_clear_thinking" => Some(&self.zai_clear_thinking),
            "zai_subscription" => Some(&self.zai_subscription),
            _ => None,
        }
    }

    pub(crate) fn display_value(&self, key: &str) -> Option<&str> {
        self.field_for_key(key).and_then(|f| f.value.as_deref())
    }

    pub(crate) fn scope(&self, key: &str) -> Option<&str> {
        self.field_for_key(key).and_then(|f| f.scope.as_deref())
    }

    pub(crate) fn numeric_value(&self, key: &str) -> Option<f64> {
        self.display_value(key)?.parse().ok()
    }
}

pub(crate) struct OutputPager {
    pub command: String,
    pub lines: Vec<Line<'static>>,
    pub scroll: u16,
    pub viewport: u16,
}

#[derive(Default)]
pub(crate) struct CompletionState {
    pub candidates: Vec<String>,
    pub descriptions: std::collections::HashMap<String, String>,
    pub selected: Option<usize>,
    pub header: Option<String>,
    pub mode: PaletteMode,
    pub scope: crate::cli::PaletteScope,
}

impl CompletionState {
    pub(crate) fn clear(&mut self) {
        self.candidates.clear();
        self.descriptions.clear();
        self.selected = None;
        self.header = None;
        self.mode = PaletteMode::Top;
        self.scope = crate::cli::PaletteScope::Full;
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ImageEntry {
    pub path: String,
    pub display_name: String,
    pub line: usize,
}

pub(crate) struct App {
    pub entries: Vec<ConversationEntry>,
    pub stream: StreamState,
    pub input: InputState,
    pub completion: CompletionState,
    pub alt_picker: Option<AltPickerState>,
    pub scroll_offset: u16,
    pub connection_status: ConnectionStatus,
    pub character_name: String,
    pub characters: Vec<CharacterInfo>,
    pub model_names: Vec<String>,
    pub active_model_names: Vec<String>,
    pub show_model_list: bool,
    pub model: String,
    pub effective_sampler: Option<EffectiveSamplerSnapshot>,
    pub sampler_settings_loading: bool,
    pub pending_sampler_settings_rid: Option<String>,
    pub sampler_settings_request_seq: u64,
    pub pending_palette_commands: std::collections::HashMap<String, String>,
    pub palette_command_request_seq: u64,
    pub palette_catalog: crate::cli::PaletteCatalog,
    pub palette_catalog_loaded: bool,
    pub pending_palette_catalog: std::collections::HashMap<String, String>,
    pub palette_confirmation: Option<PaletteConfirmation>,
    pub confirmed_palette_command: Option<String>,
    pub tokens: TokenCounts,
    pub is_private: bool,
    pub should_quit: bool,
    pub interrupt: bool,
    pub auto_scroll: bool,
    pub conversation_max_scroll: u16,
    pub grew_above_viewport: bool,
    pub history_next_before: Option<usize>,
    pub history_has_more_before: bool,
    pub history_page_loading: bool,
    pub image_cache: ImageCache,
    pub show_thinking: bool,
    pub show_tools: bool,
    pub show_subagent: bool,
    pub subagent_traces: std::collections::HashMap<String, Option<SubagentSection>>,
    pub pending_subagent_trace_ids: Vec<String>,
    pub subagent_tasks: Vec<SubagentTaskView>,
    pub subagent_panel: Option<usize>,
    pub show_images: bool,
    pub show_timestamps: bool,
    pub show_metadata: bool,
    pub usage_display: UsageDisplay,
    pub budget_focus: BudgetFocus,
    pub show_help: bool,
    pub output_pager: Option<OutputPager>,
    pub keymap: crate::tui::keymap::Keymap,
    pub usage_budgets: Vec<UsageBudget>,
    pub pending_images: Vec<String>,
    pub paste_temp_paths: Vec<std::path::PathBuf>,
    pub editing_ref: Option<String>,
    pub pending_edit_prefill: Option<PendingEditPrefill>,
    pub edit_prefill_seq: u64,
    pub image_index: Vec<ImageEntry>,
    pub fullscreen: Option<usize>,
    pub spinner_frame: usize,
    pub conv_cache: ConvCache,
    pub history_version: u64,
    pub notifications: Vec<Notification>,
    pub error_log: Vec<String>,
}

impl Default for App {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            stream: StreamState::default(),
            input: InputState::default(),
            completion: CompletionState::default(),
            alt_picker: None,
            scroll_offset: 0,
            connection_status: ConnectionStatus::Disconnected,
            character_name: String::new(),
            characters: Vec::new(),
            model_names: Vec::new(),
            active_model_names: Vec::new(),
            show_model_list: false,
            model: String::new(),
            effective_sampler: None,
            sampler_settings_loading: false,
            pending_sampler_settings_rid: None,
            sampler_settings_request_seq: 0,
            pending_palette_commands: std::collections::HashMap::new(),
            palette_command_request_seq: 0,
            palette_catalog: crate::cli::PaletteCatalog::default(),
            palette_catalog_loaded: false,
            pending_palette_catalog: std::collections::HashMap::new(),
            palette_confirmation: None,
            confirmed_palette_command: None,
            tokens: TokenCounts {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
            is_private: false,
            should_quit: false,
            interrupt: false,
            auto_scroll: true,
            conversation_max_scroll: 0,
            grew_above_viewport: false,
            history_next_before: None,
            history_has_more_before: false,
            history_page_loading: false,
            image_cache: ImageCache::new(),
            show_thinking: true,
            show_tools: true,
            show_subagent: true,
            subagent_traces: std::collections::HashMap::new(),
            pending_subagent_trace_ids: Vec::new(),
            subagent_tasks: Vec::new(),
            subagent_panel: None,
            show_images: true,
            show_timestamps: false,
            show_metadata: true,
            usage_display: UsageDisplay::Off,
            budget_focus: BudgetFocus::default(),
            show_help: false,
            output_pager: None,
            keymap: crate::tui::keymap::Keymap::default(),
            usage_budgets: Vec::new(),
            pending_images: Vec::new(),
            paste_temp_paths: Vec::new(),
            editing_ref: None,
            pending_edit_prefill: None,
            edit_prefill_seq: 0,
            image_index: Vec::new(),
            fullscreen: None,
            spinner_frame: 0,
            conv_cache: ConvCache::default(),
            history_version: 0,
            notifications: Vec::new(),
            error_log: Vec::new(),
        }
    }
}

impl App {
    pub(crate) fn conversation_fingerprint(&self, width: u16) -> ConvFingerprint {
        let entry_summary = |e: &ConversationEntry| -> u64 {
            match e {
                ConversationEntry::Turn(turn) => {
                    let block_len = |b: &Block| -> u64 {
                        match b {
                            Block::Text(s) | Block::Thinking(s) => {
                                u64::try_from(s.len()).unwrap_or(u64::MAX)
                            }
                            Block::ToolUse { tool_name, .. } => {
                                u64::try_from(tool_name.len()).unwrap_or(u64::MAX)
                            }
                            Block::ToolResult {
                                tool_name, output, ..
                            } => u64::try_from(tool_name.len().saturating_add(output.len()))
                                .unwrap_or(u64::MAX),
                            Block::SubagentBegin(name) | Block::SubagentEnd(name) => {
                                u64::try_from(name.len()).unwrap_or(u64::MAX)
                            }
                        }
                    };
                    let role_bit = u64::from(matches!(turn.role, Role::Assistant));
                    let last_len = turn.blocks.last().map_or(0, block_len);
                    (1_u64 << 56)
                        | (role_bit << 55)
                        | (u64::from(turn.is_streaming()) << 54)
                        | (u64::from(turn.metadata.is_some()) << 53)
                        | ((u64::try_from(turn.images.len()).unwrap_or(u64::MAX) & 0x1FF) << 44)
                        | ((u64::try_from(turn.blocks.len()).unwrap_or(u64::MAX) & 0xFFF) << 32)
                        | (last_len & 0xFFFF_FFFF)
                }
                ConversationEntry::System { content, count, .. } => {
                    (3_u64 << 56)
                        | (u64::try_from(content.len()).unwrap_or(u64::MAX) << 24)
                        | u64::from(*count)
                }
                ConversationEntry::ArchiveBoundary { archived_count } => {
                    (7_u64 << 56) | u64::try_from(*archived_count).unwrap_or(u64::MAX)
                }
            }
        };

        let last_entry = self.entries.last().map_or(0, entry_summary);
        let second_last_entry = self.entries.iter().rev().nth(1).map_or(0, entry_summary);

        ConvFingerprint {
            width,
            entries_len: u32::try_from(self.entries.len()).unwrap_or(u32::MAX),
            last_entry,
            second_last_entry,
            history_version: self.history_version,
            stream_active: self.stream.active,
            stream_regen: self.stream.regen,
            stream_phase_len: u32::try_from(self.stream.phase.len()).unwrap_or(u32::MAX),
            stream_tool_name_len: self
                .stream
                .tool_name
                .as_ref()
                .map_or(-1, |s| i32::try_from(s.len()).unwrap_or(i32::MAX)),
            show_thinking: self.show_thinking,
            show_tools: self.show_tools,
            show_subagent: self.show_subagent,
            show_images: self.show_images,
            show_timestamps: self.show_timestamps,
            show_metadata: self.show_metadata,
            spinner_frame: u32::try_from(self.spinner_frame).unwrap_or(u32::MAX),
            character_name_len: u32::try_from(self.character_name.len()).unwrap_or(u32::MAX),
            image_cache_version: self.image_cache.version(),
        }
    }

    pub(crate) fn scroll_up(&mut self, amount: u16) {
        self.scroll_offset = self.scroll_offset.saturating_add(amount);
        self.auto_scroll = false;
    }

    pub(crate) fn scroll_down(&mut self, amount: u16) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
        if self.scroll_offset == 0 {
            self.auto_scroll = true;
        }
    }

    pub(crate) fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
        self.auto_scroll = true;
    }

    pub(crate) fn ensure_streaming_turn(&mut self) -> &mut Turn {
        let needs_new = !matches!(
            self.entries.last(),
            Some(ConversationEntry::Turn(turn)) if turn.is_streaming()
        );
        if needs_new {
            self.entries.push(ConversationEntry::Turn(Turn {
                role: Role::Assistant,
                msg_id: None,
                blocks: Vec::new(),
                images: Vec::new(),
                timestamp: String::new(),
                state: TurnState::Streaming,
                metadata: None,
            }));
        }
        let Some(turn) = self
            .entries
            .last_mut()
            .and_then(ConversationEntry::as_turn_mut)
        else {
            std::process::abort();
        };
        turn
    }

    pub(crate) fn subagent_task_index(&mut self, task_id: &str, name: Option<&str>) -> usize {
        if let Some(idx) = self
            .subagent_tasks
            .iter()
            .position(|task| task.task_id == task_id)
        {
            if let Some(task_name) = name
                && let Some(task) = self.subagent_tasks.get_mut(idx)
                && task.name.is_empty()
            {
                task.name = task_name.to_owned();
            }
            return idx;
        }
        self.subagent_tasks.push(SubagentTaskView::new(
            task_id.to_owned(),
            name.unwrap_or_default().to_owned(),
        ));
        self.subagent_tasks.len().saturating_sub(1)
    }

    pub(crate) fn begin_subagent_task(&mut self, tool_id: &str, name: &str, query: String) {
        let idx = self.subagent_task_index(tool_id, Some(name));
        let Some(task) = self.subagent_tasks.get_mut(idx) else {
            return;
        };
        task.query = query;
        task.status = "running".to_owned();
        task.detail = None;
    }

    pub(crate) fn settle_subagent_task(&mut self, tool_id: &str, output: &str, is_error: bool) {
        let Some(task) = self
            .subagent_tasks
            .iter_mut()
            .find(|task| task.task_id == tool_id)
        else {
            return;
        };
        task.status = if is_error { "error" } else { "done" }.to_owned();
        task.detail = Some(output.to_owned());
    }

    pub(crate) fn subagent_task_append_text(&mut self, idx: usize, text: &str) {
        let Some(task) = self.subagent_tasks.get_mut(idx) else {
            return;
        };
        match task.blocks.last_mut() {
            Some(Block::Text(content)) => content.push_str(text),
            _ => task.blocks.push(Block::Text(text.to_owned())),
        }
    }

    pub(crate) fn subagent_task_append_thinking(&mut self, idx: usize, text: &str) {
        let Some(task) = self.subagent_tasks.get_mut(idx) else {
            return;
        };
        match task.blocks.last_mut() {
            Some(Block::Thinking(content)) => content.push_str(text),
            _ => task.blocks.push(Block::Thinking(text.to_owned())),
        }
    }

    pub(crate) fn subagent_task_push_block(&mut self, idx: usize, block: Block) {
        if let Some(task) = self.subagent_tasks.get_mut(idx) {
            task.blocks.push(block);
        }
    }

    pub(crate) fn running_subagent_count(&self) -> usize {
        self.subagent_tasks
            .iter()
            .filter(|task| task.is_running())
            .count()
    }

    pub(crate) fn open_subagent_panel(&mut self) {
        if self.subagent_tasks.is_empty() {
            return;
        }
        let running = self
            .subagent_tasks
            .iter()
            .position(SubagentTaskView::is_running);
        self.subagent_panel = Some(running.unwrap_or(self.subagent_tasks.len().saturating_sub(1)));
    }

    pub(crate) fn select_subagent_task(&mut self, delta: isize) {
        let total = self.subagent_tasks.len();
        let Some(selected) = self.subagent_panel else {
            return;
        };
        if total == 0 {
            return;
        }
        let Ok(total_i) = isize::try_from(total) else {
            return;
        };
        let Ok(selected_i) = isize::try_from(selected) else {
            return;
        };
        let next = selected_i.saturating_add(delta).rem_euclid(total_i);
        self.subagent_panel = usize::try_from(next).ok();
    }

    pub(crate) fn selected_subagent_task_mut(&mut self) -> Option<&mut SubagentTaskView> {
        let idx = self.subagent_panel?;
        self.subagent_tasks.get_mut(idx)
    }

    pub(crate) fn scroll_subagent_panel(&mut self, delta: i32) {
        let Some(task) = self.selected_subagent_task_mut() else {
            return;
        };
        if delta < 0 {
            task.scroll = task
                .scroll
                .saturating_sub(u16::try_from(delta.unsigned_abs()).unwrap_or(u16::MAX));
            task.follow = false;
        } else {
            task.scroll = task
                .scroll
                .saturating_add(u16::try_from(delta).unwrap_or(u16::MAX));
        }
    }

    pub(crate) fn stream_append_thinking(&mut self, text: &str) {
        let turn = self.ensure_streaming_turn();
        match turn.blocks.last_mut() {
            Some(Block::Thinking(content)) => content.push_str(text),
            _ => turn.blocks.push(Block::Thinking(text.to_owned())),
        }
    }

    pub(crate) fn stream_append_text(&mut self, text: &str) {
        let turn = self.ensure_streaming_turn();
        match turn.blocks.last_mut() {
            Some(Block::Text(content)) => content.push_str(text),
            _ => turn.blocks.push(Block::Text(text.to_owned())),
        }
    }

    pub(crate) fn stream_push_tool_call(
        &mut self,
        tool_id: String,
        tool_name: String,
        input: serde_json::Value,
    ) {
        self.ensure_streaming_turn().blocks.push(Block::ToolUse {
            tool_id,
            tool_name,
            input,
        });
    }

    pub(crate) fn stream_push_tool_result(
        &mut self,
        tool_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    ) {
        self.ensure_streaming_turn().blocks.push(Block::ToolResult {
            tool_id,
            tool_name,
            output,
            is_error,
        });
    }

    pub(crate) fn abort_stream(&mut self) {
        if matches!(
            self.entries.last(),
            Some(ConversationEntry::Turn(turn)) if turn.is_streaming()
        ) {
            let _ = self.entries.pop();
        }
        self.stream.reset();
    }

    pub(crate) fn begin_regen_optimistic(&mut self) {
        self.stream.reset();
        self.stream.active = true;
        self.stream.regen = true;
        self.spinner_frame = 0;
        self.scroll_to_bottom();
    }

    pub(crate) fn begin_edit_prefill(&mut self, msg_ref: &str) -> String {
        self.edit_prefill_seq = self.edit_prefill_seq.wrapping_add(1);
        let rid = format!("tui_edit_prefill_{}", self.edit_prefill_seq);
        self.pending_edit_prefill = Some(PendingEditPrefill {
            rid: rid.clone(),
            msg_ref: msg_ref.to_owned(),
        });
        rid
    }

    pub(crate) fn take_edit_prefill(&mut self, rid: Option<&str>) -> Option<String> {
        let pending = self.pending_edit_prefill.as_ref()?;
        if rid? != pending.rid {
            return None;
        }
        self.pending_edit_prefill.take().map(|p| p.msg_ref)
    }

    pub(crate) fn cancel_edit_prefill(&mut self) {
        self.pending_edit_prefill = None;
    }

    pub(crate) fn begin_palette_command(&mut self, command: &str) -> String {
        self.palette_command_request_seq = self.palette_command_request_seq.wrapping_add(1);
        let rid = format!("tui_palette_{}", self.palette_command_request_seq);
        let _ = self
            .pending_palette_commands
            .insert(rid.clone(), command.to_owned());
        rid
    }

    pub(crate) fn begin_palette_catalog_request(&mut self, kind: &str) -> String {
        self.palette_command_request_seq = self.palette_command_request_seq.wrapping_add(1);
        let rid = format!("tui_palette_catalog_{}", self.palette_command_request_seq);
        let _ = self
            .pending_palette_catalog
            .insert(rid.clone(), kind.to_owned());
        rid
    }

    pub(crate) fn take_palette_catalog_request(&mut self, rid: Option<&str>) -> Option<String> {
        self.pending_palette_catalog.remove(rid?)
    }

    pub(crate) fn invalidate_palette_catalog(&mut self) {
        self.palette_catalog_loaded = false;
        self.pending_palette_catalog.clear();
        self.palette_catalog.providers.clear();
        self.palette_catalog.status_sections.clear();
        self.palette_catalog.tools.clear();
        self.palette_catalog.subagents.clear();
        self.palette_catalog.config_keys.clear();
        self.palette_catalog.config_sections.clear();
        self.palette_catalog.config_schema = None;
    }

    pub(crate) fn take_palette_command(&mut self, rid: Option<&str>) -> Option<String> {
        self.pending_palette_commands.remove(rid?)
    }

    pub(crate) fn push_command_text(&mut self, command: &str, rendered: String) {
        self.output_pager = Some(OutputPager {
            command: command.to_owned(),
            lines: crate::tui::ansi::to_lines(&rendered),
            scroll: 0,
            viewport: 1,
        });
    }

    pub(crate) fn reopen_output_pager(&mut self) -> bool {
        match &mut self.output_pager {
            Some(pager) => {
                pager.scroll = 0;
                true
            }
            None => false,
        }
    }

    pub(crate) fn scroll_output_pager(&mut self, delta: i32) {
        let Some(pager) = &mut self.output_pager else {
            return;
        };
        let total = u16::try_from(pager.lines.len()).unwrap_or(u16::MAX);
        let last = total.saturating_sub(pager.viewport.max(1));
        let next = i64::from(pager.scroll).saturating_add(i64::from(delta));
        pager.scroll = next.clamp(0, i64::from(last)).try_into().unwrap_or(0);
    }

    pub(crate) fn start_editing(&mut self, msg_ref: String, content: String) {
        self.editing_ref = Some(msg_ref);
        self.input.set_text(content);
        self.input.mode = InputMode::Insert;
    }

    pub(crate) fn set_status(&mut self, msg: impl Into<String>) {
        self.notify(NotificationLevel::Info, msg);
    }

    pub(crate) fn set_warning(&mut self, msg: impl Into<String>) {
        self.notify(NotificationLevel::Warning, msg);
    }

    pub(crate) fn set_error(&mut self, msg: impl Into<String>) {
        let message = msg.into();
        tracing::error!("{message}");
        if self.error_log.len() >= MAX_ERROR_LOG {
            let _ = self.error_log.remove(0);
        }
        self.error_log.push(message.clone());
        self.notify(NotificationLevel::Error, message);
    }

    pub(crate) fn notify(&mut self, level: NotificationLevel, msg: impl Into<String>) {
        let message = msg.into();
        if let Some(last) = self.notifications.last_mut()
            && last.content == message
            && last.level == level
        {
            last.count = last.count.saturating_add(1);
            last.created = std::time::Instant::now();
            return;
        }
        self.notifications.push(Notification {
            content: message,
            level,
            count: 1,
            created: std::time::Instant::now(),
        });
        if self.notifications.len() > MAX_NOTIFICATIONS {
            let overflow = self.notifications.len().saturating_sub(MAX_NOTIFICATIONS);
            drop(self.notifications.drain(0..overflow));
        }
    }

    pub(crate) fn expire_notifications(&mut self, now: std::time::Instant) -> bool {
        let before = self.notifications.len();
        self.notifications
            .retain(|n| now.duration_since(n.created) < NOTIFICATION_TTL);
        self.notifications.len() != before
    }

    pub(crate) fn dismiss_notifications(&mut self) {
        self.notifications.clear();
    }

    pub(crate) fn dismiss_latest_notification(&mut self) -> bool {
        self.notifications.pop().is_some()
    }

    pub(crate) fn start_alt_picker(&mut self, target_ref: Option<String>) {
        if self.alt_picker.is_some() {
            self.cancel_alt_picker();
        }
        self.alt_picker = Some(AltPickerState {
            target_ref,
            msg_id: None,
            choices: Vec::new(),
            selected: 0,
            original_entries: self.entries.clone(),
            loading: true,
        });
    }

    pub(crate) fn populate_alt_picker(&mut self, msg_id: Option<String>, choices: Vec<AltChoice>) {
        if choices.is_empty() {
            if let Some(picker) = self.alt_picker.take() {
                self.entries = picker.original_entries;
                self.history_version = self.history_version.wrapping_add(1);
            }
            self.set_status("no alternate responses");
            return;
        }

        if self.alt_picker.is_none() {
            self.alt_picker = Some(AltPickerState {
                target_ref: msg_id.clone(),
                msg_id: msg_id.clone(),
                choices: Vec::new(),
                selected: 0,
                original_entries: self.entries.clone(),
                loading: false,
            });
        }

        if let Some(picker) = self.alt_picker.as_mut() {
            picker.msg_id = msg_id;
            picker.selected = choices.iter().position(|alt| alt.active).unwrap_or(0);
            picker.choices = choices;
            picker.loading = false;
        }
        self.preview_alt_selection();
    }

    pub(crate) fn next_alt(&mut self) {
        let Some(picker) = self.alt_picker.as_mut() else {
            return;
        };
        if picker.loading || picker.choices.is_empty() {
            return;
        }
        picker.selected = picker
            .selected
            .saturating_add(1)
            .checked_rem(picker.choices.len())
            .unwrap_or_default();
        self.preview_alt_selection();
    }

    pub(crate) fn prev_alt(&mut self) {
        let Some(picker) = self.alt_picker.as_mut() else {
            return;
        };
        if picker.loading || picker.choices.is_empty() {
            return;
        }
        picker.selected = match picker.selected {
            0 => picker.choices.len().saturating_sub(1),
            n => n.saturating_sub(1),
        };
        self.preview_alt_selection();
    }

    pub(crate) fn cancel_alt_picker(&mut self) {
        if let Some(picker) = self.alt_picker.take() {
            self.entries = picker.original_entries;
            self.history_version = self.history_version.wrapping_add(1);
        }
    }

    pub(crate) fn selected_alt_command_args(&self) -> Option<serde_json::Value> {
        let picker = self.alt_picker.as_ref()?;
        if picker.loading {
            return None;
        }
        let choice = picker.choices.get(picker.selected)?;
        let mut args = serde_json::Map::new();
        let _ = args.insert("index".into(), serde_json::json!(choice.index));
        if let Some(msg_id) = picker.msg_id.as_deref().or(picker.target_ref.as_deref()) {
            let _ = args.insert("ref".into(), serde_json::json!(msg_id));
        }
        Some(serde_json::Value::Object(args))
    }

    pub(crate) fn close_alt_picker_after_confirm(&mut self) {
        self.alt_picker = None;
    }

    fn preview_alt_selection(&mut self) {
        let Some(picker) = self.alt_picker.as_ref() else {
            return;
        };
        if picker.loading {
            return;
        }
        let Some(choice) = picker.choices.get(picker.selected).cloned() else {
            return;
        };
        let msg_id = picker.msg_id.clone();
        let original_entries = picker.original_entries.clone();

        self.entries = original_entries;
        let is_assistant = |entry: &ConversationEntry| matches!(entry.as_turn(), Some(t) if matches!(t.role, Role::Assistant) && !t.is_streaming());
        let target_idx = msg_id
            .as_deref()
            .and_then(|target| {
                self.entries.iter().position(|entry| {
                    matches!(
                        entry.as_turn(),
                        Some(Turn { role: Role::Assistant, msg_id: Some(id), .. }) if id == target
                    )
                })
            })
            .or_else(|| self.entries.iter().rposition(is_assistant));

        if let Some(turn) = target_idx.and_then(|idx| self.entries.get_mut(idx)?.as_turn_mut()) {
            turn.blocks = if choice.content.is_empty() {
                Vec::new()
            } else {
                vec![Block::Text(choice.content)]
            };
            turn.images = choice.images;
            turn.timestamp = choice.timestamp;
            turn.metadata = None;
            turn.state = TurnState::Complete;
            self.history_version = self.history_version.wrapping_add(1);
        }
    }

    pub(crate) fn last_assistant_text(&self) -> Option<String> {
        self.entries
            .iter()
            .rev()
            .filter_map(ConversationEntry::as_turn)
            .find(|turn| turn.role == Role::Assistant && !turn.is_streaming())
            .map(Turn::joined_text)
            .filter(|text| !text.trim().is_empty())
    }

    pub(crate) fn is_submenu_open(&self, parent: &str) -> bool {
        matches!(&self.completion.mode, PaletteMode::Submenu(s) if s.parent == parent)
    }

    pub(crate) fn is_setting_palette_open(&self) -> bool {
        matches!(
            &self.completion.mode,
            PaletteMode::Submenu(s)
                if s.parent == "config" || s.parent == "setting" || s.parent.starts_with("setting:")
        ) || matches!(&self.completion.mode, PaletteMode::ValueEditor(s) if Self::is_setting_key(&s.key))
    }

    pub(crate) fn selected_row_is_view_option(&self) -> bool {
        self.completion
            .selected
            .and_then(|index| self.completion.candidates.get(index))
            .is_some_and(|row| Self::is_view_key(Self::view_key_from_row(row)))
    }

    pub(crate) fn open_submenu_parent(&self) -> Option<String> {
        match &self.completion.mode {
            PaletteMode::Submenu(state) => Some(state.parent.clone()),
            PaletteMode::Top | PaletteMode::ValueEditor(_) => None,
        }
    }

    pub(crate) fn is_value_editor_open(&self) -> bool {
        matches!(self.completion.mode, PaletteMode::ValueEditor(_))
    }

    pub(crate) fn set_active_model(&mut self, model: Option<&str>) {
        let next_model = model.filter(|candidate| !candidate.is_empty());
        let current_model = (!self.model.is_empty()).then_some(self.model.as_str());
        let equivalent = match (current_model, next_model) {
            (Some(active_model), Some(candidate_model)) => {
                Self::model_identifier_matches(active_model, candidate_model)
            }
            (None, None) => true,
            _ => false,
        };

        if equivalent {
            if let Some(candidate_model) = next_model
                && !self
                    .active_model_names
                    .iter()
                    .any(|name| name == candidate_model)
            {
                self.active_model_names.push(candidate_model.to_owned());
            }
            return;
        }

        self.effective_sampler = None;
        self.sampler_settings_loading = false;
        self.pending_sampler_settings_rid = None;

        if let Some(selected_model) = next_model {
            self.model = selected_model.to_owned();
            self.active_model_names = vec![selected_model.to_owned()];
        } else {
            self.model.clear();
            self.active_model_names.clear();
        }
    }

    pub(crate) fn sampler_snapshot_matches_active_model(
        &self,
        snapshot: &EffectiveSamplerSnapshot,
    ) -> bool {
        if self.model.is_empty() {
            return true;
        }
        if snapshot.model.is_none() && snapshot.model_id.is_none() && snapshot.provider.is_none() {
            return true;
        }

        snapshot
            .model
            .as_deref()
            .is_some_and(|model| self.is_active_model_candidate(model))
            || snapshot
                .model_id
                .as_deref()
                .is_some_and(|model_id| self.is_active_model_candidate(model_id))
            || snapshot
                .provider
                .as_deref()
                .zip(snapshot.model_id.as_deref())
                .is_some_and(|(provider, model_id)| {
                    self.is_active_model_candidate(&format!("{provider}:{model_id}"))
                })
    }

    pub(crate) fn note_active_model_from_snapshot(&mut self, snapshot: &EffectiveSamplerSnapshot) {
        let mut keys = Vec::new();
        if let Some(model) = snapshot.model.as_deref() {
            keys.push(model.to_owned());
        }
        if let Some(model_id) = snapshot.model_id.as_deref() {
            if let Some(provider) = snapshot.provider.as_deref() {
                keys.push(format!("{provider}:{model_id}"));
            }
            keys.push(model_id.to_owned());
        }
        for key in keys {
            if !key.is_empty() && !self.active_model_names.iter().any(|n| n == &key) {
                self.active_model_names.push(key);
            }
        }
    }

    pub(crate) fn begin_sampler_settings_refresh(&mut self) -> String {
        self.sampler_settings_request_seq = self.sampler_settings_request_seq.wrapping_add(1);
        let rid = format!("tui_sampler_settings_{}", self.sampler_settings_request_seq);
        self.sampler_settings_loading = true;
        self.pending_sampler_settings_rid = Some(rid.clone());
        rid
    }

    pub(crate) fn sampler_settings_rid_matches(&self, rid: Option<&str>) -> bool {
        match (self.pending_sampler_settings_rid.as_deref(), rid) {
            (Some(pending), Some(response_rid)) => pending == response_rid,
            _ => false,
        }
    }

    pub(crate) fn finish_sampler_settings_refresh(&mut self) {
        self.sampler_settings_loading = false;
        self.pending_sampler_settings_rid = None;
    }

    pub(crate) fn model_identifier_matches(active: &str, candidate: &str) -> bool {
        if active == candidate {
            return true;
        }
        active.ends_with(&format!(".{candidate}"))
            || active.ends_with(&format!(":{candidate}"))
            || active.ends_with(&format!("/{candidate}"))
            || candidate.ends_with(&format!(".{active}"))
            || candidate.ends_with(&format!(":{active}"))
            || candidate.ends_with(&format!("/{active}"))
    }

    pub(crate) fn is_active_model_candidate(&self, candidate: &str) -> bool {
        self.active_model_names
            .iter()
            .any(|active| Self::model_identifier_matches(active, candidate))
            || (!self.model.is_empty() && Self::model_identifier_matches(&self.model, candidate))
    }

    pub(crate) fn command_description(&self, candidate: &str) -> Option<String> {
        self.completion.descriptions.get(candidate).cloned()
    }

    const SETTING_KEYS: &'static [&'static str] = &[
        "temperature",
        "top_p",
        "reasoning_effort",
        "budget_tokens",
        "max_output_tokens",
        "cache_ttl",
        "cache_keepalive",
        "sdk",
        "replay_prior_thinking",
        "max_tool_iterations",
        "openrouter_provider",
        "gemini_generation",
        "zai_clear_thinking",
        "zai_subscription",
    ];

    const SDK_VARIANTS: &'static [&'static str] = &[
        "anthropic",
        "openai",
        "openrouter",
        "gemini",
        "zai",
        "deepseek",
        "moonshot",
        "reset",
    ];

    fn is_setting_key(key: &str) -> bool {
        Self::SETTING_KEYS.contains(&key)
    }

    fn visible_setting_keys(&self) -> Vec<&'static str> {
        Self::SETTING_KEYS
            .iter()
            .copied()
            .filter(|key| {
                self.effective_sampler
                    .as_ref()
                    .is_none_or(|snapshot| snapshot.key_honored(key))
            })
            .collect()
    }

    const VIEW_KEYS: &'static [&'static str] = &[
        "timestamps",
        "thinking",
        "tools",
        "subagent",
        "images",
        "metadata",
        "usage",
        "budget",
    ];

    pub(crate) fn is_view_key(key: &str) -> bool {
        Self::VIEW_KEYS.contains(&key)
    }

    pub(crate) fn view_enabled(&self, key: &str) -> Option<bool> {
        match key {
            "timestamps" => Some(self.show_timestamps),
            "thinking" => Some(self.show_thinking),
            "tools" => Some(self.show_tools),
            "subagent" => Some(self.show_subagent),
            "images" => Some(self.show_images),
            "metadata" => Some(self.show_metadata),
            "usage" => Some(self.usage_display != UsageDisplay::Off),
            "budget" => Some(self.budget_focus != BudgetFocus::default()),
            _ => None,
        }
    }

    pub(crate) fn set_usage_display(&mut self, mode: UsageDisplay) {
        self.usage_display = mode;
    }

    pub(crate) fn cycle_usage_display(&mut self) -> UsageDisplay {
        self.usage_display = self.usage_display.cycled();
        self.usage_display
    }

    pub(crate) fn focused_budget(&self) -> Option<&UsageBudget> {
        if let Some(name) = &self.budget_focus.name {
            return self
                .usage_budgets
                .iter()
                .find(|b| b.name.eq_ignore_ascii_case(name));
        }
        let scope = self.budget_focus.scope;
        self.usage_budgets
            .iter()
            .max_by(|a, b| a.level_percent(scope).total_cmp(&b.level_percent(scope)))
    }

    pub(crate) fn set_budget_focus(&mut self, focus: BudgetFocus) {
        self.budget_focus = focus;
    }

    fn budget_focus_cycle(&self) -> Vec<BudgetFocus> {
        let mut cycle = vec![
            BudgetFocus::default(),
            BudgetFocus::scoped(UsageScope::Cap),
            BudgetFocus::scoped(UsageScope::Pace),
        ];
        if self.usage_budgets.len() > 1 {
            cycle.extend(
                self.usage_budgets
                    .iter()
                    .map(|b| BudgetFocus::named(&b.name)),
            );
        }
        cycle
    }

    pub(crate) fn cycle_budget_focus(&mut self) -> BudgetFocus {
        let cycle = self.budget_focus_cycle();
        let next = cycle
            .iter()
            .position(|focus| *focus == self.budget_focus)
            .map_or(0, |i| {
                i.saturating_add(1)
                    .checked_rem(cycle.len())
                    .unwrap_or_default()
            });
        self.budget_focus = cycle.get(next).cloned().unwrap_or_default();
        self.budget_focus.clone()
    }

    pub(crate) fn apply_usage_budgets(&mut self, data: &serde_json::Value) {
        let Some(arr) = data.get("budgets").and_then(|v| v.as_array()) else {
            return;
        };
        self.usage_budgets = arr
            .iter()
            .map(|b| UsageBudget {
                name: b
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_owned(),
                percent_used: b
                    .get("percent_used")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
                crossed_warn_at: b
                    .get("crossed_warn_at")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(serde_json::Value::as_f64).collect())
                    .unwrap_or_default(),
                over_limit: b
                    .get("over_limit")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                pace: b.get("pace").and_then(usage_level_from_json),
            })
            .collect();
    }

    pub(crate) fn apply_usage_warning(&mut self, name: &str, scope: UsageScope, level: UsageLevel) {
        let existing =
            if let Some(existing) = self.usage_budgets.iter_mut().find(|b| b.name == name) {
                existing
            } else {
                self.usage_budgets.push(UsageBudget {
                    name: name.to_owned(),
                    ..UsageBudget::default()
                });
                let Some(pushed) = self.usage_budgets.last_mut() else {
                    return;
                };
                pushed
            };

        match scope {
            UsageScope::Cap => {
                existing.percent_used = level.percent_used;
                existing.crossed_warn_at = level.crossed_warn_at;
                existing.over_limit = level.over_limit;
            }
            UsageScope::Pace => existing.pace = Some(level),
        }
    }

    pub(crate) fn set_view_option(&mut self, key: &str, enabled: bool) -> bool {
        match key {
            "timestamps" => self.show_timestamps = enabled,
            "thinking" => self.show_thinking = enabled,
            "tools" => self.show_tools = enabled,
            "subagent" => self.show_subagent = enabled,
            "images" => self.show_images = enabled,
            "metadata" => self.show_metadata = enabled,
            "usage" => {
                self.usage_display = if enabled {
                    UsageDisplay::Always
                } else {
                    UsageDisplay::Off
                };
            }
            _ => return false,
        }
        true
    }

    pub(crate) fn toggle_view_option(&mut self, key: &str) -> Option<bool> {
        if key == "usage" {
            return Some(self.cycle_usage_display() != UsageDisplay::Off);
        }
        if key == "budget" {
            return Some(self.cycle_budget_focus() != BudgetFocus::default());
        }
        let next = !self.view_enabled(key)?;
        let _ = self.set_view_option(key, next);
        Some(next)
    }

    fn view_row_label(&self, key: &str) -> String {
        if key == "usage" {
            return format!("usage = {}", self.usage_display.as_str());
        }
        if key == "budget" {
            return format!("budget = {}", self.budget_focus.as_token());
        }
        let state = if self.view_enabled(key).unwrap_or(false) {
            "on"
        } else {
            "off"
        };
        format!("{key} = {state}")
    }

    pub(crate) fn view_key_from_row(row: &str) -> &str {
        row.split_once(" = ").map_or(row, |(key, _)| key)
    }

    fn setting_row_label(&self, key: &str) -> String {
        match self
            .effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.display_value(key))
        {
            Some(value) => format!("{key} = {value}"),
            None => key.to_owned(),
        }
    }

    pub(crate) fn setting_key_from_row(row: &str) -> &str {
        row.split_once(" = ").map_or(row, |(key, _)| key)
    }

    pub(crate) fn setting_origin(&self, key: &str) -> Option<&str> {
        self.effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.scope(key))
    }

    fn setting_scope_is_override(&self, key: &str) -> bool {
        self.effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.scope(key))
            .is_some_and(|scope| scope != "static_default")
    }

    fn setting_editor_blocked_row(&self) -> Option<&'static str> {
        if self.sampler_settings_loading {
            Some("loading sampler settings...")
        } else if self.effective_sampler.is_none() {
            Some("sampler settings unavailable")
        } else {
            None
        }
    }

    fn setting_editors_ready(&self) -> bool {
        self.setting_editor_blocked_row().is_none()
    }

    pub(crate) fn is_effective_setting_candidate(&self, key: &str, candidate: &str) -> bool {
        let Some(current) = self
            .effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.display_value(key))
        else {
            return false;
        };
        if candidate == "reset" {
            return false;
        }
        let value = candidate
            .strip_prefix("Custom: ")
            .unwrap_or(candidate)
            .trim();
        current == value
    }

    fn current_slider_value(&self, key: &str, fallback: f64) -> f64 {
        self.effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.numeric_value(key))
            .unwrap_or(fallback)
    }

    fn slider_kind_for_setting(&self, key: &str) -> Option<ValueEditorKind> {
        match key {
            "temperature" => Some(ValueEditorKind::Slider {
                min: 0.0,
                max: 2.0,
                step: 0.1,
                current: Self::quantize_slider_value(
                    0.0,
                    2.0,
                    0.1,
                    self.current_slider_value("temperature", 1.0),
                ),
                typed: None,
                dirty: false,
            }),
            "top_p" => Some(ValueEditorKind::Slider {
                min: 0.0,
                max: 1.0,
                step: 0.05,
                current: Self::quantize_slider_value(
                    0.0,
                    1.0,
                    0.05,
                    self.current_slider_value("top_p", 0.95),
                ),
                typed: None,
                dirty: false,
            }),
            _ => None,
        }
    }

    fn refresh_value_editor_from_effective_sampler(&mut self) {
        let (key, should_refresh) = match &self.completion.mode {
            PaletteMode::ValueEditor(state) => match &state.kind {
                ValueEditorKind::Slider { dirty, .. } => (state.key.clone(), !*dirty),
            },
            PaletteMode::Top | PaletteMode::Submenu(_) => return,
        };

        if !should_refresh {
            return;
        }

        if let Some(kind) = self.slider_kind_for_setting(&key)
            && let PaletteMode::ValueEditor(state) = &mut self.completion.mode
        {
            state.kind = kind;
        }
    }

    pub(crate) fn format_slider_number(value: f64) -> String {
        let mut text = format!("{value:.2}");
        while text.contains('.') && text.ends_with('0') {
            let _ = text.pop();
        }
        if text.ends_with('.') {
            text.push('0');
        }
        text
    }

    #[expect(
        clippy::float_arithmetic,
        reason = "quantizing a floating-point sampler slider necessarily uses floating-point steps"
    )]
    fn quantize_slider_value(min: f64, max: f64, step: f64, value: f64) -> f64 {
        let clamped = value.clamp(min, max);
        if step <= 0.0 {
            return clamped;
        }
        let steps = ((clamped - min) / step).round();
        (min + steps * step).clamp(min, max)
    }

    pub(crate) fn update_completions(&mut self) {
        self.completion.selected = None;
        self.completion.header = None;
        self.completion.descriptions.clear();

        if self.completion.scope == crate::cli::PaletteScope::Shortcuts {
            self.update_shortcut_candidates();
            return;
        }
        if matches!(self.completion.mode, PaletteMode::Submenu(_)) {
            self.update_submenu_candidates();
            return;
        }
        if matches!(self.completion.mode, PaletteMode::ValueEditor(_)) {
            self.refresh_value_editor_from_effective_sampler();
            self.completion.candidates.clear();
            return;
        }

        self.palette_catalog.models = self
            .model_names
            .iter()
            .cloned()
            .map(crate::cli::PaletteValue::plain)
            .collect();
        self.palette_catalog.characters = self
            .characters
            .iter()
            .map(|character| crate::cli::PaletteValue::plain(&character.name))
            .collect();
        self.palette_catalog.setting_keys = self
            .visible_setting_keys()
            .into_iter()
            .map(crate::cli::PaletteValue::plain)
            .collect();
        let mut message_refs = ["last", "-1", "-2", "-3"]
            .into_iter()
            .map(crate::cli::PaletteValue::plain)
            .collect::<Vec<_>>();
        message_refs.extend(self.entries.iter().filter_map(|entry| {
            entry
                .as_turn()
                .and_then(|turn| turn.msg_id.as_deref())
                .map(crate::cli::PaletteValue::plain)
        }));
        self.palette_catalog.message_refs = message_refs;

        let completed =
            crate::cli::palette_completions(&self.input.cmd_text, &self.palette_catalog);
        self.completion.header = completed.header;
        self.completion.candidates = completed
            .candidates
            .into_iter()
            .map(|candidate| {
                if let Some(help) = candidate.help {
                    let _ = self
                        .completion
                        .descriptions
                        .insert(candidate.replacement.clone(), help);
                }
                candidate.replacement
            })
            .collect();
    }

    pub(crate) fn apply_completion(&mut self) {
        if !matches!(self.completion.mode, PaletteMode::Top) {
            return;
        }
        if let Some(idx) = self.completion.selected
            && let Some(text) = self.completion.candidates.get(idx)
        {
            self.input.cmd_text = text.clone();
            self.input.cmd_cursor = text.len();
            if !text.ends_with(char::is_whitespace) {
                self.input.cmd_text.push(' ');
                self.input.cmd_cursor = self.input.cmd_cursor.saturating_add(1);
            }
        }
    }

    fn update_shortcut_candidates(&mut self) {
        let filter = self.input.cmd_text.trim().to_lowercase();
        self.completion.header = Some("shortcut".into());
        self.completion.candidates = self
            .keymap
            .shortcuts()
            .iter()
            .filter(|(name, binding)| {
                filter.is_empty()
                    || name.to_lowercase().contains(&filter)
                    || binding.written.to_lowercase().contains(&filter)
            })
            .map(|(name, binding)| {
                let description = match self.keymap.key_for_command(&binding.command) {
                    Some(bound_key) => format!("{}   ({bound_key})", binding.written),
                    None => binding.written.clone(),
                };
                let _ = self
                    .completion
                    .descriptions
                    .insert(name.clone(), description);
                name.clone()
            })
            .collect();
        if self.completion.candidates.is_empty() {
            self.completion.header = Some("no shortcut matches".into());
        }
    }

    pub(crate) fn shortcut_command(&self, name: &str) -> Option<(String, bool)> {
        self.keymap
            .shortcuts()
            .iter()
            .find(|(bound, _)| bound == name)
            .map(|(_, binding)| (binding.command.clone(), binding.needs_more_input))
    }

    fn update_submenu_candidates(&mut self) {
        let parent = match &self.completion.mode {
            PaletteMode::Submenu(s) => s.parent.clone(),
            PaletteMode::Top | PaletteMode::ValueEditor(_) => return,
        };
        let raw_filter = self.input.cmd_text.trim();
        let filter = raw_filter.to_lowercase();
        self.completion.header = match parent.as_str() {
            "config" => Some("what to change".into()),
            "setting" | "setting:reset" => Some("setting key".into()),
            setting_parent if setting_parent.starts_with("setting:") => {
                Some("setting value".into())
            }
            "view" => Some("view option".into()),
            _ => None,
        };

        if (parent == "setting" || parent.starts_with("setting:"))
            && let Some(row) = self.setting_editor_blocked_row()
        {
            self.completion.candidates = vec![row.to_owned()];
            self.completion.selected = None;
            return;
        }

        match parent.as_str() {
            "model" => {
                let mut candidates: Vec<String> = self
                    .model_names
                    .iter()
                    .filter(|n| filter.is_empty() || n.to_lowercase().contains(&filter))
                    .cloned()
                    .collect();
                if filter.is_empty() || "reset".starts_with(&filter) {
                    candidates.push("reset".into());
                }
                self.completion.candidates = candidates;
            }
            "character" => {
                self.completion.candidates = self
                    .characters
                    .iter()
                    .filter(|c| filter.is_empty() || c.name.to_lowercase().starts_with(&filter))
                    .map(|c| c.name.clone())
                    .collect();
            }
            "setting" => {
                let visible = self.visible_setting_keys();
                let mut candidates: Vec<String> = visible
                    .iter()
                    .filter(|key| filter.is_empty() || key.starts_with(&filter))
                    .map(|key| self.setting_row_label(key))
                    .collect();
                if filter.is_empty() || "reset".starts_with(&filter) {
                    candidates.push("reset".into());
                }
                self.completion.candidates = candidates;
            }
            "setting:reasoning_effort" => {
                let domain: Vec<&str> = self
                    .effective_sampler
                    .as_ref()
                    .filter(|s| !s.reasoning_effort_domain.is_empty())
                    .map_or_else(
                        || vec!["low", "medium", "high", "xhigh", "max"],
                        |s| {
                            s.reasoning_effort_domain
                                .iter()
                                .map(String::as_str)
                                .collect()
                        },
                    );
                let mut presets = domain;
                presets.push("off");
                presets.push("reset");
                self.completion.candidates = Self::filtered_presets(&presets, &filter);
            }
            "setting:replay_prior_thinking" => {
                self.completion.candidates =
                    Self::filtered_presets(&["all", "none", "reset"], &filter);
            }
            "setting:zai_clear_thinking" | "setting:zai_subscription" => {
                self.completion.candidates =
                    Self::filtered_presets(&["true", "false", "reset"], &filter);
            }
            "setting:gemini_generation" => {
                let mut candidates = Self::filtered_presets(&["1", "2", "3", "reset"], &filter);
                if raw_filter.parse::<u32>().is_ok() {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:openrouter_provider" => {
                let mut candidates = Self::filtered_presets(&["reset"], &filter);
                if !raw_filter.is_empty() && !raw_filter.eq_ignore_ascii_case("reset") {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:cache_ttl" => {
                let mut candidates = Self::filtered_presets(&["5m", "1h", "reset"], &filter);
                if !raw_filter.is_empty() && !raw_filter.eq_ignore_ascii_case("off") {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:cache_keepalive" => {
                let mut candidates = Self::filtered_presets(&["off", "55m", "reset"], &filter);
                if !raw_filter.is_empty()
                    && !raw_filter.eq_ignore_ascii_case("off")
                    && !raw_filter.eq_ignore_ascii_case("reset")
                {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:max_output_tokens" => {
                let mut candidates =
                    Self::filtered_presets(&["16384", "32768", "65536", "reset"], &filter);
                if raw_filter.parse::<u32>().is_ok() {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:budget_tokens" => {
                let mut candidates = Self::filtered_presets(
                    &["1024", "2048", "4096", "8192", "16384", "32768", "reset"],
                    &filter,
                );
                if raw_filter.parse::<u32>().is_ok() {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:max_tool_iterations" => {
                let mut candidates =
                    Self::filtered_presets(&["8", "16", "32", "64", "reset"], &filter);
                if raw_filter.parse::<u32>().is_ok() {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:sdk" => {
                self.completion.candidates = Self::filtered_presets(Self::SDK_VARIANTS, &filter);
            }
            "setting:reset" => {
                self.completion.candidates = Self::SETTING_KEYS
                    .iter()
                    .filter(|key| filter.is_empty() || key.starts_with(&filter))
                    .map(|key| (*key).to_owned())
                    .collect();
            }
            "view" => {
                self.completion.candidates = Self::VIEW_KEYS
                    .iter()
                    .filter(|key| filter.is_empty() || key.starts_with(&filter))
                    .map(|key| self.view_row_label(key))
                    .collect();
            }
            "config" => {
                let mut rows: Vec<String> = Vec::new();
                for (label, value) in [
                    ("model", self.model.clone()),
                    ("character", self.character_name.clone()),
                ] {
                    if filter.is_empty() || label.starts_with(&filter) {
                        let shown = if value.is_empty() {
                            "unset".to_owned()
                        } else {
                            value
                        };
                        rows.push(format!("{label} = {shown}"));
                    }
                }
                let matching_settings: Vec<&'static str> = self
                    .visible_setting_keys()
                    .into_iter()
                    .filter(|key| filter.is_empty() || key.starts_with(&filter))
                    .collect();
                match self.setting_editor_blocked_row() {
                    Some(blocked) if !matching_settings.is_empty() => rows.push(blocked.to_owned()),
                    Some(_) => {}
                    None => {
                        rows.extend(
                            matching_settings
                                .iter()
                                .map(|key| self.setting_row_label(key)),
                        );
                        if filter.is_empty() || "reset".starts_with(&filter) {
                            rows.push("reset".into());
                        }
                    }
                }
                rows.extend(
                    Self::VIEW_KEYS
                        .iter()
                        .filter(|key| filter.is_empty() || key.starts_with(&filter))
                        .map(|key| self.view_row_label(key)),
                );
                self.completion.candidates = rows;
            }
            _ => self.completion.candidates.clear(),
        }

        self.completion.selected = match parent.as_str() {
            "model" => self
                .completion
                .candidates
                .iter()
                .position(|c| self.is_active_model_candidate(c)),
            "character" => self
                .completion
                .candidates
                .iter()
                .position(|c| !self.character_name.is_empty() && c == &self.character_name),
            "setting" => self.completion.candidates.iter().position(|c| {
                let key = Self::setting_key_from_row(c);
                self.setting_scope_is_override(key)
            }),
            p if p.starts_with("setting:") && p != "setting:reset" => {
                let key = parent.strip_prefix("setting:").unwrap_or_default();
                self.completion
                    .candidates
                    .iter()
                    .position(|c| self.is_effective_setting_candidate(key, c))
            }
            _ => None,
        };
    }

    fn filtered_presets(presets: &[&str], filter: &str) -> Vec<String> {
        presets
            .iter()
            .filter(|preset| filter.is_empty() || preset.starts_with(filter))
            .map(|preset| (*preset).to_owned())
            .collect()
    }

    pub(crate) fn enter_submenu(&mut self, parent: &str) {
        if parent == "setting" {
            self.sampler_settings_loading = true;
        }
        let saved_cmd_text = self.input.cmd_text.clone();
        let saved_cmd_cursor = self.input.cmd_cursor;
        self.completion.mode = PaletteMode::Submenu(SubmenuState {
            parent: parent.to_owned(),
            saved_cmd_text,
            saved_cmd_cursor,
        });
        self.input.cmd_text.clear();
        self.input.cmd_cursor = 0;
        self.update_completions();
    }

    fn saved_palette_input(&self) -> (String, usize) {
        match &self.completion.mode {
            PaletteMode::Submenu(s) => (s.saved_cmd_text.clone(), s.saved_cmd_cursor),
            PaletteMode::ValueEditor(s) => (s.saved_cmd_text.clone(), s.saved_cmd_cursor),
            PaletteMode::Top => (self.input.cmd_text.clone(), self.input.cmd_cursor),
        }
    }

    pub(crate) fn switch_submenu(&mut self, parent: &str) {
        let (saved_cmd_text, saved_cmd_cursor) = self.saved_palette_input();
        self.completion.mode = PaletteMode::Submenu(SubmenuState {
            parent: parent.to_owned(),
            saved_cmd_text,
            saved_cmd_cursor,
        });
        self.input.cmd_text.clear();
        self.input.cmd_cursor = 0;
        self.update_completions();
    }

    pub(crate) fn enter_value_editor(&mut self, key: &str, kind: ValueEditorKind) {
        let (saved_cmd_text, saved_cmd_cursor) = self.saved_palette_input();
        self.completion.mode = PaletteMode::ValueEditor(ValueEditorState {
            key: key.to_owned(),
            kind,
            saved_cmd_text,
            saved_cmd_cursor,
        });
        self.input.cmd_text.clear();
        self.input.cmd_cursor = 0;
        self.update_completions();
    }

    pub(crate) fn exit_submenu(&mut self) {
        if let PaletteMode::Submenu(s) = std::mem::take(&mut self.completion.mode) {
            self.input.cmd_text = s.saved_cmd_text;
            self.input.cmd_cursor = s.saved_cmd_cursor;
        }
        self.update_completions();
    }

    pub(crate) fn exit_value_editor(&mut self) {
        if let PaletteMode::ValueEditor(s) = std::mem::take(&mut self.completion.mode) {
            self.input.cmd_text = s.saved_cmd_text;
            self.input.cmd_cursor = s.saved_cmd_cursor;
        }
        self.update_completions();
    }

    #[expect(
        clippy::float_arithmetic,
        reason = "moving a floating-point sampler slider necessarily applies a signed float step"
    )]
    pub(crate) fn adjust_value_editor(&mut self, direction: f64) {
        let PaletteMode::ValueEditor(state) = &mut self.completion.mode else {
            return;
        };
        match &mut state.kind {
            ValueEditorKind::Slider {
                min,
                max,
                step,
                current,
                typed,
                dirty,
            } => {
                *current =
                    Self::quantize_slider_value(*min, *max, *step, *current + *step * direction);
                *typed = None;
                *dirty = true;
            }
        }
    }

    pub(crate) fn type_value_editor_char(&mut self, c: char) {
        let PaletteMode::ValueEditor(state) = &mut self.completion.mode else {
            return;
        };
        match &mut state.kind {
            ValueEditorKind::Slider { typed, dirty, .. } => {
                typed.get_or_insert_with(String::new).push(c);
                *dirty = true;
            }
        }
    }

    pub(crate) fn backspace_value_editor(&mut self) {
        let PaletteMode::ValueEditor(state) = &mut self.completion.mode else {
            return;
        };
        match &mut state.kind {
            ValueEditorKind::Slider { typed, dirty, .. } => {
                if let Some(value) = typed {
                    let _ = value.pop();
                    if value.is_empty() {
                        *typed = None;
                    }
                    *dirty = true;
                }
            }
        }
    }

    pub(crate) fn apply_value_editor(&mut self) -> Option<String> {
        let state = match &self.completion.mode {
            PaletteMode::ValueEditor(state) => state.clone(),
            PaletteMode::Top | PaletteMode::Submenu(_) => return None,
        };
        if Self::is_setting_key(&state.key) && !self.setting_editors_ready() {
            return None;
        }
        let value = match state.kind {
            ValueEditorKind::Slider {
                min,
                max,
                current,
                typed,
                ..
            } => {
                if let Some(typed_value) = typed {
                    let parsed = typed_value.parse::<f64>().ok()?;
                    if !(min..=max).contains(&parsed) {
                        return None;
                    }
                    typed_value
                } else {
                    Self::format_slider_number(current)
                }
            }
        };
        self.completion.clear();
        self.input.exit_command_mode();
        Some(format!("setting {} {value}", state.key))
    }

    fn toggle_view_row(&mut self, key: &str, row: usize) -> Option<String> {
        if key == "usage" {
            let mode = self.cycle_usage_display();
            self.set_status(format!("view usage: {}", mode.as_str()));
        } else if key == "budget" {
            let focus = self.cycle_budget_focus();
            self.set_status(format!("view budget: {}", focus.as_token()));
        } else {
            let enabled = self.toggle_view_option(key)?;
            self.set_status(format!(
                "view {key}: {}",
                if enabled { "on" } else { "off" }
            ));
        }
        self.update_completions();
        if row < self.completion.candidates.len() {
            self.completion.selected = Some(row);
        }
        None
    }

    pub(crate) fn is_view_submenu(&self) -> bool {
        matches!(&self.completion.mode, PaletteMode::Submenu(s) if s.parent == "view")
    }

    pub(crate) fn apply_submenu(&mut self) -> Option<String> {
        let parent = match &self.completion.mode {
            PaletteMode::Submenu(s) => s.parent.clone(),
            PaletteMode::Top | PaletteMode::ValueEditor(_) => return None,
        };
        let idx = self.completion.selected?;
        let chosen = self.completion.candidates.get(idx)?.clone();

        if parent == "config" {
            let head = chosen.split(' ').next().unwrap_or_default().to_owned();
            if head == "model" || head == "character" {
                self.switch_submenu(&head);
                return None;
            }
            let view_key = Self::view_key_from_row(&chosen).to_owned();
            if Self::is_view_key(&view_key) {
                return self.toggle_view_row(&view_key, idx);
            }
            if !self.setting_editors_ready() {
                return None;
            }
            let key = Self::setting_key_from_row(&chosen).to_owned();
            if key == "reset" {
                self.switch_submenu("setting:reset");
                return None;
            }
            if let Some(kind) = self.slider_kind_for_setting(&key) {
                self.enter_value_editor(&key, kind);
                return None;
            }
            self.switch_submenu(&format!("setting:{key}"));
            return None;
        }

        if parent == "setting" {
            if !self.setting_editors_ready() {
                return None;
            }
            let key = Self::setting_key_from_row(&chosen).to_owned();
            if key == "reset" {
                self.switch_submenu("setting:reset");
                return None;
            }
            if let Some(kind) = self.slider_kind_for_setting(&key) {
                self.enter_value_editor(&key, kind);
                return None;
            }
            self.switch_submenu(&format!("setting:{key}"));
            return None;
        }

        if parent == "setting:reset" {
            if !self.setting_editors_ready() {
                return None;
            }
            self.completion.clear();
            self.input.exit_command_mode();
            return Some(format!("setting {chosen} --reset"));
        }

        if let Some(key) = parent.strip_prefix("setting:") {
            if !self.setting_editors_ready() {
                return None;
            }
            let value = chosen
                .strip_prefix("Custom: ")
                .unwrap_or(chosen.as_str())
                .trim();
            self.completion.clear();
            self.input.exit_command_mode();
            if value == "reset" {
                return Some(format!("setting {key} --reset"));
            }
            return Some(format!("setting {key} {value}"));
        }

        if parent == "view" {
            let key = Self::view_key_from_row(&chosen).to_owned();
            if !Self::is_view_key(&key) {
                return None;
            }
            if key == "usage" {
                let mode = self.cycle_usage_display();
                self.set_status(format!("view usage: {}", mode.as_str()));
            } else if key == "budget" {
                let focus = self.cycle_budget_focus();
                self.set_status(format!("view budget: {}", focus.as_token()));
            } else {
                let enabled = self.toggle_view_option(&key)?;
                self.set_status(format!(
                    "view {key}: {}",
                    if enabled { "on" } else { "off" }
                ));
            }
            self.update_completions();
            if idx < self.completion.candidates.len() {
                self.completion.selected = Some(idx);
            }
            return None;
        }

        self.completion.clear();
        self.input.exit_command_mode();
        Some(format!("{parent} {chosen}"))
    }

    pub(crate) fn next_completion(&mut self) {
        if self.completion.candidates.is_empty() {
            return;
        }
        self.completion.selected = Some(match self.completion.selected {
            Some(i) => i
                .saturating_add(1)
                .checked_rem(self.completion.candidates.len())
                .unwrap_or_default(),
            None => 0,
        });
    }

    pub(crate) fn prev_completion(&mut self) {
        let len = self.completion.candidates.len();
        if len == 0 {
            return;
        }
        self.completion.selected = Some(match self.completion.selected {
            Some(0) | None => len.saturating_sub(1),
            Some(i) => i.saturating_sub(1),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_setting_keys_honors_daemon_applicability() {
        let snapshot = EffectiveSamplerSnapshot::from_model_settings(&serde_json::json!({
            "effective_sampler": { "temperature": 0.7 },
            "reasoning_effort_domain": ["minimal", "low", "medium", "high", "xhigh"],
            "applicability": {
                "temperature": "honored",
                "reasoning_effort": "honored",
                "sdk": "always",
                "replay_prior_thinking": "always",
                "budget_tokens": "ignored",
                "zai_clear_thinking": "rejected",
                "cache_keepalive": "honored",
                "max_tool_iterations": "always",
            },
        }))
        .expect("snapshot");

        assert_eq!(
            snapshot.reasoning_effort_domain,
            vec!["minimal", "low", "medium", "high", "xhigh"]
        );

        let app = App {
            effective_sampler: Some(snapshot),
            ..App::default()
        };
        let visible = app.visible_setting_keys();

        assert!(visible.contains(&"temperature"));
        assert!(visible.contains(&"sdk"));
        assert!(visible.contains(&"openrouter_provider"));
        assert!(visible.contains(&"cache_keepalive"));
        assert!(visible.contains(&"max_tool_iterations"));
        assert!(!visible.contains(&"budget_tokens"));
        assert!(!visible.contains(&"zai_clear_thinking"));
    }

    #[test]
    fn visible_setting_keys_shows_all_without_snapshot() {
        let app = App::default();
        assert_eq!(app.visible_setting_keys(), App::SETTING_KEYS.to_vec());
    }

    #[test]
    fn input_insert_and_backspace() {
        let mut input = InputState::default();
        input.insert_char('h');
        input.insert_char('i');
        assert_eq!(input.text, "hi");
        assert_eq!(input.cursor, 2);
        input.backspace();
        assert_eq!(input.text, "h");
        assert_eq!(input.cursor, 1);
    }

    #[test]
    fn input_newline() {
        let mut input = InputState::default();
        input.insert_char('a');
        input.insert_newline();
        input.insert_char('b');
        assert_eq!(input.text, "a\nb");
        assert_eq!(input.line_count(), 2);
    }

    #[test]
    fn input_navigation() {
        let mut input = InputState::default();
        for c in "hello".chars() {
            input.insert_char(c);
        }
        assert_eq!(input.cursor, 5);
        input.move_left();
        assert_eq!(input.cursor, 4);
        input.move_right();
        assert_eq!(input.cursor, 5);
        input.move_home();
        assert_eq!(input.cursor, 0);
        input.move_end();
        assert_eq!(input.cursor, 5);
    }

    #[test]
    fn input_take_text() {
        let mut input = InputState::default();
        for c in "message".chars() {
            input.insert_char(c);
        }
        let text = input.take_text();
        assert_eq!(text, "message");
        assert_eq!(input.text, "");
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn input_delete() {
        let mut input = InputState::default();
        for c in "abc".chars() {
            input.insert_char(c);
        }
        input.move_home();
        input.delete();
        assert_eq!(input.text, "bc");
    }

    #[test]
    fn scroll_up_down() {
        let mut app = App::default();
        assert!(app.auto_scroll);
        app.scroll_up(5);
        assert_eq!(app.scroll_offset, 5);
        assert!(!app.auto_scroll);
        app.scroll_down(3);
        assert_eq!(app.scroll_offset, 2);
        app.scroll_down(10);
        assert_eq!(app.scroll_offset, 0);
        assert!(app.auto_scroll);
    }

    #[test]
    fn set_active_model_does_not_downgrade_to_less_qualified_form() {
        let mut app = App::default();
        app.set_active_model(Some("openrouter:anthropic/claude-4.6-opus-20260205"));
        app.effective_sampler = Some(EffectiveSamplerSnapshot {
            model: Some("openrouter:anthropic/claude-4.6-opus-20260205".into()),
            ..EffectiveSamplerSnapshot::default()
        });

        app.set_active_model(Some("anthropic/claude-4.6-opus-20260205"));

        assert_eq!(app.model, "openrouter:anthropic/claude-4.6-opus-20260205");
        assert!(app.effective_sampler.is_some());
        assert!(
            app.active_model_names
                .iter()
                .any(|n| n == "anthropic/claude-4.6-opus-20260205"),
            "the bare form should still be tracked as a match key"
        );
    }

    #[test]
    fn set_active_model_to_genuinely_different_model_resets_sampler() {
        let mut app = App::default();
        app.set_active_model(Some("openrouter:anthropic/claude-4.6-opus-20260205"));
        app.effective_sampler = Some(EffectiveSamplerSnapshot::default());

        app.set_active_model(Some("anthropic/claude-sonnet-4.5"));

        assert_eq!(app.model, "anthropic/claude-sonnet-4.5");
        assert!(app.effective_sampler.is_none());
        assert_eq!(app.active_model_names, vec!["anthropic/claude-sonnet-4.5"]);
    }

    #[test]
    fn set_status_dedupes_consecutive_identical() {
        let mut app = App::default();
        app.set_status("reconnecting: connection lost");
        app.set_status("reconnecting: connection lost");
        app.set_status("reconnecting: connection lost");
        assert_eq!(app.notifications.len(), 1);
        let notification = app.notifications.first().expect("notification");
        assert_eq!(notification.content, "reconnecting: connection lost");
        assert_eq!(notification.count, 3);
    }

    #[test]
    fn set_status_does_not_dedupe_different_content() {
        let mut app = App::default();
        app.set_status("x");
        app.set_status("y");
        assert_eq!(app.notifications.len(), 2);
    }

    #[test]
    fn set_status_does_not_touch_conversation_entries() {
        let mut app = App::default();
        app.entries
            .push(ConversationEntry::user("hi".into(), vec![], String::new()));
        app.set_status("connected");
        assert_eq!(app.entries.len(), 1);
        assert_eq!(app.notifications.len(), 1);
    }

    #[test]
    fn notification_stack_is_capped() {
        let mut app = App::default();
        for i in 0..10 {
            app.set_status(format!("msg {i}"));
        }
        assert_eq!(app.notifications.len(), MAX_NOTIFICATIONS);
        assert_eq!(app.notifications.last().unwrap().content, "msg 9");
    }

    #[test]
    fn expired_notifications_are_pruned() {
        let mut app = App::default();
        app.set_status("hi");
        let now = app.notifications.first().expect("notification").created;
        assert!(
            !app.expire_notifications(
                (now + NOTIFICATION_TTL)
                    .checked_sub(std::time::Duration::from_millis(1))
                    .unwrap()
            )
        );
        assert_eq!(app.notifications.len(), 1);
        assert!(app.expire_notifications(now + NOTIFICATION_TTL));
        assert!(app.notifications.is_empty());
    }

    #[test]
    fn set_error_records_to_error_log() {
        let mut app = App::default();
        app.set_error("error: rate_limit - too many requests");
        assert_eq!(app.notifications.len(), 1);
        assert_eq!(
            app.notifications.first().expect("notification").level,
            NotificationLevel::Error
        );
        assert_eq!(app.error_log.len(), 1);
        assert!(
            app.error_log
                .first()
                .is_some_and(|entry| entry.contains("rate_limit"))
        );
    }

    #[test]
    fn alt_picker_previews_and_cancels() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::assistant(
            Some("a1".into()),
            "first".into(),
            vec![],
            "t1".into(),
            None,
        ));

        app.start_alt_picker(None);
        app.populate_alt_picker(
            Some("a1".into()),
            vec![
                AltChoice {
                    index: 0,
                    position: 1,
                    active: true,
                    content: "first".into(),
                    images: vec![],
                    timestamp: "t1".into(),
                },
                AltChoice {
                    index: 1,
                    position: 2,
                    active: false,
                    content: "second".into(),
                    images: vec![],
                    timestamp: "t2".into(),
                },
            ],
        );
        app.next_alt();
        assert!(matches!(
            app.entries.first().and_then(ConversationEntry::as_turn),
            Some(t) if t.joined_text() == "second"
        ));

        app.cancel_alt_picker();
        assert!(matches!(
            app.entries.first().and_then(ConversationEntry::as_turn),
            Some(t) if t.joined_text() == "first"
        ));
    }

    #[test]
    fn alt_picker_command_uses_selected_index() {
        let mut app = App::default();
        app.start_alt_picker(Some("last".into()));
        app.populate_alt_picker(
            Some("a1".into()),
            vec![AltChoice {
                index: 3,
                position: 4,
                active: false,
                content: "fourth".into(),
                images: vec![],
                timestamp: "t4".into(),
            }],
        );

        let args = app.selected_alt_command_args().unwrap();
        assert_eq!(args.get("index"), Some(&serde_json::json!(3)));
        assert_eq!(args.get("ref"), Some(&serde_json::json!("a1")));
    }

    fn budget(name: &str, cap: f64, pace: Option<f64>) -> UsageBudget {
        UsageBudget {
            name: name.into(),
            percent_used: cap,
            crossed_warn_at: vec![],
            over_limit: false,
            pace: pace.map(|percent_used| UsageLevel {
                percent_used,
                crossed_warn_at: vec![],
                over_limit: false,
            }),
        }
    }

    #[test]
    fn budget_focus_tokens_round_trip() {
        for token in ["auto", "cap", "pace", "brainwife", "brainwife:pace"] {
            let focus = BudgetFocus::from_token(token).expect("parses");
            assert_eq!(focus.as_token(), token);
        }
        assert_eq!(BudgetFocus::from_token("budget").unwrap().as_token(), "cap");
        assert_eq!(BudgetFocus::from_token("PACE").unwrap().as_token(), "pace");
        assert_eq!(
            BudgetFocus::from_token("Weekly").unwrap().as_token(),
            "Weekly"
        );
        assert!(BudgetFocus::from_token("").is_none());
        assert!(BudgetFocus::from_token("weekly:hourly").is_none());
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "level() selects a stored percent_used without arithmetic, so these are the fixture's own values"
    )]
    fn focused_budget_honors_scope_and_name_pins() {
        let mut app = App {
            usage_budgets: vec![
                budget("weekly", 0.7, Some(0.2)),
                budget("monthly", 0.4, None),
            ],
            ..App::default()
        };

        assert_eq!(app.focused_budget().unwrap().name, "weekly");
        assert_eq!(app.focused_budget().unwrap().level(None).percent_used, 0.7);

        app.budget_focus = BudgetFocus::scoped(UsageScope::Pace);
        assert_eq!(app.focused_budget().unwrap().name, "monthly");
        assert_eq!(
            app.focused_budget()
                .unwrap()
                .level(app.budget_focus.scope)
                .percent_used,
            0.4
        );

        app.budget_focus = BudgetFocus::named("weekly");
        let weekly_budget = app.focused_budget().unwrap();
        assert_eq!(weekly_budget.name, "weekly");
        assert_eq!(
            weekly_budget.level(app.budget_focus.scope).percent_used,
            0.7
        );

        app.budget_focus = BudgetFocus::from_token("weekly:pace").unwrap();
        let weekly_pace = app.focused_budget().unwrap();
        assert_eq!(weekly_pace.level(app.budget_focus.scope).percent_used, 0.2);
        assert!(weekly_pace.level_is_pace(app.budget_focus.scope));

        app.budget_focus = BudgetFocus::named("retired");
        assert!(app.focused_budget().is_none());
    }

    #[test]
    fn budget_focus_cycle_covers_scopes_then_names() {
        let mut app = App {
            usage_budgets: vec![budget("weekly", 0.7, Some(0.2))],
            ..App::default()
        };

        assert_eq!(app.cycle_budget_focus().as_token(), "cap");
        assert_eq!(app.cycle_budget_focus().as_token(), "pace");
        assert_eq!(app.cycle_budget_focus().as_token(), "auto");

        app.usage_budgets.push(budget("monthly", 0.4, None));
        app.budget_focus = BudgetFocus::scoped(UsageScope::Pace);
        assert_eq!(app.cycle_budget_focus().as_token(), "weekly");
        assert_eq!(app.cycle_budget_focus().as_token(), "monthly");
        assert_eq!(app.cycle_budget_focus().as_token(), "auto");

        app.budget_focus = BudgetFocus::named("retired");
        assert_eq!(app.cycle_budget_focus().as_token(), "auto");
    }
}
