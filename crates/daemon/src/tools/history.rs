//! Conversation history search tool.
//!
//! Searches both compacted segment files and the current active conversation
//! window for the character. This is intentionally separate from filesystem
//! search: history is transcript data, not workspace files.
//!
//! **Ported.** `llm-sidecar/src/tools/history.ts` is the implementation now,
//! pinned by `llm-sidecar/tests/engine_fixtures/history_parity.json` (frozen;
//! generated from this file at 9023b46d). Do not add behaviour here.
//!
//! Not deleted yet: tool dispatch still runs through `tools/mod.rs` and the
//! daemon's tool socket, and the TypeScript side has no executor registry to
//! receive it (#12, step 3). It goes when dispatch moves.

use std::path::PathBuf;

use chrono::{DateTime, FixedOffset};
use serde_json::{json, Value};
use shore_common::protocol::types::{derive_content_from_blocks_with, Message, Role};

use crate::convert::{i64_to_f64, u64_to_usize};
use crate::engine::messages::MessageStore;
use crate::engine::segments::SegmentReader;

use super::{ToolCategory, ToolContext, ToolDef, ToolError};

const DEFAULT_MAX_RESULTS: usize = 20;
const MAX_RESULTS: usize = 100;
const EXCERPT_CHARS: usize = 360;
const MIN_EXCERPT_CHARS: usize = 80;
const MAX_EXCERPT_CHARS: usize = 2000;

/// Relevance weights for ranking keyword matches. A contiguous phrase match is
/// worth more than scattered terms, and full term coverage beats partial.
const TERM_HIT: i64 = 10;
const FULL_COVERAGE_BONUS: i64 = 15;
const PHRASE_BONUS: i64 = 25;
/// Maximum recency contribution, in the same units as relevance. Kept below a
/// phrase match so a recent weak hit can't outrank an older strong one, while
/// recent matches still win among results of comparable relevance.
const RECENCY_WEIGHT: f64 = 15.0;

pub fn tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "search_chat_logs",
        description: crate::include_prompt!("../../prompts/tools/history/search_history.md"),
        parameters: json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optional keyword or phrase to search for (case-insensitive). Omit this to return messages by time range only."
                },
                "start_time": {
                    "type": "string",
                    "description": "Optional inclusive lower timestamp bound in RFC3339 format, for example 2026-05-13T09:00:00+10:00."
                },
                "end_time": {
                    "type": "string",
                    "description": "Optional inclusive upper timestamp bound in RFC3339 format, for example 2026-05-13T17:00:00+10:00."
                },
                "max_results": {
                    "type": "number",
                    "description": "Maximum matching messages to return. Defaults to 20, maximum 100."
                },
                "model": {
                    "type": "string",
                    "description": "Optional model filter: only return assistant messages minted by a matching model. Case-insensitive substring match with '.' and '-' treated as equal, so 'opus-4.6' matches both 'claude-opus-4-6' and 'anthropic/claude-opus-4.6'. Messages stored before model tracking carry no model and never match."
                },
                "excerpt_chars": {
                    "type": "number",
                    "description": "Approximate excerpt length in characters. Defaults to 360; maximum 2000. Use larger values when you need full quotes rather than context snippets."
                }
            },
            "required": []
        }),
        category: ToolCategory::Other,
    }]
}

#[derive(Debug, Clone)]
struct TimeRange {
    start: Option<DateTime<FixedOffset>>,
    end: Option<DateTime<FixedOffset>>,
}

impl TimeRange {
    fn is_empty(&self) -> bool {
        self.start.is_none() && self.end.is_none()
    }

    fn contains(&self, timestamp: DateTime<FixedOffset>) -> bool {
        if let Some(start) = self.start {
            if timestamp < start {
                return false;
            }
        }
        if let Some(end) = self.end {
            if timestamp > end {
                return false;
            }
        }
        true
    }
}

#[derive(Default)]
struct SearchStats {
    skipped_invalid_timestamps: usize,
}

/// Per-request filters threaded through the corpus scan.
#[derive(Clone, Copy)]
struct SearchFilters<'req> {
    matcher: Option<&'req QueryMatcher>,
    range: &'req TimeRange,
    /// Normalized (`normalize_model`) model substring, if the caller filters
    /// by minting model.
    model_filter: Option<&'req str>,
    excerpt_chars: usize,
}

pub(super) fn optional_trimmed_string(
    input: &Value,
    field: &str,
) -> Result<Option<String>, ToolError> {
    let Some(value) = input.get(field) else {
        return Ok(None);
    };
    let Some(s) = value.as_str() else {
        return Err(ToolError::InvalidArgs(format!("{field} must be a string")));
    };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.to_owned()))
}

pub(super) fn parse_time_bound(
    input: &Value,
    field: &str,
) -> Result<Option<DateTime<FixedOffset>>, ToolError> {
    optional_trimmed_string(input, field)?
        .map(|raw| {
            DateTime::parse_from_rfc3339(&raw).map_err(|e| {
                ToolError::InvalidArgs(format!("{field} must be an RFC3339 timestamp: {e}"))
            })
        })
        .transpose()
}

