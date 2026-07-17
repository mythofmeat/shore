//! Workspace filesystem tools — read, edit, search, delete, git.
//!
//! These tools give the assistant access to a real filesystem workspace
//! (`{character}/workspace/`), mirroring OpenClaw's model of agent-curated files.
//!
//! `read` doubles as directory listing (a directory path returns its entries),
//! and `edit` doubles as file creation (`content` writes a whole file, `edits`
//! replaces text within one). `git` is the only process-spawning tool: the
//! workspace is a git repository and the memory passes commit their own
//! changes there.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};
use shore_config::app::RetrievalConfig;
use shore_llm::embed::Embedder;

use crate::convert::u64_to_usize;
use crate::memory::workspace_index::{self, HybridMode};

use super::{ToolCategory, ToolDef, ToolError};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

pub fn tool_defs() -> Vec<ToolDef> {
    let mut defs = editing_tool_defs();
    defs.extend(discovery_tool_defs());
    defs
}

/// `read` / `edit` workspace file tools.
fn editing_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "read",
            description: crate::include_prompt!("../../prompts/tools/workspace/read.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path within your workspace. A file path returns its contents; a directory path lists its entries. Omit for a listing of the workspace root."
                    },
                    "offset": {
                        "type": "number",
                        "description": "Line number to start reading from (1-based). Files only; ignored for directories. Optional."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of lines to read. Files only; ignored for directories. Optional."
                    }
                },
                "required": []
            }),
            category: ToolCategory::Other,
        },
        ToolDef {
            name: "edit",
            description: crate::include_prompt!("../../prompts/tools/workspace/edit.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path within your workspace."
                    },
                    "content": {
                        "type": "string",
                        "description": "Full content for the file, creating it or overwriting it wholesale. Parent directories are created automatically. Mutually exclusive with `edits`."
                    },
                    "edits": {
                        "type": "array",
                        "description": "List of replacements to apply in order to an existing file. Mutually exclusive with `content`.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": {
                                    "type": "string",
                                    "description": "Exact text to find and replace. Must match whitespace and newlines precisely."
                                },
                                "new_string": {
                                    "type": "string",
                                    "description": "Text to replace old_string with."
                                },
                                "replace_all": {
                                    "type": "boolean",
                                    "description": "Replace every occurrence of old_string. Defaults to false, which requires old_string to match exactly once."
                                }
                            },
                            "required": ["old_string", "new_string"]
                        }
                    }
                },
                "required": ["path"]
            }),
            category: ToolCategory::Other,
        },
    ]
}

/// `search` / `delete` / `git` workspace tools.
fn discovery_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "search",
            description: crate::include_prompt!("../../prompts/tools/workspace/search.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keyword, phrase, or natural-language description to search for."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["hybrid", "lexical", "vector"],
                        "description": "Ranking mode. `hybrid` (default) blends semantic similarity with substring matching. `lexical` is case-insensitive substring only, ordered by file recency. `vector` is pure semantic similarity."
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional relative path to scope the search to a subtree. Works in all modes — hybrid/vector queries are filtered to this subtree after ranking against the workspace-wide embedding index."
                    },
                    "max_results": {
                        "type": "number",
                        "description": "Maximum matches to return. Defaults to 20, maximum 100."
                    }
                },
                "required": ["query"]
            }),
            category: ToolCategory::Other,
        },
        ToolDef {
            name: "delete",
            description: crate::include_prompt!("../../prompts/tools/workspace/delete.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path to the file to remove, within your workspace."
                    }
                },
                "required": ["path"]
            }),
            category: ToolCategory::Other,
        },
        ToolDef {
            name: "git",
            description: crate::include_prompt!("../../prompts/tools/workspace/git.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subcommand": {
                        "type": "string",
                        "description": "The git subcommand to run, e.g. \"status\", \"add\", \"commit\", \"log\", \"diff\"."
                    },
                    "args": {
                        "type": "array",
                        "description": "Arguments for the subcommand, one array element per argument. For example [\"-m\", \"note why this matters\"]. Optional.",
                        "items": { "type": "string" }
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Directory to run in, relative to your workspace root. Optional; defaults to the workspace root."
                    }
                },
                "required": ["subcommand"]
            }),
            category: ToolCategory::Other,
        },
    ]
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

pub(crate) fn resolve_roots(
    workspace_dir: &str,
    relative_raw: &str,
) -> Result<(PathBuf, String), ToolError> {
    if workspace_dir.is_empty() {
        return Err(ToolError::InvalidArgs("workspace not configured".into()));
    }

    let relative = relative_raw.trim();
    if relative.is_empty() {
        return Err(ToolError::InvalidArgs("path is empty".into()));
    }

    let workspace_root = PathBuf::from(workspace_dir);

    let (root, stripped) = if relative == "workspace" {
        (workspace_root, String::new())
    } else if let Some(rest) = relative.strip_prefix("workspace/") {
        (workspace_root, rest.to_owned())
    } else if relative == "memory" {
        (workspace_root.join("memory"), String::new())
    } else if let Some(rest) = relative.strip_prefix("memory/") {
        (workspace_root.join("memory"), rest.to_owned())
    } else {
        (workspace_root, relative.to_owned())
    };

    Ok((root, stripped))
}

pub(crate) fn resolve_path(workspace_dir: &str, relative: &str) -> Result<PathBuf, ToolError> {
    let (base, stripped) = resolve_roots(workspace_dir, relative)?;
    if stripped.is_empty() {
        return Err(ToolError::InvalidArgs("path is empty".into()));
    }

    for component in Path::new(&stripped).components() {
        match component {
            std::path::Component::ParentDir => {
                return Err(ToolError::InvalidArgs(
                    "path traversal (..) is not allowed".into(),
                ));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(ToolError::InvalidArgs(
                    "absolute paths are not allowed".into(),
                ));
            }
            std::path::Component::CurDir | std::path::Component::Normal(_) => {}
        }
    }

    let resolved = base.join(&stripped);

    if let Ok(canonical_base) = base.canonicalize() {
        if let Ok(canonical) = resolved.canonicalize() {
            if !canonical.starts_with(&canonical_base) {
                return Err(ToolError::InvalidArgs(
                    "resolved path escapes workspace".into(),
                ));
            }
        } else {
            let mut ancestor = resolved.as_path();
            while let Some(parent) = ancestor.parent() {
                if let Ok(canonical_parent) = parent.canonicalize() {
                    if !canonical_parent.starts_with(&canonical_base) {
                        return Err(ToolError::InvalidArgs(
                            "resolved path escapes workspace".into(),
                        ));
                    }
                    break;
                }
                ancestor = parent;
            }
        }
    }

    Ok(resolved)
}

fn resolve_list_path(workspace_dir: &str, relative: Option<&str>) -> Result<PathBuf, ToolError> {
    if workspace_dir.is_empty() {
        return Err(ToolError::InvalidArgs("workspace not configured".into()));
    }

    match relative {
        None | Some("" | ".") => Ok(PathBuf::from(workspace_dir)),
        Some(rel) => {
            let (base, stripped) = resolve_roots(workspace_dir, rel)?;
            if stripped.is_empty() {
                Ok(base)
            } else {
                resolve_path(workspace_dir, rel)
            }
        }
    }
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

const SEARCH_DEFAULT_MAX_RESULTS: usize = 20;
const SEARCH_MAX_RESULTS: usize = 100;
const SEARCH_EXCERPT_CHARS: usize = 1_200;

fn normalize_search_query(input: &Value) -> Result<String, ToolError> {
    let query = input
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing required field: query".into()))?
        .trim();

    if query.is_empty() {
        return Err(ToolError::InvalidArgs("query must not be empty".into()));
    }

    Ok(query.to_owned())
}

fn search_result_limit(input: &Value) -> usize {
    input
        .get("max_results")
        .and_then(Value::as_u64)
        .map_or(SEARCH_DEFAULT_MAX_RESULTS, u64_to_usize)
        .clamp(1, SEARCH_MAX_RESULTS)
}

fn display_path_for(workspace_dir: &str, path: &Path) -> String {
    let workspace_root = Path::new(workspace_dir);
    if let Ok(rel) = path.strip_prefix(workspace_root) {
        let normalized = rel.to_string_lossy().replace('\\', "/");
        return normalized;
    }
    path.to_string_lossy().replace('\\', "/")
}

fn find_case_insensitive_match(line: &str, query_lower: &str) -> Option<(usize, usize)> {
    let folded = line.to_lowercase();
    let folded_start = folded.find(query_lower)?;
    let folded_end = folded_start.saturating_add(query_lower.len());

    let mut folded_pos = 0_usize;
    let mut original_start = None;
    let mut original_end = None;

    for (original_idx, ch) in line.char_indices() {
        let original_next = original_idx.saturating_add(ch.len_utf8());
        let char_folded_start = folded_pos;
        for folded_ch in ch.to_lowercase() {
            folded_pos = folded_pos.saturating_add(folded_ch.len_utf8());
        }
        let char_folded_end = folded_pos;

        if char_folded_end > folded_start && char_folded_start < folded_end {
            let _ignored = original_start.get_or_insert(original_idx);
            original_end = Some(original_next);
            if char_folded_end >= folded_end {
                break;
            }
        }
    }

    Some((
        original_start.unwrap_or(0),
        original_end.unwrap_or(line.len()),
    ))
}

fn byte_index_before_chars(text: &str, end: usize, count: usize) -> usize {
    let mut start = end;
    for _ in 0..count {
        let Some((idx, _)) = text.get(..start).unwrap_or("").char_indices().next_back() else {
            return 0;
        };
        start = idx;
    }
    start
}

fn byte_index_after_chars(text: &str, start: usize, count: usize) -> usize {
    let mut end = start;
    for _ in 0..count {
        let Some((offset, ch)) = text.get(end..).unwrap_or("").char_indices().next() else {
            return text.len();
        };
        end = end.saturating_add(offset).saturating_add(ch.len_utf8());
    }
    end
}

fn excerpt_line(line: &str, raw_match_start: usize, raw_match_end: usize) -> String {
    let trimmed_start = line.trim_start();
    let leading_trimmed_bytes = line.len().saturating_sub(trimmed_start.len());
    let trimmed = trimmed_start.trim_end();

    let match_start = raw_match_start
        .saturating_sub(leading_trimmed_bytes)
        .min(trimmed.len());
    let match_end = raw_match_end
        .saturating_sub(leading_trimmed_bytes)
        .min(trimmed.len())
        .max(match_start);

    let match_chars = trimmed
        .get(match_start..match_end)
        .map_or(0, |s| s.chars().count());
    let available_before = trimmed.get(..match_start).map_or(0, |s| s.chars().count());
    let available_after = trimmed.get(match_end..).map_or(0, |s| s.chars().count());
    let context_chars = SEARCH_EXCERPT_CHARS.saturating_sub(match_chars);
    let half_context_chars = context_chars.checked_div(2).unwrap_or_default();
    let mut before_chars = half_context_chars.min(available_before);
    let mut after_chars = context_chars
        .saturating_sub(before_chars)
        .min(available_after);

    let unused_after = context_chars.saturating_sub(before_chars.saturating_add(after_chars));
    if unused_after > 0 {
        let extra_before = available_before
            .saturating_sub(before_chars)
            .min(unused_after);
        before_chars = before_chars.saturating_add(extra_before);
    }

    let unused_before = context_chars.saturating_sub(before_chars.saturating_add(after_chars));
    if unused_before > 0 {
        let extra_after = available_after
            .saturating_sub(after_chars)
            .min(unused_before);
        after_chars = after_chars.saturating_add(extra_after);
    }

    let excerpt_start = byte_index_before_chars(trimmed, match_start, before_chars);
    let excerpt_end = byte_index_after_chars(trimmed, match_end, after_chars);

    let mut excerpt = String::new();
    if excerpt_start > 0 {
        excerpt.push_str("...");
    }
    excerpt.push_str(trimmed.get(excerpt_start..excerpt_end).unwrap_or(""));
    if excerpt_end < trimmed.len() {
        excerpt.push_str("...");
    }
    excerpt
}

// ---------------------------------------------------------------------------
// .git path rejection
// ---------------------------------------------------------------------------

/// Reject paths whose first path component is `.git` (the git internal
/// directory).  `.gitignore`, `.gitattributes`, and files inside
/// subdirectories are unaffected — only an exact leading `.git` component
/// (after an optional `workspace/` prefix) is blocked.
fn reject_git_internal_path(path_str: &str) -> Result<(), ToolError> {
    let trimmed = path_str.strip_prefix("workspace/").unwrap_or(path_str);
    let path = Path::new(trimmed);
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(name) => {
                if name == ".git" {
                    return Err(ToolError::InvalidArgs(
                        "writing to .git/ is not allowed".into(),
                    ));
                }
                return Ok(());
            }
            std::path::Component::Prefix(_)
            | std::path::Component::RootDir
            | std::path::Component::ParentDir => return Ok(()),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Read a file's contents, or list a directory's entries.
///
/// The path decides which: a file is read, a directory is listed, and an
/// omitted path lists the workspace root. This is why `path` is optional and
/// why a missing path can't be an error — a bare `read` is the root listing
/// that `list_files` used to serve.
pub async fn handle_read(input: Value, workspace_dir: &str) -> Result<Value, ToolError> {
    let Some(path_str) = input.get("path").and_then(|v| v.as_str()) else {
        return list_directory(workspace_dir, None).await;
    };

    let path = resolve_path(workspace_dir, path_str)?;

    if path.is_dir() {
        return list_directory(workspace_dir, Some(path_str)).await;
    }

    if !path.exists() {
        return Err(ToolError::Io(format!("file not found: {path_str}")));
    }
    if !path.is_file() {
        return Err(ToolError::InvalidArgs(format!(
            "{path_str} is neither a file nor a directory"
        )));
    }

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    let offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .map_or(1, u64_to_usize)
        .saturating_sub(1)
        .min(total_lines);

    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .map_or(total_lines, u64_to_usize);

    let end = offset.saturating_add(limit).min(total_lines);
    let selected: Vec<&str> = lines
        .iter()
        .skip(offset)
        .take(end.saturating_sub(offset))
        .copied()
        .collect();
    let result_text = selected.join("\n");

    let mut result = json!({
        "path": path_str,
        "content": result_text,
        "total_lines": total_lines,
    });

    if offset > 0 || end < total_lines {
        if let Some(obj) = result.as_object_mut() {
            let _ignored = obj.insert("offset".into(), json!(offset.saturating_add(1)));
            _ = obj.insert("returned_lines".into(), json!(end.saturating_sub(offset)));
            if end < total_lines {
                _ = obj.insert(
                    "note".into(),
                    json!(format!(
                        "Showing lines {}–{} of {}. Use offset={} to continue.",
                        offset.saturating_add(1),
                        end,
                        total_lines,
                        end.saturating_add(1)
                    )),
                );
            }
        }
    }

    Ok(result)
}

/// Write `content` to `path` wholesale, creating parent directories and the
/// file itself as needed. The `content` half of [`handle_edit`].
async fn write_whole_file(
    path_str: &str,
    content: &str,
    workspace_dir: &str,
) -> Result<Value, ToolError> {
    let path = resolve_path(workspace_dir, path_str)?;

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| ToolError::Io(e.to_string()))?;
    }

    tokio::fs::write(&path, content)
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    Ok(json!({
        "path": path_str,
        "bytes_written": content.len(),
    }))
}

