use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

const SIGN_INS_FILE: &str = "sign-ins.toml";

#[derive(Debug, Clone)]
pub(crate) struct TokenError {
    pub origin: String,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "this CLI isn't signed in to {origin}. Run `shore sign-in {origin}` and give the daemon's password.",
            origin = self.origin
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
            Self::Discover => resolve_with(&sign_ins_path(), origin),
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

pub(crate) fn resolve_with(sign_ins: &Path, origin: &str) -> Result<String, TokenError> {
    read_sign_ins(sign_ins)
        .get(origin)
        .and_then(|token| non_blank(token))
        .ok_or_else(|| TokenError {
            origin: origin.to_owned(),
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
    fn each_address_keeps_its_own_sign_in_owner_only() {
        let tmp = tempfile::tempdir().unwrap();
        let sign_ins = tmp.path().join("cli").join(SIGN_INS_FILE);
        save_sign_in_at(&sign_ins, ORIGIN, "  shore_signed\n").unwrap();
        save_sign_in_at(&sign_ins, "http://other:7340", "shore_other").unwrap();
        assert_eq!(
            resolve_with(&sign_ins, ORIGIN).unwrap(),
            "shore_signed",
            "the sign-in for this address is used, trimmed"
        );
        assert_eq!(
            resolve_with(&sign_ins, "http://other:7340").unwrap(),
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
    fn without_a_sign_in_for_the_address_the_error_says_how_to_sign_in() {
        let tmp = tempfile::tempdir().unwrap();
        let sign_ins = tmp.path().join(SIGN_INS_FILE);
        std::fs::write(tmp.path().join("token"), "a daemon token\n").unwrap();
        let message = resolve_with(&sign_ins, ORIGIN).unwrap_err().to_string();
        assert_eq!(
            message,
            "this CLI isn't signed in to https://shore.example. Run `shore sign-in https://shore.example` and give the daemon's password.",
            "a token file beside the sign-ins is never read"
        );
        save_sign_in_at(&sign_ins, ORIGIN, "   ").unwrap();
        assert!(
            resolve_with(&sign_ins, ORIGIN).is_err(),
            "a blank sign-in counts as none"
        );
        std::fs::write(&sign_ins, "not = [toml").unwrap();
        assert!(
            resolve_with(&sign_ins, ORIGIN).is_err(),
            "an unreadable sign-ins file counts as no sign-in"
        );
    }
}
