use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// Persisted provisioning state for a character's Matrix account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProvisionState {
    /// Character name
    pub character: String,
    /// Matrix user ID (e.g. @shore-alice:localhost)
    pub user_id: String,
    /// The device ID used by this bot account
    pub device_id: String,
    /// Access token for the bot account
    pub access_token: String,
    /// Room ID the character is provisioned into
    pub room_id: Option<String>,
    /// Whether the avatar has been set
    pub avatar_set: bool,
    /// Homeserver URL used during provisioning
    pub homeserver_url: String,
}

/// Paths for a character's Matrix data within the XDG data directory.
#[derive(Debug, Clone)]
pub struct CharacterPaths {
    /// Root: $XDG_DATA_HOME/shore/{character}/matrix/
    pub matrix_dir: PathBuf,
    /// $XDG_DATA_HOME/shore/{character}/matrix/provision.json
    pub provision_file: PathBuf,
    /// $XDG_DATA_HOME/shore/{character}/matrix/crypto_store/
    pub crypto_store: PathBuf,
    /// $XDG_DATA_HOME/shore/{character}/
    pub character_dir: PathBuf,
}

impl CharacterPaths {
    /// Compute paths for a character, using the resolved Shore data directory.
    pub fn new(character: &str) -> Self {
        let data_dir = shore_config::data_dir();
        Self::with_base(data_dir, character)
    }

    /// Compute paths with an explicit base data directory (useful for testing).
    ///
    /// Note: `base` is treated as the Shore data root directly (no `/shore` appended).
    pub fn with_base(base: PathBuf, character: &str) -> Self {
        let character_dir = base.join(character);
        let matrix_dir = character_dir.join("matrix");
        let provision_file = matrix_dir.join("provision.json");
        let crypto_store = matrix_dir.join("crypto_store");
        Self {
            matrix_dir,
            provision_file,
            crypto_store,
            character_dir,
        }
    }

    /// Create all required directories.
    pub async fn ensure_dirs(&self) -> Result<(), ProvisionError> {
        tokio::fs::create_dir_all(&self.matrix_dir)
            .await
            .map_err(|e| ProvisionError::Io(format!("create matrix dir: {e}")))?;
        tokio::fs::create_dir_all(&self.crypto_store)
            .await
            .map_err(|e| ProvisionError::Io(format!("create crypto store: {e}")))?;
        Ok(())
    }
}

impl ProvisionState {
    /// Load provisioning state from a JSON file.
    pub fn load(path: &Path) -> Result<Option<Self>, ProvisionError> {
        if !path.exists() {
            return Ok(None);
        }
        let data = std::fs::read_to_string(path)
            .map_err(|e| ProvisionError::Io(format!("read provision.json: {e}")))?;
        let state: Self = serde_json::from_str(&data)
            .map_err(|e| ProvisionError::InvalidState(format!("parse provision.json: {e}")))?;
        Ok(Some(state))
    }

    /// Save provisioning state to a JSON file.
    pub fn save(&self, path: &Path) -> Result<(), ProvisionError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ProvisionError::Io(format!("create parent dir: {e}")))?;
        }
        let data = serde_json::to_string_pretty(self)
            .map_err(|e| ProvisionError::Io(format!("serialize provision state: {e}")))?;
        std::fs::write(path, data)
            .map_err(|e| ProvisionError::Io(format!("write provision.json: {e}")))?;
        info!("saved provision state for {}", self.character);
        Ok(())
    }

    /// Async variant of save.
    pub async fn save_async(&self, path: &Path) -> Result<(), ProvisionError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ProvisionError::Io(format!("create parent dir: {e}")))?;
        }
        let data = serde_json::to_string_pretty(self)
            .map_err(|e| ProvisionError::Io(format!("serialize provision state: {e}")))?;
        tokio::fs::write(path, data)
            .await
            .map_err(|e| ProvisionError::Io(format!("write provision.json: {e}")))?;
        info!("saved provision state for {}", self.character);
        Ok(())
    }
}

