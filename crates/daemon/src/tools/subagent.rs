//! Sub-agent delegation runtime.
//!
//! A `[subagents.<name>]` config entry surfaces to the primary model as a
//! single `ask_<name>(query)` tool. Invoking it runs a *nested* tool loop on a
//! (typically cheaper) model over a subset of the in-process tools, then
//! returns only the agent's final text. The bulky intermediate tool results
//! never enter the primary model's context, and the primary model's tool
//! surface stays small — that's the cost/compression win (see issue #35).
//!
//! Nesting is hard-capped at one level: the nested loop runs against
//! [`SubagentGuardContext`], whose `run_subagent` falls back to the trait
//! default (`NotImplemented`), so a sub-agent can never invoke another. The
//! offered tool subset also never contains `ask_*`, so a well-behaved model
//! has no `ask_*` affordance in the first place — the guard only defends
//! against a hallucinated call.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::ledger::{CallType, LedgerClient};
use crate::llm::stream::StreamConsumer;
use crate::llm::types::LlmRequest;
use serde_json::{json, Value};
use shore_common::config::app::SubagentConfig;
use shore_common::config::models::ResolvedModel;
use shore_common::config::LoadedConfig;
use shore_common::diagnostics::Diagnostics;
use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::{ContentBlock, Message, Role};
use tokio::sync::mpsc;

/// Maximum messages a single `{{active_history: n}}` expansion may include, and
/// the cap on the conversation tail cloned into [`SubagentRuntime`]. Bounds both
/// the per-turn clone and the rendered transcript size.
pub(crate) const MAX_HISTORY_MESSAGES: usize = 100;

use super::context::SharedToolContext;
use super::{ToolContext, ToolError};
use crate::engine::tools::{run_tool_loop, ToolLoopRetry};

/// Per-turn dependencies a [`SharedToolContext`] needs to run a sub-agent.
///
/// The chat generation path populates this with a live client channel. The
/// heartbeat and dreaming background paths populate it via
/// [`SubagentRuntime::background`] (no client channel — frames drain). Only
/// compaction leaves it `None`, so calling `ask_*` there returns
/// `NotImplemented` rather than panicking.
pub(crate) struct SubagentRuntime {
    /// Ledger-wrapped client so sub-agent spend is recorded and attributable
    /// (initial stream tagged [`CallType::Subagent`]).
    pub(crate) ledger_client: LedgerClient,
    /// Diagnostics sink threaded into the nested tool loop.
    pub(crate) diagnostics: Arc<Mutex<Diagnostics>>,
    /// The effective config for this character — sub-agent specs, the model
    /// catalog/providers for resolution, and tool-loop knobs.
    pub(crate) config: Arc<LoadedConfig>,
    /// The live client channel for this turn. The sub-agent's nested tool-loop
    /// frames are forwarded here, tagged with the sub-agent name, so the UI can
    /// show the nested loop instead of appearing frozen. Intermediate tool
    /// *results* still never enter the primary model's context — this is a
    /// client-side view only.
    ///
    /// `None` for background contexts (heartbeat, dreaming): there is no live
    /// client turn to stream into, so the nested loop's frames are drained and
    /// dropped rather than forwarded. The sub-agent still runs and returns its
    /// summary.
    pub(crate) direct_tx: Option<mpsc::Sender<ServerMessage>>,
    /// A bounded tail (≤ [`MAX_HISTORY_MESSAGES`]) of the conversation this
    /// turn, used to expand `{{active_history: n}}` macros in the sub-agent's
    /// prompt. Empty for background contexts (heartbeat, dreaming), so the
    /// macro degrades to an empty string there.
    pub(crate) conversation: Vec<Message>,
}

impl SubagentRuntime {
    /// Build a runtime for a background context (heartbeat, dreaming) with no
    /// live client channel. The nested tool-loop runs and returns its summary;
    /// its streamed frames are drained and dropped. Diagnostics land in a
    /// throwaway buffer — background ticks have no interactive `shore diagnose`
    /// view to feed.
    pub(crate) fn background(ledger_client: LedgerClient, config: Arc<LoadedConfig>) -> Self {
        Self {
            ledger_client,
            diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
            config,
            direct_tx: None,
            conversation: Vec::new(),
        }
    }
}

