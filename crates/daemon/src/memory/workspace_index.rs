//! Workspace-wide embedding index + hybrid search.
//!
//! Walks the same paths the lexical `search` tool walks (workspace root)
//! with identical security rules
//! (symlink skip, size cap, non-UTF8 skip), embeds every text file once,
//! and stores vectors in a JSON index under the Shore cache directory.
//!
//! Subsequent searches reuse cached vectors and only re-embed files whose
//! size, mtime, embedding model, or embedding character cap changed.
//!
//! Non-text and oversized files are recorded with `embedded: false` and a
//! skip reason so the walker doesn't churn on them every query.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use crate::llm::embed::Embedder;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use shore_common::config::app::{RetrievalBinaryMode, RetrievalConfig};
use tokio::sync::Mutex;
use tracing::warn;

const EMBED_BATCH_MAX_ITEMS: usize = 32;
const EMBED_BATCH_MAX_CHARS: usize = 96_000;
const INDEX_FILE: &str = "workspace_index.json";

/// Build the canonical cache path for a character's workspace embedding index:
/// `<cache_dir>/characters/<character>/workspace_index.json`.
pub fn index_path(cache_dir: &Path, character: &str) -> PathBuf {
    cache_dir
        .join("characters")
        .join(character)
        .join(INDEX_FILE)
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceIndexError {
    #[error("workspace not configured")]
    NotConfigured,
    #[error("embedder failed: {0}")]
    Embedder(String),
    #[error("embedding count mismatch: got {got}, expected {expected}")]
    EmbeddingCountMismatch { got: usize, expected: usize },
}

/// One file's place in the persisted index.
///
/// Freshness is decided by `(size, modified_at_secs, model_id,
/// max_embed_chars_per_file)`. The `hash` field is informational — older
/// index files used a SHA256 here; new entries store a `mtime:{secs}:{size}`
/// tag so the format stays backwards-compatible without paying the per-call
/// hash cost.
///
/// `embedded: false` entries record *why* the file was skipped so future
/// walks can short-circuit without re-reading the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IndexedEntry {
    pub hash: String,
    pub size: u64,
    pub modified_at_secs: i64,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_embed_chars_per_file: Option<usize>,
    pub embedded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct WorkspaceIndex {
    pub entries: BTreeMap<String, IndexedEntry>,
}

/// One file's contribution to a hybrid query result.
#[derive(Debug, Clone)]
pub struct ScoredFile {
    pub display_path: String,
    pub fs_path: PathBuf,
    pub content: Option<String>,
    pub semantic_score: Option<f32>,
    pub lexical_score: usize,
    pub combined_score: f32,
    pub embedded: bool,
    pub skip_reason: Option<String>,
}

/// Outcome of a hybrid query, including stats useful for telling the model
/// what was searched.
#[derive(Debug)]
pub struct HybridSearchResult {
    pub files: Vec<ScoredFile>,
    pub searched_files: usize,
    pub embedded_files: usize,
    pub skipped_binary_or_large: usize,
}

/// Search mode selecting how lexical and semantic signals are fused.
#[derive(Debug, Clone, Copy)]
pub enum HybridMode {
    /// 0.45 lexical + 0.55 cosine. Good default.
    Hybrid,
    /// Pure cosine similarity (lexical weight zero).
    Vector,
}

impl HybridMode {
    fn weights(self) -> (f32, f32) {
        match self {
            HybridMode::Hybrid => (0.45, 0.55),
            HybridMode::Vector => (0.0, 1.0),
        }
    }
}

/// Walk the workspace, refresh the embedding index, and return files
/// ranked by `combined_score`. Files with no signal at all are filtered.
///
/// Two concurrent calls on the same `index_path` (e.g. heartbeat tick + user
/// message) serialize through a per-path async mutex so the load → mutate →
/// save sequence is exclusive. Different characters (different paths) do
/// not block each other.
pub async fn hybrid_search(
    workspace_dir: &str,
    retrieval_config: &RetrievalConfig,
    query: &str,
    mode: HybridMode,
    embedder: &dyn Embedder,
    index_path: &Path,
    path_filter: Option<&str>,
) -> Result<HybridSearchResult, WorkspaceIndexError> {
    if workspace_dir.is_empty() {
        return Err(WorkspaceIndexError::NotConfigured);
    }
    let root = PathBuf::from(workspace_dir);
    if !root.exists() {
        return Ok(HybridSearchResult {
            files: vec![],
            searched_files: 0,
            embedded_files: 0,
            skipped_binary_or_large: 0,
        });
    }

    let lock = index_lock_for(index_path);
    let _guard = lock.lock().await;

    let mut index = load_index(index_path);
    let model_id = embedder.model_id().to_owned();

    let mut candidates = enumerate_files(workspace_dir, retrieval_config).await;

    let mut index_dirty = prune_and_scope(&mut index, &mut candidates, path_filter);

    let RefreshOutcome {
        stale,
        stale_docs,
        skipped_binary_or_large,
        dirty: refresh_dirty,
    } = refresh_index_entries(&mut candidates, &mut index, retrieval_config, &model_id).await;
    index_dirty = index_dirty || refresh_dirty;

    // Persist prune + skip-record progress before the embed call so a
    // transient embedder failure doesn't drop the work — the next call
    // would otherwise repeat the same prune and re-mark the same skips.
    if index_dirty {
        save_index(index_path, &index);
        index_dirty = false;
    }

    if !stale_docs.is_empty() {
        embed_stale_entries(
            embedder,
            &mut index,
            stale,
            stale_docs,
            &model_id,
            retrieval_config,
        )
        .await?;
        index_dirty = true;
    }

    if index_dirty {
        save_index(index_path, &index);
    }

    let query_vector = embed_query(embedder, query).await?;

    let (files, searched_files, embedded_files) =
        score_candidates(candidates, &index, &query_vector, mode, query);

    Ok(HybridSearchResult {
        files,
        searched_files,
        embedded_files,
        skipped_binary_or_large,
    })
}

/// Outputs of [`refresh_index_entries`]: stale entries needing re-embedding,
/// their embedding documents, the binary/oversize skip count, and whether the
/// index changed on disk.
struct RefreshOutcome {
    stale: Vec<(String, u64, i64)>,
    stale_docs: Vec<String>,
    skipped_binary_or_large: usize,
    dirty: bool,
}

/// Prune index entries whose files vanished or fell outside the walk, then
/// scope `candidates` to `path_filter`. Returns whether the index changed.
fn prune_and_scope(
    index: &mut WorkspaceIndex,
    candidates: &mut Vec<FileCandidate>,
    path_filter: Option<&str>,
) -> bool {
    let mut index_dirty = false;

    // Drop entries whose files vanished or now live outside the walk.
    // Persist this even when no embed work runs, so deletions don't linger
    // on disk indefinitely. Computed from the unscoped walk so a path-
    // scoped query doesn't prune entries outside its scope.
    let current: BTreeSet<String> = candidates.iter().map(|f| f.display_path.clone()).collect();
    let pre_prune = index.entries.len();
    index.entries.retain(|p, _| current.contains(p));
    if index.entries.len() != pre_prune {
        index_dirty = true;
    }

    // Scope the walk to the requested subtree. Embeddings stay cached
    // workspace-wide; we just refresh + score within scope.
    let scope_prefix = path_filter
        .map(|p| p.trim_end_matches('/'))
        .filter(|p| !p.is_empty());
    if let Some(prefix) = scope_prefix {
        let with_slash = format!("{prefix}/");
        candidates.retain(|f| f.display_path == prefix || f.display_path.starts_with(&with_slash));
    }

    index_dirty
}

/// Refresh per-file content and identify entries that need a fresh embedding.
///
/// Freshness is `(size, mtime, model_id, max_embed_chars_per_file)` only —
/// no SHA256. The narrow miss case is editors that preserve mtime on a
/// content change; agent edits via `write` / `edit` always bump mtime so
/// this is acceptable and self-corrects on any later real edit.
///
/// `stale` captures `(path, size, mtime)` per file that needs a fresh
/// embedding so the writeback after `embedder.embed(...)` doesn't have
/// to re-find each candidate by path.
async fn refresh_index_entries(
    candidates: &mut [FileCandidate],
    index: &mut WorkspaceIndex,
    retrieval_config: &RetrievalConfig,
    model_id: &str,
) -> RefreshOutcome {
    let mut stale: Vec<(String, u64, i64)> = Vec::new();
    let mut stale_docs: Vec<String> = Vec::new();
    let mut skipped_binary_or_large = 0_usize;
    let mut dirty = false;

    for file in candidates.iter_mut() {
        if file.skip_reason.as_deref() == Some("oversize") {
            skipped_binary_or_large = skipped_binary_or_large.saturating_add(1);
            let _ignored = index.entries.insert(
                file.display_path.clone(),
                IndexedEntry {
                    hash: skip_tag(file.size, file.modified_at_secs),
                    size: file.size,
                    modified_at_secs: file.modified_at_secs,
                    model_id: model_id.to_owned(),
                    max_embed_chars_per_file: Some(retrieval_config.max_embed_chars_per_file),
                    embedded: false,
                    reason: Some("oversize".into()),
                    embedding: Vec::new(),
                },
            );
            dirty = true;
            continue;
        }

        let fresh = index.entries.get(&file.display_path).is_some_and(|e| {
            e.embedded
                && e.size == file.size
                && e.modified_at_secs == file.modified_at_secs
                && e.model_id == model_id
                && e.max_embed_chars_per_file == Some(retrieval_config.max_embed_chars_per_file)
        });

        let Ok(bytes) = tokio::fs::read(&file.fs_path).await else {
            file.skip_reason = Some("read failed".into());
            if index.entries.remove(&file.display_path).is_some() {
                dirty = true;
            }
            continue;
        };
        if let Ok(text) = String::from_utf8(bytes) {
            if !fresh {
                stale.push((file.display_path.clone(), file.size, file.modified_at_secs));
                stale_docs.push(document_for_embedding(
                    &file.display_path,
                    &text,
                    retrieval_config.max_embed_chars_per_file,
                ));
            }
            file.content = Some(text);
        } else {
            skipped_binary_or_large = skipped_binary_or_large.saturating_add(1);
            let reason = match retrieval_config.binary {
                RetrievalBinaryMode::Skip => "non-utf8",
                RetrievalBinaryMode::Metadata => "binary-metadata-only",
                RetrievalBinaryMode::TryEmbed => "binary-embedding-unsupported",
            };
            file.skip_reason = Some(reason.into());
            let _ignored = index.entries.insert(
                file.display_path.clone(),
                IndexedEntry {
                    hash: skip_tag(file.size, file.modified_at_secs),
                    size: file.size,
                    modified_at_secs: file.modified_at_secs,
                    model_id: model_id.to_owned(),
                    max_embed_chars_per_file: Some(retrieval_config.max_embed_chars_per_file),
                    embedded: false,
                    reason: Some(reason.into()),
                    embedding: Vec::new(),
                },
            );
            dirty = true;
        }
    }

    RefreshOutcome {
        stale,
        stale_docs,
        skipped_binary_or_large,
        dirty,
    }
}

/// Embed the stale documents and write the fresh vectors back into the index.
async fn embed_stale_entries(
    embedder: &dyn Embedder,
    index: &mut WorkspaceIndex,
    stale: Vec<(String, u64, i64)>,
    stale_docs: Vec<String>,
    model_id: &str,
    retrieval_config: &RetrievalConfig,
) -> Result<(), WorkspaceIndexError> {
    let vectors = embed_documents(embedder, &stale_docs).await?;
    if vectors.len() != stale.len() {
        return Err(WorkspaceIndexError::EmbeddingCountMismatch {
            got: vectors.len(),
            expected: stale.len(),
        });
    }
    for ((path, size, mtime), embedding) in stale.into_iter().zip(vectors) {
        let _ignored = index.entries.insert(
            path,
            IndexedEntry {
                hash: skip_tag(size, mtime),
                size,
                modified_at_secs: mtime,
                model_id: model_id.to_owned(),
                max_embed_chars_per_file: Some(retrieval_config.max_embed_chars_per_file),
                embedded: true,
                reason: None,
                embedding,
            },
        );
    }
    Ok(())
}

/// Embed the query string and return its single vector.
async fn embed_query(
    embedder: &dyn Embedder,
    query: &str,
) -> Result<Vec<f32>, WorkspaceIndexError> {
    embedder
        .embed(&[query])
        .await
        .map_err(|e| WorkspaceIndexError::Embedder(e.to_string()))?
        .into_iter()
        .next()
        .ok_or_else(|| {
            WorkspaceIndexError::Embedder("embedding response did not include query vector".into())
        })
}

/// Score candidates by blended lexical + semantic relevance, retain non-zero
/// matches, and sort best-first. Returns `(files, searched_files,
/// embedded_files)`.
#[expect(
    clippy::float_arithmetic,
    reason = "hybrid workspace search blends lexical and semantic f32 relevance weights"
)]
fn score_candidates(
    candidates: Vec<FileCandidate>,
    index: &WorkspaceIndex,
    query_vector: &[f32],
    mode: HybridMode,
    query: &str,
) -> (Vec<ScoredFile>, usize, usize) {
    let q_lower = query.to_lowercase();
    let terms = tokenize_query(&q_lower);

    let mut scored: Vec<ScoredFile> = candidates
        .into_iter()
        .map(|file| {
            let lexical = file.content.as_deref().map_or(0, |c| {
                lexical_score(&file.display_path, c, &q_lower, &terms)
            });
            let entry = index.entries.get(&file.display_path);
            let semantic = entry
                .filter(|e| e.embedded)
                .map(|e| cosine_similarity(query_vector, &e.embedding));
            let has_embedding_entry = entry.is_some_and(|e| e.embedded);
            ScoredFile {
                display_path: file.display_path,
                fs_path: file.fs_path,
                content: file.content,
                lexical_score: lexical,
                semantic_score: semantic,
                combined_score: 0.0,
                embedded: has_embedding_entry,
                skip_reason: file.skip_reason,
            }
        })
        .collect();

    let max_lex_count = scored
        .iter()
        .map(|f| f.lexical_score)
        .max()
        .unwrap_or(1)
        .max(1);
    let max_lex = crate::convert::usize_to_f32(max_lex_count);
    let embedded_files = scored.iter().filter(|f| f.semantic_score.is_some()).count();

    let (lw, sw) = mode.weights();
    for f in &mut scored {
        let lex_norm = crate::convert::usize_to_f32(f.lexical_score) / max_lex;
        let sem_norm = f.semantic_score.unwrap_or(0.0).max(0.0);
        f.combined_score = lex_norm * lw + sem_norm * sw;
    }

    let searched_files = scored.len();
    scored.retain(|f| f.combined_score > 0.0);
    scored.sort_by(|a, b| {
        b.combined_score
            .partial_cmp(&a.combined_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.display_path.cmp(&b.display_path))
    });

    (scored, searched_files, embedded_files)
}

