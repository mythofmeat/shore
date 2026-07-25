use std::path::{Path, PathBuf};

use shore_common::protocol::types::{
    derive_content_from_blocks_with, ContentBlock, Message, MessageAlternative, Role,
};
use tracing::info;

use super::EngineError;
use crate::convert::usize_to_u32;

/// Alternatives captured before a regeneration replaces the active response.
#[derive(Debug, Clone)]
pub struct PendingAlt {
    pub alternatives: Vec<MessageAlternative>,
}

/// Result of selecting a stored alternate response.
#[derive(Debug, Clone)]
pub struct AltSelection {
    pub msg_id: String,
    pub alt_index: u32,
    pub alt_count: u32,
    pub content: String,
}

/// In-memory message store backed by a JSONL file on disk.
///
/// Each line in the JSONL file is one `Message` serialized as JSON.
/// Mutations (append, edit, delete) are reflected both in-memory and on disk.
#[derive(Debug)]
pub struct MessageStore {
    messages: Vec<Message>,
    path: PathBuf,
}

impl MessageStore {
    /// Create a new empty store that will persist to `path`.
    pub fn new(path: PathBuf) -> Self {
        Self {
            messages: Vec::new(),
            path,
        }
    }

    /// Load messages from an existing JSONL file.
    /// If the file doesn't exist, starts with an empty list.
    pub fn load(path: PathBuf) -> Result<Self, EngineError> {
        Self::load_with_raw(path).map(|(store, _)| store)
    }

    /// Load messages and return the raw on-disk content alongside the parsed
    /// store. The caller-side use case is background compaction, which needs
    /// both views — `compact()` parses messages while segment archival needs
    /// the byte-for-byte file contents. A single read avoids re-opening the
    /// file (which can be many MB for long histories) and avoids briefly
    /// blocking the runtime on a sync read after the parse already happened.
    ///
    /// Returns `(store, raw)`. When the file doesn't exist, `raw` is empty.
    pub fn load_with_raw(path: PathBuf) -> Result<(Self, String), EngineError> {
        let (messages, raw) = if path.exists() {
            let content = std::fs::read_to_string(&path).map_err(|e| EngineError::Io {
                path: path.clone(),
                source: e,
            })?;
            let mut msgs = Vec::new();
            for raw_line in content.lines() {
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                let mut msg: Message =
                    serde_json::from_str(line).map_err(|e| EngineError::JsonParse {
                        path: path.clone(),
                        source: e,
                    })?;
                msg.normalize();
                msgs.push(msg);
            }
            (msgs, content)
        } else {
            (Vec::new(), String::new())
        };

        Ok((Self { messages, path }, raw))
    }

    /// All messages in order.
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// Number of raw messages in the store.
    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    /// Number of user turns in the store.
    ///
    /// A turn is a real user message — one that is NOT purely tool_result
    /// content.  Tool exchanges (assistant tool_use + user tool_result) are
    /// part of the same turn as the preceding real user message.
    pub fn turn_count(&self) -> usize {
        use shore_common::protocol::types::Role;
        self.messages
            .iter()
            .filter(|m| m.role == Role::User && !m.is_tool_result_only())
            .count()
    }

    /// Clear all messages and truncate the backing file.
    pub fn clear(&mut self) -> Result<(), EngineError> {
        self.messages.clear();
        self.persist()
    }

    /// Clone conversation messages through the last real user turn.
    ///
    /// Regeneration prompts use this view so the provider does not see the
    /// assistant response currently being regenerated.
    pub fn messages_through_last_user_turn(&self) -> Vec<Message> {
        let keep = self.last_real_user_turn_keep_index();
        self.messages.get(..keep).unwrap_or(&self.messages).to_vec()
    }

    /// The file path this store persists to.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append a message and persist.
    pub fn append(&mut self, msg: Message) -> Result<(), EngineError> {
        info!(msg_id = %msg.msg_id, role = ?msg.role, "Appending message");
        self.messages.push(msg);
        self.persist()
    }

