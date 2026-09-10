use std::path::{Path, PathBuf};

const KEEP_EDITOR_SESSIONS: usize = 20;

pub(crate) fn drafts_dir() -> PathBuf {
    shore_common::dirs::data_dir().join("drafts")
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Draft {
    pub daemon: String,
    pub character: String,
    pub thread: String,
    pub text: String,
    pub images: Vec<String>,
    pub editing_ref: Option<String>,
}

impl Draft {
    fn same_conversation(&self, other: &Self) -> bool {
        self.daemon == other.daemon
            && self.character == other.character
            && self.thread == other.thread
    }

    fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.images.is_empty() && self.editing_ref.is_none()
    }

    fn directory(&self, dir: &Path) -> PathBuf {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        (&self.daemon, &self.character, &self.thread).hash(&mut hash);
        dir.join(format!("{:016x}", hash.finish()))
    }
}

pub(crate) fn lock_session(dir: &Path, owner: &str) -> std::io::Result<std::fs::File> {
    let locks = dir.join("sessions");
    std::fs::create_dir_all(&locks)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(locks.join(owner))?;
    file.try_lock().map_err(std::io::Error::other)?;
    Ok(file)
}

pub(crate) fn load(dir: &Path, owner: &str, identity: &Draft) -> Option<Draft> {
    let directory = identity.directory(dir);
    let own_path = directory.join(format!("{owner}.json"));
    let mut paths: Vec<_> = std::fs::read_dir(&directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort_by_key(|entry| std::cmp::Reverse(entry.metadata().and_then(|m| m.modified()).ok()));
    paths.sort_by_key(|entry| entry.path() != own_path);
    for entry in paths {
        let path = entry.path();
        let source_owner = path.file_stem()?.to_str()?;
        let _lock = if source_owner == owner {
            None
        } else {
            match lock_session(dir, source_owner) {
                Ok(lock) => Some(lock),
                Err(_) => continue,
            }
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(draft) = serde_json::from_slice::<Draft>(&bytes) else {
            continue;
        };
        if !draft.same_conversation(identity) || draft.is_empty() {
            continue;
        }
        if path != own_path && std::fs::rename(&path, &own_path).is_err() {
            continue;
        }
        return Some(draft);
    }
    let _legacy_lock = lock_session(dir, "legacy").ok()?;
    let legacy_path = dir.join("current.md");
    let text = std::fs::read_to_string(&legacy_path).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let mut migrated = identity.clone();
    migrated.text = text;
    save(dir, owner, &migrated, &[]).ok()?;
    std::fs::rename(legacy_path, dir.join(format!("legacy-{owner}.md"))).ok()?;
    Some(migrated)
}

pub(crate) fn save(
    dir: &Path,
    owner: &str,
    draft: &Draft,
    owned_images: &[PathBuf],
) -> std::io::Result<()> {
    let directory = draft.directory(dir);
    let path = directory.join(format!("{owner}.json"));
    if draft.is_empty() {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        };
    }
    std::fs::create_dir_all(&directory)?;
    let mut snapshot = draft.clone();
    for image in &mut snapshot.images {
        if owned_images.iter().any(|owned| owned == Path::new(image)) {
            use std::hash::Hasher;
            let attachments = dir.join("attachments");
            std::fs::create_dir_all(&attachments)?;
            let bytes = std::fs::read(&*image)?;
            let mut digest = std::collections::hash_map::DefaultHasher::new();
            digest.write(&bytes);
            let mut destination = attachments.join(format!("{:016x}.png", digest.finish()));
            if let Ok(existing) = std::fs::read(&destination)
                && existing != bytes
            {
                destination = attachments.join(format!(
                    "{}.png",
                    shore_common::swp_client::connection::request_id()
                ));
            }
            if !destination.exists() {
                let mut copy = tempfile::NamedTempFile::new_in(&attachments)?;
                std::io::Write::write_all(&mut copy, &bytes)?;
                copy.as_file().sync_all()?;
                let _file = copy.persist(&destination).map_err(|error| error.error)?;
            }
            *image = destination.to_string_lossy().into_owned();
        }
    }
    let mut tmp = tempfile::NamedTempFile::new_in(&directory)?;
    serde_json::to_writer(&mut tmp, &snapshot)?;
    tmp.as_file().sync_all()?;
    let _file = tmp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub(crate) fn editor_dir(dir: &Path) -> PathBuf {
    dir.join("editor")
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

#[cfg(test)]
mod recovery_tests {
    use super::{Draft, load, lock_session, save};

    fn message(thread: &str, text: &str) -> Draft {
        Draft {
            daemon: "localhost:9090".into(),
            character: "ada".into(),
            thread: thread.into(),
            text: text.into(),
            ..Draft::default()
        }
    }

    #[test]
    fn empty_sessions_cannot_delete_another_sessions_draft() {
        let tmp = tempfile::tempdir().unwrap();
        let original = message("main", "unfinished");
        save(tmp.path(), "first", &original, &[]).unwrap();
        let mut empty = original.clone();
        empty.text.clear();
        save(tmp.path(), "second", &empty, &[]).unwrap();
        assert_eq!(load(tmp.path(), "next", &empty), Some(original));
    }

    #[test]
    fn recovery_claims_only_inactive_sessions_in_the_same_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let original = message("main", "unfinished");
        let lock = lock_session(tmp.path(), "active").unwrap();
        save(tmp.path(), "active", &original, &[]).unwrap();
        assert!(load(tmp.path(), "second", &original).is_none());
        drop(lock);
        assert!(load(tmp.path(), "second", &message("side", "")).is_none());
        let mut another_daemon = original.clone();
        another_daemon.daemon = "localhost:9091".into();
        assert!(load(tmp.path(), "second", &another_daemon).is_none());
        assert_eq!(
            load(tmp.path(), "second", &original),
            Some(original.clone())
        );
        let second_lock = lock_session(tmp.path(), "second").unwrap();
        assert!(load(tmp.path(), "third", &original).is_none());
        drop(second_lock);
    }

    #[test]
    fn attachments_and_editor_targets_survive_recovery_without_cross_thread_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("clipboard.png");
        std::fs::write(&source, "first image").unwrap();
        let mut original = message("main", "caption");
        original.images.push(source.to_string_lossy().into_owned());
        original.editing_ref = Some("stable-message-id".into());
        save(
            tmp.path(),
            "first",
            &original,
            std::slice::from_ref(&source),
        )
        .unwrap();
        std::fs::write(&source, "second image").unwrap();
        let mut side = original.clone();
        side.thread = "side".into();
        save(tmp.path(), "first", &side, std::slice::from_ref(&source)).unwrap();
        std::fs::remove_file(&source).unwrap();
        let restored = load(tmp.path(), "next", &original).unwrap();
        assert_eq!(restored.editing_ref, original.editing_ref);
        assert_eq!(
            std::fs::read_to_string(restored.images.first().unwrap()).unwrap(),
            "first image"
        );
        let restored_side = load(tmp.path(), "next", &side).unwrap();
        assert_eq!(
            std::fs::read_to_string(restored_side.images.first().unwrap()).unwrap(),
            "second image"
        );
    }
}

#[cfg(test)]
mod migration_tests {
    use super::{Draft, load};

    #[test]
    fn legacy_text_is_preserved_and_migrated_only_once() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("current.md"), "old draft").unwrap();
        let identity = Draft {
            daemon: "localhost:9090".into(),
            character: "ada".into(),
            thread: "main".into(),
            ..Draft::default()
        };
        let recovered = load(tmp.path(), "first", &identity).unwrap();
        assert_eq!(recovered.text, "old draft");
        assert_eq!(recovered.character, "ada");
        assert!(!tmp.path().join("current.md").exists());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("legacy-first.md")).unwrap(),
            "old draft"
        );
        let mut side = identity;
        side.thread = "side".into();
        assert!(load(tmp.path(), "second", &side).is_none());
    }
}
