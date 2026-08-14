use std::io::{self, Write};
use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClientConfig {
    pub default_address: Option<String>,
}

pub(crate) fn client_config_path() -> PathBuf {
    crate::dirs::config_dir().join("client.toml")
}

pub(crate) fn load_client_config() -> Option<ClientConfig> {
    let path = client_config_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => {
            warn_stderr(format_args!(
                "shore: warning: cannot read {}: {e}",
                path.display()
            ));
            return None;
        }
    };
    match toml::from_str::<ClientConfig>(&content) {
        Ok(cfg) => Some(cfg),
        Err(e) => {
            warn_stderr(format_args!(
                "shore: warning: invalid {}: {e}",
                path.display()
            ));
            None
        }
    }
}

fn warn_stderr(args: std::fmt::Arguments<'_>) {
    let stderr = io::stderr();
    let mut out = stderr.lock();
    let _ignored = writeln!(out, "{args}");
}
