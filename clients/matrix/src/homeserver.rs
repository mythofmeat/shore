use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tracing::{error, info, warn};

/// Configuration for a managed Matrix homeserver (conduwuit / continuwuity / tuwunel).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeserverConfig {
    /// Server name (e.g. "shore.local"). Cannot be changed after first run.
    pub server_name: String,
    /// Address the homeserver binds to. Use `0.0.0.0` for all interfaces, or
    /// a specific LAN/Tailscale IP. The local bridge always reaches the
    /// homeserver via loopback when this is `0.0.0.0`.
    pub bind_address: String,
    /// HTTP listener port.
    pub port: u16,
    /// Path to the data directory (RocksDB, media, etc.).
    pub data_dir: PathBuf,
    /// Registration token for programmatic account creation.
    pub registration_token: String,
    /// Whether to allow federation with other Matrix servers.
    pub allow_federation: bool,
}

impl Default for HomeserverConfig {
    fn default() -> Self {
        let data_dir = shore_config::data_dir().join("matrix-server");
        Self {
            server_name: "localhost".to_string(),
            bind_address: "127.0.0.1".to_string(),
            port: 6167,
            data_dir,
            registration_token: String::new(),
            allow_federation: false,
        }
    }
}

impl HomeserverConfig {
    /// Generate a TOML configuration file for conduwuit / continuwuity.
    pub fn generate_config(&self) -> String {
        let db_path = self.data_dir.join("database");
        // Note: no `database_backend` key — tuwunel dropped it (RocksDB is the
        // only supported backend across the conduwuit/continuwuity/tuwunel
        // family), and setting it causes a noisy "unknown config parameter"
        // warning on tuwunel with no functional effect on the others.
        format!(
            r#"[global]
server_name = "{server_name}"
database_path = "{db_path}"
port = {port}
address = "{address}"
max_request_size = 20_000_000
allow_registration = true
registration_token = "{reg_token}"
allow_federation = {federation}
allow_encryption = true
allow_room_creation = true
log = "warn,state_res=warn"
"#,
            server_name = self.server_name,
            db_path = db_path.display(),
            port = self.port,
            address = self.bind_address,
            reg_token = self.registration_token,
            federation = self.allow_federation,
        )
    }

    /// URL the local bridge uses to reach the homeserver. When the server
    /// binds to `0.0.0.0` we reach it through loopback; otherwise the bind
    /// address is reachable from the local host directly (loopback IP, LAN
    /// IP, or Tailscale IP — all work).
    pub fn homeserver_url(&self) -> String {
        let host = if self.bind_address == "0.0.0.0" || self.bind_address == "::" {
            "127.0.0.1"
        } else {
            self.bind_address.as_str()
        };
        format!("http://{host}:{}", self.port)
    }
}

/// Manages a Matrix homeserver subprocess lifecycle.
pub struct HomeserverManager {
    config: HomeserverConfig,
    child: Option<Child>,
    binary: String,
}

/// Try to find a compatible Matrix homeserver binary.
///
/// Checks for `continuwuity`, `conduwuit`, and `tuwunel` in PATH.
pub fn detect_binary() -> Option<String> {
    for name in &["continuwuity", "conduwuit", "tuwunel"] {
        if which(name) {
            return Some(name.to_string());
        }
    }
    None
}