/// Create/overwrite a file (`content`) or replace text within an existing one
/// (`edits`).
///
/// The two modes are mutually exclusive. `edits` deliberately still fails on a
/// missing file rather than creating it: an unmatched path is far more often a
/// mistake than an intent to create, and `content` is the unambiguous way to
/// say "make this file".
pub async fn handle_edit(input: Value, workspace_dir: &str) -> Result<Value, ToolError> {
    let path_str = input
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing required field: path".into()))?;
    reject_git_internal_path(path_str)?;

    let content_arg = input.get("content").and_then(|v| v.as_str());
    let edits_arg = input.get("edits").and_then(|v| v.as_array());

    match (content_arg, edits_arg) {
        (Some(_), Some(_)) => Err(ToolError::InvalidArgs(
            "pass either 'content' (whole file) or 'edits' (targeted replacements), not both"
                .into(),
        )),
        (Some(content), None) => write_whole_file(path_str, content, workspace_dir).await,
        (None, Some(edits)) => apply_edits(path_str, edits, workspace_dir).await,
        (None, None) => Err(ToolError::InvalidArgs(
            "missing required field: pass 'content' to write a whole file, or 'edits' to replace text within one"
                .into(),
        )),
    }
}

/// Apply ordered text replacements to an existing file. The `edits` half of
/// [`handle_edit`].
async fn apply_edits(
    path_str: &str,
    edits: &[Value],
    workspace_dir: &str,
) -> Result<Value, ToolError> {
    if edits.is_empty() {
        return Err(ToolError::InvalidArgs("'edits' array is empty".into()));
    }

    let path = resolve_path(workspace_dir, path_str)?;

    if !path.exists() {
        return Err(ToolError::Io(format!(
            "file not found: {path_str} (pass 'content' instead of 'edits' to create it)"
        )));
    }

    let mut content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    let mut replacements_made = 0_usize;

    for edit in edits {
        let old_str = edit
            .get("old_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("each edit must have 'old_string'".into()))?;
        let new_str = edit
            .get("new_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("each edit must have 'new_string'".into()))?;
        let replace_all = edit
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if old_str.is_empty() {
            return Err(ToolError::InvalidArgs(
                "old_string must not be empty".into(),
            ));
        }

        let count = content.matches(old_str).count();

        if count == 0 {
            let snippet_limit = 800;
            let content_chars = content.chars().count();
            let snippet = if content_chars <= snippet_limit {
                content.clone()
            } else {
                format!(
                    "{}\n... (truncated)",
                    truncate_chars(&content, snippet_limit)
                )
            };
            return Err(ToolError::InvalidArgs(format!(
                "Could not find the exact text in {path_str}.\nCurrent file contents:\n{snippet}"
            )));
        }

        // Default to a unique match so an edit can't silently clobber other
        // occurrences; `replace_all` opts into rewriting every one.
        if count > 1 && !replace_all {
            return Err(ToolError::InvalidArgs(format!(
                "Found {count} occurrences of old_string in {path_str}; it must \
                 match exactly once. Add surrounding context to target a single \
                 occurrence, or set \"replace_all\": true to replace every one."
            )));
        }

        content = content.replace(old_str, new_str);
        replacements_made = replacements_made.saturating_add(count);
    }

    tokio::fs::write(&path, content)
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    Ok(json!({
        "path": path_str,
        "replacements_made": replacements_made,
    }))
}

/// Flat listing of a directory's entries. Reached through [`handle_read`] when
/// the resolved path is a directory (or no path was given at all).
async fn list_directory(workspace_dir: &str, path_str: Option<&str>) -> Result<Value, ToolError> {
    let dir = resolve_list_path(workspace_dir, path_str)?;

    if !dir.exists() {
        return Ok(json!({ "entries": [], "note": "directory does not exist yet" }));
    }

    if !dir.is_dir() {
        return Err(ToolError::InvalidArgs(format!(
            "{} is not a directory",
            path_str.unwrap_or(".")
        )));
    }

    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?
    {
        let meta = entry
            .metadata()
            .await
            .map_err(|e| ToolError::Io(e.to_string()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(json!({
            "name": name,
            "type": if meta.is_dir() { "directory" } else { "file" },
            "size": meta.len(),
        }));
    }

    entries.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .cmp(&b.get("name").and_then(|v| v.as_str()))
    });

    Ok(json!({ "entries": entries }))
}

/// Top-level entry point: dispatches to lexical or hybrid based on the
/// caller-supplied `mode` and whether an embedder is wired up.
///
/// `embedder` and `workspace_index_path` are optional so tests (and
/// embedder-less production setups) can call this without a configured
/// embedding profile — they fall through to the lexical path.
pub async fn handle_search(
    input: Value,
    workspace_dir: &str,
    retrieval_config_opt: Option<&RetrievalConfig>,
    embedder: Option<&dyn Embedder>,
    workspace_index_path: Option<&Path>,
) -> Result<Value, ToolError> {
    let retrieval_config = retrieval_config_opt.cloned().unwrap_or_default();
    let requested_mode = parse_search_mode(input.get("mode"))?;
    let requested_hybrid = !matches!(requested_mode, RequestedMode::Lexical);
    let path_str = input.get("path").and_then(|v| v.as_str());

    if let (true, Some(embedder_ref), Some(index_path)) =
        (requested_hybrid, embedder, workspace_index_path)
    {
        let mode = match requested_mode {
            RequestedMode::Vector => HybridMode::Vector,
            RequestedMode::Hybrid | RequestedMode::Lexical => HybridMode::Hybrid,
        };
        let scope = match path_str {
            Some(raw) if !raw.is_empty() && raw != "." => {
                Some(scope_prefix_for(workspace_dir, raw)?)
            }
            Some(_) | None => None,
        };
        return handle_search_hybrid(
            input,
            workspace_dir,
            &retrieval_config,
            mode,
            embedder_ref,
            index_path,
            scope.as_deref(),
        )
        .await;
    }

    let mut response = handle_search_lexical(input, workspace_dir, &retrieval_config).await?;
    if let Some(obj) = response.as_object_mut() {
        let _ignored = obj.insert("mode".into(), json!("lexical"));
        if requested_hybrid {
            _ = obj.insert(
                "semantic_unavailable".into(),
                json!("embedder not configured"),
            );
        }
    }
    Ok(response)
}

/// Returns the workspace-relative display prefix used to scope a path-filtered
/// hybrid search (e.g. `"workspace/notes"` → `"notes"`, `"memory/x"` →
/// `"memory/x"`). The empty string means "no scope" and is filtered out by
/// `hybrid_search`.
fn scope_prefix_for(workspace_dir: &str, raw: &str) -> Result<String, ToolError> {
    let resolved = resolve_list_path(workspace_dir, Some(raw))?;
    Ok(display_path_for(workspace_dir, &resolved))
}

#[derive(Debug, Clone, Copy)]
enum RequestedMode {
    Hybrid,
    Lexical,
    Vector,
}

fn parse_search_mode(raw: Option<&Value>) -> Result<RequestedMode, ToolError> {
    let Some(v) = raw else {
        return Ok(RequestedMode::Hybrid);
    };
    match v.as_str() {
        None => Err(ToolError::InvalidArgs(
            "search `mode` must be a string".into(),
        )),
        Some("hybrid") => Ok(RequestedMode::Hybrid),
        Some("lexical") => Ok(RequestedMode::Lexical),
        Some("vector") => Ok(RequestedMode::Vector),
        Some(other) => Err(ToolError::InvalidArgs(format!(
            "unknown search mode '{other}'; expected hybrid, lexical, or vector"
        ))),
    }
}

async fn handle_search_lexical(
    input: Value,
    workspace_dir: &str,
    retrieval_config: &RetrievalConfig,
) -> Result<Value, ToolError> {
    if workspace_dir.is_empty() {
        return Err(ToolError::InvalidArgs("workspace not configured".into()));
    }

    let query = normalize_search_query(&input)?;
    let query_lower = query.to_lowercase();
    let max_results = search_result_limit(&input);
    let path_str = input.get("path").and_then(|v| v.as_str());
    let root = resolve_list_path(workspace_dir, path_str)?;

    if !root.exists() {
        return Ok(json!({
            "query": query,
            "results": [],
            "count": 0,
            "note": "path does not exist"
        }));
    }

    let (candidates, oversize_skipped) = enumerate_search_candidates(root, retrieval_config).await;

    let LexicalScanOutput {
        results,
        files_summary,
        searched_files,
        skipped_binary_or_large,
    } = scan_lexical_matches(
        candidates,
        workspace_dir,
        &query_lower,
        max_results,
        oversize_skipped,
    )
    .await;

    let count = results.len();
    let mut response = json!({
        "query": query,
        "results": results,
        "count": count,
        "searched_files": searched_files,
        "skipped_binary_or_large": skipped_binary_or_large,
    });

    if count > 0 {
        if let Some(obj) = response.as_object_mut() {
            let _ignored = obj.insert("files".into(), json!(files_summary));
            _ = obj.insert(
                "note".into(),
                json!(
                    "These are line-level excerpts, ordered by file recency. \
                     Call `read` on the top file paths to see surrounding context — \
                     excerpts almost never contain the full answer, and one file \
                     often references others worth reading too."
                ),
            );
        }
    }

    Ok(response)
}

/// Enumerate searchable files under `root`, newest-first (path order breaks
/// mtime ties). Symlinks are skipped here — descendants discovered by walking
/// are joined onto the workspace root without re-checking containment, so a
/// symlink pointing outside (e.g. → /etc/passwd) would otherwise be read like
/// any regular file. Returns the candidates and the oversize-skip count.
async fn enumerate_search_candidates(
    root: PathBuf,
    retrieval_config: &RetrievalConfig,
) -> (Vec<(PathBuf, SystemTime)>, usize) {
    let mut pending = vec![root];
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    let mut skipped_binary_or_large = 0_usize;

    while let Some(path) = pending.pop() {
        let Ok(meta) = tokio::fs::symlink_metadata(&path).await else {
            continue;
        };

        if meta.file_type().is_symlink() {
            continue;
        }

        // The workspace carries a git history of memory changes; the git store
        // is machine state, not searchable memory. Skip `.git` whether it is a
        // directory or a `.git` *file* (linked worktrees expose it as a file
        // whose `gitdir:` line would otherwise be read and leaked).
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }

        if meta.is_dir() {
            let mut entries = Vec::new();
            let Ok(mut read_dir) = tokio::fs::read_dir(&path).await else {
                continue;
            };
            while let Ok(Some(entry)) = read_dir.next_entry().await {
                entries.push(entry.path());
            }
            pending.extend(entries);
            continue;
        }

        if !meta.is_file() {
            continue;
        }

        if meta.len() > retrieval_config.max_file_bytes {
            skipped_binary_or_large = skipped_binary_or_large.saturating_add(1);
            continue;
        }

        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        candidates.push((path, mtime));
    }

    // Newest first; fall back to path order so output is stable when mtimes
    // tie (e.g. tests that write files in quick succession).
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    (candidates, skipped_binary_or_large)
}

/// Per-file lexical scan results, accumulated across candidates.
struct LexicalScanOutput {
    results: Vec<Value>,
    files_summary: Vec<Value>,
    searched_files: usize,
    skipped_binary_or_large: usize,
}

/// Scan candidate files for case-insensitive matches of `query_lower`,
/// collecting line excerpts (capped at `max_results`) and per-file hit counts.
async fn scan_lexical_matches(
    candidates: Vec<(PathBuf, SystemTime)>,
    workspace_dir: &str,
    query_lower: &str,
    max_results: usize,
    mut skipped_binary_or_large: usize,
) -> LexicalScanOutput {
    let mut results = Vec::new();
    let mut files_summary: Vec<Value> = Vec::new();
    let mut searched_files = 0_usize;

    for (path, _) in candidates {
        let Ok(bytes) = tokio::fs::read(&path).await else {
            continue;
        };
        let Ok(content) = String::from_utf8(bytes) else {
            skipped_binary_or_large = skipped_binary_or_large.saturating_add(1);
            continue;
        };

        searched_files = searched_files.saturating_add(1);
        let display = display_path_for(workspace_dir, &path);
        let mut file_hits = 0_usize;
        for (line_idx, line) in content.lines().enumerate() {
            let Some((match_start, match_end)) = find_case_insensitive_match(line, query_lower)
            else {
                continue;
            };
            results.push(json!({
                "path": display.clone(),
                "line": line_idx.saturating_add(1),
                "excerpt": excerpt_line(line, match_start, match_end),
            }));
            file_hits = file_hits.saturating_add(1);
            if results.len() >= max_results {
                break;
            }
        }
        if file_hits > 0 {
            files_summary.push(json!({"path": display, "hits": file_hits}));
        }
        if results.len() >= max_results {
            break;
        }
    }

    LexicalScanOutput {
        results,
        files_summary,
        searched_files,
        skipped_binary_or_large,
    }
}

async fn handle_search_hybrid(
    input: Value,
    workspace_dir: &str,
    retrieval_config: &RetrievalConfig,
    mode: HybridMode,
    embedder: &dyn Embedder,
    index_path: &Path,
    path_filter: Option<&str>,
) -> Result<Value, ToolError> {
    let query = normalize_search_query(&input)?;
    let max_results = search_result_limit(&input);

    let result = match workspace_index::hybrid_search(
        workspace_dir,
        retrieval_config,
        &query,
        mode,
        embedder,
        index_path,
        path_filter,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "hybrid search failed; falling back to lexical");
            let mut lex = handle_search_lexical(input, workspace_dir, retrieval_config).await?;
            if let Some(obj) = lex.as_object_mut() {
                let _ignored = obj.insert("mode".into(), json!("lexical"));
                _ = obj.insert("semantic_unavailable".into(), json!(e.to_string()));
            }
            return Ok(lex);
        }
    };

    let q_lower = query.to_lowercase();
    let mut results: Vec<Value> = Vec::new();

    for f in result.files.iter().take(max_results) {
        let content = f.content.as_deref().unwrap_or("");
        let (line_no, excerpt) = best_line_excerpt(content, &q_lower);
        results.push(json!({
            "path": f.display_path,
            "line": line_no,
            "excerpt": excerpt,
            "lexical_score": f.lexical_score,
            "semantic_score": f.semantic_score,
            "combined_score": f.combined_score,
        }));
    }

    let count = results.len();
    let mode_label = match mode {
        HybridMode::Hybrid => "hybrid",
        HybridMode::Vector => "vector",
    };
    let mut response = json!({
        "query": query,
        "mode": mode_label,
        "results": results,
        "count": count,
        "searched_files": result.searched_files,
        "embedded_files": result.embedded_files,
        "skipped_binary_or_large": result.skipped_binary_or_large,
    });

    if count > 0 {
        if let Some(obj) = response.as_object_mut() {
            let _ignored = obj.insert(
                "note".into(),
                json!(
                    "Files ranked by combined semantic + lexical score. Excerpts are \
                     best-effort line-level snippets; call `read` on the top paths for \
                     full context — one file often references others worth reading too."
                ),
            );
        }
    }

    Ok(response)
}

