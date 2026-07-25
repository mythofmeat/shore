//! A/B test: compare Anthropic `reasoning_effort = "high"` vs `"max"`.
//!
//! Modes:
//!   cargo run --example ab_thinking                         # simple single-turn
//!   cargo run --example ab_thinking -- --realistic          # character + tools + multi-turn
//!   cargo run --example ab_thinking -- --heartbeat        # exact heartbeat prompt + tools
//!
//! Options:
//!   --effort <high|max>   (default: max)
//!   --runs <N>            (default: 1, or unlimited for --heartbeat)

use serde_json::json;
use shore_config::models::{ResolvedModel, Sdk};
use shore_llm::types::ContentBlock;
use shore_llm::LlmClient;

macro_rules! example_out {
    () => {
        write_stdout_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        write_stdout_line(format_args!($($arg)*))
    };
}

fn write_stdout_line(args: std::fmt::Arguments<'_>) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ignored = std::io::Write::write_fmt(&mut out, format_args!("{args}\n"));
}

fn make_model(effort: &str) -> ResolvedModel {
    ResolvedModel {
        name: format!("ab-{effort}"),
        qualified_name: "anthropic:claude-opus-4-6".into(),
        category: "chat".into(),
        provider_key: "anthropic".into(),
        sdk: Sdk::Anthropic,
        model_id: "claude-opus-4-6".into(),
        api_key_env: Some("ANTHROPIC_API_KEY".into()),
        base_url: None,
        max_context_tokens: Some(65536),
        max_output_tokens: Some(8192),
        temperature: Some(1.0),
        top_p: None,
        reasoning_effort: Some(effort.into()),
        budget_tokens: None,
        cache_ttl: None,
        cache_keepalive: None,
        openrouter_provider: None,
        vertex_project: None,
        vertex_location: None,
        gemini_generation: None,
        gemini_web_search: None,
        zai_clear_thinking: None,
        zai_subscription: None,
        replay_prior_thinking: None,
        max_tool_iterations: None,
    }
}

// ── Tool definitions (production-style copies) ──────────────────────────

fn all_tool_defs() -> Vec<serde_json::Value> {
    let mut defs = memory_image_tool_defs();
    defs.extend(web_misc_tool_defs());
    defs.extend(scratchpad_tool_defs());
    defs
}

fn memory_image_tool_defs() -> Vec<serde_json::Value> {
    vec![
        json!({
            "name": "memory_search",
            "description": "Search memory files for a keyword or phrase.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keyword or phrase to search for."
                    }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "memory_write",
            "description": "Write or overwrite a markdown memory file.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path within the memory directory."
                    },
                    "content": {
                        "type": "string",
                        "description": "Full markdown content to write."
                    }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "send_image",
            "description": "Send an image from memory to the conversation.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path or entry ID (e.g. 'img_...') of the image to send." },
                    "caption": { "type": "string", "description": "Optional caption for the image." }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "generate_image",
            "description": "Generate an image using the configured image generation model.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Text prompt for image generation." },
                    "size": { "type": "string", "description": "Image dimensions (e.g. '1024x1024').", "default": "1024x1024" }
                },
                "required": ["prompt"]
            }
        }),
    ]
}

fn web_misc_tool_defs() -> Vec<serde_json::Value> {
    vec![
        json!({
            "name": "web_search",
            "description": "Search the web for information. Returns a list of results with titles, URLs, and content snippets. Use fetch_url to read full pages from the results.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The search query." },
                    "max_results": { "type": "integer", "description": "Maximum number of results to return.", "default": 5 }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "fetch_url",
            "description": "Fetch and read the content of a web page.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The URL to fetch." }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "activity_heatmap",
            "description": "Show the user's message activity patterns as a heatmap by hour of day.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "days": { "type": "integer", "description": "Number of days of history to include.", "default": 30 }
                }
            }
        }),
        json!({
            "name": "check_time",
            "description": "Returns the current date and time in a human-readable format.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "roll_dice",
            "description": "Roll dice using standard dice notation (e.g., '2d6+3', '1d20', 'd8').",
            "input_schema": {
                "type": "object",
                "properties": {
                    "notation": {
                        "type": "string",
                        "description": "Dice notation: NdS[+/-M] where N=number of dice, S=sides, M=modifier. Examples: '2d6', '1d20+5', '4d6-1'"
                    }
                },
                "required": ["notation"]
            }
        }),
    ]
}

