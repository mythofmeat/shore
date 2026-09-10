use std::fmt;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    Kitty,
    Iterm2,
}

impl fmt::Display for ImageProtocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImageProtocol::Kitty => write!(f, "kitty"),
            ImageProtocol::Iterm2 => write!(f, "iterm2"),
        }
    }
}

fn has_env_prefix(prefix: &str) -> bool {
    std::env::vars().any(|(k, _)| k.starts_with(prefix))
}

pub fn detect_protocol() -> Option<ImageProtocol> {
    detect_protocol_from_env(
        std::env::var("SHORE_IMAGES").ok().as_deref(),
        std::env::var("TERM_PROGRAM").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
        has_env_prefix("GHOSTTY_"),
        std::env::var("KITTY_WINDOW_ID").ok().is_some(),
    )
}

pub fn detect_protocol_probe() -> Option<ImageProtocol> {
    let env_result = detect_protocol();
    if env_result.is_some() || std::env::var("SHORE_IMAGES").is_ok() {
        return env_result;
    }

    if probe_kitty_graphics() {
        return Some(ImageProtocol::Kitty);
    }

    None
}

fn probe_kitty_graphics() -> bool {
    let Ok(mut tty) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
    else {
        return false;
    };

    let query = b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
    if tty.write_all(query).is_err() {
        return false;
    }
    if tty.flush().is_err() {
        return false;
    }

    let now = Instant::now();
    let deadline = now.checked_add(Duration::from_millis(200)).unwrap_or(now);
    let mut response = Vec::with_capacity(64);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut buf = [0_u8; 64];
        let n = read_with_timeout(&mut tty, &mut buf, remaining);
        if n == 0 {
            break;
        }
        let Some(chunk) = buf.get(..n) else {
            return false;
        };
        response.extend_from_slice(chunk);
        if response.windows(2).any(|w| w == b"\x1b\\") {
            break;
        }
    }

    let text = std::str::from_utf8(&response).unwrap_or("");
    text.contains("OK")
}

#[cfg(unix)]
#[expect(
    unsafe_code,
    reason = "terminal protocol probing needs libc::poll on the tty fd"
)]
fn read_with_timeout(file: &mut std::fs::File, buf: &mut [u8], timeout: Duration) -> usize {
    use std::os::unix::io::AsRawFd;

    let fd = file.as_raw_fd();
    let timeout_ms = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);

    let mut pfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };

    // SAFETY: `pfd` points to one initialized pollfd, `fd` comes from the live
    let ready = unsafe { libc::poll(&raw mut pfd, 1, timeout_ms) };
    if ready <= 0 {
        return 0;
    }

    file.read(buf).unwrap_or(0)
}

#[cfg(not(unix))]
fn read_with_timeout(_file: &mut std::fs::File, _buf: &mut [u8], _timeout: Duration) -> usize {
    0
}

pub fn detect_protocol_from_env(
    shore_images: Option<&str>,
    term_program: Option<&str>,
    term: Option<&str>,
    has_ghostty_env: bool,
    has_kitty_env: bool,
) -> Option<ImageProtocol> {
    if let Some(val) = shore_images {
        return match val.to_lowercase().as_str() {
            "kitty" => Some(ImageProtocol::Kitty),
            "iterm2" | "iterm" => Some(ImageProtocol::Iterm2),
            _ => None,
        };
    }

    if let Some(prog) = term_program {
        let lower = prog.to_lowercase();
        if lower.contains("iterm") {
            return Some(ImageProtocol::Iterm2);
        }
        if lower.contains("kitty") || lower.contains("ghostty") {
            return Some(ImageProtocol::Kitty);
        }
    }

    if has_ghostty_env || has_kitty_env {
        return Some(ImageProtocol::Kitty);
    }

    if let Some(t) = term {
        let lower = t.to_lowercase();
        if lower.contains("kitty") || lower.contains("ghostty") {
            return Some(ImageProtocol::Kitty);
        }
    }

    None
}
