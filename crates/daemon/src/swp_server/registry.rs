//! **Ported.** `llm-sidecar/src/instances.ts`, pinned by
//! `tests/instances.test.ts` and `scripts/mutate_instances.py`. Filed at the
//! root over there rather than under `swp/`: this is daemon discovery, not part
//! of the SWP protocol, and "registry" is already three other things in that
//! tree.
//!
//! One mechanism differs. There is no portable `flock` on the other side, so
//! the read-modify-write is guarded by an exclusively-created lock file whose
//! *existence* is the lock. The kernel releases a `flock` when its holder dies
//! and does not release a lock file, so that port carries a staleness timeout —
//! a lock older than ten seconds is assumed abandoned and broken. Without it, a
//! daemon killed mid-write would wedge every later reader forever.
//!
//! The atomic write is unchanged: sibling temp file, `fsync`, rename.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

/// One daemon instance entry in the registry.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct InstanceInfo {
    pub id: String,
    pub pid: u32,
    pub addr: String,
    pub started_at: String,
    /// Resolved data directory so CLI commands can find the ledger.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    /// Resolved config directory so clients can read the same config.toml
    /// without requiring the caller to set SHORE_CONFIG_DIR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
}

/// Handle to the instance registry file at a known path.
#[derive(Debug)]
pub struct Registry {
    path: PathBuf,
}

impl Registry {
    /// Create a registry using the default path:
    /// `$SHORE_RUNTIME_DIR/instances.json` (or `/tmp/shore/instances.json`).
    pub fn default_path() -> Self {
        Self {
            path: shore_common::config::runtime_dir().join("instances.json"),
        }
    }

    /// Create a registry at a specific path (useful for testing).
    pub fn at<P: Into<PathBuf>>(path: P) -> Self {
        Self { path: path.into() }
    }

    /// Path to the registry file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read-modify-write under a stable sidecar lock file.
    ///
    /// Automatically prunes entries whose PID is no longer alive.
    fn with_locked<T, F>(&self, f: F) -> std::io::Result<T>
    where
        F: FnOnce(&mut Vec<InstanceInfo>) -> std::io::Result<(T, bool)>,
    {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let lock_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.lock_path())?;

        lock_file.lock_exclusive()?;

        let mut entries = self.read_entries()?;
        let mut dirty = prune_dead_entries(&mut entries);
        let (result, changed) = f(&mut entries)?;
        dirty |= changed;
        if dirty {
            self.write_entries(&entries)?;
        }

        lock_file.unlock()?;
        Ok(result)
    }

    /// Register a daemon instance (replaces any existing entry with the same id).
    pub fn register(&self, info: InstanceInfo) -> std::io::Result<()> {
        self.with_locked(|entries| {
            entries.retain(|e| e.id != info.id);
            entries.push(info);
            Ok(((), true))
        })
    }

    /// Remove a daemon instance by id.
    pub fn unregister(&self, id: &str) -> std::io::Result<()> {
        self.with_locked(|entries| {
            let before = entries.len();
            entries.retain(|e| e.id != id);
            Ok(((), entries.len() != before))
        })
    }

    /// List all registered instances, pruning any with dead PIDs.
    pub fn list(&self) -> std::io::Result<Vec<InstanceInfo>> {
        self.with_locked(|entries| Ok((entries.clone(), false)))
    }

    fn lock_path(&self) -> PathBuf {
        self.path.with_extension("lock")
    }

    fn read_entries(&self) -> std::io::Result<Vec<InstanceInfo>> {
        let content = match std::fs::read_to_string(&self.path) {
            Ok(content) => content,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };

        if content.trim().is_empty() {
            return Ok(Vec::new());
        }

        serde_json::from_str(&content).map_err(|err| {
            let backup = self
                .preserve_corrupt_registry(&content)
                .unwrap_or_else(|_| self.corrupt_backup_path());
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "corrupt registry JSON in {}: {err}. Preserved backup at {}",
                    self.path.display(),
                    backup.display()
                ),
            )
        })
    }

    fn write_entries(&self, entries: &[InstanceInfo]) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(entries)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("instances.json");
        let tmp_path = self.path.with_file_name(format!("{file_name}.tmp"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }

    fn preserve_corrupt_registry(&self, content: &str) -> std::io::Result<PathBuf> {
        let backup = self.corrupt_backup_path();
        std::fs::write(&backup, content)?;
        Ok(backup)
    }

    fn corrupt_backup_path(&self) -> PathBuf {
        let stem = self
            .path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("instances");
        let ext = self
            .path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("json");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        self.path
            .with_file_name(format!("{stem}.corrupt-{suffix}.{ext}"))
    }
}