    /// Insert a message at its chronological position by `timestamp`.
    ///
    /// Inserts after the last existing message whose timestamp is `<=` the
    /// new message's timestamp. Falls back to append if either timestamp is
    /// unparseable (no silent reordering of malformed data).
    ///
    /// Needed for out-of-band writers (e.g. a heartbeat tick completing
    /// while a user message has already landed via the handler) — the
    /// resulting chronology stays consistent.
    pub fn insert_by_timestamp(&mut self, msg: Message) -> Result<(), EngineError> {
        use chrono::DateTime;
        let insert_pos = match DateTime::parse_from_rfc3339(&msg.timestamp) {
            Ok(new_ts) => self
                .messages
                .iter()
                .rposition(|m| {
                    DateTime::parse_from_rfc3339(&m.timestamp)
                        .map_or(true, |existing| existing <= new_ts)
                })
                .map_or(0, |i| i.saturating_add(1)),
            Err(_) => self.messages.len(),
        };
        info!(
            msg_id = %msg.msg_id,
            role = ?msg.role,
            insert_pos,
            total = self.messages.len(),
            "Inserting message by timestamp"
        );
        self.messages.insert(insert_pos, msg);
        self.persist()
    }

    /// Edit the content of a message by `msg_id`. Returns an error if not found.
    ///
    /// Updates both `content` and `content_blocks` to keep them in sync.
    pub fn edit(&mut self, msg_id: &str, new_content: &str) -> Result<(), EngineError> {
        use shore_common::protocol::types::ContentBlock;
        let msg = self
            .messages
            .iter_mut()
            .find(|m| m.msg_id == msg_id)
            .ok_or_else(|| EngineError::MessageNotFound(msg_id.to_owned()))?;
        info!(msg_id, "Editing message");
        new_content.clone_into(&mut msg.content);
        msg.content_blocks = vec![ContentBlock::Text {
            text: new_content.to_owned(),
        }];
        self.persist()
    }

    /// Remove every message after the last real user turn.
    ///
    /// A "real user turn" is a User message that is NOT purely tool_result
    /// content.  This wipes assistant replies, tool-use exchanges, and
    /// tool-result messages that followed the last genuine user input.
    /// Returns the number of messages removed.
    pub fn truncate_after_last_user_turn(&mut self) -> Result<usize, EngineError> {
        let keep = self.last_real_user_turn_keep_index();
        let removed = self.messages.len().saturating_sub(keep);
        if removed > 0 {
            info!(removed, "Truncating messages after last user turn");
            self.messages.truncate(keep);
            self.persist()?;
        }
        Ok(removed)
    }

    /// Replace every message after the last real user turn with `new_messages`.
    ///
    /// Used after a successful regeneration: old assistant/tool output becomes
    /// stored alternate responses, while the active conversation tail is
    /// atomically replaced by the newly generated raw response messages.
    pub fn replace_after_last_user_turn(
        &mut self,
        new_messages: Vec<Message>,
    ) -> Result<usize, EngineError> {
        let keep = self.last_real_user_turn_keep_index();
        let removed = self.messages.len().saturating_sub(keep);
        info!(
            removed,
            added = new_messages.len(),
            "Replacing messages after last user turn"
        );
        self.messages.truncate(keep);
        self.messages.extend(new_messages);
        self.persist()?;
        Ok(removed)
    }

    /// Delete a message by `msg_id`. Returns an error if not found.
    pub fn delete(&mut self, msg_id: &str) -> Result<(), EngineError> {
        let idx = self
            .messages
            .iter()
            .position(|m| m.msg_id == msg_id)
            .ok_or_else(|| EngineError::MessageNotFound(msg_id.to_owned()))?;
        info!(msg_id, "Deleting message");
        let _ignored = self.messages.remove(idx);
        self.persist()
    }

    /// Set the active alternate response for a message.
    /// Updates `alt_index` to `index` and ensures `alt_count >= index + 1`.
    pub fn set_alt(&mut self, msg_id: &str, index: u32, count: u32) -> Result<(), EngineError> {
        let msg = self
            .messages
            .iter_mut()
            .find(|m| m.msg_id == msg_id)
            .ok_or_else(|| EngineError::MessageNotFound(msg_id.to_owned()))?;
        info!(msg_id, alt_index = index, alt_count = count, "Setting alt");
        msg.alt_index = Some(index);
        msg.alt_count = Some(count);
        self.persist()
    }

    /// Increment the alt_count for a message and return the new count.
    pub fn add_alt_candidate(&mut self, msg_id: &str) -> Result<u32, EngineError> {
        let msg = self
            .messages
            .iter_mut()
            .find(|m| m.msg_id == msg_id)
            .ok_or_else(|| EngineError::MessageNotFound(msg_id.to_owned()))?;
        let new_count = msg.alt_count.unwrap_or(1).saturating_add(1);
        msg.alt_count = Some(new_count);
        // Point to the newest candidate.
        msg.alt_index = Some(new_count.saturating_sub(1));
        info!(msg_id, alt_count = new_count, "Added alt candidate");
        self.persist()?;
        Ok(new_count)
    }

