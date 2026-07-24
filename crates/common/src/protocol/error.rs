use serde::{Deserialize, Serialize};

/// SWP error codes per §3.6.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProtocolError,
    InvalidRequest,
    NotFound,
    Busy,
    ProviderError,
    Timeout,
    InternalError,
}