fn best_line_excerpt(content: &str, q_lower: &str) -> (usize, String) {
    for (i, line) in content.lines().enumerate() {
        if let Some((s, e)) = find_case_insensitive_match(line, q_lower) {
            return (i.saturating_add(1), excerpt_line(line, s, e));
        }
    }

    let terms = search_excerpt_terms(q_lower);
    if !terms.is_empty() {
        let frequencies = term_line_frequencies(content, &terms);
        if let Some((line_no, line, term)) =
            best_term_matched_line(content, &terms, &frequencies, false)
                .or_else(|| best_term_matched_line(content, &terms, &frequencies, true))
        {
            if let Some((s, e)) = find_case_insensitive_match(line, term) {
                return (line_no, excerpt_line(line, s, e));
            }
            return (line_no, truncate_excerpt_line(line.trim()));
        }
    }

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            return (i.saturating_add(1), truncate_excerpt_line(trimmed));
        }
    }
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return (i.saturating_add(1), truncate_excerpt_line(trimmed));
        }
    }
    (1, String::new())
}

fn search_excerpt_terms(query_lower: &str) -> Vec<String> {
    query_lower
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|t| t.len() >= 2)
        .map(str::to_owned)
        .collect()
}

fn term_line_frequencies(content: &str, terms: &[String]) -> Vec<usize> {
    terms
        .iter()
        .map(|term| {
            content
                .lines()
                .filter(|line| line.to_lowercase().contains(term))
                .count()
                .max(1)
        })
        .collect()
}

fn best_term_matched_line<'val>(
    content: &'val str,
    terms: &'val [String],
    frequencies: &[usize],
    allow_heading: bool,
) -> Option<(usize, &'val str, &'val str)> {
    content
        .lines()
        .enumerate()
        .filter_map(|(line_idx, line)| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            if !allow_heading && trimmed.starts_with('#') {
                return None;
            }

            let lower = trimmed.to_lowercase();
            let mut best_term: Option<(&str, usize)> = None;
            let mut line_score = 0_usize;
            for (idx, term) in terms.iter().enumerate() {
                if lower.contains(term) {
                    let denom = frequencies.get(idx).copied().unwrap_or(1).max(1);
                    let term_score = 100_usize
                        .checked_div(denom)
                        .unwrap_or(0)
                        .saturating_add(term.len());
                    line_score = line_score.saturating_add(term_score);
                    let replace_best = match best_term {
                        Some((_, score)) => term_score > score,
                        None => true,
                    };
                    if replace_best {
                        best_term = Some((term.as_str(), term_score));
                    }
                }
            }

            best_term.map(|(term, _)| (line_idx.saturating_add(1), line, term, line_score))
        })
        .max_by(|a, b| a.3.cmp(&b.3).then_with(|| b.0.cmp(&a.0)))
        .map(|(line_no, line, term, _)| (line_no, line, term))
}

fn truncate_excerpt_line(line: &str) -> String {
    let count = line.chars().count();
    if count <= SEARCH_EXCERPT_CHARS {
        return line.to_owned();
    }
    let truncated: String = line.chars().take(SEARCH_EXCERPT_CHARS).collect();
    format!("{truncated}...")
}

pub async fn handle_delete(
    input: Value,
    workspace_dir: &str,
    character_data_dir: &str,
) -> Result<Value, ToolError> {
    let path_str = input
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing required field: path".into()))?;
    reject_git_internal_path(path_str)?;

    if crate::memory::deferred_edits::is_prompt_visible_path(path_str) {
        return Err(ToolError::InvalidArgs(format!(
            "{path_str} is a prompt-visible file and cannot be deleted"
        )));
    }

    if character_data_dir.is_empty() {
        return Err(ToolError::InvalidArgs(
            "character data directory not configured".into(),
        ));
    }

    let path = resolve_path(workspace_dir, path_str)?;

    if !path.exists() {
        return Err(ToolError::Io(format!("file not found: {path_str}")));
    }
    if !path.is_file() {
        return Err(ToolError::InvalidArgs(format!(
            "{path_str} is not a file (delete only operates on regular files)"
        )));
    }

    let workspace_root = PathBuf::from(workspace_dir);
    let relative_under_workspace = path.strip_prefix(&workspace_root).map_or_else(
        |_| PathBuf::from(path.file_name().unwrap_or_default()),
        Path::to_path_buf,
    );

    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ").to_string();
    let trash_root = PathBuf::from(character_data_dir).join("trash").join(&stamp);
    let trash_target = trash_root.join(&relative_under_workspace);

    if let Some(parent) = trash_target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| ToolError::Io(format!("could not create trash directory: {e}")))?;
    }

    if let Err(rename_err) = tokio::fs::rename(&path, &trash_target).await {
        // Cross-device rename can fail with EXDEV. Fall back to copy + remove.
        let _ignored = tokio::fs::copy(&path, &trash_target).await.map_err(|e| {
            ToolError::Io(format!(
                "could not move file to trash (rename: {rename_err}, copy fallback: {e})"
            ))
        })?;
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| ToolError::Io(format!("could not remove original after copy: {e}")))?;
    }

    let character_data_root = PathBuf::from(character_data_dir);
    let trash_display_root = character_data_root.parent().unwrap_or(Path::new(""));
    let trashed_display = trash_target.strip_prefix(trash_display_root).map_or_else(
        |_| trash_target.to_string_lossy().replace('\\', "/"),
        |p| p.to_string_lossy().replace('\\', "/"),
    );

    Ok(json!({
        "path": path_str,
        "deleted": true,
        "trashed_to": trashed_display,
    }))
}

