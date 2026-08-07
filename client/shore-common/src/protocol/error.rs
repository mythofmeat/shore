use serde::{Deserialize, Serialize};

/// SWP error codes per §3.6.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProtocolError,
    InvalidRequest,
    NotFound,
    Busy,
    ProviderError,
    Timeout,
    InternalError,
    /// The hello carried no token, or the wrong one.
    ///
    /// Distinct from `ProtocolError` because it is the one refusal a person is
    /// expected to fix themselves, and telling them "protocol error" would send
    /// them looking in the wrong place entirely.
    Unauthorized,
}
