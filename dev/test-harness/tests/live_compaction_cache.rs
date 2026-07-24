//! Live compaction cache-invalidation probe.
//!
//! Mirrors the wire shape `RealCompactionLlm::build_compaction_request` +
//! the compaction tool loop in `memory/compaction/mod.rs` produce:
//!
//!   1. A short "chat" warms a cache prefix at a 1h TTL.
//!   2. We then send a "compaction" request whose `messages` are
//!      `[...chat prefix..., compact_now_user, inline role:"system"]` —
//!      the post-fix shape pinned by
//!      `compaction_impls::tests::compaction_tool_loop_keeps_compact_now_user_byte_stable_across_rounds`.
//!   3. The model emits a `write` tool_use; we push assistant + user(tool_result).
//!   4. We send the iter-1 request and observe cache stats.
//!
//! Contract:
//! - chat call 2 reads the cache chat call 1 created (sanity check on TTL).
//! - compaction iter-0 reads at least the chat prefix (it's a strict
//!   superset that adds compact_now + system at the end).
//! - compaction iter-1 cache_read > 0 — the compact_now slot stayed
//!   byte-stable across the tool loop, so Anthropic's prefix walker
//!   extended past it.
//! - compaction iter-1 cache_creation < cold/2 — no full re-cache of the
//!   prefix; this is the failure mode that motivated the fix.
//!
//! **Gated `#[ignore]`** — costs real OR credit (~$0.10–0.30). Run:
//!
//! ```sh
//! SHORE_ENV_FILE=~/.config/shore/.env \
//!     cargo test -p shore-test-harness --test live_compaction_cache \
//!     -- --ignored --nocapture
//! ```
#![deny(clippy::arithmetic_side_effects, clippy::indexing_slicing)]
// Cache-token assertions halve cold baselines (`cold_w / 2`) as comparison
// thresholds; truncating division is intended there, not a correctness hazard.
#![expect(
    clippy::integer_division,
    reason = "halving token baselines for assertion thresholds intends truncation"
)]

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use shore_config::models::Sdk;
use shore_llm::types::{ContentBlock, GenerateResponse, LlmRequest, Usage};
use shore_llm::LlmClient;

const LCG_MULTIPLIER: u64 = 6_364_136_223_846_793_005;
const LCG_INCREMENT: u64 = 1_442_695_040_888_963_407;

static ENV_LOCK: Mutex<()> = Mutex::new(());

macro_rules! test_out {
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

fn insert_json_field(value: &mut Value, key: &str, field: Value) {
    if let Some(object) = value.as_object_mut() {
        let _previous = object.insert(key.to_owned(), field);
    }
}

fn load_env_file() {
    let path = env::var("SHORE_ENV_FILE").map_or_else(
        |_| {
            env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
                .unwrap_or_else(|| PathBuf::from("."))
                .join("shore/.env")
        },
        PathBuf::from,
    );
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    for raw_line in contents.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let line = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }
        let value = raw_value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_owned();
        env::set_var(key, value);
    }
}

fn clock_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
}

fn random_nonce() -> String {
    let mut buf = String::with_capacity(32);
    let mut x = clock_seed();
    while buf.len() < 32 {
        let digit = u32::try_from(x & 0xf).unwrap_or(0);
        buf.push(char::from_digit(digit, 16).unwrap_or('0'));
        x = x.wrapping_mul(LCG_MULTIPLIER).wrapping_add(LCG_INCREMENT);
    }
    buf
}

/// ~3.4k-token system prompt (Sonnet 4.6's documented cache threshold is
/// 2048 tokens; this clears the cliff with margin). Identical paragraph
/// repeated to keep the cost down.
fn make_chat_system(nonce: &str) -> String {
    let para = "You are Casey, a meticulous tabletop-game referee. Your job is to roll \
dice on behalf of the player whenever they request a check, an attack roll, \
damage, or a saving throw. You always use the roll_dice tool. You never \
make up dice results — every random outcome must come from the tool.\n\n\
When the player asks for a result, think carefully about how to interpret \
their request: what kind of check is implied, how many dice, what sides, \
whether any modifier should be applied after the roll. Then call \
roll_dice with the appropriate count and sides. After the tool returns, \
narrate the result in-character and explain what it means for the \
player's situation. Be concise but flavorful.\n\n\
You speak with a measured, slightly formal voice. You refer to the player \
by name when possible. You use period-appropriate vocabulary for whatever \
setting is in play. You never break character, even when the player asks \
meta questions about the rules; you reframe the answer in-fiction.\n\n\
Your rulings are firm and final. You don't second-guess the dice.";
    let mut s = format!("nonce: {nonce}\n\n");
    for _ in 0..10 {
        s.push_str(para);
        s.push_str("\n\n");
    }
    s
}

