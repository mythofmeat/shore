//! Test/dev stub MCP server (echo tool over stdio), built as a `shore-daemon`
//! binary so the daemon's integration tests can launch it via
//! `CARGO_BIN_EXE_daemon_mcp_stub_server` without depending on another crate's
//! bin. Implementation lives in [`shore_mcp_client::stub`].

fn main() {
    shore_mcp_client::stub::run();
}