fn filters_from(input: &Value) -> Result<(Option<String>, TimeRange), ToolError> {
    let query = optional_trimmed_string(input, "query")?;
    let range = TimeRange {
        start: parse_time_bound(input, "start_time")?,
        end: parse_time_bound(input, "end_time")?,
    };

    if let (Some(start), Some(end)) = (range.start, range.end) {
        if start > end {
            return Err(ToolError::InvalidArgs(
                "start_time must be before or equal to end_time".into(),
            ));
        }
    }

    Ok((query, range))
}

fn max_results_from(input: &Value) -> usize {
    input
        .get("max_results")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_MAX_RESULTS, u64_to_usize)
        .clamp(1, MAX_RESULTS)
}

fn excerpt_chars_from(input: &Value) -> usize {
    input
        .get("excerpt_chars")
        .and_then(Value::as_u64)
        .map_or(EXCERPT_CHARS, u64_to_usize)
        .clamp(MIN_EXCERPT_CHARS, MAX_EXCERPT_CHARS)
}

/// Model ids for the same model differ by route (`claude-opus-4-6` direct,
/// `anthropic/claude-opus-4.6` via a gateway), so the filter compares with
/// `.` and `-` folded together, case-insensitively.
fn normalize_model(id: &str) -> String {
    id.to_lowercase().replace('.', "-")
}

/// Pre-normalized model filter, or `None` when the input omits it.
fn model_filter_from(input: &Value) -> Result<Option<String>, ToolError> {
    Ok(optional_trimmed_string(input, "model")?.map(|raw| normalize_model(&raw)))
}

/// Whether an (optional) minting model passes an (optional) normalized filter.
/// Messages without a model stamp never match an explicit filter — they
/// predate model tracking and cannot be attributed.
fn model_matches(model: Option<&str>, filter: Option<&str>) -> bool {
    match filter {
        None => true,
        Some(wanted) => model.is_some_and(|m| normalize_model(m).contains(wanted)),
    }
}

fn role_label(role: &Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
    }
}

/// Tokenized, lowercased view of a keyword query used for OR-style matching
/// and relevance scoring. Multi-word queries match any message containing *at
/// least one* term; messages matching more terms (or the full phrase) rank
/// higher. This replaces the previous whole-string substring match, which
/// required the entire query to appear verbatim and so returned nothing for
/// most natural-language phrases.
struct QueryMatcher {
    raw_lower: String,
    terms: Vec<String>,
}

impl QueryMatcher {
    fn new(query: &str) -> Self {
        let raw_lower = query.to_lowercase();
        let terms = raw_lower
            .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
            .filter(|t| t.len() >= 2)
            .map(str::to_owned)
            .collect();
        Self { raw_lower, terms }
    }

    /// Relevance score if `content` matches, or `None` if it contains none of
    /// the query terms.
    fn score(&self, content: &str) -> Option<i64> {
        let content_lower = content.to_lowercase();

        // Queries with no usable tokens (e.g. all single characters) fall back
        // to a literal substring match so the tool still behaves sensibly.
        if self.terms.is_empty() {
            return content_lower
                .contains(&self.raw_lower)
                .then_some(PHRASE_BONUS);
        }

        let hits = self
            .terms
            .iter()
            .filter(|term| content_lower.contains(term.as_str()))
            .count();
        if hits == 0 {
            return None;
        }

        let mut score = i64::try_from(hits)
            .unwrap_or_else(|_| i64::MAX.checked_div(TERM_HIT).unwrap_or_default())
            .saturating_mul(TERM_HIT);
        if hits == self.terms.len() {
            score = score.saturating_add(FULL_COVERAGE_BONUS);
        }
        if self.terms.len() > 1 && content_lower.contains(&self.raw_lower) {
            score = score.saturating_add(PHRASE_BONUS);
        }
        Some(score)
    }

    /// Byte index of the earliest match (full phrase or any single term), used
    /// to center the excerpt on the most relevant span.
    fn earliest_index(&self, content_lower: &str) -> Option<usize> {
        let mut best = content_lower.find(&self.raw_lower);
        for term in &self.terms {
            if let Some(idx) = content_lower.find(term.as_str()) {
                best = Some(best.map_or(idx, |b| b.min(idx)));
            }
        }
        best
    }
}

