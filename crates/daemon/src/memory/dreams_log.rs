//! Dreams audit log.
//!
//! The dreams log records what each dreaming pass (and other memory-maintenance
//! events) inspected and changed. It lives in the character's data directory
//! at `data_dir/{character}/DREAMS.md` — outside the workspace so it never
//! bleeds into prompts or memory snapshots.

use std::cmp::Reverse;
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset};
use shore_common::config::character_data_dir;
use tokio::fs;

const DREAMS_FILE: &str = "DREAMS.md";
const DREAMS_HEADER: &str = "# Dreams\n";

/// Canonical path of the dreams log for a character.
pub fn dreams_log_path(data_dir: &Path, character: &str) -> PathBuf {
    character_data_dir(data_dir, character).join(DREAMS_FILE)
}

/// Append a timestamped audit entry to the dreams log.
///
/// Creates the parent directory and the log file if they do not yet exist.
pub async fn append_dream_entry(
    data_dir: &Path,
    character: &str,
    timestamp: DateTime<FixedOffset>,
    title: &str,
    body: &str,
) -> io::Result<()> {
    let path = dreams_log_path(data_dir, character);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let existing = match fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) if e.kind() == io::ErrorKind::NotFound => DREAMS_HEADER.to_owned(),
        Err(e) => return Err(e),
    };

    let mut updated = existing.trim_end().to_owned();
    if !updated.is_empty() {
        updated.push_str("\n\n");
    }
    let formatted_ts = timestamp.format("%Y-%m-%d %H:%M");
    let trimmed_body = body.trim();
    write!(updated, "## {formatted_ts} - {title}\n\n{trimmed_body}\n").map_err(io::Error::other)?;

    fs::write(&path, updated).await
}

/// Read the most recent N dream entries (newest first), or an empty list when
/// the log does not yet exist.
pub async fn recent_dream_entries(
    data_dir: &Path,
    character: &str,
    limit: usize,
) -> io::Result<Vec<String>> {
    let path = dreams_log_path(data_dir, character);
    let content = match fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };

    let mut sections = content
        .split("\n## ")
        .filter_map(|section| {
            let trimmed = section.trim();
            if trimmed.is_empty() || trimmed.starts_with("# Dreams") {
                None
            } else {
                Some(format!("## {trimmed}"))
            }
        })
        .collect::<Vec<_>>();
    sections.sort_by_key(|entry| Reverse(entry.clone()));
    sections.truncate(limit);
    Ok(sections)
}

/// Read the full dreams log, or `None` when it does not exist yet.
pub async fn read_dreams_log(data_dir: &Path, character: &str) -> io::Result<Option<String>> {
    let path = dreams_log_path(data_dir, character);
    match fs::read_to_string(&path).await {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    #[tokio::test]
    async fn append_then_read_full_log() {
        let tmp = tempfile::tempdir().unwrap();
        append_dream_entry(
            tmp.path(),
            "alice",
            ts("2026-04-22T10:00:00+00:00"),
            "first",
            "did a thing",
        )
        .await
        .unwrap();
        append_dream_entry(
            tmp.path(),
            "alice",
            ts("2026-04-23T11:00:00+00:00"),
            "second",
            "did another thing",
        )
        .await
        .unwrap();

        let full = read_dreams_log(tmp.path(), "alice")
            .await
            .unwrap()
            .expect("log written");
        assert!(full.contains("first"));
        assert!(full.contains("second"));
        assert!(full.starts_with("# Dreams"));
    }

    #[tokio::test]
    async fn recent_returns_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        for (when, title) in [
            ("2026-04-22T10:00:00+00:00", "alpha"),
            ("2026-04-24T10:00:00+00:00", "gamma"),
            ("2026-04-23T10:00:00+00:00", "beta"),
        ] {
            append_dream_entry(tmp.path(), "alice", ts(when), title, "x")
                .await
                .unwrap();
        }
        let recent = recent_dream_entries(tmp.path(), "alice", 2).await.unwrap();
        assert_eq!(recent.len(), 2);
        assert!(recent[0].contains("gamma"));
        assert!(recent[1].contains("beta"));
    }

    #[tokio::test]
    async fn missing_log_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let recent = recent_dream_entries(tmp.path(), "ghost", 5).await.unwrap();
        assert!(recent.is_empty());
        assert!(read_dreams_log(tmp.path(), "ghost")
            .await
            .unwrap()
            .is_none());
    }
}
