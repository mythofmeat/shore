//! Shared utilities for converting `ContentBlock` values to JSON and
//! extracting structured data from content block sequences.

use serde_json::{json, Value};
use shore_config::app::ThinkingReplay;
use shore_config::models::Sdk;
use shore_protocol::types::ContentBlock;

/// Convert a `ContentBlock` to its LLM API JSON representation, filtering
/// out blocks the API would reject (unsigned thinking blocks, empty text).
///
/// Returns `None` for blocks that should be omitted from API requests.
///
/// Empty (whitespace-only) text blocks are dropped: Anthropic rejects them
/// when a `cache_control` breakpoint lands on one ("cache_control cannot be
/// set for empty text blocks"), failing the whole request. They carry no
/// content, so omitting them is lossless and keeps already-persisted junk
/// (e.g. from older builds or non-Anthropic providers) off the wire.
pub fn content_block_to_api_json(block: &ContentBlock) -> Option<Value> {
    match block {
        ContentBlock::Text { text } if text.trim().is_empty() => None,
        ContentBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
        ContentBlock::Thinking {
            thinking,
            signature,
        } => {
            // Require signature — Anthropic API rejects unsigned thinking blocks.
            signature
                .as_ref()
                .map(|sig| json!({ "type": "thinking", "thinking": thinking, "signature": sig }))
        }
        ContentBlock::RedactedThinking { data } => Some(json!({
            "type": "redacted_thinking", "data": data,
        })),
        ContentBlock::ToolUse { id, name, input } => Some(json!({
            "type": "tool_use", "id": id, "name": name, "input": input,
        })),
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            let mut v = json!({
                "type": "tool_result", "tool_use_id": tool_use_id, "content": content,
            });
            if *is_error {
                if let Some(obj) = v.as_object_mut() {
                    let _ignored = obj.insert("is_error".into(), json!(true));
                }
            }
            Some(v)
        }
    }
}

/// Convert a `ContentBlock` to JSON unconditionally.
///
/// Unlike [`content_block_to_api_json`], this includes all blocks regardless
/// of validity for API submission. Used for internal message reconstruction
/// (e.g. memory query tool loops, memory query conversations).
pub fn content_block_to_json(block: &ContentBlock) -> Value {
    match block {
        ContentBlock::Text { text } => json!({"type": "text", "text": text}),
        ContentBlock::ToolUse { id, name, input } => {
            json!({"type": "tool_use", "id": id, "name": name, "input": input})
        }
        ContentBlock::Thinking {
            thinking,
            signature,
        } => {
            let mut thinking_json = json!({"type": "thinking", "thinking": thinking});
            if let Some(sig) = signature {
                if let Some(obj) = thinking_json.as_object_mut() {
                    let _ignored = obj.insert("signature".into(), json!(sig));
                }
            }
            thinking_json
        }
        ContentBlock::RedactedThinking { data } => {
            json!({"type": "redacted_thinking", "data": data})
        }
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            let mut v =
                json!({"type": "tool_result", "tool_use_id": tool_use_id, "content": content});
            if *is_error {
                if let Some(obj) = v.as_object_mut() {
                    let _ignored = obj.insert("is_error".into(), json!(true));
                }
            }
            v
        }
    }
}

/// Convert a `ContentBlock` to the provider-neutral request JSON Shore passes
/// into `shore-llm` for a specific SDK.
///
/// Anthropic requires signatures on replayed thinking blocks, so it uses the
/// stricter API projection. OpenAI-compatible providers and Z.AI receive the
/// full internal block so their provider adapters can project unsigned
/// reasoning into `reasoning` / `reasoning_content`.
pub fn content_block_to_request_json_for_sdk(block: &ContentBlock, sdk: &Sdk) -> Option<Value> {
    if matches!(sdk, Sdk::Openai | Sdk::Zai) {
        // Drop empty text blocks here too: they carry nothing and only invite
        // provider-side validation errors. See [`content_block_to_api_json`].
        if matches!(block, ContentBlock::Text { text } if text.trim().is_empty()) {
            return None;
        }
        Some(content_block_to_json(block))
    } else {
        content_block_to_api_json(block)
    }
}

/// Extract `(id, name, input)` tuples from `ToolUse` blocks in a content
/// block sequence.
pub fn extract_tool_uses(blocks: &[ContentBlock]) -> Vec<(String, String, Value)> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => {
                Some((id.clone(), name.clone(), input.clone()))
            }
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect()
}

/// Convert a `dispatch_tool` result (`Result<Value, ToolError>`) to an
/// `(output_string, is_error)` pair suitable for tool_result messages.
///
/// On success, extracts the string representation (bare string if the
/// Value is a string, otherwise JSON-serialized). On error, uses the
/// Display representation.
pub fn dispatch_result_to_output(result: Result<Value, crate::tools::ToolError>) -> (String, bool) {
    match result {
        Ok(value) => {
            let s = if let Some(s) = value.as_str() {
                s.to_owned()
            } else {
                serde_json::to_string(&value).unwrap_or_default()
            };
            (s, false)
        }
        Err(e) => (e.to_string(), true),
    }
}

