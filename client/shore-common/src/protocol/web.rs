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
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebLoginCode {
    pub code: String,
    #[ts(type = "number")]
    pub expires_at: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebArchiveExport {
    pub character: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub enum WebArchivePhase {
    Uploading,
    Ready,
    Exporting,
    Importing,
    Imported,
    Failed,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(tag = "name", content = "data")]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub enum WebArchiveResult {
    #[serde(rename = "export_character")]
    Export(super::operations::ExportCharacterResult),
    #[serde(rename = "import_character")]
    Import(super::operations::ImportCharacterResult),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebArchiveInfo {
    pub id: String,
    pub filename: String,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub expires_at: u64,
    pub phase: WebArchivePhase,
    pub downloadable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<WebArchiveResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebArchiveList {
    pub archives: Vec<WebArchiveInfo>,
    #[ts(type = "number")]
    pub max_upload_bytes: u64,
    #[ts(type = "number")]
    pub max_expanded_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub enum WebRequestPhase {
    Running,
    Uncertain,
    Completed,
    Failed,
    Cancelled,
    Superseded,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebRequestInfo {
    pub id: String,
    pub rid: String,
    pub operation: String,
    pub label: String,
    pub character: Option<String>,
    pub thread: Option<String>,
    #[ts(type = "number")]
    pub started_at: u64,
    #[ts(type = "number")]
    pub expires_at: u64,
    pub phase: WebRequestPhase,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<super::operations::OperationResponse>,
    pub result_omitted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<super::server_msg::Error>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebRequestList {
    pub requests: Vec<WebRequestInfo>,
    pub max_records: u32,
    pub max_result_bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebPreferences {
    pub values: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub enum WebDeviceKind {
    Browser,
    Cli,
    Automation,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebDevice {
    pub id: String,
    pub kind: WebDeviceKind,
    pub name: String,
    #[ts(type = "number")]
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last_used_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub operations: Option<Vec<String>>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebSignInRequest {
    pub code: String,
    pub name: String,
    #[ts(type = "number")]
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebDeviceList {
    pub devices: Vec<WebDevice>,
    pub requests: Vec<WebSignInRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebAutomationKey {
    pub name: String,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebNewDevice {
    pub device: WebDevice,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebDeviceChoice {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebSignInStart {
    pub name: String,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebSignInPending {
    pub id: String,
    pub code: String,
    #[ts(type = "number")]
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebSignInPoll {
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebSignInGranted {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../../daemon/src/protocol/")]
pub struct WebSignInDecision {
    pub code: String,
    pub allow: bool,
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
            "login_code": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebLoginCode>(),
            "problem": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebProblem>(),
            "archive_export": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebArchiveExport>(),
            "archive_info": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebArchiveInfo>(),
            "archive_list": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebArchiveList>(),
            "request_info": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebRequestInfo>(),
            "request_list": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebRequestList>(),
            "preferences": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebPreferences>(),
            "device_list": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebDeviceList>(),
            "automation_key": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebAutomationKey>(),
            "new_device": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebNewDevice>(),
            "device_choice": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebDeviceChoice>(),
            "sign_in_start": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebSignInStart>(),
            "sign_in_pending": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebSignInPending>(),
            "sign_in_poll": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebSignInPoll>(),
            "sign_in_granted": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<WebSignInGranted>(),
            "sign_in_decision": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<WebSignInDecision>(),
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