fn excerpt_for(content: &str, matcher_opt: Option<&QueryMatcher>, excerpt_chars: usize) -> String {
    let Some(matcher) = matcher_opt else {
        let mut excerpt: String = content.chars().take(excerpt_chars).collect();
        if content.chars().count() > excerpt_chars {
            excerpt.push_str("...");
        }
        return excerpt;
    };

    let content_lower = content.to_lowercase();
    let Some(byte_idx) = matcher.earliest_index(&content_lower) else {
        return content.chars().take(excerpt_chars).collect();
    };

    // Leading context must stay well under the window size: a fixed 80-char
    // lead-in with `excerpt_chars` at the 80 minimum would end the excerpt
    // exactly where the match begins.
    let leading = excerpt_chars.saturating_div(4).min(80);
    let start_char = content
        .get(..byte_idx)
        .map_or(0, |prefix| prefix.chars().count().saturating_sub(leading));
    let mut excerpt: String = content
        .chars()
        .skip(start_char)
        .take(excerpt_chars)
        .collect();
    if start_char > 0 {
        excerpt = format!("...{excerpt}");
    }
    if content.chars().count() > start_char.saturating_add(excerpt_chars) {
        excerpt.push_str("...");
    }
    excerpt
}

/// The text a user actually sees in the chat transcript: `Text` blocks only.
/// Excludes thinking, redacted thinking, tool calls, and tool results so
/// `search_history` searches the conversation rather than the model's private
/// reasoning or machine-readable tool payloads. `Message.content` deliberately
/// folds tool-result text in (for replay/rendering), so we do not use it here.
fn chat_text(blocks: &[shore_common::protocol::types::ContentBlock]) -> String {
    derive_content_from_blocks_with(blocks, false)
}

fn relevance_for(matcher: Option<&QueryMatcher>, content: &str) -> Option<i64> {
    match matcher {
        Some(m) => m.score(content),
        // No query: every message is a (zero-relevance) candidate, ordered by
        // time rather than ranked.
        None => Some(0),
    }
}

fn matches_time_range(
    timestamp: &str,
    range: &TimeRange,
    skipped_invalid_timestamps: &mut usize,
) -> bool {
    if range.is_empty() {
        return true;
    }

    if let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) {
        range.contains(parsed)
    } else {
        *skipped_invalid_timestamps = skipped_invalid_timestamps.saturating_add(1);
        false
    }
}

/// A matching message (or stored alternative) plus the keys needed to rank it.
struct ScoredCandidate {
    value: Value,
    relevance: i64,
    parsed_ts: Option<DateTime<FixedOffset>>,
}

fn make_candidate(relevance: i64, timestamp: &str, value: Value) -> ScoredCandidate {
    ScoredCandidate {
        relevance,
        parsed_ts: DateTime::parse_from_rfc3339(timestamp).ok(),
        value,
    }
}

/// Scans every message in `messages`, appending all matches (no early cutoff)
/// so the caller can rank the full candidate set. The previous early break at
/// `max_results` meant oldest segments filled the quota and recent matches were
/// never reached.
fn collect_matches(
    candidates: &mut Vec<ScoredCandidate>,
    messages: &[Message],
    source: &str,
    filters: &SearchFilters<'_>,
    stats: &mut SearchStats,
) {
    let SearchFilters {
        matcher,
        range,
        model_filter,
        excerpt_chars,
    } = *filters;
    for message in messages {
        // Search the user-visible chat text only — never thinking or tool
        // results. A message with no chat text (e.g. a tool-result-only turn)
        // is skipped entirely, including for time-range-only queries.
        let text = chat_text(&message.content_blocks);
        if !text.is_empty() && model_matches(message.model.as_deref(), model_filter) {
            if let Some(relevance) = relevance_for(matcher, &text) {
                if matches_time_range(
                    &message.timestamp,
                    range,
                    &mut stats.skipped_invalid_timestamps,
                ) {
                    candidates.push(make_candidate(
                        relevance,
                        &message.timestamp,
                        json!({
                            "msg_id": message.msg_id,
                            "role": role_label(&message.role),
                            "timestamp": message.timestamp,
                            "source": source,
                            "model": message.model,
                            "excerpt": excerpt_for(&text, matcher, excerpt_chars),
                        }),
                    ));
                }
            }
        }

        for (index, alternative) in message.alternatives.iter().enumerate() {
            if alternative.content == message.content {
                continue;
            }
            let alt_text = chat_text(&alternative.content_blocks);
            if alt_text.is_empty() {
                continue;
            }
            // Alternatives stamped before per-alternative provenance inherit
            // the parent message's model, mirroring alternative selection.
            let alt_model = alternative.model.as_deref().or(message.model.as_deref());
            if !model_matches(alt_model, model_filter) {
                continue;
            }
            let Some(relevance) = relevance_for(matcher, &alt_text) else {
                continue;
            };
            let timestamp = if alternative.timestamp.is_empty() {
                &message.timestamp
            } else {
                &alternative.timestamp
            };
            if !matches_time_range(timestamp, range, &mut stats.skipped_invalid_timestamps) {
                continue;
            }
            candidates.push(make_candidate(
                relevance,
                timestamp,
                json!({
                    "msg_id": message.msg_id,
                    "role": role_label(&message.role),
                    "timestamp": timestamp,
                    "source": format!("{source}:alt:{index}"),
                    "alternative_index": index,
                    "alternative_count": message.alternatives.len(),
                    "model": alt_model,
                    "excerpt": excerpt_for(&alt_text, matcher, excerpt_chars),
                }),
            ));
        }
    }
}