/// Register a Matrix account using the standard client-server API with a
/// registration token (User-Interactive Authentication flow).
///
/// Works with any Matrix homeserver that supports `m.login.registration_token`.
pub async fn register_account(
    homeserver_url: &str,
    registration_token: &str,
    username: &str,
    password: &str,
) -> Result<RegisterResponse, ProvisionError> {
    let client = reqwest::Client::new();
    let url = format!("{homeserver_url}/_matrix/client/v3/register");

    // Step 1: Initial request to get session ID and required auth flows
    let initial_body = serde_json::json!({
        "username": username,
        "password": password,
    });

    let resp = client
        .post(&url)
        .json(&initial_body)
        .send()
        .await
        .map_err(|e| ProvisionError::Http(format!("register initial: {e}")))?;

    // 200 = registered immediately (unlikely with token auth), 401 = UIA required
    if resp.status().is_success() {
        let result: RegisterResponse = resp
            .json()
            .await
            .map_err(|e| ProvisionError::Http(format!("parse register response: {e}")))?;
        info!("registered Matrix account: {}", result.user_id);
        return Ok(result);
    }

    if resp.status() != reqwest::StatusCode::UNAUTHORIZED {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(ProvisionError::Registration(format!(
            "unexpected status {status}: {body}"
        )));
    }

    // Extract session from 401 response
    let uia_resp: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ProvisionError::Http(format!("parse UIA response: {e}")))?;

    let session = uia_resp["session"]
        .as_str()
        .ok_or_else(|| ProvisionError::Registration("no session in UIA response".into()))?;

    // Step 2: Complete registration with token auth
    let auth_body = serde_json::json!({
        "username": username,
        "password": password,
        "auth": {
            "type": "m.login.registration_token",
            "token": registration_token,
            "session": session,
        },
    });

    let resp = client
        .post(&url)
        .json(&auth_body)
        .send()
        .await
        .map_err(|e| ProvisionError::Http(format!("register with token: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(ProvisionError::Registration(format!(
            "registration failed {status}: {body}"
        )));
    }

    let result: RegisterResponse = resp
        .json()
        .await
        .map_err(|e| ProvisionError::Http(format!("parse register response: {e}")))?;

    info!("registered Matrix account: {}", result.user_id);
    Ok(result)
}

/// Full provisioning flow for a character.
///
/// 1. Load existing state (skip if already provisioned)
/// 2. Register Matrix account via registration token
/// 3. Save provision state
pub async fn provision_character(
    homeserver_url: &str,
    registration_token: &str,
    character: &str,
    password: &str,
    paths: &CharacterPaths,
) -> Result<ProvisionState, ProvisionError> {
    // Check for existing provisioning. URL equality is necessary but not
    // sufficient — the DB at that URL may have been wiped since we last ran.
    // Verify the saved token still works, and if not, re-provision.
    if let Some(state) = ProvisionState::load(&paths.provision_file)? {
        if state.homeserver_url != homeserver_url {
            warn!(
                "character {} provisioned for different homeserver ({}), re-provisioning",
                character, state.homeserver_url
            );
            wipe_character_state(paths).await?;
        } else {
            match check_token(homeserver_url, &state.access_token).await {
                TokenStatus::Valid { .. } => {
                    info!(
                        "character {} already provisioned as {}",
                        character, state.user_id
                    );
                    return Ok(state);
                }
                TokenStatus::Invalid => {
                    warn!(
                        "character {}: saved token rejected (401), wiping and re-provisioning",
                        character
                    );
                    wipe_character_state(paths).await?;
                }
                TokenStatus::Unknown(err) => {
                    // Don't destroy state on transient errors — surface as failure.
                    return Err(ProvisionError::Http(format!(
                        "could not verify saved token for {character}: {err}"
                    )));
                }
            }
        }
    }

    paths.ensure_dirs().await?;

    let username = format!("shore-{}", character.to_lowercase().replace(' ', "-"));
    let reg = register_account(homeserver_url, registration_token, &username, password).await?;

    let state = ProvisionState {
        character: character.to_string(),
        user_id: reg.user_id,
        device_id: reg.device_id.unwrap_or_else(|| "SHORE_MATRIX".to_string()),
        access_token: reg.access_token,
        room_id: None,
        avatar_set: false,
        homeserver_url: homeserver_url.to_string(),
    };

    state.save_async(&paths.provision_file).await?;
    Ok(state)
}

