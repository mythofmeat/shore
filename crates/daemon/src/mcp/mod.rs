//! MCP (Model Context Protocol) client for the Silvershore daemon.
//!
//! The daemon is an MCP *client*: each `[mcp.<name>]` config entry points at an
//! external server (a stdio child process or a remote HTTP endpoint) that the
//! daemon connects to, discovers tools from via `tools/list`, and invokes via
//! `tools/call`. Servers are never daemon code — anything speaking standard MCP
//! works unchanged.
//!
//! This crate is a thin, transport-agnostic wrapper over [`rmcp`]. The daemon
//! adapts the [`McpTool`]s discovered here into its own tool registry and
//! namespaces them `mcp__<server>__<tool>` (that namespacing lives in the
//! daemon, not here).
//!
//! [`stub`] is a tiny in-tree stdio MCP *server* used only by tests (this
//! crate's and the daemon's) so the MCP test paths need no external runtime.

pub mod stub;

use std::collections::BTreeMap;

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Error)]
pub enum McpError {
    #[error("connect to MCP server '{server}': {source}")]
    Connect {
        server: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("spawn MCP server '{server}': {source}")]
    Spawn {
        server: String,
        #[source]
        source: std::io::Error,
    },
    #[error("MCP request to '{server}': {source}")]
    Request {
        server: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("invalid arguments for MCP tool '{tool}': {detail}")]
    InvalidArgs { tool: String, detail: String },
    #[error("MCP tool '{tool}' returned an error: {detail}")]
    ToolFailed { tool: String, detail: String },
}

/// How to reach an MCP server.
#[derive(Debug, Clone)]
pub enum Transport {
    /// Launch a child process and speak over its stdio.
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        /// Working directory for the child. `None` inherits the daemon's cwd.
        cwd: Option<String>,
    },
    /// Connect to a remote streamable-HTTP endpoint.
    Http { url: String },
}

/// A named MCP server to connect to.
#[derive(Debug, Clone)]
pub struct McpServerSpec {
    pub name: String,
    pub transport: Transport,
}

/// A single tool discovered from a server via `tools/list`.
#[derive(Debug, Clone)]
pub struct McpTool {
    /// The server this tool belongs to (the `[mcp.<name>]` key).
    pub server: String,
    /// The server-side tool name (e.g. `set_light`), without namespacing.
    pub name: String,
    pub description: String,
    /// The tool's JSON Schema for its arguments.
    pub input_schema: Value,
}

/// A live connection to one MCP server.
pub struct McpClient {
    server: String,
    service: RunningService<RoleClient, ()>,
}

impl std::fmt::Debug for McpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClient")
            .field("server", &self.server)
            .finish_non_exhaustive()
    }
}

impl McpClient {
    /// Connect to `spec`, performing the MCP `initialize` handshake.
    pub async fn connect(spec: &McpServerSpec) -> Result<Self, McpError> {
        let service = match &spec.transport {
            Transport::Stdio {
                command,
                args,
                env,
                cwd,
            } => {
                let mut cmd = tokio::process::Command::new(command);
                let _ = cmd.args(args);
                if let Some(dir) = cwd {
                    let _ = cmd.current_dir(dir);
                }
                // Don't leak the daemon's environment (provider API keys, etc.)
                // to MCP servers, which may be third-party code. Start from a
                // clean slate and pass through only what a server needs to run
                // (`PATH` for command resolution, `HOME` for tool caches/config)
                // plus the explicitly configured `env`.
                let _ = cmd.env_clear();
                for passthrough in ["PATH", "HOME"] {
                    if let Some(val) = std::env::var_os(passthrough) {
                        let _ = cmd.env(passthrough, val);
                    }
                }
                for (key, val) in env {
                    let _ = cmd.env(key, val);
                }
                let (process, stderr) = TokioChildProcess::builder(cmd)
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|source| McpError::Spawn {
                        server: spec.name.clone(),
                        source,
                    })?;
                if let Some(child_stderr) = stderr {
                    spawn_stderr_logger(spec.name.clone(), child_stderr);
                }
                ().serve(process).await.map_err(|e| McpError::Connect {
                    server: spec.name.clone(),
                    source: Box::new(e),
                })?
            }
            Transport::Http { url } => {
                let transport = StreamableHttpClientTransport::from_uri(url.clone());
                ().serve(transport).await.map_err(|e| McpError::Connect {
                    server: spec.name.clone(),
                    source: Box::new(e),
                })?
            }
        };
        Ok(Self {
            server: spec.name.clone(),
            service,
        })
    }

    /// The server name (the `[mcp.<name>]` key).
    #[must_use]
    pub fn server(&self) -> &str {
        &self.server
    }

    /// List the server's tools. Called once at connect; the daemon pins the
    /// result for the session so the tool surface (and cache prefix) is stable.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>, McpError> {
        let result = self
            .service
            .list_all_tools()
            .await
            .map_err(|e| McpError::Request {
                server: self.server.clone(),
                source: Box::new(e),
            })?;
        Ok(result
            .into_iter()
            .map(|tool| McpTool {
                server: self.server.clone(),
                name: tool.name.into_owned(),
                description: tool
                    .description
                    .map(std::borrow::Cow::into_owned)
                    .unwrap_or_default(),
                input_schema: Value::Object((*tool.input_schema).clone()),
            })
            .collect())
    }

    /// Invoke `tool` with `args` (a JSON object or null), returning a flattened
    /// JSON result. A tool-level error (`isError`) maps to [`McpError::ToolFailed`].
    pub async fn call(&self, tool: &str, args: Value) -> Result<Value, McpError> {
        let arguments = match args {
            Value::Object(map) => Some(map),
            Value::Null => None,
            other @ (Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_)) => {
                return Err(McpError::InvalidArgs {
                    tool: tool.to_owned(),
                    detail: format!("expected a JSON object, got {other}"),
                })
            }
        };
        let mut params = CallToolRequestParams::new(tool.to_owned());
        if let Some(map) = arguments {
            params = params.with_arguments(map);
        }
        let result = self
            .service
            .call_tool(params)
            .await
            .map_err(|e| McpError::Request {
                server: self.server.clone(),
                source: Box::new(e),
            })?;
        if result.is_error.unwrap_or(false) {
            return Err(McpError::ToolFailed {
                tool: tool.to_owned(),
                detail: flatten_text(&result),
            });
        }
        Ok(flatten_result(result))
    }

    /// Gracefully close the connection (and, for stdio, the child process).
    pub async fn shutdown(self) {
        if let Err(e) = self.service.cancel().await {
            tracing::warn!(server = %self.server, error = %e, "MCP shutdown error");
        }
    }
}

/// Reduce a tool result to JSON: prefer structured content, else join text.
fn flatten_result(result: CallToolResult) -> Value {
    if let Some(structured) = result.structured_content {
        return structured;
    }
    Value::String(flatten_text(&result))
}

/// Join all text content blocks of a result with newlines.
fn flatten_text(result: &CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Relay a child server's stderr into tracing so server diagnostics are visible
/// without polluting the stdout protocol channel.
fn spawn_stderr_logger(server: String, stderr: tokio::process::ChildStderr) {
    // Detach: the task lives until the child's stderr closes (process exit).
    let _handle = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(server = %server, "mcp stderr: {line}");
        }
    });
}
