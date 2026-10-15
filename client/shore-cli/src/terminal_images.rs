use std::fs;
use std::io::{self, Write};

use base64::Engine;
pub(crate) use shore_common::image_protocol::{ImageProtocol, detect_protocol};
use tracing::{debug, warn};

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
            write!(
                out,
                "\x1b_Ga=T,f=100,m={};{}\x1b\\",
                i32::from(!is_last),
                chunk
            )?;
        } else {
            write!(out, "\x1b_Gm={};{}\x1b\\", i32::from(!is_last), chunk)?;
        }
    }
    writeln!(out)?;
    out.flush()
}

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
