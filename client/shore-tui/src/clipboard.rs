use std::io;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug)]
pub(crate) enum ClipboardError {
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

fn fresh_temp_path() -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!("shore_paste_{ts}.png"));
    if path.exists() {
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

pub(crate) fn read_image_to_temp() -> Result<PathBuf, ClipboardError> {
    #[cfg(target_os = "macos")]
    {
        let path = fresh_temp_path();
        let script = r#"on run argv
set outputFile to POSIX file (item 1 of argv)
try
    set imageData to the clipboard as «class PNGf»
on error
    error "clipboard has no PNG image"
end try
set fileRef to open for access outputFile with write permission
try
    set eof fileRef to 0
    write imageData to fileRef
    close access fileRef
on error errorMessage
    try
        close access fileRef
    end try
    error errorMessage
end try
end run"#;
        let status = Command::new("osascript")
            .args(["-e", script, "--"])
            .arg(&path)
            .status()
            .map_err(|e| ClipboardError::ClipboardUnavailable(format!("osascript failed: {e}")))?;
        if !status.success() {
            let _ignored = std::fs::remove_file(&path);
            return Err(ClipboardError::NoImage);
        }
        if std::fs::metadata(&path).map_or(true, |metadata| metadata.len() == 0) {
            let _ignored = std::fs::remove_file(&path);
            return Err(ClipboardError::NoImage);
        }
        return Ok(path);
    }

    #[cfg(not(target_os = "macos"))]
    {
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
