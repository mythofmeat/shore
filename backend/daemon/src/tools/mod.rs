pub mod activity;
pub mod basic;
pub(crate) mod context;
pub mod history;
pub mod images;
pub mod mcp_registry;
pub mod model_history;
pub(crate) mod subagent;
pub mod web;
pub mod workspace;

use crate::autonomy::manager::AutonomyManager;
use crate::memory::compaction_impls::ImageGenConfig;
use serde_json::Value;
use shore_config::app::{RetrievalConfig, RetrievalMode};
use shore_llm::embed::Embedder;
use shore_llm::LlmClient;
use std::future::Future;
use std::pin::Pin;

// ---------------------------------------------------------------------------
// Tool category — coarse capability grouping
// ---------------------------------------------------------------------------

/// Tool categories for coarse routing and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCategory {
    /// Web/HTTP tools — always available.
    Web,
    /// Other tools (filesystem, history, dice, time, activity).
    Other,
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/// Static definition of a tool (name, description, JSON Schema, category).
#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
    pub category: ToolCategory,
}

// ---------------------------------------------------------------------------
// Tool error
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid args: {0}")]
    InvalidArgs(String),
    #[error("{0}: not yet implemented")]
    NotImplemented(String),
    #[error("io: {0}")]
    Io(String),
    #[error("http: {0}")]
    Http(String),
}

// ---------------------------------------------------------------------------
// Tool context trait — dependency injection for tool handlers
// ---------------------------------------------------------------------------

/// Provides access to shared dependencies needed by tool handlers.
///
/// Requires `Sync` so that `&dyn ToolContext` is `Send`, enabling tool handlers
/// to hold the reference across `.await` points in `Send` futures.
pub trait ToolContext: Sync {
    fn image_dir(&self) -> &str;
    fn llm_client(&self) -> Option<&LlmClient>;
    fn image_gen_config(&self) -> Option<&ImageGenConfig>;

    // Web search configuration
    fn search_config(&self) -> &shore_config::app::SearchConfig;

