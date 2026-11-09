use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const KEEP_EDITOR_SESSIONS: usize = 20;

pub(crate) fn drafts_dir(data: &Path) -> PathBuf {
    data.join("drafts")
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
        let mut hash = Sha256::new();
        for field in [&self.daemon, &self.character, &self.thread] {
            hash.update(u64::try_from(field.len()).unwrap_or(u64::MAX).to_be_bytes());
            hash.update(field.as_bytes());
        }
        dir.join(format!("v1-{}", hex(&hash.finalize())))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn image_suffix(bytes: &[u8]) -> &'static str {
    image::guess_format(bytes)
        .ok()
        .and_then(|format| format.extensions_str().first().copied())
        .unwrap_or("bin")
}

pub(crate) fn recover_attachment(data: &str) -> std::io::Result<PathBuf> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut copy = tempfile::Builder::new()
        .prefix("shore-recovered-")
        .suffix(&format!(".{}", image_suffix(&bytes)))
        .tempfile()?;
    std::io::Write::write_all(&mut copy, &bytes)?;
    let (_file, path) = copy.keep().map_err(|error| error.error)?;
    Ok(path)
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
    let _store_lock = lock_store(dir).ok()?;
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
        if path != own_path
            && (std::fs::create_dir_all(&directory).is_err()
                || std::fs::rename(&path, &own_path).is_err())
        {
            continue;
        }
        return Some(draft);
    }
    None
}

pub(crate) fn save(
    dir: &Path,
    owner: &str,
    draft: &Draft,
    owned_images: &[PathBuf],
) -> std::io::Result<()> {
    let _store_lock = lock_store(dir)?;
    save_locked(dir, owner, draft, owned_images).map(|_| ())
}

fn lock_store(dir: &Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("store.lock"))?;
    file.try_lock()?;
    Ok(file)
}