// ---------------------------------------------------------------------------
// Git argument confinement
// ---------------------------------------------------------------------------

fn is_path_like_arg(arg: &str) -> bool {
    if arg.is_empty() || arg == "-" || arg == "--" {
        return false;
    }

    arg.starts_with('/')
        || arg.starts_with('\\')
        || arg.starts_with("./")
        || arg.starts_with("../")
        || arg.starts_with("~/")
        || arg.starts_with("~\\")
        || arg == "."
        || arg == ".."
        || arg.contains('/')
        || arg.contains('\\')
        || arg.starts_with("file:")
        || matches!(
            Path::new(arg).components().next(),
            Some(std::path::Component::Prefix(_))
        )
}

fn validate_git_path_arg(workspace_dir: &str, arg: &str) -> Result<(), ToolError> {
    let path = Path::new(arg);
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err(ToolError::InvalidArgs(format!(
                    "git argument escapes workspace: {arg}"
                )));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(ToolError::InvalidArgs(format!(
                    "git argument uses an absolute path: {arg}"
                )));
            }
            std::path::Component::CurDir | std::path::Component::Normal(_) => {}
        }
    }

    let resolved = resolve_path(workspace_dir, arg)?;
    let workspace_root = PathBuf::from(workspace_dir)
        .canonicalize()
        .map_err(|e| ToolError::Io(format!("workspace unavailable: {e}")))?;

    if let Ok(canonical) = resolved.canonicalize() {
        if !canonical.starts_with(&workspace_root) {
            return Err(ToolError::InvalidArgs(format!(
                "git argument escapes workspace: {arg}"
            )));
        }
        return Ok(());
    }

    let mut ancestor = resolved.as_path();
    while let Some(parent) = ancestor.parent() {
        if let Ok(canonical_parent) = parent.canonicalize() {
            if !canonical_parent.starts_with(&workspace_root) {
                return Err(ToolError::InvalidArgs(format!(
                    "git argument escapes workspace: {arg}"
                )));
            }
            return Ok(());
        }
        ancestor = parent;
    }

    Ok(())
}

/// Confine every path-like argument to the workspace. Unlike the argv form
/// this replaces, `args` never contains the program or subcommand — the caller
/// passes only the subcommand's own arguments.
fn validate_git_args(workspace_dir: &str, args: &[String]) -> Result<(), ToolError> {
    if workspace_dir.is_empty() {
        return Err(ToolError::InvalidArgs("workspace not configured".into()));
    }

    for arg in args {
        if arg.starts_with("file:") {
            return Err(ToolError::InvalidArgs(format!(
                "git argument uses a file URL: {arg}"
            )));
        }

        if let Some((_, value)) = arg.split_once('=') {
            if is_path_like_arg(value) {
                validate_git_path_arg(workspace_dir, value)?;
            }
        }

        if is_path_like_arg(arg) {
            validate_git_path_arg(workspace_dir, arg)?;
        }
    }

    Ok(())
}

/// Reject a subcommand that is really a git *global* flag in disguise.
///
/// The structured `{subcommand, args}` shape is what makes this cheap: the
/// runtime always spawns `git <subcommand> <args…>`, so `-c core.pager=…`,
/// `--exec-path=…`, `--git-dir=…` and friends can never land in the global
/// slot ahead of the subcommand the way they could when the model handed us a
/// whole command line. Guarding argv[0] closes the only remaining door.
fn validate_git_subcommand_token(subcommand: &str) -> Result<(), ToolError> {
    if subcommand.is_empty() {
        return Err(ToolError::InvalidArgs("subcommand is empty".into()));
    }
    if subcommand.starts_with('-') {
        return Err(ToolError::InvalidArgs(format!(
            "'{subcommand}' is a git option, not a subcommand; pass options in `args`"
        )));
    }
    if subcommand.contains('/') || subcommand.contains('\\') {
        return Err(ToolError::InvalidArgs(format!(
            "'{subcommand}' is not a valid git subcommand"
        )));
    }
    Ok(())
}

/// True when a `checkout`'s arguments name a pathspec rather than just a branch
/// — the form that overwrites working-tree files from a tree-ish.
///
/// Two shapes reach it: an explicit `--` separator, or a bare `<tree-ish>
/// <path>` pair. Branch creation (`-b`/`-B`) legitimately takes two operands
/// (`-b topic origin/main`), so it is not a pathspec by operand count alone.
fn checkout_targets_a_pathspec(rest: &[String]) -> bool {
    if rest.iter().any(|a| a == "--") {
        return true;
    }
    if rest
        .iter()
        .any(|a| a == "-b" || a == "-B" || a == "--orphan")
    {
        return false;
    }
    // `checkout main` is a branch switch; `checkout HEAD note.md` is a discard.
    rest.iter().filter(|a| !a.starts_with('-')).count() >= 2
}

/// Validate a git subcommand + its arguments against the destructive denylist.
/// `sub[0]` is the subcommand name; `rest = &sub[1..]`.
///
/// Blocks history rewriting, forced discards, remote mutation, `config`, and
/// `push` — the model commits, the daemon pushes.
#[expect(
    clippy::too_many_lines,
    reason = "validates all blocked git subcommands in one place"
)]
fn validate_git_subcommand(sub: &[String]) -> Result<(), ToolError> {
    let Some(cmd_arg) = sub.first() else {
        return Ok(());
    };
    let cmd = cmd_arg.as_str();
    let rest = sub.get(1..).unwrap_or(&[]);

    let rest_has = |flag: &str| -> bool { rest.iter().any(|a| a == flag) };

    match cmd {
        "config" => Err(ToolError::InvalidArgs(
            "git config is not allowed (use the daemon's identity setup)".into(),
        )),
        "reset" => {
            if rest_has("--hard") || rest_has("--merge") || rest_has("--keep") {
                Err(ToolError::InvalidArgs(
                    "git reset --hard/--merge/--keep is not allowed".into(),
                ))
            } else {
                Ok(())
            }
        }
        "clean" => {
            if rest_has("-f")
                || rest_has("--force")
                || rest_has("-d")
                || rest_has("-x")
                || rest_has("-X")
            {
                return Err(ToolError::InvalidArgs(
                    "git clean (forced) is not allowed".into(),
                ));
            }
            // combined short flags like -fd, -fdx, -xd etc. contain any of f, d, x, X
            for a in rest
                .iter()
                .filter(|a| a.starts_with('-') && !a.starts_with("--"))
            {
                if a.contains('f') || a.contains('d') || a.contains('x') || a.contains('X') {
                    return Err(ToolError::InvalidArgs(
                        "git clean (forced) is not allowed".into(),
                    ));
                }
            }
            Ok(())
        }
        "rebase" | "filter-branch" | "filter-repo" => {
            Err(ToolError::InvalidArgs(format!("git {cmd} is not allowed")))
        }
        "checkout" => {
            if rest_has("-f") || rest_has("--force") {
                return Err(ToolError::InvalidArgs(
                    "git checkout --force is not allowed".into(),
                ));
            }
            // `git checkout <tree-ish> -- <path>` overwrites the file from the
            // tree, discarding uncommitted work — it is precisely what
            // `git restore` was split out of, and `restore` is denied right
            // below for exactly that. Deny the pathspec forms too, or the
            // denylist blocks the modern spelling and waves through the old
            // one. Branch operations (`checkout main`, `checkout -b topic
            // origin/main`) keep working.
            if checkout_targets_a_pathspec(rest) {
                return Err(ToolError::InvalidArgs(
                    "git checkout of a path is not allowed (discards changes); commit first, or read the file and edit it"
                        .into(),
                ));
            }
            Ok(())
        }
        "switch" => {
            if rest_has("-f") || rest_has("--force") || rest_has("--discard-changes") {
                Err(ToolError::InvalidArgs(
                    "git switch --force is not allowed".into(),
                ))
            } else {
                Ok(())
            }
        }
        "restore" => Err(ToolError::InvalidArgs(
            "git restore is not allowed (discards changes)".into(),
        )),
        "branch" => {
            if rest_has("-D") || rest_has("-d") || rest_has("--delete") {
                Err(ToolError::InvalidArgs(
                    "git branch deletion is not allowed".into(),
                ))
            } else {
                Ok(())
            }
        }
        "tag" => {
            if rest_has("-d") || rest_has("--delete") {
                Err(ToolError::InvalidArgs(
                    "git tag deletion is not allowed".into(),
                ))
            } else {
                Ok(())
            }
        }
        "stash" => match rest.first().map(String::as_str) {
            Some("drop" | "clear" | "pop") => Err(ToolError::InvalidArgs(
                "git stash drop/clear/pop is not allowed".into(),
            )),
            _ => Ok(()),
        },
        "reflog" => match rest.first().map(String::as_str) {
            Some("expire" | "delete") => Err(ToolError::InvalidArgs(
                "git reflog expire/delete is not allowed".into(),
            )),
            _ => Ok(()),
        },
        "gc" => Err(ToolError::InvalidArgs("git gc is not allowed".into())),
        "update-ref" => {
            if rest_has("-d") || rest_has("--delete") {
                Err(ToolError::InvalidArgs(
                    "git update-ref -d is not allowed".into(),
                ))
            } else {
                Ok(())
            }
        }
        // Pushing is not the model's job: network egress is daemon policy.
        // The daemon pushes after a successful pass when `[memory] git_push`
        // is enabled; the model only commits.
        "push" => Err(ToolError::InvalidArgs(
            "git push is not allowed (the daemon pushes after a pass when [memory] git_push is enabled)".into(),
        )),
        // Remote access is the daemon's job, the same way `push` is: the model
        // works in the local repo. These would also fail opaquely under the
        // sandbox — seccomp blocks `socket(AF_INET)` unless `allow_network` is
        // set — so deny them here, where the refusal can explain itself.
        "fetch" | "pull" | "clone" => Err(ToolError::InvalidArgs(format!(
            "git {cmd} is not allowed (the daemon owns remote access)"
        ))),
        "remote" => match rest.first().map(String::as_str) {
            Some("add" | "set-url" | "rename" | "remove" | "rm") => Err(ToolError::InvalidArgs(
                "modifying git remotes is not allowed".into(),
            )),
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}

/// Build the `git` invocation for `sub_slice`, applying the sandbox when it is
/// enabled.
///
/// git is the only tool that spawns a process, and it can still run
/// repo-supplied code (hooks), so it keeps the containment the exec tool had:
/// the program is re-executed through the daemon's hidden helper mode, which
/// applies Landlock + seccomp before running it. Falls back to a direct spawn
/// when the sandbox is disabled or unavailable under `auto`.
fn git_command(
    workspace_dir: &str,
    sub_slice: &[String],
) -> Result<tokio::process::Command, ToolError> {
    match crate::sandbox::plan_for(workspace_dir) {
        crate::sandbox::SandboxPlan::Direct => {
            let mut cmd = tokio::process::Command::new("git");
            let _ignored = cmd.args(sub_slice);
            Ok(cmd)
        }
        crate::sandbox::SandboxPlan::Wrapped {
            helper,
            prefix_args,
        } => {
            let mut cmd = tokio::process::Command::new(helper);
            let _prefix = cmd.args(&prefix_args);
            let _sep = cmd.arg("--");
            let _prog = cmd.arg("git");
            let _args = cmd.args(sub_slice);
            Ok(cmd)
        }
        // `sandbox = "on"` requires enforcement we cannot provide here: fail
        // closed rather than run git unsandboxed.
        crate::sandbox::SandboxPlan::Unavailable { reason } => Err(ToolError::Io(format!(
            "git sandbox required but unavailable: {reason}"
        ))),
    }
}

/// Run a git subcommand in the character's workspace repository.
///
/// The only tool that spawns a process. Everything it can do is bounded by
/// three checks: the subcommand must not be a global flag
/// (`validate_git_subcommand_token`), it must not be destructive or
/// history-rewriting (`validate_git_subcommand`), and every path-like
/// argument must stay inside the workspace (`validate_git_args`).
///
/// Initializes the workspace repository if it is missing. The memory passes do
/// the same before they run ([`ensure_workspace_git_repo_best_effort`]), but
/// they are the only ones that used to: on the chat path a character offered
/// this tool would otherwise meet `fatal: not a git repository` until the first
/// compaction or dreaming pass happened to create one.
pub async fn handle_git(
    input: Value,
    workspace_dir: &str,
    character: &str,
) -> Result<Value, ToolError> {
    let subcommand = input
        .get("subcommand")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing required field: subcommand".into()))?
        .trim();

    validate_git_subcommand_token(subcommand)?;

    let args: Vec<String> = match input.get("args") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str().map(str::to_owned).ok_or_else(|| {
                    ToolError::InvalidArgs("every element of `args` must be a string".into())
                })
            })
            .collect::<Result<_, _>>()?,
        Some(Value::Null) | None => Vec::new(),
        Some(_) => {
            return Err(ToolError::InvalidArgs(
                "`args` must be an array of strings".into(),
            ))
        }
    };

    // `validate_git_subcommand` expects the subcommand at index 0 followed by
    // its arguments — the same slice layout the exec argv walk used to hand it.
    let mut sub_slice = Vec::with_capacity(args.len().saturating_add(1));
    sub_slice.push(subcommand.to_owned());
    sub_slice.extend(args.iter().cloned());
    validate_git_subcommand(&sub_slice)?;

    validate_git_args(workspace_dir, &args)?;

    if !workspace_dir.is_empty() {
        ensure_workspace_git_repo_best_effort(Path::new(workspace_dir), character, "git tool")
            .await;
    }

    let workdir = input
        .get("workdir")
        .and_then(|v| v.as_str())
        .map(|w| resolve_path(workspace_dir, w))
        .transpose()?;

    // Safety flags first, then the subcommand: a repo the operator imported
    // must not get to run its `.git/hooks/pre-commit` just because the model
    // committed. `run_git` has always done this for the daemon's own calls;
    // the model-facing path needs it at least as much.
    let mut spawn_args: Vec<String> = GIT_SAFETY_FLAGS.iter().map(|f| (*f).to_owned()).collect();
    spawn_args.extend(sub_slice.iter().cloned());

    let mut cmd = git_command(workspace_dir, &spawn_args)?;

    // git runs as the character: attribute commits to it, keeping them
    // distinct from operator commits in the same repo.
    let (name, email) = character_git_identity(character);
    let _env = cmd
        .env("GIT_AUTHOR_NAME", &name)
        .env("GIT_AUTHOR_EMAIL", &email)
        .env("GIT_COMMITTER_NAME", &name)
        .env("GIT_COMMITTER_EMAIL", &email);

    if let Some(dir) = workdir {
        _ = cmd.current_dir(dir);
    } else if !workspace_dir.is_empty() {
        _ = cmd.current_dir(workspace_dir);
    } else {
        // No workdir and no workspace root: inherit the daemon's cwd.
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    Ok(json!({
        "subcommand": subcommand,
        "args": args,
        "exit_code": output.status.code(),
        "stdout": stdout,
        "stderr": stderr,
    }))
}