/// Run sub-agent `name` with `query`, returning its final text.
pub(crate) async fn run(
    ctx: &SharedToolContext,
    runtime: &SubagentRuntime,
    name: &str,
    query: &str,
) -> Result<Value, ToolError> {
    let config = &runtime.config;
    let (spec, resolved) = resolve_spec_and_model(config, name)?;
    let mut request = build_request(&resolved, config, spec, ctx, query, &runtime.conversation)?;

    let thinking = thinking_enabled(&request);
    let char_name = ctx.character_name();

    // Forward the sub-agent's nested tool-loop frames to the client, each
    // tagged with the sub-agent name, so the UI renders the nested loop instead
    // of freezing on the `ask_<name>` call. The bulky tool *results* still never
    // enter the primary model's context — only the returned summary does; this
    // is purely a client-side view.
    let (tx, rx) = mpsc::channel::<ServerMessage>(64);
    let forward = spawn_forwarder(rx, runtime.direct_tx.clone(), name.to_owned());

    let consumer = StreamConsumer::new(tx.clone(), request.rid.clone());
    let mut ledger_stream = runtime
        .ledger_client
        .stream_raw(&request, CallType::Subagent, char_name, thinking)
        .await
        .map_err(|e| ToolError::Http(e.to_string()))?;
    let first = match consumer.consume(ledger_stream.reader_mut(), false).await {
        Ok(r) => {
            ledger_stream.finalize(&r);
            r
        }
        Err(e) => {
            ledger_stream.finalize_error(&e);
            forward.abort();
            return Err(ToolError::Http(e.to_string()));
        }
    };

    let retry = ToolLoopRetry {
        max_retries: config
            .app
            .advanced
            .max_retries
            .unwrap_or(crate::llm::retry::RetryPolicy::default().max_retries),
        backoff_base_ms: config
            .app
            .advanced
            .retry_backoff
            .map_or(500, |d| d.as_millis()),
    };

    // The nested loop runs against the guard context — never `ctx` — so a
    // hallucinated `ask_*` cannot recurse.
    let guard = SubagentGuardContext { inner: ctx };
    let loop_result = run_tool_loop(
        &runtime.ledger_client,
        &tx,
        &mut request,
        first,
        &guard,
        spec.max_iterations.or(resolved.max_tool_iterations),
        &config.app.tools,
        &runtime.diagnostics,
        char_name,
        thinking,
        retry,
    )
    .await
    .map_err(|e| ToolError::Http(e.to_string()));

    // Close the channel (drop both senders) so the forwarder drains any
    // buffered frames, then join it so the client sees the whole nested loop
    // before we return the summary.
    drop(consumer);
    drop(tx);
    let _ignored = forward.await;
    Ok(Value::String(loop_result?.result.content))
}

/// Resolve the subagent config entry and effective model.
fn resolve_spec_and_model<'conf>(
    config: &'conf LoadedConfig,
    name: &str,
) -> Result<(&'conf SubagentConfig, ResolvedModel), ToolError> {
    let spec = config
        .app
        .subagents
        .get(name)
        .ok_or_else(|| ToolError::NotImplemented(format!("ask_{name}")))?;

    // Model resolution: spec → defaults.subagent_model → defaults.model. Stop
    // there rather than chaining to the (expensive) active chat model — the
    // whole point is to land on something cheap.
    let model_name = spec
        .model
        .as_deref()
        .or(config.app.defaults.subagent_model.as_deref())
        .or(config.app.defaults.model.as_deref())
        .ok_or_else(|| {
            ToolError::InvalidArgs(format!(
                "subagent '{name}' has no model; set subagents.{name}.model or defaults.subagent_model"
            ))
        })?;
    let resolved = crate::effective_catalog::find_effective_model(
        config,
        &config.dirs.cache,
        model_name,
        true,
    )
    .map_err(|e| ToolError::InvalidArgs(format!("subagent '{name}' model '{model_name}': {e}")))?;

    Ok((spec, resolved))
}

/// Build the LLM request for the sub-agent, assembling system prompt and tools.
fn build_request(
    resolved: &ResolvedModel,
    config: &LoadedConfig,
    spec: &SubagentConfig,
    ctx: &SharedToolContext,
    query: &str,
    history: &[Message],
) -> Result<LlmRequest, ToolError> {
    let display_name = config.app.defaults.resolve_display_name();
    let vars = template_vars(ctx.character_name(), &display_name);
    // Two-phase render. First the standard `{{char}}`/`{{user}}`/`{{#if}}`
    // substitution over the trusted authored prompt; then expand the
    // sub-agent-only `{{file:}}` / `{{active_history:}}` macros. Macro content
    // is inserted *after* the var pass and never re-scanned, so untrusted
    // conversation text (which may itself contain `{{...}}`) can never trigger a
    // file read — mirroring the main prompt, where SOUL.md/USER.md go in raw.
    let rendered = crate::engine::prompt::render_template(&spec.prompt, &vars);
    let system_text = expand_prompt_macros(
        &rendered,
        ctx.character_data_dir(),
        ctx.workspace_dir(),
        history,
        ctx.character_name(),
        &display_name,
    );
    let tools = subagent_tool_subset(&spec.tools, &vars, ctx.mcp_registry.as_deref());

    // Mirror the dreaming/compaction shape: Anthropic-cache SDKs take the
    // system prompt as an inline `role:"system"` entry (kept byte-stable
    // across iterations); everyone else takes it top-level.
    let uses_anthropic_cache = resolved.sdk.uses_anthropic_prompt_cache();
    let system_arg = if uses_anthropic_cache {
        None
    } else {
        Some(json!(system_text))
    };
    let mut request = LedgerClient::build_request_with_provider_keys(
        resolved,
        &config.providers,
        vec![json!({ "role": "user", "content": query })],
        system_arg,
        Some(tools),
        None,
    )
    .map_err(|e| ToolError::Http(e.to_string()))?;
    if uses_anthropic_cache {
        request.push_inline_system(system_text);
    }

    Ok(request)
}