/// Signature carriers that are bound to a specific non-Anthropic wire shape.
/// `orrd:` is the OpenRouter `reasoning_details` blob minted on the
/// [`Sdk::Openrouter`] path; `zair:` is the Z.AI Preserved-Thinking carrier.
/// Neither is an Anthropic signature, so neither survives a hop onto the
/// Anthropic wire shape no matter which upstream serves it.
const FOREIGN_SIGNATURE_CARRIERS: [&str; 2] = ["orrd:", "zair:"];

/// Whether `block` can be safely replayed to `active_provider`/`active_model`.
///
/// Providers mint opaque, **model-bound** data inside `thinking` blocks
/// (signatures) and `redacted_thinking` blocks (encrypted blobs, or
/// OpenRouter's `openrouter.reasoning:` envelopes). Replaying such a block to
/// anything but its minter triggers an HTTP 400 — e.g. Anthropic rejects an
/// OpenRouter-relayed block with `Invalid `data` in `redacted_thinking``.
/// Text, tool_use, tool_result, and unsigned thinking carry no bound data and
/// are always portable.
///
/// Provenance must be compared at **model** granularity, not provider. An
/// aggregator fronts many model families behind one `provider_key`: a Gemini
/// turn and a Claude turn are both `provider_key = "openrouter"`, so a
/// provider-only check reports a `google-gemini-v1` reasoning blob as portable
/// onto the Anthropic wire shape and every upstream rejects it identically
/// (`messages.N.content.0: Invalid `signature` in `thinking` block`). Model
/// equality is the honest rule — opaque reasoning is only ever valid for the
/// exact model that minted it.
///
/// `minting_provider`/`minting_model` describe the message this block belongs
/// to ([`shore_protocol::types::Message::provider_key`] and
/// [`shore_protocol::types::Message::model`]); either is `None` for messages
/// persisted before that provenance was tracked.
pub fn thinking_block_portable_to(
    block: &ContentBlock,
    minting_provider: Option<&str>,
    minting_model: Option<&str>,
    active_provider: &str,
    active_model: &str,
) -> bool {
    let carries_opaque_data = match block {
        ContentBlock::Thinking { signature, .. } => signature.is_some(),
        ContentBlock::RedactedThinking { .. } => true,
        ContentBlock::Text { .. }
        | ContentBlock::ToolUse { .. }
        | ContentBlock::ToolResult { .. } => false,
    };
    if !carries_opaque_data {
        return true;
    }

    // Carrier backstop, checked before provenance so it holds even for legacy
    // messages: a signature stamped with a non-Anthropic carrier is only ever
    // replayable to the exact model that minted it. Provenance-free histories
    // would otherwise sail straight onto the Anthropic wire.
    if let ContentBlock::Thinking {
        signature: Some(sig),
        ..
    } = block
    {
        if FOREIGN_SIGNATURE_CARRIERS
            .iter()
            .any(|prefix| sig.starts_with(prefix))
            && minting_model.is_none_or(|m| m != active_model)
        {
            return false;
        }
    }

    match (minting_provider, minting_model) {
        // Full provenance: opaque data is valid only against its exact minter.
        // Stripping on a mismatch costs reasoning/cache continuity (already
        // lost on a model switch); keeping a foreign block hard-fails.
        (Some(p), Some(m)) => p == active_provider && m == active_model,
        // Provider-only provenance (persisted before model tracking): the
        // coarse check is all that is available.
        (Some(p), None) => p == active_provider,
        // Unknown provenance (legacy messages): fall back to the one signal
        // readable off the wire. OpenRouter tags relayed reasoning with an
        // `openrouter.reasoning:` prefix; that envelope is OpenRouter-only.
        // Other legacy opaque blocks are kept, to avoid busting working
        // same-provider histories that predate provenance tracking.
        (None, _) => match block {
            ContentBlock::RedactedThinking { data }
                if data.starts_with("openrouter.reasoning:") =>
            {
                active_provider.contains("openrouter")
            }
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => true,
        },
    }
}

/// Strip prior-turn thinking from `messages` according to the tri-state
/// `replay` mode (#191), unless the provider requires `reasoning_content` to be
/// replayed (DeepSeek V3.1+, Moonshot Kimi-thinking — see
/// [`shore_llm::requires_reasoning_replay`]), in which case full replay is
/// forced regardless of the setting.
///
/// - [`ThinkingReplay::All`]: keep every prior turn's thinking (no-op).
/// - [`ThinkingReplay::LastTurn`]: keep only the most-recent assistant turn's
///   thinking; strip older turns.
/// - [`ThinkingReplay::None`]: strip thinking from all assistant history.
pub fn maybe_strip_prior_thinking(
    messages: &mut [Value],
    replay: ThinkingReplay,
    provider_key: &str,
) {
    // Provider floor: these models hard-require prior `reasoning_content`, so
    // never strip for them — full replay always wins over the user setting.
    if shore_llm::requires_reasoning_replay(provider_key) {
        return;
    }
    match replay {
        ThinkingReplay::All => {}
        ThinkingReplay::LastTurn => strip_thinking_from_assistant_history_except_last(messages),
        ThinkingReplay::None => strip_thinking_from_assistant_history(messages),
    }
}