fn which(name: &str) -> bool {
    std::process::Command::new("which")
        .arg(name)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

impl HomeserverManager {
    pub fn new(config: HomeserverConfig, binary: Option<String>) -> Self {
        let binary = binary
            .or_else(detect_binary)
            .unwrap_or_else(|| "continuwuity".to_string());
        Self {
            config,
            child: None,
            binary,
        }
    }

    /// Write config files and start the homeserver process.
    pub async fn start(&mut self) -> Result<(), HomeserverError> {
        if self.child.is_some() {
            return Err(HomeserverError::AlreadyRunning);
        }

        // Ensure directories exist
        tokio::fs::create_dir_all(&self.config.data_dir)
            .await
            .map_err(|e| HomeserverError::Io(format!("create data dir: {e}")))?;
        tokio::fs::create_dir_all(self.config.data_dir.join("database"))
            .await
            .map_err(|e| HomeserverError::Io(format!("create database dir: {e}")))?;

        // Write config file
        let config_path = self.config.data_dir.join("conduwuit.toml");
        tokio::fs::write(&config_path, self.config.generate_config())
            .await
            .map_err(|e| HomeserverError::Io(format!("write config: {e}")))?;

        info!(
            "starting {} with config at {}",
            self.binary,
            config_path.display()
        );

        let child = Command::new(&self.binary)
            .env("CONDUWUIT_CONFIG", &config_path)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    HomeserverError::SpawnFailed(format!(
                        "'{}' not found. Install a conduwuit-compatible Matrix homeserver \
                         (continuwuity, conduwuit, or tuwunel)",
                        self.binary
                    ))
                } else {
                    HomeserverError::SpawnFailed(e.to_string())
                }
            })?;

        self.child = Some(child);
        info!("{} started (port {})", self.binary, self.config.port);
        Ok(())
    }

    /// Stop the homeserver process.
    pub async fn stop(&mut self) -> Result<(), HomeserverError> {
        if let Some(mut child) = self.child.take() {
            info!("stopping {}", self.binary);
            child
                .kill()
                .await
                .map_err(|e| HomeserverError::Io(format!("kill: {e}")))?;
            Ok(())
        } else {
            Err(HomeserverError::NotRunning)
        }
    }

    /// Check if the homeserver process is running and the HTTP endpoint is healthy.
    pub async fn health_check(&mut self) -> HealthStatus {
        if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(Some(status)) => {
                    warn!("{} exited with status: {status}", self.binary);
                    self.child = None;
                    return HealthStatus::ProcessExited(status.code());
                }
                Ok(None) => { /* still running */ }
                Err(e) => {
                    error!("failed to check {} status: {e}", self.binary);
                    return HealthStatus::Unknown;
                }
            }
        } else {
            return HealthStatus::NotRunning;
        }

        match http_health_check(&self.config.homeserver_url()).await {
            Ok(true) => HealthStatus::Healthy,
            Ok(false) => HealthStatus::Unhealthy,
            Err(_) => HealthStatus::Unhealthy,
        }
    }

    pub fn config(&self) -> &HomeserverConfig {
        &self.config
    }

    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }

    pub fn binary_name(&self) -> &str {
        &self.binary
    }
}

/// Check the Matrix `/_matrix/client/versions` endpoint.
async fn http_health_check(homeserver_url: &str) -> Result<bool, String> {
    let url = format!("{homeserver_url}/_matrix/client/versions");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    Ok(resp.status().is_success())
}

