use std::path::{Path, PathBuf};

use serde::Deserialize;
use tracing::{debug, warn};

use crate::swp_client::connection::ServerAddr;
use crate::swp_client::error::{ClientError, DiscoveryKind, Result};

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct InstanceEntry {
    #[serde(default)]
    pub id: Option<String>,
    pub addr: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub config_dir: Option<String>,
}

type InstancesFile = Vec<InstanceEntry>;

pub(crate) fn instances_path() -> PathBuf {
    crate::dirs::runtime_dir().join("instances.json")
}

pub(crate) fn read_instances() -> Result<Vec<InstanceEntry>> {
    read_instances_from_path(&instances_path())
}

fn read_instances_from_path(path: &Path) -> Result<Vec<InstanceEntry>> {
    debug!(path = %path.display(), "reading instances file");
    let data = std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ClientError::Discovery {
                kind: DiscoveryKind::RegistryMissing,
                message: format!("instances registry not found at {}", path.display()),
            }
        } else {
            ClientError::Discovery {
                kind: DiscoveryKind::Io,
                message: format!("cannot read instances registry {}: {e}", path.display()),
            }
        }
    })?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: InstancesFile =
        serde_json::from_str(&data).map_err(|e| ClientError::Discovery {
            kind: DiscoveryKind::RegistryCorrupt,
            message: format!("corrupt instances registry {}: {e}", path.display()),
        })?;
    let total = entries.len();
    let live: Vec<_> = entries.into_iter().filter(entry_alive).collect();
    debug!(total, live = live.len(), "discovered daemon instances");
    Ok(live)
}

fn entry_alive(entry: &InstanceEntry) -> bool {
    match entry.pid {
        Some(pid) => !matches!(pid_state(pid), ProcessState::Dead),
        None => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessState {
    Alive,
    Dead,
    Unknown,
}

#[cfg(unix)]
#[expect(
    unsafe_code,
    reason = "process liveness probe uses libc::kill(pid, 0), which has no safe std wrapper"
)]
fn pid_state(pid: u32) -> ProcessState {
    let Ok(pid_t) = libc::pid_t::try_from(pid) else {
        return ProcessState::Dead;
    };
    // SAFETY: signal 0 performs permission/existence checking only. `pid_t`
    let rc = unsafe { libc::kill(pid_t, 0) };
    if rc == 0 {
        return ProcessState::Alive;
    }

    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => ProcessState::Dead,
        Some(libc::EPERM) => ProcessState::Alive,
        _ => ProcessState::Unknown,
    }
}

#[cfg(not(unix))]
fn pid_state(_pid: u32) -> ProcessState {
    ProcessState::Unknown
}

fn discover_from_path(path: &Path, selector: Option<&str>) -> Result<ServerAddr> {
    let entries = read_instances_from_path(path)?;

    let entry = match selector {
        Some(wanted) => {
            if entries.is_empty() {
                return Err(ClientError::Discovery {
                    kind: DiscoveryKind::RegistryEmpty,
                    message: format!(
                        "instances registry has no live entries (looking for {wanted})"
                    ),
                });
            }
            entries
                .iter()
                .find(|e| {
                    e.id.as_deref() == Some(wanted) || e.config_dir.as_deref() == Some(wanted)
                })
                .ok_or_else(|| ClientError::Discovery {
                    kind: DiscoveryKind::NoMatch,
                    message: format!("no daemon found matching id or config_dir: {wanted}"),
                })?
        }
        None => match entries.as_slice() {
            [] => {
                return Err(ClientError::Discovery {
                    kind: DiscoveryKind::RegistryEmpty,
                    message: "instances registry has no live entries".into(),
                });
            }
            [only] => only,
            several => {
                return Err(ClientError::Discovery {
                    kind: DiscoveryKind::Ambiguous,
                    message: format!(
                        "{} daemons are running ({}) — name one with --addr or SHORE_ADDR, \
                         or set default_address in client.toml",
                        several.len(),
                        describe_instances(several)
                    ),
                });
            }
        },
    };

    Ok(ServerAddr(entry.addr.clone()))
}

