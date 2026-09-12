use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, schemars::JsonSchema, ts_rs::TS)]
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
    Unauthorized,
}
