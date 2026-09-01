#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryKind {
    RegistryMissing,
    RegistryEmpty,
    NoMatch,
    Ambiguous,
    RegistryCorrupt,
    Io,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("connection failed: {0}")]
    Connect(String),

    #[error("disconnected from server")]
    Disconnected,

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("{0}")]
    Unauthorized(String),

    #[error("provider error: {message}")]
    Provider {
        message: String,
        retry_after_ms: Option<u64>,
    },

    #[error("request timed out: {message}")]
    Timeout {
        message: String,
        retry_after_ms: Option<u64>,
    },

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

    #[error("failed to read attachment {path}: {source}")]
    AttachmentRead {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

pub type Result<T> = std::result::Result<T, ClientError>;
