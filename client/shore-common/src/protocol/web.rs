use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebLogin {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebSessionInfo {
    pub contract: String,
    pub protocol: u32,
    #[ts(type = "number")]
    pub expires_at: u64,
    pub max_message_bytes: u32,
    pub max_pending_requests: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub enum WebProblemCode {
    Unauthorized,
    Forbidden,
    InvalidRequest,
    TooManyRequests,
    ReloadRequired,
    Unavailable,
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebProblem {
    pub code: WebProblemCode,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use schemars::generate::SchemaSettings;

    #[test]
    fn export_web_schemas() {
        let schema = serde_json::json!({
            "login": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebLogin>(),
            "session": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebSessionInfo>(),
            "problem": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebProblem>(),
        });
        let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../daemon/src/web/schemas.generated.json");
        std::fs::write(
            target,
            format!("{}\n", serde_json::to_string_pretty(&schema).unwrap()),
        )
        .unwrap();
    }
}
