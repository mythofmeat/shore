//! Terminal image protocol detection.
//!
//! Shared between shore-cli and shore-tui for consistent protocol detection.

use std::fmt;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

/// Supported inline image protocols.
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

/// Check whether any env var starting with the given prefix exists.
fn has_env_prefix(prefix: &str) -> bool {
    std::env::vars().any(|(k, _)| k.starts_with(prefix))
}

/// Detect the best image protocol for the current terminal.
///
/// Check order:
/// 1. `SHORE_IMAGES` env var: `kitty`, `iterm2`/`iterm`, or `off`
/// 2. `TERM_PROGRAM` env var: `iTerm.app` → iTerm2; `kitty`/`ghostty` → Kitty
/// 3. Terminal-specific env vars that survive multiplexers:
///    - Any `GHOSTTY_*` env var → Kitty (Ghostty supports kitty graphics)
///    - `KITTY_WINDOW_ID` → Kitty
/// 4. `TERM` env var: contains `kitty` or `ghostty` → Kitty
/// 5. None (unsupported)
pub fn detect_protocol() -> Option<ImageProtocol> {
    detect_protocol_from_env(
        std::env::var("SHORE_IMAGES").ok().as_deref(),
        std::env::var("TERM_PROGRAM").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
        has_env_prefix("GHOSTTY_"),
        std::env::var("KITTY_WINDOW_ID").ok().is_some(),
    )
}

/// Detect protocol by probing the terminal with a kitty graphics query.
///
/// Must be called while the terminal is in raw mode (no echo, no line
/// buffering). Sends `a=q` and checks for an `OK` response.
pub fn detect_protocol_probe() -> Option<ImageProtocol> {
    // Try env-based detection first (fast path).
    let env_result = detect_protocol();
    if env_result.is_some() {
        return env_result;
    }

    // Probe: send a kitty graphics query and check for a response.
    if probe_kitty_graphics() {
        return Some(ImageProtocol::Kitty);
    }

    None
}

/// Send a kitty graphics protocol query and return true if the terminal
/// responds with OK. Requires raw mode to be active.
fn probe_kitty_graphics() -> bool {
    // Use /dev/tty to avoid conflicts with stdin/stdout redirection.
    let Ok(mut tty) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
    else {
        return false;
    };

    // Query: transmit a 1x1 pixel with action=query, id=31.
    // If supported, terminal responds: \x1b_Gi=31;OK\x1b\\
    let query = b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
    if tty.write_all(query).is_err() {
        return false;
    }
    if tty.flush().is_err() {
        return false;
    }

    // Read response in a loop until we see the string terminator (\x1b\\)
    // or the deadline expires. A single read can miss a slow or split response,
    // and any unconsumed bytes leak into crossterm's event reader as phantom input.
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
        // Full kitty response ends with ST (ESC \)
        if response.windows(2).any(|w| w == b"\x1b\\") {
            break;
        }
    }

    let text = std::str::from_utf8(&response).unwrap_or("");
    text.contains("OK")
}

/// Read from a file descriptor with a timeout using poll(2).
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
    // file handle, and `timeout_ms` is bounded to i32.
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

/// Testable version that takes env values directly.
pub fn detect_protocol_from_env(
    shore_images: Option<&str>,
    term_program: Option<&str>,
    term: Option<&str>,
    has_ghostty_env: bool,
    has_kitty_env: bool,
) -> Option<ImageProtocol> {
    // Manual override takes priority.
    if let Some(val) = shore_images {
        return match val.to_lowercase().as_str() {
            "kitty" => Some(ImageProtocol::Kitty),
            "iterm2" | "iterm" => Some(ImageProtocol::Iterm2),
            // "off" or any unrecognized value disables image output.
            _ => None,
        };
    }

    // Auto-detect from TERM_PROGRAM.
    if let Some(prog) = term_program {
        let lower = prog.to_lowercase();
        if lower.contains("iterm") {
            return Some(ImageProtocol::Iterm2);
        }
        if lower.contains("kitty") || lower.contains("ghostty") {
            return Some(ImageProtocol::Kitty);
        }
    }

    // Terminal-specific env vars that survive multiplexers (tmux, zellij, etc.)
    if has_ghostty_env || has_kitty_env {
        return Some(ImageProtocol::Kitty);
    }

    // Auto-detect from TERM.
    if let Some(t) = term {
        let lower = t.to_lowercase();
        if lower.contains("kitty") || lower.contains("ghostty") {
            return Some(ImageProtocol::Kitty);
        }
    }

    None
}
