//! A minimal stdio MCP **server** stub for tests — an `echo` tool over
//! newline-delimited JSON-RPC 2.0. Hand-rolled (no server SDK) so it stays tiny
//! and dependency-light; it implements just enough surface (`initialize`,
//! `tools/list`, `tools/call`, `ping`) to exercise the client end to end.
//!
//! Not for production use. It exists so the MCP test cases (the stdio test and
//! the keepalive cache-parity test) can launch a real MCP server process with
//! zero external runtime. `tests/support/mcp_stub_server.rs` is a one-line bin
//! that calls [`run`], so it is reachable via `CARGO_BIN_EXE_mcp_stub_server`
//! from integration tests and via `target/<profile>/mcp_stub_server` from unit
//! tests. It is gated behind the `test-stub` feature, which a self-referential
//! dev-dependency enables for test builds only — so it never lands in a release
//! build or a `cargo install`.

use std::io::{BufRead as _, Write as _};

use serde_json::{json, Value};

/// Run the stub server: read JSON-RPC requests from stdin, write responses to
/// stdout, until stdin closes.
pub fn run() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(text) = line else { break };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(resp) = handle(&msg) {
            if let Ok(serialized) = serde_json::to_string(&resp) {
                let _ignored = writeln!(out, "{serialized}").and_then(|()| out.flush());
            }
        }
    }
}

/// Build the JSON-RPC response for one request, or `None` for notifications.
fn handle(msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();

    match method {
        "initialize" => {
            let protocol_version = msg
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .cloned()
                .unwrap_or(Value::Null);
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": protocol_version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "stub", "version": "0.0.1" },
                },
            }))
        }
        // Notification: no response.
        "notifications/initialized" => None,
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [{
                    "name": "echo",
                    "description": "Echo back the message.",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "message": { "type": "string" } },
                        "required": ["message"],
                    },
                }],
            },
        })),
        "tools/call" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": tool_call_result(msg.get("params")),
        })),
        // Unknown request → method-not-found; unknown notification → ignore.
        _ => id.as_ref().map(|_| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") },
            })
        }),
    }
}

/// The `result` object for a `tools/call` (without the JSON-RPC envelope).
fn tool_call_result(params: Option<&Value>) -> Value {
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let (text, is_error) = if name == "echo" {
        let message = params
            .and_then(|p| p.get("arguments"))
            .and_then(|a| a.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("");
        (format!("echo: {message}"), false)
    } else {
        (format!("unknown tool: {name}"), true)
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}