    // Autonomy access — used by activity heatmap tool
    fn autonomy_manager(&self) -> Option<&AutonomyManager> {
        None
    }
    #[expect(
        clippy::unnecessary_literal_bound,
        reason = "real ToolContext implementations return character names borrowed from self"
    )]
    fn character_name(&self) -> &str {
        ""
    }
    fn schedule_next_wake(&self, _input: &Value) -> Option<Result<Value, ToolError>> {
        None
    }

    // Workspace directory for general filesystem tools
    #[expect(
        clippy::unnecessary_literal_bound,
        reason = "real ToolContext implementations return workspace paths borrowed from self"
    )]
    fn workspace_dir(&self) -> &str {
        ""
    }

    // Character data directory for conversation history search.
    #[expect(
        clippy::unnecessary_literal_bound,
        reason = "real ToolContext implementations return data paths borrowed from self"
    )]
    fn character_data_dir(&self) -> &str {
        ""
    }

    // Markdown memory store for inspectable memory files
    fn markdown_store(&self) -> Option<&crate::memory::markdown_store::MarkdownMemoryStore> {
        None
    }

    // Memory retrieval configuration and optional embedding profile. The
    // embedding index is non-authoritative; markdown files remain the source
    // of truth.
    fn memory_retrieval_config(&self) -> &RetrievalConfig {
        static DEFAULT: std::sync::OnceLock<RetrievalConfig> = std::sync::OnceLock::new();
        DEFAULT.get_or_init(RetrievalConfig::default)
    }
    fn embedder(&self) -> Option<&dyn Embedder> {
        None
    }
    fn memory_index_path(&self) -> Option<&std::path::Path> {
        None
    }

    // Config directory for deferred character self-edits
    #[expect(
        clippy::unnecessary_literal_bound,
        reason = "real ToolContext implementations return config paths borrowed from self"
    )]
    fn config_dir(&self) -> &str {
        ""
    }

    /// Queue a deferred edit for a prompt-visible workspace file. Called by
    /// the tool dispatch layer after a successful write or edit to a path
    /// whose content should only become prompt-active at the next compaction
    /// boundary.
    fn defer_edit(&self, _path: &str) {}

    /// Run a configured sub-agent (`ask_<name>`) and return its final text as
    /// a JSON string value.
    ///
    /// Default: unavailable — only the chat tool context wires a sub-agent
    /// runtime. The `NotImplemented` default is also the recursion cap: a
    /// sub-agent's own tool loop runs against a context that does not override
    /// this, so it can never delegate further (see the `subagent` module).
    fn run_subagent<'ctx>(
        &'ctx self,
        name: &'ctx str,
        query: &'ctx str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send + 'ctx>> {
        let _ = query;
        Box::pin(async move { Err(ToolError::NotImplemented(format!("ask_{name}"))) })
    }

    /// Read access to the usage ledger for provenance queries
    /// (`model_history`). Default: unavailable — only contexts that carry a
    /// ledger handle (chat and background paths) override this; compaction
    /// and bare test contexts return `None` and the tool reports itself
    /// unavailable instead of panicking.
    fn ledger(&self) -> Option<&shore_ledger::Ledger> {
        None
    }

    /// Invoke an MCP tool (`mcp__<server>__<tool>`) and return its result.
    ///
    /// Default: unavailable — only contexts wired with an MCP registry override
    /// this. Like [`run_subagent`](Self::run_subagent), the `NotImplemented`
    /// default keeps unconfigured/background contexts inert.
    fn mcp_call<'ctx>(
        &'ctx self,
        name: &'ctx str,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send + 'ctx>> {
        let _ = input;
        Box::pin(async move { Err(ToolError::NotImplemented(name.to_owned())) })
    }
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/// Returns all registered tool definitions.
pub fn all_tools() -> Vec<ToolDef> {
    let mut tools = Vec::new();
    tools.extend(images::tool_defs());
    tools.extend(web::tool_defs());
    tools.extend(activity::tool_defs());
    tools.extend(basic::tool_defs());
    tools.extend(workspace::tool_defs());
    tools.extend(history::tool_defs());
    tools.extend(model_history::tool_defs());
    tools
}

/// Build the outbound LLM `tools` array from `available_tools`, rendering
/// `{{char}}` / `{{user}}` placeholders in each tool's description through
/// the same template pipeline the system prompt uses.
///
/// Centralizes what was previously duplicated at every call site (handler +
/// autonomy manager) and guarantees that `{{user}}` in a description
/// actually substitutes instead of shipping literally to the model.
pub fn render_tool_defs(
    tools_cfg: &shore_config::app::ToolsConfig,
    char_name: &str,
    user_name: &str,
) -> Vec<Value> {
    use std::collections::HashMap;
    let mut vars: HashMap<String, String> = HashMap::new();
    let _ignored = vars.insert("char".into(), char_name.to_owned());
    _ = vars.insert("character_name".into(), char_name.to_owned());
    _ = vars.insert("user".into(), user_name.to_owned());
    available_tools(tools_cfg)
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": crate::engine::prompt::render_template(t.description, &vars),
                "input_schema": t.parameters.clone(),
            })
        })
        .collect()
}

/// Returns tool definitions offered for the `enabled_tools` allowlist. Tools
/// are opt-in: only names present in `tools_cfg.enabled_tools` are offered.
pub fn available_tools(tools_cfg: &shore_config::app::ToolsConfig) -> Vec<ToolDef> {
    all_tools()
        .into_iter()
        .filter(|t| tools_cfg.tool_enabled(t.name))
        .collect()
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

fn default_search_mode(ctx: &dyn ToolContext, index_path_available: bool) -> &'static str {
    match ctx.memory_retrieval_config().mode {
        RetrievalMode::Lexical => "lexical",
        RetrievalMode::Hybrid => "hybrid",
        RetrievalMode::Auto => {
            if ctx.embedder().is_some() && index_path_available {
                "hybrid"
            } else {
                "lexical"
            }
        }
    }
}

