use std::path::PathBuf;

#[cfg(target_os = "macos")]
fn platform_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".config"))
}

#[cfg(not(target_os = "macos"))]
fn platform_config_dir() -> Option<PathBuf> {
    dirs::config_dir()
}

#[cfg(target_os = "macos")]
fn platform_data_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".local/share"))
}

#[cfg(not(target_os = "macos"))]
fn platform_data_dir() -> Option<PathBuf> {
    dirs::data_dir()
}

#[cfg(target_os = "macos")]
fn platform_cache_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".cache"))
}

#[cfg(not(target_os = "macos"))]
fn platform_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir()
}

#[derive(Debug, Clone)]
pub struct ShoreDirs {
    pub config: PathBuf,
    pub data: PathBuf,
    pub runtime: PathBuf,
    pub cache: PathBuf,
    pub workspace: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy)]
enum LastResort {
    TempDir,
    Refuse,
}

#[expect(
    clippy::panic,
    reason = "no home directory means nowhere correct to write; the alternative is \
              a relative directory named `~` that looks like it worked (#45)"
)]
fn resolve_xdg_dir(
    override_var: &str,
    xdg_var: &str,
    platform_fn: fn() -> Option<PathBuf>,
    last_resort: LastResort,
) -> PathBuf {
    std::env::var(override_var).ok().map_or_else(
        || {
            std::env::var(xdg_var)
                .ok()
                .map(PathBuf::from)
                .or_else(platform_fn)
                .unwrap_or_else(|| match last_resort {
                    LastResort::TempDir => std::env::temp_dir(),
                    LastResort::Refuse => panic!(
                        "shore cannot determine a home directory: ${xdg_var} is unset and this \
                         user has no home (no $HOME and no passwd entry for the uid). Set \
                         ${override_var} to an explicit path, or ${xdg_var}, or run as a user \
                         the passwd database knows."
                    ),
                })
                .join("shore")
        },
        PathBuf::from,
    )
}

impl ShoreDirs {
    pub fn resolve() -> Self {
        Self {
            config: resolve_xdg_dir(
                "SHORE_CONFIG_DIR",
                "XDG_CONFIG_HOME",
                platform_config_dir,
                LastResort::Refuse,
            ),
            data: resolve_xdg_dir(
                "SHORE_DATA_DIR",
                "XDG_DATA_HOME",
                platform_data_dir,
                LastResort::Refuse,
            ),
            runtime: resolve_xdg_dir(
                "SHORE_RUNTIME_DIR",
                "XDG_RUNTIME_DIR",
                dirs::runtime_dir,
                LastResort::TempDir,
            ),
            cache: resolve_xdg_dir(
                "SHORE_CACHE_DIR",
                "XDG_CACHE_HOME",
                platform_cache_dir,
                LastResort::Refuse,
            ),
            workspace: workspace_root(),
        }
    }
}

pub fn workspace_root() -> Option<PathBuf> {
    std::env::var("SHORE_WORKSPACE_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

pub fn config_dir() -> PathBuf {
    ShoreDirs::resolve().config
}

pub fn runtime_dir() -> PathBuf {
    ShoreDirs::resolve().runtime
}

pub fn data_dir() -> PathBuf {
    ShoreDirs::resolve().data
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::{set_env, unset_env};

    #[test]
    fn xdg_dirs_resolve() {
        let dirs = ShoreDirs::resolve();
        assert!(dirs.config.ends_with("shore"));
        assert!(dirs.data.ends_with("shore"));
        assert!(dirs.runtime.ends_with("shore"));
    }

    #[test]
    fn xdg_override_shore_config_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let custom = tmp.path().join("my_config");
        std::fs::create_dir_all(&custom).unwrap();

        set_env("SHORE_CONFIG_DIR", &custom);
        let dir = resolve_xdg_dir(
            "SHORE_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            dirs::config_dir,
            LastResort::Refuse,
        );
        unset_env("SHORE_CONFIG_DIR");

        assert_eq!(dir, custom, "SHORE_CONFIG_DIR should be used as-is");
    }

    #[test]
    fn xdg_platform_dir_appends_shore() {
        let unique = format!("SHORE_TEST_NO_OVERRIDE_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_NO_{}", std::process::id());
        let dir = resolve_xdg_dir(
            &unique,
            &xdg_unique,
            || Some(PathBuf::from("/tmp/shore_fallback_test")),
            LastResort::Refuse,
        );
        assert_eq!(dir, PathBuf::from("/tmp/shore_fallback_test/shore"));
    }

    #[test]
    fn runtime_falls_back_to_the_temp_dir() {
        let unique = format!("SHORE_TEST_EMPTY_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_EMPTY_{}", std::process::id());
        let dir = resolve_xdg_dir(&unique, &xdg_unique, || None, LastResort::TempDir);
        assert!(dir.ends_with("shore"));
        assert!(dir.parent().unwrap().exists(), "parent should be temp_dir");
    }

    #[test]
    #[should_panic(expected = "cannot determine a home directory")]
    fn no_home_anywhere_refuses_rather_than_inventing_a_tilde_directory() {
        let unique = format!("SHORE_TEST_NOHOME_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_NOHOME_{}", std::process::id());
        let _ = resolve_xdg_dir(&unique, &xdg_unique, || None, LastResort::Refuse);
    }

    #[test]
    fn an_override_is_enough_on_its_own() {
        let unique = format!("SHORE_TEST_OVERRIDE_ONLY_{}", std::process::id());
        let xdg_unique = format!("SHORE_TEST_XDG_OVERRIDE_ONLY_{}", std::process::id());
        set_env(&unique, "/srv/shore");
        unset_env(&xdg_unique);

        let dir = resolve_xdg_dir(&unique, &xdg_unique, || None, LastResort::Refuse);
        unset_env(&unique);

        assert_eq!(dir, PathBuf::from("/srv/shore"));
    }

    #[test]
    fn empty_workspace_root_counts_as_unset() {
        set_env("SHORE_WORKSPACE_DIR", "");
        assert_eq!(workspace_root(), None);
        unset_env("SHORE_WORKSPACE_DIR");
    }
}