/// Spawn the task that tags each frame from the sub-agent's nested loop with
/// `name` and relays it to the client channel. It ends when every sender on
/// `rx` is dropped (or the client channel closes), so the caller drops its
/// senders and awaits the handle to flush.
///
/// `client_tx` is `None` for background contexts (heartbeat, dreaming): the
/// frames are still drained off `rx` — otherwise the bounded channel would
/// fill and stall the nested loop — but discarded rather than forwarded.
fn spawn_forwarder(
    mut rx: mpsc::Receiver<ServerMessage>,
    client_tx: Option<mpsc::Sender<ServerMessage>>,
    name: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(mut msg) = rx.recv().await {
            let Some(tx) = client_tx.as_ref() else {
                // Background tick: drain and drop to keep the nested loop moving.
                continue;
            };
            msg.set_subagent(&name);
            if tx.send(msg).await.is_err() {
                break;
            }
        }
    })
}

/// Build the `{{char}}` / `{{user}}` / `{{date}}` / `{{time}}` substitution
/// table. Unlike the main loop, a sub-agent runs in its own LLM call and never
/// sees the conversation's injected time markers, so `{{date}}`/`{{time}}` are
/// the only way its prompt can anchor freshness to "now" — populate them with
/// the live local clock rather than leaving them blank.
fn template_vars(char_name: &str, display_name: &str) -> HashMap<String, String> {
    let mut vars: HashMap<String, String> = HashMap::new();
    let _ = vars.insert("char".into(), char_name.to_owned());
    let _ = vars.insert("character_name".into(), char_name.to_owned());
    let _ = vars.insert("user".into(), display_name.to_owned());
    let _ = vars.insert("date".into(), crate::tools::basic::format_friendly_date());
    let _ = vars.insert("time".into(), crate::tools::basic::format_friendly_time());
    vars
}

/// Expand the sub-agent-only `{{file: <path>}}` and `{{active_history: <n>}}`
/// macros in an already-var-substituted prompt.
///
/// Both macros insert their content as a **terminal**: the pulled-in file
/// contents / conversation transcript are never re-scanned for further macros.
/// That is the security boundary — a chat message containing the literal text
/// `{{file: ~/.ssh/id_rsa}}` must never cause a file read. Callers run the
/// trusted `{{char}}`/`{{#if}}` substitution *before* this pass, so authored
/// interpolation still works while pulled-in content stays inert.
///
/// Any `{{...}}` that is not one of these two macros is passed through
/// untouched (e.g. a leftover `{{unknown}}` `render_template` did not resolve).
fn expand_prompt_macros(
    text: &str,
    character_data_dir: &str,
    workspace_dir: &str,
    history: &[Message],
    char_name: &str,
    user_name: &str,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        // `find` returns a char-boundary byte offset and `{{`/`}}` are ASCII, so
        // every `.get(..)` below is `Some`; `unwrap_or` only guards the
        // impossible-None case without an indexing panic (repo denies `[]` on
        // `str`).
        out.push_str(rest.get(..open).unwrap_or(""));
        let after = rest.get(open.saturating_add(2)..).unwrap_or("");
        let Some(close) = after.find("}}") else {
            // Unterminated `{{` — emit from `{{` onward verbatim and stop.
            out.push_str(rest.get(open..).unwrap_or(""));
            return out;
        };
        let inner_raw = after.get(..close).unwrap_or("");
        let inner = inner_raw.trim();
        if let Some(arg) = inner.strip_prefix("file:") {
            out.push_str(&read_prompt_file(
                character_data_dir,
                workspace_dir,
                arg.trim(),
            ));
        } else if let Some(arg) = inner.strip_prefix("active_history:") {
            out.push_str(&render_history_slice(
                history,
                arg.trim(),
                char_name,
                user_name,
            ));
        } else {
            // Not one of ours: pass the whole `{{...}}` token through verbatim.
            out.push_str("{{");
            out.push_str(inner_raw);
            out.push_str("}}");
        }
        rest = after.get(close.saturating_add(2)..).unwrap_or("");
    }
    out.push_str(rest);
    out
}