    /// Capture the selectable alternatives for the assistant response that a
    /// regeneration is about to replace.
    pub fn pending_regen_alt(&self) -> Option<PendingAlt> {
        let keep = self.last_real_user_turn_keep_index();
        let tail = self.messages.get(keep..).unwrap_or(&[]);
        let merged = shore_common::protocol::merge::merge_tool_loop_messages(tail);
        let active = merged.iter().rev().find(|m| m.role == Role::Assistant)?;

        let mut alternatives = active.alternatives.clone();
        let current = alternative_from_message(active);
        if alternatives.is_empty() {
            alternatives.push(current);
        } else {
            let last_alt = usize_to_u32(alternatives.len().saturating_sub(1));
            let idx = usize::try_from(active.alt_index.unwrap_or(last_alt).min(last_alt))
                .unwrap_or(usize::MAX);
            if let Some(slot) = alternatives.get_mut(idx) {
                *slot = current;
            }
        }

        Some(PendingAlt { alternatives })
    }

    /// Attach `prior` plus the active generated response as alternatives on
    /// the last assistant message in `messages`.
    pub fn attach_generated_alt(
        messages: &mut [Message],
        mut prior: Vec<MessageAlternative>,
    ) -> Option<(u32, u32)> {
        let merged = shore_common::protocol::merge::merge_tool_loop_messages(messages);
        let active = merged.iter().rev().find(|m| m.role == Role::Assistant)?;
        let active_msg_id = active.msg_id.clone();
        let new_alt = alternative_from_message(active);
        let alt_index = usize_to_u32(prior.len());
        prior.push(new_alt);
        let alt_count = usize_to_u32(prior.len());

        let target = messages
            .iter_mut()
            .rev()
            .find(|m| m.role == Role::Assistant && m.msg_id == active_msg_id)?;
        target.alt_index = Some(alt_index);
        target.alt_count = Some(alt_count);
        target.alternatives = prior;
        Some((alt_index, alt_count))
    }

    /// Select a stored alternate response on a message.
    pub fn select_alt(&mut self, msg_id: &str, index: u32) -> Result<AltSelection, EngineError> {
        let merged = shore_common::protocol::merge::merge_tool_loop_messages(&self.messages);
        let target = merged
            .iter()
            .find(|m| m.msg_id == msg_id)
            .ok_or_else(|| EngineError::MessageNotFound(msg_id.to_owned()))?;
        let alt_count = usize_to_u32(target.alternatives.len());
        if alt_count == 0 {
            return Err(EngineError::InvalidAlt(format!(
                "message {msg_id} has no alternate responses"
            )));
        }
        if index >= alt_count {
            return Err(EngineError::InvalidAlt(format!(
                "alternate index {} out of range (message has {} alternate response(s))",
                index.saturating_add(1),
                alt_count
            )));
        }

        let current_index = target.alt_index.unwrap_or(0);
        if current_index == index {
            return Ok(AltSelection {
                msg_id: target.msg_id.clone(),
                alt_index: index,
                alt_count,
                content: target.content.clone(),
            });
        }

        let selected = message_from_alternative(target, index).ok_or_else(|| {
            EngineError::InvalidAlt(format!(
                "alternate index {} out of range (message has {} alternate response(s))",
                index.saturating_add(1),
                alt_count
            ))
        })?;
        let keep = self.last_real_user_turn_keep_index();
        let tail_merged = shore_common::protocol::merge::merge_tool_loop_messages(
            self.messages.get(keep..).unwrap_or(&[]),
        );
        let is_current_tail = tail_merged
            .iter()
            .rev()
            .find(|m| m.role == Role::Assistant)
            .is_some_and(|m| m.msg_id == msg_id);

        if is_current_tail {
            self.messages.truncate(keep);
            self.messages.push(selected.clone());
        } else if let Some(raw) = self.messages.iter_mut().find(|m| m.msg_id == msg_id) {
            *raw = selected.clone();
        } else {
            return Err(EngineError::MessageNotFound(msg_id.to_owned()));
        }

        self.persist()?;
        Ok(AltSelection {
            msg_id: selected.msg_id,
            alt_index: index,
            alt_count,
            content: selected.content,
        })
    }

