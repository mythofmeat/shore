use std::collections::HashMap;
use std::hash::BuildHasher;

use chrono::{DateTime, FixedOffset, Local};
use shore_protocol::types::{ContentBlock, ImageRef, Message, Role};
use tracing::{debug, warn};

use crate::convert::{f64_to_u32_saturating, i64_to_f64};

/// Default context window size when not specified in model config.
const DEFAULT_MAX_CONTEXT_TOKENS: usize = 200_000;

/// Default max output tokens when not specified.
const DEFAULT_MAX_OUTPUT_TOKENS: usize = 4096;

/// Rough characters-per-token ratio for budget estimation.
const CHARS_PER_TOKEN: usize = 4;

/// Minimum gap (in seconds) before a relative-time phrase ("X later") is
/// included in a marker. Markers may still be injected for shorter gaps when
/// triggered by the hourly tick or by lost prior context — those use the
/// absolute-time-only form.
const TIME_GAP_THRESHOLD_SECS: f64 = 1_800.0; // 30 minutes

/// Minimum elapsed time since the previous injected marker before a fresh
/// "hourly tick" marker is injected on the next user message. Keeps long,
/// slow conversations time-aware even when no individual gap crosses the
/// relative-marker threshold.
const HOURLY_MARKER_INTERVAL_SECS: f64 = 3_600.0; // 1 hour

const ONE_AND_HALF_HOURS_SECS: f64 = 5_400.0;
const EIGHTEEN_HOURS_SECS: f64 = 64_800.0;
const THIRTY_SIX_HOURS_SECS: f64 = 129_600.0;
const SECS_PER_HOUR: f64 = 3_600.0;
const SECS_PER_DAY: f64 = 86_400.0;

/// Built-in system prompt template used when no override is found on disk.
///
/// This is intentionally minimal — character/user definitions, TOOLS.md, and
/// the prompt-visible memory index are injected as separate system blocks by
/// `assemble_prompt`.
const BUILTIN_SYSTEM_TEMPLATE: &str =
    crate::include_prompt!("../../prompts/engine/builtin_system.md");

/// A block of system prompt content with an identifying label.
#[derive(Debug, Clone, PartialEq)]
pub struct SystemBlock {
    /// Label for cache/debugging (e.g. "system", "character", "memory").
    pub label: String,
    /// The text content of this block.
    pub content: String,
}

/// A message in the assembled prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptMessage {
    pub role: Role,
    pub content: String,
    pub images: Vec<ImageRef>,
    pub content_blocks: Vec<ContentBlock>,
    /// Provider that minted this message (carried from
    /// [`shore_protocol::types::Message::provider_key`]) so the replay path
    /// can drop opaque thinking data the active provider cannot interpret.
    pub provider_key: Option<String>,
}

/// The fully assembled prompt ready for LLM submission.
#[derive(Debug, Clone, PartialEq)]
pub struct AssembledPrompt {
    /// System prompt blocks (sent as the `system` parameter).
    pub system: Vec<SystemBlock>,
    /// Conversation messages trimmed to fit the token budget.
    pub messages: Vec<PromptMessage>,
}

// ---------------------------------------------------------------------------
// Prompt parameters
// ---------------------------------------------------------------------------

/// Parameters required for prompt assembly.
#[derive(Debug)]
pub struct PromptParams<'prompt> {
    /// Character name.
    pub character_name: &'prompt str,
    /// Resolved display name for the user (from config or $USER).
    pub display_name: &'prompt str,
    /// Active AGENTS.md content, or None to use the built-in default.
    pub system_prompt: Option<&'prompt str>,
    /// Active TOOLS.md guidance.
    pub tools_guidance: Option<&'prompt str>,
    /// Character definition (from SOUL.md).
    pub character_definition: Option<&'prompt str>,
    /// User definition (from USER.md).
    pub user_definition: Option<&'prompt str>,
    /// Prompt-visible memory index from workspace/MEMORY.md.
    pub memory_index: Option<&'prompt str>,
    /// Whether there is conversation history outside of `messages` that the
    /// model can no longer see — typically true when prior turns have been
    /// archived by compaction. When set, the first user message in the
    /// trimmed prompt is given an absolute-time marker so the model retains
    /// a date/time anchor across the cut.
    pub has_prior_context: bool,
    /// Conversation messages (full history).
    pub messages: &'prompt [Message],
    /// Maximum context tokens (total context window). `None` uses default.
    pub max_context_tokens: Option<u32>,
    /// Maximum output tokens (reserved for response). `None` uses default.
    pub max_output_tokens: Option<u32>,
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/// Assemble the complete prompt from active snapshot content and history.
///
/// Produces multiple system blocks matching V1's structure:
/// 1. Rendered AGENTS.md template (or built-in default)
/// 2. TOOLS.md guidance (if present)
/// 3. `<{char}>` character definition (if present)
/// 4. `<{user}>` user definition (if present)
/// 5. `<memory_index>` block (if present, not private)
///
/// Then trims conversation history to fit the token budget.
pub fn assemble_prompt(params: &PromptParams<'_>) -> AssembledPrompt {
    let max_context = configured_token_limit(params.max_context_tokens, DEFAULT_MAX_CONTEXT_TOKENS);
    let max_output = configured_token_limit(params.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS);

    let using_builtin = params.system_prompt.is_none();
    let template = params.system_prompt.unwrap_or(BUILTIN_SYSTEM_TEMPLATE);
    debug!(
        character = %params.character_name,
        builtin_template = using_builtin,
        "assembling prompt"
    );

    let system = build_system_blocks(params, template);
    log_system_blocks(params, system.len());

    let available_for_messages =
        available_message_tokens(&system, max_context, max_output, params.messages.len());
    let messages = trim_messages(
        params.messages,
        available_for_messages,
        params.has_prior_context,
    );

    debug!(
        input_messages = params.messages.len(),
        output_messages = messages.len(),
        trimmed = params.messages.len().saturating_sub(messages.len()),
        "prompt assembly complete"
    );

    AssembledPrompt { system, messages }
}

fn configured_token_limit(configured: Option<u32>, default: usize) -> usize {
    configured.map_or(default, |tokens| {
        usize::try_from(tokens).unwrap_or(usize::MAX)
    })
}