/// Combined ranking score: lexical relevance plus a recency boost normalized
/// over the span of candidate timestamps. Older messages contribute 0 recency,
/// the newest contributes `RECENCY_WEIGHT`.
#[expect(
    clippy::float_arithmetic,
    reason = "history ranking blends integer lexical relevance with normalized f64 recency weight"
)]
fn combined_score(
    candidate: &ScoredCandidate,
    min_ts: Option<DateTime<FixedOffset>>,
    span_secs: f64,
) -> f64 {
    let recency = match (candidate.parsed_ts, min_ts) {
        (Some(ts), Some(min)) if span_secs > 0.0 => {
            (i64_to_f64(ts.signed_duration_since(min).num_seconds()) / span_secs) * RECENCY_WEIGHT
        }
        _ => 0.0,
    };
    i64_to_f64(candidate.relevance) + recency
}

/// Orders keyword-query candidates by relevance blended with recency, newest
/// first on ties. Time-range-only queries skip this and stay chronological.
fn rank_candidates(candidates: &mut [ScoredCandidate]) {
    let (mut min_ts, mut max_ts): (Option<DateTime<FixedOffset>>, Option<DateTime<FixedOffset>>) =
        (None, None);
    for candidate in candidates.iter() {
        if let Some(ts) = candidate.parsed_ts {
            min_ts = Some(min_ts.map_or(ts, |m| m.min(ts)));
            max_ts = Some(max_ts.map_or(ts, |m| m.max(ts)));
        }
    }
    let span_secs = match (min_ts, max_ts) {
        (Some(min), Some(max)) => i64_to_f64(max.signed_duration_since(min).num_seconds().max(0)),
        _ => 0.0,
    };

    candidates.sort_by(|a, b| {
        combined_score(b, min_ts, span_secs)
            .partial_cmp(&combined_score(a, min_ts, span_secs))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.parsed_ts.cmp(&a.parsed_ts))
    });
}

