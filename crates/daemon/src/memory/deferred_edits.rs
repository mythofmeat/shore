use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use shore_common::config::{
    character_config_dir, character_memory_dir, character_workspace_dir, character_workspace_file,
    AGENTS_FILE, SOUL_FILE, TOOLS_FILE, USER_FILE,
};

/// Top-level workspace files that are editable immediately but only become
/// prompt-active after the next compaction/reload boundary.
const PROTECTED_PATHS: &[&str] = &[SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE];

/// Persisted snapshot directory under the character data dir.
const ACTIVE_PROMPT_DIR: &str = "active_prompt";

/// Prompt-visible memory index, maintained at the workspace root alongside
/// the other top-level prompt files (SOUL.md, USER.md, AGENTS.md, etc.).
pub const MEMORY_INDEX_FILE: &str = "MEMORY.md";
pub const MEMORY_INDEX_DEFERRED_PATH: &str = "MEMORY.md";

/// Stale active-prompt snapshots left behind by retired prompt files: the
/// pre-rename `<recent_memory>` block, and `HEARTBEAT.md` from before heartbeat
/// carry-forward folded into `MEMORY.md`. Cleaned up opportunistically when the
/// active prompt directory is (re)seeded so they don't accumulate forever.
const LEGACY_SNAPSHOTS: &[&str] = &["RECENT_MEMORY.md", "HEARTBEAT.md"];

const DEFAULT_TOOLS_GUIDANCE: &str = "\
# TOOLS

Use tools when they materially help.

- Read files before editing them.
- Search memory files before guessing facts about the user or past events.
- Prefer concise, direct tool use over busywork.
";

/// **Ported.** `normalize_workspace_path`, `normalize_protected_path`,
/// `normalize_prompt_visible_path` and the active-prompt path helpers now live
/// in `llm-sidecar/src/tools/workspace_path.ts`, pinned by
/// `llm-sidecar/tests/engine_fixtures/subagent_parity.json`.
fn normalize_workspace_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");

    // Strip any combination of leading separators, "./", and "workspace/"
    // segments until none apply. A single pass missed inputs like
    // "workspace/./SOUL.md" (./ only checked before workspace/) and
    // "./workspace/SOUL.md", letting them slip past the protected-path guard.
    loop {
        let before = normalized.len();
        while normalized.starts_with('/') {
            let _ignored = normalized.remove(0);
        }
        while let Some(rest) = normalized.strip_prefix("./") {
            normalized = rest.to_owned();
        }
        if let Some(rest) = normalized.strip_prefix("workspace/") {
            normalized = rest.to_owned();
        }
        if normalized.len() == before {
            break;
        }
    }

    normalized
}

/// Normalize a workspace path to one of the protected workspace-root files.
pub fn normalize_protected_path(path: &str) -> Option<String> {
    let normalized = normalize_workspace_path(path);

    PROTECTED_PATHS
        .iter()
        .any(|&protected| normalized == protected)
        .then_some(normalized)
}

pub fn is_protected_path(path: &str) -> bool {
    normalize_protected_path(path).is_some()
}

/// Normalize a path whose canonical content is prompt-visible only after the
/// next compaction/reload boundary.
pub fn normalize_prompt_visible_path(path: &str) -> Option<String> {
    let normalized = normalize_workspace_path(path);
    if let Some(protected) = normalize_protected_path(&normalized) {
        return Some(protected);
    }
    if normalized == MEMORY_INDEX_DEFERRED_PATH {
        return Some(MEMORY_INDEX_DEFERRED_PATH.to_owned());
    }
    None
}

pub fn is_prompt_visible_path(path: &str) -> bool {
    normalize_prompt_visible_path(path).is_some()
}

pub fn active_prompt_dir(character_data_dir: &Path) -> PathBuf {
    character_data_dir.join(ACTIVE_PROMPT_DIR)
}

pub fn active_prompt_file(character_data_dir: &Path, name: &str) -> PathBuf {
    active_prompt_dir(character_data_dir).join(name)
}

