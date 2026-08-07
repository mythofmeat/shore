/// Why a discovery call failed. Attached to `ClientError::Discovery` so
/// callers can decide (e.g. "spawn a daemon", "fall back to the default
/// address", "bubble up") without string-matching the human message, which
/// historically drifted out of sync and silently broke spawn-on-miss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryKind {
    /// The instances registry file does not exist on disk.
    RegistryMissing,
    /// The registry exists but has no live entries (empty file, JSON `[]`,
    /// or every recorded PID was dead and got pruned).
    RegistryEmpty,
    /// The registry has live entries, but none match the requested
    /// instance id or config_dir selector.
    NoMatch,
    /// The registry file is unreadable or not valid JSON.
    RegistryCorrupt,
    /// Unexpected I/O error reading the registry.
    Io,
}

/// Errors produced by the shore-common library.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("connection failed: {0}")]
    Connect(String),

    #[error("disconnected from server")]
    Disconnected,

    #[error("protocol error: {0}")]
    Protocol(String),

    /// No token could be found on this side, or the daemon refused the one
    /// sent. Separate from [`ClientError::Protocol`] because it is the one
    /// failure the person running the client is expected to fix, and the
    /// message carries the instructions for fixing it.
    #[error("{0}")]
    Unauthorized(String),

    #[error("discovery error: {message}")]
    Discovery {
        kind: DiscoveryKind,
        message: String,
    },

    #[error("serialization error: {0}")]
    Serialize(#[source] serde_json::Error),

    #[error("deserialization error: {0}")]
    Deserialize(#[source] serde_json::Error),

    #[error("I/O error: {0}")]
    Io(#[source] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ClientError>;
