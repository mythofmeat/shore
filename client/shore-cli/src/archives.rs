use std::fs::File;
use std::io::{self, IsTerminal as _, Read as _, Write as _};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use shore_common::protocol::operations::{
    EmptyOperationArgs, ExportBackup, ExportCharacter, ExportCharacterArgs, ImportArchive,
    ImportArchiveArgs, ReadTransfer, ReadTransferArgs, WriteTransfer, WriteTransferArgs,
};
use shore_common::swp_client::SWPConnection;

use crate::run::{execute_operation, execute_operation_with_raw};

const CHUNK_BYTES: usize = 8 * 1024 * 1024;

type Failure = Box<dyn std::error::Error>;

pub(crate) async fn handle_export(
    conn: &mut SWPConnection,
    character: Option<&str>,
    output: Option<&Path>,
    json: bool,
) -> Result<(), Failure> {
    let target = archive_target(output, character)?;
    let raw = export_to(conn, character, &target).await?;
    if json {
        cli_out!("{}", serde_json::to_string_pretty(&raw)?);
        return Ok(());
    }
    let bytes = raw
        .get("bytes")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    match character {
        Some(name) => cli_out!("Exported {name} to {} ({bytes} bytes).", target.display()),
        None => {
            let names = raw
                .get("characters")
                .and_then(serde_json::Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            cli_out!(
                "Backed up {} and the global configuration to {} ({bytes} bytes).",
                if names.is_empty() {
                    "no characters"
                } else {
                    names.as_str()
                },
                target.display(),
            );
        }
    }
    Ok(())
}

pub(crate) async fn handle_import(
    conn: &mut SWPConnection,
    archive: &Path,
    json: bool,
) -> Result<(), Failure> {
    let transfer = upload(conn, archive).await?;
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

pub(crate) fn archive_target(
    output: Option<&Path>,
    character: Option<&str>,
) -> Result<PathBuf, Failure> {
    let path = match (output, character) {
        (Some(path), _) => path.to_path_buf(),
        (None, Some(name)) => PathBuf::from(format!("{name}.shore.tar")),
        (None, None) => PathBuf::from(format!(
            "shore-backup-{}.tar",
            chrono::Local::now().format("%Y-%m-%d-%H%M%S")
        )),
    };
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
    character: Option<&str>,
    target: &Path,
) -> Result<serde_json::Value, Failure> {
    status(&format!(
        "Packing {} on the daemon...",
        character.unwrap_or("every character")
    ));
    let (transfer, mut raw) = match character {
        Some(name) => {
            let (data, raw) = execute_operation_with_raw::<ExportCharacter>(
                conn,
                ExportCharacterArgs {
                    character: name.to_owned(),
                    output: None,
                },
            )
            .await?;
            let transfer = data
                .transfer
                .ok_or("the daemon kept the archive instead of offering it for download")?;
            (transfer, raw)
        }
        None => {
            let (data, raw) =
                execute_operation_with_raw::<ExportBackup>(conn, EmptyOperationArgs {}).await?;
            (data.transfer, raw)
        }
    };
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
    _ = file
        .persist_noclobber(target)
        .map_err(|error| error.error)?;
    Ok(offset)
}

async fn upload(conn: &mut SWPConnection, archive: &Path) -> Result<String, Failure> {
    let mut file =
        File::open(archive).map_err(|error| format!("{}: {error}", archive.display()))?;
    let total = usize::try_from(file.metadata()?.len())?;
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
        progress("Uploading", sent, total);
    }
    transfer.ok_or_else(|| format!("{} is empty", archive.display()).into())
}

fn fill(file: &mut File, buffer: &mut [u8]) -> io::Result<usize> {
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