pub fn memory_index_path(config_dir: &Path, char_name: &str) -> PathBuf {
    character_workspace_dir(config_dir, char_name).join(MEMORY_INDEX_FILE)
}

pub fn load_memory_index(
    character_data_dir: &Path,
    config_dir: &Path,
    char_name: &str,
) -> Option<String> {
    let active = active_prompt_file(character_data_dir, MEMORY_INDEX_FILE);
    if active.exists() {
        return fs::read_to_string(active)
            .ok()
            .filter(|content| !content.trim().is_empty());
    }

    fs::read_to_string(memory_index_path(config_dir, char_name))
        .ok()
        .filter(|content| !content.trim().is_empty())
}

fn canonical_prompt_visible_file(config_dir: &Path, char_name: &str, path: &str) -> PathBuf {
    if path == MEMORY_INDEX_DEFERRED_PATH {
        return memory_index_path(config_dir, char_name);
    }
    character_workspace_file(config_dir, char_name, path)
}

fn active_prompt_snapshot_name(path: &str) -> &str {
    if path == MEMORY_INDEX_DEFERRED_PATH {
        MEMORY_INDEX_FILE
    } else {
        path
    }
}

fn copy_prompt_visible_file(
    character_data_dir: &Path,
    config_dir: &Path,
    char_name: &str,
    path: &str,
    seed_only: bool,
) -> io::Result<()> {
    let active_dir = active_prompt_dir(character_data_dir);
    fs::create_dir_all(&active_dir)?;

    let src = canonical_prompt_visible_file(config_dir, char_name, path);
    let dst = active_dir.join(active_prompt_snapshot_name(path));

    if seed_only && dst.exists() {
        return Ok(());
    }

    if src.exists() {
        let _ignored = fs::copy(src, dst)?;
    } else if !seed_only && dst.exists() {
        fs::remove_file(dst)?;
    } else {
        // No source and nothing to remove: leave the snapshot as-is.
    }
    Ok(())
}

fn ensure_deferred_memory_index_sentinel(character_data_dir: &Path) -> io::Result<()> {
    let dst = active_prompt_file(character_data_dir, MEMORY_INDEX_FILE);
    if dst.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(dst, "")
}

pub fn note_memory_index_deferred(character_data_dir: &Path) -> io::Result<()> {
    queue_deferred_edit(character_data_dir, MEMORY_INDEX_DEFERRED_PATH)
}

pub fn load_canonical_memory_index(config_dir: &Path, char_name: &str) -> Option<String> {
    fs::read_to_string(memory_index_path(config_dir, char_name))
        .ok()
        .filter(|content| !content.trim().is_empty())
}

pub fn load_active_prompt_file(character_data_dir: &Path, name: &str) -> Option<String> {
    fs::read_to_string(active_prompt_file(character_data_dir, name))
        .ok()
        .filter(|content| !content.trim().is_empty())
}

/// Return deduped protected paths waiting for activation.
pub fn pending_deferred_edit_paths(character_data_dir: &Path) -> io::Result<Vec<String>> {
    let queue_path = character_data_dir.join("deferred_edits.jsonl");
    if !queue_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(queue_path)?;
    let mut paths = BTreeSet::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let entry: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(path) = entry
            .get("path")
            .and_then(|v| v.as_str())
            .and_then(normalize_prompt_visible_path)
        {
            let _ignored = paths.insert(path);
        }
    }
    Ok(paths.into_iter().collect())
}

/// Queue a deferred refresh for a prompt-visible file.
pub fn queue_deferred_edit(character_data_dir: &Path, requested_path: &str) -> io::Result<()> {
    let Some(path) = normalize_prompt_visible_path(requested_path) else {
        return Ok(());
    };

    fs::create_dir_all(character_data_dir)?;
    if path == MEMORY_INDEX_DEFERRED_PATH {
        ensure_deferred_memory_index_sentinel(character_data_dir)?;
    }
    let queue_path = character_data_dir.join("deferred_edits.jsonl");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&queue_path)?;
    let line = serde_json::json!({
        "path": path,
        "timestamp": chrono::Local::now().to_rfc3339(),
    });
    writeln!(file, "{line}")?;
    Ok(())
}