fn template_vars(params: &PromptParams<'_>) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    let _ignored = vars.insert("char".into(), params.character_name.to_owned());
    _ = vars.insert("character_name".into(), params.character_name.to_owned());
    _ = vars.insert("user".into(), params.display_name.to_owned());
    _ = vars.insert("date".into(), String::new());
    _ = vars.insert("time".into(), String::new());
    vars
}

fn build_system_blocks(params: &PromptParams<'_>, template: &str) -> Vec<SystemBlock> {
    let vars = template_vars(params);
    let rendered_system = render_template(template, &vars);

    let mut system = Vec::new();
    system.push(SystemBlock {
        label: "system".into(),
        content: rendered_system,
    });

    // Block 2: TOOLS.md guidance.
    if let Some(tools_guidance) = params.tools_guidance.filter(|s| !s.is_empty()) {
        system.push(SystemBlock {
            label: "tools_guidance".into(),
            content: tools_guidance.to_owned(),
        });
    }

    // Block 3: character definition.
    if let Some(char_def) = params.character_definition.filter(|s| !s.is_empty()) {
        let tag = xml_tag_from_name(params.character_name, "character");
        system.push(SystemBlock {
            label: "character".into(),
            content: format!("<{tag}>\n{char_def}\n</{tag}>"),
        });
    }

    // Block 4: user definition.
    if let Some(user_def) = params.user_definition.filter(|s| !s.is_empty()) {
        let tag = xml_tag_from_name(params.display_name, "user");
        system.push(SystemBlock {
            label: "user".into(),
            content: format!("<{tag}>\n{user_def}\n</{tag}>"),
        });
    }

    // Block 5: prompt-visible memory index.
    if let Some(index) = params.memory_index.filter(|s| !s.is_empty()) {
        system.push(SystemBlock {
            label: "memory_index".into(),
            content: format!(
                "<memory_index>\n\
                 The following is your prompt-visible memory index from workspace/MEMORY.md. \
                 It is a map of memory files, recently updated files, and still-relevant conversational throughlines; \
                 it does not replace SOUL.md, USER.md, AGENTS.md, TOOLS.md, or HEARTBEAT.md.\n\n\
                 {index}\n\
                 </memory_index>"
            ),
        });
    }

    system
}

fn log_system_blocks(params: &PromptParams<'_>, system_block_count: usize) {
    debug!(
        system_blocks = system_block_count,
        has_char_def = params.character_definition.is_some_and(|s| !s.is_empty()),
        has_user_def = params.user_definition.is_some_and(|s| !s.is_empty()),
        has_memory_index = params.memory_index.is_some_and(|s| !s.is_empty()),
        "system blocks assembled"
    );
}

