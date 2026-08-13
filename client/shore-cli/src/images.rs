use std::fs;
use std::io::{self, Write};

use base64::Engine;
pub(crate) use shore_common::image_protocol::{ImageProtocol, detect_protocol};
use tracing::{debug, warn};

/// Render an image inline using the detected protocol, or fall back to text.
///
/// `path` is the filesystem path to the image (used as a label and as a
/// fallback when `data` is not provided).
/// `caption` is an optional human-readable name.
/// `data` is base64-encoded image bytes from the daemon, used when the CLI is
/// connected to a remote daemon and the file path doesn't exist locally.
pub(crate) fn render_image(path: &str, caption: Option<&str>, data: Option<&str>) {
    let label = caption.unwrap_or(path);

    let Some(bytes) = resolve_bytes(path, data) else {
        debug!(
            path,
            "No local file and no embedded data, displaying as text"
        );
        cli_out!("[img: {label}]");
        return;
    };

    match detect_protocol() {
        Some(ImageProtocol::Kitty) => {
            if let Err(e) = render_kitty(&bytes) {
                warn!(path, error = %e, "Kitty image render failed");
                cli_err!("[img: {label}] (kitty render failed: {e})");
            }
        }
        Some(ImageProtocol::Iterm2) => {
            if let Err(e) = render_iterm2(&bytes, label) {
                warn!(path, error = %e, "iTerm2 image render failed");
                cli_err!("[img: {label}] (iterm2 render failed: {e})");
            }
        }
        None => {
            debug!(path, "No image protocol detected, displaying as text");
            cli_out!("[img: {label}]");
        }
    }
}

/// Resolve image bytes from the embedded base64 payload (preferred for remote
/// daemons) or fall back to reading the local filesystem path.
fn resolve_bytes(path: &str, data: Option<&str>) -> Option<Vec<u8>> {
    if let Some(b64) = data {
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => return Some(bytes),
            Err(e) => {
                warn!(path, error = %e, "failed to decode embedded image data; falling back to path");
            }
        }
    }
    fs::read(path).ok()
}

/// Render an image using the Kitty graphics protocol.
///
/// Uses the "transmit and display" action with base64-encoded data,
/// chunked into 4096-byte pieces per the protocol spec.
fn render_kitty(data: &[u8]) -> io::Result<()> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    let stdout = io::stdout();
    let mut out = stdout.lock();

    let chunk_size = 4096;
    let chunks: Vec<&str> = encoded
        .as_bytes()
        .chunks(chunk_size)
        .map(std::str::from_utf8)
        .collect::<Result<_, _>>()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    for (i, chunk) in chunks.iter().enumerate() {
        let is_last = i.checked_add(1) == Some(chunks.len());
        if i == 0 {
            // First chunk: action=transmit+display, format=100 (PNG/auto)
            write!(
                out,
                "\x1b_Ga=T,f=100,m={};{}\x1b\\",
                i32::from(!is_last),
                chunk
            )?;
        } else {
            // Continuation chunk
            write!(out, "\x1b_Gm={};{}\x1b\\", i32::from(!is_last), chunk)?;
        }
    }
    writeln!(out)?;
    out.flush()
}