/// Effective prompt-visible content of a file: present and non-blank, matching
/// the load semantics of [`load_active_prompt_file`] / [`load_memory_index`].
fn effective_content(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .filter(|content| !content.trim().is_empty())
}

/// Report which prompt-visible files would change if the active prompt
/// snapshot were refreshed from the canonical config workspace right now.
///
/// Compares effective content (missing and blank are equivalent), but any
/// byte-level difference between two non-blank versions counts — the provider
/// prompt cache is keyed on exact bytes.
pub fn changed_prompt_files(
    character_data_dir: &Path,
    config_dir: &Path,
    char_name: &str,
) -> Vec<String> {
    let mut changed = Vec::new();
    let paths = PROTECTED_PATHS
        .iter()
        .copied()
        .chain(std::iter::once(MEMORY_INDEX_DEFERRED_PATH));
    for path in paths {
        let canonical = canonical_prompt_visible_file(config_dir, char_name, path);
        let active = active_prompt_file(character_data_dir, active_prompt_snapshot_name(path));
        if effective_content(&canonical) != effective_content(&active) {
            changed.push(path.to_owned());
        }
    }
    changed
}

/// Refresh the active prompt snapshot from the canonical config workspace and
/// clear any deferred-edit queue.
pub fn apply_deferred_edits(
    character_data_dir: &Path,
    config_dir: &Path,
    char_name: &str,
) -> io::Result<()> {
    refresh_active_prompt_snapshot(character_data_dir, config_dir, char_name)?;

    let queue_path = character_data_dir.join("deferred_edits.jsonl");
    if queue_path.exists() {
        fs::remove_file(queue_path)?;
    }
    Ok(())
}

/// Ensure the workspace-first layout exists for a character and migrate any
/// legacy bootstrap files or memory files into it.
pub fn ensure_character_workspace(
    character_data_dir: &Path,
    config_dir: &Path,
    char_name: &str,
) -> io::Result<()> {
    let char_config_dir = character_config_dir(config_dir, char_name);
    let workspace_dir = character_workspace_dir(config_dir, char_name);
    let memory_dir = character_memory_dir(config_dir, char_name);

    fs::create_dir_all(&workspace_dir)?;
    fs::create_dir_all(&memory_dir)?;

    migrate_legacy_file(
        char_config_dir.join("character.md"),
        workspace_dir.join(SOUL_FILE),
    )?;
    migrate_legacy_file(
        char_config_dir.join("user.md"),
        workspace_dir.join(USER_FILE),
    )?;
    migrate_legacy_file(
        char_config_dir.join("prompts").join("system.md"),
        workspace_dir.join(AGENTS_FILE),
    )?;

    let global_user = config_dir.join("user.md");
    let workspace_user = workspace_dir.join(USER_FILE);
    if global_user.exists() && !workspace_user.exists() {
        let _ignored = fs::copy(global_user, workspace_user)?;
    }

    write_default_if_missing(workspace_dir.join(TOOLS_FILE), DEFAULT_TOOLS_GUIDANCE)?;

    let legacy_memories = character_data_dir.join("memories");
    if legacy_memories.exists() {
        copy_tree_if_missing(&legacy_memories, &memory_dir)?;
    }

    Ok(())
}

/// Ensure the active prompt snapshot exists. Missing files are seeded from the
/// canonical config workspace, but an existing snapshot is left intact so edits
/// remain deferred until compaction.
pub fn ensure_active_prompt_snapshot(
    character_data_dir: &Path,
    config_dir: &Path,
    char_name: &str,
) -> io::Result<()> {
    ensure_character_workspace(character_data_dir, config_dir, char_name)?;

    let active_dir = active_prompt_dir(character_data_dir);
    fs::create_dir_all(&active_dir)?;

    for name in PROTECTED_PATHS {
        copy_prompt_visible_file(character_data_dir, config_dir, char_name, name, true)?;
    }
    copy_prompt_visible_file(
        character_data_dir,
        config_dir,
        char_name,
        MEMORY_INDEX_DEFERRED_PATH,
        true,
    )?;

    for legacy in LEGACY_SNAPSHOTS {
        let legacy_snapshot = active_dir.join(legacy);
        if legacy_snapshot.exists() {
            fs::remove_file(legacy_snapshot)?;
        }
    }

    Ok(())
}

