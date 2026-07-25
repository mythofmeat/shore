use serde_json::json;
use shore_common::protocol::error::ErrorCode;
use shore_common::protocol::types::{ContentBlock, Message, Role};
use tracing::debug;

use super::{engine_err, CommandContext, CommandResult};
use crate::convert::{u64_to_usize, usize_to_u32};
use crate::engine::ConversationEngine;

const DEFAULT_LOG_TURNS: usize = 64;

/// Resolve a message reference to a concrete msg_id.
///
/// Supports: `"last"`, `"latest"`, negative indices (`"-1"` = last),
/// positive 1-based indices (`"3"` = third message), or literal msg_ids (passthrough).
fn resolve_ref(messages: &[Message], reference: &str) -> Result<String, (ErrorCode, String)> {
    if reference == "last" || reference == "latest" {
        return messages
            .last()
            .map(|m| m.msg_id.clone())
            .ok_or_else(|| (ErrorCode::NotFound, "No messages in conversation".into()));
    }

    if let Ok(n) = reference.parse::<i64>() {
        if n == 0 {
            return Err((
                ErrorCode::InvalidRequest,
                "Message index must be non-zero (use 1 for first, -1 for last)".into(),
            ));
        }

        let signed_opt = if n < 0 {
            // -1 = last, -2 = second-to-last, etc.
            i64::try_from(messages.len())
                .unwrap_or(i64::MAX)
                .checked_add(n)
        } else {
            // 1-based positive index
            n.checked_sub(1)
        };
        let Some(signed) = signed_opt else {
            return Err((
                ErrorCode::NotFound,
                format!(
                    "Message index {reference} out of range (conversation has {} messages)",
                    messages.len()
                ),
            ));
        };

        let idx = match usize::try_from(signed) {
            Ok(i) if i < messages.len() => i,
            _ => {
                return Err((
                    ErrorCode::NotFound,
                    format!(
                        "Message index {reference} out of range (conversation has {} messages)",
                        messages.len()
                    ),
                ));
            }
        };

        return messages
            .get(idx)
            .map(|msg| msg.msg_id.clone())
            .ok_or_else(|| {
                (
                    ErrorCode::NotFound,
                    format!(
                        "Message index {reference} out of range (conversation has {} messages)",
                        messages.len()
                    ),
                )
            });
    }

    // Literal msg_id passthrough
    Ok(reference.to_owned())
}

fn resolve_assistant_ref(
    messages: &[Message],
    reference: Option<&str>,
) -> Result<String, (ErrorCode, String)> {
    match reference {
        None | Some("last" | "latest") => messages
            .iter()
            .rev()
            .find(|m| m.role == Role::Assistant)
            .map(|m| m.msg_id.clone())
            .ok_or_else(|| {
                (
                    ErrorCode::NotFound,
                    "No assistant messages in conversation".into(),
                )
            }),
        Some(name) => {
            let msg_id = resolve_ref(messages, name)?;
            let msg = messages
                .iter()
                .find(|m| m.msg_id == msg_id)
                .ok_or_else(|| (ErrorCode::NotFound, format!("Message not found: {msg_id}")))?;
            if msg.role != Role::Assistant {
                return Err((
                    ErrorCode::InvalidRequest,
                    "Alternate response selection only applies to assistant messages".into(),
                ));
            }
            Ok(msg_id)
        }
    }
}

fn page_start_by_turns(messages: &[Message], end_bound: usize, turns: usize) -> usize {
    let end = end_bound.min(messages.len());
    if turns == 0 {
        return end;
    }

    let mut seen = 0_usize;
    for idx in (0..end).rev() {
        if messages.get(idx).is_some_and(|msg| msg.role == Role::User) {
            seen = seen.saturating_add(1);
            if seen >= turns {
                return idx;
            }
        }
    }
    0
}

fn count_user_turns(messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|msg| msg.role == Role::User && !msg.is_tool_result_only())
        .count()
}

fn page_start_by_args(messages: &[Message], end: usize, args: &serde_json::Value) -> usize {
    if let Some(turns) = args.get("turns").and_then(serde_json::Value::as_u64) {
        return page_start_by_turns(messages, end, u64_to_usize(turns));
    }

    if let Some(count) = args.get("count").and_then(serde_json::Value::as_u64) {
        return end.saturating_sub(u64_to_usize(count));
    }

    page_start_by_turns(messages, end, DEFAULT_LOG_TURNS)
}

