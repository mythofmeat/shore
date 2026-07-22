//! Live MCP connections and the dynamic tool surface they contribute.
//!
//! Each `[mcp.<name>]` config entry is connected at startup (and on hot-reload)
//! via [`shore_mcp_client`]. The tools discovered from every server are flattened into
//! one list, namespaced `mcp__<server>__<tool>`, sorted by that full name, and
//! **pinned for the registry's lifetime**. Pinning is what keeps the outbound
//! tool surface — and therefore the Anthropic cache prefix — stable across
//! turns: a server is listed once at connect, never re-listed mid-session.
//!
//! Unlike the static [`ToolDef`](super::ToolDef) registry (which is `&'static`),
//! MCP tool defs are owned because their names and schemas are only known at
//! runtime.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use shore_config::app::{tool_pattern_matches, McpServerConfig};
use shore_mcp_client::{McpClient, McpServerSpec, Transport};

use super::ToolError;

/// One discovered MCP tool, owned (runtime-resolved, unlike `ToolDef`).
#[derive(Debug, Clone)]
pub(crate) struct McpToolDef {
    /// Namespaced name offered to the model: `mcp__<server>__<tool>`.
    pub(crate) full_name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
    /// The `[mcp.<name>]` key this tool came from.
    pub(crate) server: String,
    /// The bare server-side tool name (used for the actual `tools/call`).
    pub(crate) tool: String,
}

impl McpToolDef {
    /// Render to the outbound LLM `tools` array shape.
    pub(crate) fn to_tool_json(&self) -> Value {
        json!({
            "name": self.full_name,
            "description": self.description,
            "input_schema": self.input_schema,
        })
    }
}

/// Live MCP connections plus the pinned, sorted tool surface they expose.
#[derive(Debug, Default)]
pub struct McpRegistry {
    clients: BTreeMap<String, McpClient>,
    /// Sorted by `full_name`; pinned for the registry's lifetime.
    tools: Vec<McpToolDef>,
    /// The `[mcp.*]` config this registry was built from. Used on hot-reload to
    /// skip reconnecting when the MCP section is unchanged.
    source: BTreeMap<String, McpServerConfig>,
}

impl McpRegistry {
    /// Connect every configured server and discover its tools. A server that
    /// fails to connect or list is logged and skipped — a bad server never
    /// takes the daemon down. Returns an empty registry when `mcp` is empty.
    ///
    /// `plugins_dir` is `<data>/plugins/`; relative stdio paths resolve against
    /// it (see [`to_spec`]).
    pub async fn from_config(mcp: &BTreeMap<String, McpServerConfig>, plugins_dir: &Path) -> Self {
        let mut clients = BTreeMap::new();
        let mut tools = Vec::new();

        for (name, cfg) in mcp {
            let Some(spec) = to_spec(name, cfg, plugins_dir) else {
                tracing::warn!(server = %name, "mcp server has no valid transport; skipping");
                continue;
            };
            let client = match McpClient::connect(&spec).await {
                Ok(client) => client,
                Err(e) => {
                    tracing::warn!(server = %name, error = %e, "mcp server connect failed; skipping");
                    continue;
                }
            };
            match client.list_tools().await {
                Ok(discovered) => {
                    for tool in discovered {
                        // Namespace on the config key (`name`), which the registry
                        // owns, rather than the server-reported name — the two
                        // match today, but keying both the full name and the
                        // dispatch lookup on `name` keeps them authoritative here.
                        tools.push(McpToolDef {
                            full_name: format!("mcp__{}__{}", name, tool.name),
                            description: tool.description,
                            input_schema: tool.input_schema,
                            server: name.clone(),
                            tool: tool.name,
                        });
                    }
                    let _existing = clients.insert(name.clone(), client);
                }
                Err(e) => {
                    tracing::warn!(server = %name, error = %e, "mcp tools/list failed; skipping");
                    client.shutdown().await;
                }
            }
        }

        tools.sort_by(|a, b| a.full_name.cmp(&b.full_name));
        if !tools.is_empty() {
            tracing::info!(count = tools.len(), "connected MCP tools");
        }
        Self {
            clients,
            tools,
            source: mcp.clone(),
        }
    }

    /// Whether this registry was built from `mcp` (lets hot-reload skip a
    /// needless reconnect when the `[mcp.*]` section is unchanged).
    pub(crate) fn matches_config(&self, mcp: &BTreeMap<String, McpServerConfig>) -> bool {
        &self.source == mcp
    }

