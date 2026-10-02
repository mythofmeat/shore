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
    env: &impl Fn(&str) -> Option<String>,
    override_var: &str,
    xdg_var: &str,
    platform_fn: fn() -> Option<PathBuf>,
    last_resort: LastResort,
) -> PathBuf {
    env(override_var).map_or_else(
        || {
            env(xdg_var)
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

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

impl ShoreDirs {
    pub fn resolve() -> Self {
        Self::resolve_from(&process_env)
    }

    fn resolve_from(env: &impl Fn(&str) -> Option<String>) -> Self {
        Self {
            config: resolve_xdg_dir(
                env,
                "SHORE_CONFIG_DIR",
                "XDG_CONFIG_HOME",
                platform_config_dir,
                LastResort::Refuse,
            ),
            data: resolve_xdg_dir(
                env,
                "SHORE_DATA_DIR",
                "XDG_DATA_HOME",
                platform_data_dir,
                LastResort::Refuse,
            ),
            runtime: resolve_xdg_dir(
                env,
                "SHORE_RUNTIME_DIR",
                "XDG_RUNTIME_DIR",
                dirs::runtime_dir,
                LastResort::TempDir,
            ),
            cache: resolve_xdg_dir(
                env,
                "SHORE_CACHE_DIR",
                "XDG_CACHE_HOME",
                platform_cache_dir,
                LastResort::Refuse,
            ),
            workspace: workspace_root_from(env),
        }
    }
}

fn workspace_root_from(env: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    env("SHORE_WORKSPACE_DIR")
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

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    #[test]
    fn xdg_homes_get_a_shore_subdirectory() {
        let dirs = ShoreDirs::resolve_from(&env_of(&[
            ("XDG_CONFIG_HOME", "/xdg/config"),
            ("XDG_DATA_HOME", "/xdg/data"),
            ("XDG_RUNTIME_DIR", "/xdg/run"),
            ("XDG_CACHE_HOME", "/xdg/cache"),
        ]));
        assert_eq!(dirs.config, PathBuf::from("/xdg/config/shore"));
        assert_eq!(dirs.data, PathBuf::from("/xdg/data/shore"));
        assert_eq!(dirs.runtime, PathBuf::from("/xdg/run/shore"));
        assert_eq!(dirs.cache, PathBuf::from("/xdg/cache/shore"));
    }

    #[test]
    fn a_shore_override_is_used_as_is() {
        let dirs = ShoreDirs::resolve_from(&env_of(&[
            ("SHORE_CONFIG_DIR", "/srv/shore-config"),
            ("XDG_CONFIG_HOME", "/xdg/config"),
            ("XDG_DATA_HOME", "/xdg/data"),
            ("XDG_CACHE_HOME", "/xdg/cache"),
        ]));
        assert_eq!(
            dirs.config,
            PathBuf::from("/srv/shore-config"),
            "SHORE_CONFIG_DIR should be used as-is"
        );
    }

    #[test]
    fn xdg_platform_dir_appends_shore() {
        let dir = resolve_xdg_dir(
            &env_of(&[]),
            "SHORE_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            || Some(PathBuf::from("/tmp/shore_fallback_test")),
            LastResort::Refuse,
        );
        assert_eq!(dir, PathBuf::from("/tmp/shore_fallback_test/shore"));
    }

    #[test]
    fn runtime_falls_back_to_the_temp_dir() {
        let dir = resolve_xdg_dir(
            &env_of(&[]),
            "SHORE_RUNTIME_DIR",
            "XDG_RUNTIME_DIR",
            || None,
            LastResort::TempDir,
        );
        assert_eq!(dir, std::env::temp_dir().join("shore"));
    }

    #[test]
    #[should_panic(expected = "cannot determine a home directory")]
    fn no_home_anywhere_refuses_rather_than_inventing_a_tilde_directory() {
        let _ = resolve_xdg_dir(
            &env_of(&[]),
            "SHORE_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            || None,
            LastResort::Refuse,
        );
    }

    #[test]
    fn an_override_is_enough_on_its_own() {
        let dir = resolve_xdg_dir(
            &env_of(&[("SHORE_CONFIG_DIR", "/srv/shore")]),
            "SHORE_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            || None,
            LastResort::Refuse,
        );
        assert_eq!(dir, PathBuf::from("/srv/shore"));
    }

    #[test]
    fn empty_workspace_root_counts_as_unset() {
        assert_eq!(
            workspace_root_from(&env_of(&[("SHORE_WORKSPACE_DIR", "")])),
            None
        );
        assert_eq!(
            workspace_root_from(&env_of(&[("SHORE_WORKSPACE_DIR", "/work")])),
            Some(PathBuf::from("/work"))
        );
    }
}