fn apply_default_search_mode(input: &mut Value, ctx: &dyn ToolContext, index_path_available: bool) {
    if input.get("mode").is_some() {
        return;
    }
    if let Some(obj) = input.as_object_mut() {
        let _ignored = obj.insert(
            "mode".into(),
            serde_json::json!(default_search_mode(ctx, index_path_available)),
        );
    }
}

/// Annotate a workspace-mutation result when the target is a prompt-visible
/// file: register the deferred edit with the context and flag the result so
/// the model learns the write won't reach the prompt until compaction.
fn annotate_deferred_edit(path: &str, result: &mut Value, ctx: &dyn ToolContext) {
    let Some(deferred_path) = crate::memory::deferred_edits::normalize_prompt_visible_path(path)
    else {
        return;
    };
    ctx.defer_edit(path);
    if let Some(obj) = result.as_object_mut() {
        let _ignored = obj.insert("prompt_visible_file".into(), serde_json::json!(true));
        if crate::memory::deferred_edits::normalize_protected_path(path).is_some() {
            _ = obj.insert("protected_file".into(), serde_json::json!(true));
        }
        _ = obj.insert("deferred_until_compaction".into(), serde_json::json!(true));
        _ = obj.insert("deferred_path".into(), serde_json::json!(deferred_path));
        _ = obj.insert("prompt_reload_required".into(), serde_json::json!(true));
    }
}

/// Dispatch a tool call by name to its handler.
pub fn dispatch_tool<'ctx>(
    name: &'ctx str,
    mut input: Value,
    ctx: &'ctx dyn ToolContext,
) -> Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send + 'ctx>> {
    Box::pin(async move {
        match name {
            "search_chat_logs" => history::handle_search_history(&input, ctx),
            "model_history" => model_history::handle_model_history(&input, ctx),
            "generate_image" => images::handle_generate_image(input, ctx).await,
            // Web tools
            "web_search" => web::handle_web_search(input, ctx).await,
            "fetch_url" => web::handle_fetch_url(input).await,
            // Basic tools
            "roll_dice" => basic::handle_roll_dice(&input),
            // Other
            "activity_heatmap" => activity::handle_activity_heatmap(&input, ctx),
            // Workspace tools
            "read" => workspace::handle_read(input, ctx.workspace_dir()).await,
            "edit" => {
                let path = input
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned();
                let mut result = workspace::handle_edit(input, ctx.workspace_dir()).await?;
                annotate_deferred_edit(&path, &mut result, ctx);
                Ok(result)
            }
            "search" => {
                let index_path = ctx.memory_index_path();
                apply_default_search_mode(&mut input, ctx, index_path.is_some());
                workspace::handle_search(
                    input,
                    ctx.workspace_dir(),
                    Some(ctx.memory_retrieval_config()),
                    ctx.embedder(),
                    index_path,
                )
                .await
            }
            "delete" => {
                workspace::handle_delete(input, ctx.workspace_dir(), ctx.character_data_dir()).await
            }
            "git" => workspace::handle_git(input, ctx.workspace_dir(), ctx.character_name()).await,
            // set_next_wake is an undeclared, heartbeat-only capability: the
            // heartbeat loop intercepts it before dispatch (see
            // `dispatch_heartbeat_tools`). This arm only fires if some other
            // context dispatches the name, and rejects it there.
            "set_next_wake" => ctx.schedule_next_wake(&input).unwrap_or_else(|| {
                Err(ToolError::InvalidArgs(
                    "set_next_wake is only available during heartbeat ticks".into(),
                ))
            }),
            // Sub-agent delegation: `ask_<name>` routes to the wired runtime.
            _ => {
                if let Some(agent) = name.strip_prefix("ask_") {
                    let query = input.get("query").and_then(Value::as_str).ok_or_else(|| {
                        ToolError::InvalidArgs(format!("{name} requires a string `query`"))
                    })?;
                    ctx.run_subagent(agent, query).await
                } else if name.starts_with("mcp__") {
                    // Dynamic MCP tool: route to the wired registry.
                    ctx.mcp_call(name, input).await
                } else {
                    Err(ToolError::NotImplemented(name.to_owned()))
                }
            }
        }
    })
}

