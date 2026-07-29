//! Shared test mocks and builders for shore-daemon tests.
//!
//! This module consolidates duplicated test infrastructure
//! (test_model, TestToolContext) so each test file can import from a
//! single source.

use std::sync::Arc;

use crate::autonomy::manager::AutonomyManager;
use crate::ledger::LedgerClient;
use crate::llm::embed::Embedder;
use crate::llm::LlmClient;
use crate::memory::compaction_impls::ImageGenConfig;
use crate::memory::markdown_store::MarkdownMemoryStore;
use crate::tools::ToolContext;
use shore_common::config::app::{RetrievalConfig, SearchConfig};
use shore_common::config::models::{ResolvedModel, Sdk};
use shore_common::protocol::types::Message;

// ── JSONL persistence helper ───────────────────────────────────────────

/// Write a list of `Message`s as a newline-delimited JSONL file at `path`.
///
/// Mirrors the canonical on-disk shape used by the engine and tests, with
/// a trailing newline so file readers that split on `\n` see the final
/// entry. Used by tests in `engine/` and `commands/conversation`.
pub fn write_jsonl(path: &std::path::Path, messages: &[Message]) {
    let body = messages
        .iter()
        .map(|msg| serde_json::to_string(msg).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(path, body).unwrap();
}

/// Build a fixture segmented-history layout under `character_dir`:
/// one segment file + a `compaction.json` manifest + an `active.jsonl`.
///
/// This bypasses `compaction_impls::archive_and_retain` and writes the
/// files directly — that's intentional for unit tests that need a
/// canned post-compaction state without running the full compaction
/// pipeline. Tests that want to exercise the real archive path should
/// drive `archive_and_retain` instead.
pub fn write_segmented_fixture(
    character_dir: &std::path::Path,
    archived: &[Message],
    active: &[Message],
    timestamp: &str,
) {
    let segments_dir = character_dir.join("segments");
    std::fs::create_dir_all(&segments_dir).unwrap();
    write_jsonl(&segments_dir.join("0001.jsonl"), archived);

    let manifest = crate::engine::segments::CompactionManifest {
        segments: vec![crate::engine::segments::SegmentEntry {
            file: "0001.jsonl".into(),
            message_count: archived.len(),
            compacted_at: timestamp.into(),
        }],
        total_compacted_messages: archived.len(),
    };
    std::fs::write(
        character_dir.join("compaction.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    write_jsonl(&character_dir.join("active.jsonl"), active);
}

// ── test_model ──────────────────────────────────────────────────────────

/// Canonical test `ResolvedModel` used across all daemon tests.
pub fn test_model() -> ResolvedModel {
    ResolvedModel {
        name: "test".into(),
        qualified_name: "chat.test".into(),
        category: "chat".into(),
        provider_key: "anthropic".into(),
        sdk: Sdk::Anthropic,
        model_id: "claude-test".into(),
        api_key_env: Some("TEST_KEY".into()),
        base_url: None,
        max_context_tokens: None,
        max_output_tokens: Some(4096),
        temperature: Some(0.7),
        top_p: None,
        reasoning_effort: None,
        budget_tokens: None,
        cache_ttl: None,
        cache_keepalive: None,
        openrouter_provider: None,
        gemini_generation: None,
        zai_clear_thinking: None,
        zai_subscription: None,
        replay_prior_thinking: None,
        max_tool_iterations: None,
    }
}

// ── TestToolContext ─────────────────────────────────────────────────────

/// Shared `ToolContext` implementation for unit tests.
#[must_use]
pub struct TestToolContext {
    pub model: ResolvedModel,
    pub image_dir_val: String,
    pub search_config_val: SearchConfig,
    pub autonomy_mgr: Option<AutonomyManager>,
    pub character_name_val: String,
    pub markdown_store_val: Option<MarkdownMemoryStore>,
    pub retrieval_config_val: RetrievalConfig,
    pub embedder_val: Option<Arc<dyn Embedder>>,
    pub memory_index_path_val: Option<std::path::PathBuf>,
    pub workspace_dir_val: String,
    pub character_data_dir_val: String,
    pub ledger_client_val: Option<LedgerClient>,
}

impl std::fmt::Debug for TestToolContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestToolContext")
            .field("model", &self.model)
            .field("image_dir_val", &self.image_dir_val)
            .field("search_config_val", &self.search_config_val)
            .field("autonomy_mgr", &self.autonomy_mgr)
            .field("character_name_val", &self.character_name_val)
            .field("markdown_store_val", &self.markdown_store_val)
            .field("retrieval_config_val", &self.retrieval_config_val)
            .field(
                "embedder_val",
                &self.embedder_val.as_ref().map(|_| "<embedder>"),
            )
            .field("memory_index_path_val", &self.memory_index_path_val)
            .field("workspace_dir_val", &self.workspace_dir_val)
            .field("character_data_dir_val", &self.character_data_dir_val)
            .field(
                "ledger_client_val",
                &self.ledger_client_val.as_ref().map(|_| "<ledger client>"),
            )
            .finish()
    }
}

impl TestToolContext {
    /// Create a default test context.
    pub fn new() -> Self {
        Self {
            model: test_model(),
            image_dir_val: "/tmp/test_images".to_owned(),
            search_config_val: SearchConfig::default(),
            autonomy_mgr: None,
            character_name_val: String::new(),
            markdown_store_val: None,
            retrieval_config_val: RetrievalConfig::default(),
            embedder_val: None,
            memory_index_path_val: None,
            workspace_dir_val: String::new(),
            character_data_dir_val: String::new(),
            ledger_client_val: None,
        }
    }

    /// Set a custom image directory.
    pub fn with_image_dir(mut self, dir: &str) -> Self {
        self.image_dir_val = dir.to_owned();
        self
    }

    /// Set an autonomy manager and character name for activity tests.
    pub fn with_autonomy(mut self, mgr: AutonomyManager, character: &str) -> Self {
        self.autonomy_mgr = Some(mgr);
        self.character_name_val = character.to_owned();
        self
    }

    /// Set a markdown memory store.
    pub fn with_markdown_store(mut self, store: MarkdownMemoryStore) -> Self {
        self.markdown_store_val = Some(store);
        self
    }

    /// Set a workspace directory for workspace dispatch tests.
    pub fn with_workspace_dir(mut self, dir: &str) -> Self {
        self.workspace_dir_val = dir.to_owned();
        self
    }

    /// Set a character data directory for conversation-history tool tests.
    pub fn with_character_data_dir(mut self, dir: &str) -> Self {
        self.character_data_dir_val = dir.to_owned();
        self
    }

    pub fn with_retrieval_config(mut self, config: RetrievalConfig) -> Self {
        self.retrieval_config_val = config;
        self
    }

    /// Set the character name.
    pub fn with_character(mut self, name: &str) -> Self {
        self.character_name_val = name.to_owned();
        self
    }

    /// Make the usage ledger available to `model_history`.
    ///
    /// The client is backed by an in-memory ledger and has no sidecar socket,
    /// so any query it makes fails at the transport. That is enough for the
    /// tests that live here — they check the argument handling that happens
    /// *before* the query. What the query itself returns is pinned on the side
    /// that runs it, in `llm-sidecar/tests/ledger_usage.test.ts`.
    pub fn with_ledger(mut self) -> Self {
        self.ledger_client_val = Some(LedgerClient::new_in_memory(
            LlmClient::try_new().expect("test LLM client builds"),
        ));
        self
    }
}

impl Default for TestToolContext {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolContext for TestToolContext {
    fn image_dir(&self) -> &str {
        &self.image_dir_val
    }
    fn llm_client(&self) -> Option<&LlmClient> {
        None
    }
    fn image_gen_config(&self) -> Option<&ImageGenConfig> {
        None
    }
    fn search_config(&self) -> &SearchConfig {
        &self.search_config_val
    }
    fn autonomy_manager(&self) -> Option<&AutonomyManager> {
        self.autonomy_mgr.as_ref()
    }
    fn character_name(&self) -> &str {
        &self.character_name_val
    }
    fn markdown_store(&self) -> Option<&MarkdownMemoryStore> {
        self.markdown_store_val.as_ref()
    }
    fn memory_retrieval_config(&self) -> &RetrievalConfig {
        &self.retrieval_config_val
    }
    fn embedder(&self) -> Option<&dyn Embedder> {
        self.embedder_val.as_deref()
    }
    fn memory_index_path(&self) -> Option<&std::path::Path> {
        self.memory_index_path_val.as_deref()
    }
    fn workspace_dir(&self) -> &str {
        &self.workspace_dir_val
    }
    fn character_data_dir(&self) -> &str {
        &self.character_data_dir_val
    }
    fn ledger_client(&self) -> Option<&LedgerClient> {
        self.ledger_client_val.as_ref()
    }
    fn config_dir(&self) -> &'static str {
        ""
    }
    fn defer_edit(&self, _path: &str) {}
}
