use std::fs::File;
use std::io::{self, IsTerminal as _, Write as _};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use shore_common::protocol::operations::{
    BackupExported, ExportBackup, ExportBackupArgs, ExportCharacter, ExportCharacterArgs,
    ImportArchive, ImportArchiveArgs, ReadTransfer, ReadTransferArgs, WriteTransfer,
    WriteTransferArgs,
};
use shore_common::swp_client::SWPConnection;

use crate::run::{execute_operation, execute_operation_with_raw};

const CHUNK_BYTES: usize = 8 * 1024 * 1024;
const BACKUP_FOLDER: &str = "shore-backup";

type Failure = Box<dyn std::error::Error>;

pub(crate) async fn handle_export(
    conn: &mut SWPConnection,
    character: Option<&str>,
    output: Option<&Path>,
    full: bool,
    json: bool,
) -> Result<(), Failure> {
    let Some(name) = character else {
        return handle_backup(conn, output, full, json).await;
    };
    let target = archive_target(output, name)?;
    let raw = export_to(conn, name, &target).await?;
    if json {
        cli_out!("{}", serde_json::to_string_pretty(&raw)?);
        return Ok(());
    }
    let bytes = raw
        .get("bytes")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    cli_out!("Exported {name} to {} ({bytes} bytes).", target.display());
    Ok(())
}

async fn handle_backup(
    conn: &mut SWPConnection,
    output: Option<&Path>,
    full: bool,
    json: bool,
) -> Result<(), Failure> {
    let folder = PathBuf::from(crate::cli::absolute_path(
        output.unwrap_or_else(|| Path::new(BACKUP_FOLDER)),
    ));
    status(&format!("Checking the backup in {}...", folder.display()));
    let previous = crate::backups::prepare_folder(&folder, full)?;
    let base = match &previous {
        Some(backup) => {
            let listing = crate::backups::base_manifest(backup)?;
            Some(
                upload_reader(
                    conn,
                    listing.as_slice(),
                    listing.len(),
                    "Sending what the folder holds",
                )
                .await?,
            )
        }
        None => None,
    };
    status(if previous.is_some() {
        "Collecting what changed since the last export..."
    } else {
        "Collecting everything for the first export into this folder..."
    });
    let (data, mut raw) =
        execute_operation_with_raw::<ExportBackup>(conn, ExportBackupArgs { base }).await?;
    let delta = fetch(conn, &data.transfer, &folder).await?;
    status("Updating the folder...");
    let manifest = crate::backups::commit_update(&folder, delta)?;
    if json {
        if let Some(fields) = raw.as_object_mut() {
            _ = fields.remove("transfer");
            _ = fields.insert("archive".to_owned(), folder.display().to_string().into());
        }
        cli_out!("{}", serde_json::to_string_pretty(&raw)?);
        return Ok(());
    }
    let names = if manifest.characters.is_empty() {
        "no characters".to_owned()
    } else {
        manifest.characters.join(", ")
    };
    cli_out!(
        "Backed up {names} and the global configuration to {}.",
        folder.display()
    );
    cli_out!("{}", backup_summary(&data, previous.is_some()));
    Ok(())
}

fn backup_summary(data: &BackupExported, incremental: bool) -> String {
    let megabytes = data.bytes.checked_div(1_000_000).unwrap_or(0);
    if incremental {
        format!(
            "Changed since the last export: {} of {} files and {} of {} database blocks ({megabytes} MB downloaded).",
            data.files_sent, data.files, data.blocks_sent, data.blocks,
        )
    } else {
        format!(
            "Downloaded everything ({megabytes} MB); exporting to this folder again only sends what changed."
        )
    }
}

pub(crate) async fn handle_import(
    conn: &mut SWPConnection,
    archive: &Path,
    json: bool,
) -> Result<(), Failure> {
    let transfer = if archive.is_dir() {
        upload_folder(conn, archive).await?
    } else {
        upload(conn, archive).await?
    };
    let (data, raw) =
        execute_operation_with_raw::<ImportArchive>(conn, ImportArchiveArgs { transfer }).await?;
    if json {
        cli_out!("{}", serde_json::to_string_pretty(&raw)?);
        return Ok(());
    }
    for character in &data.characters {
        cli_out!("Imported character {character}.");
    }
    if !data.skipped.is_empty() {
        cli_out!("Left alone, already here: {}.", data.skipped.join(", "));
    }
    if !data.restored.is_empty() {
        cli_out!("Restored:");
        for path in &data.restored {
            cli_out!("  {path}");
        }
    }
    if !data.kept.is_empty() {
        cli_out!("Kept the daemon's own copy of:");
        for path in &data.kept {
            cli_out!("  {path}");
        }
    }
    if data.characters.is_empty() && data.restored.is_empty() {
        cli_out!(
            "Nothing to import: everything in {} is already here.",
            archive.display()
        );
    }
    Ok(())
}

pub(crate) fn archive_target(output: Option<&Path>, character: &str) -> Result<PathBuf, Failure> {
    let path = output.map_or_else(
        || PathBuf::from(format!("{character}.shore.tar")),
        Path::to_path_buf,
    );
    let target = PathBuf::from(crate::cli::absolute_path(&path));
    if target.symlink_metadata().is_ok() {
        return Err(format!("refusing to overwrite {}", target.display()).into());
    }
    if !target.parent().is_some_and(Path::is_dir) {
        return Err(format!("no directory to write {} into", target.display()).into());
    }
    Ok(target)
}