/// Provision the admin account on first run.
pub async fn provision_admin(
    homeserver_url: &str,
    registration_token: &str,
    admin_user: &str,
    admin_password: &str,
) -> Result<RegisterResponse, ProvisionError> {
    register_account(
        homeserver_url,
        registration_token,
        admin_user,
        admin_password,
    )
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterResponse {
    pub user_id: String,
    pub access_token: String,
    pub device_id: Option<String>,
    pub home_server: Option<String>,
}

// ── Liveness checks ─────────────────────────────────────────────────────
//
// Provision state on disk can outlive the homeserver database it was created
// against — wiping the RocksDB leaves `provision.json` and `embedded_state.json`
// referencing users/tokens the fresh DB has never heard of. URL equality is
// not a proof of identity; the only reliable signal is asking the server.

/// Whether an access token is still accepted by the homeserver.
#[derive(Debug)]
pub enum TokenStatus {
    /// Server accepted the token and returned this user_id.
    Valid { user_id: String },
    /// Server returned 401 — the token is dead (DB wiped, revoked, etc.).
    Invalid,
    /// Request failed for some other reason. Caller should treat as
    /// "can't tell" and NOT destroy state — a 500 or network blip must
    /// not trigger a wipe-and-reprovision.
    Unknown(String),
}

/// Call `GET /_matrix/client/v3/account/whoami` to verify a token.
pub async fn check_token(homeserver_url: &str, access_token: &str) -> TokenStatus {
    let client = reqwest::Client::new();
    let url = format!("{homeserver_url}/_matrix/client/v3/account/whoami");
    let resp = match client.get(&url).bearer_auth(access_token).send().await {
        Ok(r) => r,
        Err(e) => return TokenStatus::Unknown(format!("whoami request: {e}")),
    };
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return TokenStatus::Invalid;
    }
    if !resp.status().is_success() {
        return TokenStatus::Unknown(format!("whoami status {}", resp.status()));
    }
    #[derive(Deserialize)]
    struct WhoamiResp {
        user_id: String,
    }
    match resp.json::<WhoamiResp>().await {
        Ok(r) => TokenStatus::Valid { user_id: r.user_id },
        Err(e) => TokenStatus::Unknown(format!("whoami parse: {e}")),
    }
}

/// Whether a room still exists on the homeserver from the caller's view.
#[derive(Debug)]
pub enum RoomStatus {
    /// `m.room.create` state was fetched successfully — the room exists
    /// and the caller has access.
    Exists,
    /// Server returned 404 — the room is gone (or never existed).
    Gone,
    /// Any other outcome (403, 500, network error). Don't clear state.
    Unknown(String),
}

/// Probe whether a room still exists using the admin/caller token.
pub async fn check_room_exists(
    homeserver_url: &str,
    room_id: &str,
    access_token: &str,
) -> RoomStatus {
    let client = reqwest::Client::new();
    let encoded = urlencoding::encode(room_id);
    let url = format!("{homeserver_url}/_matrix/client/v3/rooms/{encoded}/state/m.room.create");
    let resp = match client.get(&url).bearer_auth(access_token).send().await {
        Ok(r) => r,
        Err(e) => return RoomStatus::Unknown(format!("room check request: {e}")),
    };
    if resp.status().is_success() {
        return RoomStatus::Exists;
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return RoomStatus::Gone;
    }
    RoomStatus::Unknown(format!("room check status {}", resp.status()))
}

