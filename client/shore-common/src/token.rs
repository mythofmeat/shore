//! The shared secret every SWP client presents, and where it comes from.
//!
//! This is the Rust counterpart of `daemon/src/config/token.ts`. The two must
//! agree on the resolution order and on the file's name, because they are the
//! two halves of one credential — and, as with [`crate::dirs`], a client has to
//! find it *before* it has a daemon to ask.
//!
//! # Why a token at all
//!
//! SWP carries no authentication of its own, and passing the connection check
//! grants a full session: every character's history, the ability to send as the
//! user, and the whole tool surface. So the check is all-or-nothing, and the
//! only question is what it should be.
//!
//! It used to be an IP allowlist plus a flag acknowledging that remote access
//! was unauthenticated. Both are gone. An address is not a credential — a
//! container bridge hands out addresses from ranges indistinguishable from an
//! ordinary LAN, so "allow my containers" and "allow my whole network" were the
//! same config — and a flag that asks you to accept a risk is a worse answer
//! than not having the risk. One mechanism, always on.
//!
//! # This side only ever reads
//!
//! Generation belongs to the daemon, which owns the config directory. A client
//! that minted its own credential would not be authenticating, so an absent
//! token here is an error with somewhere to go, never a fresh secret.

use std::path::{Path, PathBuf};

/// Environment override, and the way a client on another host or in another
/// container is told the secret.
pub const TOKEN_ENV: &str = "SHORE_TOKEN";

/// The daemon-written file, under the config directory.
pub const TOKEN_FILE: &str = "token";

/// Why no token could be found.
#[derive(Debug, Clone)]
pub struct TokenError {
    /// Where the file was looked for, for the message.
    pub path: PathBuf,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "no shore token: ${TOKEN_ENV} is unset and {} could not be read. \
             If the daemon runs on this machine it writes that file on first \
             start; if it runs elsewhere, copy the value and set ${TOKEN_ENV}.",
            self.path.display()
        )
    }
}

impl std::error::Error for TokenError {}

/// The token for this client: `$SHORE_TOKEN`, else `<config_dir>/token`.
///
/// An empty or whitespace-only value counts as unset in both sources.
/// `SHORE_TOKEN=""` means "I have not set this", which is what an unset
/// variable in a compose `.env` expands to — treating it as a real (empty)
/// secret would send an empty token and produce a confusing rejection instead
/// of a clear "you have not set this".
pub fn resolve_token(config_dir: &Path) -> Result<String, TokenError> {
    resolve_token_with(std::env::var(TOKEN_ENV).ok(), config_dir)
}

/// [`resolve_token`] with the environment supplied rather than read.
///
/// Injectable for the same reason `resolveShoreDirs` takes its env on the
/// TypeScript side: the process environment is global and the test binary is
/// parallel, so a test that sets `SHORE_TOKEN` to exercise one branch would
/// otherwise decide the answer for every test running beside it.
pub fn resolve_token_with(
    env_token: Option<String>,
    config_dir: &Path,
) -> Result<String, TokenError> {
    if let Some(from_env) = env_token.as_deref().and_then(non_blank) {
        return Ok(from_env);
    }
    let path = config_dir.join(TOKEN_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .as_deref()
        .and_then(non_blank)
        .ok_or(TokenError { path })
}

/// The value with surrounding whitespace removed, or `None` if nothing is left.
///
/// The trim matters for the file: an editor that adds a trailing newline, or a
/// `docker exec cat` piped into a shell variable, must not produce a token that
/// differs from the daemon's by one byte.
fn non_blank(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Env wins over the file, and the file answers when env is absent.
    #[test]
    fn resolution_order() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(TOKEN_FILE), "from-file\n").unwrap();

        let from_env = resolve_token_with(Some("from-env".into()), tmp.path());
        assert_eq!(from_env.unwrap(), "from-env");

        let from_file = resolve_token_with(None, tmp.path());
        assert_eq!(from_file.unwrap(), "from-file");
    }

    /// A trailing newline in the file is not part of the secret. An editor adds
    /// one; `docker exec cat` piped into a variable keeps one; a token that
    /// differs from the daemon's by one byte fails with no clue why.
    #[test]
    fn the_file_is_trimmed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(TOKEN_FILE), "  abc123\n\n").unwrap();
        assert_eq!(resolve_token_with(None, tmp.path()).unwrap(), "abc123");
    }

    /// An empty `SHORE_TOKEN` is what an unset compose variable expands to, so
    /// it must mean "unset" and fall through rather than send an empty secret.
    #[test]
    fn an_empty_env_value_falls_through_to_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(TOKEN_FILE), "from-file").unwrap();
        assert_eq!(
            resolve_token_with(Some(String::new()), tmp.path()).unwrap(),
            "from-file"
        );
        assert_eq!(
            resolve_token_with(Some("   ".into()), tmp.path()).unwrap(),
            "from-file"
        );
    }

    /// Nothing anywhere is an error naming the path that was tried — never a
    /// generated secret, which is the daemon's job alone.
    #[test]
    fn nothing_anywhere_is_an_error_that_says_where_to_look() {
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_token_with(None, tmp.path()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains(TOKEN_ENV), "{msg}");
        assert!(msg.contains("token"), "{msg}");
        assert!(
            !tmp.path().join(TOKEN_FILE).exists(),
            "the client must never write a token"
        );
    }
}