fn roll_dice_tool() -> Value {
    json!({
        "name": "roll_dice",
        "description": "Roll dice and return the result.",
        "input_schema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer"},
                "sides": {"type": "integer"}
            },
            "required": ["count", "sides"]
        }
    })
}

/// Mirrors the `write` tool the compaction tool loop dispatches in
/// `memory/compaction/mod.rs::dispatch_compaction_tool`. The path is
/// constrained to `memory/*` or `MEMORY.md`; we don't enforce that here
/// since this is the wire-shape test, not the daemon's path filter.
fn write_tool() -> Value {
    json!({
        "name": "write",
        "description": "Write a memory file. Use this to capture what you've learned about \
    the player so it persists across sessions. Paths must be under memory/ (e.g. memory/people/alice.md) \
    or be MEMORY.md.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path, e.g. memory/people/alice.md"},
                "content": {"type": "string", "description": "Full file content (markdown)"}
            },
            "required": ["path", "content"]
        }
    })
}

fn dice_param(input: &Value, key: &str, default: u32) -> u32 {
    input
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn fake_roll(input: &Value) -> String {
    let count = dice_param(input, "count", 1);
    let sides = dice_param(input, "sides", 6);
    let mut seed = clock_seed();
    let mut rolls = Vec::new();
    let mut total: u32 = 0;
    for _ in 0..count {
        seed = seed
            .wrapping_mul(LCG_MULTIPLIER)
            .wrapping_add(LCG_INCREMENT);
        let base = u32::try_from(seed >> 33)
            .unwrap_or(0)
            .checked_rem(sides)
            .unwrap_or(0);
        let r = base.saturating_add(1);
        rolls.push(r);
        total = total.saturating_add(r);
    }
    let parts: Vec<String> = rolls.iter().map(ToString::to_string).collect();
    format!("Rolled {count}d{sides}: [{}] = {total}", parts.join(", "))
}

fn content_blocks_to_wire(blocks: &[ContentBlock]) -> Vec<Value> {
    blocks
        .iter()
        .map(|b| match b {
            ContentBlock::Text { text } => json!({"type": "text", "text": text}),
            ContentBlock::Thinking {
                thinking,
                signature,
            } => {
                let mut v = json!({"type": "thinking", "thinking": thinking});
                if let Some(sig) = signature {
                    insert_json_field(&mut v, "signature", json!(sig));
                }
                v
            }
            ContentBlock::ToolUse { id, name, input } => json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }),
            ContentBlock::RedactedThinking { data } => {
                json!({"type": "redacted_thinking", "data": data})
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let mut v = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                });
                if *is_error {
                    insert_json_field(&mut v, "is_error", json!(true));
                }
                v
            }
        })
        .collect()
}

fn build_chat_request(
    api_key: &str,
    model: &str,
    system: &str,
    messages: &[Value],
    rid: &str,
) -> LlmRequest {
    // Anthropic's prefix-cache hash covers `tools`. Compaction shares the
    // chat tool list and appends `write`, so chat sends BOTH from the
    // start: the model only calls roll_dice during chat, but the tool
    // definitions match what compaction will send, keeping the cache
    // prefix usable across the chat→compaction boundary.
    LlmRequest {
        sdk: Sdk::Anthropic,
        model: model.to_owned(),
        api_key: api_key.to_owned(),
        api_key_name: Some("default".into()),
        base_url: Some("https://openrouter.ai/api/v1".into()),
        messages: messages.to_vec(),
        system: Some(json!(system)),
        tools: Some(vec![roll_dice_tool(), write_tool()]),
        max_tokens: 4096,
        temperature: None,
        top_p: None,
        provider_options: Some(json!({
            "cache_ttl": "1h",
            "openrouter_provider": {"order": ["anthropic"], "allow_fallbacks": false},
        })),
        provider_key: Some("openrouter".into()),
        rid: Some(rid.into()),
        forensic_character: None,
        retain_long: false,
        keepalive_interval: None,
    }
}