fn save_locked(
    dir: &Path,
    owner: &str,
    draft: &Draft,
    owned_images: &[PathBuf],
) -> std::io::Result<Draft> {
    let directory = draft.directory(dir);
    let path = directory.join(format!("{owner}.json"));
    if draft.is_empty() {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        }?;
        if let Err(error) = prune_attachments(dir) {
            tracing::warn!("could not reclaim draft attachments: {error}");
        }
        return Ok(draft.clone());
    }
    std::fs::create_dir_all(&directory)?;
    let mut snapshot = draft.clone();
    for image in &mut snapshot.images {
        if owned_images.iter().any(|owned| owned == Path::new(image)) {
            let attachments = dir.join("attachments");
            std::fs::create_dir_all(&attachments)?;
            let bytes = std::fs::read(&*image)?;
            let suffix = image_suffix(&bytes);
            let mut destination =
                attachments.join(format!("{}.{suffix}", hex(&Sha256::digest(&bytes))));
            if let Ok(existing) = std::fs::read(&destination)
                && existing != bytes
            {
                destination = attachments.join(format!(
                    "{}.{suffix}",
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
    if let Err(error) = prune_attachments(dir) {
        tracing::warn!("could not reclaim draft attachments: {error}");
    }
    Ok(snapshot)
}

fn prune_attachments(dir: &Path) -> std::io::Result<()> {
    let attachments = dir.join("attachments");
    let mut referenced = std::collections::HashSet::new();
    for entry_result in std::fs::read_dir(dir)? {
        let entry = entry_result?;
        if !entry.file_type()?.is_dir() || entry.path() == attachments {
            continue;
        }
        for candidate in std::fs::read_dir(entry.path())? {
            let path = candidate?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let bytes = std::fs::read(path)?;
            let Ok(saved) = serde_json::from_slice::<Draft>(&bytes) else {
                return Ok(());
            };
            referenced.extend(saved.images.into_iter().map(PathBuf::from));
        }
    }
    let files = match std::fs::read_dir(attachments) {
        Ok(files) => files,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for file_result in files {
        let file = file_result?;
        if file.file_type()?.is_file() && !referenced.contains(&file.path()) {
            std::fs::remove_file(file.path())?;
        }
    }
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
    use chrono::Timelike as _;

    #[test]
    fn two_editor_sessions_in_the_same_second_get_their_own_files() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("editor");
        std::fs::create_dir_all(&sessions).unwrap();

        let first = editor_session_path(tmp.path(), "20260822-010203");
        assert_eq!(first, sessions.join("20260822-010203.md"));
        std::fs::write(&first, "one").unwrap();
        let second = editor_session_path(tmp.path(), "20260822-010203");
        assert_eq!(second, sessions.join("20260822-010203-2.md"));
        std::fs::write(&second, "two").unwrap();
        assert_eq!(
            editor_session_path(tmp.path(), "20260822-010203"),
            sessions.join("20260822-010203-3.md")
        );

        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "two");
    }

    #[test]
    fn drafts_and_editor_sessions_live_in_the_data_directory() {
        let data = Path::new("/srv/shore-data");
        assert_eq!(drafts_dir(data), Path::new("/srv/shore-data/drafts"));
        assert_eq!(
            editor_dir(&drafts_dir(data)),
            Path::new("/srv/shore-data/drafts/editor")
        );
    }

    #[test]
    fn editor_sessions_are_named_by_the_local_time_to_the_second() {
        let before = chrono::Local::now()
            .naive_local()
            .with_nanosecond(0)
            .unwrap();
        let stamp = stamp_now();
        let after = chrono::Local::now().naive_local();
        let named = chrono::NaiveDateTime::parse_from_str(&stamp, "%Y%m%d-%H%M%S").unwrap();
        assert!(
            before <= named && named <= after,
            "{stamp} is not between {before} and {after}"
        );
    }

    fn write_sessions(dir: &Path, count: u32) {
        let sessions = dir.join("editor");
        std::fs::create_dir_all(&sessions).unwrap();
        for minute in 0..count {
            std::fs::write(
                sessions.join(format!("20260822-01{minute:02}00.md")),
                "text",
            )
            .unwrap();
        }
    }

    fn session_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir.join("editor"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn pruning_keeps_the_newest_editor_sessions_and_leaves_other_files_alone() {
        let tmp = tempfile::tempdir().unwrap();
        write_sessions(tmp.path(), 25);
        std::fs::write(tmp.path().join("editor").join("notes.txt"), "keep").unwrap();
        prune_editor_sessions(tmp.path(), 20);
        let left = session_files(tmp.path());
        assert_eq!(left.len(), 21);
        assert!(left.contains(&"notes.txt".to_owned()), "{left:?}");
        assert!(!left.contains(&"20260822-010400.md".to_owned()), "{left:?}");
        assert!(left.contains(&"20260822-010500.md".to_owned()), "{left:?}");
        assert!(left.contains(&"20260822-012400.md".to_owned()), "{left:?}");
    }

    #[test]
    fn the_editor_keeps_its_last_twenty_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        write_sessions(tmp.path(), 21);
        prune_editor_sessions_to_default(tmp.path());
        let left = session_files(tmp.path());
        assert_eq!(left.len(), 20);
        assert!(!left.contains(&"20260822-010000.md".to_owned()), "{left:?}");
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::{Draft, load, save};
    use sha2::Digest as _;
    use std::path::Path;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\npayload";

    fn message(thread: &str, text: &str) -> Draft {
        Draft {
            daemon: "localhost:9090".into(),
            character: "ada".into(),
            thread: thread.into(),
            text: text.into(),
            ..Draft::default()
        }
    }

    fn write_raw(dir: &Path, identity: &Draft, owner: &str, draft: &Draft) {
        let directory = identity.directory(dir);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join(format!("{owner}.json")),
            serde_json::to_vec(draft).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn a_draft_for_another_conversation_or_with_nothing_in_it_is_never_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let identity = message("main", "");
        let mut stranger = message("main", "for someone else");
        stranger.character = "bea".into();
        write_raw(tmp.path(), &identity, "stray", &stranger);
        assert_eq!(load(tmp.path(), "next", &identity), None);
        write_raw(tmp.path(), &identity, "blank", &message("main", "  \n"));
        assert_eq!(load(tmp.path(), "next", &identity), None);
        write_raw(tmp.path(), &identity, "kept", &message("main", "unsent"));
        assert_eq!(
            load(tmp.path(), "next", &identity),
            Some(message("main", "unsent"))
        );
    }

    #[test]
    fn a_session_restores_its_own_draft_before_a_newer_one_left_by_another() {
        let tmp = tempfile::tempdir().unwrap();
        let identity = message("main", "");
        save(tmp.path(), "mine", &message("main", "my own words"), &[]).unwrap();
        save(tmp.path(), "other", &message("main", "someone else's"), &[]).unwrap();
        assert_eq!(
            load(tmp.path(), "mine", &identity),
            Some(message("main", "my own words"))
        );
        assert_eq!(
            load(tmp.path(), "third", &identity),
            Some(message("main", "someone else's"))
        );
    }

    #[test]
    fn a_draft_held_by_a_running_session_is_left_to_it() {
        let tmp = tempfile::tempdir().unwrap();
        let identity = message("main", "");
        save(tmp.path(), "running", &message("main", "still typing"), &[]).unwrap();
        let held = super::lock_session(tmp.path(), "running").unwrap();
        assert_eq!(load(tmp.path(), "next", &identity), None);
        drop(held);
        assert_eq!(
            load(tmp.path(), "next", &identity),
            Some(message("main", "still typing"))
        );
    }

    #[test]
    fn clearing_a_draft_that_cannot_be_removed_reports_the_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let identity = message("main", "");
        let stuck = identity.directory(tmp.path()).join("mine.json");
        std::fs::create_dir_all(stuck.join("in-the-way")).unwrap();
        assert!(
            save(tmp.path(), "mine", &identity, &[]).is_err(),
            "the draft file is still there"
        );
    }

    #[test]
    fn attachments_keep_their_image_type_and_identical_images_share_one_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let png = tmp.path().join("clipboard.png");
        std::fs::write(&png, PNG).unwrap();
        let blob = tmp.path().join("notes");
        std::fs::write(&blob, b"not an image").unwrap();
        let mut first = message("main", "pictures");
        first.images = vec![
            png.to_string_lossy().into_owned(),
            blob.to_string_lossy().into_owned(),
        ];
        save(tmp.path(), "first", &first, &[png.clone(), blob.clone()]).unwrap();
        let mut second = message("side", "the same picture");
        second.images = vec![png.to_string_lossy().into_owned()];
        save(tmp.path(), "second", &second, std::slice::from_ref(&png)).unwrap();
        let stored = load(tmp.path(), "first", &first).unwrap().images;
        let picture = stored.first().unwrap();
        assert_eq!(Path::new(picture).extension(), Some("png".as_ref()));
        assert_eq!(
            Path::new(stored.get(1).unwrap()).extension(),
            Some("bin".as_ref())
        );
        assert_eq!(
            load(tmp.path(), "second", &second).unwrap().images,
            vec![picture.clone()]
        );
        assert_eq!(
            std::fs::read_dir(tmp.path().join("attachments"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn an_attachment_whose_stored_copy_changed_is_saved_under_a_new_name() {
        let tmp = tempfile::tempdir().unwrap();
        let png = tmp.path().join("clipboard.png");
        std::fs::write(&png, PNG).unwrap();
        let attachments = tmp.path().join("attachments");
        std::fs::create_dir_all(&attachments).unwrap();
        let hashed = attachments.join(format!("{}.png", super::hex(&sha2::Sha256::digest(PNG))));
        std::fs::write(&hashed, b"\x89PNG\r\n\x1a\naltered").unwrap();
        let mut draft = message("main", "picture");
        draft.images = vec![png.to_string_lossy().into_owned()];
        save(tmp.path(), "mine", &draft, std::slice::from_ref(&png)).unwrap();
        let stored = load(tmp.path(), "mine", &draft).unwrap().images;
        let kept = Path::new(stored.first().unwrap());
        assert_ne!(kept, hashed);
        assert_eq!(std::fs::read(kept).unwrap(), PNG);
    }

    #[test]
    fn a_recovered_attachment_keeps_its_image_type() {
        use base64::Engine as _;
        let path =
            super::recover_attachment(&base64::engine::general_purpose::STANDARD.encode(PNG))
                .unwrap();
        let contents = std::fs::read(&path).unwrap();
        let extension = path.extension().map(std::ffi::OsStr::to_os_string);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(extension, Some("png".into()));
        assert_eq!(contents, PNG);
    }

    #[test]
    fn reclaiming_attachments_before_any_exist_is_fine_but_an_unreadable_store_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            super::prune_attachments(tmp.path()).is_ok(),
            "no attachments directory yet"
        );
        std::fs::write(tmp.path().join("attachments"), "not a directory").unwrap();
        assert!(
            super::prune_attachments(tmp.path()).is_err(),
            "attachments is a file"
        );
    }

    #[test]
    fn collection_cannot_race_with_another_sessions_unpublished_attachment() {
        let tmp = tempfile::tempdir().unwrap();
        let lock = super::lock_store(tmp.path()).unwrap();
        let attachments = tmp.path().join("attachments");
        std::fs::create_dir(&attachments).unwrap();
        let pending = attachments.join("pending.png");
        std::fs::write(&pending, b"\x89PNG\r\n\x1a\npayload").unwrap();
        assert!(save(tmp.path(), "clearing", &message("main", ""), &[]).is_err());
        assert!(pending.exists(), "the publisher still owns the store lock");
        let mut published = message("side", "published");
        published
            .images
            .push(pending.to_string_lossy().into_owned());
        let snapshot = super::save_locked(tmp.path(), "publisher", &published, &[]).unwrap();
        drop(lock);
        save(tmp.path(), "clearing", &message("main", ""), &[]).unwrap();
        assert!(Path::new(snapshot.images.first().unwrap()).exists());
    }

    #[test]
    fn clearing_drafts_reclaims_only_unreferenced_attachments() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("clipboard.png");
        std::fs::write(&source, b"\x89PNG\r\n\x1a\npayload").unwrap();
        let mut original = message("main", "caption");
        original.images.push(source.to_string_lossy().into_owned());
        save(tmp.path(), "first", &original, &[source]).unwrap();
        let recovered = load(tmp.path(), "first", &original).unwrap();
        let attachment = recovered.images.first().unwrap();
        let mut shared = recovered.clone();
        shared.thread = "side".into();
        save(tmp.path(), "second", &shared, &[]).unwrap();
        save(tmp.path(), "first", &message("main", ""), &[]).unwrap();
        assert!(
            Path::new(attachment).exists(),
            "another draft still owns the image"
        );
        save(tmp.path(), "second", &message("side", ""), &[]).unwrap();
        assert!(
            !Path::new(attachment).exists(),
            "sent/cleared images must not accumulate"
        );
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