/// Remove `thinking` and `redacted_thinking` blocks from every assistant
/// message in an already-serialized request body. Used when
/// `[memory.thinking] replay_prior_thinking` is false to avoid re-sending
/// signed thinking blocks from completed prior turns on every subsequent
/// request — they consume input/cache tokens but Anthropic's Claude 4.x
/// models do not attend to prior-turn thinking (only to thinking within
/// an in-progress tool-use loop, which is appended via a different code
/// path and not touched by this helper).
///
/// Expects each element of `messages` to be an object with `role` and an
/// array-typed `content` field (the format produced by `build_llm_messages`
/// and by the tool-loop continuation paths). Non-conforming entries are
/// left untouched.
pub fn strip_thinking_from_assistant_history(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        strip_thinking_from_message(msg);
    }
}

/// Like [`strip_thinking_from_assistant_history`], but keep the thinking on the
/// most-recent assistant *turn* and strip it from all earlier turns
/// ([`ThinkingReplay::LastTurn`], #191).
///
/// Anthropic models tend to stop producing thinking when the immediately
/// preceding assistant turn has none, so retaining just the last turn's
/// thinking keeps the model reasoning while still shedding the bulk of the
/// token cost (older thinking blocks dwarf the surrounding text).
///
/// "Most-recent assistant turn" is the trailing run of assistant messages and
/// their interleaved tool-result user messages, counted back from the last
/// assistant message to the first genuine (non-tool-result) user message. This
/// keeps a whole tool-use loop's thinking together rather than only the final
/// assistant message of it. If there is no assistant message, this is a no-op.
pub fn strip_thinking_from_assistant_history_except_last(messages: &mut [Value]) {
    let keep_from = most_recent_assistant_turn_start(messages);
    for (idx, msg) in messages.iter_mut().enumerate() {
        if idx < keep_from {
            strip_thinking_from_message(msg);
        }
    }
}

/// Index at which the most-recent assistant turn begins — the first message of
/// the trailing assistant run (walking back over assistant messages and the
/// tool-result-only user messages between them, stopping at the first genuine
/// user turn). Returns `messages.len()` when there is no assistant message
/// (nothing to keep), so every message is treated as strippable history.
fn most_recent_assistant_turn_start(messages: &[Value]) -> usize {
    let Some(last_assistant) = messages
        .iter()
        .rposition(|m| msg_role(m) == Some("assistant"))
    else {
        return messages.len();
    };
    // Walk back from the last assistant message; the turn extends across
    // assistant messages and tool-result-only user messages (tool-loop steps),
    // and ends at the first genuine user turn.
    let mut start = last_assistant;
    while start > 0 {
        let prev = start.saturating_sub(1);
        let Some(prev_msg) = messages.get(prev) else {
            break;
        };
        match msg_role(prev_msg) {
            Some("assistant") => start = prev,
            Some("user") if is_tool_result_only_user(prev_msg) => start = prev,
            _ => break,
        }
    }
    start
}

/// Role string of a wire message, if present.
fn msg_role(msg: &Value) -> Option<&str> {
    msg.get("role").and_then(|r| r.as_str())
}