/// Build a compaction-shape request from a chat-shape one.
///
/// Mirrors `RealCompactionLlm::build_compaction_request` +
/// `append_compaction_tail` exactly: the chat prefix
/// (`system`/`tools`/`messages`) carries through verbatim, then we
/// append one `role:"user"` ("compact now") and one inline
/// `role:"system"` (the compaction instruction). The inline-system
/// shape — instead of `request.system_suffix` — is what the fix
/// landed; it keeps `compact_now_user`'s position fixed across the
/// compaction tool loop, so the Anthropic prefix cache extends rather
/// than invalidating.
fn build_compaction_request(
    api_key: &str,
    model: &str,
    chat_system: &str,
    chat_messages: &[Value],
    compact_now_text: &str,
    compaction_system: &str,
    rid: &str,
) -> LlmRequest {
    // Chat tools + write tool — the model needs `write` to do its
    // compaction job, and we keep `roll_dice` because production
    // compaction inherits chat's tool list (the cache prefix hash covers
    // tool definitions).
    let tools = vec![roll_dice_tool(), write_tool()];

    let mut messages = chat_messages.to_vec();
    messages.push(json!({
        "role": "user",
        "content": [{"type": "text", "text": compact_now_text}],
    }));
    messages.push(json!({
        "role": "system",
        "content": compaction_system,
    }));

    LlmRequest {
        sdk: Sdk::Anthropic,
        model: model.to_owned(),
        api_key: api_key.to_owned(),
        api_key_name: Some("default".into()),
        base_url: Some("https://openrouter.ai/api/v1".into()),
        messages,
        system: Some(json!(chat_system)),
        tools: Some(tools),
        max_tokens: 4096,
        temperature: None,
        top_p: None,
        provider_options: Some(json!({
            "cache_ttl": "1h",
            "openrouter_provider": {"order": ["anthropic"], "allow_fallbacks": false},
        })),
        provider_key: Some("openrouter".into()),
        rid: Some(rid.into()),
        forensic_character: None,
        retain_long: false,
        keepalive_interval: None,
    }
}

struct CallStat {
    label: String,
    input: u64,
    output: u64,
    cache_r: u64,
    cache_w: u64,
}

fn record(stats: &mut Vec<CallStat>, label: &str, usage: &Usage) {
    stats.push(CallStat {
        label: label.into(),
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_r: usage.cache_read_tokens,
        cache_w: usage.cache_creation_tokens,
    });
}

fn print_stat(s: &CallStat) {
    test_out!(
        "  {:<28} input={:<6} output={:<5} cache_r={:<7} cache_w={}",
        s.label,
        s.input,
        s.output,
        s.cache_r,
        s.cache_w
    );
}

fn print_table(stats: &[CallStat]) {
    test_out!();
    test_out!(
        "  {:<28} {:>8} {:>8} {:>10} {:>10}",
        "call",
        "input",
        "output",
        "cache_r",
        "cache_w"
    );
    test_out!("  {}", "─".repeat(68));
    for s in stats {
        test_out!(
            "  {:<28} {:>8} {:>8} {:>10} {:>10}",
            s.label,
            s.input,
            s.output,
            s.cache_r,
            s.cache_w
        );
    }
}