#[derive(Debug, Clone)]
struct FileCandidate {
    display_path: String,
    fs_path: PathBuf,
    size: u64,
    modified_at_secs: i64,
    content: Option<String>,
    skip_reason: Option<String>,
}

async fn enumerate_files(
    workspace_dir: &str,
    retrieval_config: &RetrievalConfig,
) -> Vec<FileCandidate> {
    let mut pending = vec![PathBuf::from(workspace_dir)];
    let mut out: Vec<FileCandidate> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut cap_hit: Option<&'static str> = None;

    while let Some(path) = pending.pop() {
        if out.len() >= retrieval_config.max_indexed_files {
            let _ignored = cap_hit.get_or_insert("file count");
            break;
        }
        if total_bytes >= retrieval_config.max_total_indexed_bytes {
            let _ignored = cap_hit.get_or_insert("byte total");
            break;
        }

        let Ok(meta) = tokio::fs::symlink_metadata(&path).await else {
            continue;
        };

        if meta.file_type().is_symlink() {
            continue;
        }

        // The workspace carries a git history of memory changes; the git store
        // is machine state, not indexable memory. Skip `.git` whether it is a
        // directory or a `.git` *file* (linked worktrees expose it as a file).
        // Keeps .git churn from eating the file/byte caps and from leaking the
        // worktree `gitdir:` path into the index.
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }

        if meta.is_dir() {
            let Ok(mut read_dir) = tokio::fs::read_dir(&path).await else {
                continue;
            };
            while let Ok(Some(entry)) = read_dir.next_entry().await {
                pending.push(entry.path());
            }
            continue;
        }

        if !meta.is_file() {
            continue;
        }

        let display_path = display_path_for(workspace_dir, &path);
        let size = meta.len();
        let modified_at_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX));

        let skip_reason = if size > retrieval_config.max_file_bytes {
            Some("oversize".to_owned())
        } else {
            None
        };

        // Only count files we'll actually try to ingest toward the byte cap;
        // an oversize binary is recorded but not read or embedded, so its
        // size shouldn't short-circuit the rest of the walk.
        if skip_reason.is_none() {
            total_bytes = total_bytes.saturating_add(size);
        }
        out.push(FileCandidate {
            display_path,
            fs_path: path,
            size,
            modified_at_secs,
            content: None,
            skip_reason,
        });
    }

    if let Some(cap) = cap_hit {
        warn!(
            workspace_dir,
            cap,
            files = out.len(),
            total_bytes,
            "workspace index walk hit cap; remaining files were not indexed"
        );
    }

    out
}

