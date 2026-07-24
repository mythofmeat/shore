//! Markdown memory store — filesystem-based memory entries.
//!
//! Replaces the opaque SQLite `entries` table with inspectable, git-diffable
//! markdown files in `characters/{character}/workspace/memory/`.
//!
//! Each file is pure markdown — no YAML frontmatter, no structured metadata.
//! The assistant decides the structure: headings, bullet points, nested folders,
//! filenames. Trust the model to organize.
//!
//! Directory layout:
//! ```text
//! characters/{character}/workspace/memory/
//!   README.md              # Character-curated index
//!   topics/
//!     gaming/
//!       doom.md
//!   people/
//!     ren.md
//! ```

use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, Utc};
use tokio::fs;
use tracing::info;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum MarkdownStoreError {
    #[error("io: {0}")]
    Io(String),
    #[error("path traversal: {0}")]
    PathTraversal(String),
    #[error("not found: {0}")]
    NotFound(String),
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/// A memory entry read from the markdown store.
#[derive(Debug, Clone)]
pub struct MarkdownEntry {
    /// Relative path within the memory directory (e.g., "topics/gaming/doom.md").
    pub path: String,
    /// Full markdown content.
    pub content: String,
    /// File size in bytes.
    pub size: u64,
    /// Last modified timestamp (RFC3339).
    pub modified_at: String,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct MarkdownMemoryStore {
    base_dir: PathBuf,
}

impl MarkdownMemoryStore {
    /// Open (or create) the markdown memory store for a character.
    pub async fn open<P: AsRef<Path>>(base_dir: P) -> Result<Self, MarkdownStoreError> {
        let base = base_dir.as_ref().to_path_buf();
        if !base.exists() {
            fs::create_dir_all(&base)
                .await
                .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        }
        let canonical = base
            .canonicalize()
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        Ok(Self {
            base_dir: canonical,
        })
    }

    /// Synchronous version of `open` for contexts where async is unavailable.
    pub fn open_sync<P: AsRef<Path>>(base_dir: P) -> Result<Self, MarkdownStoreError> {
        let base = base_dir.as_ref().to_path_buf();
        if !base.exists() {
            std::fs::create_dir_all(&base).map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        }
        let canonical = base
            .canonicalize()
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        Ok(Self {
            base_dir: canonical,
        })
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// List all `.md` files in the store, recursively.
    pub async fn list_all(&self) -> Result<Vec<MarkdownEntry>, MarkdownStoreError> {
        let mut entries = Vec::new();
        self.collect_md_files(&self.base_dir, &mut entries).await?;
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    /// Read a single entry by relative path.
    pub async fn read(&self, rel_path: &str) -> Result<MarkdownEntry, MarkdownStoreError> {
        let path = self.resolve_path(rel_path)?;
        if !path.exists() {
            return Err(MarkdownStoreError::NotFound(rel_path.to_owned()));
        }
        let content = fs::read_to_string(&path)
            .await
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        let meta = fs::metadata(&path)
            .await
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        let modified = meta
            .modified()
            .ok()
            .map(format_modified_at)
            .unwrap_or_default();
        Ok(MarkdownEntry {
            path: rel_path.to_owned(),
            content,
            size: meta.len(),
            modified_at: modified,
        })
    }

    /// Write (create or overwrite) an entry.
    pub async fn write(&self, rel_path: &str, content: &str) -> Result<(), MarkdownStoreError> {
        let path = self.resolve_path(rel_path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        }
        fs::write(&path, content)
            .await
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        info!(path = %rel_path, bytes = content.len(), "wrote memory entry");
        Ok(())
    }

    /// Delete an entry.
    pub async fn delete(&self, rel_path: &str) -> Result<(), MarkdownStoreError> {
        let path = self.resolve_path(rel_path)?;
        if !path.exists() {
            return Err(MarkdownStoreError::NotFound(rel_path.to_owned()));
        }
        fs::remove_file(&path)
            .await
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
        // Try to clean up empty parent directories.
        if let Some(parent) = path.parent() {
            if parent != self.base_dir {
                let _ignored = fs::remove_dir(parent).await;
            }
        }
        Ok(())
    }

    /// Ranked text search across all entries.
    ///
    /// Scores path/title/content matches using the full query and individual
    /// query tokens so markdown-only retrieval can stay usable without a shadow
    /// DB/vector layer.
    pub async fn search_text(&self, query: &str) -> Result<Vec<MarkdownEntry>, MarkdownStoreError> {
        let all = self.list_all().await?;
        let q = query.to_lowercase();
        let terms = tokenize_query(&q);
        let mut scored = Vec::new();
        for entry in all {
            let score = entry_search_score(&entry, &q, &terms);
            if score > 0 {
                scored.push((score, entry));
            }
        }
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
        let results = scored.into_iter().map(|(_, entry)| entry).collect();
        Ok(results)
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    async fn collect_md_files(
        &self,
        dir: &Path,
        entries: &mut Vec<MarkdownEntry>,
    ) -> Result<(), MarkdownStoreError> {
        let mut read_dir = fs::read_dir(dir)
            .await
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;

        while let Some(child) = read_dir
            .next_entry()
            .await
            .map_err(|e| MarkdownStoreError::Io(e.to_string()))?
        {
            let path = child.path();
            if is_internal_dream_path(&self.base_dir, &path) {
                continue;
            }
            let link_meta = fs::symlink_metadata(&path)
                .await
                .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
            if link_meta.file_type().is_symlink() {
                let canonical = path
                    .canonicalize()
                    .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
                if !canonical.starts_with(&self.base_dir) {
                    return Err(MarkdownStoreError::PathTraversal(format!(
                        "symlink escapes memory directory: {}",
                        path.display()
                    )));
                }
                if canonical.is_dir() {
                    continue;
                }
            }
            let meta = child
                .metadata()
                .await
                .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
            if meta.is_dir() {
                Box::pin(self.collect_md_files(&path, entries)).await?;
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                let rel = path
                    .strip_prefix(&self.base_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                let content = fs::read_to_string(&path)
                    .await
                    .map_err(|e| MarkdownStoreError::Io(e.to_string()))?;
                let modified = meta
                    .modified()
                    .ok()
                    .map(format_modified_at)
                    .unwrap_or_default();
                entries.push(MarkdownEntry {
                    path: rel,
                    content,
                    size: meta.len(),
                    modified_at: modified,
                });
            } else {
                // Non-markdown file: skip it.
            }
        }
        Ok(())
    }

    fn resolve_path(&self, rel_path: &str) -> Result<PathBuf, MarkdownStoreError> {
        let rel = rel_path.trim();
        if rel.is_empty() {
            return Err(MarkdownStoreError::PathTraversal("empty path".into()));
        }
        for component in Path::new(rel).components() {
            match component {
                std::path::Component::ParentDir => {
                    return Err(MarkdownStoreError::PathTraversal(
                        "path traversal (..) not allowed".into(),
                    ));
                }
                std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                    return Err(MarkdownStoreError::PathTraversal(
                        "absolute paths not allowed".into(),
                    ));
                }
                std::path::Component::CurDir | std::path::Component::Normal(_) => {}
            }
        }
        let resolved = self.base_dir.join(rel);
        self.ensure_resolved_path_inside(&resolved)?;
        Ok(resolved)
    }

    fn ensure_resolved_path_inside(&self, resolved: &Path) -> Result<(), MarkdownStoreError> {
        if let Ok(canonical) = resolved.canonicalize() {
            if !canonical.starts_with(&self.base_dir) {
                return Err(MarkdownStoreError::PathTraversal(
                    "resolved path escapes memory directory".into(),
                ));
            }
            return Ok(());
        }

        let mut ancestor = resolved;
        while let Some(parent) = ancestor.parent() {
            if let Ok(canonical_parent) = parent.canonicalize() {
                if !canonical_parent.starts_with(&self.base_dir) {
                    return Err(MarkdownStoreError::PathTraversal(
                        "resolved path escapes memory directory".into(),
                    ));
                }
                return Ok(());
            }
            ancestor = parent;
        }

        Ok(())
    }
}

fn is_internal_dream_path(base_dir: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(base_dir).unwrap_or(path);
    let mut components = rel.components();
    components
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .is_some_and(|name| {
            let lower = name.to_ascii_lowercase();
            matches!(
                lower.as_str(),
                ".dreams" | "dreaming" | "dreams.md" | "memory.md"
            )
        })
}

fn format_modified_at(time: std::time::SystemTime) -> String {
    let utc: DateTime<Utc> = time.into();
    utc.with_timezone(&Local).to_rfc3339()
}

fn tokenize_query(query: &str) -> Vec<&str> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|term| term.len() >= 2)
        .collect()
}

fn entry_search_score(entry: &MarkdownEntry, query: &str, terms: &[&str]) -> usize {
    let path = entry.path.to_lowercase();
    let content = entry.content.to_lowercase();
    let title = entry
        .content
        .lines()
        .find(|line| line.trim_start().starts_with('#'))
        .unwrap_or_default()
        .to_lowercase();

    let mut score: usize = 0;
    if path.contains(query) {
        score = score.saturating_add(50);
    }
    if title.contains(query) {
        score = score.saturating_add(40);
    }
    if content.contains(query) {
        score = score.saturating_add(30);
    }

    for term in terms {
        if path.contains(term) {
            score = score.saturating_add(12);
        }
        if title.contains(term) {
            score = score.saturating_add(10);
        }
        if content.contains(term) {
            score = score.saturating_add(4);
        }
    }

    score
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_creates_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();
        assert!(store.base_dir.exists());
    }

    #[tokio::test]
    async fn write_read_cycle() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();

        store
            .write("topics/gaming/doom.md", "# Doom\n\n- UV-Max speedrunner\n")
            .await
            .unwrap();

        let entry = store.read("topics/gaming/doom.md").await.unwrap();
        assert_eq!(entry.content, "# Doom\n\n- UV-Max speedrunner\n");
        assert_eq!(entry.path, "topics/gaming/doom.md");
    }

    #[tokio::test]
    async fn read_reports_real_modified_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();

        store.write("a.md", "A").await.unwrap();

        let path = tmp.path().join("memories/a.md");
        let metadata = std::fs::metadata(&path).unwrap();
        let expected = format_modified_at(metadata.modified().unwrap());

        let entry = store.read("a.md").await.unwrap();
        assert_eq!(entry.modified_at, expected);
    }

    #[tokio::test]
    async fn list_all_recursive() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();

        store.write("a.md", "A").await.unwrap();
        store.write("deep/b.md", "B").await.unwrap();

        let entries = store.list_all().await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "a.md");
        assert_eq!(entries[1].path, "deep/b.md");
    }

    #[tokio::test]
    async fn list_all_excludes_dreaming_internal_files() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();

        store.write("a.md", "A").await.unwrap();
        store.write("DREAMS.md", "review").await.unwrap();
        store.write("dreams.md", "lowercase review").await.unwrap();
        store.write("MEMORY.md", "index").await.unwrap();
        store
            .write(".dreams/candidates.md", "internal")
            .await
            .unwrap();
        store
            .write("dreaming/rem/today.md", "report")
            .await
            .unwrap();

        let entries = store.list_all().await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "a.md");

        let report_results = store.search_text("review internal report").await.unwrap();
        assert!(report_results.is_empty());

        let index_results = store.search_text("index").await.unwrap();
        assert!(index_results.is_empty());
    }

    #[tokio::test]
    async fn search_text_finds_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();

        store.write("a.md", "Ren likes chocolate").await.unwrap();
        store.write("b.md", "Alice prefers tea").await.unwrap();

        let results = store.search_text("chocolate").await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "a.md");
    }

    #[tokio::test]
    async fn delete_removes_file() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();

        store.write("temp.md", "temp").await.unwrap();
        store.delete("temp.md").await.unwrap();

        assert!(store.read("temp.md").await.is_err());
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memories"))
            .await
            .unwrap();

        assert!(store.read("../secret.md").await.is_err());
        assert!(store.write("../secret.md", "x").await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape_for_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let memory_dir = tmp.path().join("memories");
        let outside_dir = tmp.path().join("outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("secret.md"), "secret").unwrap();

        let store = MarkdownMemoryStore::open(&memory_dir).await.unwrap();
        std::os::unix::fs::symlink(outside_dir.join("secret.md"), memory_dir.join("secret.md"))
            .unwrap();

        assert!(matches!(
            store.read("secret.md").await,
            Err(MarkdownStoreError::PathTraversal(_))
        ));
        assert!(matches!(
            store.write("secret.md", "new secret").await,
            Err(MarkdownStoreError::PathTraversal(_))
        ));
        assert_eq!(
            std::fs::read_to_string(outside_dir.join("secret.md")).unwrap(),
            "secret"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape_for_new_file_under_linked_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let memory_dir = tmp.path().join("memories");
        let outside_dir = tmp.path().join("outside");
        std::fs::create_dir_all(&outside_dir).unwrap();

        let store = MarkdownMemoryStore::open(&memory_dir).await.unwrap();
        std::os::unix::fs::symlink(&outside_dir, memory_dir.join("linked")).unwrap();

        assert!(matches!(
            store.write("linked/new.md", "new secret").await,
            Err(MarkdownStoreError::PathTraversal(_))
        ));
        assert!(!outside_dir.join("new.md").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn list_all_rejects_symlinked_directory_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let memory_dir = tmp.path().join("memories");
        let outside_dir = tmp.path().join("outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("secret.md"), "secret").unwrap();

        let store = MarkdownMemoryStore::open(&memory_dir).await.unwrap();
        store.write("inside.md", "inside").await.unwrap();
        std::os::unix::fs::symlink(&outside_dir, memory_dir.join("linked")).unwrap();

        assert!(matches!(
            store.list_all().await,
            Err(MarkdownStoreError::PathTraversal(_))
        ));
    }
}