fn prune_dead_entries(entries: &mut Vec<InstanceInfo>) -> bool {
    let before = entries.len();
    entries.retain(|entry| !matches!(pid_state(entry.pid), ProcessState::Dead));
    entries.len() != before
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_registry() -> (tempfile::TempDir, Registry) {
        let tmp = tempfile::tempdir().unwrap();
        let registry = Registry::at(tmp.path().join("shore").join("instances.json"));
        (tmp, registry)
    }

    fn sample_instance(id: &str) -> InstanceInfo {
        let port = 7320_usize.saturating_add(id.len());
        InstanceInfo {
            id: id.into(),
            pid: std::process::id(),
            addr: format!("127.0.0.1:{port}"),
            started_at: "2026-01-01T00:00:00Z".into(),
            data_dir: None,
            config_dir: None,
        }
    }

    #[test]
    fn register_and_list() {
        let (_tmp, reg) = test_registry();
        let info = sample_instance("test-1");
        reg.register(info.clone()).unwrap();

        let entries = reg.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries.first(), Some(&info));
    }

    #[test]
    fn register_and_unregister() {
        let (_tmp, reg) = test_registry();
        reg.register(sample_instance("test-2")).unwrap();
        reg.register(sample_instance("test-3")).unwrap();

        assert_eq!(reg.list().unwrap().len(), 2);

        reg.unregister("test-2").unwrap();
        let entries = reg.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries.first().map(|entry| entry.id.as_str()),
            Some("test-3")
        );
    }

    #[test]
    fn register_replaces_stale_entry() {
        let (_tmp, reg) = test_registry();
        reg.register(sample_instance("test-4")).unwrap();

        let mut updated = sample_instance("test-4");
        updated.addr = "127.0.0.1:9999".into();
        reg.register(updated.clone()).unwrap();

        let entries = reg.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries.first().map(|entry| entry.addr.as_str()),
            Some("127.0.0.1:9999")
        );
    }

    #[test]
    fn list_empty_when_no_registry() {
        let (_tmp, reg) = test_registry();
        let entries = reg.list().unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn cleanup_on_shutdown() {
        let (_tmp, reg) = test_registry();
        reg.register(sample_instance("daemon-a")).unwrap();
        reg.register(sample_instance("daemon-b")).unwrap();

        reg.unregister("daemon-a").unwrap();

        let entries = reg.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries.first().map(|entry| entry.id.as_str()),
            Some("daemon-b")
        );
    }

    #[test]
    fn register_creates_sidecar_lock_file() {
        let (_tmp, reg) = test_registry();
        reg.register(sample_instance("daemon-lock")).unwrap();

        assert!(
            reg.path().with_extension("lock").exists(),
            "registry writes should use a stable sidecar lock file"
        );
    }

    #[test]
    fn register_rejects_corrupt_registry_and_preserves_backup() {
        let (_tmp, reg) = test_registry();
        let corrupt = "{ definitely not valid json";
        std::fs::create_dir_all(reg.path().parent().unwrap()).unwrap();
        std::fs::write(reg.path(), corrupt).unwrap();

        let err = reg
            .register(sample_instance("daemon-corrupt"))
            .expect_err("corrupt registry should be rejected");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains("corrupt"),
            "error should describe corruption: {err}"
        );

        let backups: Vec<_> = std::fs::read_dir(reg.path().parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                let is_json = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
                let is_corrupt_backup = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("instances.corrupt-"));
                is_json && is_corrupt_backup
            })
            .collect();
        assert_eq!(backups.len(), 1, "expected one preserved corrupt backup");
        let backup = backups.first().expect("backup path should exist");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), corrupt);
    }
}
