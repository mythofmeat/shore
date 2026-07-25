use crate::include_prompt;

use super::types::CompactionError;
use tracing::debug;

// ---------------------------------------------------------------------------
// Default prompt templates
// ---------------------------------------------------------------------------

/// Default compaction system prompt template. In production, loaded from `compact_system.md`.
///
/// Placeholders:
/// - `{{char}}`, `{{user}}` — character and user names
///
/// Contains only stable instructions (no conversation or memory snapshot), so
/// it is cacheable across compaction calls for the same character.
pub const DEFAULT_COMPACT_SYSTEM: &str =
    include_prompt!("../../../prompts/memory/compaction/compact_system.md");

/// Default compaction final-message template. In production, loaded from `compact.md`.
///
/// Appended as the last user message after the structured conversation history.
///
/// Placeholders:
/// - `{{char}}`, `{{user}}` — character and user names
pub const DEFAULT_COMPACT_PROMPT: &str =
    include_prompt!("../../../prompts/memory/compaction/compact.md");

// ---------------------------------------------------------------------------
// XML parsing helpers
// ---------------------------------------------------------------------------

/// Extract content between `<tag>` and `</tag>` (first occurrence).
pub(super) fn extract_xml_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)?;
    let content_start = start.saturating_add(open.len());
    let end = text.get(content_start..).unwrap_or("").find(&close)?;
    let content = text
        .get(content_start..content_start.saturating_add(end))
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        None
    } else {
        Some(content.to_owned())
    }
}

/// A memory file operation extracted from the LLM compaction response.
#[derive(Debug, Clone)]
pub struct MemoryFileOp {
    pub path: String,
    pub content: String,
}

/// Parse raw LLM response into memory file operations.
///
/// Expected format: a `<memory>` block containing one or more
/// `<write path="...">` blocks. Legacy responses may include a `<recap>` block;
/// compaction ignores it because current compaction writes markdown files
/// directly, including workspace-root `MEMORY.md` when the model provides a
/// carry-forward throughline.
pub fn parse_compaction_response(raw: &str) -> Result<Vec<MemoryFileOp>, CompactionError> {
    debug!(response_len = raw.len(), "Parsing compaction LLM response");

    let memory_block = extract_xml_tag(raw, "memory").unwrap_or_default();
    let ops = extract_write_ops(&memory_block);

    debug!(ops = ops.len(), "Compaction response parsed");
    Ok(ops)
}

/// Extract <write path="...">...</write> blocks from a <memory> section.
#[expect(
    clippy::string_slice,
    reason = "byte offsets derive from find()/literal-len() on `text` itself, so every slice bound lands on a char boundary"
)]
fn extract_write_ops(text: &str) -> Vec<MemoryFileOp> {
    let mut ops = Vec::new();
    let mut search_from = 0;

    while let Some(start) = text[search_from..].find("<write ") {
        let abs_start = search_from.saturating_add(start);
        // Find path attribute
        let Some(path_offset) = text[abs_start..].find("path=\"") else {
            search_from = abs_start.saturating_add(1);
            continue;
        };
        let path_start = abs_start.saturating_add(path_offset).saturating_add(6);
        let Some(path_offset_end) = text[path_start..].find('"') else {
            search_from = abs_start.saturating_add(1);
            continue;
        };
        let path_end = path_start.saturating_add(path_offset_end);
        let path = text[path_start..path_end].trim().to_owned();

        // Find closing > of the opening tag
        let Some(content_offset) = text[abs_start..].find('>') else {
            search_from = abs_start.saturating_add(1);
            continue;
        };
        let content_start = abs_start.saturating_add(content_offset).saturating_add(1);

        // Find </write>
        let close = "</write>";
        let Some(content_offset_end) = text[content_start..].find(close) else {
            search_from = abs_start.saturating_add(1);
            continue;
        };
        let content_end = content_start.saturating_add(content_offset_end);

        let content = text[content_start..content_end].trim().to_owned();
        if !path.is_empty() {
            ops.push(MemoryFileOp { path, content });
        }
        search_from = content_end.saturating_add(close.len());
    }

    ops
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_memory_response() -> String {
        r#"<memory>
<write path="daily/2026-03-25.md">
# Conversation on 2026-03-25

- User discussed their day
- They mentioned having a busy morning
</write>

<write path="preferences/beverages.md">
# Beverage Preferences

- User prefers tea over coffee
- This is a stable preference
</write>
</memory>"#
            .to_owned()
    }

    #[test]
    fn test_extract_xml_tag() {
        let text = "before <recap>hello world</recap> after";
        assert_eq!(
            extract_xml_tag(text, "recap"),
            Some("hello world".to_owned())
        );
    }

    #[test]
    fn test_extract_xml_tag_not_found() {
        assert_eq!(extract_xml_tag("no tags here", "recap"), None);
    }

    #[test]
    fn test_extract_xml_tag_empty() {
        assert_eq!(extract_xml_tag("<recap></recap>", "recap"), None);
    }

    #[test]
    fn test_extract_xml_tag_with_whitespace() {
        let text = "<recap>\n  trimmed content  \n</recap>";
        assert_eq!(
            extract_xml_tag(text, "recap"),
            Some("trimmed content".to_owned())
        );
    }

    #[test]
    fn test_parse_compaction_response() {
        let raw = make_memory_response();
        let ops = parse_compaction_response(&raw).unwrap();

        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].path, "daily/2026-03-25.md");
        assert!(ops[0].content.contains("User discussed their day"));
        assert_eq!(ops[1].path, "preferences/beverages.md");
        assert!(ops[1].content.contains("User prefers tea"));
    }

    #[test]
    fn test_parse_empty_memory_block() {
        let raw = r"<memory></memory>";
        let ops = parse_compaction_response(raw).unwrap();
        assert!(ops.is_empty());
    }

    #[test]
    fn test_parse_legacy_recap_without_memory_block() {
        let raw = r"<recap>The conversation was about cats</recap>";
        let ops = parse_compaction_response(raw).unwrap();
        assert!(ops.is_empty());
    }

    #[test]
    fn test_parse_memory_without_legacy_recap() {
        let raw = r#"<memory>
<write path="test.md">
- Something happened
</write>
</memory>"#;
        let ops = parse_compaction_response(raw).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].path, "test.md");
    }

    #[test]
    fn test_extract_write_ops_with_nested_xml() {
        let text = r#"<write path="test.md">
# Test

- Line with <b>bold</b> text
</write>"#;
        let ops = extract_write_ops(text);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].path, "test.md");
        assert!(ops[0].content.contains("<b>bold</b>"));
    }

    #[test]
    fn test_extract_write_ops_multiple() {
        let text = r#"<write path="a.md">Content A</write>
<write path="b.md">Content B</write>"#;
        let ops = extract_write_ops(text);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].path, "a.md");
        assert_eq!(ops[0].content, "Content A");
        assert_eq!(ops[1].path, "b.md");
        assert_eq!(ops[1].content, "Content B");
    }

    #[test]
    fn test_extract_write_ops_malformed_missing_close() {
        let text = r#"<write path="a.md">Content A"#;
        let ops = extract_write_ops(text);
        assert!(ops.is_empty());
    }

    #[test]
    fn test_extract_write_ops_malformed_missing_path() {
        let text = r"<write>Content A</write>";
        let ops = extract_write_ops(text);
        assert!(ops.is_empty());
    }

    #[test]
    fn test_extract_write_ops_empty_content() {
        let text = r#"<write path="a.md"></write>"#;
        let ops = extract_write_ops(text);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].path, "a.md");
        assert_eq!(ops[0].content, "");
    }
}
