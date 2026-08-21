use std::path::{Path, PathBuf};

const KEEP_EDITOR_SESSIONS: usize = 20;

pub(crate) fn drafts_dir() -> PathBuf {
    shore_common::dirs::data_dir().join("drafts")
}

pub(crate) fn current_path(dir: &Path) -> PathBuf {
    dir.join("current.md")
}

pub(crate) fn editor_dir(dir: &Path) -> PathBuf {
    dir.join("editor")
}

pub(crate) fn load(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(current_path(dir)).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

pub(crate) fn save(dir: &Path, text: &str) -> std::io::Result<()> {
    let path = current_path(dir);
    if text.trim().is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        drop(std::fs::remove_file(&tmp));
    })
}

pub(crate) fn editor_session_path(dir: &Path, stamp: &str) -> PathBuf {
    let sessions = editor_dir(dir);
    let first = sessions.join(format!("{stamp}.md"));
    if !first.exists() {
        return first;
    }
    (2_u32..)
        .map(|n| sessions.join(format!("{stamp}-{n}.md")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

pub(crate) fn stamp_now() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

pub(crate) fn prune_editor_sessions(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(editor_dir(dir)) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "md"))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_unstable();
    let stale = files.len().saturating_sub(keep);
    for old in files.iter().take(stale) {
        drop(std::fs::remove_file(old));
    }
}

pub(crate) fn prune_editor_sessions_to_default(dir: &Path) {
    prune_editor_sessions(dir, KEEP_EDITOR_SESSIONS);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_draft_written_on_the_way_out_comes_back_on_the_way_in() {
        let tmp = tempfile::tempdir().unwrap();
        save(tmp.path(), "half a thought").unwrap();
        assert_eq!(load(tmp.path()).as_deref(), Some("half a thought"));
    }

    #[test]
    fn an_empty_box_leaves_no_draft_to_restore() {
        let tmp = tempfile::tempdir().unwrap();
        save(tmp.path(), "something").unwrap();
        save(tmp.path(), "   \n ").unwrap();
        assert_eq!(load(tmp.path()), None);
        assert!(!current_path(tmp.path()).exists());
    }

    #[test]
    fn nothing_saved_means_nothing_to_restore() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(tmp.path()), None);
        save(tmp.path(), "").unwrap();
    }

    #[test]
    fn two_editor_sessions_in_the_same_second_get_their_own_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(editor_dir(tmp.path())).unwrap();

        let first = editor_session_path(tmp.path(), "20260822-010203");
        std::fs::write(&first, "one").unwrap();
        let second = editor_session_path(tmp.path(), "20260822-010203");
        std::fs::write(&second, "two").unwrap();

        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "two");
    }

    #[test]
    fn pruning_keeps_the_newest_sessions_and_drops_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(editor_dir(tmp.path())).unwrap();
        for stamp in ["20260822-010201", "20260822-010202", "20260822-010203"] {
            std::fs::write(editor_session_path(tmp.path(), stamp), stamp).unwrap();
        }

        prune_editor_sessions(tmp.path(), 2);

        let mut left: Vec<String> = std::fs::read_dir(editor_dir(tmp.path()))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["20260822-010202.md", "20260822-010203.md"]);
    }

    #[test]
    fn pruning_an_empty_or_missing_directory_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        prune_editor_sessions(tmp.path(), 2);
        std::fs::create_dir_all(editor_dir(tmp.path())).unwrap();
        prune_editor_sessions(tmp.path(), 2);
    }

    #[test]
    fn a_stamp_sorts_the_same_way_it_reads() {
        let stamp = stamp_now();
        assert_eq!(stamp.len(), 15, "{stamp}");
        assert!(stamp.chars().nth(8) == Some('-'), "{stamp}");
        assert!(
            stamp.chars().filter(char::is_ascii_digit).count() == 14,
            "{stamp}"
        );
    }
}