/// End-to-end probe for the system_suffix-migration fix.
///
/// Phases:
///   1. Two chat turns (cold + warm). Sanity check: warm reads cache.
///   2. Compaction iter-0. Reads the chat-warmed prefix.
///   3. Compaction iter-1 (after pushing tool_result). The fix's
///      contract: cache_read > 0 and cache_creation < cold/2, because
///      compact_now_user bytes didn't shift between iter-0 and iter-1.
#[tokio::test]
#[ignore = "Requires OPENROUTER_API_KEY; costs real OR credit"]
#[expect(
    clippy::too_many_lines,
    reason = "live compaction cache probe is deliberately phase-oriented"
)]
#[expect(
    clippy::await_holding_lock,
    reason = "holds ENV_LOCK across provider awaits to pin process-global SHORE_CACHE_PINNED_POSITION for the whole request lifecycle"
)]
async fn compaction_tool_loop_preserves_cache_prefix() {
    let _guard = ENV_LOCK.lock().unwrap();
    load_env_file();

    // shore-llm reads SHORE_CACHE_PINNED_POSITION / SHORE_CACHE_DEPTH_TURNS
    // from the process env on every request and uses them to override the
    // TS-default placement. The probe's cache_read / cache_creation
    // assertions only hold for a specific breakpoint layout, so pin both
    // explicitly while we hold ENV_LOCK rather than inheriting whatever
    // the shell or `~/.config/shore/.env` happens to have set. Single-block
    // system in this test ⇒ anchor on system[0]; no depth-based
    // breakpoints ⇒ rely solely on the pinned anchor.
    env::set_var("SHORE_CACHE_PINNED_POSITION", "0");
    env::remove_var("SHORE_CACHE_DEPTH_TURNS");

    let model =
        env::var("SHORE_TEST_MODEL").unwrap_or_else(|_| "anthropic/claude-sonnet-4.6".into());
    let nonce = env::var("SHORE_TEST_NONCE").unwrap_or_else(|_| random_nonce());
    let api_key = env::var("OPENROUTER_API_KEY").unwrap_or_default();
    assert!(
        !api_key.trim().is_empty(),
        "OPENROUTER_API_KEY not set; this test is `#[ignore]` precisely so it \
         doesn't run without a key."
    );

    let chat_system = make_chat_system(&nonce);
    test_out!("model:  {model}");
    test_out!("nonce:  {nonce}");
    test_out!(
        "system: {} chars (~{} tokens)",
        chat_system.len(),
        chat_system.len() / 4
    );

    let client = LlmClient::try_new().unwrap();
    let mut stats: Vec<CallStat> = Vec::new();

    // ── Phase 1: chat turns to warm the cache ────────────────────────────
    let mut chat_messages: Vec<Value> = vec![json!({
        "role": "user",
        "content": [{
            "type": "text",
            "text": "Casey, please roll 1d20 for my stealth check and narrate briefly."
        }]
    })];
    test_out!("\n── chat turn 1 (cold) ──");
    let req = build_chat_request(
        &api_key,
        &model,
        &chat_system,
        &chat_messages,
        "live-compaction-chat-1",
    );
    let resp: GenerateResponse = client.generate(&req, None).await.expect("chat 1 generate");
    record(&mut stats, "chat#1 (cold)", &resp.usage);
    print_stat(stats.last().unwrap());
    let cold_w = resp.usage.cache_creation_tokens;
    assert!(
        cold_w > 0,
        "cold cache_creation = 0 — prompt below the provider cache threshold; \
         can't validate. Try a larger system prompt or bump the model."
    );

    // Drain any roll_dice tool_use the model issued, so chat_messages ends
    // on a turn that compaction can extend from.
    let assistant_wire = content_blocks_to_wire(&resp.content_blocks);
    chat_messages.push(json!({"role": "assistant", "content": assistant_wire}));
    let tool_uses: Vec<(String, Value)> = resp
        .content_blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, input, .. } => Some((id.clone(), input.clone())),
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect();
    if !tool_uses.is_empty() {
        let tool_results: Vec<Value> = tool_uses
            .iter()
            .map(|(id, input)| {
                json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": fake_roll(input),
                })
            })
            .collect();
        chat_messages.push(json!({"role": "user", "content": tool_results}));

        // Run the chat tool-loop continuation so we end on an assistant
        // text turn (matches what `last_request` would carry into compaction).
        test_out!("── chat turn 1 (continuation) ──");
        let cont_req = build_chat_request(
            &api_key,
            &model,
            &chat_system,
            &chat_messages,
            "live-compaction-chat-1-cont",
        );
        let cont_resp: GenerateResponse =
            client.generate(&cont_req, None).await.expect("chat 1 cont");
        record(&mut stats, "chat#1 (tool_result)", &cont_resp.usage);
        print_stat(stats.last().unwrap());
        let cont_wire = content_blocks_to_wire(&cont_resp.content_blocks);
        chat_messages.push(json!({"role": "assistant", "content": cont_wire}));
    }

    // A second chat turn to deepen the prefix.
    chat_messages.push(json!({
        "role": "user",
        "content": [{"type": "text", "text": "Now describe the alley you're sneaking through, briefly."}],
    }));
    test_out!("── chat turn 2 (warm) ──");
    let chat2_req = build_chat_request(
        &api_key,
        &model,
        &chat_system,
        &chat_messages,
        "live-compaction-chat-2",
    );
    let chat2_resp: GenerateResponse = client
        .generate(&chat2_req, None)
        .await
        .expect("chat 2 generate");
    record(&mut stats, "chat#2 (warm)", &chat2_resp.usage);
    print_stat(stats.last().unwrap());
    let chat2_read = chat2_resp.usage.cache_read_tokens;
    assert!(
        chat2_read > 0,
        "chat#2 cache_read = 0 — TTL or hash mismatch invalidated chat#1 cache; \
         can't validate the compaction contract without a warm cache to extend."
    );
    let chat2_wire = content_blocks_to_wire(&chat2_resp.content_blocks);
    chat_messages.push(json!({"role": "assistant", "content": chat2_wire}));

    // ── Phase 2: compaction iter-0 ───────────────────────────────────────
    //
    // Wire shape: chat's [system, tools, messages] + (compact_now_user)
    // + inline {role:"system", content: compaction_instruction}. Exactly
    // what `append_compaction_tail` produces post-fix.
    let compact_now_text = "Compact your memory now. \
You have access to a `write` tool that takes a `path` (e.g. memory/people/alice.md) \
and `content` (markdown). \
Based on the conversation so far, write ONE short memory file capturing what \
you've learned about the player. Then stop. \
You MUST call the `write` tool — do not just narrate.";
    let compaction_system = "You are a compaction agent. \
Your job is to extract durable facts from the conversation above and persist them \
to memory files via the `write` tool. \
Be concise — one file per pass. Path must start with memory/.";

    test_out!("\n── compaction iter-0 ──");
    let mut compaction_req = build_compaction_request(
        &api_key,
        &model,
        &chat_system,
        &chat_messages,
        compact_now_text,
        compaction_system,
        "live-compaction-iter-0",
    );
    let compaction0_resp: GenerateResponse = client
        .generate(&compaction_req, None)
        .await
        .expect("compaction iter-0");
    record(&mut stats, "compaction#0", &compaction0_resp.usage);
    print_stat(stats.last().unwrap());
    let compaction0_read = compaction0_resp.usage.cache_read_tokens;
    let compaction0_write = compaction0_resp.usage.cache_creation_tokens;

    assert!(
        compaction0_read > 0,
        "compaction iter-0 cache_read = 0 — the chat prefix didn't carry through. \
         The cache prefix hash includes system + tools, and compaction adds a \
         `write` tool to chat's tool list; this is expected to bust the cache if \
         the cache anchor falls outside the shared prefix. If this assertion fires \
         consistently, the test setup needs to revisit how tools enter the cache hash."
    );

    // ── Phase 3: run the tool loop one step (the bug surface) ───────────
    //
    // Push the assistant turn + a user(tool_result). The post-fix shape
    // puts these AFTER the inline role:"system" entry, leaving every
    // earlier slot — including compact_now_user — byte-stable.
    let mut compaction_tool_uses: Vec<(String, String, Value)> = compaction0_resp
        .content_blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, input } => {
                Some((id.clone(), name.clone(), input.clone()))
            }
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect();
    if compaction_tool_uses.is_empty() {
        // The model finished without calling `write`. We can't measure
        // the tool-loop continuation contract in that case. Print stats
        // and bail.
        print_table(&stats);
        panic!(
            "compaction iter-0 returned no tool_use blocks — the model did not engage \
             the `write` tool. This makes the iter-1 contract unmeasurable. \
             Re-run with a different nonce or tweak `compact_now_text` to be more \
             direct."
        );
    }

    let compaction_wire = content_blocks_to_wire(&compaction0_resp.content_blocks);
    compaction_req.messages.push(json!({
        "role": "assistant",
        "content": compaction_wire,
    }));

    // Fabricate `write` tool_results. The test doesn't actually write
    // to disk — we just confirm the request to the model.
    let tool_results: Vec<Value> = compaction_tool_uses
        .drain(..)
        .map(|(id, name, input)| {
            let content = if name == "write" {
                format!(
                    "wrote {}",
                    input.get("path").and_then(Value::as_str).unwrap_or("?")
                )
            } else {
                format!("{name} dispatched")
            };
            json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": content,
            })
        })
        .collect();
    compaction_req.messages.push(json!({
        "role": "user",
        "content": tool_results,
    }));
    compaction_req.rid = Some("live-compaction-iter-1".into());

    test_out!("── compaction iter-1 (after tool_result) ──");
    let compaction1_resp: GenerateResponse = client
        .generate(&compaction_req, None)
        .await
        .expect("compaction iter-1");
    record(&mut stats, "compaction#1", &compaction1_resp.usage);
    print_stat(stats.last().unwrap());
    let compaction1_read = compaction1_resp.usage.cache_read_tokens;
    let compaction1_write = compaction1_resp.usage.cache_creation_tokens;

    print_table(&stats);

    // ── Contract assertions ─────────────────────────────────────────────

    // The smoking-gun assertion: after the tool loop pushed assistant +
    // user(tool_result), Anthropic's cache walker must still find the
    // prefix from compaction iter-0. Pre-fix, compaction#1 cache_read
    // dropped to roughly the chat-only prefix (or zero) because the
    // compact_now_user bytes had shifted.
    assert!(
        compaction1_read > 0,
        "FAIL: compaction#1 cache_read = 0 — cache prefix invalidated mid \
         tool loop. This is the moving-tail cache-invalidation bug; check \
         that `append_compaction_tail` pins the inline role:\"system\" \
         entry at a fixed slot via push_inline_system."
    );

    // Stronger contract: cache_read on iter-1 should be at least as
    // large as cache_read on iter-0. Iter-1's prefix is a strict superset
    // of iter-0's (we only appended, never mutated), so the cached
    // prefix should grow, not shrink.
    assert!(
        compaction1_read >= compaction0_read,
        "FAIL: compaction#1 cache_read ({compaction1_read}) < compaction#0 \
         cache_read ({compaction0_read}). The iter-1 prefix is a strict \
         superset of iter-0's — cache_read shrinking means the iter-0 \
         entry didn't extend, i.e. bytes at some position shifted between \
         the two calls."
    );

    // Final guard: cache_creation on iter-1 must not be a full re-cache
    // of the prefix iter-0 just cached. The iter-1 request appended
    // exactly `assistant + user(tool_result)` to iter-0; iter-1's
    // cache_creation should reflect only those new bytes (and Anthropic's
    // breakpoint at iter-0's last_msg position becoming the new
    // frozen-boundary breakpoint — the appended assistant starts the next
    // trailing turn, so the boundary lands exactly there). Pre-fix, iter-1
    // cache_creation was on the order of `compaction0_write` itself, because
    // the compact_now_user bytes shifted and the entire prefix re-cached.
    let iter1_cap = std::cmp::max(compaction0_write / 2, 1024);
    assert!(
        compaction1_write < iter1_cap,
        "FAIL: compaction#1 cache_creation ({compaction1_write}) ≥ \
         max(iter0_write/2, 1024) ({iter1_cap}) — Anthropic is \
         re-caching a sizable chunk of the prefix instead of extending. \
         This is the cost symptom the fix targets. \
         (iter0 cache_creation was {compaction0_write}; iter1 should only \
         add the assistant + tool_result content.)"
    );
    // Also keep a chat-baseline guard so we catch the symptom the user
    // reported in production: a single compaction tool round costing
    // ~50 chat turns of cache_creation.
    assert!(
        compaction1_write < cold_w / 2,
        "FAIL: compaction#1 cache_creation ({compaction1_write}) ≥ chat#1 \
         cold/2 ({}) — this is the production-observed cost regression.",
        cold_w / 2
    );

    test_out!(
        "\nPASS — chat-warmed prefix carries into compaction, and the \
         compaction tool loop extends rather than invalidates the cache."
    );
    test_out!(
        "       chat#1 cold cache_w={cold_w}, compaction#0 cache_r={compaction0_read} \
         cache_w={compaction0_write}, compaction#1 cache_r={compaction1_read} \
         cache_w={compaction1_write}."
    );
}
