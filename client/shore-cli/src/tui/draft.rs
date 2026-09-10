use sha2::{Digest, Sha256};
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
    let mut directories = vec![directory.clone()];
    directories.extend(std::fs::read_dir(dir).ok()?.flatten().filter_map(|entry| {
        let name = entry.file_name();
        let text = name.to_str()?;
        (text.len() == 16 && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| entry.path())
    }));
    let mut paths: Vec<_> = directories
        .iter()
        .flat_map(|path| std::fs::read_dir(path).into_iter().flatten().flatten())
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
        return Some(
            save_locked(dir, owner, &draft, &[]).unwrap_or_else(|error| {
                tracing::warn!("could not update the recovered draft: {error}");
                draft
            }),
        );
    }
    let _legacy_lock = lock_session(dir, "legacy").ok()?;
    let legacy_path = dir.join("current.md");
    let text = std::fs::read_to_string(&legacy_path).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let mut migrated = identity.clone();
    migrated.text = text;
    let _saved = save_locked(dir, owner, &migrated, &[]).ok()?;
    std::fs::rename(legacy_path, dir.join(format!("legacy-{owner}.md"))).ok()?;
    Some(migrated)
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

#[derive(Debug)]
struct StoreLock(std::fs::File);

impl Drop for StoreLock {
    fn drop(&mut self) {
        if let Err(error) = self.0.unlock() {
            tracing::warn!("could not release the draft store lock: {error}");
        }
    }
}

fn lock_store(dir: &Path) -> std::io::Result<StoreLock> {
    std::fs::create_dir_all(dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("store.lock"))?;
    file.try_lock()?;
    Ok(StoreLock(file))
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
        let copy_required = owned_images.iter().any(|owned| owned == Path::new(image));
        if copy_required || Path::new(image).parent() == Some(dir.join("attachments").as_path()) {
            let attachments = dir.join("attachments");
            std::fs::create_dir_all(&attachments)?;
            let bytes = match std::fs::read(&*image) {
                Ok(bytes) => bytes,
                Err(_) if !copy_required => continue,
                Err(error) => return Err(error),
            };
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
    fn persisted_identity_has_a_specified_stable_directory() {
        assert_eq!(
            message("main", "").directory(std::path::Path::new("drafts")),
            std::path::Path::new(
                "drafts/v1-b8f85f2dbc3d1ad2fc9bcc055eb0b24167f53f8c775286a1ea333e86700a7b6a"
            )
        );
    }

    #[test]
    fn old_hash_directories_are_recovered_by_their_stored_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let original = message("main", "recover across toolchain changes");
        let old_directory = tmp.path().join("0123456789abcdef");
        std::fs::create_dir(&old_directory).unwrap();
        std::fs::write(
            old_directory.join("previous.json"),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        assert_eq!(load(tmp.path(), "new", &original), Some(original.clone()));
        assert!(original.directory(tmp.path()).join("new.json").exists());
        assert!(!old_directory.join("previous.json").exists());
    }

    #[test]
    fn migration_repairs_old_image_suffixes_without_discarding_missing_attachments() {
        let tmp = tempfile::tempdir().unwrap();
        let attachments = tmp.path().join("attachments");
        std::fs::create_dir(&attachments).unwrap();
        let old_image = attachments.join("old.png");
        std::fs::write(&old_image, b"\xff\xd8\xffpayload").unwrap();
        let missing = attachments
            .join("missing.png")
            .to_string_lossy()
            .into_owned();
        let mut original = message("main", "keep the entire draft");
        original.images = vec![old_image.to_string_lossy().into_owned(), missing.clone()];
        let old_directory = tmp.path().join("0123456789abcdef");
        std::fs::create_dir(&old_directory).unwrap();
        std::fs::write(
            old_directory.join("previous.json"),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        let recovered = load(tmp.path(), "next", &original).unwrap();
        assert_eq!(recovered.text, original.text);
        assert!(recovered.images.first().unwrap().ends_with(".jpg"));
        assert_eq!(recovered.images.get(1), Some(&missing));
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
        assert!(std::path::Path::new(snapshot.images.first().unwrap()).exists());
    }

    #[test]
    fn a_duplicated_descriptor_does_not_extend_a_finished_store_transaction() {
        let tmp = tempfile::tempdir().unwrap();
        let transaction = super::lock_store(tmp.path()).unwrap();
        let _inherited = transaction.0.try_clone().unwrap();
        drop(transaction);
        save(tmp.path(), "next", &message("main", "next draft"), &[]).unwrap();
        assert_eq!(
            load(tmp.path(), "reader", &message("main", "")),
            Some(message("main", "next draft"))
        );
    }

    #[test]
    fn recovered_uploads_keep_their_image_format() {
        for (bytes, suffix) in [
            (b"\xff\xd8\xffpayload".as_slice(), "jpg"),
            (b"GIF89apayload", "gif"),
            (b"RIFF0000WEBPpayload", "webp"),
            (b"\x89PNG\r\n\x1a\npayload", "png"),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let source = tmp.path().join("clipboard.png");
            std::fs::write(&source, bytes).unwrap();
            let mut original = message("main", "caption");
            original.images.push(source.to_string_lossy().into_owned());
            save(tmp.path(), "previous", &original, &[source]).unwrap();
            let recovered = load(tmp.path(), "next", &original).unwrap();
            let path = recovered.images.first().unwrap();
            let upload = shore_common::swp_client::read_image_upload(path).unwrap();
            assert!(
                upload.filename.ends_with(&format!(".{suffix}")),
                "{}",
                upload.filename
            );
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
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
            std::path::Path::new(attachment).exists(),
            "another draft still owns the image"
        );
        save(tmp.path(), "second", &message("side", ""), &[]).unwrap();
        assert!(
            !std::path::Path::new(attachment).exists(),
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