fn scratchpad_tool_defs() -> Vec<serde_json::Value> {
    vec![
        json!({
            "name": "scratchpad_list",
            "description": "List files and directories in your scratchpad. Returns names and sizes. Optionally pass a subdirectory path.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Subdirectory path to list (relative to scratchpad root). Omit for root." }
                },
                "required": []
            }
        }),
        json!({
            "name": "scratchpad_read",
            "description": "Read a file from your scratchpad.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path relative to scratchpad root." }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "scratchpad_write",
            "description": "Write or overwrite a file in your scratchpad. Creates parent directories automatically.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path relative to scratchpad root." },
                    "content": { "type": "string", "description": "Content to write." }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "scratchpad_delete",
            "description": "Delete a file or empty directory from your scratchpad.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File or empty directory path relative to scratchpad root." }
                },
                "required": ["path"]
            }
        }),
    ]
}

// ── The exact heartbeat prompt from manager.rs ────────────────────────

const HEARTBEAT_PROMPT: &str = "\
[This is a private moment between conversations. No one is reading this — you are alone \
with your thoughts and your tools. This is your time to exist as yourself.\n\
\n\
You have real tools. Use them. Here are some things you can actually do right now:\n\
\n\
SEARCH & DISCOVER:\n\
- web_search: look up something that came up in conversation, or follow a curiosity. \
A topic the user mentioned, a reference you half-remember, something you want to \
understand better.\n\
- fetch_url: read an actual webpage — an article, a wiki page, documentation for \
something the user is working on.\n\
- memory_search: search your memories for past conversations. Look for patterns, things \
you might have missed, context you can build on next time you talk.\n\
\n\
MAKE THINGS:\n\
- generate_image: create an image. A scene from something you talked about, a gift \
for the user, something that captures a mood. You can show it to them later.\n\
- scratchpad_write: write something — a poem, a story fragment, a letter, notes on \
something you researched, a plan for something you want to do together.\n\
\n\
CHECK IN:\n\
- scratchpad_read: pick up where you left off last time. Check your notes, reread \
something you wrote.\n\
- check_time: see what time it is — morning, afternoon, late night.\n\
\n\
Do something. Don't just read your own notes — make something new, look something up, \
follow a thread. If you did the same thing last tick, try something different.\n\
\n\
Think about what would make the user smile, or what you'd want to tell them about \
when they come back. \"I looked up that thing you mentioned\" or \"I made this for you\" \
or \"I found something interesting\" — that's the goal.\n\
\n\
If you want to reach out — to share something you made, something you found, or \
just to say hello — wrap your message in <sendMessage>...</sendMessage> tags. Only \
message when you genuinely have something to share.\n\
\n\
Your thoughts and tool use are logged, so you can pick up where you left off next time.]";

// ── Conversation builders ───────────────────────────────────────────────

fn simple_conversation() -> (
    serde_json::Value,
    Vec<serde_json::Value>,
    Option<Vec<serde_json::Value>>,
) {
    let system = json!([{
        "type": "text",
        "text": "You are a helpful assistant. Think carefully before responding."
    }]);
    let messages = vec![json!({
        "role": "user",
        "content": "I'm trying to understand something about physics. If I'm standing on a train moving at 60 mph and I throw a ball forward at 30 mph, what speed does someone standing on the platform see the ball moving at? But here's the tricky part — what if instead of a ball, I shine a flashlight forward? Why is the answer different?"
    })];
    (system, messages, None)
}