/// Remove a character's on-disk matrix state (provision.json + crypto store).
///
/// Called when we detect the saved state is bound to a dead homeserver DB
/// or token. The crypto store must be wiped alongside `provision.json`
/// because matrix-sdk's olm sessions are bound to the old device_id; after
/// re-registration the bot gets a new device_id and the stale olm state
/// would cause encryption failures.
pub async fn wipe_character_state(paths: &CharacterPaths) -> Result<(), ProvisionError> {
    if paths.provision_file.exists() {
        tokio::fs::remove_file(&paths.provision_file)
            .await
            .map_err(|e| ProvisionError::Io(format!("remove provision.json: {e}")))?;
    }
    if paths.crypto_store.exists() {
        tokio::fs::remove_dir_all(&paths.crypto_store)
            .await
            .map_err(|e| ProvisionError::Io(format!("remove crypto_store: {e}")))?;
    }
    Ok(())
}

/// Delete `embedded_state.json` and every character's `provision.json` +
/// `crypto_store` found under the shore data dir. Returns the list of
/// character names whose state was wiped.
///
/// Called when we detect the admin token is rejected — that means the
/// homeserver DB has been replaced, which transitively invalidates every
/// character's provisioning too. Does NOT touch the running homeserver's
/// database dir; the caller is responsible for preserving the registration
/// token so re-registration hits the same live homeserver.
pub async fn wipe_embedded_state_and_characters(
    hs_paths: &HomeserverPaths,
) -> Result<Vec<String>, ProvisionError> {
    if hs_paths.state_file.exists() {
        tokio::fs::remove_file(&hs_paths.state_file)
            .await
            .map_err(|e| ProvisionError::Io(format!("remove embedded_state.json: {e}")))?;
    }

    let data_dir = shore_config::data_dir();
    let mut wiped = Vec::new();
    let mut entries = match tokio::fs::read_dir(&data_dir).await {
        Ok(e) => e,
        Err(_) => return Ok(wiped),
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| ProvisionError::Io(format!("read data_dir: {e}")))?
    {
        let ft = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let char_paths = CharacterPaths::with_base(data_dir.clone(), &name);
        if char_paths.provision_file.exists() {
            wipe_character_state(&char_paths).await?;
            wiped.push(name);
        }
    }
    Ok(wiped)
}

#[derive(Debug, thiserror::Error)]
pub enum ProvisionError {
    #[error("I/O error: {0}")]
    Io(String),
    #[error("invalid provision state: {0}")]
    InvalidState(String),
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("registration failed: {0}")]
    Registration(String),
}

// ── Embedded homeserver state ───────────────────────────────────────────

/// Paths for the global embedded Matrix homeserver instance.
#[derive(Debug, Clone)]
pub struct HomeserverPaths {
    /// $SHORE_DATA_DIR/matrix-server/
    pub server_dir: PathBuf,
    /// $SHORE_DATA_DIR/matrix-server/embedded_state.json
    pub state_file: PathBuf,
}

impl Default for HomeserverPaths {
    fn default() -> Self {
        Self::new()
    }
}

impl HomeserverPaths {
    /// Compute paths using the resolved Shore data directory.
    pub fn new() -> Self {
        let data_dir = shore_config::data_dir();
        Self::with_base(data_dir)
    }

    /// Compute paths from an explicit data directory override.
    pub fn from_data_dir(data_dir: &str) -> Self {
        Self {
            server_dir: PathBuf::from(data_dir),
            state_file: PathBuf::from(data_dir).join("embedded_state.json"),
        }
    }

    /// Compute paths with an explicit base data directory (Shore root, not XDG parent).
    pub fn with_base(base: PathBuf) -> Self {
        let server_dir = base.join("matrix-server");
        let state_file = server_dir.join("embedded_state.json");
        Self {
            server_dir,
            state_file,
        }
    }
}