fn display_path_for(workspace_dir: &str, path: &Path) -> String {
    let workspace_root = Path::new(workspace_dir);
    if let Ok(rel) = path.strip_prefix(workspace_root) {
        return rel.to_string_lossy().replace('\\', "/");
    }
    path.to_string_lossy().replace('\\', "/")
}

fn lexical_score(path: &str, content: &str, q_lower: &str, terms: &[&str]) -> usize {
    let path_lower = path.to_lowercase();
    let content_lower = content.to_lowercase();
    let title_lower = content
        .lines()
        .find(|line| line.trim_start().starts_with('#'))
        .unwrap_or_default()
        .to_lowercase();

    let mut score: usize = 0;
    if path_lower.contains(q_lower) {
        score = score.saturating_add(50);
    }
    if title_lower.contains(q_lower) {
        score = score.saturating_add(40);
    }
    if content_lower.contains(q_lower) {
        score = score.saturating_add(30);
    }
    for term in terms {
        if path_lower.contains(term) {
            score = score.saturating_add(12);
        }
        if title_lower.contains(term) {
            score = score.saturating_add(10);
        }
        if content_lower.contains(term) {
            score = score.saturating_add(4);
        }
    }
    score
}

fn tokenize_query(query: &str) -> Vec<&str> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|t| t.len() >= 2)
        .collect()
}