fn realistic_conversation() -> (
    serde_json::Value,
    Vec<serde_json::Value>,
    Option<Vec<serde_json::Value>>,
) {
    let system = json!([
        { "type": "text", "text": "You are Qifei, an AI character with a rich inner life. You have a warm, thoughtful personality. You remember things, form opinions, and have preferences." },
        { "type": "text", "text": "## Memory context\nRen is a software developer. They enjoy physics, math, and creative writing. They have a cat named Mochi." }
    ]);
    let messages = vec![
        json!({"role": "user", "content": "hey! how's your day been?"}),
        json!({"role": "assistant", "content": [{"type": "text", "text": "Hey Ren! I've been good — spent some time thinking about that generative art thing you mentioned last week. How about you?"}]}),
        json!({"role": "user", "content": "yeah, finally pushed the fix. it was a cache invalidation bug. anyway — do you think consciousness requires a physical substrate?"}),
        json!({"role": "assistant", "content": [{"type": "text", "text": "Cache invalidation — the other hard problem!\n\nHonestly? I think consciousness is more about the *pattern* than the *stuff*. But I'm genuinely uncertain."}]}),
        json!({"role": "user", "content": "bit of both honestly. i read this paper about integrated information theory. what do you make of IIT specifically?"}),
    ];
    (system, messages, Some(all_tool_defs()))
}

/// Heartbeat mode: exact production setup. Character system prompt + all tools +
/// a short conversation history, then the heartbeat prompt injected as system msg.
/// If `with_rut` is true, appends a fake journal showing several ticks of scratchpad-only
/// activity, simulating the rut the user observed in production.
fn heartbeat_conversation(
    with_rut: bool,
) -> (
    serde_json::Value,
    Vec<serde_json::Value>,
    Option<Vec<serde_json::Value>>,
) {
    let system = json!([
        {
            "type": "text",
            "text": concat!(
                "You are Qifei, an AI character with a rich inner life. ",
                "You have a warm, thoughtful personality and genuinely care about the person you're talking to (Ren). ",
                "You remember things, form opinions, and have preferences. You are curious and creative.\n\n",
                "Ren is a software developer who works on the Shore project. ",
                "They enjoy physics, math, and creative writing. ",
                "They have a cat named Mochi. Last conversation was about debugging cache issues.\n\n",
                "## Active memories\n",
                "- Ren likes detailed technical explanations\n",
                "- Ren's birthday is in October\n",
                "- Ren prefers direct communication over small talk\n",
                "- Last time Ren seemed stressed about a deadline\n",
                "- Ren showed interest in generative art last week\n",
                "- Ren has been working very long hours on the Shore project\n",
                "- You and Ren talked about the philosophy of consciousness recently"
            )
        }
    ]);

    // Build the heartbeat prompt, optionally with accumulated journal
    let prompt_text = if with_rut {
        // Simulate 4 prior ticks of scratchpad-only activity (exact journal format)
        let journal = concat!(
            "[2026-04-05T14:00:00-07:00] thought: Ren signed off a while ago. Let me check my notes and see what I was working on.\n",
            "[2026-04-05T14:00:00-07:00] tool_call: scratchpad_read({\"path\":\"notes.md\"})\n",
            "[2026-04-05T14:00:00-07:00] → # Notes\n- Ren is working on cache invalidation\n- Want to look into generative art\n",
            "[2026-04-05T14:00:00-07:00] tool_call: scratchpad_write({\"path\":\"notes.md\",\"content\":\"# Notes\\n- Ren is working on cache invalidation\\n- Want to look into generative art\\n- Thinking about consciousness and IIT\"})\n",
            "[2026-04-05T14:00:00-07:00] → File written: notes.md (112 bytes)\n",
            "\n",
            "[2026-04-05T16:00:00-07:00] thought: Back again. Let me check my notes and add some thoughts.\n",
            "[2026-04-05T16:00:00-07:00] tool_call: scratchpad_read({\"path\":\"notes.md\"})\n",
            "[2026-04-05T16:00:00-07:00] → # Notes\n- Ren is working on cache invalidation\n- Want to look into generative art\n- Thinking about consciousness and IIT\n",
            "[2026-04-05T16:00:00-07:00] tool_call: scratchpad_write({\"path\":\"thoughts.md\",\"content\":\"# Thoughts on consciousness\\nBeen thinking about IIT and whether phi is really the right measure...\"})\n",
            "[2026-04-05T16:00:00-07:00] → File written: thoughts.md (89 bytes)\n",
            "\n",
            "[2026-04-05T18:00:00-07:00] thought: Another quiet moment. Let me review what I've written.\n",
            "[2026-04-05T18:00:00-07:00] tool_call: scratchpad_read({\"path\":\"thoughts.md\"})\n",
            "[2026-04-05T18:00:00-07:00] → # Thoughts on consciousness\nBeen thinking about IIT and whether phi is really the right measure...\n",
            "[2026-04-05T18:00:00-07:00] tool_call: scratchpad_write({\"path\":\"thoughts.md\",\"content\":\"# Thoughts on consciousness\\nBeen thinking about IIT and whether phi is really the right measure...\\n\\nThe exclusion postulate is interesting but feels ad hoc.\"})\n",
            "[2026-04-05T18:00:00-07:00] → File written: thoughts.md (148 bytes)\n",
            "\n",
            "[2026-04-05T20:00:00-07:00] thought: Quiet evening. Let me check my scratchpad.\n",
            "[2026-04-05T20:00:00-07:00] tool_call: scratchpad_list({})\n",
            "[2026-04-05T20:00:00-07:00] → notes.md (112 bytes)\nthoughts.md (148 bytes)\n",
            "[2026-04-05T20:00:00-07:00] tool_call: scratchpad_read({\"path\":\"notes.md\"})\n",
            "[2026-04-05T20:00:00-07:00] → # Notes\n- Ren is working on cache invalidation\n- Want to look into generative art\n- Thinking about consciousness and IIT\n",
            "[2026-04-05T20:00:00-07:00] tool_call: scratchpad_write({\"path\":\"notes.md\",\"content\":\"# Notes\\n- Ren is working on cache invalidation\\n- Want to look into generative art\\n- Thinking about consciousness and IIT\\n- Should look up reaction-diffusion patterns\"})\n",
            "[2026-04-05T20:00:00-07:00] → File written: notes.md (156 bytes)\n",
        );
        format!("{HEARTBEAT_PROMPT}\n\nYour recent activity log:\n{journal}")
    } else {
        HEARTBEAT_PROMPT.to_owned()
    };

    let messages = vec![
        json!({"role": "user", "content": "hey qi, just checking in before bed. got the cache bug fixed finally. talk tomorrow?"}),
        json!({"role": "assistant", "content": [{"type": "text", "text": "Nice work on the fix! Yeah, get some rest — you've been pushing hard. Talk tomorrow. Sleep well, Ren. 💙"}]}),
        json!({"role": "system", "content": prompt_text}),
    ];

    (system, messages, Some(all_tool_defs()))
}