/// Persisted state for an embedded Matrix homeserver.
///
/// Generated on first run and loaded on subsequent starts. Contains
/// the registration token and admin credentials needed to manage accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedState {
    /// Registration token for creating accounts via the Matrix API.
    pub registration_token: String,
    /// Admin user ID (e.g. @shore-admin:shore.local).
    pub admin_user_id: String,
    /// Admin access token.
    pub admin_access_token: String,
    /// Admin device ID.
    pub admin_device_id: String,
    /// The password used for the admin account.
    pub admin_password: String,
    /// Homeserver URL (e.g. http://127.0.0.1:6167).
    pub homeserver_url: String,
}

impl EmbeddedState {
    /// Load embedded state from a JSON file.
    pub fn load(path: &Path) -> Result<Option<Self>, ProvisionError> {
        if !path.exists() {
            return Ok(None);
        }
        let data = std::fs::read_to_string(path)
            .map_err(|e| ProvisionError::Io(format!("read embedded_state.json: {e}")))?;
        let state: Self = serde_json::from_str(&data)
            .map_err(|e| ProvisionError::InvalidState(format!("parse embedded_state.json: {e}")))?;
        Ok(Some(state))
    }

    /// Save embedded state to a JSON file.
    pub fn save(&self, path: &Path) -> Result<(), ProvisionError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ProvisionError::Io(format!("create parent dir: {e}")))?;
        }
        let data = serde_json::to_string_pretty(self)
            .map_err(|e| ProvisionError::Io(format!("serialize embedded state: {e}")))?;
        std::fs::write(path, data)
            .map_err(|e| ProvisionError::Io(format!("write embedded_state.json: {e}")))?;
        info!("saved embedded state to {}", path.display());
        Ok(())
    }
}

// ── Room creation ───────────────────────────────────────────────────────

/// Create a private room for a character, inviting the bot and optionally a human user.
///
/// Uses the admin account's access token to create the room and set power levels.
pub async fn create_character_room(
    homeserver_url: &str,
    admin_token: &str,
    admin_user_id: &str,
    character_user_id: &str,
    trusted_user: Option<&str>,
    character_name: &str,
) -> Result<String, ProvisionError> {
    let client = reqwest::Client::new();
    let url = format!("{homeserver_url}/_matrix/client/v3/createRoom");

    let mut invite = vec![character_user_id.to_string()];
    if let Some(human) = trusted_user {
        invite.push(human.to_string());
    }

    let body = serde_json::json!({
        "name": character_name,
        "topic": format!("Chat with {character_name} (Shore)"),
        "preset": "private_chat",
        "invite": invite,
        "creation_content": {
            "m.federate": false
        },
        "power_level_content_override": {
            "users": {
                admin_user_id: 100,
                character_user_id: 50,
            }
        }
    });

    let resp = client
        .post(&url)
        .bearer_auth(admin_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| ProvisionError::Http(format!("create room: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(ProvisionError::Registration(format!(
            "create room failed {status}: {text}"
        )));
    }

    #[derive(Deserialize)]
    struct CreateRoomResponse {
        room_id: String,
    }
    let result: CreateRoomResponse = resp
        .json()
        .await
        .map_err(|e| ProvisionError::Http(format!("parse room response: {e}")))?;

    info!("created room {} for {}", result.room_id, character_name);
    Ok(result.room_id)
}

