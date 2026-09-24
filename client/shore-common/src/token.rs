use std::path::{Path, PathBuf};

pub const TOKEN_ENV: &str = "SHORE_TOKEN";

pub(crate) const TOKEN_FILE: &str = "token";

#[derive(Debug, Clone)]
pub(crate) struct TokenError {
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

#[derive(Debug, Clone, Default)]
pub enum TokenSource {
    #[default]
    Discover,
    Given(String),
}

impl TokenSource {
    pub(crate) fn resolve(&self, addr: Option<&str>) -> Result<String, TokenError> {
        match self {
            Self::Given(token) => Ok(token.clone()),
            Self::Discover => resolve_client_token(
                addr.and_then(crate::swp_client::discovery::config_dir_for_addr),
            ),
        }
    }
}

pub(crate) fn resolve_client_token(
    daemon_config_dir: Option<PathBuf>,
) -> Result<String, TokenError> {
    resolve_token(&daemon_config_dir.unwrap_or_else(crate::dirs::config_dir))
}

pub(crate) fn resolve_token(config_dir: &Path) -> Result<String, TokenError> {
    resolve_token_with(std::env::var(TOKEN_ENV).ok().as_deref(), config_dir)
}

pub(crate) fn resolve_token_with(
    env_token: Option<&str>,
    config_dir: &Path,
) -> Result<String, TokenError> {
    if let Some(from_env) = env_token.and_then(non_blank) {
        return Ok(from_env);
    }
    let path = config_dir.join(TOKEN_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .as_deref()
        .and_then(non_blank)
        .ok_or(TokenError { path })
}

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

    #[test]
    fn resolution_order() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(TOKEN_FILE), "from-file\n").unwrap();

        let from_env = resolve_token_with(Some("from-env"), tmp.path());
        assert_eq!(from_env.unwrap(), "from-env");

        let from_file = resolve_token_with(None, tmp.path());
        assert_eq!(from_file.unwrap(), "from-file");
    }

    #[test]
    fn the_file_is_trimmed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(TOKEN_FILE), "  abc123\n\n").unwrap();
        assert_eq!(resolve_token_with(None, tmp.path()).unwrap(), "abc123");
    }

    #[test]
    fn an_empty_env_value_falls_through_to_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(TOKEN_FILE), "from-file").unwrap();
        assert_eq!(
            resolve_token_with(Some(""), tmp.path()).unwrap(),
            "from-file"
        );
        assert_eq!(
            resolve_token_with(Some("   "), tmp.path()).unwrap(),
            "from-file"
        );
    }

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