pub fn handle_search_history(input: &Value, ctx: &dyn ToolContext) -> Result<Value, ToolError> {
    let character_data_dir = ctx.character_data_dir();
    if character_data_dir.is_empty() {
        return Err(ToolError::InvalidArgs(
            "conversation history is not configured".into(),
        ));
    }

    let (query, range) = filters_from(input)?;
    let model_filter = model_filter_from(input)?;
    if query.is_none() && range.is_empty() && model_filter.is_none() {
        return Err(ToolError::InvalidArgs(
            "provide query, start_time, end_time, model, or a combination".into(),
        ));
    }
    let matcher = query.as_deref().map(QueryMatcher::new);
    let max_results = max_results_from(input);
    let filters = SearchFilters {
        matcher: matcher.as_ref(),
        range: &range,
        model_filter: model_filter.as_deref(),
        excerpt_chars: excerpt_chars_from(input),
    };
    let character_dir = PathBuf::from(character_data_dir);

    let mut candidates: Vec<ScoredCandidate> = Vec::new();
    let mut searched_messages = 0_usize;
    let mut stats = SearchStats::default();

    // Scan the entire corpus so ranking sees every match and `searched_messages`
    // reports the true total examined (segments are oldest-first; active last).
    let segments = SegmentReader::load(&character_dir).map_err(|e| ToolError::Io(e.to_string()))?;
    for index in 0..segments.segment_count() {
        let messages = segments
            .read_segment(index)
            .map_err(|e| ToolError::Io(e.to_string()))?;
        searched_messages = searched_messages.saturating_add(messages.len());
        collect_matches(
            &mut candidates,
            &messages,
            &format!("segment:{index}"),
            &filters,
            &mut stats,
        );
    }

    let active_path = character_dir.join(shore_common::config::ACTIVE_JSONL_FILE);
    let active = MessageStore::load(active_path).map_err(|e| ToolError::Io(e.to_string()))?;
    searched_messages = searched_messages.saturating_add(active.message_count());
    collect_matches(
        &mut candidates,
        active.messages(),
        "active",
        &filters,
        &mut stats,
    );

    // Keyword queries rank by relevance blended with recency; time-range-only
    // queries are returned oldest-first. The stable sort keeps storage order on
    // ties and corrects cases where an alternative's timestamp diverges from its
    // parent message's position in the transcript.
    if matcher.is_some() {
        rank_candidates(&mut candidates);
    } else {
        candidates.sort_by_key(|candidate| candidate.parsed_ts);
    }
    candidates.truncate(max_results);

    let results: Vec<Value> = candidates.into_iter().map(|c| c.value).collect();
    let count = results.len();
    Ok(json!({
        "query": query,
        "time_range": {
            "start_time": range.start.map(|ts| ts.to_rfc3339()),
            "end_time": range.end.map(|ts| ts.to_rfc3339()),
            "inclusive": true,
        },
        "model_filter": model_filter,
        "results": results,
        "count": count,
        "searched_messages": searched_messages,
        "skipped_invalid_timestamps": stats.skipped_invalid_timestamps,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestToolContext;
    use shore_common::protocol::types::{ContentBlock, MessageAlternative};

    fn msg(id: &str, role: Role, content: &str) -> Message {
        Message {
            msg_id: id.to_owned(),
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
            timestamp: "2026-01-01T00:00:00Z".to_owned(),
        }
    }

    fn msg_at(id: &str, role: Role, content: &str, timestamp: &str) -> Message {
        let mut message = msg(id, role, content);
        message.timestamp = timestamp.to_owned();
        message
    }

    fn write_active(character_dir: &std::path::Path, messages: &[Message]) {
        let lines = messages
            .iter()
            .map(|message| message.serialize_for_storage().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(character_dir.join("active.jsonl"), format!("{lines}\n")).unwrap();
    }

    #[test]
    fn search_history_schema_exposes_optional_time_range() {
        let defs = tool_defs();
        let schema = &defs[0].parameters;
        assert!(schema["properties"].get("query").is_some());
        assert!(schema["properties"].get("start_time").is_some());
        assert!(schema["properties"].get("end_time").is_some());
        assert!(schema["required"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn search_history_finds_active_and_segment_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        let segments_dir = character_dir.join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();

        let old = msg("old", Role::User, "We talked about tea last winter.");
        let old_line = old.serialize_for_storage().unwrap();
        std::fs::write(segments_dir.join("0001.jsonl"), format!("{old_line}\n")).unwrap();
        std::fs::write(
            character_dir.join("compaction.json"),
            r#"{
              "segments": [{
                "file": "0001.jsonl",
                "message_count": 1,
                "compacted_at": "2026-01-01T00:00:00Z"
              }],
              "total_compacted_messages": 1
            }"#,
        )
        .unwrap();

        let active = msg("active", Role::Assistant, "Tea came up again today.");
        std::fs::write(
            character_dir.join("active.jsonl"),
            format!("{}\n", active.serialize_for_storage().unwrap()),
        )
        .unwrap();

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(&json!({"query": "tea"}), &ctx).unwrap();
        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["msg_id"], "old");
        assert_eq!(hits[1]["msg_id"], "active");
    }

    #[tokio::test]
    async fn search_history_finds_stored_alternatives() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();

        let mut active = msg("active", Role::Assistant, "Tea came up again today.");
        active.alt_index = Some(0);
        active.alt_count = Some(2);
        active.alternatives = vec![
            MessageAlternative {
                content: active.content.clone(),
                images: vec![],
                content_blocks: active.content_blocks.clone(),
                timestamp: active.timestamp.clone(),
                provider_key: None,
                model: None,
            },
            MessageAlternative {
                content: "Coffee came up in a regenerated reply.".to_owned(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "Coffee came up in a regenerated reply.".to_owned(),
                }],
                timestamp: "2026-01-01T00:01:00Z".to_owned(),
                provider_key: None,
                model: None,
            },
        ];
        std::fs::write(
            character_dir.join("active.jsonl"),
            format!("{}\n", active.serialize_for_storage().unwrap()),
        )
        .unwrap();

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(&json!({"query": "coffee"}), &ctx).unwrap();
        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["msg_id"], "active");
        assert_eq!(hits[0]["source"], "active:alt:1");
        assert_eq!(hits[0]["alternative_index"], 1);
    }

    #[tokio::test]
    async fn search_history_finds_messages_by_time_range_without_query() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        let segments_dir = character_dir.join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();

        let old = msg_at(
            "old",
            Role::User,
            "This is before the requested window.",
            "2026-05-13T08:59:59+10:00",
        );
        let segment_match = msg_at(
            "segment_match",
            Role::Assistant,
            "This compacted message is inside the window.",
            "2026-05-13T09:15:00+10:00",
        );
        let segment_lines = [old, segment_match]
            .iter()
            .map(|message| message.serialize_for_storage().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(
            segments_dir.join("0001.jsonl"),
            format!("{segment_lines}\n"),
        )
        .unwrap();
        std::fs::write(
            character_dir.join("compaction.json"),
            r#"{
              "segments": [{
                "file": "0001.jsonl",
                "message_count": 2,
                "compacted_at": "2026-05-13T10:00:00+10:00"
              }],
              "total_compacted_messages": 2
            }"#,
        )
        .unwrap();

        let active_match = msg_at(
            "active_match",
            Role::User,
            "This active message is also inside the window.",
            "2026-05-13T10:30:00+10:00",
        );
        let late = msg_at(
            "late",
            Role::Assistant,
            "This is after the requested window.",
            "2026-05-13T11:00:01+10:00",
        );
        write_active(character_dir, &[active_match, late]);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(
            &json!({
                "start_time": "2026-05-13T09:00:00+10:00",
                "end_time": "2026-05-13T10:59:59+10:00"
            }),
            &ctx,
        )
        .unwrap();

        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["msg_id"], "segment_match");
        assert_eq!(hits[1]["msg_id"], "active_match");
        assert_eq!(result["query"], Value::Null);
        assert_eq!(
            result["time_range"]["start_time"],
            "2026-05-13T09:00:00+10:00"
        );
        assert_eq!(result["time_range"]["inclusive"], true);
    }

    #[tokio::test]
    async fn search_history_combines_query_and_time_range() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        write_active(
            character_dir,
            &[
                msg_at(
                    "too_early",
                    Role::User,
                    "Tea was mentioned before breakfast.",
                    "2026-05-13T08:30:00+10:00",
                ),
                msg_at(
                    "match",
                    Role::Assistant,
                    "Tea came up during the requested hour.",
                    "2026-05-13T09:30:00+10:00",
                ),
                msg_at(
                    "wrong_query",
                    Role::User,
                    "Coffee came up during the requested hour.",
                    "2026-05-13T09:45:00+10:00",
                ),
            ],
        );

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(
            &json!({
                "query": "tea",
                "start_time": "2026-05-13T09:00:00+10:00",
                "end_time": "2026-05-13T10:00:00+10:00"
            }),
            &ctx,
        )
        .unwrap();

        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["msg_id"], "match");
    }

    #[tokio::test]
    async fn search_history_time_range_uses_stored_alternative_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();

        let mut active = msg_at(
            "active",
            Role::Assistant,
            "This selected reply is outside the requested window.",
            "2026-05-13T08:00:00+10:00",
        );
        active.alt_index = Some(0);
        active.alt_count = Some(2);
        active.alternatives = vec![
            MessageAlternative {
                content: active.content.clone(),
                images: vec![],
                content_blocks: active.content_blocks.clone(),
                timestamp: active.timestamp.clone(),
                provider_key: None,
                model: None,
            },
            MessageAlternative {
                content: "Tea appeared in a regenerated reply.".to_owned(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "Tea appeared in a regenerated reply.".to_owned(),
                }],
                timestamp: "2026-05-13T09:30:00+10:00".to_owned(),
                provider_key: None,
                model: None,
            },
        ];
        write_active(character_dir, &[active]);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(
            &json!({
                "query": "tea",
                "start_time": "2026-05-13T09:00:00+10:00",
                "end_time": "2026-05-13T10:00:00+10:00"
            }),
            &ctx,
        )
        .unwrap();

        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["source"], "active:alt:1");
        assert_eq!(hits[0]["timestamp"], "2026-05-13T09:30:00+10:00");
    }

    #[tokio::test]
    async fn search_history_time_range_only_sorts_by_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();

        // Message "first" (09:00) carries a regenerated alternative timestamped
        // LATER (11:00) than the following message "second" (10:00). In storage
        // order the alternative is emitted right after its parent, so without an
        // explicit sort the results would be 09:00, 11:00, 10:00.
        let mut first = msg_at(
            "first",
            Role::Assistant,
            "First message.",
            "2026-05-13T09:00:00+10:00",
        );
        first.alt_index = Some(0);
        first.alt_count = Some(2);
        first.alternatives = vec![
            MessageAlternative {
                content: first.content.clone(),
                images: vec![],
                content_blocks: first.content_blocks.clone(),
                timestamp: first.timestamp.clone(),
                provider_key: None,
                model: None,
            },
            MessageAlternative {
                content: "Regenerated reply.".to_owned(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "Regenerated reply.".to_owned(),
                }],
                timestamp: "2026-05-13T11:00:00+10:00".to_owned(),
                provider_key: None,
                model: None,
            },
        ];
        let second = msg_at(
            "second",
            Role::User,
            "Second message.",
            "2026-05-13T10:00:00+10:00",
        );
        write_active(character_dir, &[first, second]);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(
            &json!({
                "start_time": "2026-05-13T09:00:00+10:00",
                "end_time": "2026-05-13T11:00:00+10:00"
            }),
            &ctx,
        )
        .unwrap();

        let order: Vec<&str> = result["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["timestamp"].as_str().unwrap())
            .collect();
        assert_eq!(
            order,
            vec![
                "2026-05-13T09:00:00+10:00",
                "2026-05-13T10:00:00+10:00",
                "2026-05-13T11:00:00+10:00",
            ],
            "time-range-only results must be oldest-first across divergent alternative timestamps"
        );
    }

    #[tokio::test]
    async fn search_history_requires_query_or_time_range() {
        let ctx = TestToolContext::new().with_character_data_dir("/tmp");
        let result = handle_search_history(&json!({}), &ctx);
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
    }

    #[tokio::test]
    async fn search_history_surfaces_and_filters_by_model() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();

        let mut opus = msg_at(
            "opus",
            Role::Assistant,
            "Tea talk under opus.",
            "2026-01-01T00:00:00Z",
        );
        opus.model = Some("claude-opus-4-6".to_owned());
        let mut deepseek = msg_at(
            "deepseek",
            Role::Assistant,
            "Tea talk under deepseek.",
            "2026-01-02T00:00:00Z",
        );
        deepseek.model = Some("deepseek-v4-pro".to_owned());
        let unstamped = msg_at(
            "unstamped",
            Role::Assistant,
            "Tea talk before model tracking.",
            "2026-01-03T00:00:00Z",
        );
        write_active(character_dir, &[opus, deepseek, unstamped]);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());

        // Unfiltered: everything matches; model is surfaced (null when absent).
        let all = handle_search_history(&json!({"query": "tea"}), &ctx).unwrap();
        let hits = all["results"].as_array().unwrap();
        assert_eq!(hits.len(), 3);
        let by_id = |id: &str| {
            hits.iter()
                .find(|h| h["msg_id"] == id)
                .unwrap_or_else(|| panic!("missing {id}"))
        };
        assert_eq!(by_id("opus")["model"], "claude-opus-4-6");
        assert_eq!(by_id("deepseek")["model"], "deepseek-v4-pro");
        assert_eq!(by_id("unstamped")["model"], Value::Null);

        // Dot/dash-folded substring filter: 'opus-4.6' matches 'claude-opus-4-6'.
        // Unstamped messages never match an explicit filter.
        let filtered =
            handle_search_history(&json!({"query": "tea", "model": "opus-4.6"}), &ctx).unwrap();
        let filtered_hits = filtered["results"].as_array().unwrap();
        assert_eq!(filtered_hits.len(), 1);
        assert_eq!(filtered_hits[0]["msg_id"], "opus");

        // Model-only search is valid and returns chronological results.
        let model_only = handle_search_history(&json!({"model": "deepseek"}), &ctx).unwrap();
        let model_only_hits = model_only["results"].as_array().unwrap();
        assert_eq!(model_only_hits.len(), 1);
        assert_eq!(model_only_hits[0]["msg_id"], "deepseek");
    }

    #[tokio::test]
    async fn search_history_alternative_model_falls_back_to_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();

        let mut active = msg("active", Role::Assistant, "Tea came up again today.");
        active.model = Some("claude-opus-4-6".to_owned());
        active.alt_index = Some(0);
        active.alt_count = Some(2);
        active.alternatives = vec![
            MessageAlternative {
                content: active.content.clone(),
                images: vec![],
                content_blocks: active.content_blocks.clone(),
                timestamp: active.timestamp.clone(),
                provider_key: None,
                model: active.model.clone(),
            },
            // Legacy alternative: no model stamp of its own.
            MessageAlternative {
                content: "Coffee came up in a regenerated reply.".to_owned(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "Coffee came up in a regenerated reply.".to_owned(),
                }],
                timestamp: "2026-01-01T00:01:00Z".to_owned(),
                provider_key: None,
                model: None,
            },
        ];
        write_active(character_dir, &[active]);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(&json!({"query": "coffee"}), &ctx).unwrap();
        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["source"], "active:alt:1");
        assert_eq!(
            hits[0]["model"], "claude-opus-4-6",
            "legacy alternative should inherit the parent message's model"
        );
    }

    #[tokio::test]
    async fn search_history_respects_excerpt_chars() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        let long_text = format!("tea {}", "x".repeat(1200));
        write_active(character_dir, &[msg("long", Role::Assistant, &long_text)]);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());

        let default_run = handle_search_history(&json!({"query": "tea"}), &ctx).unwrap();
        let default_excerpt = default_run["results"][0]["excerpt"].as_str().unwrap();
        assert!(default_excerpt.chars().count() <= EXCERPT_CHARS + 3);

        let wide =
            handle_search_history(&json!({"query": "tea", "excerpt_chars": 2000}), &ctx).unwrap();
        let wide_excerpt = wide["results"][0]["excerpt"].as_str().unwrap();
        assert!(
            wide_excerpt.chars().count() > 1200,
            "excerpt_chars should widen the excerpt to cover the full message"
        );
        assert!(!wide_excerpt.ends_with("..."));
    }

    #[tokio::test]
    async fn minimum_excerpt_still_contains_deep_match() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        let deep_text = format!("{} tea and biscuits", "x".repeat(500));
        write_active(character_dir, &[msg("deep", Role::Assistant, &deep_text)]);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let narrow = handle_search_history(
            &json!({"query": "tea", "excerpt_chars": MIN_EXCERPT_CHARS}),
            &ctx,
        )
        .unwrap();
        let excerpt = narrow["results"][0]["excerpt"].as_str().unwrap();
        assert!(
            excerpt.contains("tea"),
            "minimum-width excerpt must include the matched term, got: {excerpt}"
        );
    }

    #[tokio::test]
    async fn search_history_rejects_invalid_time_range() {
        let ctx = TestToolContext::new().with_character_data_dir("/tmp");

        let invalid = handle_search_history(
            &json!({
                "start_time": "not-a-timestamp"
            }),
            &ctx,
        );
        assert!(matches!(invalid, Err(ToolError::InvalidArgs(_))));

        let reversed = handle_search_history(
            &json!({
                "start_time": "2026-05-13T10:00:00+10:00",
                "end_time": "2026-05-13T09:00:00+10:00"
            }),
            &ctx,
        );
        assert!(matches!(reversed, Err(ToolError::InvalidArgs(_))));
    }

    #[tokio::test]
    async fn search_history_searches_chat_text_only() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();

        // Assistant turn: visible text + private thinking + a tool result.
        let mut answer = msg_at("answer", Role::Assistant, "", "2026-01-01T00:00:00Z");
        answer.content_blocks = vec![
            ContentBlock::Text {
                text: "Here is the visible answer about apples.".into(),
            },
            ContentBlock::Thinking {
                thinking: "private pondering about bananas".into(),
                signature: None,
            },
            ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "tool output mentioning cherries".into(),
                is_error: false,
            },
        ];

        // Synthetic tool-result-only user turn (machine payload, not chat).
        let mut tool_turn = msg_at("tool_turn", Role::User, "", "2026-01-02T00:00:00Z");
        tool_turn.content_blocks = vec![ContentBlock::ToolResult {
            tool_use_id: "t2".into(),
            content: "durian appears only in a tool result".into(),
            is_error: false,
        }];

        write_active(character_dir, &[answer, tool_turn]);
        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());

        // Visible text matches.
        let hit = handle_search_history(&json!({"query": "apples"}), &ctx).unwrap();
        let hits = hit["results"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["msg_id"], "answer");

        // Terms that appear only inside thinking / tool results never match.
        for buried in ["bananas", "cherries", "durian"] {
            let miss = handle_search_history(&json!({"query": buried}), &ctx).unwrap();
            assert_eq!(
                miss["results"].as_array().unwrap().len(),
                0,
                "{buried:?} lives in thinking/tool output and must not match"
            );
        }

        // Time-range-only search excludes the tool-result-only turn entirely.
        let range = handle_search_history(
            &json!({
                "start_time": "2026-01-01T00:00:00Z",
                "end_time": "2026-01-03T00:00:00Z"
            }),
            &ctx,
        )
        .unwrap();
        let range_hits = range["results"].as_array().unwrap();
        assert_eq!(range_hits.len(), 1);
        assert_eq!(range_hits[0]["msg_id"], "answer");
    }

    #[tokio::test]
    async fn search_history_matches_multi_word_query_by_term() {
        // Regression: previously the whole query had to appear verbatim, so any
        // multi-word phrase returned nothing. Now terms match independently and
        // coverage drives rank — even though the lower-relevance hit is newer.
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        write_active(
            character_dir,
            &[
                msg_at(
                    "both",
                    Role::User,
                    "The cache and the daemon both misbehaved.",
                    "2026-01-01T00:00:00Z",
                ),
                msg_at(
                    "one",
                    Role::Assistant,
                    "Only the cache is mentioned here.",
                    "2026-02-01T00:00:00Z",
                ),
                msg_at(
                    "none",
                    Role::User,
                    "Nothing relevant in this line.",
                    "2026-02-15T00:00:00Z",
                ),
            ],
        );

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(&json!({"query": "cache daemon"}), &ctx).unwrap();
        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["msg_id"], "both");
        assert_eq!(hits[1]["msg_id"], "one");
    }

    #[tokio::test]
    async fn search_history_breaks_relevance_ties_by_recency() {
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        write_active(
            character_dir,
            &[
                msg_at(
                    "older",
                    Role::User,
                    "We hit a cache miss.",
                    "2026-01-01T00:00:00Z",
                ),
                msg_at(
                    "newer",
                    Role::Assistant,
                    "Another cache miss today.",
                    "2026-03-01T00:00:00Z",
                ),
            ],
        );

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result = handle_search_history(&json!({"query": "cache"}), &ctx).unwrap();
        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["msg_id"], "newer");
        assert_eq!(hits[1]["msg_id"], "older");
    }

    #[tokio::test]
    async fn search_history_reports_full_corpus_and_returns_recent_under_cap() {
        // Regression: the old early break filled the quota from the oldest
        // segments and stopped, so recent matches never surfaced and
        // `searched_messages` reflected only what was scanned before the cap.
        let tmp = tempfile::tempdir().unwrap();
        let character_dir = tmp.path();
        let many: Vec<Message> = (0..10)
            .map(|i| {
                msg_at(
                    &format!("m{i}"),
                    Role::User,
                    "cache discussion",
                    &format!("2026-01-{:02}T00:00:00Z", i + 1),
                )
            })
            .collect();
        write_active(character_dir, &many);

        let ctx = TestToolContext::new().with_character_data_dir(character_dir.to_str().unwrap());
        let result =
            handle_search_history(&json!({"query": "cache", "max_results": 3}), &ctx).unwrap();
        let hits = result["results"].as_array().unwrap();
        assert_eq!(hits.len(), 3);
        // Newest three despite the cap, and the full corpus is reported scanned.
        assert_eq!(hits[0]["msg_id"], "m9");
        assert_eq!(hits[1]["msg_id"], "m8");
        assert_eq!(hits[2]["msg_id"], "m7");
        assert_eq!(result["searched_messages"], 10);
    }
}