fn role_filter(args: &serde_json::Value) -> Result<Option<Role>, (ErrorCode, String)> {
    let Some(role) = args.get("role") else {
        return Ok(None);
    };

    serde_json::from_value(role.clone()).map(Some).map_err(|_| {
        (
            ErrorCode::InvalidRequest,
            "role must be one of user, assistant, or system".into(),
        )
    })
}

fn matches_role(message: &Message, role: Option<&Role>) -> bool {
    role.is_none_or(|want| message.role == *want)
}

fn resolve_history_before(
    args: &serde_json::Value,
    active_start: usize,
    total: usize,
) -> Result<usize, (ErrorCode, String)> {
    let Some(before) = args.get("before") else {
        return Ok(total);
    };

    if before.as_str() == Some("active") {
        return Ok(active_start);
    }

    let index = before.as_u64().ok_or_else(|| {
        (
            ErrorCode::InvalidRequest,
            "before must be \"active\" or a message cursor".into(),
        )
    })?;

    Ok(u64_to_usize(index).min(total))
}

fn history_page_payload(
    messages: &[Message],
    global_active_start: usize,
    start_idx: usize,
    end_idx: usize,
    role: Option<&Role>,
) -> serde_json::Value {
    let start = start_idx.min(messages.len());
    let end = end_idx.min(messages.len()).max(start);
    let messages_page = messages.get(start..end).unwrap_or(&[]);
    let mut page: Vec<Message> = messages_page
        .iter()
        .filter(|msg| matches_role(msg, role))
        .cloned()
        .collect();
    let archived_end = global_active_start.min(end).max(start);
    let archived_page = messages.get(start..archived_end).unwrap_or(&[]);
    let active_page_start = archived_page
        .iter()
        .filter(|msg| matches_role(msg, role))
        .count();
    let total_turns = count_user_turns(messages);

    // Keep archived scrollback lightweight. Active-tail messages may still
    // embed image bytes for remote clients; archived image refs remain labels.
    if let Some(active_tail) = page.get_mut(active_page_start..) {
        crate::handler::embed_messages_image_data(active_tail);
    }

    json!({
        "messages": page,
        "active_start": active_page_start,
        "cursor": start,
        "next_before": start,
        "has_more_before": start > 0,
        "global_active_start": global_active_start,
        "total_messages": total_turns,
        "total_turns": total_turns,
    })
}

/// Get a single message by index or reference.
///
/// Refs resolve against the merged (client-visible) message list.
pub fn get(
    engine: &ConversationEngine,
    _ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let raw_ref = args
        .get("ref")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            (
                ErrorCode::InvalidRequest,
                "Missing required argument: ref".into(),
            )
        })?;

    let role = role_filter(args)?;
    let mut merged = shore_common::protocol::merge::merge_tool_loop_messages(engine.messages());
    merged.retain(|msg| matches_role(msg, role.as_ref()));
    let msg_id = resolve_ref(&merged, raw_ref)?;
    let msg = merged
        .iter()
        .find(|m| m.msg_id == msg_id)
        .ok_or_else(|| (ErrorCode::NotFound, format!("Message not found: {msg_id}")))?;

    debug!(msg_id = %msg_id, role = ?msg.role, "Message retrieved");
    serde_json::to_value(msg).map_err(|e| (ErrorCode::InternalError, e.to_string()))
}

/// Show conversation history, bounded by messages (`count`) or turns (`turns`).
///
/// Tool-loop messages are merged into single assistant turns. By default this
/// returns the last 64 user turns, spanning compacted archive segments and the
/// active context tail when needed.
pub fn log(
    engine: &ConversationEngine,
    _ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let (messages, active_start) = engine.display_history();
    let end = messages.len();
    let start = page_start_by_args(&messages, end, args);
    let role = role_filter(args)?;

    Ok(history_page_payload(
        &messages,
        active_start,
        start,
        end,
        role.as_ref(),
    ))
}

/// Fetch a bounded page of older display history for lazy clients.
///
/// Args:
/// - `before`: `"active"` or a numeric cursor from a prior page.
/// - `turns`: user turns to fetch; defaults to 64.
pub fn history_page(
    engine: &ConversationEngine,
    _ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let (messages, active_start) = engine.display_history();
    let end = resolve_history_before(args, active_start, messages.len())?;
    let start = page_start_by_args(&messages, end, args);
    let role = role_filter(args)?;

    Ok(history_page_payload(
        &messages,
        active_start,
        start,
        end,
        role.as_ref(),
    ))
}