fn document_for_embedding(path: &str, content: &str, max_embed_chars_per_file: usize) -> String {
    let trimmed: String = content.chars().take(max_embed_chars_per_file).collect();
    format!("path: {path}\n\n{trimmed}")
}

async fn embed_documents(
    embedder: &dyn Embedder,
    docs: &[String],
) -> Result<Vec<Vec<f32>>, WorkspaceIndexError> {
    let mut vectors = Vec::with_capacity(docs.len());
    let mut start = 0_usize;

    while start < docs.len() {
        let mut end = start;
        let mut batch_chars = 0_usize;

        while end < docs.len() && end.saturating_sub(start) < EMBED_BATCH_MAX_ITEMS {
            let Some(doc) = docs.get(end) else {
                break;
            };
            let doc_chars = doc.chars().count();
            if end > start && batch_chars.saturating_add(doc_chars) > EMBED_BATCH_MAX_CHARS {
                break;
            }
            batch_chars = batch_chars.saturating_add(doc_chars);
            end = end.saturating_add(1);
        }

        if end == start {
            end = end.saturating_add(1);
        }

        let inputs: Vec<&str> = docs
            .get(start..end)
            .unwrap_or(&[])
            .iter()
            .map(String::as_str)
            .collect();
        let batch_vectors = embedder
            .embed(&inputs)
            .await
            .map_err(|e| WorkspaceIndexError::Embedder(e.to_string()))?;
        if batch_vectors.len() != inputs.len() {
            return Err(WorkspaceIndexError::EmbeddingCountMismatch {
                got: batch_vectors.len(),
                expected: inputs.len(),
            });
        }
        vectors.extend(batch_vectors);
        start = end;
    }

    Ok(vectors)
}