    /// Tool defs whose full name matches any allowlist `patterns` (exact or
    /// `mcp__server__*` glob), in pinned sorted order. Shaped for the outbound
    /// LLM `tools` array.
    pub(crate) fn tool_defs_filtered(&self, patterns: &[String]) -> Vec<Value> {
        self.tools
            .iter()
            .filter(|t| {
                patterns
                    .iter()
                    .any(|p| tool_pattern_matches(p, &t.full_name))
            })
            .map(McpToolDef::to_tool_json)
            .collect()
    }

    /// Tools whose full name matches any of `patterns`. Used to expand a
    /// sub-agent's `tools = ["mcp__hue__*"]` grant against the live surface.
    pub(crate) fn names_matching(&self, patterns: &[String]) -> Vec<&McpToolDef> {
        self.tools
            .iter()
            .filter(|t| {
                patterns
                    .iter()
                    .any(|p| tool_pattern_matches(p, &t.full_name))
            })
            .collect()
    }

    /// Invoke `full_name` (an `mcp__server__tool`) with `args`. Resolves the
    /// server/tool via the pinned tool list (robust to `__` inside names) and
    /// routes to the live client.
    pub(crate) async fn call(&self, full_name: &str, args: Value) -> Result<Value, ToolError> {
        let def = self
            .tools
            .iter()
            .find(|t| t.full_name == full_name)
            .ok_or_else(|| ToolError::NotImplemented(full_name.to_owned()))?;
        let client = self
            .clients
            .get(&def.server)
            .ok_or_else(|| ToolError::NotImplemented(full_name.to_owned()))?;
        client
            .call(&def.tool, args)
            .await
            .map_err(|e| ToolError::Http(e.to_string()))
    }

    /// Shut down every connection (drains stdio child processes).
    pub(crate) async fn shutdown(self) {
        for (_name, client) in self.clients {
            client.shutdown().await;
        }
    }
}

/// Convert a config entry into a connection spec, resolving relative stdio
/// paths against `plugins_dir` (`<data>/plugins/`). Returns `None` if no
/// transport is set (config validation rejects this, but stay defensive).
///
/// - `cwd`: relative resolves against `plugins_dir`, so `cwd = "hue-mcp"` means
///   `<data>/plugins/hue-mcp` no matter where the daemon was started from.
/// - `command`: a bare name (`node`, `npx`) is left alone for `PATH` lookup; a
///   relative path (`./venv/bin/python`) resolves against the resolved `cwd`,
///   falling back to `plugins_dir` when `cwd` is unset. Resolving it here is
///   required, not cosmetic: `Command::current_dir` does *not* define whether a
///   relative program path resolves against the parent's cwd or the child's.
/// - `args` are left verbatim — they are the server's own, and the child
///   already resolves them against its `cwd`.
fn to_spec(name: &str, cfg: &McpServerConfig, plugins_dir: &Path) -> Option<McpServerSpec> {
    let transport = if let Some(command) = &cfg.command {
        let cwd = cfg.cwd.as_ref().map(|dir| resolve_under(dir, plugins_dir));
        let command_base = cwd.as_deref().unwrap_or(plugins_dir);
        Transport::Stdio {
            command: resolve_command(command, command_base),
            args: cfg.args.clone(),
            env: cfg.env.clone(),
            cwd: cwd.map(|dir| dir.to_string_lossy().into_owned()),
        }
    } else if let Some(url) = &cfg.url {
        Transport::Http { url: url.clone() }
    } else {
        return None;
    };
    Some(McpServerSpec {
        name: name.to_owned(),
        transport,
    })
}

/// Resolve `raw` against `base`, leaving absolute paths untouched. Bare `.`
/// components are dropped so a `./`-prefixed entry doesn't produce a
/// `<base>/./x` path in logs; `..` and symlinks are left for the OS to resolve.
fn resolve_under(raw: &str, base: &Path) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        return path.to_path_buf();
    }
    let mut resolved = base.to_path_buf();
    for component in path.components() {
        if !matches!(component, std::path::Component::CurDir) {
            resolved.push(component);
        }
    }
    resolved
}

/// Resolve a configured `command`. A bare name with no path separator stays a
/// `PATH` lookup; anything path-shaped resolves against `base`.
fn resolve_command(command: &str, base: &Path) -> String {
    if !command.contains('/') && !command.contains(std::path::MAIN_SEPARATOR) {
        return command.to_owned();
    }
    resolve_under(command, base).to_string_lossy().into_owned()
}

