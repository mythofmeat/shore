use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Permissions};
use std::io::{self, BufReader, BufWriter, Read, Seek as _, SeekFrom, Write as _};
use std::os::unix::fs::{PermissionsExt as _, symlink};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

type Failure = Box<dyn std::error::Error>;

const FORMAT: &str = "shore-backup";
const VERSION: u64 = 2;
const MANIFEST: &str = "manifest.json";
const DATABASE: &str = "data/shore.db";
const BLOCKS: &str = "shore.db.blocks";
const PENDING: &str = ".shore-update.tar";
const TOP_LEVEL: [&str; 4] = ["config", "data", "workspace", "cache"];
const MTIME_SLACK: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct Manifest {
    format: String,
    version: u64,
    created_at: String,
    pub(crate) characters: Vec<String>,
    source: Source,
    entries: Vec<Entry>,
    database: Database,
}

#[derive(Debug, Deserialize, Serialize)]
struct Source {
    data: String,
    cache: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Entry {
    File {
        path: String,
        mode: u32,
        size: u64,
        mtime: String,
    },
    Directory {
        path: String,
        mode: u32,
    },
    Symlink {
        path: String,
        target: String,
    },
}

impl Entry {
    fn path(&self) -> &str {
        match self {
            Self::File { path, .. } | Self::Directory { path, .. } | Self::Symlink { path, .. } => {
                path
            }
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct Database {
    bytes: u64,
    block_bytes: u64,
    blocks: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct Backup {
    pub(crate) root: PathBuf,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
}

pub(crate) fn is_backup(path: &Path) -> bool {
    path.join(MANIFEST).is_file() || path.join(PENDING).is_file()
}

pub(crate) fn open_backup(root: &Path) -> Result<Option<Backup>, Failure> {
    if root.join(PENDING).is_file() {
        _ = apply_pending(root)?;
    }
    let path = root.join(MANIFEST);
    if !path.is_file() {
        return Ok(None);
    }
    let manifest_bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let manifest = parse_manifest(&manifest_bytes)?;
    Ok(Some(Backup {
        root: root.to_path_buf(),
        manifest,
        manifest_bytes,
    }))
}

pub(crate) fn prepare_folder(root: &Path, full: bool) -> Result<Option<Backup>, Failure> {
    fs::create_dir_all(root).map_err(|error| format!("{}: {error}", root.display()))?;
    if !is_backup(root) && fs::read_dir(root)?.next().is_some() {
        return Err(format!(
            "{} holds other files and no Shore backup; choose a new or empty folder",
            root.display()
        )
        .into());
    }
    if full {
        if root.join(PENDING).is_file() {
            fs::remove_file(root.join(PENDING))?;
        }
        return Ok(None);
    }
    open_backup(root)
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, Failure> {
    let manifest: Manifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("not a Shore backup manifest: {error}"))?;
    if manifest.format != FORMAT || manifest.version != VERSION {
        return Err(format!(
            "this is a {} version {} manifest; this shore reads {FORMAT} version {VERSION}",
            manifest.format, manifest.version
        )
        .into());
    }
    for entry in &manifest.entries {
        _ = tree_path(Path::new(""), entry.path())?;
    }
    if manifest.database.block_bytes == 0 {
        return Err("the manifest's database has no block size".into());
    }
    Ok(manifest)
}

fn tree_path(root: &Path, path: &str) -> Result<PathBuf, Failure> {
    let relative = Path::new(path);
    let mut components = relative.components();
    let top = matches!(components.next(), Some(Component::Normal(name)) if TOP_LEVEL.iter().any(|allowed| name == *allowed));
    if !top
        || path.contains('\0')
        || !components.all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!("the backup names an unsafe path: {path}").into());
    }
    Ok(root.join(relative))
}

fn block_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn block_len(database: &Database, index: usize) -> Result<u64, Failure> {
    let last = database.blocks.len().checked_sub(1).ok_or("no blocks")?;
    if index < last {
        return Ok(database.block_bytes);
    }
    let before = database
        .block_bytes
        .checked_mul(u64::try_from(last)?)
        .ok_or("the database is too large")?;
    database
        .bytes
        .checked_sub(before)
        .filter(|bytes| (1..=database.block_bytes).contains(bytes))
        .ok_or_else(|| "the manifest's database size does not match its blocks".into())
}

fn block_index(database: &Database, offset: u64) -> Result<usize, Failure> {
    let rest = offset
        .checked_rem(database.block_bytes)
        .ok_or("no block size")?;
    let index = usize::try_from(
        offset
            .checked_div(database.block_bytes)
            .ok_or("no block size")?,
    )?;
    if rest != 0 || index >= database.blocks.len() {
        return Err(
            format!("the backup sent a database block at {offset} it does not list").into(),
        );
    }
    Ok(index)
}

fn hashes_of<R: Read>(source: &mut R, block_bytes: u64) -> Result<(Vec<String>, u64), Failure> {
    let mut buffer = vec![0_u8; usize::try_from(block_bytes)?];
    let mut hashes = Vec::new();
    let mut total = 0_u64;
    loop {
        let filled = fill(source, &mut buffer)?;
        let Some(block) = buffer.get(..filled).filter(|block| !block.is_empty()) else {
            return Ok((hashes, total));
        };
        hashes.push(block_hash(block));
        total = total
            .checked_add(u64::try_from(filled)?)
            .ok_or("the database is too large")?;
    }
}

fn fill<R: Read>(source: &mut R, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while let Some(rest) = buffer.get_mut(filled..).filter(|rest| !rest.is_empty()) {
        match source.read(rest)? {
            0 => break,
            read => filled = filled.saturating_add(read),
        }
    }
    Ok(filled)
}

fn nanos(time: SystemTime) -> Result<u128, Failure> {
    Ok(time.duration_since(SystemTime::UNIX_EPOCH)?.as_nanos())
}

fn modified(mtime: &str) -> Result<SystemTime, Failure> {
    let nanos: u64 = mtime.parse()?;
    SystemTime::UNIX_EPOCH
        .checked_add(Duration::from_nanos(nanos))
        .ok_or_else(|| format!("{mtime} is not a usable time").into())
}

fn matches_local(root: &Path, entry: &Entry) -> bool {
    let Entry::File {
        path, size, mtime, ..
    } = entry
    else {
        return true;
    };
    let (Ok(target), Ok(expected)) = (tree_path(root, path), mtime.parse::<u128>()) else {
        return false;
    };
    let Ok(info) = fs::symlink_metadata(target) else {
        return false;
    };
    let Ok(actual) = info.modified().map_err(Failure::from).and_then(nanos) else {
        return false;
    };
    info.is_file() && info.len() == *size && actual.abs_diff(expected) <= MTIME_SLACK.as_nanos()
}

pub(crate) fn base_manifest(backup: &Backup) -> Result<Vec<u8>, Failure> {
    let manifest = &backup.manifest;
    let entries = manifest
        .entries
        .iter()
        .filter(|entry| matches_local(&backup.root, entry))
        .cloned()
        .collect();
    let path = backup.root.join(DATABASE);
    let database = match File::open(&path) {
        Ok(_) if database_unchanged(&path, manifest) => Database {
            bytes: manifest.database.bytes,
            block_bytes: manifest.database.block_bytes,
            blocks: manifest.database.blocks.clone(),
        },
        Ok(file) => {
            let (blocks, bytes) =
                hashes_of(&mut BufReader::new(file), manifest.database.block_bytes)?;
            Database {
                bytes,
                block_bytes: manifest.database.block_bytes,
                blocks,
            }
        }
        Err(_) => Database {
            bytes: 0,
            block_bytes: 0,
            blocks: Vec::new(),
        },
    };
    let base = Manifest {
        format: manifest.format.clone(),
        version: manifest.version,
        created_at: manifest.created_at.clone(),
        characters: manifest.characters.clone(),
        source: Source {
            data: manifest.source.data.clone(),
            cache: manifest.source.cache.clone(),
        },
        entries,
        database,
    };
    Ok(serde_json::to_vec(&base)?)
}

fn stamp(manifest: &Manifest) -> Result<SystemTime, Failure> {
    Ok(chrono::DateTime::parse_from_rfc3339(&manifest.created_at)?.into())
}

fn database_unchanged(path: &Path, manifest: &Manifest) -> bool {
    let (Ok(info), Ok(expected)) = (fs::symlink_metadata(path), stamp(manifest)) else {
        return false;
    };
    let (Ok(actual), Ok(wanted)) = (
        info.modified().map_err(Failure::from).and_then(nanos),
        nanos(expected),
    ) else {
        return false;
    };
    info.is_file()
        && info.len() == manifest.database.bytes
        && actual.abs_diff(wanted) <= MTIME_SLACK.as_nanos()
}

fn delta_manifest(path: &Path) -> Result<(Manifest, Vec<u8>), Failure> {
    let mut archive = tar::Archive::new(File::open(path)?);
    for item in archive.entries_with_seek()? {
        let mut entry = item?;
        if entry.path()?.as_os_str() == MANIFEST {
            let mut bytes = Vec::new();
            _ = entry.read_to_end(&mut bytes)?;
            return Ok((parse_manifest(&bytes)?, bytes));
        }
    }
    Err("the backup has no manifest.json".into())
}

enum Part {
    Manifest,
    Database,
    Block(u64),
    File(String),
}

fn part(name: &str) -> Result<Part, Failure> {
    if name == MANIFEST {
        return Ok(Part::Manifest);
    }
    if name == DATABASE {
        return Ok(Part::Database);
    }
    if let Some(offset) = name
        .strip_prefix(BLOCKS)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        return Ok(Part::Block(offset.parse()?));
    }
    _ = tree_path(Path::new(""), name)?;
    Ok(Part::File(name.to_owned()))
}

fn entry_name<R: Read>(entry: &tar::Entry<'_, R>) -> Result<Option<String>, Failure> {
    let kind = entry.header().entry_type();
    if kind.is_dir() || kind.is_symlink() {
        return Ok(None);
    }
    if !kind.is_file() {
        return Err("the backup holds something other than files, folders and links".into());
    }
    Ok(Some(
        entry
            .path()?
            .to_str()
            .ok_or("the backup names a path that is not UTF-8")?
            .to_owned(),
    ))
}

fn verify_delta(delta: &Path, manifest: &Manifest) -> Result<(), Failure> {
    let files: HashMap<&str, u64> = manifest
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::File { path, size, .. } => Some((path.as_str(), *size)),
            Entry::Directory { .. } | Entry::Symlink { .. } => None,
        })
        .collect();
    let database = &manifest.database;
    let mut archive = tar::Archive::new(BufReader::new(File::open(delta)?));
    for item in archive.entries()? {
        let mut entry = item?;
        let Some(name) = entry_name(&entry)? else {
            continue;
        };
        match part(&name)? {
            Part::Manifest => {}
            Part::Database => {
                let (hashes, bytes) = hashes_of(&mut entry, database.block_bytes)?;
                if bytes != database.bytes || hashes != database.blocks {
                    return Err("the database arrived damaged".into());
                }
            }
            Part::Block(offset) => {
                let index = block_index(database, offset)?;
                let mut block = Vec::new();
                _ = entry.read_to_end(&mut block)?;
                if u64::try_from(block.len())? != block_len(database, index)?
                    || database.blocks.get(index) != Some(&block_hash(&block))
                {
                    return Err(format!("database block {index} arrived damaged").into());
                }
            }
            Part::File(file) => {
                if files.get(file.as_str()) != Some(&entry.size()) {
                    return Err(format!(
                        "the backup sent {file}, which its manifest does not list at that size"
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn commit_update(
    root: &Path,
    delta: tempfile::NamedTempFile,
) -> Result<Manifest, Failure> {
    let (manifest, _) = delta_manifest(delta.path())?;
    verify_delta(delta.path(), &manifest)?;
    delta.as_file().sync_all()?;
    _ = delta
        .persist(root.join(PENDING))
        .map_err(|error| error.error)?;
    File::open(root)?.sync_all()?;
    apply_pending(root)
}

fn make_dirs(root: &Path, path: &Path) -> Result<(), Failure> {
    let relative = path.strip_prefix(root)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(info) if info.is_dir() => continue,
            Ok(_) => fs::remove_file(&current)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        fs::create_dir(&current)?;
    }
    Ok(())
}

fn clear(path: &Path) -> Result<(), Failure> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn place<R: Read>(root: &Path, source: &mut R, target: &Path) -> Result<(), Failure> {
    let parent = target.parent().ok_or("a backup path has no folder")?;
    make_dirs(root, parent)?;
    let mut file = tempfile::Builder::new()
        .prefix(".shore-new-")
        .tempfile_in(parent)?;
    _ = io::copy(source, &mut file)?;
    file.as_file().sync_all()?;
    if fs::symlink_metadata(target).is_ok_and(|info| info.is_dir()) {
        fs::remove_dir_all(target)?;
    }
    _ = file.persist(target).map_err(|error| error.error)?;
    Ok(())
}

fn apply_pending(root: &Path) -> Result<Manifest, Failure> {
    let pending = root.join(PENDING);
    let (manifest, manifest_bytes) = delta_manifest(&pending)?;
    let previous = fs::read(root.join(MANIFEST))
        .ok()
        .and_then(|bytes| parse_manifest(&bytes).ok());
    let database_path = tree_path(root, DATABASE)?;
    let mut received = HashSet::new();
    let mut archive = tar::Archive::new(BufReader::new(File::open(&pending)?));
    let mut database: Option<File> = None;
    for item in archive.entries()? {
        let mut entry = item?;
        let Some(name) = entry_name(&entry)? else {
            continue;
        };
        match part(&name)? {
            Part::Manifest => {}
            Part::Database => place(root, &mut entry, &database_path)?,
            Part::Block(offset) => {
                let file = match database.as_mut() {
                    Some(file) => file,
                    None => {
                        if !fs::symlink_metadata(&database_path).is_ok_and(|info| info.is_file()) {
                            return Err("the backup folder lost data/shore.db; run the export again with --full".into());
                        }
                        database.insert(File::options().write(true).open(&database_path)?)
                    }
                };
                _ = file.seek(SeekFrom::Start(offset))?;
                _ = io::copy(&mut entry, file)?;
            }
            Part::File(file) => {
                place(root, &mut entry, &tree_path(root, &file)?)?;
                _ = received.insert(file);
            }
        }
    }
    if let Some(file) = database.take() {
        file.set_len(manifest.database.bytes)?;
        file.sync_all()?;
    }
    if fs::symlink_metadata(&database_path)?.len() != manifest.database.bytes {
        return Err("data/shore.db in the backup folder is the wrong size; run the export again with --full".into());
    }
    File::options()
        .write(true)
        .open(&database_path)?
        .set_modified(stamp(&manifest)?)?;

    let listed: HashSet<&str> = manifest.entries.iter().map(Entry::path).collect();
    if let Some(old) = &previous {
        let mut gone: Vec<&Entry> = old
            .entries
            .iter()
            .filter(|entry| !listed.contains(entry.path()))
            .collect();
        gone.reverse();
        for entry in gone {
            let target = tree_path(root, entry.path())?;
            match entry {
                Entry::Directory { .. } => {
                    if fs::symlink_metadata(&target).is_ok_and(|info| info.is_dir()) {
                        _ = fs::remove_dir(&target);
                    }
                }
                Entry::File { .. } | Entry::Symlink { .. } => {
                    if fs::symlink_metadata(&target).is_ok_and(|info| !info.is_dir()) {
                        fs::remove_file(&target)?;
                    }
                }
            }
        }
    }

    let mut directories = Vec::new();
    for entry in &manifest.entries {
        let target = tree_path(root, entry.path())?;
        match entry {
            Entry::Directory { mode, .. } => {
                make_dirs(root, &target)?;
                directories.push((target, *mode));
            }
            Entry::Symlink { target: link, .. } => {
                let parent = target.parent().ok_or("a backup path has no folder")?;
                make_dirs(root, parent)?;
                if fs::read_link(&target).ok().as_deref() != Some(Path::new(link)) {
                    clear(&target)?;
                    symlink(link, &target)?;
                }
            }
            Entry::File {
                path,
                mode,
                size,
                mtime,
            } => {
                let info = fs::symlink_metadata(&target).map_err(|_| {
                    format!("the backup folder lost {path}; run the export again with --full")
                })?;
                if !info.is_file() || info.len() != *size {
                    return Err(format!("{path} in the backup folder is not what the backup says; run the export again with --full").into());
                }
                if received.contains(path) {
                    File::options()
                        .write(true)
                        .open(&target)?
                        .set_modified(modified(mtime)?)?;
                    fs::set_permissions(&target, Permissions::from_mode(*mode))?;
                }
            }
        }
    }
    for (target, mode) in directories.iter().rev() {
        fs::set_permissions(target, Permissions::from_mode(*mode))?;
    }
    place(root, &mut manifest_bytes.as_slice(), &root.join(MANIFEST))?;
    fs::remove_file(&pending)?;
    File::open(root)?.sync_all()?;
    Ok(manifest)
}

pub(crate) fn write_restore_archive(backup: &Backup, out: &File) -> Result<(), Failure> {
    let root = &backup.root;
    let manifest = &backup.manifest;
    let mut builder = tar::Builder::new(BufWriter::new(out));
    builder.follow_symlinks(false);
    builder.mode(tar::HeaderMode::Complete);
    for entry in &manifest.entries {
        match entry {
            Entry::Directory { path, .. } => builder.append_dir(path, tree_path(root, path)?)?,
            Entry::File { path, .. } => {
                builder.append_path_with_name(tree_path(root, path)?, path)?;
            }
            Entry::Symlink { path, target } => {
                _ = tree_path(root, path)?;
                let mut link = tar::Header::new_gnu();
                link.set_entry_type(tar::EntryType::Symlink);
                link.set_size(0);
                link.set_mode(0o777);
                builder.append_link(&mut link, path, target)?;
            }
        }
    }
    let database = tree_path(root, DATABASE)?;
    if fs::symlink_metadata(&database)?.len() != manifest.database.bytes {
        return Err("data/shore.db in the backup folder is not what the backup says".into());
    }
    builder.append_path_with_name(&database, DATABASE)?;
    let mut listing = tar::Header::new_gnu();
    listing.set_entry_type(tar::EntryType::Regular);
    listing.set_size(u64::try_from(backup.manifest_bytes.len())?);
    listing.set_mode(0o600);
    builder.append_data(&mut listing, MANIFEST, backup.manifest_bytes.as_slice())?;
    builder.into_inner()?.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Read as _, Write as _};
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::Path;

    use serde_json::{Value, json};

    fn delta(folder: &Path, files: &[(&str, &[u8])], manifest: &Value) -> tempfile::NamedTempFile {
        let mut file = tempfile::Builder::new()
            .prefix(".shore-download-")
            .tempfile_in(folder)
            .expect("delta file");
        {
            let mut builder = tar::Builder::new(file.as_file_mut());
            let text = serde_json::to_vec(manifest).expect("encode the manifest");
            for (name, bytes) in files
                .iter()
                .copied()
                .chain(std::iter::once(("manifest.json", text.as_slice())))
            {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(u64::try_from(bytes.len()).expect("small"));
                header.set_mode(0o644);
                let field = &mut header.as_old_mut().name;
                field.fill(0);
                for (slot, byte) in field.iter_mut().zip(name.bytes()) {
                    *slot = byte;
                }
                header.set_cksum();
                builder.append(&header, bytes).expect("append to the delta");
            }
            builder.finish().expect("finish the delta");
        }
        file.as_file_mut().flush().expect("flush the delta");
        file
    }

    fn file(path: &str, mode: u32, bytes: &[u8], mtime: &str) -> Value {
        json!({ "path": path, "kind": "file", "mode": mode, "size": bytes.len(), "mtime": mtime })
    }

    fn manifest(entries: &[Value], database: &[u8]) -> Value {
        let blocks: Vec<String> = database.chunks(4096).map(super::block_hash).collect();
        json!({
            "format": "shore-backup",
            "version": 2,
            "created_at": "2026-10-21T00:00:00Z",
            "characters": ["ada"],
            "source": { "data": "/srv/data", "cache": "/srv/cache" },
            "entries": entries,
            "database": { "bytes": database.len(), "block_bytes": 4096, "blocks": blocks },
        })
    }

    fn first(folder: &Path, database: &[u8]) {
        fs::create_dir_all(folder).expect("folder");
        let entries = [
            json!({ "path": "workspace/ada", "kind": "directory", "mode": 0o755 }),
            file(
                "workspace/ada/SOUL.md",
                0o644,
                b"You are ada.\n",
                "1700000000000000000",
            ),
            file(
                "workspace/ada/notes.md",
                0o600,
                b"one\n",
                "1700000000000000001",
            ),
            file(
                "workspace/ada/gone.md",
                0o644,
                b"bye\n",
                "1700000000000000002",
            ),
            json!({ "path": "workspace/ada/soul", "kind": "symlink", "target": "SOUL.md" }),
        ];
        _ = super::commit_update(
            folder,
            delta(
                folder,
                &[
                    ("workspace/ada/SOUL.md", b"You are ada.\n"),
                    ("workspace/ada/notes.md", b"one\n"),
                    ("workspace/ada/gone.md", b"bye\n"),
                    ("data/shore.db", database),
                ],
                &manifest(&entries, database),
            ),
        )
        .expect("first export");
    }

    fn database(len: u32, fill: u8) -> Vec<u8> {
        (0..len)
            .map(|i| {
                u8::try_from(i.rem_euclid(251))
                    .expect("small")
                    .wrapping_add(fill)
            })
            .collect()
    }

    fn later_entries() -> Vec<Value> {
        vec![
            json!({ "path": "workspace/ada", "kind": "directory", "mode": 0o755 }),
            file(
                "workspace/ada/SOUL.md",
                0o644,
                b"You are ada.\n",
                "1700000000000000000",
            ),
            file(
                "workspace/ada/notes.md",
                0o600,
                b"two\n",
                "1700000000000000005",
            ),
            file(
                "workspace/ada/new.md",
                0o644,
                b"hello\n",
                "1700000000000000006",
            ),
            json!({ "path": "workspace/ada/soul", "kind": "symlink", "target": "notes.md" }),
        ]
    }

    #[test]
    fn exporting_into_the_same_folder_again_updates_its_one_copy_in_place() {
        let dir = tempfile::tempdir().expect("scratch");
        let folder = dir.path().join("shore-backup");
        assert!(
            super::prepare_folder(&folder, false)
                .expect("prepare")
                .is_none(),
            "a new folder holds no backup"
        );
        let before = database(10240, 0);
        first(&folder, &before);
        let notes = folder.join("workspace/ada/notes.md");
        assert_eq!(
            fs::read(&notes).expect("notes"),
            b"one\n",
            "files land in the folder"
        );
        assert_eq!(
            fs::metadata(&notes).expect("notes").permissions().mode() & 0o777,
            0o600,
            "file modes come from the manifest"
        );
        assert_eq!(
            fs::read(folder.join("data/shore.db")).expect("database"),
            before,
            "the database is one plain file"
        );
        fs::write(folder.join("workspace/ada/mine.txt"), "kept\n")
            .expect("a file of the user's own");

        let backup = super::prepare_folder(&folder, false)
            .expect("reopen")
            .expect("a backup now");
        let base: Value = serde_json::from_slice(&super::base_manifest(&backup).expect("base"))
            .expect("base json");
        assert_eq!(
            base.pointer("/database/blocks"),
            manifest(&[], &before).pointer("/database/blocks"),
            "the base describes the database the folder really holds"
        );

        let mut after = before.clone();
        after.truncate(8192);
        after.extend(database(3808, 9));
        if let Some(byte) = after.get_mut(5000) {
            *byte = 0xff;
        }
        let blocks: Vec<&[u8]> = after.chunks(4096).collect();
        _ = super::commit_update(
            &folder,
            delta(
                &folder,
                &[
                    ("workspace/ada/notes.md", b"two\n"),
                    ("workspace/ada/new.md", b"hello\n"),
                    (
                        "shore.db.blocks/4096",
                        blocks.get(1).copied().expect("block 1"),
                    ),
                    (
                        "shore.db.blocks/8192",
                        blocks.get(2).copied().expect("block 2"),
                    ),
                ],
                &manifest(&later_entries(), &after),
            ),
        )
        .expect("second export");
        assert_eq!(
            fs::read(&notes).expect("notes"),
            b"two\n",
            "changed files are replaced"
        );
        assert_eq!(
            fs::read(folder.join("workspace/ada/new.md")).expect("new"),
            b"hello\n",
            "new files arrive"
        );
        assert!(
            !folder.join("workspace/ada/gone.md").exists(),
            "files gone from the daemon go from the folder"
        );
        assert_eq!(
            fs::read(folder.join("data/shore.db")).expect("database"),
            after,
            "the database is patched in place"
        );
        assert_eq!(
            fs::read_link(folder.join("workspace/ada/soul")).expect("link"),
            Path::new("notes.md"),
            "links follow the manifest"
        );
        assert_eq!(
            fs::read(folder.join("workspace/ada/mine.txt")).expect("mine"),
            b"kept\n",
            "unlisted files are left alone"
        );
        assert!(
            !folder.join(super::PENDING).exists(),
            "a finished update leaves no journal"
        );
        let names: Vec<String> = fs::read_dir(&folder)
            .expect("folder")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(
            names.is_empty(),
            "no temporary files stay behind: {names:?}"
        );

        let restore = dir.path().join("restore.tar");
        super::write_restore_archive(
            &super::open_backup(&folder).expect("open").expect("backup"),
            &fs::File::create(&restore).expect("restore archive"),
        )
        .expect("pack the restore");
        let mut archive = tar::Archive::new(fs::File::open(&restore).expect("reopen the restore"));
        let mut restored = Vec::new();
        for item in archive.entries().expect("entries") {
            let mut entry = item.expect("entry");
            if entry.path().expect("path").as_os_str() == "data/shore.db" {
                _ = entry.read_to_end(&mut restored).expect("database");
            }
        }
        assert_eq!(restored, after, "the restore carries the database");
    }

    #[test]
    fn an_update_interrupted_after_it_arrived_is_finished_by_the_next_export() {
        let dir = tempfile::tempdir().expect("scratch");
        let folder = dir.path().join("shore-backup");
        let before = database(10240, 0);
        first(&folder, &before);
        let after = database(10240, 3);
        let pending = delta(
            &folder,
            &[
                ("workspace/ada/notes.md", b"two\n"),
                ("workspace/ada/new.md", b"hello\n"),
                ("data/shore.db", &after),
            ],
            &manifest(&later_entries(), &after),
        );
        _ = pending
            .persist(folder.join(super::PENDING))
            .expect("leave the update pending");
        assert!(
            super::prepare_folder(&folder, false)
                .expect("prepare")
                .is_some(),
            "the folder is still a backup"
        );
        assert_eq!(
            fs::read(folder.join("data/shore.db")).expect("database"),
            after,
            "the pending update was applied"
        );
        assert!(
            !folder.join("workspace/ada/gone.md").exists(),
            "including its removals"
        );
        assert!(
            !folder.join(super::PENDING).exists(),
            "and its journal is gone"
        );
    }

    #[test]
    fn a_damaged_or_unsafe_update_is_refused_before_the_folder_changes() {
        let dir = tempfile::tempdir().expect("scratch");
        let folder = dir.path().join("shore-backup");
        let before = database(10240, 0);
        first(&folder, &before);
        let after = database(10240, 3);
        let damaged = delta(
            &folder,
            &[("shore.db.blocks/4096", &[0_u8; 4096])],
            &manifest(&later_entries(), &after),
        );
        assert!(
            super::commit_update(&folder, damaged).is_err(),
            "a block that does not match its hash is refused"
        );
        for name in [
            "../escape.md",
            "workspace/../../escape.md",
            "elsewhere/escape.md",
        ] {
            let unsafe_delta = delta(
                &folder,
                &[(name, b"x")],
                &manifest(&later_entries(), &before),
            );
            assert!(
                super::commit_update(&folder, unsafe_delta).is_err(),
                "{name} must be refused"
            );
            assert!(
                !dir.path().join("escape.md").exists(),
                "{name} wrote outside the folder"
            );
        }
        assert_eq!(
            fs::read(folder.join("data/shore.db")).expect("database"),
            before,
            "the database is untouched"
        );
        assert_eq!(
            fs::read(folder.join("workspace/ada/notes.md")).expect("notes"),
            b"one\n",
            "files are untouched"
        );
        assert!(
            !folder.join(super::PENDING).exists(),
            "nothing was left pending"
        );
    }

    #[test]
    fn a_database_changed_in_the_folder_is_described_as_it_now_is() {
        let dir = tempfile::tempdir().expect("scratch");
        let folder = dir.path().join("shore-backup");
        let before = database(10240, 0);
        first(&folder, &before);
        let mut touched = before.clone();
        if let Some(byte) = touched.get_mut(10) {
            *byte = byte.wrapping_add(1);
        }
        fs::write(folder.join("data/shore.db"), &touched).expect("someone edits the copy");
        let backup = super::prepare_folder(&folder, false)
            .expect("reopen")
            .expect("a backup");
        let base: Value = serde_json::from_slice(&super::base_manifest(&backup).expect("base"))
            .expect("base json");
        assert_eq!(
            base.pointer("/database/blocks"),
            manifest(&[], &touched).pointer("/database/blocks"),
            "the daemon is told what the folder holds, so it resends the edited block"
        );
    }

    #[test]
    fn a_folder_holding_other_things_is_not_used_as_a_backup() {
        let dir = tempfile::tempdir().expect("scratch");
        fs::write(dir.path().join("photo.jpg"), "not a backup").expect("other file");
        assert!(
            super::prepare_folder(dir.path(), false).is_err(),
            "an unrelated folder is refused"
        );
        assert!(
            super::prepare_folder(dir.path(), true).is_err(),
            "even with --full"
        );
    }
}