    /// Write all messages to the JSONL file (full rewrite).
    ///
    /// Uses `serialize_for_storage()` to omit the derived `content` field.
    fn persist(&self) -> Result<(), EngineError> {
        let mut buf = String::new();
        for msg in &self.messages {
            let line = msg
                .serialize_for_storage()
                .map_err(|e| EngineError::JsonSerialize {
                    context: "message".into(),
                    source: e,
                })?;
            buf.push_str(&line);
            buf.push('\n');
        }
        super::atomic::atomic_write(&self.path, buf.as_bytes())?;
        Ok(())
    }

    fn last_real_user_turn_keep_index(&self) -> usize {
        self.messages
            .iter()
            .rposition(is_real_user_turn)
            .map_or(0, |i| i.saturating_add(1))
    }
}

fn is_real_user_turn(m: &Message) -> bool {
    m.role == Role::User && !m.is_tool_result_only()
}

fn alternative_from_message(msg: &Message) -> MessageAlternative {
    let mut content_blocks: Vec<ContentBlock> = msg
        .content_blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } if !text.trim().is_empty() => {
                Some(ContentBlock::Text { text: text.clone() })
            }
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect();
    let mut content = derive_content_from_blocks_with(&content_blocks, false);
    if content.is_empty() && !msg.content.trim().is_empty() {
        content.clone_from(&msg.content);
        content_blocks = vec![ContentBlock::Text {
            text: msg.content.clone(),
        }];
    }

    MessageAlternative {
        content,
        images: msg.images.clone(),
        content_blocks,
        timestamp: msg.timestamp.clone(),
        provider_key: msg.provider_key.clone(),
        model: msg.model.clone(),
    }
}