/// Resolve a `{{file:}}` target, preferring the active-prompt snapshot (so the
/// bytes match what the main prompt used this turn) and falling back to the live
/// workspace file for anything not snapshotted. A missing/unreadable file
/// expands to an empty string plus a warning, matching the "unknown var → empty"
/// degradation elsewhere.
///
/// The target is confined to the character's workspace by the same
/// [`workspace::resolve_path`] the `read`/`write` tools use: absolute paths,
/// `..` traversal, and symlinks pointing outside the workspace are all rejected
/// and expand to nothing. Expanded content is handed to an external sub-agent
/// model, so an out-of-workspace path would exfiltrate to the provider; the
/// documented contract is workspace-relative and this enforces it rather than
/// trusting the prompt author to get it right.
fn read_prompt_file(character_data_dir: &str, workspace_dir: &str, path: &str) -> String {
    let target = match super::workspace::resolve_path(workspace_dir, path) {
        Ok(target) => target,
        Err(e) => {
            tracing::warn!(
                macro_path = %path,
                error = %e,
                "subagent {{file}} macro: path rejected; expanding to empty"
            );
            return String::new();
        }
    };

    // The snapshot only ever holds the prompt-visible root files, so consult it
    // for those and let everything else read straight from the workspace. The
    // path is already confined above; this just picks which copy to serve.
    if let Some(name) = crate::memory::deferred_edits::normalize_prompt_visible_path(path) {
        let snapshot =
            crate::memory::deferred_edits::active_prompt_file(Path::new(character_data_dir), &name);
        if let Ok(content) = std::fs::read_to_string(&snapshot) {
            return content;
        }
    }

    match std::fs::read_to_string(&target) {
        Ok(content) => content,
        Err(e) => {
            tracing::warn!(
                macro_path = %path,
                error = %e,
                "subagent {{file}} macro: file unreadable; expanding to empty"
            );
            String::new()
        }
    }
}