#[cfg(test)]
impl McpToolDef {
    /// Build a tool def for tests (no live connection).
    pub(crate) fn new_for_test(server: &str, tool: &str) -> Self {
        Self {
            full_name: format!("mcp__{server}__{tool}"),
            description: format!("{tool} tool"),
            input_schema: json!({"type": "object"}),
            server: server.to_owned(),
            tool: tool.to_owned(),
        }
    }
}

#[cfg(test)]
impl McpRegistry {
    /// Build a registry from hand-made tool defs (no live clients), sorted like
    /// the real `from_config`.
    pub(crate) fn from_tools_for_test(mut tools: Vec<McpToolDef>) -> Self {
        tools.sort_by(|a, b| a.full_name.cmp(&b.full_name));
        Self {
            clients: BTreeMap::new(),
            tools,
            source: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> McpRegistry {
        McpRegistry::from_tools_for_test(vec![
            McpToolDef::new_for_test("hue", "on"),
            McpToolDef::new_for_test("hue", "off"),
            McpToolDef::new_for_test("nanoleaf", "scene"),
        ])
    }

    #[test]
    fn tool_defs_filtered_globs_and_stays_sorted() {
        let r = registry();
        let names: Vec<String> = r
            .tool_defs_filtered(&["mcp__hue__*".to_owned()])
            .iter()
            .map(|d| d["name"].as_str().unwrap().to_owned())
            .collect();
        // Sorted by full name (off < on); the nanoleaf tool is excluded.
        assert_eq!(names, vec!["mcp__hue__off", "mcp__hue__on"]);
    }

    #[test]
    fn tool_defs_filtered_exact_wildcard_and_empty() {
        let r = registry();
        assert_eq!(r.tool_defs_filtered(&["mcp__hue__on".to_owned()]).len(), 1);
        assert_eq!(r.tool_defs_filtered(&["mcp__*".to_owned()]).len(), 3);
        assert!(r.tool_defs_filtered(&[]).is_empty());
    }

    #[test]
    fn tool_defs_filtered_is_stable_across_calls() {
        let r = registry();
        let a = r.tool_defs_filtered(&["mcp__*".to_owned()]);
        let b = r.tool_defs_filtered(&["mcp__*".to_owned()]);
        assert_eq!(a, b, "tool surface must be byte-stable for cache reuse");
    }

    #[test]
    fn names_matching_expands_server_glob() {
        let r = registry();
        let matched = r.names_matching(&["mcp__hue__*".to_owned()]);
        assert_eq!(matched.len(), 2);
        assert!(matched.iter().all(|t| t.server == "hue"));
    }

    #[tokio::test]
    async fn call_unknown_or_unconnected_tool_is_not_implemented() {
        let r = registry();
        // Name not in the surface at all.
        assert!(matches!(
            r.call("mcp__hue__missing", json!({})).await,
            Err(ToolError::NotImplemented(_))
        ));
        // Known def but no live client (test registry has none).
        assert!(matches!(
            r.call("mcp__hue__on", json!({})).await,
            Err(ToolError::NotImplemented(_))
        ));
    }

    #[test]
    fn matches_config_detects_changes() {
        let r = registry();
        assert!(r.matches_config(&BTreeMap::new()));
        let mut changed = BTreeMap::new();
        let _ = changed.insert(
            "hue".to_owned(),
            McpServerConfig {
                command: Some("node".to_owned()),
                args: vec![],
                env: BTreeMap::new(),
                cwd: None,
                url: None,
            },
        );
        assert!(!r.matches_config(&changed));
    }

    fn stdio_cfg(command: &str, cwd: Option<&str>) -> McpServerConfig {
        McpServerConfig {
            command: Some(command.to_owned()),
            args: vec!["dist/index.js".to_owned()],
            env: BTreeMap::new(),
            cwd: cwd.map(str::to_owned),
            url: None,
        }
    }

    /// Destructure a stdio spec into `(command, args, cwd)`.
    fn stdio_parts(spec: &McpServerSpec) -> (&str, &[String], Option<&str>) {
        match &spec.transport {
            Transport::Stdio {
                command, args, cwd, ..
            } => (command, args, cwd.as_deref()),
            Transport::Http { .. } => panic!("expected stdio transport"),
        }
    }

    fn plugins() -> PathBuf {
        PathBuf::from("/data/shore/plugins")
    }

    #[test]
    fn relative_cwd_resolves_under_plugins_dir() {
        let cfg = stdio_cfg("node", Some("hue-mcp"));
        let spec = to_spec("hue", &cfg, &plugins()).expect("spec");
        let (command, args, cwd) = stdio_parts(&spec);
        assert_eq!(cwd, Some("/data/shore/plugins/hue-mcp"));
        // A bare command stays a `PATH` lookup, and args are passed verbatim.
        assert_eq!(command, "node");
        assert_eq!(args, ["dist/index.js"]);
    }

    #[test]
    fn absolute_cwd_is_left_alone() {
        let cfg = stdio_cfg("node", Some("/srv/hue-mcp"));
        let spec = to_spec("hue", &cfg, &plugins()).expect("spec");
        assert_eq!(stdio_parts(&spec).2, Some("/srv/hue-mcp"));
    }

    #[test]
    fn relative_command_resolves_against_resolved_cwd() {
        let cfg = stdio_cfg("./venv/bin/python", Some("notes"));
        let spec = to_spec("notes", &cfg, &plugins()).expect("spec");
        assert_eq!(
            stdio_parts(&spec).0,
            "/data/shore/plugins/notes/venv/bin/python"
        );
    }

    #[test]
    fn relative_command_without_cwd_resolves_against_plugins_dir() {
        let cfg = stdio_cfg("notes/server.sh", None);
        let spec = to_spec("notes", &cfg, &plugins()).expect("spec");
        let (command, _args, cwd) = stdio_parts(&spec);
        assert_eq!(command, "/data/shore/plugins/notes/server.sh");
        // No `cwd` configured stays no `cwd` — the child inherits the daemon's.
        assert_eq!(cwd, None);
    }

    #[test]
    fn absolute_command_is_left_alone() {
        let cfg = stdio_cfg("/usr/bin/node", Some("hue-mcp"));
        let spec = to_spec("hue", &cfg, &plugins()).expect("spec");
        assert_eq!(stdio_parts(&spec).0, "/usr/bin/node");
    }

    #[test]
    fn http_transport_ignores_plugins_dir() {
        let cfg = McpServerConfig {
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            cwd: Some("ignored".to_owned()),
            url: Some("http://localhost:9123/sse".to_owned()),
        };
        let spec = to_spec("docs", &cfg, &plugins()).expect("spec");
        assert!(
            matches!(spec.transport, Transport::Http { url } if url == "http://localhost:9123/sse")
        );
    }

    /// Path to the in-tree `daemon_mcp_stub_server` bin. `CARGO_BIN_EXE_*` is
    /// only set for integration tests, so derive it from this test binary's own
    /// location (`target/<profile>/deps/<test>` ->
    /// `target/<profile>/daemon_mcp_stub_server`).
    fn stub_server_bin() -> PathBuf {
        let exe = std::env::current_exe().expect("test exe path");
        let bin = exe
            .parent()
            .and_then(Path::parent)
            .expect("target/<profile> dir")
            .join("daemon_mcp_stub_server");
        assert!(bin.exists(), "stub server not built at {}", bin.display());
        bin
    }

    /// End-to-end: a server installed under the plugins directory and
    /// configured purely with relative paths actually spawns and lists tools.
    /// Covers what the string-level tests above cannot — that a relative
    /// `command` is resolved before spawn rather than left to the child's cwd.
    #[tokio::test]
    async fn relative_paths_connect_a_real_server_under_plugins_dir() {
        let plugins = tempfile::tempdir().expect("tempdir");
        let install = plugins.path().join("stub-server");
        std::fs::create_dir_all(&install).expect("create install dir");
        let _bytes =
            std::fs::copy(stub_server_bin(), install.join("server")).expect("install stub binary");

        let mut mcp = BTreeMap::new();
        let _existing = mcp.insert(
            "stub".to_owned(),
            McpServerConfig {
                command: Some("./server".to_owned()),
                args: vec![],
                env: BTreeMap::new(),
                cwd: Some("stub-server".to_owned()),
                url: None,
            },
        );

        let registry = McpRegistry::from_config(&mcp, plugins.path()).await;
        let names: Vec<String> = registry
            .tool_defs_filtered(&["mcp__*".to_owned()])
            .iter()
            .map(|d| d["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, vec!["mcp__stub__echo"]);

        registry.shutdown().await;
    }
}
