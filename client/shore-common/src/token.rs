use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

pub(crate) const TOKEN_FILE: &str = "token";
const SIGN_INS_FILE: &str = "sign-ins.toml";

#[derive(Debug, Clone)]
pub(crate) struct TokenError {
    pub origin: String,
    pub path: PathBuf,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "this CLI isn't signed in to {origin}. Run `shore sign-in {origin}` and allow the code it shows from a device that's already signed in. \
             On the daemon's own machine the CLI uses {path} instead.",
            origin = self.origin,
            path = self.path.display()
        )
    }
}

impl std::error::Error for TokenError {}

#[derive(Clone, Default)]
pub enum TokenSource {
    #[default]
    Discover,
    Given(String),
}

impl std::fmt::Debug for TokenSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Discover => f.write_str("Discover"),
            Self::Given(_) => f.write_str("Given(<redacted>)"),
        }
    }
}

impl TokenSource {
    pub(crate) fn resolve(&self, origin: &str) -> Result<String, TokenError> {
        match self {
            Self::Given(token) => Ok(token.clone()),
            Self::Discover => resolve_with(
                &sign_ins_path(),
                origin,
                &crate::swp_client::discovery::config_dir_for_addr(origin)
                    .unwrap_or_else(crate::dirs::config_dir),
            ),
        }
    }
}

pub(crate) fn sign_ins_path() -> PathBuf {
    crate::dirs::config_dir().join(SIGN_INS_FILE)
}

fn read_sign_ins(path: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| toml::from_str::<BTreeMap<String, String>>(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn resolve_with(
    sign_ins: &Path,
    origin: &str,
    daemon_config_dir: &Path,
) -> Result<String, TokenError> {
    if let Some(token) = read_sign_ins(sign_ins)
        .get(origin)
        .and_then(|token| non_blank(token))
    {
        return Ok(token);
    }
    let path = daemon_config_dir.join(TOKEN_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .as_deref()
        .and_then(non_blank)
        .ok_or_else(|| TokenError {
            origin: origin.to_owned(),
            path,
        })
}

pub fn save_sign_in(origin: &str, token: &str) -> std::io::Result<PathBuf> {
    let path = sign_ins_path();
    save_sign_in_at(&path, origin, token)?;
    Ok(path)
}

pub(crate) fn save_sign_in_at(path: &Path, origin: &str, token: &str) -> std::io::Result<()> {
    let mut sign_ins = read_sign_ins(path);
    _ = sign_ins.insert(origin.to_owned(), token.to_owned());
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory)?;
    let text = toml::to_string(&sign_ins).map_err(std::io::Error::other)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(text.as_bytes())?;
    file.as_file().sync_all()?;
    _ = file.persist(path).map_err(|error| error.error)?;
    Ok(())
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

    const ORIGIN: &str = "https://shore.example";

    #[test]
    fn debug_output_never_carries_a_given_token() {
        let rendered = format!("{:?}", TokenSource::Given("secret-token".into()));
        assert_eq!(rendered, "Given(<redacted>)", "the token must not show");
        assert_eq!(format!("{:?}", TokenSource::Discover), "Discover", "plain");
    }

    #[test]
    fn a_sign_in_for_the_address_wins_over_the_daemons_own_token_and_is_kept_owner_only() {
        let tmp = tempfile::tempdir().unwrap();
        let sign_ins = tmp.path().join("cli").join(SIGN_INS_FILE);
        std::fs::write(tmp.path().join(TOKEN_FILE), "  from-file\n\n").unwrap();
        assert_eq!(
            resolve_with(&sign_ins, ORIGIN, tmp.path()).unwrap(),
            "from-file",
            "without a sign-in the daemon's own token is trimmed and used"
        );
        save_sign_in_at(&sign_ins, ORIGIN, "shore_signed").unwrap();
        save_sign_in_at(&sign_ins, "http://other:7340", "shore_other").unwrap();
        assert_eq!(
            resolve_with(&sign_ins, ORIGIN, tmp.path()).unwrap(),
            "shore_signed",
            "the sign-in for this address is used"
        );
        assert_eq!(
            resolve_with(&sign_ins, "http://other:7340", tmp.path()).unwrap(),
            "shore_other",
            "each address keeps its own sign-in"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&sign_ins).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "sign-ins are owner-only");
        }
    }

    #[test]
    fn a_blank_sign_in_or_token_file_falls_through_and_nothing_anywhere_says_how_to_sign_in() {
        let tmp = tempfile::tempdir().unwrap();
        let sign_ins = tmp.path().join(SIGN_INS_FILE);
        save_sign_in_at(&sign_ins, ORIGIN, "   ").unwrap();
        std::fs::write(tmp.path().join(TOKEN_FILE), "\n").unwrap();
        let message = resolve_with(&sign_ins, ORIGIN, tmp.path())
            .unwrap_err()
            .to_string();
        assert!(
            message.contains("shore sign-in https://shore.example"),
            "{message}"
        );
        assert!(
            message.contains(&tmp.path().join(TOKEN_FILE).display().to_string()),
            "{message}"
        );
        std::fs::write(&sign_ins, "not = [toml").unwrap();
        assert!(
            resolve_with(&sign_ins, ORIGIN, tmp.path()).is_err(),
            "an unreadable sign-ins file counts as no sign-in"
        );
    }
}