/// Tag stored in the persisted `hash` field. We no longer use it for
/// freshness — that's `(size, mtime, model_id, max_embed_chars_per_file)` —
/// but the field stays so older index files round-trip cleanly on read.
fn skip_tag(size: u64, mtime_secs: i64) -> String {
    format!("mtime:{mtime_secs}:{size}")
}

/// Per-`index_path` mutex registry. Two concurrent searches against the
/// same character's index serialize through this; different characters
/// hold different mutexes.
fn index_lock_for(index_path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<DashMap<PathBuf, Arc<Mutex<()>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(DashMap::new);
    map.entry(index_path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[expect(
    clippy::float_arithmetic,
    reason = "cosine similarity is vector dot-product and norm math over f32 embeddings"
)]
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn load_index(path: &Path) -> WorkspaceIndex {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_index(path: &Path, index: &WorkspaceIndex) {
    let bytes = match serde_json::to_vec_pretty(index) {
        Ok(b) => b,
        Err(e) => {
            warn!(error = %e, path = ?path, "failed to serialize workspace index");
            return;
        }
    };
    if let Err(e) = crate::engine::atomic::atomic_write(path, &bytes) {
        warn!(error = %e, path = ?path, "failed to persist workspace index");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use crate::llm::LlmError;
    use async_trait::async_trait;
    use tempfile::TempDir;
    use tokio::fs;

    use super::*;

    /// Topic-keyword embedder for deterministic testing.
    ///
    /// Each "topic" gets a one-hot dimension in the output vector. Inputs that
    /// mention the same topic produce vectors that point in the same direction.
    /// `call_count` records how many `embed` calls were made — used to assert
    /// incremental reindex behavior.
    struct TopicEmbedder {
        topics: &'static [&'static str],
        call_count: Arc<AtomicUsize>,
        input_count: Arc<AtomicUsize>,
    }

    impl TopicEmbedder {
        fn new(topics: &'static [&'static str]) -> Self {
            Self {
                topics,
                call_count: Arc::new(AtomicUsize::new(0)),
                input_count: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn vector_for(&self, text: &str) -> Vec<f32> {
            let lower = text.to_lowercase();
            let mut v = vec![0.0_f32; self.topics.len()];
            for (i, topic) in self.topics.iter().enumerate() {
                if lower.contains(topic) {
                    v[i] = 1.0;
                }
            }
            v
        }
    }

    #[async_trait]
    impl Embedder for TopicEmbedder {
        async fn embed(&self, inputs: &[&str]) -> Result<Vec<Vec<f32>>, LlmError> {
            let _ignored = self.call_count.fetch_add(1, Ordering::SeqCst);
            _ = self.input_count.fetch_add(inputs.len(), Ordering::SeqCst);
            Ok(inputs.iter().map(|s| self.vector_for(s)).collect())
        }
        fn model_id(&self) -> &'static str {
            "topic-test"
        }
        fn dimensions(&self) -> Option<usize> {
            Some(self.topics.len())
        }
    }

    #[test]
    fn cosine_handles_zero_vectors() {
        assert!(cosine_similarity(&[0.0, 0.0], &[1.0, 0.0]).abs() <= f32::EPSILON);
    }

    #[test]
    fn cosine_handles_mismatched_dims() {
        assert!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0, 0.0]).abs() <= f32::EPSILON);
    }

    #[test]
    fn lexical_score_rewards_path_and_title() {
        let path = "people/ren.md";
        let content = "# Ren\n\nLikes tea";
        let q = "ren";
        let s = lexical_score(path, content, q, &["ren"]);
        assert!(s >= 50 + 40);
    }

    async fn write_file(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.unwrap();
        }
        fs::write(path, body).await.unwrap();
    }

    fn setup() -> (TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let idx = tmp.path().join("data/workspace_index.json");
        (tmp, ws, idx)
    }

    #[tokio::test]
    async fn hybrid_promotes_semantic_only_match() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        // a.md is about tea + garden. b.md is unrelated. The query mentions
        // tea + garden but uses none of those words verbatim — so semantic
        // is the only signal that distinguishes them.
        write_file(&ws, "a.md", "# Notes\n\nThe garden is full of tea plants.").await;
        write_file(&ws, "b.md", "# Other\n\nThe accountant filed taxes.").await;

        let embedder = TopicEmbedder::new(&["tea", "garden", "tax"]);
        let result = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "growing tea in the garden",
            HybridMode::Vector,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.files[0].display_path, "a.md");
        assert!(result.files[0].semantic_score.unwrap_or(0.0) > 0.0);
    }

    #[tokio::test]
    async fn hybrid_falls_back_to_lexical_when_only_lexical_signal() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        // Neither file contains the embedder's topic words, but a.md contains
        // the literal query string in its content.
        write_file(&ws, "a.md", "# A\n\nLook for needle in this haystack").await;
        write_file(&ws, "b.md", "# B\n\nUnrelated content").await;

        let embedder = TopicEmbedder::new(&["completely-unrelated-topic"]);
        let result = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "needle",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.files[0].display_path, "a.md");
        assert!(result.files[0].lexical_score > 0);
    }

    #[tokio::test]
    async fn incremental_reindex_only_embeds_changed_files() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "a.md", "tea in the garden").await;
        write_file(&ws, "b.md", "rust is fun").await;

        let embedder = TopicEmbedder::new(&["tea", "rust"]);
        let _ignored = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        // Two embed calls so far: one for the docs (batch of 2), one for the query.
        let after_first = embedder.call_count.load(Ordering::SeqCst);
        let inputs_first = embedder.input_count.load(Ordering::SeqCst);
        assert_eq!(after_first, 2);
        assert_eq!(inputs_first, 3); // 2 docs + 1 query

        // Modify only b.md.
        write_file(&ws, "b.md", "rust and tokio are fun").await;
        _ = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        let inputs_total = embedder.input_count.load(Ordering::SeqCst);
        // Second call should embed only the changed b.md (1 doc) + 1 query.
        assert_eq!(inputs_total - inputs_first, 2);
    }

    #[tokio::test]
    async fn embed_char_cap_change_reindexes_unchanged_files() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(
            &ws,
            "a.md",
            "tea appears early, while rust appears after the short cap",
        )
        .await;

        let embedder = TopicEmbedder::new(&["tea", "rust"]);
        let mut retrieval_config = RetrievalConfig {
            max_embed_chars_per_file: 5,
            ..RetrievalConfig::default()
        };
        let _ignored = hybrid_search(
            &ws_str,
            &retrieval_config,
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        let inputs_first = embedder.input_count.load(Ordering::SeqCst);
        assert_eq!(inputs_first, 2);

        retrieval_config.max_embed_chars_per_file = 100;
        _ = hybrid_search(
            &ws_str,
            &retrieval_config,
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        let inputs_total = embedder.input_count.load(Ordering::SeqCst);
        assert_eq!(inputs_total - inputs_first, 2);

        let raw = std::fs::read_to_string(&idx).expect("index persisted");
        let parsed: WorkspaceIndex = serde_json::from_str(&raw).expect("valid json");
        let entry = parsed.entries.get("a.md").expect("a.md tracked in index");
        assert_eq!(entry.max_embed_chars_per_file, Some(100));
    }

    #[tokio::test]
    async fn stale_documents_are_embedded_in_bounded_batches() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        for i in 0..(EMBED_BATCH_MAX_ITEMS + 3) {
            write_file(&ws, &format!("notes/{i}.md"), "tea in the garden").await;
        }

        let embedder = TopicEmbedder::new(&["tea"]);
        let _ignored = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();

        // Two document batches plus one query embedding.
        assert_eq!(embedder.call_count.load(Ordering::SeqCst), 3);
        assert_eq!(
            embedder.input_count.load(Ordering::SeqCst),
            EMBED_BATCH_MAX_ITEMS + 4
        );
    }

    #[tokio::test]
    async fn non_utf8_files_recorded_as_skipped_no_churn() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "good.md", "tea time").await;
        // Write raw non-UTF8 bytes.
        fs::create_dir_all(&ws).await.unwrap();
        fs::write(ws.join("blob.bin"), &[0xFF, 0xFE, 0x00, 0x80])
            .await
            .unwrap();

        let embedder = TopicEmbedder::new(&["tea"]);
        let _ignored = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        let inputs_first = embedder.input_count.load(Ordering::SeqCst);
        // 1 text doc + 1 query embedding (binary file is skipped).
        assert_eq!(inputs_first, 2);

        // Re-run; the binary file should not trigger another embedding.
        _ = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        let inputs_total = embedder.input_count.load(Ordering::SeqCst);
        // Just one more query embedding; no doc re-embedding.
        assert_eq!(inputs_total - inputs_first, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_pointing_outside_are_not_embedded() {
        let (g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "in.md", "tea time").await;
        let outside_dir = g.path().join("outside");
        fs::create_dir_all(&outside_dir).await.unwrap();
        fs::write(outside_dir.join("secret.md"), "secret_token_xyzzy")
            .await
            .unwrap();
        std::os::unix::fs::symlink(outside_dir.join("secret.md"), ws.join("link_to_secret.md"))
            .unwrap();

        let embedder = TopicEmbedder::new(&["xyzzy"]);
        let result = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "xyzzy",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        // The symlink target should not appear in results.
        for f in &result.files {
            assert_ne!(f.display_path, "link_to_secret.md");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_file_drops_stale_embedding() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "secret.md", "secret_token_xyzzy").await;

        let embedder = TopicEmbedder::new(&["xyzzy"]);
        let result = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "xyzzy",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        // First search indexes the file and finds it.
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].display_path, "secret.md");

        // Make the file unreadable.
        let perms = std::fs::Permissions::from_mode(0o000);
        fs::set_permissions(ws.join("secret.md"), perms)
            .await
            .unwrap();

        // Run again; the stale embedding must be dropped so the file doesn't appear.
        let rerun = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "xyzzy",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        for f in &rerun.files {
            assert_ne!(f.display_path, "secret.md");
        }
    }

    #[tokio::test]
    async fn oversize_file_recorded_as_skipped_no_churn() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "small.md", "tea time").await;
        // Just over the 2 MiB cap.
        fs::create_dir_all(&ws).await.unwrap();
        let big_len = crate::convert::u64_to_usize(RetrievalConfig::default().max_file_bytes + 1);
        let big = vec![b'a'; big_len];
        fs::write(ws.join("huge.md"), &big).await.unwrap();

        let embedder = TopicEmbedder::new(&["tea"]);
        let _ignored = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        let inputs_first = embedder.input_count.load(Ordering::SeqCst);
        // 1 text doc + 1 query embedding; the oversize file is skipped.
        assert_eq!(inputs_first, 2);

        // The on-disk index should record huge.md as skipped with an
        // "oversize" reason so the next call doesn't re-read it.
        let raw = std::fs::read_to_string(&idx).expect("index persisted");
        let parsed: WorkspaceIndex = serde_json::from_str(&raw).expect("valid json");
        let entry = parsed
            .entries
            .get("huge.md")
            .expect("huge.md tracked in index");
        assert!(!entry.embedded);
        assert_eq!(entry.reason.as_deref(), Some("oversize"));

        // Second call: only the query should embed.
        _ = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();
        let inputs_total = embedder.input_count.load(Ordering::SeqCst);
        assert_eq!(inputs_total - inputs_first, 1);
    }

    #[tokio::test]
    async fn corrupt_index_recovers() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "a.md", "tea time").await;

        // Pre-write garbage at the index path. load_index should fall back
        // to a fresh empty index without panicking.
        if let Some(parent) = idx.parent() {
            fs::create_dir_all(parent).await.unwrap();
        }
        fs::write(&idx, b"not json at all { [ }").await.unwrap();

        let embedder = TopicEmbedder::new(&["tea"]);
        let result = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .expect("hybrid search recovers from corrupt index");
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].display_path, "a.md");

        // The index file should now be valid JSON again.
        let raw = std::fs::read_to_string(&idx).expect("index rewritten");
        let parsed: WorkspaceIndex =
            serde_json::from_str(&raw).expect("rewritten index is valid json");
        assert!(parsed.entries.contains_key("a.md"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unwritable_index_path_does_not_panic() {
        let (g, ws, _idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "a.md", "tea time").await;

        // Create a parent directory and lock it so the atomic write can't
        // create its temp file. The search itself must still return.
        let locked = g.path().join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let idx = locked.join("workspace_index.json");

        let embedder = TopicEmbedder::new(&["tea"]);
        let search_result = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await;

        // Restore perms so TempDir can clean up regardless of outcome.
        let _ignored = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700));

        let result = search_result.expect("hybrid search returns despite unwritable index path");
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].display_path, "a.md");
    }

    #[tokio::test]
    async fn pruning_a_deleted_file_persists() {
        let (_g, ws, idx) = setup();
        let ws_str = ws.to_string_lossy().into_owned();

        write_file(&ws, "a.md", "tea time").await;
        write_file(&ws, "b.md", "rust is fun").await;

        let embedder = TopicEmbedder::new(&["tea", "rust"]);
        let _ignored = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();

        // Delete b.md and re-run; the on-disk index must lose b.md.
        fs::remove_file(ws.join("b.md")).await.unwrap();
        _ = hybrid_search(
            &ws_str,
            &RetrievalConfig::default(),
            "tea",
            HybridMode::Hybrid,
            &embedder,
            &idx,
            None,
        )
        .await
        .unwrap();

        let raw = std::fs::read_to_string(&idx).expect("index persisted");
        let parsed: WorkspaceIndex = serde_json::from_str(&raw).expect("valid json");
        assert!(parsed.entries.contains_key("a.md"));
        assert!(
            !parsed.entries.contains_key("b.md"),
            "deleted file must be pruned from on-disk index"
        );
    }

    #[tokio::test]
    async fn walk_skips_git_object_store() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        fs::write(ws.join("note.md"), "tea preferences")
            .await
            .unwrap();
        fs::create_dir_all(ws.join(".git").join("objects"))
            .await
            .unwrap();
        fs::write(ws.join(".git").join("objects").join("blob"), "tea")
            .await
            .unwrap();
        fs::write(ws.join(".git").join("config"), "[core]")
            .await
            .unwrap();

        let config = RetrievalConfig::default();
        let candidates = enumerate_files(&ws.to_string_lossy(), &config).await;
        let paths: Vec<&str> = candidates.iter().map(|c| c.display_path.as_str()).collect();
        assert_eq!(paths, ["note.md"], "git internals must not be indexed");
    }

    #[tokio::test]
    async fn walk_skips_git_worktree_file() {
        // Linked worktrees expose `.git` as a file, not a directory; it must
        // still be skipped so the `gitdir:` path is not indexed.
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        fs::write(ws.join("note.md"), "tea preferences")
            .await
            .unwrap();
        fs::write(ws.join(".git"), "gitdir: /abs/secret/path\n")
            .await
            .unwrap();

        let config = RetrievalConfig::default();
        let candidates = enumerate_files(&ws.to_string_lossy(), &config).await;
        let paths: Vec<&str> = candidates.iter().map(|c| c.display_path.as_str()).collect();
        assert_eq!(paths, ["note.md"], "worktree .git file must not be indexed");
    }
}
