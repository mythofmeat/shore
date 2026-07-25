//! Shared tool context — canonical `ToolContext` implementation.
//!
//! Both the message handler and heartbeat ticks construct a `SharedToolContext`
//! with their caller-specific wiring. Adding a new `ToolContext` method requires
//! updating this struct + impl (one place) instead of two separate copies.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use crate::llm::embed::Embedder;
use crate::llm::LlmClient;
use serde_json::Value;
use shore_common::config::app::{RetrievalConfig, SearchConfig};

use crate::memory::compaction_impls::ImageGenConfig;
use crate::memory::markdown_store::MarkdownMemoryStore;

use super::mcp_registry::McpRegistry;
use super::subagent::SubagentRuntime;
use super::{ToolContext, ToolError};

// ---------------------------------------------------------------------------
// SharedToolContext
// ---------------------------------------------------------------------------

/// Shared tool context holding all dependencies needed by tool handlers.
///
/// Used directly by heartbeat ticks. Wrapped by `HandlerToolContext` in the
/// message handler (which adds `AutonomyManager` access).
pub(crate) struct SharedToolContext {
    pub(crate) image_dir: String,
    pub(crate) llm_client: LlmClient,
    pub(crate) image_gen_config: Option<ImageGenConfig>,
    pub(crate) search_config: SearchConfig,
    pub(crate) character_name: String,
    pub(crate) workspace_dir: String,
    pub(crate) markdown_store: Option<MarkdownMemoryStore>,
    pub(crate) memory_retrieval_config: RetrievalConfig,
    pub(crate) embedder: Option<Arc<dyn Embedder>>,
    pub(crate) memory_index_path: std::path::PathBuf,
    pub(crate) config_dir: String,
    pub(crate) character_data_dir: String,
    /// Sub-agent delegation runtime. `Some` only on the chat generation path;
    /// background contexts leave it `None`, so `ask_*` there is `NotImplemented`.
    pub(crate) subagent_runtime: Option<Arc<SubagentRuntime>>,
    /// Live MCP connections. `Some` on chat and background paths that wire it;
    /// `None` leaves `mcp__*` tools `NotImplemented`. Shared (not per-turn) so
    /// connections persist across turns.
    pub(crate) mcp_registry: Option<Arc<McpRegistry>>,
}

impl ToolContext for SharedToolContext {
    fn image_dir(&self) -> &str {
        &self.image_dir
    }
    fn llm_client(&self) -> Option<&LlmClient> {
        Some(&self.llm_client)
    }
    fn image_gen_config(&self) -> Option<&ImageGenConfig> {
        self.image_gen_config.as_ref()
    }
    fn search_config(&self) -> &SearchConfig {
        &self.search_config
    }
    fn character_name(&self) -> &str {
        &self.character_name
    }
    fn workspace_dir(&self) -> &str {
        &self.workspace_dir
    }
    fn character_data_dir(&self) -> &str {
        &self.character_data_dir
    }
    // The ledger handle rides on the sub-agent runtime's ledger-wrapped
    // client, which every path except compaction populates — no separate
    // field to thread through construction sites.
    fn ledger(&self) -> Option<&crate::ledger::Ledger> {
        self.subagent_runtime
            .as_ref()
            .map(|rt| rt.ledger_client.ledger().as_ref())
    }
    fn markdown_store(&self) -> Option<&MarkdownMemoryStore> {
        self.markdown_store.as_ref()
    }
    fn memory_retrieval_config(&self) -> &RetrievalConfig {
        &self.memory_retrieval_config
    }
    fn embedder(&self) -> Option<&dyn Embedder> {
        self.embedder.as_deref()
    }
    fn memory_index_path(&self) -> Option<&Path> {
        Some(&self.memory_index_path)
    }
    fn config_dir(&self) -> &str {
        &self.config_dir
    }
    fn defer_edit(&self, path: &str) {
        if !crate::memory::deferred_edits::is_prompt_visible_path(path) {
            return;
        }
        let data_dir = Path::new(&self.character_data_dir);
        if let Err(e) = crate::memory::deferred_edits::queue_deferred_edit(data_dir, path) {
            tracing::warn!(path = %path, error = %e, "Failed to queue deferred edit");
        }
    }
    fn run_subagent<'ctx>(
        &'ctx self,
        name: &'ctx str,
        query: &'ctx str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send + 'ctx>> {
        Box::pin(async move {
            match self.subagent_runtime.as_ref() {
                Some(runtime) => super::subagent::run(self, runtime, name, query).await,
                None => Err(ToolError::NotImplemented(format!("ask_{name}"))),
            }
        })
    }
    fn mcp_call<'ctx>(
        &'ctx self,
        name: &'ctx str,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ToolError>> + Send + 'ctx>> {
        Box::pin(async move {
            match self.mcp_registry.as_ref() {
                Some(registry) => registry.call(name, input).await,
                None => Err(ToolError::NotImplemented(name.to_owned())),
            }
        })
    }
}