fn message_from_alternative(template: &Message, index: u32) -> Option<Message> {
    let alt_pos = usize::try_from(index).unwrap_or(usize::MAX);
    let alt = template.alternatives.get(alt_pos)?.clone();
    let mut msg = Message {
        msg_id: template.msg_id.clone(),
        origin: template.origin,
        role: Role::Assistant,
        content: alt.content,
        images: alt.images,
        content_blocks: alt.content_blocks,
        alt_index: Some(index),
        alt_count: Some(usize_to_u32(template.alternatives.len())),
        alternatives: template.alternatives.clone(),
        // Prefer the selected alternative's own provenance; fall back to the
        // template for legacy alternatives stamped before per-alternative
        // provider tracking. This keeps the replay portability filter aligned
        // with the provider that actually minted the selected body, even when
        // it differs from the template or a sibling alternative.
        provider_key: alt
            .provider_key
            .clone()
            .or_else(|| template.provider_key.clone()),
        // Same fallback rule as provider_key: alternatives stamped before
        // model provenance tracking inherit the template's model.
        model: alt.model.clone().or_else(|| template.model.clone()),
        timestamp: if alt.timestamp.is_empty() {
            template.timestamp.clone()
        } else {
            alt.timestamp
        },
    };
    msg.normalize();
    Some(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shore_common::protocol::types::Role;
    use tempfile::TempDir;

    fn make_msg(id: &str, role: Role, content: &str) -> Message {
        use shore_common::protocol::types::ContentBlock;
        Message {
            msg_id: id.to_owned(),
            origin: None,
            role,
            content: content.to_owned(),
            images: vec![],
            content_blocks: if content.is_empty() {
                vec![]
            } else {
                vec![ContentBlock::Text {
                    text: content.to_owned(),
                }]
            },
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn append_and_read_back() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store.append(make_msg("m1", Role::User, "Hello")).unwrap();
        store
            .append(make_msg("m2", Role::Assistant, "Hi there"))
            .unwrap();

        assert_eq!(store.messages().len(), 2);
        assert_eq!(store.messages()[0].content, "Hello");
        assert_eq!(store.messages()[1].content, "Hi there");

        // Reload from disk.
        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages().len(), 2);
        assert_eq!(reloaded.messages()[0].msg_id, "m1");
        assert_eq!(reloaded.messages()[1].msg_id, "m2");
    }

    #[test]
    fn edit_message() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store
            .append(make_msg("m1", Role::User, "Original"))
            .unwrap();
        store.edit("m1", "Edited").unwrap();

        assert_eq!(store.messages()[0].content, "Edited");

        // Persisted.
        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages()[0].content, "Edited");
    }

    #[test]
    fn edit_nonexistent_returns_error() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path);

        let result = store.edit("nope", "content");
        assert!(matches!(result, Err(EngineError::MessageNotFound(_))));
    }

    #[test]
    fn delete_message() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store.append(make_msg("m1", Role::User, "First")).unwrap();
        store
            .append(make_msg("m2", Role::Assistant, "Second"))
            .unwrap();
        store.append(make_msg("m3", Role::User, "Third")).unwrap();

        store.delete("m2").unwrap();

        assert_eq!(store.messages().len(), 2);
        assert_eq!(store.messages()[0].msg_id, "m1");
        assert_eq!(store.messages()[1].msg_id, "m3");

        // Persisted.
        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages().len(), 2);
    }

    #[test]
    fn delete_nonexistent_returns_error() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path);

        let result = store.delete("nope");
        assert!(matches!(result, Err(EngineError::MessageNotFound(_))));
    }

    #[test]
    fn alt_candidate_management() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store
            .append(make_msg("m1", Role::Assistant, "Response A"))
            .unwrap();

        // Set initial alternate state.
        store.set_alt("m1", 0, 1).unwrap();
        assert_eq!(store.messages()[0].alt_index, Some(0));
        assert_eq!(store.messages()[0].alt_count, Some(1));

        // Add an alternate candidate.
        let count = store.add_alt_candidate("m1").unwrap();
        assert_eq!(count, 2);
        assert_eq!(store.messages()[0].alt_index, Some(1));
        assert_eq!(store.messages()[0].alt_count, Some(2));

        // Switch back to first.
        store.set_alt("m1", 0, 2).unwrap();
        assert_eq!(store.messages()[0].alt_index, Some(0));

        // Persisted.
        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages()[0].alt_index, Some(0));
        assert_eq!(reloaded.messages()[0].alt_count, Some(2));
    }

    #[test]
    fn regen_alts_preserve_and_select_prior_alternatives() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store.append(make_msg("u1", Role::User, "Prompt")).unwrap();
        store
            .append(make_msg("a1", Role::Assistant, "First answer"))
            .unwrap();

        let prompt_messages = store.messages_through_last_user_turn();
        assert_eq!(prompt_messages.len(), 1);
        assert_eq!(prompt_messages[0].msg_id, "u1");

        let pending = store.pending_regen_alt().unwrap();
        assert_eq!(pending.alternatives.len(), 1);
        assert_eq!(pending.alternatives[0].content, "First answer");

        let mut regenerated = vec![make_msg("a2", Role::Assistant, "Second answer")];
        let (alt_index, alt_count) =
            MessageStore::attach_generated_alt(&mut regenerated, pending.alternatives).unwrap();
        assert_eq!((alt_index, alt_count), (1, 2));

        let _ignored = store.replace_after_last_user_turn(regenerated).unwrap();
        let active = &store.messages()[1];
        assert_eq!(active.msg_id, "a2");
        assert_eq!(active.content, "Second answer");
        assert_eq!(active.alt_index, Some(1));
        assert_eq!(active.alt_count, Some(2));
        assert_eq!(active.alternatives[0].content, "First answer");
        assert_eq!(active.alternatives[1].content, "Second answer");

        let selected = store.select_alt("a2", 0).unwrap();
        assert_eq!(selected.content, "First answer");
        assert_eq!(store.messages().len(), 2);
        assert_eq!(store.messages()[1].content, "First answer");
        assert_eq!(store.messages()[1].alt_index, Some(0));

        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages()[1].content, "First answer");
        assert_eq!(reloaded.messages()[1].alternatives.len(), 2);
        assert_eq!(reloaded.messages()[1].alt_index, Some(0));
    }

    #[test]
    fn alternatives_track_their_own_provider_provenance() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store.append(make_msg("u1", Role::User, "Prompt")).unwrap();
        // Original answer minted by Anthropic.
        let mut first = make_msg("a1", Role::Assistant, "First answer");
        first.provider_key = Some("anthropic".to_owned());
        first.model = Some("claude-opus-4-6".to_owned());
        store.append(first).unwrap();

        let pending = store.pending_regen_alt().unwrap();
        assert_eq!(
            pending.alternatives[0].provider_key.as_deref(),
            Some("anthropic"),
            "captured prior alternative should carry the minting provider"
        );
        assert_eq!(
            pending.alternatives[0].model.as_deref(),
            Some("claude-opus-4-6"),
            "captured prior alternative should carry the minting model"
        );

        // Regenerate under a different provider and model.
        let mut second = make_msg("a2", Role::Assistant, "Second answer");
        second.provider_key = Some("openrouter".to_owned());
        second.model = Some("deepseek-v4-pro".to_owned());
        let mut regenerated = vec![second];
        let _ = MessageStore::attach_generated_alt(&mut regenerated, pending.alternatives).unwrap();
        let _ = store.replace_after_last_user_turn(regenerated).unwrap();

        let active = &store.messages()[1];
        assert_eq!(active.provider_key.as_deref(), Some("openrouter"));
        assert_eq!(active.model.as_deref(), Some("deepseek-v4-pro"));
        assert_eq!(
            active.alternatives[0].provider_key.as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            active.alternatives[0].model.as_deref(),
            Some("claude-opus-4-6")
        );
        assert_eq!(
            active.alternatives[1].provider_key.as_deref(),
            Some("openrouter")
        );
        assert_eq!(
            active.alternatives[1].model.as_deref(),
            Some("deepseek-v4-pro")
        );

        // Selecting the Anthropic-minted alternative must tag the resulting
        // active message with *its* provenance, not the openrouter template's.
        let _ = store.select_alt("a2", 0).unwrap();
        assert_eq!(store.messages()[1].content, "First answer");
        assert_eq!(
            store.messages()[1].provider_key.as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            store.messages()[1].model.as_deref(),
            Some("claude-opus-4-6")
        );

        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(
            reloaded.messages()[1].provider_key.as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            reloaded.messages()[1].model.as_deref(),
            Some("claude-opus-4-6")
        );
        assert_eq!(
            reloaded.messages()[1].alternatives[1]
                .provider_key
                .as_deref(),
            Some("openrouter")
        );
        assert_eq!(
            reloaded.messages()[1].alternatives[1].model.as_deref(),
            Some("deepseek-v4-pro")
        );
    }

    #[test]
    fn legacy_alternative_without_provenance_falls_back_to_template() {
        // An alternative persisted before per-alternative provenance tracking
        // has `provider_key: None` / `model: None`; selecting it should
        // inherit the message's provenance rather than dropping it entirely.
        let mut template = make_msg("a1", Role::Assistant, "Active answer");
        template.provider_key = Some("anthropic".to_owned());
        template.model = Some("claude-opus-4-6".to_owned());
        template.alternatives = vec![
            MessageAlternative {
                content: "Legacy answer".to_owned(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "Legacy answer".to_owned(),
                }],
                timestamp: String::new(),
                provider_key: None,
                model: None,
            },
            alternative_from_message(&template),
        ];

        let selected = message_from_alternative(&template, 0).unwrap();
        assert_eq!(selected.content, "Legacy answer");
        assert_eq!(selected.provider_key.as_deref(), Some("anthropic"));
        assert_eq!(selected.model.as_deref(), Some("claude-opus-4-6"));
    }

    #[test]
    fn load_nonexistent_file_gives_empty_store() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("does_not_exist.jsonl");

        let store = MessageStore::load(path).unwrap();
        assert!(store.messages().is_empty());
    }

    // ── JSONL resilience tests ���───────────────────────────────────────

    #[test]
    fn load_skips_empty_lines() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");

        // Create a store with one message, then manually inject blank lines.
        let mut store = MessageStore::new(path.clone());
        store.append(make_msg("m1", Role::User, "Hello")).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let with_blanks = format!("\n\n{}\n\n", content.trim());
        std::fs::write(&path, with_blanks).unwrap();

        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages().len(), 1);
        assert_eq!(reloaded.messages()[0].msg_id, "m1");
    }

    #[test]
    fn load_rejects_invalid_json_line() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");

        std::fs::write(&path, "{broken json\n").unwrap();
        let result = MessageStore::load(path);
        assert!(
            matches!(result, Err(EngineError::JsonParse { .. })),
            "should return JsonParse error for malformed JSON"
        );
    }

    #[test]
    fn load_handles_trailing_newline() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");

        let mut store = MessageStore::new(path.clone());
        store.append(make_msg("m1", Role::User, "Hello")).unwrap();

        // Append extra trailing newlines (simulating editor artifact).
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("\n\n\n");
        std::fs::write(&path, content).unwrap();

        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages().len(), 1);
    }

    #[test]
    fn load_normalizes_legacy_format() {
        use shore_common::protocol::types::ContentBlock;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");

        // Write a legacy message with content but no content_blocks.
        let legacy = serde_json::json!({
            "msg_id": "legacy1",
            "role": "user",
            "content": "old format message",
            "content_blocks": [],
            "images": [],
            "timestamp": "2026-01-01T00:00:00Z"
        });
        std::fs::write(&path, format!("{legacy}\n")).unwrap();

        let store = MessageStore::load(path).unwrap();
        assert_eq!(store.messages().len(), 1);
        let msg = &store.messages()[0];
        // normalize() should populate content_blocks from content.
        assert!(
            !msg.content_blocks.is_empty(),
            "normalize should populate content_blocks from content"
        );
        assert!(
            matches!(&msg.content_blocks[0], ContentBlock::Text { text } if text == "old format message")
        );
    }

    #[test]
    fn persist_roundtrip_special_characters() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        let special = "Unicode: \u{1F600} \u{00E9}\nNewline in content\t\"Quoted\"\\Backslash";
        store.append(make_msg("m1", Role::User, special)).unwrap();

        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages()[0].content, special);
    }

    #[test]
    fn turn_count_excludes_tool_result_messages() {
        use shore_common::protocol::types::ContentBlock;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path);

        // Real user turn.
        store.append(make_msg("m1", Role::User, "Hello")).unwrap();
        // Assistant with tool use.
        store
            .append(make_msg("m2", Role::Assistant, "Let me search"))
            .unwrap();
        // Tool result (NOT a real user turn).
        let mut tool_msg = Message {
            msg_id: "m3".to_owned(),
            origin: None,
            role: Role::User,
            content: String::new(),
            images: vec![],
            content_blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "call_1".to_owned(),
                content: "5 results found".to_owned(),
                is_error: false,
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".to_owned(),
        };
        tool_msg.content = "5 results found".to_owned();
        store.append(tool_msg).unwrap();
        // Another real user turn.
        store.append(make_msg("m4", Role::User, "Thanks")).unwrap();

        assert_eq!(store.message_count(), 4);
        assert_eq!(
            store.turn_count(),
            2,
            "tool-result message should not count as a turn"
        );
    }

    // ── JSONL corruption / edge-case tests ─────────────────────────────

    #[test]
    fn load_truncated_json_line() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");

        // Write one valid message, then a truncated JSON line (simulating power loss).
        let mut store = MessageStore::new(path.clone());
        store.append(make_msg("m1", Role::User, "Hello")).unwrap();

        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str(r#"{"msg_id":"m2","role":"user","content":"trunc"#);
        content.push('\n');
        std::fs::write(&path, content).unwrap();

        let result = MessageStore::load(path);
        assert!(
            matches!(result, Err(EngineError::JsonParse { .. })),
            "truncated JSON line should produce JsonParse error"
        );
    }

    #[test]
    fn load_skips_whitespace_only_lines() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");

        let mut store = MessageStore::new(path.clone());
        store.append(make_msg("m1", Role::User, "Hello")).unwrap();

        let valid_line = std::fs::read_to_string(&path).unwrap();
        let with_ws = format!("   \t  \n{}\n  \t\n", valid_line.trim());
        std::fs::write(&path, with_ws).unwrap();

        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages().len(), 1);
        assert_eq!(reloaded.messages()[0].msg_id, "m1");
    }

    // ── insert_by_timestamp ────────────────────────────────────────────

    fn make_msg_ts(id: &str, role: Role, ts: &str) -> Message {
        let mut m = make_msg(id, role, id);
        m.timestamp = ts.to_owned();
        m
    }

    #[test]
    fn insert_by_timestamp_empty_store() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store
            .insert_by_timestamp(make_msg_ts("m1", Role::User, "2026-04-19T10:00:00+10:00"))
            .unwrap();

        assert_eq!(store.messages().len(), 1);
        assert_eq!(store.messages()[0].msg_id, "m1");
    }

    #[test]
    fn insert_by_timestamp_at_end_for_latest_ts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store
            .append(make_msg_ts("m1", Role::User, "2026-04-19T10:00:00+10:00"))
            .unwrap();
        store
            .append(make_msg_ts(
                "m2",
                Role::Assistant,
                "2026-04-19T10:05:00+10:00",
            ))
            .unwrap();

        // New message with the latest timestamp should land at the end.
        store
            .insert_by_timestamp(make_msg_ts("m3", Role::System, "2026-04-19T10:30:00+10:00"))
            .unwrap();

        let ids: Vec<&str> = store.messages().iter().map(|m| m.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2", "m3"]);
    }

    #[test]
    fn insert_by_timestamp_in_middle() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        // Simulate the tick's recap racing a user-message landing: the tick
        // captures tick_started_at earlier, but the user message lands
        // first. The recap should splice before the user message.
        store
            .append(make_msg_ts(
                "m_user1",
                Role::User,
                "2026-04-19T10:00:00+10:00",
            ))
            .unwrap();
        store
            .append(make_msg_ts(
                "m_assistant1",
                Role::Assistant,
                "2026-04-19T10:05:00+10:00",
            ))
            .unwrap();
        store
            .append(make_msg_ts(
                "m_user2",
                Role::User,
                "2026-04-19T10:30:00+10:00",
            ))
            .unwrap();

        // Recap timestamped at 10:20 (between assistant and user2).
        store
            .insert_by_timestamp(make_msg_ts(
                "m_recap",
                Role::System,
                "2026-04-19T10:20:00+10:00",
            ))
            .unwrap();

        let ids: Vec<&str> = store.messages().iter().map(|m| m.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m_user1", "m_assistant1", "m_recap", "m_user2"]);

        // Persisted in correct order.
        let reloaded = MessageStore::load(path).unwrap();
        let reloaded_ids: Vec<&str> = reloaded
            .messages()
            .iter()
            .map(|m| m.msg_id.as_str())
            .collect();
        assert_eq!(
            reloaded_ids,
            vec!["m_user1", "m_assistant1", "m_recap", "m_user2"]
        );
    }

    #[test]
    fn insert_by_timestamp_at_front_for_earliest_ts() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        store
            .append(make_msg_ts("m1", Role::User, "2026-04-19T10:00:00+10:00"))
            .unwrap();
        store
            .append(make_msg_ts(
                "m2",
                Role::Assistant,
                "2026-04-19T10:05:00+10:00",
            ))
            .unwrap();

        store
            .insert_by_timestamp(make_msg_ts("m0", Role::System, "2026-04-19T09:00:00+10:00"))
            .unwrap();

        let ids: Vec<&str> = store.messages().iter().map(|m| m.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m0", "m1", "m2"]);
    }

    #[test]
    fn insert_by_timestamp_tolerates_different_offsets() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path);

        // 10:00 +10:00 == 00:00 UTC
        store
            .append(make_msg_ts("m1", Role::User, "2026-04-19T10:00:00+10:00"))
            .unwrap();
        // 01:30 UTC == 11:30 +10:00 — should land after m1.
        store
            .insert_by_timestamp(make_msg_ts("m2", Role::System, "2026-04-19T01:30:00+00:00"))
            .unwrap();

        let ids: Vec<&str> = store.messages().iter().map(|m| m.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2"]);
    }

    #[test]
    fn insert_by_timestamp_unparseable_falls_back_to_append() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path);

        store
            .append(make_msg_ts("m1", Role::User, "2026-04-19T10:00:00+10:00"))
            .unwrap();
        // Malformed timestamp — store should just append, not panic.
        store
            .insert_by_timestamp(make_msg_ts("m_bad", Role::System, "not-a-timestamp"))
            .unwrap();

        let ids: Vec<&str> = store.messages().iter().map(|m| m.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m_bad"]);
    }

    #[test]
    fn load_large_file_1000_messages() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("conv.jsonl");
        let mut store = MessageStore::new(path.clone());

        for i in 0..1000 {
            let role = if i % 2 == 0 {
                Role::User
            } else {
                Role::Assistant
            };
            store
                .append(make_msg(&format!("m{i}"), role, &format!("Message {i}")))
                .unwrap();
        }

        assert_eq!(store.messages().len(), 1000);
        assert_eq!(store.turn_count(), 500);

        let reloaded = MessageStore::load(path).unwrap();
        assert_eq!(reloaded.messages().len(), 1000);
        assert_eq!(reloaded.messages()[0].msg_id, "m0");
        assert_eq!(reloaded.messages()[999].msg_id, "m999");
    }
}
