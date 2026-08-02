use std::path::{Path, PathBuf};

use serde::Deserialize;
use tracing::{debug, warn};

use crate::swp_client::connection::ServerAddr;
use crate::swp_client::error::{ClientError, DiscoveryKind, Result};

/// One entry in `$XDG_RUNTIME_DIR/shore/instances.json`.
#[derive(Deserialize, Debug, Clone)]
pub struct InstanceEntry {
    /// Instance ID.
    #[serde(default)]
    pub id: Option<String>,
    /// TCP address where the daemon listens.
    pub addr: String,
    /// PID of the daemon process.
    #[serde(default)]
    pub pid: Option<u32>,
    /// Resolved data directory (written by daemon at registration).
    #[serde(default)]
    pub data_dir: Option<String>,
    /// Resolved config directory (written by daemon at registration).
    #[serde(default)]
    pub config_dir: Option<String>,
}

/// The instances file is a JSON array of `InstanceEntry`.
type InstancesFile = Vec<InstanceEntry>;

/// Return the default path to the Shore instances file.
///
/// Uses `crate::config::runtime_dir()` so that `SHORE_RUNTIME_DIR`,
/// `XDG_RUNTIME_DIR`, and platform defaults are respected consistently.
pub fn instances_path() -> PathBuf {
    crate::config::runtime_dir().join("instances.json")
}

/// Read the instances file and return all live entries (dead PIDs are skipped).
pub fn read_instances() -> Result<Vec<InstanceEntry>> {
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

/// Check whether an instance entry's PID is still running.
fn entry_alive(entry: &InstanceEntry) -> bool {
    match entry.pid {
        Some(pid) => !matches!(pid_state(pid), ProcessState::Dead),
        None => true, // no PID recorded — can't prune, assume alive
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
    // The kernel's pid_t is i32; real PIDs fit far below i32::MAX. A value that
    // doesn't fit can't name a live process, so treat it as dead.
    let Ok(pid_t) = libc::pid_t::try_from(pid) else {
        return ProcessState::Dead;
    };
    // SAFETY: signal 0 performs permission/existence checking only. `pid_t`
    // was range-checked for this platform's pid_t above.
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

/// Find the `ServerAddr` for a daemon whose identity matches `selector`.
///
/// A selector is matched first against `InstanceEntry::id` (for callers
/// that know the exact instance ID, e.g. `shore-mcp`) and then against
/// `InstanceEntry::config_dir` (for callers that know the daemon by its
/// config directory, e.g. `shore-tui`). If `selector` is `None`,
/// returns the first (default) entry.
pub fn discover(selector: Option<&str>) -> Result<ServerAddr> {
    discover_from_path(&instances_path(), selector)
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
        None => entries.first().ok_or_else(|| ClientError::Discovery {
            kind: DiscoveryKind::RegistryEmpty,
            message: "instances registry has no live entries".into(),
        })?,
    };

    Ok(ServerAddr(entry.addr.clone()))
}

/// Discover the data directory from the first live daemon instance.
///
/// Returns `Ok(None)` if no instance is registered or the entry lacks `data_dir`.
pub fn discover_data_dir() -> Result<Option<PathBuf>> {
    Ok(read_instances()?
        .first()
        .and_then(|e| e.data_dir.as_deref())
        .map(PathBuf::from))
}

/// Discover the config directory from the first live daemon instance.
///
/// Lets clients read the same `config.toml` the daemon is using without
/// requiring the caller to set `SHORE_CONFIG_DIR` in their environment.
/// Returns `Ok(None)` if no instance is registered or the entry lacks
/// `config_dir` (older daemons that predate the field).
pub fn discover_config_dir() -> Result<Option<PathBuf>> {
    Ok(read_instances()?
        .first()
        .and_then(|e| e.config_dir.as_deref())
        .map(PathBuf::from))
}

pub const DEFAULT_ADDR: &str = "127.0.0.1:7320";

/// Convenience: check client.toml, then discover, then fall back to the
/// default TCP address when discovery is simply absent.
///
/// Corrupt or unreadable registry state is returned as an error instead of
/// being flattened into the default address.
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

    // ── entry_alive ──────────────────────────────────────────────────

    #[test]
    fn entry_alive_no_pid_assumes_alive() {
        let entry = InstanceEntry {
            id: None,
            addr: "127.0.0.1:7320".into(),
            pid: None,
            data_dir: None,
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
            data_dir: None,
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
            data_dir: None,
            config_dir: None,
        };
        assert!(!entry_alive(&entry));
    }

    // ── InstanceEntry deserialization ─────────────────────────────────

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
        assert_eq!(entry.data_dir.as_deref(), Some("/home/user/data"));
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