/// Refresh every protected file in the active prompt snapshot.
pub fn refresh_active_prompt_snapshot(
    character_data_dir: &Path,
    config_dir: &Path,
    char_name: &str,
) -> io::Result<()> {
    ensure_character_workspace(character_data_dir, config_dir, char_name)?;

    for name in PROTECTED_PATHS {
        copy_prompt_visible_file(character_data_dir, config_dir, char_name, name, false)?;
    }
    copy_prompt_visible_file(
        character_data_dir,
        config_dir,
        char_name,
        MEMORY_INDEX_DEFERRED_PATH,
        false,
    )?;

    Ok(())
}

fn migrate_legacy_file(src: PathBuf, dst: PathBuf) -> io::Result<()> {
    if src.exists() && !dst.exists() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        let _ignored = fs::copy(src, dst)?;
    }
    Ok(())
}

fn write_default_if_missing(path: PathBuf, content: &str) -> io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)
}

fn copy_tree_if_missing(src: &Path, dst: &Path) -> io::Result<()> {
    if src.is_file() {
        if !dst.exists() {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            let _ignored = fs::copy(src, dst)?;
        }
        return Ok(());
    }

    fs::create_dir_all(dst)?;
    for dir_entry in fs::read_dir(src)? {
        let entry = dir_entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_tree_if_missing(&src_path, &dst_path)?;
        } else if !dst_path.exists() {
            let _ignored = fs::copy(src_path, dst_path)?;
        } else {
            // Destination file already present: preserve it.
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_is_protected_path() {
        assert!(is_protected_path("SOUL.md"));
        assert!(is_protected_path("workspace/SOUL.md"));
        assert!(is_protected_path("/workspace/USER.md"));
        assert!(is_protected_path(r"workspace\AGENTS.md"));
        assert!(is_protected_path("TOOLS.md"));
        assert!(!is_protected_path("notes.md"));

        // Mixed prefixes must still resolve to the canonical name. A single
        // pass left "./" behind after stripping "workspace/", letting these
        // bypass the guard.
        assert!(is_protected_path("workspace/./SOUL.md"));
        assert!(is_protected_path("./SOUL.md"));
        assert!(is_protected_path("./workspace/SOUL.md"));
        assert!(is_protected_path("/./workspace/SOUL.md"));
        assert!(is_protected_path("workspace/workspace/SOUL.md"));
    }

    #[test]
    fn test_queue_and_apply_refreshes_snapshot() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join(SOUL_FILE), "new soul").unwrap();
        fs::write(workspace.join(USER_FILE), "new user").unwrap();
        fs::write(workspace.join(AGENTS_FILE), "new agents").unwrap();
        fs::write(workspace.join(TOOLS_FILE), "new tools").unwrap();

        queue_deferred_edit(&char_dir, "workspace/SOUL.md").unwrap();
        queue_deferred_edit(&char_dir, "USER.md").unwrap();

        apply_deferred_edits(&char_dir, &config_dir, "TestChar").unwrap();

        assert_eq!(
            fs::read_to_string(active_prompt_file(&char_dir, SOUL_FILE)).unwrap(),
            "new soul"
        );
        assert_eq!(
            fs::read_to_string(active_prompt_file(&char_dir, USER_FILE)).unwrap(),
            "new user"
        );
        assert!(!char_dir.join("deferred_edits.jsonl").exists());
    }

    #[test]
    fn test_changed_prompt_files_reports_workspace_edits() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join(SOUL_FILE), "soul v1").unwrap();
        fs::write(workspace.join(MEMORY_INDEX_FILE), "index v1").unwrap();

        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();
        assert!(changed_prompt_files(&char_dir, &config_dir, "TestChar").is_empty());

        // Edit two workspace files; only those show as changed.
        fs::write(workspace.join(SOUL_FILE), "soul v2").unwrap();
        fs::write(workspace.join(MEMORY_INDEX_FILE), "index v2").unwrap();
        assert_eq!(
            changed_prompt_files(&char_dir, &config_dir, "TestChar"),
            vec![SOUL_FILE.to_owned(), MEMORY_INDEX_FILE.to_owned()]
        );

        // Refresh clears the delta.
        apply_deferred_edits(&char_dir, &config_dir, "TestChar").unwrap();
        assert!(changed_prompt_files(&char_dir, &config_dir, "TestChar").is_empty());
    }

    #[test]
    fn test_changed_prompt_files_treats_blank_as_missing() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        fs::create_dir_all(&workspace).unwrap();
        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();

        // Blank canonical vs. absent snapshot: both load as None, so no delta.
        fs::write(workspace.join(SOUL_FILE), "  \n").unwrap();
        assert!(!changed_prompt_files(&char_dir, &config_dir, "TestChar")
            .contains(&SOUL_FILE.to_owned()));

        // The deferred memory-index sentinel (empty active file) vs. real
        // canonical content must count as a change.
        fs::write(workspace.join(MEMORY_INDEX_FILE), "fresh index").unwrap();
        ensure_deferred_memory_index_sentinel(&char_dir).unwrap();
        assert!(changed_prompt_files(&char_dir, &config_dir, "TestChar")
            .contains(&MEMORY_INDEX_FILE.to_owned()));
    }

    #[test]
    fn test_pending_paths_deduped() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("char");
        fs::create_dir_all(&char_dir).unwrap();

        queue_deferred_edit(&char_dir, "workspace/SOUL.md").unwrap();
        queue_deferred_edit(&char_dir, "SOUL.md").unwrap();
        queue_deferred_edit(&char_dir, "AGENTS.md").unwrap();
        queue_deferred_edit(&char_dir, "workspace/MEMORY.md").unwrap();

        let paths = pending_deferred_edit_paths(&char_dir).unwrap();
        assert_eq!(
            paths,
            vec![
                "AGENTS.md".to_owned(),
                "MEMORY.md".to_owned(),
                "SOUL.md".to_owned(),
            ]
        );
    }

    #[test]
    fn test_workspace_migration_and_global_seed() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let char_config = character_config_dir(&config_dir, "TestChar");

        fs::create_dir_all(char_config.join("prompts")).unwrap();
        fs::write(char_config.join("character.md"), "orig soul").unwrap();
        fs::write(char_config.join("user.md"), "orig user").unwrap();
        fs::write(char_config.join("prompts/system.md"), "orig agents").unwrap();
        fs::write(config_dir.join("user.md"), "global user").unwrap();
        fs::create_dir_all(char_dir.join("memories").join("daily")).unwrap();
        fs::write(
            char_dir
                .join("memories")
                .join("daily")
                .join("2026-01-01.md"),
            "note",
        )
        .unwrap();

        ensure_character_workspace(&char_dir, &config_dir, "TestChar").unwrap();

        let workspace = character_workspace_dir(&config_dir, "TestChar");
        assert_eq!(
            fs::read_to_string(workspace.join(SOUL_FILE)).unwrap(),
            "orig soul"
        );
        assert_eq!(
            fs::read_to_string(workspace.join(USER_FILE)).unwrap(),
            "orig user"
        );
        assert_eq!(
            fs::read_to_string(workspace.join(AGENTS_FILE)).unwrap(),
            "orig agents"
        );
        assert!(workspace.join(TOOLS_FILE).exists());
        assert!(
            !workspace.join("HEARTBEAT.md").exists(),
            "retired HEARTBEAT.md must not be seeded into new workspaces"
        );
        assert_eq!(
            fs::read_to_string(
                character_memory_dir(&config_dir, "TestChar").join("daily/2026-01-01.md")
            )
            .unwrap(),
            "note"
        );
    }

    #[test]
    fn test_snapshot_seed_only_when_missing() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join(SOUL_FILE), "workspace soul").unwrap();
        fs::write(workspace.join(USER_FILE), "workspace user").unwrap();
        fs::write(workspace.join(AGENTS_FILE), "workspace agents").unwrap();
        fs::write(workspace.join(TOOLS_FILE), "workspace tools").unwrap();

        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();
        fs::write(workspace.join(SOUL_FILE), "edited later").unwrap();
        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();

        assert_eq!(
            fs::read_to_string(active_prompt_file(&char_dir, SOUL_FILE)).unwrap(),
            "workspace soul"
        );
    }

    #[test]
    fn test_protected_edit_stays_deferred_until_apply() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join(SOUL_FILE), "active soul").unwrap();
        fs::write(workspace.join(USER_FILE), "active user").unwrap();
        fs::write(workspace.join(AGENTS_FILE), "active agents").unwrap();
        fs::write(workspace.join(TOOLS_FILE), "active tools").unwrap();

        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();

        fs::write(workspace.join(SOUL_FILE), "edited soul").unwrap();
        queue_deferred_edit(&char_dir, "SOUL.md").unwrap();
        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();

        assert_eq!(
            fs::read_to_string(active_prompt_file(&char_dir, SOUL_FILE)).unwrap(),
            "active soul",
            "protected workspace edits must not live-activate before apply"
        );
        assert_eq!(
            pending_deferred_edit_paths(&char_dir).unwrap(),
            vec!["SOUL.md"]
        );

        apply_deferred_edits(&char_dir, &config_dir, "TestChar").unwrap();

        assert_eq!(
            fs::read_to_string(active_prompt_file(&char_dir, SOUL_FILE)).unwrap(),
            "edited soul",
            "apply_deferred_edits is the activation boundary"
        );
        assert!(!char_dir.join("deferred_edits.jsonl").exists());
    }

    #[test]
    fn test_memory_index_stays_deferred_until_apply() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join(MEMORY_INDEX_FILE), "active index").unwrap();
        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();

        fs::write(workspace.join(MEMORY_INDEX_FILE), "edited index").unwrap();
        queue_deferred_edit(&char_dir, "MEMORY.md").unwrap();
        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();

        assert_eq!(
            load_memory_index(&char_dir, &config_dir, "TestChar").unwrap(),
            "active index"
        );
        assert_eq!(
            pending_deferred_edit_paths(&char_dir).unwrap(),
            vec!["MEMORY.md"]
        );

        apply_deferred_edits(&char_dir, &config_dir, "TestChar").unwrap();

        assert_eq!(
            load_memory_index(&char_dir, &config_dir, "TestChar").unwrap(),
            "edited index"
        );
    }

    #[test]
    fn test_new_memory_index_deferred_sentinel_blocks_live_activation() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join(MEMORY_INDEX_FILE), "new index").unwrap();
        queue_deferred_edit(&char_dir, "MEMORY.md").unwrap();
        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();

        assert!(load_memory_index(&char_dir, &config_dir, "TestChar").is_none());

        apply_deferred_edits(&char_dir, &config_dir, "TestChar").unwrap();
        assert_eq!(
            load_memory_index(&char_dir, &config_dir, "TestChar").unwrap(),
            "new index"
        );
    }

    #[test]
    fn test_legacy_snapshots_cleaned_on_seed() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("data").join("TestChar");
        let config_dir = tmp.path().join("config");
        let workspace = character_workspace_dir(&config_dir, "TestChar");

        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join(SOUL_FILE), "soul").unwrap();
        fs::write(workspace.join(USER_FILE), "user").unwrap();
        fs::write(workspace.join(AGENTS_FILE), "agents").unwrap();
        fs::write(workspace.join(TOOLS_FILE), "tools").unwrap();

        let active_dir = active_prompt_dir(&char_dir);
        fs::create_dir_all(&active_dir).unwrap();
        for legacy in LEGACY_SNAPSHOTS {
            fs::write(active_dir.join(legacy), "stale").unwrap();
            assert!(active_dir.join(legacy).exists());
        }

        ensure_active_prompt_snapshot(&char_dir, &config_dir, "TestChar").unwrap();
        for legacy in LEGACY_SNAPSHOTS {
            assert!(
                !active_dir.join(legacy).exists(),
                "legacy {legacy} snapshot must be cleaned up on seed"
            );
        }
    }
}