// ---------------------------------------------------------------------------
// Workspace git history
// ---------------------------------------------------------------------------

/// Global `-c` flags that neutralize repo-controlled execution surfaces: a
/// pre-existing (e.g. imported) `.git/config` or `.gitattributes` must not run
/// hooks or filter drivers when git runs. Prepended before the subcommand so
/// they apply to all of them, and passed on the command line so they outrank
/// the repo's own config.
///
/// Every git spawn in this module goes through these — the daemon's own calls
/// via [`run_git`], and the model's via [`handle_git`]. The model cannot inject
/// its own `-c` (the subcommand slot rejects option tokens, and `git config` is
/// denied), so these are the daemon's to set and nobody else's.
const GIT_SAFETY_FLAGS: [&str; 4] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
];

async fn run_git(workspace_dir: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    // Commits additionally pass `--no-verify` (see `git_commit_all`).
    let mut full_args: Vec<&str> = GIT_SAFETY_FLAGS.to_vec();
    full_args.extend_from_slice(args);
    tokio::process::Command::new("git")
        .args(&full_args)
        .current_dir(workspace_dir)
        .output()
        .await
}

fn git_output_err(context: &str, output: &std::process::Output) -> std::io::Error {
    std::io::Error::other(format!(
        "{context}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// The git author/committer identity (name, email) the daemon attributes its
/// own and the model's memory commits to. Deliberately *not* written to the
/// repo's local config: identity is injected per-process only onto git
/// commands the daemon spawns, so an operator's own `git commit` in the same
/// workspace keeps their global identity and stays distinguishable in the log.
pub(crate) fn character_git_identity(character: &str) -> (String, String) {
    let email_local: String = character
        .to_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect();
    (character.to_owned(), format!("{email_local}@shore.local"))
}

/// Ensure the character workspace is a git repository so memory passes can
/// commit their changes. When `.git` is missing, initializes a bare-config
/// repository. Deliberately sets **no** local identity: the daemon injects the
/// character identity per-commit (see `character_git_identity`), leaving an
/// operator's own commits attributed to their global git identity. Pre-existing
/// repositories are left untouched. Returns `true` if a repository was created.
pub async fn ensure_workspace_git_repo(
    workspace_dir: &Path,
    _character: &str,
) -> std::io::Result<bool> {
    if workspace_dir.join(".git").exists() {
        return Ok(false);
    }
    tokio::fs::create_dir_all(workspace_dir).await?;
    let init = run_git(workspace_dir, &["init", "--quiet"]).await?;
    if !init.status.success() {
        return Err(git_output_err("git init failed", &init));
    }
    Ok(true)
}

/// Best-effort wrapper around [`ensure_workspace_git_repo`] for the memory
/// passes (`pass` names the caller in logs). Failures are logged, never
/// fatal: a host without git still gets a full pass, just without history.
pub async fn ensure_workspace_git_repo_best_effort(
    workspace_dir: &Path,
    character: &str,
    pass: &str,
) {
    match ensure_workspace_git_repo(workspace_dir, character).await {
        Ok(true) => {
            tracing::info!(character, pass, "initialized workspace git repository");
        }
        Ok(false) => {}
        Err(e) => tracing::warn!(
            character,
            pass,
            error = %e,
            "failed to ensure workspace git repository"
        ),
    }
}

/// Stage and commit everything in the workspace repository, attributed to the
/// character (identity injected per-commit, not via repo config). Used by the
/// daemon for bookkeeping commits (e.g. recording a compaction rollback) —
/// model-authored commits go through the `git` tool instead. A clean tree is
/// not an error; returns `true` only when a commit was created.
pub async fn git_commit_all(
    workspace_dir: &Path,
    character: &str,
    message: &str,
) -> std::io::Result<bool> {
    if !workspace_dir.join(".git").exists() {
        return Ok(false);
    }
    let add = run_git(workspace_dir, &["add", "--all"]).await?;
    if !add.status.success() {
        return Err(git_output_err("git add failed", &add));
    }
    // `diff --cached --quiet` exits 0 when nothing is staged.
    let staged = run_git(workspace_dir, &["diff", "--cached", "--quiet"]).await?;
    if staged.status.success() {
        return Ok(false);
    }
    // Attribute the commit to the character via `-c` overrides (both author
    // and committer) rather than repo config, so operator commits stay theirs.
    let (name, email) = character_git_identity(character);
    let name_arg = format!("user.name={name}");
    let email_arg = format!("user.email={email}");
    let commit = run_git(
        workspace_dir,
        &[
            "-c",
            &name_arg,
            "-c",
            &email_arg,
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            message,
        ],
    )
    .await?;
    if !commit.status.success() {
        return Err(git_output_err("git commit failed", &commit));
    }
    Ok(true)
}

/// Push the workspace repository to its configured remote, honoring the repo's
/// own push config (remote, branch, upstream). Skips silently when the
/// workspace is not a repo or has no remote configured — the daemon never
/// invents a remote; pushing is opt-in (`[memory] git_push`) to a remote the
/// operator set up. Returns `true` if a push was attempted and succeeded.
pub async fn git_push_workspace(workspace_dir: &Path) -> std::io::Result<bool> {
    if !workspace_dir.join(".git").exists() {
        return Ok(false);
    }
    // No remote → nothing to push to. Skip without noise (a freshly
    // bootstrapped repo has none until the operator adds one).
    let remotes = run_git(workspace_dir, &["remote"]).await?;
    if !remotes.status.success() || String::from_utf8_lossy(&remotes.stdout).trim().is_empty() {
        return Ok(false);
    }
    let push = run_git(workspace_dir, &["push"]).await?;
    if !push.status.success() {
        return Err(git_output_err("git push failed", &push));
    }
    Ok(true)
}

/// Best-effort wrapper around [`git_push_workspace`] for the memory passes.
/// Failures (no upstream, network down, remote rejects) are logged, never
/// fatal — the pass already committed; a failed push must not undo it.
pub async fn git_push_workspace_best_effort(workspace_dir: &Path, character: &str, pass: &str) {
    match git_push_workspace(workspace_dir).await {
        Ok(true) => tracing::info!(character, pass, "pushed workspace memory history"),
        Ok(false) => {}
        Err(e) => tracing::warn!(
            character,
            pass,
            error = %e,
            "failed to push workspace memory history"
        ),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    /// Whether a `git` binary is on PATH. The git-history feature is
    /// best-effort without git, so tests that shell out to it skip cleanly on
    /// minimal hosts rather than failing.
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn tool_defs_count() {
        // read, edit, search, delete, git
        assert_eq!(tool_defs().len(), 5);
        let names: Vec<&str> = tool_defs().iter().map(|d| d.name).collect();
        assert_eq!(names, vec!["read", "edit", "search", "delete", "git"]);
    }

    #[test]
    fn resolve_rejects_traversal() {
        assert!(resolve_path("/tmp/ws", "../etc/passwd").is_err());
        assert!(resolve_path("/tmp/ws", "foo/../../etc/passwd").is_err());
    }

    #[test]
    fn resolve_rejects_absolute() {
        assert!(resolve_path("/tmp/ws", "/etc/passwd").is_err());
    }

    #[test]
    fn resolve_normal_path() {
        let p = resolve_path("/tmp/ws", "notes/ideas.md").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/ws/notes/ideas.md"));
    }

    #[tokio::test]
    async fn write_read_delete_cycle() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        // Write
        let write_result = handle_edit(
            json!({"path": "test.txt", "content": "hello world"}),
            &ws_str,
        )
        .await
        .unwrap();
        assert_eq!(write_result["bytes_written"], 11);

        // Read
        let read_result = handle_read(json!({"path": "test.txt"}), &ws_str)
            .await
            .unwrap();
        assert_eq!(read_result["content"], "hello world");
        assert_eq!(read_result["total_lines"], 1);

        // List
        let list_result = handle_read(json!({}), &ws_str).await.unwrap();
        let entries = list_result["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "test.txt");
    }

    #[tokio::test]
    async fn edit_replaces_text() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "test.txt", "content": "hello world\nfoo bar\n"}),
            &ws_str,
        )
        .await
        .unwrap();

        let edit_result = handle_edit(
            json!({
                "path": "test.txt",
                "edits": [
                    {"old_string": "hello world", "new_string": "goodbye world"}
                ]
            }),
            &ws_str,
        )
        .await
        .unwrap();
        assert_eq!(edit_result["replacements_made"], 1);

        let read_result = handle_read(json!({"path": "test.txt"}), &ws_str)
            .await
            .unwrap();
        assert_eq!(read_result["content"], "goodbye world\nfoo bar\n");
    }

    #[tokio::test]
    async fn edit_replace_all_replaces_every_occurrence() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "test.txt", "content": "foo foo foo"}),
            &ws_str,
        )
        .await
        .unwrap();

        let edit_result = handle_edit(
            json!({
                "path": "test.txt",
                "edits": [
                    {"old_string": "foo", "new_string": "bar", "replace_all": true}
                ]
            }),
            &ws_str,
        )
        .await
        .unwrap();
        assert_eq!(edit_result["replacements_made"], 3);

        let read_result = handle_read(json!({"path": "test.txt"}), &ws_str)
            .await
            .unwrap();
        assert_eq!(read_result["content"], "bar bar bar");
    }

    #[tokio::test]
    async fn edit_fails_on_nonunique_match_without_replace_all() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "test.txt", "content": "foo foo foo"}),
            &ws_str,
        )
        .await
        .unwrap();

        // Without replace_all, a non-unique old_string must error rather than
        // silently rewriting every occurrence.
        let result = handle_edit(
            json!({
                "path": "test.txt",
                "edits": [
                    {"old_string": "foo", "new_string": "bar"}
                ]
            }),
            &ws_str,
        )
        .await;
        assert!(result.is_err(), "non-unique match should error");

        // The file is left untouched.
        let read_result = handle_read(json!({"path": "test.txt"}), &ws_str)
            .await
            .unwrap();
        assert_eq!(read_result["content"], "foo foo foo");
    }

    #[tokio::test]
    async fn edit_fails_on_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "test.txt", "content": "hello world"}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_edit(
            json!({
                "path": "test.txt",
                "edits": [
                    {"old_string": "nonexistent", "new_string": "replaced"}
                ]
            }),
            &ws_str,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn edit_mismatch_with_unicode_content_does_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "test.txt", "content": "🙂".repeat(900)}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_edit(
            json!({
                "path": "test.txt",
                "edits": [
                    {"old_string": "missing", "new_string": "replaced"}
                ]
            }),
            &ws_str,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn write_creates_subdirectories() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "deep/nested/file.txt", "content": "nested"}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_read(json!({"path": "deep/nested/file.txt"}), &ws_str)
            .await
            .unwrap();
        assert_eq!(result["content"], "nested");
    }

    #[tokio::test]
    async fn read_with_offset_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let content = "line1\nline2\nline3\nline4\nline5";
        let _ignored = handle_edit(json!({"path": "test.txt", "content": content}), &ws_str)
            .await
            .unwrap();

        let result = handle_read(
            json!({"path": "test.txt", "offset": 2, "limit": 2}),
            &ws_str,
        )
        .await
        .unwrap();
        assert_eq!(result["content"], "line2\nline3");
        assert_eq!(result["total_lines"], 5);
    }

    #[tokio::test]
    async fn write_and_read_memory_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "memory/people/ren.md", "content": "# Ren\n\nLikes tea."}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_read(json!({"path": "memory/people/ren.md"}), &ws_str)
            .await
            .unwrap();
        assert_eq!(result["content"], "# Ren\n\nLikes tea.");
        assert!(tmp.path().join("workspace/memory/people/ren.md").exists());
    }

    #[test]
    fn search_excerpt_centers_match_and_marks_clipping() {
        let line = format!(
            "{}German Shepherd{}",
            "before ".repeat(140),
            " after".repeat(140)
        );
        let (match_start, match_end) =
            find_case_insensitive_match(&line, "german shepherd").unwrap();

        let excerpt = excerpt_line(&line, match_start, match_end);

        assert!(excerpt.contains("German Shepherd"));
        assert!(excerpt.starts_with("..."));
        assert!(excerpt.ends_with("..."));
        assert!(excerpt.chars().count() <= SEARCH_EXCERPT_CHARS + 6);
    }

    #[test]
    fn search_excerpt_preserves_source_casing() {
        let line = "metadata: the Important Phrase appears here";
        let (match_start, match_end) =
            find_case_insensitive_match(line, "important phrase").unwrap();

        let excerpt = excerpt_line(line, match_start, match_end);

        assert!(excerpt.contains("Important Phrase"));
        assert!(!excerpt.contains("important phrase appears"));
    }

    #[test]
    fn hybrid_excerpt_prefers_relevant_body_line_over_title() {
        let content = "# Christine - Ren's mother\n\nBackground notes mention mother.\n\nMarch note: opioid relapse concerns and a no-contact boundary.";

        let (line_no, excerpt) = best_line_excerpt(content, "christine mother opioid");

        assert_eq!(line_no, 5);
        assert!(excerpt.contains("opioid"));
    }

    #[tokio::test]
    async fn search_finds_workspace_and_memory_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "notes/ideas.md", "content": "Tea in the garden\nCoffee later"}),
            &ws_str,
        )
        .await
        .unwrap();
        _ = handle_edit(
            json!({"path": "memory/people/ren.md", "content": "Ren likes tea."}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_search(json!({"query": "tea"}), &ws_str, None, None, None)
            .await
            .unwrap();
        let results = result["results"].as_array().unwrap();
        let paths: Vec<&str> = results
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"notes/ideas.md"));
        assert!(paths.contains(&"memory/people/ren.md"));
    }

    #[tokio::test]
    async fn search_orders_results_newest_file_first() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "older.md", "content": "tea in the garden"}),
            &ws_str,
        )
        .await
        .unwrap();

        // mtime resolution can be coarse (e.g. 1s on some filesystems), so
        // bump the older file backwards in time rather than relying on the
        // write order alone.
        let past = SystemTime::now() - std::time::Duration::from_mins(1);
        std::fs::File::options()
            .write(true)
            .open(ws.join("older.md"))
            .unwrap()
            .set_modified(past)
            .unwrap();

        _ = handle_edit(
            json!({"path": "newer.md", "content": "tea on the porch"}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_search(json!({"query": "tea"}), &ws_str, None, None, None)
            .await
            .unwrap();
        let results = result["results"].as_array().unwrap();
        let paths: Vec<&str> = results
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["newer.md", "older.md"]);

        let files = result["files"].as_array().expect("files summary present");
        assert_eq!(files[0]["path"], "newer.md");
        assert_eq!(files[1]["path"], "older.md");
        assert!(result["note"].is_string());
    }

    #[tokio::test]
    async fn search_omits_note_when_no_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "notes.md", "content": "nothing relevant"}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_search(json!({"query": "absent"}), &ws_str, None, None, None)
            .await
            .unwrap();
        assert_eq!(result["count"], 0);
        assert!(result.get("note").is_none());
        assert!(result.get("files").is_none());
    }

    #[tokio::test]
    async fn search_excerpt_includes_match_in_long_single_line_file() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();
        let metadata = "metadata ".repeat(200);
        let line = format!(
            r#"{{"metadata":"{metadata}","message":"spotted a German Shepherd near the gate"}}"#
        );

        let _ignored = handle_edit(
            json!({"path": "archive/chat.jsonl", "content": line}),
            &ws_str,
        )
        .await
        .unwrap();

        let result = handle_search(
            json!({"query": "german shepherd"}),
            &ws_str,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let results = result["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["path"], "archive/chat.jsonl");
        assert_eq!(results[0]["line"], 1);
        let excerpt = results[0]["excerpt"].as_str().unwrap();
        assert!(excerpt.contains("German Shepherd"));
        assert!(excerpt.starts_with("..."));
        assert!(excerpt.chars().count() <= SEARCH_EXCERPT_CHARS + 6);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn search_skips_symlinks_pointing_outside_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "notes.md", "content": "no match here"}),
            &ws_str,
        )
        .await
        .unwrap();

        let outside_dir = tmp.path().join("outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let secret = outside_dir.join("secret.md");
        std::fs::write(&secret, "secret_token_xyzzy").unwrap();

        std::os::unix::fs::symlink(&secret, ws.join("link_to_secret.md")).unwrap();
        std::os::unix::fs::symlink(&outside_dir, ws.join("outside_dir")).unwrap();

        let result = handle_search(json!({"query": "xyzzy"}), &ws_str, None, None, None)
            .await
            .unwrap();
        assert_eq!(result["count"], 0, "symlinked file content must not leak");
        let results = result["results"].as_array().unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn search_hybrid_mode_falls_back_to_lexical_without_embedder() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(json!({"path": "notes.md", "content": "tea time"}), &ws_str)
            .await
            .unwrap();

        let result = handle_search(
            json!({"query": "tea", "mode": "hybrid"}),
            &ws_str,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result["mode"], "lexical");
        assert_eq!(result["semantic_unavailable"], "embedder not configured");
        let results = result["results"].as_array().unwrap();
        assert!(!results.is_empty());
    }

    #[tokio::test]
    async fn search_lexical_mode_does_not_set_semantic_unavailable() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(json!({"path": "notes.md", "content": "tea time"}), &ws_str)
            .await
            .unwrap();

        let result = handle_search(
            json!({"query": "tea", "mode": "lexical"}),
            &ws_str,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result["mode"], "lexical");
        assert!(result.get("semantic_unavailable").is_none());
    }

    struct DummyEmbedder;

    #[async_trait]
    impl Embedder for DummyEmbedder {
        async fn embed(&self, inputs: &[&str]) -> Result<Vec<Vec<f32>>, shore_llm::LlmError> {
            let dim = self.dimensions().unwrap_or(4);
            Ok(inputs.iter().map(|_| vec![0.0; dim]).collect())
        }

        fn model_id(&self) -> &'static str {
            "dummy"
        }

        fn dimensions(&self) -> Option<usize> {
            Some(4)
        }
    }

    #[tokio::test]
    async fn search_with_path_runs_hybrid_scoped_to_subtree() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "notes/a.md", "content": "tea time"}),
            &ws_str,
        )
        .await
        .unwrap();
        _ = handle_edit(
            json!({"path": "other/b.md", "content": "tea ceremony"}),
            &ws_str,
        )
        .await
        .unwrap();

        let embedder = DummyEmbedder;
        let idx = tmp.path().join("index.json");

        let result = handle_search(
            json!({"query": "tea", "path": "notes/"}),
            &ws_str,
            None,
            Some(&embedder),
            Some(&idx),
        )
        .await
        .unwrap();

        assert_eq!(result["mode"], "hybrid");
        assert!(result.get("semantic_unavailable").is_none());
        let results = result["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["path"], "notes/a.md");
    }

    #[tokio::test]
    async fn search_rejects_unknown_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(json!({"path": "notes.md", "content": "tea time"}), &ws_str)
            .await
            .unwrap();

        let result = handle_search(
            json!({"query": "tea", "mode": "magic"}),
            &ws_str,
            None,
            None,
            None,
        )
        .await;

        match result {
            Err(ToolError::InvalidArgs(msg)) => assert!(
                msg.contains("magic"),
                "expected error to mention the bad mode, got: {msg}"
            ),
            other => panic!("expected InvalidArgs, got {other:?}"),
        }
    }

    /// A workspace with an initialized git repo and one committed file.
    async fn git_workspace() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let _created = ensure_workspace_git_repo(&ws, "test").await.unwrap();
        tokio::fs::write(ws.join("note.md"), "tea").await.unwrap();
        (tmp, ws_str)
    }

    #[tokio::test]
    async fn git_runs_subcommand_in_workspace() {
        if !git_available() {
            return;
        }
        let (_tmp, ws_str) = git_workspace().await;

        let result = handle_git(
            json!({"subcommand": "status", "args": ["--porcelain"]}),
            &ws_str,
            "test",
        )
        .await
        .unwrap();

        assert_eq!(result["exit_code"], 0);
        assert_eq!(result["subcommand"], "status");
        let stdout = result["stdout"].as_str().unwrap();
        assert!(
            stdout.contains("note.md"),
            "expected untracked note.md in status output: {stdout}"
        );
    }

    /// A character offered `git` on the chat path meets a workspace that no
    /// memory pass has touched yet. Note this deliberately does NOT use
    /// `git_workspace()` — that helper inits the repo, which is precisely what
    /// hid this from every other test here.
    #[tokio::test]
    async fn git_initializes_a_workspace_that_is_not_yet_a_repo() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        assert!(!ws.join(".git").exists(), "precondition: bare workspace");

        let result = handle_git(json!({"subcommand": "status"}), &ws_str, "test")
            .await
            .unwrap();

        assert_eq!(
            result["exit_code"], 0,
            "git must not report 'not a git repository': {:?}",
            result["stderr"]
        );
        assert!(ws.join(".git").exists(), "repository must be initialized");
    }

    /// An operator can import a repository that already carries hooks. Those
    /// hooks are arbitrary code the daemon never approved, and the model must
    /// not be able to trigger them just by committing its memory.
    #[tokio::test]
    async fn git_commit_does_not_run_repository_hooks() {
        if !git_available() {
            return;
        }
        let (_tmp, ws_str) = git_workspace().await;
        let hooks = PathBuf::from(&ws_str).join(".git/hooks");
        tokio::fs::create_dir_all(&hooks).await.unwrap();
        let hook = hooks.join("pre-commit");
        // A hook that fails loudly: if it runs, the commit dies with its marker.
        tokio::fs::write(&hook, "#!/bin/sh\necho HOOK_RAN >&2\nexit 1\n")
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            tokio::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
        }

        let _add = handle_git(
            json!({"subcommand": "add", "args": ["note.md"]}),
            &ws_str,
            "test",
        )
        .await
        .unwrap();
        let commit = handle_git(
            json!({"subcommand": "commit", "args": ["-m", "save"]}),
            &ws_str,
            "test",
        )
        .await
        .unwrap();

        assert_eq!(
            commit["exit_code"], 0,
            "commit must succeed with the hook neutralized: {commit:?}"
        );
        assert!(
            !commit["stderr"].as_str().unwrap().contains("HOOK_RAN"),
            "repository hook must not execute: {:?}",
            commit["stderr"]
        );
    }

    #[tokio::test]
    async fn git_omitted_args_defaults_to_empty() {
        if !git_available() {
            return;
        }
        let (_tmp, ws_str) = git_workspace().await;

        let result = handle_git(json!({"subcommand": "status"}), &ws_str, "test")
            .await
            .unwrap();
        assert_eq!(result["exit_code"], 0);
        assert_eq!(result["args"], json!([]));
    }

    #[tokio::test]
    async fn git_commit_is_attributed_to_the_character() {
        if !git_available() {
            return;
        }
        let (_tmp, ws_str) = git_workspace().await;

        let add = handle_git(
            json!({"subcommand": "add", "args": ["note.md"]}),
            &ws_str,
            "qifei",
        )
        .await
        .unwrap();
        assert_eq!(add["exit_code"], 0);

        let commit = handle_git(
            json!({"subcommand": "commit", "args": ["-m", "save note"]}),
            &ws_str,
            "qifei",
        )
        .await
        .unwrap();
        assert_eq!(commit["exit_code"], 0);

        let log = handle_git(
            json!({"subcommand": "log", "args": ["-1", "--format=%an <%ae>"]}),
            &ws_str,
            "qifei",
        )
        .await
        .unwrap();
        assert_eq!(
            log["stdout"].as_str().unwrap().trim(),
            "qifei <qifei@shore.local>"
        );
    }

    /// The subcommand slot only ever holds a subcommand, so git's global
    /// ACE-injection flags have nowhere to land.
    #[tokio::test]
    async fn git_rejects_global_flags_in_the_subcommand_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        for sub in [
            "-c",
            "--exec-path=/tmp/evil",
            "--git-dir=/tmp/other",
            "-C",
            "--work-tree=/tmp",
        ] {
            let result = handle_git(json!({"subcommand": sub}), &ws_str, "test").await;
            assert!(
                result.is_err(),
                "'{sub}' must be rejected as a subcommand, not run as a global flag"
            );
        }
    }

    #[tokio::test]
    async fn git_rejects_empty_and_path_subcommands() {
        let tmp = tempfile::tempdir().unwrap();
        let ws_str = tmp.path().to_string_lossy().to_string();

        assert!(handle_git(json!({"subcommand": ""}), &ws_str, "test")
            .await
            .is_err());
        assert!(
            handle_git(json!({"subcommand": "/usr/bin/git"}), &ws_str, "test")
                .await
                .is_err()
        );
        assert!(handle_git(json!({}), &ws_str, "test").await.is_err());
    }

    #[tokio::test]
    async fn git_rejects_destructive_subcommands() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        for (sub, args) in [
            ("push", vec![]),
            ("config", vec!["user.name", "someone"]),
            ("reset", vec!["--hard"]),
            ("rebase", vec!["-i"]),
            ("restore", vec!["note.md"]),
            ("clean", vec!["-fd"]),
            ("gc", vec![]),
        ] {
            let result =
                handle_git(json!({"subcommand": sub, "args": args}), &ws_str, "test").await;
            assert!(result.is_err(), "git {sub} must be refused");
        }
    }

    #[tokio::test]
    async fn git_rejects_absolute_path_argument() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        let result = handle_git(
            json!({"subcommand": "add", "args": ["/etc/passwd"]}),
            &ws_str,
            "test",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn git_rejects_parent_path_argument() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        let result = handle_git(
            json!({"subcommand": "add", "args": ["../outside.md"]}),
            &ws_str,
            "test",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn git_rejects_equals_absolute_path_argument() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        let result = handle_git(
            json!({"subcommand": "log", "args": ["--output=/tmp/leak.txt"]}),
            &ws_str,
            "test",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn git_rejects_absolute_workdir() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        let result = handle_git(
            json!({"subcommand": "status", "workdir": "/tmp"}),
            &ws_str,
            "test",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn git_rejects_non_string_args() {
        let tmp = tempfile::tempdir().unwrap();
        let ws_str = tmp.path().to_string_lossy().to_string();

        assert!(
            handle_git(json!({"subcommand": "log", "args": [1]}), &ws_str, "test")
                .await
                .is_err()
        );
        assert!(
            handle_git(json!({"subcommand": "log", "args": "-1"}), &ws_str, "test")
                .await
                .is_err()
        );
    }

    /// A shell metacharacter is just a literal argument: there is no shell, so
    /// `; rm -rf` reaches git as an ordinary (unmatched) pathspec and nothing
    /// is executed. git is content to exit 0 on a pathspec that matches
    /// nothing — the proof is that the workspace survives, not the exit code.
    #[tokio::test]
    async fn git_does_not_interpret_shell_syntax() {
        if !git_available() {
            return;
        }
        let (_tmp, ws_str) = git_workspace().await;
        let note = PathBuf::from(&ws_str).join("note.md");

        let result = handle_git(
            json!({"subcommand": "status", "args": ["; rm -rf ."]}),
            &ws_str,
            "test",
        )
        .await
        .unwrap();

        assert!(
            result["stdout"].as_str().is_some_and(|s| !s.contains("rm")),
            "the argument must be passed to git, not run: {:?}",
            result["stdout"]
        );
        assert!(note.exists(), "workspace file must survive");
        assert!(
            PathBuf::from(&ws_str).join(".git").exists(),
            "repository must survive"
        );
    }

    #[tokio::test]
    async fn git_allows_workspace_relative_path_arguments() {
        if !git_available() {
            return;
        }
        let (_tmp, ws_str) = git_workspace().await;

        let result = handle_git(
            json!({"subcommand": "add", "args": ["note.md"]}),
            &ws_str,
            "test",
        )
        .await
        .unwrap();
        assert_eq!(result["exit_code"], 0);
    }

    #[tokio::test]
    async fn git_with_workdir() {
        if !git_available() {
            return;
        }
        let (_tmp, ws_str) = git_workspace().await;
        tokio::fs::create_dir_all(PathBuf::from(&ws_str).join("subdir"))
            .await
            .unwrap();

        let result = handle_git(
            json!({"subcommand": "rev-parse", "args": ["--show-toplevel"], "workdir": "subdir"}),
            &ws_str,
            "test",
        )
        .await
        .unwrap();
        assert_eq!(result["exit_code"], 0);
    }

    #[tokio::test]
    async fn delete_moves_file_to_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();
        let data_dir = tmp.path().join("data");
        let data_str = data_dir.to_string_lossy().to_string();

        let _ignored = handle_edit(json!({"path": "notes/old.md", "content": "stale"}), &ws_str)
            .await
            .unwrap();

        let result = handle_delete(json!({"path": "notes/old.md"}), &ws_str, &data_str)
            .await
            .unwrap();
        assert_eq!(result["deleted"], true);
        assert_eq!(result["path"], "notes/old.md");

        assert!(!ws.join("notes/old.md").exists(), "file should be moved");
        let trash = data_dir.join("trash");
        assert!(trash.exists(), "trash directory should exist");

        let mut found = None;
        for entry in std::fs::read_dir(&trash).unwrap() {
            let dir_entry = entry.unwrap();
            let candidate = dir_entry.path().join("notes/old.md");
            if candidate.exists() {
                found = Some(candidate);
                break;
            }
        }
        let trashed = found.expect("trashed file should exist under timestamped folder");
        assert_eq!(std::fs::read_to_string(trashed).unwrap(), "stale");
    }

    #[tokio::test]
    async fn delete_preserves_memory_namespace_under_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();
        let data_dir = tmp.path().join("data");
        let data_str = data_dir.to_string_lossy().to_string();

        let _ignored = handle_edit(
            json!({"path": "memory/people/ren.md", "content": "Ren"}),
            &ws_str,
        )
        .await
        .unwrap();

        _ = handle_delete(json!({"path": "memory/people/ren.md"}), &ws_str, &data_str)
            .await
            .unwrap();

        assert!(!ws.join("memory/people/ren.md").exists());
        let trash = data_dir.join("trash");
        let mut paths = Vec::new();
        for entry in std::fs::read_dir(&trash).unwrap() {
            let dir_entry = entry.unwrap();
            paths.push(dir_entry.path().join("memory/people/ren.md"));
        }
        assert!(
            paths.iter().any(|p| p.exists()),
            "memory file should land under trash/<ts>/memory/people/ren.md"
        );
    }

    #[tokio::test]
    async fn delete_rejects_protected_files() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();
        let data_dir = tmp.path().join("data");
        let data_str = data_dir.to_string_lossy().to_string();

        let _ignored = handle_edit(json!({"path": "SOUL.md", "content": "soul"}), &ws_str)
            .await
            .unwrap();
        _ = handle_edit(json!({"path": "MEMORY.md", "content": "idx"}), &ws_str)
            .await
            .unwrap();

        for path in [
            "SOUL.md",
            "USER.md",
            "AGENTS.md",
            "TOOLS.md",
            "MEMORY.md",
            "workspace/SOUL.md",
        ] {
            let result = handle_delete(json!({"path": path}), &ws_str, &data_str).await;
            assert!(result.is_err(), "delete must refuse {path}");
        }

        assert!(ws.join("SOUL.md").exists(), "SOUL.md must remain in place");
    }

    #[tokio::test]
    async fn delete_rejects_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let data_str = tmp.path().join("data").to_string_lossy().to_string();

        let result = handle_delete(json!({"path": "ghost.md"}), &ws_str, &data_str).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn delete_rejects_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(ws.join("notes")).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let data_str = tmp.path().join("data").to_string_lossy().to_string();

        let result = handle_delete(json!({"path": "notes"}), &ws_str, &data_str).await;
        assert!(result.is_err(), "delete must refuse directories");
        assert!(ws.join("notes").exists(), "directory must remain");
    }

    #[tokio::test]
    async fn delete_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let data_str = tmp.path().join("data").to_string_lossy().to_string();

        let result = handle_delete(json!({"path": "../escape.md"}), &ws_str, &data_str).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn delete_rejects_when_data_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _ignored = handle_edit(json!({"path": "foo.md", "content": "x"}), &ws_str)
            .await
            .unwrap();

        let result = handle_delete(json!({"path": "foo.md"}), &ws_str, "").await;
        assert!(result.is_err());
        assert!(ws.join("foo.md").exists(), "file should not be moved");
    }

    #[tokio::test]
    async fn search_skips_git_object_store() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _written = handle_edit(
            json!({"path": "note.md", "content": "jasmine tea preferences"}),
            &ws_str,
        )
        .await
        .unwrap();
        std::fs::create_dir_all(ws.join(".git")).unwrap();
        std::fs::write(ws.join(".git").join("config"), "jasmine tea in git state").unwrap();

        let result = handle_search(json!({"query": "jasmine"}), &ws_str, None, None, None)
            .await
            .unwrap();
        assert_eq!(result["count"], 1, "git internals must not be searched");
        assert_eq!(result["results"][0]["path"], "note.md");
    }

    #[tokio::test]
    async fn search_skips_git_worktree_file() {
        // A linked worktree exposes `.git` as a FILE (`gitdir: /abs/path`),
        // not a directory — it must still be skipped so the absolute path
        // doesn't leak into search results.
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let _written = handle_edit(
            json!({"path": "note.md", "content": "jasmine tea preferences"}),
            &ws_str,
        )
        .await
        .unwrap();
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join(".git"), "gitdir: /home/jasmine/secret/path\n").unwrap();

        let result = handle_search(json!({"query": "jasmine"}), &ws_str, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            result["count"], 1,
            "worktree .git file must not be searched"
        );
        assert_eq!(result["results"][0]["path"], "note.md");
    }

    #[tokio::test]
    async fn ensure_workspace_git_repo_initializes_once() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");

        let created = ensure_workspace_git_repo(&ws, "Test Char").await.unwrap();
        assert!(created);
        assert!(ws.join(".git").exists());

        // No *local* identity is written — so an operator's own commits keep
        // their global identity. (`--local` errors when the key is unset.)
        let local = run_git(&ws, &["config", "--local", "user.name"])
            .await
            .unwrap();
        assert!(
            !local.status.success(),
            "ensure_workspace_git_repo must not set a local identity"
        );

        // Daemon commits are still attributed to the character via per-commit
        // injection (works even with no local/global identity configured).
        std::fs::write(ws.join("note.md"), "hi").unwrap();
        let _committed = git_commit_all(&ws, "Test Char", "first").await.unwrap();
        let author = run_git(&ws, &["log", "-1", "--format=%an <%ae>"])
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&author.stdout).trim(),
            "Test Char <test-char@shore.local>"
        );

        // Second call is a no-op on the existing repo.
        let created_again = ensure_workspace_git_repo(&ws, "Test Char").await.unwrap();
        assert!(!created_again);
    }

    #[tokio::test]
    async fn git_commit_all_commits_and_skips_clean_tree() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");

        // No repo: silently does nothing.
        assert!(!git_commit_all(&ws, "test", "noop").await.unwrap());

        let _created = ensure_workspace_git_repo(&ws, "test").await.unwrap();
        std::fs::write(ws.join("note.md"), "hello").unwrap();
        assert!(git_commit_all(&ws, "test", "first commit").await.unwrap());

        // Clean tree: no commit, no error.
        assert!(!git_commit_all(&ws, "test", "empty").await.unwrap());

        let log = run_git(&ws, &["log", "--format=%s"]).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "first commit");
    }

    #[tokio::test]
    async fn git_push_workspace_skips_and_pushes() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");

        // No repo: silently does nothing.
        assert!(!git_push_workspace(&ws).await.unwrap());

        let _created = ensure_workspace_git_repo(&ws, "test").await.unwrap();
        std::fs::write(ws.join("note.md"), "hello").unwrap();
        let _committed = git_commit_all(&ws, "test", "first").await.unwrap();

        // Repo but no remote configured: skip without error.
        assert!(!git_push_workspace(&ws).await.unwrap());

        // Add a bare remote and an upstream, then push reaches it.
        let bare = tmp.path().join("remote.git");
        let init_bare = run_git(tmp.path(), &["init", "--quiet", "--bare", "remote.git"])
            .await
            .unwrap();
        assert!(init_bare.status.success());
        let add_remote = run_git(&ws, &["remote", "add", "origin", &bare.to_string_lossy()])
            .await
            .unwrap();
        assert!(add_remote.status.success());
        // Establish upstream so a bare `git push` knows where to go.
        let set_upstream = run_git(&ws, &["push", "-u", "origin", "HEAD"])
            .await
            .unwrap();
        assert!(set_upstream.status.success());
        // A subsequent commit + bare push lands on the remote.
        std::fs::write(ws.join("note.md"), "updated").unwrap();
        let _second = git_commit_all(&ws, "test", "second").await.unwrap();
        assert!(git_push_workspace(&ws).await.unwrap());

        let remote_log = run_git(&bare, &["log", "--format=%s"]).await.unwrap();
        let log = String::from_utf8_lossy(&remote_log.stdout);
        assert!(
            log.contains("second"),
            "remote should have the pushed commit"
        );
    }

    // -- git subcommand validation -------------------------------------------

    /// Validate a `{subcommand, args}` pair exactly as [`handle_git`] does:
    /// the subcommand-token guard, then the destructive denylist.
    fn vg(subcommand: &str, args: &[&str]) -> Result<(), ToolError> {
        validate_git_subcommand_token(subcommand)?;
        let mut sub: Vec<String> = vec![subcommand.to_owned()];
        sub.extend(args.iter().map(|a| (*a).to_owned()));
        validate_git_subcommand(&sub)
    }

    fn vg_ok(subcommand: &str, args: &[&str]) {
        vg(subcommand, args)
            .unwrap_or_else(|e| panic!("expected Ok for git {subcommand} {args:?}: {e}"));
    }

    fn vg_err(subcommand: &str, args: &[&str]) {
        assert!(
            vg(subcommand, args).is_err(),
            "expected Err for: git {subcommand} {args:?}"
        );
    }

    #[test]
    fn git_validate_allows_basic_commands() {
        vg_ok("status", &[]);
        vg_ok("add", &["memory/foo.md"]);
        // "reset" inside a message must not trip the reset rule.
        vg_ok("commit", &["-m", "reset the counter"]);
        // push is daemon-only; see git_validate_blocks_destructive
        vg_ok("checkout", &["main"]);
        vg_ok("checkout", &["-b", "topic"]);
        // Branch creation from a start point: two operands, still not a pathspec.
        vg_ok("checkout", &["-b", "topic", "origin/main"]);
        vg_ok("remote", &["-v"]);
        vg_ok("log", &["--oneline"]);
        vg_ok("diff", &[]);
        vg_ok("branch", &[]);
        vg_ok("stash", &[]);
        vg_ok("tag", &["-l"]);
        vg_ok("reflog", &[]);
        vg_ok("merge", &["feature"]);
        vg_ok("blame", &["README.md"]);
        vg_ok("show", &["HEAD"]);
        vg_ok("rev-parse", &["HEAD"]);
    }

    #[test]
    fn git_validate_blocks_destructive() {
        vg_err("reset", &["--hard", "HEAD~3"]);
        vg_err("clean", &["-fdx"]);
        vg_err("rebase", &["main"]);
        vg_err("config", &["alias.x", "!sh"]);
        vg_err("remote", &["add", "origin", "git@x:y"]);
        vg_err("push", &["--force"]);
        vg_err("push", &["origin", "main"]); // all push is daemon-only, even plain push
        vg_err("push", &[]);
        // Remote access is daemon-only in both directions, not just outbound.
        vg_err("fetch", &[]);
        vg_err("fetch", &["origin", "main"]);
        vg_err("pull", &[]);
        vg_err("pull", &["--rebase", "origin", "main"]);
        vg_err("clone", &["https://example.com/x.git"]);
        vg_err("branch", &["-D", "main"]);
        vg_err("restore", &["."]);
        vg_err("gc", &[]);
        vg_err("reflog", &["expire", "--all"]);
        vg_err("filter-branch", &["--tree-filter", "rm secrets", "HEAD"]);
        vg_err("filter-repo", &["--path", "secrets"]);
        vg_err("reset", &["--merge", "HEAD~1"]);
        vg_err("reset", &["--keep", "HEAD~1"]);
        vg_err("checkout", &["-f", "main"]);
        vg_err("checkout", &["--force", "other"]);
        // The pathspec forms discard working-tree changes exactly as `restore`
        // does, and `restore` is denied outright — deny these too.
        vg_err("checkout", &["--", "note.md"]);
        vg_err("checkout", &["HEAD", "--", "note.md"]);
        vg_err("checkout", &["HEAD", "note.md"]);
        vg_err("checkout", &["main", "memory/people/ren.md"]);
        vg_err("switch", &["-f", "topic"]);
        vg_err("switch", &["--force", "topic"]);
        vg_err("switch", &["--discard-changes", "topic"]);
        vg_err("branch", &["-d", "old"]);
        vg_err("branch", &["--delete", "old"]);
        vg_err("tag", &["-d", "v1"]);
        vg_err("tag", &["--delete", "v1"]);
        vg_err("stash", &["drop"]);
        vg_err("stash", &["clear"]);
        vg_err("stash", &["pop"]);
        vg_err("reflog", &["delete", "HEAD@{1}"]);
        vg_err("update-ref", &["-d", "refs/heads/bad"]);
        vg_err("update-ref", &["--delete", "refs/heads/bad"]);
        vg_err("push", &["--force-with-lease"]);
        vg_err("push", &["--delete", "origin", "bad"]);
        vg_err("remote", &["set-url", "origin", "git@x:z"]);
        vg_err("remote", &["rename", "origin", "upstream"]);
        vg_err("remote", &["remove", "origin"]);
        vg_err("remote", &["rm", "origin"]);
        vg_err("clean", &["-fd"]);
        vg_err("clean", &["-xd"]);
        vg_err("clean", &["-X"]);
        vg_err("clean", &["-xdf"]);
    }

    /// The global ACE-injection flags that `validate_git_command` used to hunt
    /// for in an argv stream. The structured shape retires that walk: a global
    /// flag can only arrive in the subcommand slot, where the token guard
    /// refuses it outright.
    #[test]
    fn git_validate_blocks_global_flags_as_subcommands() {
        vg_err("-c", &["core.pager=!sh", "log"]);
        vg_err("-c", &["status"]);
        vg_err("--exec-path=.", &["foo"]);
        vg_err("--config-env=GIT_CONFIG", &["env", "status"]);
        vg_err("--git-dir=/tmp/other", &["status"]);
        vg_err("--work-tree=/tmp", &["status"]);
        vg_err("-C", &["/tmp", "status"]);
    }

    // -- reject_git_internal_path --------------------------------------------

    fn rgip_err(path: &str) {
        assert!(
            reject_git_internal_path(path).is_err(),
            "expected Err for path: {path}"
        );
    }

    fn rgip_ok(path: &str) {
        reject_git_internal_path(path).unwrap();
    }

    #[test]
    fn reject_git_internal_blocks_dot_git() {
        rgip_err(".git/config");
        rgip_err(".git/hooks/pre-commit");
        rgip_err("workspace/.git/hooks/x");
        rgip_err(".git/objects/ab/cdef1234");
    }

    #[test]
    fn reject_git_internal_allows_normal_paths() {
        rgip_ok("memory/note.md");
        rgip_ok(".gitignore");
        rgip_ok("MEMORY.md");
        rgip_ok(".gitattributes");
        rgip_ok("notes/.git.md");
        rgip_ok("workspace/notes.md");
        rgip_ok("memory/people/ren.md");
    }

    #[tokio::test]
    async fn handle_write_rejects_dot_git_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let result = handle_edit(
            json!({"path": ".git/hooks/pre-commit", "content": "#!/bin/sh\necho hacked"}),
            &ws_str,
        )
        .await;
        assert!(result.is_err(), "write to .git/ must be rejected");
        assert!(
            !ws.join(".git/hooks/pre-commit").exists(),
            ".git file must not be created"
        );
    }

    #[tokio::test]
    async fn handle_edit_rejects_dot_git_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();

        let result = handle_edit(
            json!({
                "path": ".git/config",
                "edits": [{"old_string": "foo", "new_string": "bar"}]
            }),
            &ws_str,
        )
        .await;
        assert!(result.is_err(), "edit of .git/ must be rejected");
    }

    #[tokio::test]
    async fn handle_delete_rejects_dot_git_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        let ws_str = ws.to_string_lossy().to_string();
        let data_str = tmp.path().join("data").to_string_lossy().to_string();

        let result = handle_delete(json!({"path": ".git/HEAD"}), &ws_str, &data_str).await;
        assert!(result.is_err(), "delete of .git/ must be rejected");
    }
}