/// Synthesize the `ask_<name>` tool defs for the configured sub-agents,
/// rendering `{{char}}` / `{{user}}` in each description.
///
/// Returned as raw outbound JSON (not [`ToolDef`], which is `&'static`) and
/// appended after [`render_tool_defs`] in the request-build path. Ordering
/// follows the config's `BTreeMap`, so the tool surface — and thus the cache
/// prefix — stays stable across turns.
pub fn subagent_tool_defs(
    subagents: &std::collections::BTreeMap<String, shore_config::app::SubagentConfig>,
    enabled: &[String],
    char_name: &str,
    user_name: &str,
) -> Vec<Value> {
    use std::collections::HashMap;
    let mut vars: HashMap<String, String> = HashMap::new();
    let _ = vars.insert("char".into(), char_name.to_owned());
    let _ = vars.insert("character_name".into(), char_name.to_owned());
    let _ = vars.insert("user".into(), user_name.to_owned());
    subagents
        .iter()
        .filter(|(name, _)| enabled.iter().any(|e| e == *name))
        .map(|(name, spec)| {
            serde_json::json!({
                "name": format!("ask_{name}"),
                "description": crate::engine::prompt::render_template(&spec.description, &vars),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language request for this sub-agent.",
                        }
                    },
                    "required": ["query"],
                },
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestToolContext;
    use shore_config::app::ToolsConfig;

    /// A `ToolsConfig` with every registered tool in the allowlist.
    fn all_enabled() -> ToolsConfig {
        ToolsConfig {
            enabled_tools: all_tools().iter().map(|t| t.name.to_owned()).collect(),
            ..ToolsConfig::default()
        }
    }

    #[test]
    fn render_tool_defs_substitutes_user_placeholder() {
        // {{user}} opens activity_heatmap's description and must resolve, not
        // ship literal to the model.
        let cfg = all_enabled();
        let defs = render_tool_defs(&cfg, "qifei", "ren");
        let heatmap = defs
            .iter()
            .find(|d| d["name"] == "activity_heatmap")
            .expect("activity_heatmap present");
        let desc = heatmap["description"].as_str().unwrap();
        assert!(
            !desc.contains("{{user}}"),
            "{{{{user}}}} must be substituted, got: {desc}"
        );
        assert!(
            desc.starts_with("View ren's activity heatmap"),
            "substituted name 'ren' must appear in description, got: {desc}"
        );
    }

    #[test]
    fn render_tool_defs_substitutes_char_placeholder() {
        // Future-proof guard: {{char}} also resolves through render_tool_defs.
        let cfg = all_enabled();
        let defs = render_tool_defs(&cfg, "qifei", "ren");
        for def in &defs {
            let desc = def["description"].as_str().unwrap();
            assert!(
                !desc.contains("{{char}}") && !desc.contains("{{user}}"),
                "tool {} has unsubstituted placeholder: {desc}",
                def["name"]
            );
        }
    }

    #[test]
    fn test_all_tools_returns_expected_count() {
        let tools = all_tools();
        // images(1) + web(2) + activity(1) + basic(1) + workspace(5) + history(1)
        // + model_history(1) = 12
        // (basic = roll_dice; set_next_wake is undeclared — see basic.rs)
        // (workspace = read, edit, search, delete, git — read absorbs listing,
        //  edit absorbs whole-file writes, git replaces exec)
        assert_eq!(tools.len(), 12);
    }

    #[test]
    fn enabled_tools_allowlist_offers_only_listed() {
        // Opt-in: only the listed tools are offered, in registry order.
        let cfg = ToolsConfig {
            enabled_tools: vec![
                "search".to_owned(),
                "search_chat_logs".to_owned(),
                "git".to_owned(),
            ],
            ..ToolsConfig::default()
        };
        let tools = available_tools(&cfg);
        let names: Vec<&str> = tools.iter().map(|t| t.name).collect();

        assert!(names.contains(&"search"));
        assert!(names.contains(&"search_chat_logs"));
        assert!(names.contains(&"git"));
        // Not listed → not offered.
        assert!(!names.contains(&"roll_dice"));
        assert!(!names.contains(&"web_search"));
        assert_eq!(tools.len(), 3);
    }

    #[test]
    fn empty_allowlist_offers_nothing() {
        let cfg = ToolsConfig::default();
        assert!(available_tools(&cfg).is_empty());
    }

    #[test]
    fn unknown_allowlist_names_are_harmless() {
        // A name that isn't a registered tool simply matches nothing.
        let cfg = ToolsConfig {
            enabled_tools: vec!["read".to_owned(), "not_a_tool".to_owned()],
            ..ToolsConfig::default()
        };
        let names: Vec<&str> = available_tools(&cfg).iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["read"]);
    }

    #[test]
    fn test_tool_names_unique() {
        let tools = all_tools();
        let mut names: Vec<&str> = tools.iter().map(|t| t.name).collect();
        let original_len = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), original_len, "duplicate tool names found");
    }

    // ── dispatch_tool tests ───────────────────────────────────────────

    /// The tools folded away in the tool-surface simplification: `write` and
    /// `list_files` were absorbed into `edit`/`read`, `check_time` is served by
    /// the injected time marker, and `exec` gave way to the narrower `git`.
    /// None may quietly come back as a dispatch arm.
    #[tokio::test]
    async fn test_dispatch_retired_tools_are_not_implemented() {
        let ctx = TestToolContext::new();
        for name in ["write", "list_files", "check_time", "exec"] {
            let result = dispatch_tool(name, serde_json::json!({}), &ctx).await;
            assert!(
                matches!(result, Err(ToolError::NotImplemented(_))),
                "retired tool '{name}' must not dispatch"
            );
        }
    }

    #[tokio::test]
    async fn test_dispatch_roll_dice() {
        let ctx = TestToolContext::new();
        let result = dispatch_tool("roll_dice", serde_json::json!({"notation": "2d6"}), &ctx).await;
        assert!(result.is_ok(), "roll_dice should succeed");
    }

    #[tokio::test]
    async fn test_dispatch_unknown_tool() {
        let ctx = TestToolContext::new();
        let result = dispatch_tool("nonexistent_tool", serde_json::json!({}), &ctx).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, ToolError::NotImplemented(_)),
            "unknown tool should return NotImplemented, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_dispatch_fetch_url_routes_correctly() {
        let ctx = TestToolContext::new();
        // Invalid URL — handler should return an error (not NotImplemented).
        let result = dispatch_tool(
            "fetch_url",
            serde_json::json!({"url": "not-a-valid-url"}),
            &ctx,
        )
        .await;
        // May succeed or fail, but should NOT be NotImplemented.
        if let Err(ref e) = result {
            assert!(
                !matches!(e, ToolError::NotImplemented(_)),
                "fetch_url should reach handler"
            );
        }
    }

    #[tokio::test]
    async fn test_dispatch_search_auto_without_embedder_uses_lexical() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::write(ws.join("notes.md"), "tea time")
            .await
            .unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let ctx = TestToolContext::new().with_workspace_dir(&ws_str);

        let result = dispatch_tool("search", serde_json::json!({"query": "tea"}), &ctx)
            .await
            .unwrap();

        assert_eq!(result["mode"], "lexical");
        assert!(result.get("semantic_unavailable").is_none());
    }

    #[tokio::test]
    async fn test_dispatch_search_respects_lexical_retrieval_config() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        tokio::fs::write(ws.join("notes.md"), "tea time")
            .await
            .unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let ctx = TestToolContext::new()
            .with_workspace_dir(&ws_str)
            .with_retrieval_config(RetrievalConfig {
                mode: RetrievalMode::Lexical,
                ..Default::default()
            });

        let result = dispatch_tool("search", serde_json::json!({"query": "tea"}), &ctx)
            .await
            .unwrap();

        assert_eq!(result["mode"], "lexical");
        assert!(result.get("semantic_unavailable").is_none());
    }

    #[tokio::test]
    async fn test_dispatch_removed_memory_tool_is_not_implemented() {
        let ctx = TestToolContext::new();
        let result =
            dispatch_tool("memory_search", serde_json::json!({"query": "tea"}), &ctx).await;
        assert!(matches!(result, Err(ToolError::NotImplemented(_))));
    }

    #[tokio::test]
    async fn test_dispatch_history_search_routes_without_memory_gate() {
        let ctx = TestToolContext::new();
        let result = dispatch_tool(
            "search_chat_logs",
            serde_json::json!({"query": "tea"}),
            &ctx,
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidArgs(_)),
            "missing history config should return InvalidArgs, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_dispatch_allows_memory_namespace_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let ctx = TestToolContext::new().with_workspace_dir(&ws_str);

        let result = dispatch_tool(
            "edit",
            serde_json::json!({"path": "memory/people/ren.md", "content": "Ren likes tea."}),
            &ctx,
        )
        .await
        .unwrap();
        assert_eq!(result["bytes_written"], 14);

        let read_result = dispatch_tool(
            "read",
            serde_json::json!({"path": "memory/people/ren.md"}),
            &ctx,
        )
        .await;
        assert!(read_result.is_ok());
    }

    #[tokio::test]
    async fn test_dispatch_all_registered_names_route() {
        let ctx = TestToolContext::new();
        let tools = all_tools();

        for tool in &tools {
            let result = dispatch_tool(tool.name, serde_json::json!({}), &ctx).await;
            // Every registered tool name should route to a handler.
            // The handler may succeed or fail with InvalidArgs/Agent/etc,
            // but must NOT return NotImplemented.
            if let Err(ref e) = result {
                assert!(
                    !matches!(e, ToolError::NotImplemented(_)),
                    "registered tool '{}' returned NotImplemented — dispatch arm missing",
                    tool.name
                );
            }
        }
    }

    fn sample_subagents() -> std::collections::BTreeMap<String, shore_config::app::SubagentConfig> {
        let mut map = std::collections::BTreeMap::new();
        let _ = map.insert(
            "music".to_owned(),
            shore_config::app::SubagentConfig {
                description: "Ask {{char}}'s music assistant.".to_owned(),
                prompt: "You help {{user}} with music.".to_owned(),
                tools: vec!["search".to_owned()],
                model: None,
                max_iterations: None,
            },
        );
        map
    }

    #[test]
    fn subagent_tool_defs_shape_and_templating() {
        let enabled = vec!["music".to_owned()];
        let defs = subagent_tool_defs(&sample_subagents(), &enabled, "qifei", "ren");
        assert_eq!(defs.len(), 1);
        let def = &defs[0];
        assert_eq!(def["name"], "ask_music");
        // {{char}} substituted, not shipped literal.
        let desc = def["description"].as_str().unwrap();
        assert!(
            desc.contains("qifei") && !desc.contains("{{char}}"),
            "{desc}"
        );
        // Single required `query` string param.
        assert_eq!(def["input_schema"]["properties"]["query"]["type"], "string");
        assert_eq!(def["input_schema"]["required"][0], "query");
    }

    #[tokio::test]
    async fn dispatch_ask_without_runtime_is_not_implemented() {
        // TestToolContext uses the trait-default `run_subagent`, which is the
        // recursion cap and the no-runtime fallback.
        let ctx = TestToolContext::new();
        let result = dispatch_tool("ask_music", serde_json::json!({"query": "hi"}), &ctx).await;
        assert!(matches!(result, Err(ToolError::NotImplemented(_))));
    }

    #[tokio::test]
    async fn dispatch_ask_missing_query_is_invalid_args() {
        let ctx = TestToolContext::new();
        let result = dispatch_tool("ask_music", serde_json::json!({}), &ctx).await;
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
    }

    #[tokio::test]
    async fn dispatch_mcp_without_registry_is_not_implemented() {
        // The `mcp__*` dispatch arm routes to `mcp_call`, whose trait default
        // (no wired registry) returns NotImplemented — the no-runtime fallback.
        let ctx = TestToolContext::new();
        let result = dispatch_tool("mcp__hue__on", serde_json::json!({}), &ctx).await;
        assert!(matches!(result, Err(ToolError::NotImplemented(_))));
    }
}
