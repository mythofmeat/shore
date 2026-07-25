//! End-to-end test of the MCP client against the in-tree `mcp_stub_server`
//! stdio stub. No external runtime required — the stub is a Rust bin in this
//! crate, located via `CARGO_BIN_EXE_*`.

use std::collections::BTreeMap;

use serde_json::json;
use shore_daemon::mcp::{McpClient, McpError, McpServerSpec, Transport};

fn stub_spec() -> McpServerSpec {
    McpServerSpec {
        name: "stub".to_owned(),
        transport: Transport::Stdio {
            command: env!("CARGO_BIN_EXE_mcp_stub_server").to_owned(),
            args: vec![],
            env: BTreeMap::new(),
            cwd: None,
        },
    }
}

#[tokio::test]
async fn connect_list_call_and_error() {
    let client = McpClient::connect(&stub_spec())
        .await
        .expect("connect to stub server");

    // tools/list surfaces the single echo tool, tagged with the server name.
    let tools = client.list_tools().await.expect("list tools");
    assert_eq!(tools.len(), 1);
    let echo = tools.first().expect("one tool present");
    assert_eq!(echo.name, "echo");
    assert_eq!(echo.server, "stub");
    assert_eq!(echo.description, "Echo back the message.");
    assert_eq!(
        echo.input_schema.get("type").and_then(|v| v.as_str()),
        Some("object")
    );

    // tools/call returns flattened text.
    let result = client
        .call("echo", json!({"message": "hi"}))
        .await
        .expect("call echo");
    assert_eq!(result.as_str(), Some("echo: hi"));

    // A tool that reports isError maps to McpError::ToolFailed.
    let err = client
        .call("nope", json!({}))
        .await
        .expect_err("unknown tool should error");
    assert!(
        matches!(err, McpError::ToolFailed { .. }),
        "expected ToolFailed, got {err:?}"
    );

    client.shutdown().await;
}