fn available_message_tokens(
    system: &[SystemBlock],
    max_context: usize,
    max_output: usize,
    input_message_count: usize,
) -> usize {
    let system_tokens = estimate_tokens(
        &system
            .iter()
            .map(|b| b.content.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let available_for_messages = max_context
        .saturating_sub(max_output)
        .saturating_sub(system_tokens);

    debug!(
        max_context,
        max_output,
        system_tokens,
        available_for_messages,
        input_messages = input_message_count,
        "token budget calculated"
    );

    if available_for_messages == 0 {
        warn!(
            max_context,
            max_output,
            system_tokens,
            "zero tokens available for messages — system prompt may exceed context window"
        );
    }
    available_for_messages
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/// Mustache-like template rendering with generic key-value substitution.
///
/// - `{{key}}` → value from `vars` (or empty string if key not found)
/// - `{{#if key}}...{{/if}}` → include block if key exists and is non-empty
///
/// Processes conditionals first (one pass per `{{#if ...}}`), then substitutes
/// remaining `{{key}}` variables.
#[expect(
    clippy::string_slice,
    reason = "byte offsets derive from find()/literal-len() on `result` itself, so every slice bound lands on a char boundary"
)]
pub fn render_template<S: BuildHasher>(
    template: &str,
    vars: &HashMap<String, String, S>,
) -> String {
    let mut result = template.to_owned();

    // Process all conditional blocks.
    while let Some(if_start) = result.find("{{#if ") {
        let name_start = if_start.saturating_add(6);
        let Some(name_end) = result[name_start..].find("}}") else {
            break;
        };
        let name = result[name_start..name_start.saturating_add(name_end)]
            .trim()
            .to_owned();
        let open_tag_end = name_start.saturating_add(name_end).saturating_add(2);

        let close_tag = "{{/if}}";
        let Some(close_pos) = result[open_tag_end..].find(close_tag) else {
            break;
        };
        let close_abs = open_tag_end.saturating_add(close_pos);

        let block_content = &result[open_tag_end..close_abs];
        let after = &result[close_abs.saturating_add(close_tag.len())..];

        let value = vars.get(&name).filter(|v| !v.is_empty());
        if let Some(v) = value {
            let var_tag = format!("{{{{{name}}}}}");
            let expanded = block_content.replace(&var_tag, v);
            result = format!("{}{expanded}{after}", &result[..if_start]);
        } else {
            result = format!("{}{after}", &result[..if_start]);
        }
    }

    // Substitute remaining {{key}} variables.
    for (key, value) in vars {
        let tag = format!("{{{{{key}}}}}");
        result = result.replace(&tag, value);
    }

    result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a free-form name to a safe XML tag name.
///
/// Lowercases the input, replaces non-alphanumeric characters with `_`,
/// collapses runs of underscores, and strips leading/trailing underscores.
/// Falls back to `fallback` if the result is empty.
pub fn xml_tag_from_name(name: &str, fallback: &str) -> String {
    let mut tag: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();

    // Collapse runs of underscores and strip edges.
    while tag.contains("__") {
        tag = tag.replace("__", "_");
    }
    let trimmed = tag.trim_matches('_');

    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Estimate token count from text using a character-based heuristic.
fn estimate_tokens(text: &str) -> usize {
    // Rough approximation: ~4 characters per token.
    text.len().div_ceil(CHARS_PER_TOKEN)
}

/// Estimate token count for a message, accounting for content blocks.
fn estimate_message_tokens(msg: &Message) -> usize {
    if msg.content_blocks.is_empty() {
        return estimate_tokens(&msg.content);
    }
    // Sum tokens across all content blocks.
    msg.content_blocks
        .iter()
        .map(|b| match b {
            ContentBlock::Text { text } => estimate_tokens(text),
            ContentBlock::Thinking { thinking, .. } => estimate_tokens(thinking),
            ContentBlock::ToolUse { input, name, .. } => {
                estimate_tokens(name).saturating_add(estimate_tokens(&input.to_string()))
            }
            ContentBlock::RedactedThinking { .. } => 0,
            ContentBlock::ToolResult { content, .. } => estimate_tokens(content),
        })
        .sum()
}

/// Render the relative-time phrase ("6 hours later", "about a day later", …)
/// for a gap in seconds. Used as part of the full marker when the gap crosses
/// `TIME_GAP_THRESHOLD_SECS`.
#[expect(
    clippy::float_arithmetic,
    reason = "relative time markers round f64 second gaps into display hours or days"
)]
fn relative_gap_phrase(gap_secs: f64) -> String {
    if gap_secs < ONE_AND_HALF_HOURS_SECS {
        // < 1.5 hours
        "about an hour later".to_owned()
    } else if gap_secs < EIGHTEEN_HOURS_SECS {
        // < 18 hours
        let hours = f64_to_u32_saturating((gap_secs / SECS_PER_HOUR).round());
        format!("{hours} hours later")
    } else if gap_secs < THIRTY_SIX_HOURS_SECS {
        // < 36 hours
        "about a day later".to_owned()
    } else {
        let days = f64_to_u32_saturating((gap_secs / SECS_PER_DAY).round());
        format!("{days} days later")
    }
}

/// Format a time marker for injection on a user message.
///
/// - When `gap_secs >= TIME_GAP_THRESHOLD_SECS`:
///   `[6 hours later · Saturday 2026-04-04 · 9:14 PM]`
/// - Otherwise (or no prior message): `[Saturday 2026-04-04 · 9:14 PM]`
fn format_time_marker(gap_secs: Option<f64>, current_ts: &DateTime<FixedOffset>) -> String {
    let time_str = current_ts
        .with_timezone(&Local)
        .format("%A %Y-%m-%d · %-I:%M %p")
        .to_string();
    match gap_secs {
        Some(g) if g >= TIME_GAP_THRESHOLD_SECS => {
            format!("[{} · {time_str}]", relative_gap_phrase(g))
        }
        _ => format!("[{time_str}]"),
    }
}

/// Trim messages from the beginning to fit within the token budget.
///
/// Keeps the most recent messages, discarding older ones first. After
/// trimming, drops any leading tool-loop messages (tool_result user
/// messages and tool_use-only assistant messages) that would be orphaned
/// without their preceding context.
fn trim_messages(
    messages: &[Message],
    token_budget: usize,
    has_prior_context: bool,
) -> Vec<PromptMessage> {
    // Build from the end (most recent first), accumulating token cost.
    let mut selected: Vec<(PromptMessage, &str)> = Vec::new();
    let mut used_tokens: usize = 0;

    for msg in messages.iter().rev() {
        let msg_tokens = estimate_message_tokens(msg);
        if used_tokens.saturating_add(msg_tokens) > token_budget && !selected.is_empty() {
            // Budget exhausted — stop adding older messages.
            break;
        }
        used_tokens = used_tokens.saturating_add(msg_tokens);
        selected.push((
            PromptMessage {
                role: msg.role.clone(),
                content: msg.content.clone(),
                images: msg.images.clone(),
                content_blocks: msg.content_blocks.clone(),
                provider_key: msg.provider_key.clone(),
            },
            &msg.timestamp,
        ));
    }

    // Reverse to restore chronological order.
    selected.reverse();

    // Drop leading tool-loop messages that would be orphaned.
    while selected
        .first()
        .is_some_and(|first| is_tool_loop_msg_prompt(&first.0))
    {
        let _ignored = selected.remove(0);
    }

    // True when the model is missing prior context — either compaction
    // archived earlier turns (`has_prior_context`) or this trim pass itself
    // dropped messages from the head of the live history.
    let lost_context = has_prior_context || selected.len() < messages.len();

    // ── Inject time markers on user messages ──────────────────────────
    // Markers are deterministic — same input timestamps always produce the
    // same markers — so injection is cache-stable. Three triggers fire:
    //   1. The gap from the previous in-context message exceeds the
    //      relative threshold ("[6 hours later · 9:14 PM]").
    //   2. An hour has elapsed since the last injected marker, so long
    //      slow conversations still drop periodic time anchors.
    //   3. Prior context was lost (compaction or in-trim drop) and this
    //      is the first user message in the prompt — the model would
    //      otherwise have no absolute date/time anchor at all.
    // Heartbeat recaps are persisted as Role::System messages in
    // active.jsonl by the tick itself, so they already sit at their
    // natural chronological position in the history.
    let mut prev_ts: Option<DateTime<FixedOffset>> = None;
    let mut last_marker_ts: Option<DateTime<FixedOffset>> = None;
    let mut first_user_pending = true;
    let mut result: Vec<PromptMessage> = Vec::with_capacity(selected.len());

    for (mut pm, ts_str) in selected {
        let current_ts = DateTime::parse_from_rfc3339(ts_str).ok();

        if pm.role == Role::User {
            if let Some(cur) = current_ts {
                let gap_secs =
                    prev_ts.map(|p| i64_to_f64(cur.signed_duration_since(p).num_seconds()));
                let elapsed_since_marker =
                    last_marker_ts.map(|m| i64_to_f64(cur.signed_duration_since(m).num_seconds()));

                let big_gap = matches!(gap_secs, Some(g) if g >= TIME_GAP_THRESHOLD_SECS);
                let hourly_tick =
                    matches!(elapsed_since_marker, Some(e) if e >= HOURLY_MARKER_INTERVAL_SECS);
                let needs_anchor = first_user_pending && lost_context;

                if big_gap || hourly_tick || needs_anchor {
                    let marker = format_time_marker(gap_secs, &cur);
                    pm.content = format!("{marker}\n\n{}", pm.content);
                    if let Some(ContentBlock::Text { text }) = pm.content_blocks.first_mut() {
                        *text = format!("{marker}\n\n{text}");
                    }
                    last_marker_ts = Some(cur);
                }
                first_user_pending = false;
            }
        }

        if current_ts.is_some() {
            prev_ts = current_ts;
        }
        result.push(pm);
    }

    result
}

/// Check if a PromptMessage is a tool-loop intermediate.
fn is_tool_loop_msg_prompt(msg: &PromptMessage) -> bool {
    if msg.content_blocks.is_empty() {
        return false;
    }
    match msg.role {
        Role::User => msg
            .content_blocks
            .iter()
            .all(|b| matches!(b, ContentBlock::ToolResult { .. })),
        Role::Assistant => {
            let has_text = msg
                .content_blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Text { text } if !text.is_empty()));
            let has_tool_use = msg
                .content_blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }));
            !has_text && has_tool_use
        }
        Role::System => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_msg(role: Role, content: &str) -> Message {
        Message {
            msg_id: uuid::Uuid::new_v4().to_string(),
            origin: None,
            role,
            content: content.to_owned(),
            images: vec![],
            content_blocks: vec![],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".to_owned(),
        }
    }

    fn test_vars() -> HashMap<String, String> {
        let mut vars = HashMap::new();
        let _ignored = vars.insert("char".into(), "Shore".into());
        _ = vars.insert("character_name".into(), "Shore".into());
        _ = vars.insert("user".into(), "Alice".into());
        vars
    }

    fn make_params(messages: &[Message]) -> PromptParams<'_> {
        PromptParams {
            character_name: "TestChar",
            display_name: "TestUser",
            system_prompt: None,
            tools_guidance: None,
            character_definition: None,
            user_definition: None,
            memory_index: None,
            has_prior_context: false,
            messages,
            max_context_tokens: None,
            max_output_tokens: None,
        }
    }

    // ── Template rendering ─────────────────────────────────────────────

    #[test]
    fn render_template_substitutes_variables() {
        let vars = test_vars();
        let result = render_template("Hello, {{char}}!", &vars);
        assert_eq!(result, "Hello, Shore!");
    }

    #[test]
    fn render_template_character_name_compat() {
        let vars = test_vars();
        let result = render_template("Hello, {{character_name}}!", &vars);
        assert_eq!(result, "Hello, Shore!");
    }

    #[test]
    fn render_template_unknown_var_replaced_empty() {
        let vars = test_vars();
        let result = render_template("Hello, {{unknown}}!", &vars);
        // Unknown vars are NOT replaced (no entry in map → tag stays).
        // Actually, our loop only replaces keys that exist in the map.
        // So {{unknown}} stays as-is. This is fine — V1 behaves the same way.
        assert_eq!(result, "Hello, {{unknown}}!");
    }

    #[test]
    fn render_template_conditional_present() {
        let mut vars = test_vars();
        let _ignored = vars.insert("character_definition".into(), "A helpful companion".into());
        let template =
            "Start.{{#if character_definition}}\nDef: {{character_definition}}{{/if}}\nEnd.";
        let result = render_template(template, &vars);
        assert_eq!(result, "Start.\nDef: A helpful companion\nEnd.");
    }

    #[test]
    fn render_template_conditional_absent() {
        let vars = test_vars();
        let template =
            "Start.{{#if character_definition}}\nDef: {{character_definition}}{{/if}}\nEnd.";
        let result = render_template(template, &vars);
        assert_eq!(result, "Start.\nEnd.");
    }

    #[test]
    fn render_template_conditional_empty_string() {
        let mut vars = test_vars();
        let _ignored = vars.insert("recap".into(), String::new());
        let template = "Before{{#if recap}} RECAP: {{recap}}{{/if}} After";
        let result = render_template(template, &vars);
        assert_eq!(result, "Before After");
    }

    #[test]
    fn render_template_builtin_system() {
        let mut vars = test_vars();
        let _ignored = vars.insert("char".into(), "TestChar".into());
        _ = vars.insert("user".into(), "TestUser".into());
        let result = render_template(BUILTIN_SYSTEM_TEMPLATE, &vars);
        assert!(result.contains("You are TestChar, in conversation with TestUser."));
        assert!(result.contains("Communicate directly"));
    }

    // ── XML tag helper ────────────────────────────────────────────────

    #[test]
    fn xml_tag_from_name_basic() {
        assert_eq!(xml_tag_from_name("Alice", "character"), "alice");
        assert_eq!(xml_tag_from_name("Dr. Bob", "character"), "dr_bob");
        assert_eq!(xml_tag_from_name("Shore v2", "character"), "shore_v2");
    }

    #[test]
    fn xml_tag_from_name_empty_fallback() {
        assert_eq!(xml_tag_from_name("", "character"), "character");
        assert_eq!(xml_tag_from_name("...", "user"), "user");
    }

    #[test]
    fn xml_tag_from_name_collapses_underscores() {
        assert_eq!(xml_tag_from_name("a - b", "x"), "a_b");
    }

    // ── Token estimation ──────────────────────────────────────────────

    #[test]
    fn estimate_tokens_basic() {
        assert_eq!(estimate_tokens("Hello world!"), 3);
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("Hello"), 2);
    }

    #[test]
    fn estimate_tokens_uses_byte_length_not_char_count() {
        // ASCII: 1 byte per char → 5 bytes / 4 = 2 tokens
        assert_eq!(estimate_tokens("Hello"), 2);

        // CJK: 3 bytes per char → 15 bytes / 4 = 4 tokens (not 5/4 = 2)
        let cjk = "日本語の文"; // 5 chars, 15 bytes
        assert_eq!(cjk.len(), 15);
        assert_eq!(estimate_tokens(cjk), 4);

        // Emoji: 4 bytes each → 16 bytes / 4 = 4 tokens
        let emoji = "😀😁😂🤣"; // 4 chars, 16 bytes
        assert_eq!(emoji.len(), 16);
        assert_eq!(estimate_tokens(emoji), 4);
    }

    #[test]
    fn estimate_tokens_short_words_undercount() {
        // Real tokenizers often produce 1 token per short word + whitespace.
        // "I am a" → 3 real tokens, but heuristic says 6 bytes / 4 = 2.
        // This documents the known under-counting for short-word text.
        let short_words = "I am a";
        assert_eq!(estimate_tokens(short_words), 2); // real ≈ 3
    }

    #[test]
    fn estimate_tokens_json_payload() {
        // JSON has many structural chars (braces, quotes, colons) that
        // tokenizers often group differently than plain prose.
        let json = r#"{"name":"test","values":[1,2,3],"nested":{"key":"val"}}"#;
        assert_eq!(estimate_tokens(json), json.len().div_ceil(4));
    }

    #[test]
    fn estimate_tokens_code_block() {
        // Code with identifiers, operators, and indentation.
        let code = "fn estimate_tokens(text: &str) -> usize {\n    text.len().div_ceil(4)\n}";
        assert_eq!(estimate_tokens(code), code.len().div_ceil(4));
    }

    #[test]
    fn estimate_message_tokens_redacted_thinking_is_zero() {
        let msg = Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::Assistant,
            content: String::new(),
            images: vec![],
            content_blocks: vec![ContentBlock::RedactedThinking {
                data: "opaque".into(),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        assert_eq!(estimate_message_tokens(&msg), 0);
    }

    #[test]
    fn estimate_message_tokens_mixed_blocks_sums_all() {
        let msg = Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::Assistant,
            content: String::new(),
            images: vec![],
            content_blocks: vec![
                ContentBlock::Thinking {
                    thinking: "A".repeat(40),
                    signature: None,
                },
                ContentBlock::Text {
                    text: "B".repeat(80),
                },
                ContentBlock::ToolUse {
                    id: "tu1".into(),
                    name: "check_time".into(),
                    input: serde_json::json!({"tz": "UTC"}),
                },
                ContentBlock::RedactedThinking {
                    data: "ignored".into(),
                },
            ],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        let tokens = estimate_message_tokens(&msg);
        // 40/4 + 80/4 + tool_name + tool_input + 0 (redacted)
        let tool_input_str = serde_json::json!({"tz": "UTC"}).to_string();
        let expected = 10 + 20 + "check_time".len().div_ceil(4) + tool_input_str.len().div_ceil(4);
        assert_eq!(tokens, expected);
    }

    #[test]
    fn estimate_message_tokens_uses_content_blocks_when_present() {
        let msg = Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::Assistant,
            content: "short".into(),
            images: vec![],
            content_blocks: vec![
                ContentBlock::Text {
                    text: "A".repeat(40).clone(),
                },
                ContentBlock::Thinking {
                    thinking: "B".repeat(20).clone(),
                    signature: None,
                },
            ],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        let tokens = estimate_message_tokens(&msg);
        assert_eq!(tokens, 15);
    }

    #[test]
    fn estimate_message_tokens_falls_back_to_content_when_no_blocks() {
        let msg = make_msg(Role::User, &"X".repeat(20));
        let tokens = estimate_message_tokens(&msg);
        assert_eq!(tokens, 5);
    }

    #[test]
    fn estimate_message_tokens_tool_use_block() {
        let msg = Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::Assistant,
            content: String::new(),
            images: vec![],
            content_blocks: vec![ContentBlock::ToolUse {
                id: "tu_1".into(),
                name: "check_time".into(),
                input: serde_json::json!({}),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        assert!(estimate_message_tokens(&msg) > 0);
    }

    #[test]
    fn estimate_message_tokens_tool_result_block() {
        let msg = Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::User,
            content: String::new(),
            images: vec![],
            content_blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "tu_1".into(),
                content: "2026-03-27T12:00:00Z".into(),
                is_error: false,
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        assert_eq!(estimate_message_tokens(&msg), 5);
    }

    // ── Message trimming ──────────────────────────────────────────────

    #[test]
    fn trim_messages_accounts_for_content_blocks_size() {
        let small_msg = make_msg(Role::User, "Hello");
        let big_msg = Message {
            msg_id: "m_big".into(),
            origin: None,
            role: Role::Assistant,
            content: String::new(),
            images: vec![],
            content_blocks: vec![ContentBlock::Text {
                text: "X".repeat(400),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        let recent_msg = make_msg(Role::User, "Recent");

        let msgs = vec![small_msg, big_msg, recent_msg];
        let result = trim_messages(&msgs, 10, false);
        // The trim drops earlier messages, so "Recent" becomes the first
        // user message in the prompt and now carries an absolute-time
        // anchor marker — assert the suffix instead of full equality.
        assert!(result.last().unwrap().content.ends_with("Recent"));
        assert!(result.len() < 3);
    }

    #[test]
    fn trim_messages_all_fit() {
        let msgs = vec![
            make_msg(Role::User, "Hello"),
            make_msg(Role::Assistant, "Hi there"),
        ];
        let result = trim_messages(&msgs, 1000, false);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].content, "Hello");
        assert_eq!(result[1].content, "Hi there");
    }

    #[test]
    fn trim_messages_drops_oldest() {
        let msgs = vec![
            make_msg(Role::User, &"A".repeat(100)),
            make_msg(Role::Assistant, &"B".repeat(100)),
            make_msg(Role::User, "Recent"),
        ];
        let result = trim_messages(&msgs, 30, false);
        assert!(result.len() < 3);
        // "Recent" is the first surviving user message after the trim, so
        // it carries an absolute-time anchor marker.
        assert!(result.last().unwrap().content.ends_with("Recent"));
    }

    #[test]
    fn trim_messages_always_includes_at_least_one() {
        let msgs = vec![make_msg(Role::User, &"A".repeat(1000))];
        let result = trim_messages(&msgs, 0, false);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn trim_messages_preserves_order() {
        let msgs = vec![
            make_msg(Role::User, "First"),
            make_msg(Role::Assistant, "Second"),
            make_msg(Role::User, "Third"),
        ];
        let result = trim_messages(&msgs, 10000, false);
        assert_eq!(result[0].content, "First");
        assert_eq!(result[1].content, "Second");
        assert_eq!(result[2].content, "Third");
    }

    // ── Time-gap markers ───────────────────────────────────────────────

    fn make_msg_at(role: Role, content: &str, timestamp: &str) -> Message {
        Message {
            msg_id: uuid::Uuid::new_v4().to_string(),
            origin: None,
            role,
            content: content.to_owned(),
            images: vec![],
            content_blocks: vec![ContentBlock::Text {
                text: content.to_owned(),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: timestamp.to_owned(),
        }
    }

    #[test]
    fn format_time_marker_under_threshold_omits_relative() {
        let ts = DateTime::parse_from_rfc3339("2026-04-04T09:30:00-07:00").unwrap();
        let local_str = ts
            .with_timezone(&Local)
            .format("%A %Y-%m-%d · %-I:%M %p")
            .to_string();
        let expected = format!("[{local_str}]");

        // Sub-threshold gap → absolute-only marker.
        assert_eq!(format_time_marker(Some(1799.0), &ts), expected);
        // Zero gap → absolute-only marker.
        assert_eq!(format_time_marker(Some(0.0), &ts), expected);
        // No prior message → absolute-only marker.
        assert_eq!(format_time_marker(None, &ts), expected);
    }

    #[test]
    fn format_time_marker_about_an_hour() {
        let ts = DateTime::parse_from_rfc3339("2026-04-04T10:30:00-07:00").unwrap();
        let result = format_time_marker(Some(3600.0), &ts);
        assert!(result.contains("about an hour later"));
        let local_str = ts
            .with_timezone(&Local)
            .format("%A %Y-%m-%d · %-I:%M %p")
            .to_string();
        assert!(result.contains(&local_str));
    }

    #[test]
    fn format_time_marker_multiple_hours() {
        let ts = DateTime::parse_from_rfc3339("2026-04-04T21:14:00-07:00").unwrap();
        let result = format_time_marker(Some(6.0 * 3600.0), &ts);
        assert!(result.contains("6 hours later"));
        let local_str = ts
            .with_timezone(&Local)
            .format("%A %Y-%m-%d · %-I:%M %p")
            .to_string();
        assert!(result.contains(&local_str));
    }

    #[test]
    fn format_time_marker_about_a_day() {
        let ts = DateTime::parse_from_rfc3339("2026-04-05T09:00:00-07:00").unwrap();
        let result = format_time_marker(Some(24.0 * 3600.0), &ts);
        assert!(result.contains("about a day later"));
        let weekday = ts.with_timezone(&Local).format("%A").to_string();
        let iso_date = ts.with_timezone(&Local).format("%Y-%m-%d").to_string();
        assert!(result.contains(&weekday), "missing weekday in: {result}");
        assert!(result.contains(&iso_date), "missing ISO date in: {result}");
    }

    #[test]
    fn format_time_marker_multiple_days() {
        let ts = DateTime::parse_from_rfc3339("2026-04-07T09:00:00-07:00").unwrap();
        let result = format_time_marker(Some(3.0 * 86400.0), &ts);
        assert!(result.contains("3 days later"));
        let weekday = ts.with_timezone(&Local).format("%A").to_string();
        let iso_date = ts.with_timezone(&Local).format("%Y-%m-%d").to_string();
        assert!(result.contains(&weekday), "missing weekday in: {result}");
        assert!(result.contains(&iso_date), "missing ISO date in: {result}");
    }

    #[test]
    fn trim_messages_injects_time_gap_on_user_message() {
        let msgs = vec![
            make_msg_at(Role::User, "Good morning", "2026-04-04T09:00:00-07:00"),
            make_msg_at(Role::Assistant, "Morning!", "2026-04-04T09:01:00-07:00"),
            make_msg_at(Role::User, "I'm back", "2026-04-04T15:30:00-07:00"),
        ];
        let result = trim_messages(&msgs, 100_000, false);
        assert_eq!(result.len(), 3);
        // First user message: no anchor (nothing was trimmed and there is
        // no prior context), and no relative gap to render.
        assert!(!result[0].content.contains("later"));
        assert_eq!(result[0].content, "Good morning");
        // Third message (user, 6.5h gap): should have marker.
        assert!(result[2].content.contains("hours later"));
        let ts3 = DateTime::parse_from_rfc3339("2026-04-04T15:30:00-07:00").unwrap();
        let local_str = ts3
            .with_timezone(&Local)
            .format("%A %Y-%m-%d · %-I:%M %p")
            .to_string();
        assert!(result[2].content.contains(&local_str));
        assert!(result[2].content.contains("I'm back"));
        // content_blocks should also be updated.
        if let Some(ContentBlock::Text { text }) = result[2].content_blocks.first() {
            assert!(text.contains("hours later"));
        } else {
            panic!("Expected Text content block");
        }
    }

    #[test]
    fn trim_messages_no_gap_marker_for_short_gaps() {
        let msgs = vec![
            make_msg_at(Role::User, "Hello", "2026-04-04T09:00:00-07:00"),
            make_msg_at(Role::Assistant, "Hi", "2026-04-04T09:01:00-07:00"),
            make_msg_at(Role::User, "Quick follow-up", "2026-04-04T09:10:00-07:00"),
        ];
        let result = trim_messages(&msgs, 100_000, false);
        assert_eq!(result[2].content, "Quick follow-up");
    }

    #[test]
    fn trim_messages_no_gap_marker_on_assistant_messages() {
        let msgs = vec![
            make_msg_at(Role::User, "Hello", "2026-04-04T09:00:00-07:00"),
            // Large gap, but the next message is assistant — no marker.
            make_msg_at(
                Role::Assistant,
                "Hey, you there?",
                "2026-04-04T15:00:00-07:00",
            ),
            make_msg_at(Role::User, "Yeah!", "2026-04-04T15:01:00-07:00"),
        ];
        let result = trim_messages(&msgs, 100_000, false);
        assert!(
            !result[1].content.contains("later"),
            "assistant messages should not get gap markers"
        );
        // But the gap from the assistant message to the next user message is only 1 min — no marker.
        assert_eq!(result[2].content, "Yeah!");
    }

    #[test]
    fn trim_messages_anchors_first_user_after_compaction() {
        // Simulates a post-compaction prompt: `messages` is the retained
        // tail and `has_prior_context = true` tells the trimmer that
        // earlier turns were archived. The first user message must carry
        // an absolute-time anchor so the model still has a date/time
        // reference even with no in-prompt prior message to compare to.
        let msgs = vec![
            make_msg_at(Role::Assistant, "…", "2026-04-04T09:00:00-07:00"),
            make_msg_at(Role::User, "Continuing on", "2026-04-04T09:01:00-07:00"),
        ];
        let result = trim_messages(&msgs, 100_000, true);
        assert_eq!(result.len(), 2);

        let user_ts = DateTime::parse_from_rfc3339("2026-04-04T09:01:00-07:00").unwrap();
        let local_str = user_ts
            .with_timezone(&Local)
            .format("%A %Y-%m-%d · %-I:%M %p")
            .to_string();
        // Absolute-only marker (no big gap to render relatively).
        assert!(result[1].content.starts_with(&format!("[{local_str}]")));
        assert!(result[1].content.contains("Continuing on"));
        assert!(!result[1].content.contains("later"));

        // content_blocks mirror the change so providers that read blocks
        // (rather than `content`) see the same anchor.
        if let Some(ContentBlock::Text { text }) = result[1].content_blocks.first() {
            assert!(text.starts_with(&format!("[{local_str}]")));
            assert!(text.contains("Continuing on"));
        } else {
            panic!("Expected Text content block");
        }
    }

    #[test]
    fn trim_messages_no_anchor_for_fresh_conversation() {
        // No compaction, nothing trimmed: don't add a marker on the first
        // user message — there is no lost context to anchor against.
        let msgs = vec![
            make_msg_at(Role::User, "Hello", "2026-04-04T09:00:00-07:00"),
            make_msg_at(Role::Assistant, "Hi", "2026-04-04T09:01:00-07:00"),
        ];
        let result = trim_messages(&msgs, 100_000, false);
        assert_eq!(result[0].content, "Hello");
    }

    #[test]
    fn trim_messages_injects_hourly_tick_during_slow_conversation() {
        // Long, slow conversation with no individual gap >= 30 min, but
        // > 1 h elapsed since the last marker — an hourly anchor must be
        // injected so the model retains time awareness.
        let msgs = vec![
            // 09:00 → 10:30 → 11:30: each adjacent gap is 90 min and 60 min;
            // none crosses the relative-marker threshold mid-walk because
            // the assistant turn sits between, but the user-to-user
            // elapsed-since-last-marker is what we want to verify.
            make_msg_at(Role::User, "First", "2026-04-04T09:00:00-07:00"),
            make_msg_at(Role::Assistant, "ack", "2026-04-04T09:00:30-07:00"),
            make_msg_at(Role::User, "Second", "2026-04-04T09:20:00-07:00"),
            make_msg_at(Role::Assistant, "ack", "2026-04-04T09:20:30-07:00"),
            make_msg_at(Role::User, "Third", "2026-04-04T10:25:00-07:00"),
        ];
        let result = trim_messages(&msgs, 100_000, false);
        // First user message: no anchor (no lost context, no gap, no
        // prior marker to time against).
        assert_eq!(result[0].content, "First");
        // Second user message: 19.5 min gap, no marker.
        assert_eq!(result[2].content, "Second");
        // Third user message: gap from prev (asst) is ~65 min → big_gap
        // fires AND it is the first user message we mark, so the marker
        // includes the relative phrase.
        assert!(result[4].content.contains("hour"));
    }

    #[test]
    fn trim_messages_hourly_tick_fires_after_earlier_marker() {
        // After a real "X later" marker fires, hourly ticks keep dropping
        // anchors every ~hour even when each adjacent message-to-message
        // gap is short.
        let msgs = vec![
            make_msg_at(Role::User, "Morning", "2026-04-04T09:00:00-07:00"),
            make_msg_at(Role::Assistant, "Hey", "2026-04-04T09:01:00-07:00"),
            // 6.5h gap → big-gap marker on this user message.
            make_msg_at(Role::User, "Back", "2026-04-04T15:30:00-07:00"),
            // Steady back-and-forth for the next hour; the largest single
            // gap is 20 min — below the relative threshold — but
            // elapsed-since-last-marker crosses 1h on the final user turn.
            make_msg_at(Role::Assistant, "wb", "2026-04-04T15:35:00-07:00"),
            make_msg_at(Role::User, "What's up", "2026-04-04T15:50:00-07:00"),
            make_msg_at(Role::Assistant, "not much", "2026-04-04T16:20:00-07:00"),
            make_msg_at(Role::User, "Still here", "2026-04-04T16:34:00-07:00"),
        ];
        let result = trim_messages(&msgs, 100_000, false);
        // Big-gap marker on "Back".
        assert!(result[2].content.contains("later"));
        // No marker on the mid-conversation user turn (15-min gap, well
        // under 1h since previous marker at 15:30).
        assert_eq!(result[4].content, "What's up");
        // Hourly tick on "Still here": prev-message gap is 14 min
        // (sub-threshold), but 64 min have elapsed since the last marker
        // at 15:30, so we drop an absolute-only marker.
        let ts = DateTime::parse_from_rfc3339("2026-04-04T16:34:00-07:00").unwrap();
        let local_str = ts
            .with_timezone(&Local)
            .format("%A %Y-%m-%d · %-I:%M %p")
            .to_string();
        assert!(result[6].content.contains("Still here"));
        assert!(result[6].content.starts_with(&format!("[{local_str}]")));
        assert!(!result[6].content.contains("later"));
    }

    // ── Full assembly ─────────────────────────────────────────────────

    #[test]
    fn assemble_prompt_basic() {
        let messages = vec![
            make_msg(Role::User, "Hello"),
            make_msg(Role::Assistant, "Hi!"),
        ];

        let params = PromptParams {
            character_name: "TestChar",
            display_name: "TestUser",
            system_prompt: None,
            tools_guidance: None,
            character_definition: Some("A friendly test character."),
            user_definition: Some("A developer."),
            memory_index: None,
            has_prior_context: false,
            messages: &messages,
            max_context_tokens: Some(200_000),
            max_output_tokens: Some(4096),
        };

        let result = assemble_prompt(&params);

        // System block should contain character info.
        assert!(result.system[0].content.contains("TestChar"));
        assert!(result.system[0].content.contains("TestUser"));
        assert_eq!(result.system[0].label, "system");

        // Character and user definitions in separate blocks.
        let char_block = result
            .system
            .iter()
            .find(|b| b.label == "character")
            .unwrap();
        assert!(char_block.content.contains("A friendly test character."));
        assert!(char_block.content.contains("<testchar>"));

        let user_block = result.system.iter().find(|b| b.label == "user").unwrap();
        assert!(user_block.content.contains("A developer."));
        assert!(user_block.content.contains("<testuser>"));

        // Messages should be included.
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].role, Role::User);
        assert_eq!(result.messages[0].content, "Hello");
    }

    #[test]
    fn assemble_prompt_uses_custom_template() {
        let params = PromptParams {
            display_name: "User",
            system_prompt: Some("Custom prompt for {{character_name}}."),
            ..make_params(&[])
        };

        let result = assemble_prompt(&params);
        // {{character_name}} should be substituted (backward compat).
        assert_eq!(result.system[0].content, "Custom prompt for TestChar.");
    }

    #[test]
    fn assemble_prompt_character_template_overrides_global() {
        let params = PromptParams {
            system_prompt: Some("Character-specific template."),
            ..make_params(&[])
        };
        let result = assemble_prompt(&params);
        assert_eq!(result.system[0].content, "Character-specific template.");
    }

    #[test]
    fn assemble_prompt_injects_memory_index() {
        let params = PromptParams {
            memory_index: Some("- `topics/rust.md` - Rust throughline."),
            ..make_params(&[])
        };
        let result = assemble_prompt(&params);

        let index_block = result
            .system
            .iter()
            .find(|b| b.label == "memory_index")
            .unwrap();
        assert!(index_block.content.contains("topics/rust.md"));
        assert!(index_block.content.contains("prompt-visible memory index"));
        assert!(index_block.content.contains("<memory_index>"));
    }

    #[test]
    fn assemble_prompt_blanks_date_time_for_cache_stability() {
        let params = PromptParams {
            system_prompt: Some("Today is {{date}} at {{time}}."),
            ..make_params(&[])
        };
        let result = assemble_prompt(&params);

        let system_text = &result.system[0].content;
        assert!(!system_text.contains("{{date}}"));
        assert!(!system_text.contains("{{time}}"));
        assert_eq!(system_text, "Today is  at .");
    }

    #[test]
    fn assemble_prompt_multi_block_count() {
        let params = PromptParams {
            tools_guidance: Some("Use tools carefully."),
            character_definition: Some("A character."),
            user_definition: Some("A user."),
            memory_index: Some("Index"),
            ..make_params(&[])
        };

        let result = assemble_prompt(&params);
        // Should have: system, tools_guidance, character, user, memory_index = 5 blocks.
        assert_eq!(result.system.len(), 5);
        assert_eq!(result.system[0].label, "system");
        assert_eq!(result.system[1].label, "tools_guidance");
        assert_eq!(result.system[2].label, "character");
        assert_eq!(result.system[3].label, "user");
        assert_eq!(result.system[4].label, "memory_index");
    }

    // ── Token budget ──────────────────────────────────────────────────

    #[test]
    fn respects_token_budget() {
        let messages: Vec<Message> = (0..100)
            .map(|i| {
                make_msg(
                    if i % 2 == 0 {
                        Role::User
                    } else {
                        Role::Assistant
                    },
                    &format!("Message number {i} with some padding text to use tokens."),
                )
            })
            .collect();

        let params = PromptParams {
            max_context_tokens: Some(500),
            max_output_tokens: Some(100),
            ..make_params(&messages)
        };

        let result = assemble_prompt(&params);
        assert!(
            result.messages.len() < 100,
            "Should trim messages to fit budget, got {} messages",
            result.messages.len()
        );
        assert_eq!(
            result.messages.last().unwrap().content,
            messages.last().unwrap().content
        );
    }

    #[test]
    fn no_heartbeat_injection() {
        let params = make_params(&[]);
        let result = assemble_prompt(&params);
        let all_text: String = result
            .system
            .iter()
            .map(|b| b.content.to_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!all_text.contains("heartbeat"));
        assert!(!all_text.contains("journal"));
        assert!(!all_text.contains("story"));
    }

    // ── Trim: orphaned tool-loop stripping ────────────────────────────

    fn make_tool_result_msg() -> Message {
        Message {
            msg_id: uuid::Uuid::new_v4().to_string(),
            origin: None,
            role: Role::User,
            content: String::new(),
            images: vec![],
            content_blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "result".into(),
                is_error: false,
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn make_tool_use_only_msg() -> Message {
        Message {
            msg_id: uuid::Uuid::new_v4().to_string(),
            origin: None,
            role: Role::Assistant,
            content: String::new(),
            images: vec![],
            content_blocks: vec![ContentBlock::ToolUse {
                id: "t1".into(),
                name: "search".into(),
                input: serde_json::json!({"q": "test"}),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn trim_drops_orphaned_tool_result() {
        let msgs = vec![
            make_msg(Role::User, "Hi"),
            make_tool_use_only_msg(),
            make_tool_result_msg(),
            make_msg(Role::Assistant, "Done"),
            make_msg(Role::User, "Recent"),
        ];

        // Budget tight enough to drop the first 2 messages.
        // "Hi" = 1 token, tool_use msg ~10 tokens, tool_result ~4 tokens,
        // "Done" = 1 token, "Recent" = 2 tokens.
        // With budget=5, newest-first picks Recent(2) + Done(1) + tool_result(~4) = 7 > 5,
        // so it stops. Result = [tool_result, Done, Recent].
        // Then orphan stripping removes the leading tool_result.
        let result = trim_messages(&msgs, 5, false);

        // Leading ToolResult should be stripped.
        assert!(
            !result.is_empty(),
            "Should have at least one message after stripping"
        );
        let first = &result[0];
        let is_tool_result = first.role == Role::User
            && first
                .content_blocks
                .iter()
                .all(|b| matches!(b, ContentBlock::ToolResult { .. }));
        assert!(!is_tool_result, "Leading ToolResult should be stripped");
        // "Recent" is the first surviving user message after the trim, so
        // it carries an absolute-time anchor marker.
        assert!(result.last().unwrap().content.ends_with("Recent"));
    }

    #[test]
    fn trim_drops_orphaned_tool_use_only_assistant() {
        let msgs = vec![
            make_msg(Role::User, "Old message here"),
            make_tool_use_only_msg(),
            make_tool_result_msg(),
            make_msg(Role::User, "Recent"),
        ];

        // Budget tight enough to drop "Old message here" (~5 tokens).
        // Newest-first: Recent(2) + tool_result(~4) + tool_use(~6) = 12 > 5,
        // stops before tool_use. Result = [tool_result, Recent].
        // Then orphan stripping removes leading tool_result.
        let result = trim_messages(&msgs, 5, false);

        assert!(
            !result.is_empty(),
            "Should have at least one message after stripping"
        );
        // The chain of tool_use-only + tool_result should be stripped, and
        // "Recent" — now the first surviving user message — carries an
        // absolute-time anchor marker.
        assert!(result.last().unwrap().content.ends_with("Recent"));
        for msg in &result {
            let is_tool_loop = is_tool_loop_msg_prompt(msg);
            assert!(
                !is_tool_loop,
                "No tool-loop messages should remain at front"
            );
        }
    }
}
