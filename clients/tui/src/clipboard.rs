//! System clipboard image paste support.
//!
//! Shells out to `wl-paste --type image/png` to retrieve a PNG image from
//! the Wayland clipboard, then writes the bytes to a temp file. The
//! resulting path is fed into shore-tui's existing pending-image flow.
//!
//! Requires `wl-clipboard` installed and a Wayland session. The earlier
//! arboard-based implementation was dropped because its Wayland backend
//! fails to negotiate `image/png` on compositors that advertise
//! Qt-flavored MIME types first (notably KDE/KWin).

use std::io;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug)]
pub enum ClipboardError {
    NoImage,
    ClipboardUnavailable(String),
    WriteFailed(io::Error),
}

impl std::fmt::Display for ClipboardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClipboardError::NoImage => write!(f, "clipboard has no image"),
            ClipboardError::ClipboardUnavailable(e) => write!(f, "clipboard unavailable: {e}"),
            ClipboardError::WriteFailed(e) => write!(f, "failed to write paste temp: {e}"),
        }
    }
}

impl std::error::Error for ClipboardError {}

/// Generate a unique temp-file path under the OS temp dir.
fn fresh_temp_path() -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!("shore_paste_{ts}.png"));
    if path.exists() {
        // Vanishingly rare at ms resolution; one retry with a counter.
        for n in 1..1000 {
            let mut alt = std::env::temp_dir();
            alt.push(format!("shore_paste_{ts}_{n}.png"));
            if !alt.exists() {
                return alt;
            }
        }
    }
    path
}

/// Read an image from the Wayland clipboard via `wl-paste --type image/png`
/// and write the PNG bytes to a temp file. Returns the path on success.
///
/// Synchronous and blocking — designed to be invoked via
/// `tokio::task::spawn_blocking`. The caller is expected to wrap this in
/// a timeout in case `wl-paste` stalls on a wedged compositor.
pub fn read_image_to_temp() -> Result<PathBuf, ClipboardError> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Err(ClipboardError::ClipboardUnavailable(
            "not a Wayland session".into(),
        ));
    }

    let output = Command::new("wl-paste")
        .args(["--type", "image/png", "--no-newline"])
        .output()
        .map_err(|e| {
            ClipboardError::ClipboardUnavailable(format!(
                "wl-paste failed: {e} (install wl-clipboard)"
            ))
        })?;

    if !output.status.success() || output.stdout.is_empty() {
        return Err(ClipboardError::NoImage);
    }

    let path = fresh_temp_path();
    std::fs::write(&path, &output.stdout).map_err(ClipboardError::WriteFailed)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_path_format() {
        let p = fresh_temp_path();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("shore_paste_"), "name was {name}");
        assert!(name.ends_with(".png"), "name was {name}");
        assert_eq!(p.parent().unwrap(), std::env::temp_dir().as_path());
    }
}
