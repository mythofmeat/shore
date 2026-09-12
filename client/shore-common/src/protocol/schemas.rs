use super::{client_msg::ClientMessage, server_msg::ServerMessage};
use schemars::generate::SchemaSettings;

#[test]
fn export_wire_schemas() {
    let schemas = serde_json::json!({
        "client": SchemaSettings::draft2020_12().for_deserialize().into_generator().into_root_schema_for::<ClientMessage>(),
        "server": SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<ServerMessage>(),
    });
    let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../daemon/src/protocol/wire.generated.json");
    std::fs::write(
        target,
        format!("{}\n", serde_json::to_string_pretty(&schemas).unwrap()),
    )
    .unwrap();
}