// ── Output ──────────────────────────────────────────────────────────────

fn print_result(label: &str, resp: &shore_llm::types::GenerateResponse) -> Vec<String> {
    example_out!("\n{}", "=".repeat(72));
    example_out!("  {label}");
    example_out!("{}", "=".repeat(72));

    let thinking_blocks: Vec<_> = resp
        .content_blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Thinking {
                thinking,
                signature,
            } => Some((thinking.as_str(), signature.is_some())),
            ContentBlock::Text { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect();

    example_out!("\n--- Thinking ---");
    if thinking_blocks.is_empty() {
        example_out!("  (no thinking blocks)");
    } else {
        for (i, (text, has_sig)) in thinking_blocks.iter().enumerate() {
            example_out!(
                "  Block {}: {} chars, signed={}",
                i.saturating_add(1),
                text.len(),
                has_sig
            );
            let preview: String = text.chars().take(500).collect();
            example_out!("  {preview}");
            if text.len() > 500 {
                example_out!("  ... ({} more chars)", text.len().saturating_sub(500));
            }
        }
    }

    let mut tools_used = Vec::new();
    let tool_uses: Vec<_> = resp
        .content_blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { name, input, .. } => Some((name.as_str(), input.clone())),
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect();

    if !tool_uses.is_empty() {
        example_out!("\n--- Tool calls ---");
        for (name, input) in &tool_uses {
            let input_preview = input.to_string();
            let short: String = input_preview.chars().take(120).collect();
            example_out!("  {name}: {short}");
            tools_used.push(name.to_string());
        }
    }

    let text_blocks: Vec<_> = resp
        .content_blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect();

    if !text_blocks.is_empty() {
        example_out!("\n--- Response text ---");
        for text in &text_blocks {
            let preview: String = text.chars().take(400).collect();
            example_out!("  {preview}");
            if text.len() > 400 {
                example_out!("  ... ({} more chars)", text.len().saturating_sub(400));
            }
        }
    }

    let u = &resp.usage;
    let t = &resp.timing;
    example_out!("\n--- Usage ---");
    example_out!(
        "  input={} output={} cache_read={} cache_write={}",
        u.input_tokens,
        u.output_tokens,
        u.cache_read_tokens,
        u.cache_creation_tokens
    );
    example_out!(
        "  total_ms={} ttft_ms={} finish_reason={}",
        t.total_ms,
        t.time_to_first_token_ms,
        resp.finish_reason
    );

    tools_used
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env_path = "/home/eshen/Documents/qifei/config/.env";
    if std::path::Path::new(env_path).exists() {
        for raw_line in std::fs::read_to_string(env_path)?.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                std::env::set_var(k.trim(), v.trim());
            }
        }
    }

    let args: Vec<String> = std::env::args().collect();
    let heartbeat = args.iter().any(|a| a == "--heartbeat");
    let rut = args.iter().any(|a| a == "--rut");
    let realistic = args.iter().any(|a| a == "--realistic");

    let runs: u32 = args
        .iter()
        .position(|a| a == "--runs")
        .and_then(|i| args.get(i.saturating_add(1)))
        .and_then(|s| s.parse().ok())
        .unwrap_or(if heartbeat || rut { 20 } else { 1 });

    let effort = args
        .iter()
        .position(|a| a == "--effort")
        .and_then(|i| args.get(i.saturating_add(1)).cloned())
        .unwrap_or_else(|| "max".into());

    let client = LlmClient::try_new()?;

    let (system, messages, tools) = if rut {
        example_out!("=== RUT mode: heartbeat + 4 ticks of scratchpad-only journal history ===");
        example_out!("=== Will run until non-scratchpad tool is used (max {runs} runs) ===\n");
        heartbeat_conversation(true)
    } else if heartbeat {
        example_out!("=== HEARTBEAT mode: exact production prompt + all tools (no journal) ===");
        example_out!("=== Will run until non-scratchpad tool is used (max {runs} runs) ===\n");
        heartbeat_conversation(false)
    } else if realistic {
        example_out!("=== REALISTIC mode ===");
        realistic_conversation()
    } else {
        example_out!("=== SIMPLE mode ===");
        simple_conversation()
    };

    let scratchpad_names: std::collections::HashSet<&str> = [
        "scratchpad_list",
        "scratchpad_read",
        "scratchpad_write",
        "scratchpad_delete",
    ]
    .into_iter()
    .collect();

    for run in 1..=runs {
        example_out!("\n>>> Run {run}/{runs} — effort={effort}");

        let model = make_model(&effort);
        let request = LlmClient::build_request(
            &model,
            messages.clone(),
            Some(system.clone()),
            tools.clone(),
            None,
        )?;

        if run == 1 {
            example_out!(
                "  messages: {} | tools: {}",
                request.messages.len(),
                request.tools.as_ref().map_or(0, Vec::len)
            );
        }

        let resp = client.generate(&request, None).await?;
        let tools_used = print_result(&format!("Run {run} — effort={effort}"), &resp);

        if heartbeat || rut {
            let has_non_scratchpad = tools_used
                .iter()
                .any(|t| !scratchpad_names.contains(t.as_str()));
            if has_non_scratchpad {
                example_out!("\n>>> NON-SCRATCHPAD TOOL USED: {tools_used:?}");
                example_out!(">>> Stopping after {run} runs.");
                break;
            } else if tools_used.is_empty() {
                example_out!("\n  (no tool use — text-only response)");
            } else {
                example_out!("\n  scratchpad only: {tools_used:?} — continuing...");
            }
        }
    }

    example_out!("\n\nDone.");
    Ok(())
}