fn describe_instances(entries: &[InstanceEntry]) -> String {
    entries
        .iter()
        .map(|e| match e.id.as_deref() {
            Some(id) => format!("{id} at {}", e.addr),
            None => e.addr.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn discover_config_dir() -> Result<Option<PathBuf>> {
    let entries = read_instances()?;
    let [only] = entries.as_slice() else {
        return Ok(None);
    };
    Ok(only.config_dir.as_deref().map(PathBuf::from))
}

pub(crate) fn config_dir_for_addr(addr: &str) -> Option<PathBuf> {
    match read_instances() {
        Ok(entries) => config_dir_of(&entries, addr),
        Err(e) => {
            debug!(error = %e, "no instance registry to resolve a token directory from");
            None
        }
    }
}

fn config_dir_of(entries: &[InstanceEntry], addr: &str) -> Option<PathBuf> {
    entries
        .iter()
        .find(|e| e.addr == addr)
        .and_then(|e| e.config_dir.as_deref())
        .map(PathBuf::from)
}

pub(crate) const DEFAULT_ADDR: &str = "127.0.0.1:7320";

pub fn discover_or_default(config_path: Option<&str>) -> Result<ServerAddr> {
    let client_default =
        crate::swp_client::client_config::load_client_config().and_then(|cfg| cfg.default_address);
    discover_or_default_from_path(&instances_path(), config_path, client_default)
}

fn discover_or_default_from_path(
    path: &Path,
    config_path: Option<&str>,
    client_default_address: Option<String>,
) -> Result<ServerAddr> {
    if let Some(addr) = client_default_address {
        debug!(addr = %addr, "using address from client.toml");
        return Ok(ServerAddr(addr));
    }

    match discover_from_path(path, config_path) {
        Ok(addr) => {
            debug!(addr = ?addr, "resolved daemon via instance discovery");
            Ok(addr)
        }
        Err(e) if config_path.is_none() && should_fallback_to_default(&e) => {
            warn!(error = %e, fallback = DEFAULT_ADDR, "instance discovery failed, using default address");
            Ok(ServerAddr(DEFAULT_ADDR.to_owned()))
        }
        Err(e) => Err(e),
    }
}

fn should_fallback_to_default(err: &ClientError) -> bool {
    matches!(
        err,
        ClientError::Discovery { kind, .. }
            if matches!(kind, DiscoveryKind::RegistryMissing | DiscoveryKind::RegistryEmpty)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(addr: &str, config_dir: Option<&str>) -> InstanceEntry {
        InstanceEntry {
            id: None,
            addr: addr.into(),
            pid: None,
            config_dir: config_dir.map(str::to_owned),
        }
    }

    #[test]
    fn config_dir_of_matches_on_address() {
        let entries = [
            entry("127.0.0.1:7320", Some("/home/u/.config/shore")),
            entry("127.0.0.1:9999", Some("/elsewhere")),
        ];
        assert_eq!(
            config_dir_of(&entries, "127.0.0.1:9999"),
            Some(PathBuf::from("/elsewhere"))
        );
        assert_eq!(
            config_dir_of(&entries, "127.0.0.1:7320"),
            Some(PathBuf::from("/home/u/.config/shore"))
        );
    }

    #[test]
    fn config_dir_of_is_none_when_it_cannot_tell() {
        let entries = [
            entry("127.0.0.1:7320", Some("/a")),
            entry("[::1]:7320", None),
        ];
        assert_eq!(config_dir_of(&entries, "127.0.0.1:1234"), None);
        assert_eq!(config_dir_of(&entries, "[::1]:7320"), None);
        assert_eq!(config_dir_of(&[], "127.0.0.1:7320"), None);
    }

    #[test]
    fn entry_alive_no_pid_assumes_alive() {
        let entry = InstanceEntry {
            id: None,
            addr: "127.0.0.1:7320".into(),
            pid: None,
            config_dir: None,
        };
        assert!(entry_alive(&entry));
    }

    #[test]
    fn entry_alive_current_process() {
        let entry = InstanceEntry {
            id: None,
            addr: "127.0.0.1:7320".into(),
            pid: Some(std::process::id()),
            config_dir: None,
        };
        assert!(entry_alive(&entry));
    }

    #[test]
    fn entry_alive_bogus_pid() {
        let entry = InstanceEntry {
            id: None,
            addr: "127.0.0.1:7320".into(),
            pid: Some(u32::MAX - 1),
            config_dir: None,
        };
        assert!(!entry_alive(&entry));
    }

    #[test]
    fn instance_entry_full_fields() {
        let json = r#"[{
            "id": "default",
            "addr": "127.0.0.1:7320",
            "pid": 12345,
            "data_dir": "/home/user/data",
            "config_dir": "/home/user/config"
        }]"#;
        let entries: Vec<InstanceEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = entries.first().expect("entry should be present");
        assert_eq!(entry.id.as_deref(), Some("default"));
        assert_eq!(entry.addr, "127.0.0.1:7320");
        assert_eq!(entry.pid, Some(12345));
        assert_eq!(entry.config_dir.as_deref(), Some("/home/user/config"));
    }

    #[test]
    fn instance_entry_minimal_fields_use_defaults() {
        let json = r#"[{"addr": "127.0.0.1:7320"}]"#;
        let entries: Vec<InstanceEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = entries.first().expect("entry should be present");
        assert!(entry.id.is_none());
        assert!(entry.pid.is_none());
        assert_eq!(entry.addr, "127.0.0.1:7320");
    }

    #[test]
    fn read_instances_rejects_corrupt_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("instances.json");
        std::fs::write(&path, "{ invalid json").unwrap();

        let err = read_instances_from_path(&path).expect_err("corrupt registry should fail");
        assert!(
            format!("{err}").contains("corrupt instances registry"),
            "expected explicit corruption error, got: {err}"
        );
    }

    #[test]
    fn discover_or_default_falls_back_when_registry_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let addr = discover_or_default_from_path(&tmp.path().join("missing.json"), None, None)
            .expect("missing registry should fall back to the default address");
        assert_eq!(addr.0, DEFAULT_ADDR);
    }

    #[test]
    fn discovery_refuses_to_choose_between_live_daemons() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("instances.json");
        std::fs::write(
            &path,
            r#"[{"id":"work","addr":"127.0.0.1:7320"},{"id":"play","addr":"127.0.0.1:7321"}]"#,
        )
        .unwrap();

        let err = discover_from_path(&path, None).expect_err("two daemons should not resolve");
        let ClientError::Discovery { kind, message } = err else {
            panic!("expected a discovery error");
        };
        assert_eq!(kind, DiscoveryKind::Ambiguous);
        assert!(message.contains("work at 127.0.0.1:7320"), "{message}");
        assert!(message.contains("play at 127.0.0.1:7321"), "{message}");
    }

    #[test]
    fn ambiguity_is_not_flattened_to_the_default_address() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("instances.json");
        std::fs::write(
            &path,
            r#"[{"addr":"127.0.0.1:7320"},{"addr":"127.0.0.1:7321"}]"#,
        )
        .unwrap();

        let err = discover_or_default_from_path(&path, None, None)
            .expect_err("two daemons should not fall back to the default address");
        assert!(matches!(
            err,
            ClientError::Discovery {
                kind: DiscoveryKind::Ambiguous,
                ..
            }
        ));
    }

    #[test]
    fn an_explicit_selector_resolves_among_several() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("instances.json");
        std::fs::write(
            &path,
            r#"[{"id":"work","addr":"127.0.0.1:7320"},{"id":"play","addr":"127.0.0.1:7321"}]"#,
        )
        .unwrap();

        let addr = discover_from_path(&path, Some("play")).expect("the named daemon resolves");
        assert_eq!(addr.0, "127.0.0.1:7321");
    }

    #[test]
    fn discover_or_default_rejects_corrupt_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("instances.json");
        std::fs::write(&path, "{ invalid json").unwrap();

        let err = discover_or_default_from_path(&path, None, None)
            .expect_err("corrupt registry should not silently fall back");
        assert!(
            format!("{err}").contains("corrupt instances registry"),
            "expected explicit corruption error, got: {err}"
        );
    }
}