/// Join a room using an access token.
pub async fn join_room(
    homeserver_url: &str,
    room_id: &str,
    access_token: &str,
) -> Result<(), ProvisionError> {
    let client = reqwest::Client::new();
    let encoded = urlencoding::encode(room_id);
    let url = format!("{homeserver_url}/_matrix/client/v3/join/{encoded}");
    let resp = client
        .post(&url)
        .bearer_auth(access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| ProvisionError::Http(format!("join room: {e}")))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(ProvisionError::Http(format!("join room failed: {text}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn provision_state_roundtrip() {
        let state = ProvisionState {
            character: "Alice".to_string(),
            user_id: "@shore-alice:localhost".to_string(),
            device_id: "DEV123".to_string(),
            access_token: "tok_abc".to_string(),
            room_id: Some("!room:localhost".to_string()),
            avatar_set: true,
            homeserver_url: "http://localhost:8008".to_string(),
        };

        let json = serde_json::to_string_pretty(&state).unwrap();
        let restored: ProvisionState = serde_json::from_str(&json).unwrap();
        assert_eq!(state, restored);
    }

    #[test]
    fn provision_state_save_and_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("provision.json");

        let state = ProvisionState {
            character: "Bob".to_string(),
            user_id: "@shore-bob:localhost".to_string(),
            device_id: "DEV456".to_string(),
            access_token: "tok_xyz".to_string(),
            room_id: None,
            avatar_set: false,
            homeserver_url: "http://localhost:8008".to_string(),
        };

        state.save(&path).unwrap();
        let loaded = ProvisionState::load(&path).unwrap().unwrap();
        assert_eq!(state, loaded);
    }

    #[test]
    fn provision_state_load_nonexistent() {
        let result = ProvisionState::load(Path::new("/nonexistent/provision.json")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn provision_state_load_invalid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("provision.json");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"not json").unwrap();

        let result = ProvisionState::load(&path);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("parse provision.json"));
    }

    #[test]
    fn provision_state_json_fields() {
        let state = ProvisionState {
            character: "Eve".to_string(),
            user_id: "@shore-eve:matrix.org".to_string(),
            device_id: "SHORE_MATRIX".to_string(),
            access_token: "secret_token".to_string(),
            room_id: Some("!abc:matrix.org".to_string()),
            avatar_set: false,
            homeserver_url: "https://matrix.org".to_string(),
        };

        let json: serde_json::Value = serde_json::to_value(&state).unwrap();
        assert_eq!(json["character"], "Eve");
        assert_eq!(json["user_id"], "@shore-eve:matrix.org");
        assert_eq!(json["device_id"], "SHORE_MATRIX");
        assert_eq!(json["access_token"], "secret_token");
        assert_eq!(json["room_id"], "!abc:matrix.org");
        assert_eq!(json["avatar_set"], false);
        assert_eq!(json["homeserver_url"], "https://matrix.org");
    }

    #[test]
    fn character_paths_structure() {
        let base = PathBuf::from("/home/user/.local/share/shore");
        let paths = CharacterPaths::with_base(base, "alice");

        assert_eq!(
            paths.character_dir,
            PathBuf::from("/home/user/.local/share/shore/alice")
        );
        assert_eq!(
            paths.matrix_dir,
            PathBuf::from("/home/user/.local/share/shore/alice/matrix")
        );
        assert_eq!(
            paths.provision_file,
            PathBuf::from("/home/user/.local/share/shore/alice/matrix/provision.json")
        );
        assert_eq!(
            paths.crypto_store,
            PathBuf::from("/home/user/.local/share/shore/alice/matrix/crypto_store")
        );
    }

    #[test]
    fn provision_error_display() {
        assert!(ProvisionError::Io("disk full".into())
            .to_string()
            .contains("disk full"));
        assert!(ProvisionError::InvalidState("bad json".into())
            .to_string()
            .contains("bad json"));
        assert!(ProvisionError::Http("timeout".into())
            .to_string()
            .contains("timeout"));
        assert!(ProvisionError::Registration("403".into())
            .to_string()
            .contains("403"));
    }

    #[test]
    fn register_response_deserialize() {
        let json = r#"{
            "user_id": "@shore-test:localhost",
            "access_token": "tok123",
            "device_id": "DEV",
            "home_server": "localhost"
        }"#;
        let resp: RegisterResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.user_id, "@shore-test:localhost");
        assert_eq!(resp.access_token, "tok123");
        assert_eq!(resp.device_id.as_deref(), Some("DEV"));
        assert_eq!(resp.home_server.as_deref(), Some("localhost"));
    }

    #[test]
    fn provision_state_save_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a").join("b").join("provision.json");

        let state = ProvisionState {
            character: "test".to_string(),
            user_id: "@test:localhost".to_string(),
            device_id: "DEV".to_string(),
            access_token: "tok".to_string(),
            room_id: None,
            avatar_set: false,
            homeserver_url: "http://localhost:8008".to_string(),
        };

        state.save(&path).unwrap();
        assert!(path.exists());
    }

    // ── Embedded state tests ────────────────────────────────────────

    #[test]
    fn homeserver_paths_structure() {
        let base = PathBuf::from("/home/user/.local/share/shore");
        let paths = HomeserverPaths::with_base(base);

        assert_eq!(
            paths.server_dir,
            PathBuf::from("/home/user/.local/share/shore/matrix-server")
        );
        assert_eq!(
            paths.state_file,
            PathBuf::from("/home/user/.local/share/shore/matrix-server/embedded_state.json")
        );
    }

    #[test]
    fn homeserver_paths_from_data_dir() {
        let paths = HomeserverPaths::from_data_dir("/opt/shore-matrix");
        assert_eq!(paths.server_dir, PathBuf::from("/opt/shore-matrix"));
        assert_eq!(
            paths.state_file,
            PathBuf::from("/opt/shore-matrix/embedded_state.json")
        );
    }

    #[test]
    fn embedded_state_roundtrip() {
        let state = EmbeddedState {
            registration_token: "abc123def456".to_string(),
            admin_user_id: "@shore-admin:localhost".to_string(),
            admin_access_token: "tok_admin".to_string(),
            admin_device_id: "SHORE_ADMIN".to_string(),
            admin_password: "admin_pass".to_string(),
            homeserver_url: "http://localhost:8008".to_string(),
        };

        let json = serde_json::to_string_pretty(&state).unwrap();
        let restored: EmbeddedState = serde_json::from_str(&json).unwrap();
        assert_eq!(state.registration_token, restored.registration_token);
        assert_eq!(state.admin_user_id, restored.admin_user_id);
        assert_eq!(state.admin_access_token, restored.admin_access_token);
        assert_eq!(state.admin_device_id, restored.admin_device_id);
        assert_eq!(state.admin_password, restored.admin_password);
        assert_eq!(state.homeserver_url, restored.homeserver_url);
    }

    #[test]
    fn embedded_state_save_and_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("embedded_state.json");

        let state = EmbeddedState {
            registration_token: "secret123".to_string(),
            admin_user_id: "@shore-admin:test".to_string(),
            admin_access_token: "tok".to_string(),
            admin_device_id: "DEV".to_string(),
            admin_password: "pass".to_string(),
            homeserver_url: "http://localhost:9999".to_string(),
        };

        state.save(&path).unwrap();
        let loaded = EmbeddedState::load(&path).unwrap().unwrap();
        assert_eq!(state.registration_token, loaded.registration_token);
        assert_eq!(state.admin_user_id, loaded.admin_user_id);
        assert_eq!(state.homeserver_url, loaded.homeserver_url);
    }

    #[test]
    fn embedded_state_load_nonexistent() {
        let result = EmbeddedState::load(Path::new("/nonexistent/state.json")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn embedded_state_load_invalid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("embedded_state.json");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"not json").unwrap();

        let result = EmbeddedState::load(&path);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("parse embedded_state.json"));
    }

    #[test]
    fn embedded_state_save_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a").join("b").join("embedded_state.json");

        let state = EmbeddedState {
            registration_token: "s".to_string(),
            admin_user_id: "@a:l".to_string(),
            admin_access_token: "t".to_string(),
            admin_device_id: "d".to_string(),
            admin_password: "p".to_string(),
            homeserver_url: "http://localhost:8008".to_string(),
        };

        state.save(&path).unwrap();
        assert!(path.exists());
    }
}