pub(crate) async fn export_to(
    conn: &mut SWPConnection,
    character: &str,
    target: &Path,
) -> Result<serde_json::Value, Failure> {
    status(&format!("Packing {character} on the daemon..."));
    let (data, mut raw) = execute_operation_with_raw::<ExportCharacter>(
        conn,
        ExportCharacterArgs {
            character: character.to_owned(),
            output: None,
        },
    )
    .await?;
    let transfer = data
        .transfer
        .ok_or("the daemon kept the archive instead of offering it for download")?;
    let bytes = download(conn, &transfer, target).await?;
    if let Some(fields) = raw.as_object_mut() {
        _ = fields.remove("transfer");
        _ = fields.insert("archive".to_owned(), target.display().to_string().into());
        _ = fields.insert("bytes".to_owned(), bytes.into());
    }
    Ok(raw)
}

async fn download(
    conn: &mut SWPConnection,
    transfer: &str,
    target: &Path,
) -> Result<usize, Failure> {
    let directory = target.parent().ok_or("the archive path has no directory")?;
    let file = fetch(conn, transfer, directory).await?;
    let bytes = usize::try_from(file.as_file().metadata()?.len())?;
    _ = file
        .persist_noclobber(target)
        .map_err(|error| error.error)?;
    Ok(bytes)
}

async fn fetch(
    conn: &mut SWPConnection,
    transfer: &str,
    directory: &Path,
) -> Result<tempfile::NamedTempFile, Failure> {
    let mut file = tempfile::Builder::new()
        .prefix(".shore-download-")
        .tempfile_in(directory)?;
    let mut offset = 0_usize;
    loop {
        let chunk = execute_operation::<ReadTransfer>(
            conn,
            ReadTransferArgs {
                transfer: transfer.to_owned(),
                offset,
            },
        )
        .await?;
        let bytes = STANDARD.decode(&chunk.data)?;
        if chunk.offset != offset || bytes.is_empty() {
            return Err("the daemon sent the wrong part of the archive".into());
        }
        file.write_all(&bytes)?;
        offset = offset
            .checked_add(bytes.len())
            .ok_or("the archive is too large")?;
        progress("Downloading", offset, chunk.bytes);
        if offset >= chunk.bytes {
            break;
        }
    }
    file.as_file().sync_all()?;
    Ok(file)
}

async fn upload_folder(conn: &mut SWPConnection, folder: &Path) -> Result<String, Failure> {
    let backup = crate::backups::open_backup(folder)?
        .ok_or_else(|| format!("{} is not a Shore backup folder", folder.display()))?;
    let directory = folder
        .parent()
        .ok_or("the backup folder has no parent directory")?;
    let archive = tempfile::Builder::new()
        .prefix(".shore-restore-")
        .tempfile_in(directory)?;
    status("Packing the backup...");
    crate::backups::write_restore_archive(&backup, archive.as_file())?;
    upload(conn, archive.path()).await
}

async fn upload(conn: &mut SWPConnection, archive: &Path) -> Result<String, Failure> {
    let file = File::open(archive).map_err(|error| format!("{}: {error}", archive.display()))?;
    let total = usize::try_from(file.metadata()?.len())?;
    upload_reader(conn, file, total, "Uploading").await
}

async fn upload_reader<R: io::Read>(
    conn: &mut SWPConnection,
    mut file: R,
    total: usize,
    verb: &str,
) -> Result<String, Failure> {
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    let mut transfer: Option<String> = None;
    let mut sent = 0_usize;
    loop {
        let filled = fill(&mut file, &mut buffer)?;
        let Some(chunk) = buffer.get(..filled).filter(|chunk| !chunk.is_empty()) else {
            break;
        };
        let written = execute_operation::<WriteTransfer>(
            conn,
            WriteTransferArgs {
                transfer: transfer.take(),
                data: STANDARD.encode(chunk),
            },
        )
        .await?;
        transfer = Some(written.transfer);
        sent = sent.checked_add(filled).ok_or("the archive is too large")?;
        progress(verb, sent, total);
    }
    transfer.ok_or_else(|| "there was nothing to upload".into())
}

fn fill<R: io::Read>(file: &mut R, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while let Some(rest) = buffer.get_mut(filled..) {
        match file.read(rest)? {
            0 => break,
            read => filled = filled.saturating_add(read),
        }
        if filled == buffer.len() {
            break;
        }
    }
    Ok(filled)
}

fn status(text: &str) {
    if io::stderr().is_terminal() {
        cli_err!("{text}");
    }
}

fn progress(verb: &str, done: usize, total: usize) {
    let stderr = io::stderr();
    if !stderr.is_terminal() {
        return;
    }
    let mut out = stderr.lock();
    let percent = done
        .saturating_mul(100)
        .checked_div(total)
        .unwrap_or(100)
        .min(100);
    _ = write!(
        out,
        "\r{verb} {} of {} MB ({percent}%)",
        done.checked_div(1_000_000).unwrap_or(0),
        total.checked_div(1_000_000).unwrap_or(0),
    );
    if done >= total {
        _ = writeln!(out);
    }
    _ = out.flush();
}