/// Render the last `n` conversation messages as a plain `Speaker: text`
/// transcript for `{{active_history: n}}`. Assistant turns are labelled with the
/// character name, user turns with the display name. Empty turns and non-text
/// blocks (thinking, tool calls) are skipped; images are annotated inline. An
/// `n` that fails to parse (or is `0`), or an empty history, yields an empty
/// string. `n` is clamped to [`MAX_HISTORY_MESSAGES`].
fn render_history_slice(
    history: &[Message],
    arg: &str,
    char_name: &str,
    user_name: &str,
) -> String {
    let n = arg.parse::<usize>().unwrap_or(0).min(MAX_HISTORY_MESSAGES);
    if n == 0 || history.is_empty() {
        return String::new();
    }
    let start = history.len().saturating_sub(n);
    history
        .iter()
        .skip(start)
        .filter_map(|msg| {
            let text = message_display_text(msg);
            if text.trim().is_empty() {
                return None;
            }
            let speaker = match msg.role {
                Role::User => user_name,
                Role::Assistant => char_name,
                Role::System => "System",
            };
            Some(format!("{speaker}: {text}"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Extract a readable text rendering of a message for the history transcript:
/// the plain `content`, or the concatenated text blocks when `content` is empty,
/// with an inline note for any attached images.
fn message_display_text(msg: &Message) -> String {
    let mut text = if msg.content.trim().is_empty() {
        msg.content_blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                ContentBlock::Thinking { .. }
                | ContentBlock::RedactedThinking { .. }
                | ContentBlock::ToolUse { .. }
                | ContentBlock::ToolResult { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        msg.content.clone()
    };
    if !msg.images.is_empty() {
        let note = format!("[{} image(s)]", msg.images.len());
        if text.trim().is_empty() {
            text = note;
        } else {
            text.push(' ');
            text.push_str(&note);
        }
    }
    text
}

/// Render the sub-agent's allowed tool subset to the outbound `tools` array.
///
/// Only registered static tools are eligible; unknown names are skipped (the
/// config layer can't see the daemon tool registry, so the filter lands here)
/// and `ask_*` can never appear because sub-agent tools are not in the static
/// registry — both the offering guard and the recursion cap fall out of this.
fn subagent_tool_subset(
    allowed: &[String],
    vars: &HashMap<String, String>,
    mcp: Option<&super::mcp_registry::McpRegistry>,
) -> Vec<Value> {
    let registry = super::all_tools();
    let mut defs: Vec<Value> = allowed
        .iter()
        .filter_map(|name| {
            let def = registry.iter().find(|t| t.name == name).or_else(|| {
                // Not a static tool. MCP names (`mcp__*`) are resolved below;
                // anything else is genuinely unknown.
                if !name.starts_with("mcp__") {
                    tracing::warn!(tool = %name, "subagent references unknown tool; skipping");
                }
                None
            })?;
            Some(json!({
                "name": def.name,
                "description": crate::engine::prompt::render_template(def.description, vars),
                "input_schema": def.parameters.clone(),
            }))
        })
        .collect();
    // Expand `mcp__server__*` grants against the live registry. Appended after
    // static tools so the offered ordering is stable.
    if let Some(mcp_reg) = mcp {
        defs.extend(
            mcp_reg
                .names_matching(allowed)
                .iter()
                .map(|t| t.to_tool_json()),
        );
    }
    defs
}

/// True when the request enables reasoning via either provider knob. Mirrors
/// `handler::generation::thinking_enabled_from_request` (kept local to avoid a
/// cross-module `pub` widening).
fn thinking_enabled(request: &LlmRequest) -> bool {
    let Some(opts) = request.provider_options.as_ref() else {
        return false;
    };
    if opts.get("thinking_enabled") == Some(&Value::Bool(false)) {
        return false;
    }
    let budget_on = opts
        .get("budget_tokens")
        .and_then(Value::as_u64)
        .is_some_and(|b| b > 0);
    let effort_on = opts.get("reasoning_effort").is_some_and(|v| !v.is_null());
    budget_on || effort_on
}

/// Tool context for a sub-agent's nested loop: delegates everything to the
/// parent [`SharedToolContext`] except `run_subagent`, which falls back to the
/// trait default (`NotImplemented`) — hard-capping nesting at one level.
struct SubagentGuardContext<'ctx> {
    inner: &'ctx SharedToolContext,
}

impl ToolContext for SubagentGuardContext<'_> {
    fn image_dir(&self) -> &str {
        self.inner.image_dir()
    }
    fn llm_client(&self) -> Option<&crate::llm::LlmClient> {
        self.inner.llm_client()
    }
    fn image_gen_config(&self) -> Option<&crate::memory::compaction_impls::ImageGenConfig> {
        self.inner.image_gen_config()
    }
    fn search_config(&self) -> &shore_common::config::app::SearchConfig {
        self.inner.search_config()
    }
    fn character_name(&self) -> &str {
        self.inner.character_name()
    }
    fn workspace_dir(&self) -> &str {
        self.inner.workspace_dir()
    }
    fn character_data_dir(&self) -> &str {
        self.inner.character_data_dir()
    }
    fn markdown_store(&self) -> Option<&crate::memory::markdown_store::MarkdownMemoryStore> {
        self.inner.markdown_store()
    }
    fn memory_retrieval_config(&self) -> &shore_common::config::app::RetrievalConfig {
        self.inner.memory_retrieval_config()
    }
    fn embedder(&self) -> Option<&dyn crate::llm::embed::Embedder> {
        self.inner.embedder()
    }
    fn memory_index_path(&self) -> Option<&Path> {
        self.inner.memory_index_path()
    }
    fn config_dir(&self) -> &str {
        self.inner.config_dir()
    }
    fn defer_edit(&self, path: &str) {
        self.inner.defer_edit(path);
    }
    // Forward ledger access so a sub-agent (e.g. the memory agent) can run
    // `model_history`.
    fn ledger(&self) -> Option<&crate::ledger::Ledger> {
        self.inner.ledger()
    }
    // Forward MCP calls to the parent context so a sub-agent can use MCP tools.
    // `run_subagent` is deliberately *not* overridden (falls back to the
    // `NotImplemented` trait default), so the one-level nesting cap holds.
    fn mcp_call<'ctx>(
        &'ctx self,
        name: &'ctx str,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send + 'ctx>> {
        self.inner.mcp_call(name, input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_subset_keeps_known_skips_unknown() {
        let vars = template_vars("qifei", "ren");
        let allowed = vec![
            "read".to_owned(),
            "not_a_real_tool".to_owned(),
            "search".to_owned(),
        ];
        let defs = subagent_tool_subset(&allowed, &vars, None);
        let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["read", "search"]);
    }

    #[test]
    fn tool_subset_expands_mcp_globs() {
        // A sub-agent granted `mcp__hue__*` should be offered the live hue
        // tools alongside its static tools.
        let vars = template_vars("qifei", "ren");
        let registry = super::super::mcp_registry::McpRegistry::from_tools_for_test(vec![
            super::super::mcp_registry::McpToolDef::new_for_test("hue", "on"),
            super::super::mcp_registry::McpToolDef::new_for_test("nanoleaf", "scene"),
        ]);
        let allowed = vec!["read".to_owned(), "mcp__hue__*".to_owned()];
        let defs = subagent_tool_subset(&allowed, &vars, Some(&registry));
        let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"read"));
        assert!(names.contains(&"mcp__hue__on"));
        // The unmatched server's tool is not offered.
        assert!(!names.contains(&"mcp__nanoleaf__scene"));
    }

    #[test]
    fn tool_subset_cannot_offer_ask_tools() {
        // `ask_*` are not in the static registry, so even if a config names
        // one it is silently dropped — the recursion cap is structural.
        let vars = template_vars("qifei", "ren");
        let allowed = vec!["ask_music".to_owned(), "read".to_owned()];
        let defs = subagent_tool_subset(&allowed, &vars, None);
        let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["read"]);
    }

    #[test]
    fn template_vars_populate_date_and_time() {
        // A sub-agent never sees the conversation's time markers, so its prompt
        // relies on these being live (non-empty) to anchor freshness to "now".
        let vars = template_vars("qifei", "ren");
        assert!(!vars["date"].is_empty(), "{{{{date}}}} must be populated");
        assert!(!vars["time"].is_empty(), "{{{{time}}}} must be populated");
        let rendered =
            crate::engine::prompt::render_template("Today is {{date}} at {{time}}.", &vars);
        assert!(!rendered.contains("{{date}}") && !rendered.contains("{{time}}"));
    }

    #[tokio::test]
    async fn forwarder_tags_frames_with_subagent_name() {
        use shore_common::protocol::server_msg::{ToolCall, ToolResult};

        let (inner_tx, inner_rx) = mpsc::channel::<ServerMessage>(8);
        let (client_tx, mut client_rx) = mpsc::channel::<ServerMessage>(8);
        let handle = spawn_forwarder(inner_rx, Some(client_tx), "research".to_owned());

        inner_tx
            .send(ServerMessage::ToolCall(ToolCall {
                rid: None,
                tool_id: "t1".into(),
                tool_name: "search".into(),
                input: json!({}),
                subagent: None,
            }))
            .await
            .unwrap();
        inner_tx
            .send(ServerMessage::ToolResult(ToolResult {
                rid: None,
                tool_id: "t1".into(),
                tool_name: "search".into(),
                output: "hits".into(),
                is_error: false,
                subagent: None,
            }))
            .await
            .unwrap();
        drop(inner_tx);

        // Both frames arrive tagged with the sub-agent name.
        let call = client_rx.recv().await.unwrap();
        assert_eq!(call.subagent(), Some("research"));
        let result = client_rx.recv().await.unwrap();
        assert_eq!(result.subagent(), Some("research"));
        // Channel closes once all senders drop, so the task ends.
        assert!(client_rx.recv().await.is_none());
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn forwarder_drains_when_no_client_channel() {
        // Background contexts (heartbeat, dreaming) pass `None`: frames must be
        // drained off the bounded channel so the nested loop never stalls, but
        // nothing is forwarded.
        use shore_common::protocol::server_msg::ToolCall;

        let (inner_tx, inner_rx) = mpsc::channel::<ServerMessage>(2);
        let handle = spawn_forwarder(inner_rx, None, "research".to_owned());

        // Push more frames than the channel capacity; draining keeps it flowing.
        for i in 0..5 {
            inner_tx
                .send(ServerMessage::ToolCall(ToolCall {
                    rid: None,
                    tool_id: format!("t{i}"),
                    tool_name: "search".into(),
                    input: json!({}),
                    subagent: None,
                }))
                .await
                .unwrap();
        }
        drop(inner_tx);
        // Drains cleanly and the task ends once all senders drop.
        handle.await.unwrap();
    }

    // ── prompt-macro expansion ──────────────────────────────────────────────

    use shore_common::protocol::types::ImageRef;

    fn msg(role: Role, content: &str) -> Message {
        Message {
            msg_id: "m".into(),
            role,
            content: content.into(),
            images: Vec::new(),
            content_blocks: Vec::new(),
            alt_index: None,
            alt_count: None,
            alternatives: Vec::new(),
            timestamp: "t".into(),
            provider_key: None,
            model: None,
            origin: None,
        }
    }

    /// Expand against dirs that hold no files — isolates the history/passthrough
    /// behavior from filesystem reads.
    fn expand_history_only(text: &str, history: &[Message]) -> String {
        expand_prompt_macros(
            text,
            "/nonexistent/data",
            "/nonexistent/ws",
            history,
            "Qifei",
            "Ren",
        )
    }

    #[test]
    fn active_history_renders_last_n_with_speaker_labels() {
        let history = vec![
            msg(Role::User, "first"),
            msg(Role::Assistant, "second"),
            msg(Role::User, "third"),
            msg(Role::Assistant, "fourth"),
        ];
        let out = expand_history_only("<<{{active_history: 2}}>>", &history);
        // Only the last two turns, labelled by display/character name.
        assert_eq!(out, "<<Ren: third\nQifei: fourth>>");
    }

    #[test]
    fn active_history_zero_and_empty_expand_to_nothing() {
        let history = vec![msg(Role::User, "hi")];
        assert_eq!(
            expand_history_only("[{{active_history: 0}}]", &history),
            "[]"
        );
        assert_eq!(expand_history_only("[{{active_history: 5}}]", &[]), "[]");
        // Non-numeric arg parses to 0 → empty.
        assert_eq!(
            expand_history_only("[{{active_history: all}}]", &history),
            "[]"
        );
    }

    #[test]
    fn active_history_clamps_to_available_and_skips_empty_turns() {
        let history = vec![
            msg(Role::User, "kept"),
            msg(Role::Assistant, "   "), // whitespace-only → skipped
            msg(Role::User, "also kept"),
        ];
        // Asking for more than exist just takes everything present.
        let out = expand_history_only("{{active_history: 99}}", &history);
        assert_eq!(out, "Ren: kept\nRen: also kept");
    }

    #[test]
    fn active_history_annotates_images() {
        let mut m = msg(Role::User, "look");
        m.images = vec![ImageRef {
            path: "/x.png".into(),
            caption: None,
            data: None,
        }];
        let out = expand_history_only("{{active_history: 1}}", &[m]);
        assert_eq!(out, "Ren: look [1 image(s)]");
    }

    #[test]
    fn unknown_and_unterminated_tokens_pass_through() {
        // A non-macro `{{...}}` is left verbatim for the earlier var pass to have
        // handled (or to remain literal), and an unterminated `{{` is emitted as-is.
        assert_eq!(expand_history_only("a {{char}} b", &[]), "a {{char}} b");
        assert_eq!(expand_history_only("open {{ only", &[]), "open {{ only");
    }

    #[test]
    fn file_macro_prefers_snapshot_then_workspace_then_empty() {
        let data = tempfile::TempDir::new().unwrap();
        let ws = tempfile::TempDir::new().unwrap();
        let data_dir = data.path().to_str().unwrap();
        let ws_dir = ws.path().to_str().unwrap();

        // Snapshot copy under <data>/active_prompt/SOUL.md wins.
        let active = crate::memory::deferred_edits::active_prompt_dir(data.path());
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("SOUL.md"), "SNAPSHOT SOUL").unwrap();
        std::fs::write(ws.path().join("SOUL.md"), "WORKSPACE SOUL").unwrap();
        assert_eq!(
            expand_prompt_macros("{{file: ./SOUL.md}}", data_dir, ws_dir, &[], "C", "U"),
            "SNAPSHOT SOUL"
        );

        // A file only in the workspace (no snapshot) falls back to it.
        std::fs::write(ws.path().join("LORE.md"), "WS LORE").unwrap();
        assert_eq!(
            expand_prompt_macros("{{file: LORE.md}}", data_dir, ws_dir, &[], "C", "U"),
            "WS LORE"
        );

        // Missing everywhere → empty, no panic.
        assert_eq!(
            expand_prompt_macros("[{{file: ./nope.md}}]", data_dir, ws_dir, &[], "C", "U"),
            "[]"
        );
    }

    #[test]
    fn file_macro_is_confined_to_the_workspace() {
        // Expanded content goes to an external sub-agent model, so a path that
        // escapes the workspace would exfiltrate to the provider. Absolute
        // paths, `..` traversal, and symlinks out of the workspace must all
        // expand to nothing rather than read.
        let data = tempfile::TempDir::new().unwrap();
        let ws = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let data_dir = data.path().to_str().unwrap();
        let ws_dir = ws.path().to_str().unwrap();

        let secret = outside.path().join("secret.md");
        std::fs::write(&secret, "TOP SECRET").unwrap();

        // Absolute path — `Path::join` would otherwise discard the workspace
        // base entirely and read it.
        let abs = format!("[{{{{file: {}}}}}]", secret.display());
        assert_eq!(
            expand_prompt_macros(&abs, data_dir, ws_dir, &[], "C", "U"),
            "[]"
        );

        // `..` traversal out of the workspace.
        let up = format!(
            "[{{{{file: ../{}/secret.md}}}}]",
            outside.path().file_name().unwrap().to_str().unwrap()
        );
        assert_eq!(
            expand_prompt_macros(&up, data_dir, ws_dir, &[], "C", "U"),
            "[]"
        );

        // A symlink inside the workspace pointing out of it: the path has no
        // `..` and is not absolute, so only canonicalization catches this.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, ws.path().join("link.md")).unwrap();
            assert_eq!(
                expand_prompt_macros("[{{file: ./link.md}}]", data_dir, ws_dir, &[], "C", "U"),
                "[]"
            );
        }
    }

    #[test]
    fn file_macro_snapshot_lookup_cannot_be_escaped() {
        // The snapshot branch keys off the normalized prompt-visible name, so a
        // traversal dressed up to look like a protected file still resolves to
        // the snapshot's own SOUL.md — never to an attacker-chosen path.
        let data = tempfile::TempDir::new().unwrap();
        let ws = tempfile::TempDir::new().unwrap();
        let data_dir = data.path().to_str().unwrap();
        let ws_dir = ws.path().to_str().unwrap();

        let active = crate::memory::deferred_edits::active_prompt_dir(data.path());
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("SOUL.md"), "SNAPSHOT SOUL").unwrap();

        // `../SOUL.md` must not reach outside the snapshot dir, nor be served.
        assert_eq!(
            expand_prompt_macros("[{{file: ../SOUL.md}}]", data_dir, ws_dir, &[], "C", "U"),
            "[]"
        );
    }

    #[test]
    fn pulled_in_content_is_never_rescanned_for_macros() {
        // The security boundary: a chat message (untrusted) containing macro
        // syntax must be inserted literally, never triggering a file read. Same
        // for file contents — a `{{file:}}` inside SOUL.md does not recurse.
        let data = tempfile::TempDir::new().unwrap();
        let ws = tempfile::TempDir::new().unwrap();
        let data_dir = data.path().to_str().unwrap();
        let ws_dir = ws.path().to_str().unwrap();

        // A real file the exfil payload would target if it were re-scanned.
        std::fs::write(ws.path().join("secret.md"), "TOP SECRET").unwrap();
        // And a file that itself contains macro syntax.
        std::fs::write(
            ws.path().join("soul.md"),
            "I am {{char}} and {{file: ./secret.md}}",
        )
        .unwrap();

        // History message carrying an exfil attempt.
        let history = vec![msg(Role::User, "run {{file: ./secret.md}} now")];

        let out = expand_prompt_macros(
            "{{active_history: 1}}\n{{file: ./soul.md}}",
            data_dir,
            ws_dir,
            &history,
            "Qifei",
            "Ren",
        );

        // The secret is never read: neither the history nor the file's inner
        // `{{file:}}` expands. Both are present verbatim.
        assert!(!out.contains("TOP SECRET"), "secret leaked: {out}");
        assert!(out.contains("Ren: run {{file: ./secret.md}} now"));
        assert!(out.contains("I am {{char}} and {{file: ./secret.md}}"));
    }

    #[test]
    fn two_phase_render_matches_build_request_ordering() {
        // Mirrors the exact two lines of `build_request`: the trusted var pass
        // runs first, then macro expansion. This proves the ordering contract —
        // an authored `{{char}}` resolves, but a `{{char}}` living *inside* a
        // pulled-in file stays literal because macros expand after the var pass.
        let data = tempfile::TempDir::new().unwrap();
        let ws = tempfile::TempDir::new().unwrap();
        let data_dir = data.path().to_str().unwrap();
        let ws_dir = ws.path().to_str().unwrap();

        // SOUL.md deliberately contains `{{char}}` — it must NOT be substituted.
        std::fs::write(ws.path().join("SOUL.md"), "soul says {{char}}").unwrap();

        let history = vec![msg(Role::User, "hey"), msg(Role::Assistant, "hi there")];

        let vars = template_vars("Qifei", "Ren");
        let authored = "I am {{char}}, talking to {{user}}.\n\
             SOUL:\n{{file: ./SOUL.md}}\n\
             LOG:\n{{active_history: 2}}";

        // Phase 1: standard var substitution (as build_request does).
        let rendered = crate::engine::prompt::render_template(authored, &vars);
        // Phase 2: macro expansion (as build_request does).
        let out = expand_prompt_macros(&rendered, data_dir, ws_dir, &history, "Qifei", "Ren");

        assert_eq!(
            out,
            "I am Qifei, talking to Ren.\n\
             SOUL:\nsoul says {{char}}\n\
             LOG:\nRen: hey\nQifei: hi there"
        );
    }
}