/// Poll until the homeserver responds to health checks, or timeout.
pub async fn wait_for_healthy(homeserver_url: &str, timeout: Duration) -> bool {
    let start = tokio::time::Instant::now();
    let interval = Duration::from_millis(500);
    loop {
        if start.elapsed() >= timeout {
            return false;
        }
        if let Ok(true) = http_health_check(homeserver_url).await {
            return true;
        }
        tokio::time::sleep(interval).await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthStatus {
    Healthy,
    Unhealthy,
    NotRunning,
    ProcessExited(Option<i32>),
    Unknown,
}

#[derive(Debug, thiserror::Error)]
pub enum HomeserverError {
    #[error("homeserver is already running")]
    AlreadyRunning,
    #[error("homeserver is not running")]
    NotRunning,
    #[error("failed to spawn homeserver: {0}")]
    SpawnFailed(String),
    #[error("I/O error: {0}")]
    Io(String),
}

/// Generate a random registration token.
pub fn generate_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let s = RandomState::new();
    let mut h = s.build_hasher();
    h.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64,
    );
    let v1 = h.finish();
    let mut h2 = s.build_hasher();
    h2.write_u64(v1.wrapping_mul(6364136223846793005));
    let v2 = h2.finish();
    format!("{v1:016x}{v2:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let config = HomeserverConfig::default();
        assert_eq!(config.server_name, "localhost");
        assert_eq!(config.bind_address, "127.0.0.1");
        assert_eq!(config.port, 6167);
        assert!(!config.allow_federation);
        let data_dir_str = config.data_dir.to_string_lossy();
        assert!(
            data_dir_str.contains("shore") && data_dir_str.contains("matrix-server"),
            "expected XDG-based path, got: {data_dir_str}"
        );
    }

    #[test]
    fn generate_config_contains_required_fields() {
        let config = HomeserverConfig {
            server_name: "test.shore.local".to_string(),
            bind_address: "0.0.0.0".to_string(),
            port: 9999,
            data_dir: PathBuf::from("/tmp/test-matrix"),
            registration_token: "secret_token_123".to_string(),
            allow_federation: false,
        };
        let toml = config.generate_config();
        assert!(toml.contains("server_name = \"test.shore.local\""));
        assert!(toml.contains("address = \"0.0.0.0\""));
        assert!(toml.contains("port = 9999"));
        assert!(toml.contains("registration_token = \"secret_token_123\""));
        assert!(
            !toml.contains("database_backend"),
            "database_backend key must not be written (tuwunel rejects it)"
        );
        assert!(toml.contains("allow_federation = false"));
        assert!(toml.contains("allow_registration = true"));
        assert!(toml.contains("/tmp/test-matrix/database"));
    }

    #[test]
    fn generate_config_federation_enabled() {
        let config = HomeserverConfig {
            allow_federation: true,
            ..HomeserverConfig::default()
        };
        let toml = config.generate_config();
        assert!(toml.contains("allow_federation = true"));
    }

    #[test]
    fn homeserver_url_loopback_default() {
        let config = HomeserverConfig {
            port: 8448,
            ..HomeserverConfig::default()
        };
        assert_eq!(config.homeserver_url(), "http://127.0.0.1:8448");
    }

    #[test]
    fn homeserver_url_wildcard_bind_uses_loopback() {
        let config = HomeserverConfig {
            bind_address: "0.0.0.0".to_string(),
            port: 6167,
            ..HomeserverConfig::default()
        };
        assert_eq!(config.homeserver_url(), "http://127.0.0.1:6167");
    }

    #[test]
    fn homeserver_url_specific_address_used_directly() {
        let config = HomeserverConfig {
            bind_address: "100.64.0.5".to_string(),
            port: 6167,
            ..HomeserverConfig::default()
        };
        assert_eq!(config.homeserver_url(), "http://100.64.0.5:6167");
    }

    #[test]
    fn generate_token_unique() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert_eq!(t1.len(), 32);
        assert_eq!(t2.len(), 32);
        assert_ne!(t1, t2);
    }

    #[test]
    fn health_status_variants() {
        assert_eq!(HealthStatus::Healthy, HealthStatus::Healthy);
        assert_ne!(HealthStatus::Healthy, HealthStatus::Unhealthy);
        assert_eq!(
            HealthStatus::ProcessExited(Some(1)),
            HealthStatus::ProcessExited(Some(1))
        );
    }

    #[test]
    fn homeserver_error_display() {
        assert_eq!(
            HomeserverError::AlreadyRunning.to_string(),
            "homeserver is already running"
        );
        assert_eq!(
            HomeserverError::NotRunning.to_string(),
            "homeserver is not running"
        );
        assert!(HomeserverError::SpawnFailed("oops".into())
            .to_string()
            .contains("oops"));
        assert!(HomeserverError::Io("disk full".into())
            .to_string()
            .contains("disk full"));
    }

    #[test]
    fn homeserver_manager_not_running_by_default() {
        let config = HomeserverConfig::default();
        let mgr = HomeserverManager::new(config, Some("test-binary".into()));
        assert!(!mgr.is_running());
        assert_eq!(mgr.binary_name(), "test-binary");
    }
}