/// A user message whose content is entirely `tool_result` blocks — i.e. a
/// tool-loop continuation, not a genuine user turn. An empty or non-array
/// content is not considered tool-result-only.
fn is_tool_result_only_user(msg: &Value) -> bool {
    let Some(arr) = msg.get("content").and_then(|c| c.as_array()) else {
        return false;
    };
    !arr.is_empty()
        && arr
            .iter()
            .all(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
}

/// Drop `thinking` / `redacted_thinking` blocks from a single assistant
/// message. Non-assistant or non-conforming messages are left untouched.
fn strip_thinking_from_message(msg: &mut Value) {
    if msg_role(msg) != Some("assistant") {
        return;
    }
    let Some(content) = msg.get_mut("content") else {
        return;
    };
    let Some(arr) = content.as_array_mut() else {
        return;
    };
    arr.retain(|block| {
        block
            .get("type")
            .and_then(|t| t.as_str())
            .is_none_or(|t| t != "thinking" && t != "redacted_thinking")
    });
}

/// Truncate a tool result to at most `max_chars` characters, appending a
/// notice so the model knows output was cut.
///
/// `max_chars == 0` disables truncation and returns `output` unchanged. When
/// the output exceeds the limit, it is cut at a character boundary (counting
/// Unicode scalar values, not bytes, so multi-byte text is never split) and a
/// one-line notice with the kept/total character counts is appended.
///
/// Callers apply this before persisting the result, so the shortened form is
/// what gets stored and replayed on later turns — capping the context cost of
/// a large result for the rest of the conversation, not just the current
/// request.
pub fn truncate_tool_result(output: String, max_chars: usize) -> String {
    if max_chars == 0 {
        return output;
    }
    let total = output.chars().count();
    if total <= max_chars {
        return output;
    }
    let kept: String = output.chars().take(max_chars).collect();
    format!("{kept}\n\n[tool_result truncated: showing first {max_chars} of {total} characters]")
}

/// Build a `tool_result` JSON value for the LLM request payload.
///
/// The `is_error` field is only included when `true`, matching the
/// Anthropic API convention.
pub fn build_tool_result_json(tool_use_id: &str, content: &str, is_error: bool) -> Value {
    let mut v = json!({
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content,
    });
    if is_error {
        if let Some(obj) = v.as_object_mut() {
            let _ignored = obj.insert("is_error".into(), json!(true));
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── turn-boundary parity with the sidecar ─────────────────────────

    /// The Anthropic cache breakpoint is anchored just *before* the boundary
    /// this function returns, and the sidecar recomputes that boundary itself
    /// (`mostRecentAssistantTurnStart` in
    /// `backend/llm-sidecar/src/llm/providers/anthropic.ts`). If the two drift,
    /// the anchor lands inside the region `replay_prior_thinking` rewrites,
    /// both message breakpoints miss, and every committed turn silently
    /// re-caches the whole conversation — a cost regression with no functional
    /// symptom, whose only end-to-end guard is an `#[ignore]` live probe.
    ///
    /// Both sides therefore assert against one shared fixture. The sidecar half
    /// is `backend/llm-sidecar/tests/turn_boundary_parity.test.ts`; adding a
    /// case to the fixture pins both implementations at once.
    #[test]
    fn turn_boundary_matches_shared_fixture() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/turn_boundary_parity.json"
        ))
        .expect("shared turn-boundary fixture is readable");
        let fixture: Value = serde_json::from_str(&raw).expect("fixture parses");
        let cases = fixture["cases"].as_array().expect("fixture has cases");
        // Guard against a fixture that parsed but carries nothing: an empty
        // case list would make this test pass while checking nothing.
        assert!(
            cases.len() > 5,
            "fixture looks truncated: {} cases",
            cases.len()
        );

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let messages = case["messages"].as_array().expect("case has messages");
            let expected = usize::try_from(case["expected"].as_u64().expect("case has expected"))
                .expect("expected index fits usize");
            assert_eq!(
                most_recent_assistant_turn_start(messages),
                expected,
                "turn boundary mismatch for fixture case {name:?}"
            );
        }
    }

    // ── content_block_to_api_json ─────────────────────────────────────

    #[test]
    fn api_json_text_block() {
        let block = ContentBlock::Text {
            text: "hello".into(),
        };
        let result = content_block_to_api_json(&block).unwrap();
        assert_eq!(result["type"], "text");
        assert_eq!(result["text"], "hello");
    }

    #[test]
    fn api_json_empty_text_block_returns_none() {
        assert!(content_block_to_api_json(&ContentBlock::Text {
            text: String::new()
        })
        .is_none());
        assert!(content_block_to_api_json(&ContentBlock::Text {
            text: "   \n".into()
        })
        .is_none());
    }

    #[test]
    fn request_json_for_sdk_drops_empty_text_all_sdks() {
        let empty = ContentBlock::Text { text: "  ".into() };
        for sdk in [Sdk::Anthropic, Sdk::Openai, Sdk::Zai] {
            assert!(
                content_block_to_request_json_for_sdk(&empty, &sdk).is_none(),
                "empty text should be dropped for {sdk:?}"
            );
        }
        // Non-empty text still passes through for every sdk.
        let real = ContentBlock::Text { text: "hi".into() };
        for sdk in [Sdk::Anthropic, Sdk::Openai, Sdk::Zai] {
            assert_eq!(
                content_block_to_request_json_for_sdk(&real, &sdk).unwrap()["text"],
                "hi"
            );
        }
    }

    #[test]
    fn api_json_thinking_with_signature() {
        let block = ContentBlock::Thinking {
            thinking: "let me think".into(),
            signature: Some("sig_abc".into()),
        };
        let result = content_block_to_api_json(&block).unwrap();
        assert_eq!(result["type"], "thinking");
        assert_eq!(result["thinking"], "let me think");
        assert_eq!(result["signature"], "sig_abc");
    }

    #[test]
    fn api_json_thinking_without_signature_returns_none() {
        let block = ContentBlock::Thinking {
            thinking: "unsigned thought".into(),
            signature: None,
        };
        assert!(
            content_block_to_api_json(&block).is_none(),
            "unsigned thinking blocks must be filtered from API requests"
        );
    }

    #[test]
    fn api_json_redacted_thinking() {
        let block = ContentBlock::RedactedThinking {
            data: "opaque".into(),
        };
        let result = content_block_to_api_json(&block).unwrap();
        assert_eq!(result["type"], "redacted_thinking");
        assert_eq!(result["data"], "opaque");
    }

    #[test]
    fn api_json_tool_use() {
        let block = ContentBlock::ToolUse {
            id: "t1".into(),
            name: "web_search".into(),
            input: json!({"query": "cats"}),
        };
        let result = content_block_to_api_json(&block).unwrap();
        assert_eq!(result["type"], "tool_use");
        assert_eq!(result["id"], "t1");
        assert_eq!(result["name"], "web_search");
        assert_eq!(result["input"]["query"], "cats");
    }

    #[test]
    fn api_json_tool_result_with_error() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "t1".into(),
            content: "something went wrong".into(),
            is_error: true,
        };
        let result = content_block_to_api_json(&block).unwrap();
        assert_eq!(result["type"], "tool_result");
        assert_eq!(result["tool_use_id"], "t1");
        assert_eq!(result["is_error"], true);
    }

    #[test]
    fn api_json_tool_result_without_error_omits_field() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "t1".into(),
            content: "success".into(),
            is_error: false,
        };
        let result = content_block_to_api_json(&block).unwrap();
        assert_eq!(result["type"], "tool_result");
        assert!(
            result.get("is_error").is_none(),
            "is_error should be omitted when false"
        );
    }

    // ── content_block_to_json ─────────────────────────────────────────

    #[test]
    fn json_thinking_without_signature_still_included() {
        let block = ContentBlock::Thinking {
            thinking: "unsigned thought".into(),
            signature: None,
        };
        let result = content_block_to_json(&block);
        assert_eq!(result["type"], "thinking");
        assert_eq!(result["thinking"], "unsigned thought");
        assert!(result.get("signature").is_none());
    }

    #[test]
    fn json_all_variants_produce_valid_json() {
        let blocks = vec![
            ContentBlock::Text { text: "hi".into() },
            ContentBlock::ToolUse {
                id: "t1".into(),
                name: "search".into(),
                input: json!({}),
            },
            ContentBlock::Thinking {
                thinking: "hmm".into(),
                signature: Some("sig".into()),
            },
            ContentBlock::RedactedThinking { data: "enc".into() },
            ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "ok".into(),
                is_error: false,
            },
        ];
        for block in &blocks {
            let val = content_block_to_json(block);
            assert!(
                val.get("type").is_some(),
                "every block must have a type field"
            );
        }
    }

    #[test]
    fn json_tool_result_without_error_omits_field() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "t1".into(),
            content: "ok".into(),
            is_error: false,
        };
        let result = content_block_to_json(&block);
        assert!(result.get("is_error").is_none());
    }

    // ── content_block_to_request_json_for_sdk ─────────────────────────

    #[test]
    fn request_json_openai_keeps_unsigned_thinking() {
        let block = ContentBlock::Thinking {
            thinking: "tool reasoning".into(),
            signature: None,
        };
        let result = content_block_to_request_json_for_sdk(&block, &Sdk::Openai).unwrap();
        assert_eq!(result["type"], "thinking");
        assert_eq!(result["thinking"], "tool reasoning");
    }

    #[test]
    fn request_json_anthropic_filters_unsigned_thinking() {
        let block = ContentBlock::Thinking {
            thinking: "unsigned thought".into(),
            signature: None,
        };
        assert!(content_block_to_request_json_for_sdk(&block, &Sdk::Anthropic).is_none());
    }

    // ── extract_tool_uses ─────────────────────────────────────────────

    #[test]
    fn extract_tool_uses_empty_input() {
        assert!(extract_tool_uses(&[]).is_empty());
    }

    #[test]
    fn extract_tool_uses_mixed_blocks() {
        let blocks = vec![
            ContentBlock::Text {
                text: "preamble".into(),
            },
            ContentBlock::ToolUse {
                id: "t1".into(),
                name: "check_time".into(),
                input: json!({}),
            },
            ContentBlock::Thinking {
                thinking: "hmm".into(),
                signature: None,
            },
            ContentBlock::ToolUse {
                id: "t2".into(),
                name: "roll_dice".into(),
                input: json!({"notation": "2d6"}),
            },
        ];
        let result = extract_tool_uses(&blocks);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, "t1");
        assert_eq!(result[0].1, "check_time");
        assert_eq!(result[1].0, "t2");
        assert_eq!(result[1].1, "roll_dice");
        assert_eq!(result[1].2, json!({"notation": "2d6"}));
    }

    // ── strip_thinking_from_assistant_history ─────────────────────────

    #[test]
    fn strip_removes_thinking_from_assistant() {
        let mut msgs = vec![json!({
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                {"type": "text", "text": "hello"},
            ],
        })];
        strip_thinking_from_assistant_history(&mut msgs);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
    }

    #[test]
    fn strip_removes_redacted_thinking_from_assistant() {
        let mut msgs = vec![json!({
            "role": "assistant",
            "content": [
                {"type": "redacted_thinking", "data": "opaque"},
                {"type": "text", "text": "final"},
            ],
        })];
        strip_thinking_from_assistant_history(&mut msgs);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
    }

    #[test]
    fn strip_preserves_tool_use_and_text() {
        let mut msgs = vec![json!({
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "x", "signature": "s"},
                {"type": "text", "text": "checking..."},
                {"type": "tool_use", "id": "t1", "name": "check_time", "input": {}},
            ],
        })];
        strip_thinking_from_assistant_history(&mut msgs);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "tool_use");
    }

    #[test]
    fn strip_leaves_user_messages_untouched() {
        // Defensive — user messages shouldn't have thinking blocks, but the
        // helper must not touch them even if one sneaks in.
        let mut msgs = vec![json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "hi"},
                {"type": "thinking", "thinking": "bogus", "signature": "x"},
            ],
        })];
        strip_thinking_from_assistant_history(&mut msgs);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn strip_tolerates_string_content() {
        // Legacy/simple messages whose `content` is a bare string (not an
        // array of blocks) must pass through unchanged.
        let mut msgs = vec![json!({"role": "assistant", "content": "plain text"})];
        strip_thinking_from_assistant_history(&mut msgs);
        assert_eq!(msgs[0]["content"], "plain text");
    }

    #[test]
    fn strip_tolerates_missing_fields() {
        let mut msgs = vec![json!({"role": "assistant"}), json!({"content": []})];
        strip_thinking_from_assistant_history(&mut msgs);
        // Just asserting no panic; structure untouched.
        assert_eq!(msgs[0].get("content"), None);
    }

    #[test]
    fn strip_across_multiple_assistant_messages() {
        let mut msgs = vec![
            json!({
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "one", "signature": "s1"},
                    {"type": "text", "text": "a"},
                ],
            }),
            json!({
                "role": "user",
                "content": [{"type": "text", "text": "q"}],
            }),
            json!({
                "role": "assistant",
                "content": [
                    {"type": "redacted_thinking", "data": "d"},
                    {"type": "text", "text": "b"},
                    {"type": "thinking", "thinking": "two", "signature": "s2"},
                ],
            }),
        ];
        strip_thinking_from_assistant_history(&mut msgs);
        assert_eq!(msgs[0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(msgs[1]["content"].as_array().unwrap().len(), 1); // user untouched
        assert_eq!(msgs[2]["content"].as_array().unwrap().len(), 1);
        assert_eq!(msgs[2]["content"][0]["type"], "text");
        assert_eq!(msgs[2]["content"][0]["text"], "b");
    }

    // ── strip_thinking_from_assistant_history_except_last (#191) ──────

    /// Helper: an assistant message with a thinking block + a text block.
    fn asst_thinking(text: &str) -> Value {
        json!({
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "t", "signature": "s"},
                {"type": "text", "text": text},
            ],
        })
    }

    fn user_text(text: &str) -> Value {
        json!({"role": "user", "content": [{"type": "text", "text": text}]})
    }

    /// Count thinking/redacted_thinking blocks in a message's content array.
    fn thinking_count(msg: &Value) -> usize {
        msg.get("content").and_then(Value::as_array).map_or(0, |a| {
            a.iter()
                .filter(|b| {
                    matches!(
                        b.get("type").and_then(Value::as_str),
                        Some("thinking" | "redacted_thinking")
                    )
                })
                .count()
        })
    }

    #[test]
    fn except_last_keeps_only_final_turn() {
        // U, A(think), U, A(think), U(current). The most-recent assistant turn
        // is the second A; its thinking stays, the first A's is stripped.
        let mut msgs = vec![
            user_text("q1"),
            asst_thinking("a1"),
            user_text("q2"),
            asst_thinking("a2"),
            user_text("q3"),
        ];
        strip_thinking_from_assistant_history_except_last(&mut msgs);
        assert_eq!(thinking_count(&msgs[1]), 0, "older turn stripped");
        assert_eq!(thinking_count(&msgs[3]), 1, "most-recent turn kept");
    }

    #[test]
    fn except_last_keeps_whole_tool_loop_of_final_turn() {
        // A multi-message final turn: A(tool) → U(tool_result) → A(text).
        // Both assistant messages of that turn keep their thinking; the
        // earlier turn's assistant is stripped.
        let mut msgs = vec![
            user_text("q1"),
            asst_thinking("old"),
            user_text("q2"),
            json!({
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "t", "signature": "s"},
                    {"type": "tool_use", "id": "t1", "name": "roll", "input": {}},
                ],
            }),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "6"}]}),
            asst_thinking("final"),
        ];
        strip_thinking_from_assistant_history_except_last(&mut msgs);
        assert_eq!(thinking_count(&msgs[1]), 0, "older turn stripped");
        assert_eq!(
            thinking_count(&msgs[3]),
            1,
            "tool-loop start of last turn kept"
        );
        assert_eq!(
            thinking_count(&msgs[5]),
            1,
            "tool-loop end of last turn kept"
        );
    }

    #[test]
    fn except_last_keeps_turn_ending_on_assistant() {
        // History ending on an assistant turn (heartbeat snapshot shape): the
        // trailing assistant turn is the most recent and is kept.
        let mut msgs = vec![
            user_text("q1"),
            asst_thinking("a1"),
            user_text("q2"),
            asst_thinking("a2"),
        ];
        strip_thinking_from_assistant_history_except_last(&mut msgs);
        assert_eq!(thinking_count(&msgs[1]), 0);
        assert_eq!(thinking_count(&msgs[3]), 1);
    }

    #[test]
    fn except_last_single_turn_is_noop() {
        let mut msgs = vec![user_text("q1"), asst_thinking("only"), user_text("q2")];
        strip_thinking_from_assistant_history_except_last(&mut msgs);
        assert_eq!(
            thinking_count(&msgs[1]),
            1,
            "the only turn is the last turn"
        );
    }

    #[test]
    fn except_last_no_assistant_is_noop() {
        let mut msgs = vec![user_text("q1")];
        strip_thinking_from_assistant_history_except_last(&mut msgs);
        // No assistant message → nothing to strip, no panic.
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn maybe_strip_last_turn_respects_provider_floor() {
        // DeepSeek requires full reasoning replay: LastTurn must NOT strip.
        let mut msgs = vec![
            user_text("q1"),
            asst_thinking("a1"),
            user_text("q2"),
            asst_thinking("a2"),
            user_text("q3"),
        ];
        maybe_strip_prior_thinking(&mut msgs, ThinkingReplay::LastTurn, "deepseek");
        assert_eq!(thinking_count(&msgs[1]), 1, "floor forces full replay");
        assert_eq!(thinking_count(&msgs[3]), 1);
    }

    #[test]
    fn maybe_strip_dispatches_on_mode() {
        let base = || {
            vec![
                user_text("q1"),
                asst_thinking("a1"),
                user_text("q2"),
                asst_thinking("a2"),
                user_text("q3"),
            ]
        };

        let mut all = base();
        maybe_strip_prior_thinking(&mut all, ThinkingReplay::All, "anthropic");
        assert_eq!(thinking_count(&all[1]) + thinking_count(&all[3]), 2);

        let mut last = base();
        maybe_strip_prior_thinking(&mut last, ThinkingReplay::LastTurn, "anthropic");
        assert_eq!(thinking_count(&last[1]), 0);
        assert_eq!(thinking_count(&last[3]), 1);

        let mut none = base();
        maybe_strip_prior_thinking(&mut none, ThinkingReplay::None, "anthropic");
        assert_eq!(thinking_count(&none[1]) + thinking_count(&none[3]), 0);
    }

    #[test]
    fn extract_tool_uses_no_tool_blocks() {
        let blocks = vec![
            ContentBlock::Text {
                text: "just text".into(),
            },
            ContentBlock::Thinking {
                thinking: "thought".into(),
                signature: None,
            },
        ];
        assert!(extract_tool_uses(&blocks).is_empty());
    }

    // ── truncate_tool_result ──────────────────────────────────────────

    #[test]
    fn truncate_zero_disables_returns_unchanged() {
        let s = "x".repeat(10_000);
        assert_eq!(truncate_tool_result(s.clone(), 0), s);
    }

    #[test]
    fn truncate_under_limit_returns_unchanged() {
        let s = "short output".to_owned();
        assert_eq!(truncate_tool_result(s.clone(), 100), s);
    }

    #[test]
    fn truncate_at_exact_limit_returns_unchanged() {
        let s = "abcde".to_owned();
        assert_eq!(truncate_tool_result(s.clone(), 5), s);
    }

    #[test]
    fn truncate_over_limit_cuts_and_annotates() {
        let s = "abcdefghij".to_owned(); // 10 chars
        let result = truncate_tool_result(s, 4);
        assert!(result.starts_with("abcd"));
        assert!(
            result.contains("truncated"),
            "must tell the model it was truncated"
        );
        assert!(
            result.contains("first 4 of 10 characters"),
            "notice should carry kept/total counts, got: {result}"
        );
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        // Multi-byte characters must never be split mid-codepoint.
        let s = "héllo wörld 🌊🌊🌊".to_owned();
        let result = truncate_tool_result(s, 7);
        // First 7 chars are "héllo w"; the kept prefix must be valid UTF-8
        // (guaranteed by String) and start with those characters.
        assert!(result.starts_with("héllo w"));
        assert!(result.contains("truncated"));
    }

    // ── thinking_block_portable_to ────────────────────────────────────

    #[test]
    fn portable_non_thinking_blocks_always_portable() {
        // Text / tool blocks carry no provider-bound data.
        let text = ContentBlock::Text { text: "hi".into() };
        assert!(thinking_block_portable_to(
            &text,
            Some("openrouter-anthropic"),
            Some("claude"),
            "anthropic",
            "claude",
        ));
    }

    #[test]
    fn portable_unsigned_thinking_is_portable() {
        // No signature → no opaque data to reject.
        let block = ContentBlock::Thinking {
            thinking: "t".into(),
            signature: None,
        };
        assert!(thinking_block_portable_to(
            &block,
            Some("openrouter-anthropic"),
            Some("gemini"),
            "anthropic",
            "claude",
        ));
    }

    #[test]
    fn portable_known_provenance_same_model_kept() {
        let signed = ContentBlock::Thinking {
            thinking: "t".into(),
            signature: Some("sig".into()),
        };
        let redacted = ContentBlock::RedactedThinking { data: "enc".into() };
        assert!(thinking_block_portable_to(
            &signed,
            Some("anthropic"),
            Some("claude"),
            "anthropic",
            "claude",
        ));
        assert!(thinking_block_portable_to(
            &redacted,
            Some("anthropic"),
            Some("claude"),
            "anthropic",
            "claude",
        ));
    }

    #[test]
    fn portable_known_provenance_cross_provider_stripped() {
        // Signed thinking and redacted blobs minted elsewhere must drop.
        let signed = ContentBlock::Thinking {
            thinking: "t".into(),
            signature: Some("sig".into()),
        };
        let redacted = ContentBlock::RedactedThinking { data: "enc".into() };
        assert!(!thinking_block_portable_to(
            &signed,
            Some("openrouter-anthropic"),
            Some("claude"),
            "anthropic",
            "claude",
        ));
        assert!(!thinking_block_portable_to(
            &redacted,
            Some("openrouter-anthropic"),
            Some("claude"),
            "anthropic",
            "claude",
        ));
    }

    #[test]
    fn portable_same_provider_cross_model_stripped() {
        // The reported failure: one aggregator fronts many model families, so
        // a Gemini turn and a Claude turn share `provider_key = "openrouter"`.
        // A provider-only check called this portable and every Anthropic
        // upstream rejected it with
        // `messages.N.content.0: Invalid signature in thinking block`.
        let gemini_thinking = ContentBlock::Thinking {
            thinking: "**Analyzing**\n\nsome reasoning".into(),
            signature: Some(r#"orrd:[{"format":"google-gemini-v1","index":0}]"#.into()),
        };
        assert!(!thinking_block_portable_to(
            &gemini_thinking,
            Some("openrouter"),
            Some("google/gemini-3.6-flash"),
            "openrouter",
            "anthropic/claude-opus-4.6",
        ));
        // Still replayable to the model that minted it.
        assert!(thinking_block_portable_to(
            &gemini_thinking,
            Some("openrouter"),
            Some("google/gemini-3.6-flash"),
            "openrouter",
            "google/gemini-3.6-flash",
        ));
    }

    #[test]
    fn portable_foreign_carrier_stripped_without_provenance() {
        // Carrier backstop: `orrd:`/`zair:` signatures predate model tracking
        // in some histories, and neither is an Anthropic signature.
        let orrd = ContentBlock::Thinking {
            thinking: "t".into(),
            signature: Some("orrd:[{\"format\":\"google-gemini-v1\"}]".into()),
        };
        let zai = ContentBlock::Thinking {
            thinking: "t".into(),
            signature: Some("zair:reasoning".into()),
        };
        assert!(!thinking_block_portable_to(
            &orrd,
            None,
            None,
            "openrouter",
            "anthropic/claude-opus-4.6",
        ));
        assert!(!thinking_block_portable_to(
            &zai,
            Some("openrouter"),
            None,
            "openrouter",
            "anthropic/claude-opus-4.6",
        ));
    }

    #[test]
    fn portable_unknown_provenance_openrouter_prefix_stripped_for_anthropic() {
        // An `openrouter.reasoning:`-prefixed blob from a pre-provenance
        // OpenRouter turn, replayed to Anthropic direct.
        let block = ContentBlock::RedactedThinking {
            data: "openrouter.reasoning: signed payload".into(),
        };
        assert!(!thinking_block_portable_to(
            &block,
            None,
            None,
            "anthropic",
            "claude"
        ));
        // …but kept when the active provider is still OpenRouter.
        assert!(thinking_block_portable_to(
            &block,
            None,
            None,
            "openrouter-anthropic",
            "claude",
        ));
    }

    #[test]
    fn portable_unknown_provenance_plain_blob_kept() {
        // Legacy same-provider blob without the OpenRouter envelope: keep, so
        // we don't bust working histories that predate provenance tracking.
        let block = ContentBlock::RedactedThinking {
            data: "opaque-anthropic-blob".into(),
        };
        assert!(thinking_block_portable_to(
            &block,
            None,
            None,
            "anthropic",
            "claude"
        ));
    }
}
