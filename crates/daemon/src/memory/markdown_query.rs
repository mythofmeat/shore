use crate::memory::markdown_store::{MarkdownEntry, MarkdownMemoryStore, MarkdownStoreError};

const MAX_DIRECT_HITS: usize = 10;

#[derive(Debug)]
pub struct MemoryStatus {
    pub total_files: usize,
    pub topic_files: usize,
    pub daily_files: usize,
    pub image_files: usize,
}

pub async fn memory_status(
    store: &MarkdownMemoryStore,
) -> Result<MemoryStatus, MarkdownStoreError> {
    let files = store.list_all().await?;
    let mut status = MemoryStatus {
        total_files: 0,
        topic_files: 0,
        daily_files: 0,
        image_files: 0,
    };

    for entry in files {
        status.total_files = status.total_files.saturating_add(1);
        if entry.path.starts_with("daily/") {
            status.daily_files = status.daily_files.saturating_add(1);
        } else if entry.path.starts_with("images/") {
            status.image_files = status.image_files.saturating_add(1);
        } else {
            status.topic_files = status.topic_files.saturating_add(1);
        }
    }

    Ok(status)
}

pub fn format_direct_response(query: &str, hits: &[MarkdownEntry]) -> String {
    if hits.is_empty() {
        return format!("No memory files matched '{query}'.");
    }

    let mut lines = vec![format!("Top memory matches for '{query}':")];
    for entry in hits.iter().take(MAX_DIRECT_HITS) {
        let excerpt = excerpt_for_query(&entry.content, query, 220);
        lines.push(format!("- {}\n  {}", entry.path, excerpt));
    }
    lines.join("\n")
}

pub fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

pub fn excerpt_for_query(text: &str, query: &str, limit: usize) -> String {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return excerpt(text, limit);
    }

    let terms = normalized_query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|term| term.len() >= 2)
        .collect::<Vec<_>>();
    let lines = text.lines().collect::<Vec<_>>();

    for (idx, raw_line) in lines.iter().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let lower = line.to_lowercase();
        let matched =
            lower.contains(&normalized_query) || terms.iter().any(|term| lower.contains(term));
        if !matched {
            continue;
        }

        let start = idx.saturating_sub(1);
        let end = idx.saturating_add(2).min(lines.len());
        let window = lines
            .get(start..end)
            .unwrap_or(&[])
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");

        if !window.is_empty() {
            return excerpt(&window, limit);
        }
    }

    excerpt(text, limit)
}

fn excerpt(text: &str, limit: usize) -> String {
    let normalized = text.lines().map(str::trim).collect::<Vec<_>>().join(" ");
    if normalized.chars().count() > limit {
        format!("{}...", truncate_chars(&normalized, limit))
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::excerpt_for_query;

    #[test]
    fn excerpt_for_query_prefers_matching_line_context() {
        let text = "\
Intro that should not be surfaced first.

## Preferences
Ren likes lapsang souchong tea after long walks.

Trailing detail.";

        let excerpt = excerpt_for_query(text, "lapsang souchong", 120);
        assert!(excerpt.contains("lapsang souchong tea"));
        assert!(!excerpt.starts_with("Intro that should not be surfaced first."));
    }
}