/// Edit a message by ID.
///
/// Refs resolve against the merged (client-visible) message list, then the
/// edit is applied to the raw store by msg_id.
pub fn edit(
    engine: &mut ConversationEngine,
    _ctx: &mut CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let raw_ref = args
        .get("ref")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            (
                ErrorCode::InvalidRequest,
                "Missing required argument: ref".into(),
            )
        })?;

    let content = args
        .get("content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            (
                ErrorCode::InvalidRequest,
                "Missing required argument: content".into(),
            )
        })?;

    let merged = shore_common::protocol::merge::merge_tool_loop_messages(engine.messages());
    let msg_id = resolve_ref(&merged, raw_ref)?;
    engine.edit_message(&msg_id, content).map_err(engine_err)?;

    debug!(msg_id = %msg_id, content_len = content.len(), "Message edited");
    Ok(json!({ "ref": msg_id, "edited": true }))
}

/// Delete one or more messages by ID.
///
/// `refs` can be a JSON array of strings or a single string.
pub fn delete(
    engine: &mut ConversationEngine,
    _ctx: &mut CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let raw_refs: Vec<&str> = if let Some(arr) = args.get("refs").and_then(|v| v.as_array()) {
        arr.iter()
            .map(|v| {
                v.as_str().ok_or_else(|| {
                    (
                        ErrorCode::InvalidRequest,
                        "refs must be an array of strings".into(),
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?
    } else if let Some(s) = args.get("refs").and_then(serde_json::Value::as_str) {
        vec![s]
    } else {
        return Err((
            ErrorCode::InvalidRequest,
            "Missing required argument: refs".into(),
        ));
    };

    // Resolve all refs against merged list, so indices match what users see.
    let merged = shore_common::protocol::merge::merge_tool_loop_messages(engine.messages());
    let resolved: Vec<String> = raw_refs
        .iter()
        .map(|r| resolve_ref(&merged, r))
        .collect::<Result<Vec<_>, _>>()?;

    let mut deleted = Vec::new();
    for msg_id in &resolved {
        engine.delete_message(msg_id).map_err(engine_err)?;
        deleted.push(msg_id.clone());
    }

    debug!(count = deleted.len(), "Messages deleted");
    Ok(json!({ "deleted": deleted }))
}

/// List stored alternate responses for an assistant message.
///
/// Args:
/// - `ref` (optional): message ref, defaulting to the latest assistant message.
pub fn list_alternatives(
    engine: &ConversationEngine,
    _ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let merged = shore_common::protocol::merge::merge_tool_loop_messages(engine.messages());
    let raw_ref = args.get("ref").and_then(serde_json::Value::as_str);
    let msg_id = resolve_assistant_ref(&merged, raw_ref)?;
    let msg = merged
        .iter()
        .find(|m| m.msg_id == msg_id)
        .ok_or_else(|| (ErrorCode::NotFound, format!("Message not found: {msg_id}")))?;

    let alt_count = usize_to_u32(msg.alternatives.len());
    let current = msg.alt_index.unwrap_or(0).min(alt_count.saturating_sub(1));
    let alternatives: Vec<serde_json::Value> = msg
        .alternatives
        .iter()
        .enumerate()
        .map(|(index, alt)| {
            let idx = usize_to_u32(index);
            let mut images = alt.images.clone();
            crate::handler::embed_image_data(&mut images);
            json!({
                "index": idx,
                "position": idx.saturating_add(1),
                "active": idx == current,
                "content": alt.content.clone(),
                "images": images,
                "timestamp": alt.timestamp.clone(),
            })
        })
        .collect();

    Ok(json!({
        "ref": msg_id,
        "alt_index": msg.alt_index,
        "position": msg.alt_index.map(|i| i.saturating_add(1)),
        "alt_count": alt_count,
        "alternatives": alternatives,
    }))
}

/// Select a stored alternate response on an assistant message.
///
/// Args:
/// - `ref` (optional): message ref, defaulting to the latest assistant message.
/// - `direction`: `prev`, `next`, `first`, or `last`.
/// - `position`: 1-based alternative position.
/// - `index`: 0-based alternative index for programmatic callers.
pub fn alt(
    engine: &mut ConversationEngine,
    _ctx: &mut CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let merged = shore_common::protocol::merge::merge_tool_loop_messages(engine.messages());
    let raw_ref = args.get("ref").and_then(serde_json::Value::as_str);
    let msg_id = resolve_assistant_ref(&merged, raw_ref)?;
    let msg = merged
        .iter()
        .find(|m| m.msg_id == msg_id)
        .ok_or_else(|| (ErrorCode::NotFound, format!("Message not found: {msg_id}")))?;

    let alt_count = usize_to_u32(msg.alternatives.len());
    if alt_count == 0 {
        return Err((
            ErrorCode::InvalidRequest,
            format!("message {msg_id} has no alternate responses"),
        ));
    }
    let current = msg.alt_index.unwrap_or(0).min(alt_count.saturating_sub(1));
    let target = resolve_alt_target(args, current, alt_count)?;

    let selection = engine.select_alt(&msg_id, target).map_err(engine_err)?;
    debug!(
        msg_id = %selection.msg_id,
        alt_index = selection.alt_index,
        alt_count = selection.alt_count,
        "Alternate response selected"
    );
    Ok(json!({
        "ref": selection.msg_id,
        "alt_index": selection.alt_index,
        "position": selection.alt_index.saturating_add(1),
        "alt_count": selection.alt_count,
        "content": selection.content,
    }))
}

fn resolve_alt_target(
    args: &serde_json::Value,
    current: u32,
    count: u32,
) -> Result<u32, (ErrorCode, String)> {
    if let Some(index_u64) = args.get("index").and_then(serde_json::Value::as_u64) {
        let index = u32::try_from(index_u64).unwrap_or(u32::MAX);
        if index >= count {
            return Err((
                ErrorCode::InvalidRequest,
                format!(
                    "alternate index {} out of range (message has {} alternate response(s))",
                    index.saturating_add(1),
                    count
                ),
            ));
        }
        return Ok(index);
    }

    if let Some(position) = args.get("position").and_then(serde_json::Value::as_u64) {
        if position == 0 || position > u64::from(count) {
            return Err((
                ErrorCode::InvalidRequest,
                format!(
                    "alternate position {position} out of range (message has {count} alternate response(s))"
                ),
            ));
        }
        return Ok(u32::try_from(position)
            .unwrap_or(u32::MAX)
            .saturating_sub(1));
    }

    match args
        .get("direction")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("next")
    {
        "prev" | "previous" => Ok(current.saturating_sub(1)),
        "next" => Ok(current.saturating_add(1).min(count.saturating_sub(1))),
        "first" => Ok(0),
        "last" => Ok(count.saturating_sub(1)),
        other => Err((
            ErrorCode::InvalidRequest,
            format!("unknown alt direction: {other}"),
        )),
    }
}

/// Inject a system-role instruction into the conversation.
///
/// This allows mid-conversation behavioral correction (e.g. "stop using
/// roleplay actions") without modifying the system prompt or polluting the
/// conversation with user-role meta-instructions.
pub fn inject_system(
    engine: &mut ConversationEngine,
    _ctx: &mut CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let text = args
        .get("text")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            (
                ErrorCode::InvalidRequest,
                "Missing required argument: text".into(),
            )
        })?;

    let msg = Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        origin: None,
        role: Role::System,
        content: text.to_owned(),
        images: vec![],
        content_blocks: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        provider_key: None,
        model: None,
        timestamp: chrono::Local::now().to_rfc3339(),
    };

    engine.append_message(msg).map_err(engine_err)?;
    debug!(text_len = text.len(), "System message injected");
    Ok(json!({ "injected": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{CommandContext, SessionTokens};
    use serde_json::Value;
    use shore_common::protocol::server_msg::ServerMessage;
    use shore_common::protocol::types::{Message, Role};
    use tempfile::TempDir;
    use tokio::sync::broadcast;

    fn make_ctx(
        tmp: &TempDir,
    ) -> (
        ConversationEngine,
        CommandContext,
        broadcast::Receiver<ServerMessage>,
    ) {
        let (push_tx, push_rx) = broadcast::channel(16);
        let data_dir = tmp.path().to_path_buf();
        let engine =
            ConversationEngine::new("TestChar".to_owned(), data_dir.clone(), push_tx.clone())
                .unwrap();

        let config = shore_common::config::LoadedConfig::new_for_test(
            shore_common::config::app::AppConfig::default(),
            shore_common::config::models::ModelCatalog::default(),
            shore_common::config::ShoreDirs {
                config: tmp.path().join("config"),
                data: data_dir.clone(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );

        let (_tx, rx) = tokio::sync::watch::channel(());
        let autonomy = crate::autonomy::manager::AutonomyManager::new(
            shore_common::config::app::AutonomyConfig::default(),
            shore_common::config::app::CompactionConfig::default(),
            data_dir.clone(),
            rx,
        );

        let ctx = CommandContext {
            config_path: config.dirs.config.join("config.toml"),
            config,
            push_tx,
            data_dir: data_dir.clone(),
            character_name: Some("TestChar".into()),
            active_model: None,
            active_resolved_model: None,
            session_tokens: std::sync::Arc::new(std::sync::Mutex::new(SessionTokens::default())),
            autonomy,
            llm_client: crate::ledger::LedgerClient::new(
                crate::llm::LlmClient::try_new().unwrap(),
                &data_dir.join("ledger.db"),
            )
            .unwrap(),
            diagnostics: std::sync::Arc::new(std::sync::Mutex::new(
                shore_common::diagnostics::Diagnostics::default(),
            )),
        };
        (engine, ctx, push_rx)
    }

    fn make_msg(id: &str, role: Role, content: &str) -> Message {
        Message {
            msg_id: id.to_owned(),
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

    use crate::test_support::write_segmented_fixture;

    fn field<'val>(value: &'val Value, key: &str) -> &'val Value {
        value
            .get(key)
            .unwrap_or_else(|| panic!("missing field {key}"))
    }

    fn array_field<'val>(value: &'val Value, key: &str) -> &'val [Value] {
        field(value, key).as_array().expect("array field")
    }

    fn item<T>(values: &[T], index: usize) -> &T {
        values.get(index).expect("value item")
    }

    fn write_segmented_history(tmp: &TempDir) {
        let character_dir = tmp.path().join("TestChar");
        let archived = vec![
            make_msg("m1", Role::User, "archived one"),
            make_msg("m2", Role::Assistant, "archived two"),
        ];
        let active = vec![
            make_msg("m3", Role::User, "active three"),
            make_msg("m4", Role::Assistant, "active four"),
        ];
        write_segmented_fixture(&character_dir, &archived, &active, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn log_all_messages() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "Hello"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "Hi"))
            .unwrap();
        engine
            .append_message(make_msg("m3", Role::User, "How?"))
            .unwrap();

        let result = log(&engine, &ctx, &json!({})).unwrap();
        let msgs = array_field(&result, "messages");
        assert_eq!(msgs.len(), 3);
    }

    #[test]
    fn log_with_count() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "A"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "B"))
            .unwrap();
        engine
            .append_message(make_msg("m3", Role::User, "C"))
            .unwrap();

        let result = log(&engine, &ctx, &json!({"count": 2})).unwrap();
        let msgs = array_field(&result, "messages");
        assert_eq!(msgs.len(), 2);
        // Should be the last 2 messages.
        assert_eq!(field(item(msgs, 0), "msg_id"), "m2");
        assert_eq!(field(item(msgs, 1), "msg_id"), "m3");
    }

    #[test]
    fn log_with_count_can_cross_from_active_tail_into_archived_segments() {
        let tmp = TempDir::new().unwrap();
        write_segmented_history(&tmp);
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let result = log(&engine, &ctx, &json!({"count": 3})).unwrap();
        let msgs = array_field(&result, "messages");
        assert_eq!(msgs.len(), 3);
        assert_eq!(field(item(msgs, 0), "msg_id"), "m2");
        assert_eq!(field(item(msgs, 1), "msg_id"), "m3");
        assert_eq!(field(item(msgs, 2), "msg_id"), "m4");
        assert_eq!(field(&result, "active_start"), 1);
    }

    #[test]
    fn log_with_role_filters_page_and_keeps_archive_boundary() {
        let tmp = TempDir::new().unwrap();
        write_segmented_history(&tmp);
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let result = log(&engine, &ctx, &json!({"count": 3, "role": "assistant"})).unwrap();
        let msgs = array_field(&result, "messages");
        assert_eq!(msgs.len(), 2);
        assert_eq!(field(item(msgs, 0), "msg_id"), "m2");
        assert_eq!(field(item(msgs, 1), "msg_id"), "m4");
        assert_eq!(field(&result, "active_start"), 1);
    }

    #[test]
    fn log_rejects_unknown_role() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let (code, message) = log(&engine, &ctx, &json!({"role": "character"})).unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
        assert!(message.contains("user, assistant, or system"));
    }

    #[test]
    fn log_keeps_archived_image_refs_lightweight() {
        use shore_common::protocol::types::ImageRef;

        let tmp = TempDir::new().unwrap();
        let character_dir = tmp.path().join("TestChar");
        let image_path = tmp.path().join("image.bin");
        std::fs::write(&image_path, b"image bytes").unwrap();
        let image_path_str = image_path.to_string_lossy().to_string();

        let mut archived = make_msg("m1", Role::User, "archived image");
        archived.images.push(ImageRef {
            path: image_path_str.clone(),
            caption: Some("old".into()),
            data: None,
        });
        let mut active = make_msg("m2", Role::User, "active image");
        active.images.push(ImageRef {
            path: image_path_str,
            caption: Some("new".into()),
            data: None,
        });
        write_segmented_fixture(
            &character_dir,
            &[archived],
            &[active],
            "2026-01-01T00:00:00Z",
        );

        let (engine, ctx, _rx) = make_ctx(&tmp);
        let result = log(&engine, &ctx, &json!({"count": 2})).unwrap();
        let msgs = array_field(&result, "messages");
        assert_eq!(msgs.len(), 2);
        let archived_images = array_field(item(msgs, 0), "images");
        let active_images = array_field(item(msgs, 1), "images");
        assert!(item(archived_images, 0).get("data").is_none());
        assert!(field(item(active_images, 0), "data").as_str().is_some());
        assert_eq!(field(&result, "active_start"), 1);
    }

    #[test]
    fn history_page_before_active_returns_archived_page_only() {
        let tmp = TempDir::new().unwrap();
        write_segmented_history(&tmp);
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let result = history_page(&engine, &ctx, &json!({"before": "active", "turns": 1})).unwrap();
        let msgs = array_field(&result, "messages");
        assert_eq!(msgs.len(), 2);
        assert_eq!(field(item(msgs, 0), "msg_id"), "m1");
        assert_eq!(field(item(msgs, 1), "msg_id"), "m2");
        assert_eq!(field(&result, "active_start"), 2);
        assert_eq!(field(&result, "cursor"), 0);
        assert_eq!(field(&result, "has_more_before"), false);
    }

    #[test]
    fn log_empty_conversation() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let result = log(&engine, &ctx, &json!({})).unwrap();
        let msgs = array_field(&result, "messages");
        assert!(msgs.is_empty());
    }

    #[test]
    fn get_last_with_role_resolves_filtered_messages() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "first user"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "first assistant"))
            .unwrap();
        engine
            .append_message(make_msg("m3", Role::User, "last user"))
            .unwrap();
        engine
            .append_message(make_msg("m4", Role::Assistant, "last assistant"))
            .unwrap();

        let result = get(&engine, &ctx, &json!({"ref": "last", "role": "user"})).unwrap();
        assert_eq!(field(&result, "msg_id"), "m3");
        assert_eq!(field(&result, "content"), "last user");
    }

    #[test]
    fn edit_message() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "Original"))
            .unwrap();

        let result = edit(
            &mut engine,
            &mut ctx,
            &json!({"ref": "m1", "content": "Edited"}),
        )
        .unwrap();
        assert_eq!(field(&result, "ref"), "m1");
        assert_eq!(field(&result, "edited"), true);
        assert_eq!(item(engine.messages(), 0).content, "Edited");
    }

    #[test]
    fn edit_missing_ref() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = edit(&mut engine, &mut ctx, &json!({"content": "x"}));
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn edit_missing_content() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = edit(&mut engine, &mut ctx, &json!({"ref": "m1"}));
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn edit_nonexistent_message() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = edit(
            &mut engine,
            &mut ctx,
            &json!({"ref": "nope", "content": "x"}),
        );
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::NotFound);
    }

    #[test]
    fn edit_triggers_history_push() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, mut rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "Original"))
            .unwrap();
        while rx.try_recv().is_ok() {}

        let _ignored = edit(
            &mut engine,
            &mut ctx,
            &json!({"ref": "m1", "content": "Edited"}),
        )
        .unwrap();

        let msg = rx.try_recv().unwrap();
        assert!(matches!(msg, ServerMessage::History(_)));
    }

    #[test]
    fn delete_messages() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "A"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "B"))
            .unwrap();

        let result = delete(&mut engine, &mut ctx, &json!({"refs": ["m1"]})).unwrap();
        assert_eq!(array_field(&result, "deleted").len(), 1);
        assert_eq!(engine.messages().len(), 1);
        assert_eq!(item(engine.messages(), 0).msg_id, "m2");
    }

    #[test]
    fn delete_single_string_ref() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "A"))
            .unwrap();

        let result = delete(&mut engine, &mut ctx, &json!({"refs": "m1"})).unwrap();
        assert_eq!(array_field(&result, "deleted").len(), 1);
        assert!(engine.messages().is_empty());
    }

    #[test]
    fn delete_missing_refs() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = delete(&mut engine, &mut ctx, &json!({}));
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn delete_nonexistent_message() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = delete(&mut engine, &mut ctx, &json!({"refs": ["nope"]}));
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::NotFound);
    }

    #[test]
    fn delete_triggers_history_push() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, mut rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "A"))
            .unwrap();
        while rx.try_recv().is_ok() {}

        let _ignored = delete(&mut engine, &mut ctx, &json!({"refs": ["m1"]})).unwrap();

        let msg = rx.try_recv().unwrap();
        assert!(matches!(msg, ServerMessage::History(_)));
    }

    #[test]
    fn alt_selects_previous_alternative() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        engine
            .append_message(make_msg("u1", Role::User, "Prompt"))
            .unwrap();
        let mut msg = make_msg("a2", Role::Assistant, "Second answer");
        msg.content_blocks = vec![ContentBlock::Text {
            text: "Second answer".into(),
        }];
        msg.alt_index = Some(1);
        msg.alt_count = Some(2);
        msg.alternatives = vec![
            shore_common::protocol::types::MessageAlternative {
                content: "First answer".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "First answer".into(),
                }],
                timestamp: "2026-01-01T00:00:00Z".into(),
                provider_key: None,
                model: None,
            },
            shore_common::protocol::types::MessageAlternative {
                content: "Second answer".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "Second answer".into(),
                }],
                timestamp: "2026-01-01T00:00:01Z".into(),
                provider_key: None,
                model: None,
            },
        ];
        engine.append_message(msg).unwrap();

        let result = alt(&mut engine, &mut ctx, &json!({"direction": "prev"})).unwrap();
        assert_eq!(field(&result, "position"), 1);
        assert_eq!(field(&result, "alt_count"), 2);
        assert_eq!(item(engine.messages(), 1).content, "First answer");
        assert_eq!(item(engine.messages(), 1).alt_index, Some(0));
    }

    #[test]
    fn list_alternatives_returns_active_marker() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, ctx, _rx) = make_ctx(&tmp);

        engine
            .append_message(make_msg("u1", Role::User, "Prompt"))
            .unwrap();
        let mut msg = make_msg("a2", Role::Assistant, "Second answer");
        msg.alt_index = Some(1);
        msg.alt_count = Some(2);
        msg.alternatives = vec![
            shore_common::protocol::types::MessageAlternative {
                content: "First answer".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "First answer".into(),
                }],
                timestamp: "2026-01-01T00:00:00Z".into(),
                provider_key: None,
                model: None,
            },
            shore_common::protocol::types::MessageAlternative {
                content: "Second answer".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "Second answer".into(),
                }],
                timestamp: "2026-01-01T00:00:01Z".into(),
                provider_key: None,
                model: None,
            },
        ];
        engine.append_message(msg).unwrap();

        let result = list_alternatives(&engine, &ctx, &json!({})).unwrap();
        assert_eq!(field(&result, "ref"), "a2");
        assert_eq!(field(&result, "alt_count"), 2);
        let alternatives = array_field(&result, "alternatives");
        assert_eq!(field(item(alternatives, 0), "position"), 1);
        assert_eq!(field(item(alternatives, 0), "active"), false);
        assert_eq!(field(item(alternatives, 1), "content"), "Second answer");
        assert_eq!(field(item(alternatives, 1), "active"), true);
    }

    // ── resolve_ref tests ───────────────────────────────────────────

    #[test]
    fn resolve_ref_last() {
        let messages = vec![
            make_msg("m1", Role::User, "A"),
            make_msg("m2", Role::Assistant, "B"),
        ];
        assert_eq!(resolve_ref(&messages, "last").unwrap(), "m2");
        assert_eq!(resolve_ref(&messages, "latest").unwrap(), "m2");
    }

    #[test]
    fn resolve_ref_negative_index() {
        let messages = vec![
            make_msg("m1", Role::User, "A"),
            make_msg("m2", Role::Assistant, "B"),
            make_msg("m3", Role::User, "C"),
        ];
        assert_eq!(resolve_ref(&messages, "-1").unwrap(), "m3");
        assert_eq!(resolve_ref(&messages, "-2").unwrap(), "m2");
        assert_eq!(resolve_ref(&messages, "-3").unwrap(), "m1");
    }

    #[test]
    fn resolve_ref_positive_index() {
        let messages = vec![
            make_msg("m1", Role::User, "A"),
            make_msg("m2", Role::Assistant, "B"),
            make_msg("m3", Role::User, "C"),
        ];
        assert_eq!(resolve_ref(&messages, "1").unwrap(), "m1");
        assert_eq!(resolve_ref(&messages, "2").unwrap(), "m2");
        assert_eq!(resolve_ref(&messages, "3").unwrap(), "m3");
    }

    #[test]
    fn resolve_ref_literal_passthrough() {
        let messages = vec![make_msg("m_abc123", Role::User, "A")];
        assert_eq!(resolve_ref(&messages, "m_abc123").unwrap(), "m_abc123");
    }

    #[test]
    fn resolve_ref_zero_is_error() {
        let messages = vec![make_msg("m1", Role::User, "A")];
        let (code, _msg) = resolve_ref(&messages, "0").unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn resolve_ref_out_of_range() {
        let messages = vec![make_msg("m1", Role::User, "A")];
        let (code, _msg) = resolve_ref(&messages, "99").unwrap_err();
        assert_eq!(code, ErrorCode::NotFound);
        let (neg_code, _neg_msg) = resolve_ref(&messages, "-99").unwrap_err();
        assert_eq!(neg_code, ErrorCode::NotFound);
    }

    #[test]
    fn resolve_ref_empty_conversation() {
        let messages: Vec<Message> = vec![];
        let (code, _msg) = resolve_ref(&messages, "last").unwrap_err();
        assert_eq!(code, ErrorCode::NotFound);
        let (neg_code, _neg_msg) = resolve_ref(&messages, "-1").unwrap_err();
        assert_eq!(neg_code, ErrorCode::NotFound);
    }

    #[test]
    fn edit_by_relative_ref_last() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "First"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "Second"))
            .unwrap();

        let result = edit(
            &mut engine,
            &mut ctx,
            &json!({"ref": "last", "content": "Edited"}),
        )
        .unwrap();
        assert_eq!(field(&result, "ref"), "m2");
        assert_eq!(item(engine.messages(), 1).content, "Edited");
    }

    #[test]
    fn edit_by_negative_index() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "First"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "Second"))
            .unwrap();

        let result = edit(
            &mut engine,
            &mut ctx,
            &json!({"ref": "-1", "content": "Edited"}),
        )
        .unwrap();
        assert_eq!(field(&result, "ref"), "m2");
        assert_eq!(item(engine.messages(), 1).content, "Edited");
    }

    #[test]
    fn edit_by_positive_index() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "First"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "Second"))
            .unwrap();

        let result = edit(
            &mut engine,
            &mut ctx,
            &json!({"ref": "1", "content": "Edited"}),
        )
        .unwrap();
        assert_eq!(field(&result, "ref"), "m1");
        assert_eq!(item(engine.messages(), 0).content, "Edited");
    }

    #[test]
    fn delete_by_relative_ref() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);
        engine
            .append_message(make_msg("m1", Role::User, "A"))
            .unwrap();
        engine
            .append_message(make_msg("m2", Role::Assistant, "B"))
            .unwrap();

        let result = delete(&mut engine, &mut ctx, &json!({"refs": "last"})).unwrap();
        assert_eq!(item(array_field(&result, "deleted"), 0), "m2");
        assert_eq!(engine.messages().len(), 1);
        assert_eq!(item(engine.messages(), 0).msg_id, "m1");
    }

    #[test]
    fn test_inject_system_appends_message() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = inject_system(
            &mut engine,
            &mut ctx,
            &json!({"text": "Stop using actions"}),
        )
        .unwrap();
        assert_eq!(field(&result, "injected"), true);

        assert_eq!(engine.messages().len(), 1);
        let msg = item(engine.messages(), 0);
        assert_eq!(msg.role, Role::System);
        assert_eq!(msg.content, "Stop using actions");
        assert!(msg.msg_id.starts_with("m_"));
    }

    #[test]
    fn test_inject_system_missing_text() {
        let tmp = TempDir::new().unwrap();
        let (mut engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = inject_system(&mut engine, &mut ctx, &json!({}));
        assert!(result.is_err());
        let (code, msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
        assert!(msg.contains("text"));
    }
}
