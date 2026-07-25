//! Config hot reload watcher.
//!
//! The watcher observes the config directory, but only forwards changes for
//! supported config inputs. Character workspace prompt and memory files are
//! deliberately ignored so filesystem saves do not become prompt activation
//! boundaries.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep, Instant};
use tracing::{debug, info, warn};

use crate::handler::HandlerControl;

const DEBOUNCE: Duration = Duration::from_millis(500);
const FAR_FUTURE: Duration = Duration::from_hours(8_760);

pub fn spawn_config_watcher(
    config_path: PathBuf,
    config_dir: PathBuf,
    control_tx: mpsc::Sender<HandlerControl>,
    mut shutdown_rx: watch::Receiver<()>,
) -> Option<tokio::task::JoinHandle<()>> {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let mut watcher = match notify::recommended_watcher(move |event| {
        let _ignored = event_tx.send(event);
    }) {
        Ok(watcher) => watcher,
        Err(e) => {
            warn!(error = %e, "Config hot reload watcher could not start");
            return None;
        }
    };

    if let Err(e) = watcher.watch(&config_dir, RecursiveMode::Recursive) {
        warn!(
            config_dir = %config_dir.display(),
            error = %e,
            "Config hot reload watcher could not watch config directory"
        );
        return None;
    }

    info!(
        config_path = %config_path.display(),
        config_dir = %config_dir.display(),
        "Config hot reload watcher started"
    );

    Some(tokio::spawn(async move {
        let _watcher = watcher;
        let mut pending = BTreeSet::new();
        let debounce = sleep(FAR_FUTURE);
        tokio::pin!(debounce);
        let mut armed = false;

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    break;
                }
                maybe_event = event_rx.recv() => {
                    let Some(event) = maybe_event else {
                        break;
                    };
                    match event {
                        Ok(notify_event) => {
                            for path in reload_paths_for_event(&config_dir, &config_path, &notify_event) {
                                let _ignored = pending.insert(path);
                            }
                            if !pending.is_empty() {
                                armed = true;
                                let deadline = Instant::now()
                                    .checked_add(DEBOUNCE)
                                    .unwrap_or_else(Instant::now);
                                debounce.as_mut().reset(deadline);
                            }
                        }
                        Err(e) => {
                            warn!(error = %e, "Config hot reload watcher event error");
                        }
                    }
                }
                () = &mut debounce, if armed => {
                    let changed_paths = pending.iter().cloned().collect::<Vec<_>>();
                    pending.clear();
                    armed = false;
                    let deadline = Instant::now()
                        .checked_add(FAR_FUTURE)
                        .unwrap_or_else(Instant::now);
                    debounce.as_mut().reset(deadline);
                    debug!(changed_paths = ?changed_paths, "Config hot reload debounce elapsed");
                    if control_tx
                        .send(HandlerControl::ReloadConfig { changed_paths })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }

        info!("Config hot reload watcher stopped");
    }))
}

fn reload_paths_for_event(config_dir: &Path, config_path: &Path, event: &Event) -> Vec<PathBuf> {
    if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
        return Vec::new();
    }

    event
        .paths
        .iter()
        .filter(|path| path_triggers_reload(config_dir, config_path, path))
        .cloned()
        .collect()
}

pub fn path_triggers_reload(config_dir_in: &Path, config_path_in: &Path, path_in: &Path) -> bool {
    let config_dir = absolutize(config_dir_in);
    let config_path = absolutize(config_path_in);
    let path = absolutize(path_in);

    if path == config_path {
        return true;
    }

    let Ok(relative) = path.strip_prefix(&config_dir) else {
        return false;
    };
    let parts = path_parts(relative);
    let Some(first) = parts.first().map(String::as_str) else {
        return false;
    };

    if is_character_workspace_path(&parts) {
        return false;
    }

    if parts.len() == 1 && first == ".env" {
        return true;
    }

    if first == "conf.d" {
        return parts.len() == 1 || has_toml_extension(&path);
    }

    if first == "characters" {
        if parts.len() == 2 {
            return true;
        }
        if parts.len() == 3
            && parts
                .get(2)
                .is_some_and(|p| p == "config.toml" || p == "character.md")
        {
            return true;
        }
        return has_toml_extension(&path);
    }

    has_toml_extension(&path)
}

fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(path)
}

fn path_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            Component::Prefix(_)
            | Component::RootDir
            | Component::CurDir
            | Component::ParentDir => None,
        })
        .collect()
}

fn is_character_workspace_path(parts: &[String]) -> bool {
    parts.first().is_some_and(|p| p == "characters")
        && parts.get(2).is_some_and(|p| p == "workspace")
}

fn has_toml_extension(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "toml")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> (PathBuf, PathBuf) {
        let config_dir = PathBuf::from("/tmp/shore-test-config");
        let config_path = config_dir.join("config.toml");
        (config_dir, config_path)
    }

    #[test]
    fn reloads_supported_config_paths() {
        let (config_dir, config_path) = base();

        assert!(path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("config.toml")
        ));
        assert!(path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join(".env")
        ));
        assert!(path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("models.toml")
        ));
        assert!(path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("conf.d/models.toml")
        ));
        assert!(path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("characters/Alice/config.toml")
        ));
    }

    #[test]
    fn ignores_character_workspace_prompt_and_memory_paths() {
        let (config_dir, config_path) = base();

        assert!(!path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("characters/Alice/workspace/SOUL.md")
        ));
        assert!(!path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("characters/Alice/workspace/memory/facts.toml")
        ));
        assert!(!path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("characters/Alice/workspace/MEMORY.md")
        ));
    }

    #[test]
    fn reloads_character_discovery_paths() {
        let (config_dir, config_path) = base();

        assert!(path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("characters/Alice")
        ));
        assert!(path_triggers_reload(
            &config_dir,
            &config_path,
            &config_dir.join("characters/Alice/character.md")
        ));
    }
}