/// Render an image using the iTerm2 inline images protocol.
fn render_iterm2(data: &[u8], name: &str) -> io::Result<()> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    let name_b64 = base64::engine::general_purpose::STANDARD.encode(name);
    let stdout = io::stdout();
    let mut out = stdout.lock();

    write!(
        out,
        "\x1b]1337;File=name={};size={};inline=1:{}\x07",
        name_b64,
        data.len(),
        encoded
    )?;
    writeln!(out)?;
    out.flush()
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use shore_common::image_protocol::detect_protocol_from_env;

    // ── Protocol detection from env ──────────────────────────────────

    #[test]
    fn shore_images_kitty_override() {
        let proto = detect_protocol_from_env(Some("kitty"), None, None, false, false);
        assert_eq!(proto, Some(ImageProtocol::Kitty));
    }

    #[test]
    fn shore_images_iterm2_override() {
        let proto = detect_protocol_from_env(Some("iterm2"), None, None, false, false);
        assert_eq!(proto, Some(ImageProtocol::Iterm2));
    }

    #[test]
    fn shore_images_off_override() {
        let proto = detect_protocol_from_env(Some("off"), None, None, false, false);
        assert_eq!(proto, None);
    }

    #[test]
    fn shore_images_case_insensitive() {
        assert_eq!(
            detect_protocol_from_env(Some("KITTY"), None, None, false, false),
            Some(ImageProtocol::Kitty)
        );
        assert_eq!(
            detect_protocol_from_env(Some("iTerm2"), None, None, false, false),
            Some(ImageProtocol::Iterm2)
        );
        assert_eq!(
            detect_protocol_from_env(Some("OFF"), None, None, false, false),
            None
        );
    }

    #[test]
    fn shore_images_unknown_value_is_off() {
        let proto = detect_protocol_from_env(Some("sixel"), None, None, false, false);
        assert_eq!(proto, None);
    }

    #[test]
    fn shore_images_overrides_term_program() {
        let proto = detect_protocol_from_env(Some("kitty"), Some("iTerm.app"), None, false, false);
        assert_eq!(proto, Some(ImageProtocol::Kitty));
    }

    #[test]
    fn shore_images_off_overrides_term_program() {
        let proto = detect_protocol_from_env(Some("off"), Some("iTerm.app"), None, false, false);
        assert_eq!(proto, None);
    }

    #[test]
    fn detect_iterm_from_term_program() {
        let proto = detect_protocol_from_env(None, Some("iTerm.app"), None, false, false);
        assert_eq!(proto, Some(ImageProtocol::Iterm2));
    }

    #[test]
    fn detect_iterm_from_term_program_case_insensitive() {
        let proto = detect_protocol_from_env(None, Some("ITERM.APP"), None, false, false);
        assert_eq!(proto, Some(ImageProtocol::Iterm2));
    }

    #[test]
    fn detect_kitty_from_term_program() {
        let proto = detect_protocol_from_env(None, Some("kitty"), None, false, false);
        assert_eq!(proto, Some(ImageProtocol::Kitty));
    }

    #[test]
    fn detect_kitty_from_term() {
        let proto = detect_protocol_from_env(None, None, Some("xterm-kitty"), false, false);
        assert_eq!(proto, Some(ImageProtocol::Kitty));
    }

    #[test]
    fn no_detection_on_generic_terminal() {
        let proto = detect_protocol_from_env(None, None, Some("xterm-256color"), false, false);
        assert_eq!(proto, None);
    }

    #[test]
    fn no_detection_when_all_none() {
        let proto = detect_protocol_from_env(None, None, None, false, false);
        assert_eq!(proto, None);
    }

    #[test]
    fn term_program_takes_priority_over_term() {
        let proto =
            detect_protocol_from_env(None, Some("iTerm.app"), Some("xterm-kitty"), false, false);
        assert_eq!(proto, Some(ImageProtocol::Iterm2));
    }

    #[test]
    fn display_protocol_names() {
        assert_eq!(ImageProtocol::Kitty.to_string(), "kitty");
        assert_eq!(ImageProtocol::Iterm2.to_string(), "iterm2");
    }

    // ── resolve_bytes ────────────────────────────────────────────────

    #[test]
    fn resolve_bytes_prefers_embedded_data_over_path() {
        // When the daemon embeds image data, the CLI must use it instead of
        // hitting the daemon's local filesystem path — that path may not
        // exist on the CLI's host (remote daemon case).
        let bytes = b"remote-embedded".to_vec();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let resolved = resolve_bytes("/nonexistent/remote/path.png", Some(&b64));
        assert_eq!(resolved.as_deref(), Some(bytes.as_slice()));
    }

    #[test]
    fn resolve_bytes_falls_back_to_path_when_data_absent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("local.png");
        fs::write(&path, b"local-fs").unwrap();
        let resolved = resolve_bytes(path.to_str().unwrap(), None);
        assert_eq!(resolved.as_deref(), Some(b"local-fs".as_slice()));
    }

    #[test]
    fn resolve_bytes_returns_none_when_neither_works() {
        let resolved = resolve_bytes("/no/such/file.png", None);
        assert!(resolved.is_none());
    }

    #[test]
    fn resolve_bytes_falls_back_to_path_on_bad_base64() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("backup.png");
        fs::write(&path, b"backup").unwrap();
        let resolved = resolve_bytes(path.to_str().unwrap(), Some("not!valid!base64!"));
        assert_eq!(resolved.as_deref(), Some(b"backup".as_slice()));
    }
}
