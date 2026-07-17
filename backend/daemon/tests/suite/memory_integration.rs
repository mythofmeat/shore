use shore_daemon::memory::compaction::{
    CompactionConfig, CompactionError, CompactionLlm, CompactionManager, CompactionOutcome,
    ConversationMessage, DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM,
};
use shore_daemon::memory::compaction_impls::RealConversationManager;
use shore_daemon::memory::markdown_query;
use shore_daemon::memory::markdown_store::MarkdownMemoryStore;
use shore_daemon::tools::ToolContext;
use shore_llm::types::{GenerateResponse, LlmRequest, Timing, Usage};
use shore_protocol::types::ContentBlock;
use std::sync::Mutex as StdMutex;
use tempfile::TempDir;

/// Minimal `ToolContext` for the integration test. The compaction tool
/// loop only needs `workspace_dir` populated for `write` dispatch to
/// resolve paths correctly; every other accessor falls back to the
/// trait's defaults.
struct IntegrationToolContext {
    workspace_dir: String,
    search_config: shore_config::app::SearchConfig,
    retrieval_config: shore_config::app::RetrievalConfig,
}

impl IntegrationToolContext {
    fn new(workspace_dir: String) -> Self {
        Self {
            workspace_dir,
            search_config: shore_config::app::SearchConfig::default(),
            retrieval_config: shore_config::app::RetrievalConfig::default(),
        }
    }
}

impl ToolContext for IntegrationToolContext {
    fn image_dir(&self) -> &'static str {
        ""
    }
    fn llm_client(&self) -> Option<&shore_llm::LlmClient> {
        None
    }
    fn image_gen_config(&self) -> Option<&shore_daemon::memory::compaction_impls::ImageGenConfig> {
        None
    }
    fn search_config(&self) -> &shore_config::app::SearchConfig {
        &self.search_config
    }
    fn workspace_dir(&self) -> &str {
        &self.workspace_dir
    }
    fn memory_retrieval_config(&self) -> &shore_config::app::RetrievalConfig {
        &self.retrieval_config
    }
}

/// Scripted [`CompactionLlm`] that returns a pre-canned sequence of
/// generate responses. The tool loop drives the responses in order; the
/// first that emits no `tool_use` blocks (or whose `finish_reason` is not
/// `tool_use`) ends the loop.
struct ScriptedCompactionLlm {
    responses: StdMutex<Vec<GenerateResponse>>,
}

impl ScriptedCompactionLlm {
    /// Build an LLM that replies with one tool-use round containing a
    /// whole-file `edit` call per `(path, content)` pair, then ends with an
    /// empty text turn.
    fn writing(entries: &[(&str, &str)]) -> Self {
        let mut blocks: Vec<ContentBlock> = Vec::new();
        for (i, (path, content)) in entries.iter().enumerate() {
            blocks.push(ContentBlock::ToolUse {
                id: format!("call_{i}"),
                name: "edit".into(),
                input: serde_json::json!({
                    "path": path,
                    "content": content,
                }),
            });
        }
        let tool_round = GenerateResponse {
            content: String::new(),
            content_blocks: blocks,
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            model: "mock".into(),
        };
        let end = GenerateResponse {
            content: "done".into(),
            content_blocks: vec![ContentBlock::Text {
                text: "done".into(),
            }],
            finish_reason: "end_turn".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            model: "mock".into(),
        };
        Self {
            responses: StdMutex::new(vec![tool_round, end]),
        }
    }
}

impl CompactionLlm for ScriptedCompactionLlm {
    fn build_initial_request(
        &self,
        system: &str,
        compact_now_user: serde_json::Value,
        chat_request: LlmRequest,
    ) -> Result<LlmRequest, CompactionError> {
        let mut messages = chat_request.messages.clone();
        messages.push(compact_now_user);
        let mut request = LlmRequest {
            sdk: chat_request.sdk,
            model: chat_request.model,
            api_key: chat_request.api_key,
            api_key_name: chat_request.api_key_name,
            base_url: chat_request.base_url,
            messages,
            system: chat_request.system,
            tools: chat_request.tools,
            max_tokens: chat_request.max_tokens,
            temperature: chat_request.temperature,
            top_p: chat_request.top_p,
            provider_options: chat_request.provider_options,
            provider_key: chat_request.provider_key,
            rid: None,
            forensic_character: None,
            retain_long: true,
            keepalive_interval: None,
        };
        // Mirror production: the compaction instruction is pinned at a
        // fixed inline `role:"system"` slot, never the moving tail.
        request.push_inline_system(system);
        Ok(request)
    }

    fn generate<'src>(
        &'src self,
        _request: &'src mut LlmRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<GenerateResponse, CompactionError>>
                + Send
                + 'src,
        >,
    > {
        let next = {
            let mut guard = self.responses.lock().unwrap();
            if guard.is_empty() {
                None
            } else {
                Some(guard.remove(0))
            }
        };
        Box::pin(async move {
            next.ok_or_else(|| CompactionError::Llm("scripted LLM exhausted".into()))
        })
    }
}

/// Build a minimal chat-shape `LlmRequest` for integration tests. Mirrors
/// what `handler::build_chat_shape_request_from_disk` would produce, but
/// without needing the full disk-walking setup.
fn make_chat_request_for_test() -> LlmRequest {
    LlmRequest {
        sdk: shore_config::models::Sdk::Anthropic,
        model: "mock-chat-model".into(),
        api_key: String::new(),
        api_key_name: None,
        base_url: None,
        messages: Vec::new(),
        system: Some(serde_json::json!("mock chat system")),
        tools: Some(Vec::new()),
        max_tokens: 1024,
        temperature: None,
        top_p: None,
        provider_options: None,
        provider_key: None,
        rid: None,
        forensic_character: None,
        retain_long: false,
        keepalive_interval: None,
    }
}

fn make_conversation() -> Vec<ConversationMessage> {
    vec![
        ConversationMessage {
            role: "user".into(),
            content: "I love ramen and tea.".into(),
            timestamp: "2026-04-23T10:00:00Z".into(),
            is_tool_result_only: false,
            is_autonomous: false,
        },
        ConversationMessage {
            role: "assistant".into(),
            content: "Noted.".into(),
            timestamp: "2026-04-23T10:00:10Z".into(),
            is_tool_result_only: false,
            is_autonomous: false,
        },
        ConversationMessage {
            role: "user".into(),
            content: "My cat Mochi knocked over a mug again.".into(),
            timestamp: "2026-04-23T10:01:00Z".into(),
            is_tool_result_only: false,
            is_autonomous: false,
        },
        ConversationMessage {
            role: "assistant".into(),
            content: "Poor mug.".into(),
            timestamp: "2026-04-23T10:01:10Z".into(),
            is_tool_result_only: false,
            is_autonomous: false,
        },
    ]
}

fn active_jsonl(messages: &[ConversationMessage]) -> String {
    messages
        .iter()
        .map(|msg| {
            serde_json::json!({
                "msg_id": format!("m_{}", uuid::Uuid::new_v4()),
                "role": msg.role,
                "content": msg.content,
                "images": [],
                "content_blocks": [{"type": "text", "text": msg.content}],
                "alt_index": serde_json::Value::Null,
                "alt_count": serde_json::Value::Null,
                "timestamp": msg.timestamp,
            })
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn test_markdown_memory_compaction_end_to_end() {
    let tmp = TempDir::new().unwrap();
    let char_dir = tmp.path().join("Shore");
    std::fs::create_dir_all(&char_dir).unwrap();

    let messages = make_conversation();
    let active = active_jsonl(&messages);
    std::fs::write(char_dir.join("active.jsonl"), &active).unwrap();

    // Workspace lives at char_dir; the markdown store hangs off
    // <workspace>/memory so write tool path resolution lines up.
    let store = MarkdownMemoryStore::open(char_dir.join("memory"))
        .await
        .unwrap();
    let conv_mgr = RealConversationManager::new(&char_dir);
    let llm = ScriptedCompactionLlm::writing(&[
        (
            "memory/people/user.md",
            "# User\n\n- Loves ramen\n- Prefers tea over coffee",
        ),
        (
            "memory/topics/pets/mochi.md",
            "# Mochi\n\n- The user's cat\n- Knocks over mugs",
        ),
    ]);
    let mgr = CompactionManager::new(CompactionConfig::default());
    let tool_ctx = IntegrationToolContext::new(char_dir.to_string_lossy().into_owned());

    let data_dir = tmp.path().join("data");
    let outcome = mgr
        .compact(
            "Shore",
            &messages,
            &active,
            DEFAULT_COMPACT_SYSTEM,
            DEFAULT_COMPACT_PROMPT,
            "Shore",
            "User",
            &llm,
            &conv_mgr,
            Some(&store),
            false,
            Some(1),
            false,
            make_chat_request_for_test(),
            Some(&data_dir),
            &tool_ctx,
            None,
        )
        .await
        .unwrap();

    let CompactionOutcome::Compacted(result) = outcome else {
        panic!("expected Compacted");
    };

    assert_eq!(result.memory_files_written.len(), 2);
    assert!(store.read("people/user.md").await.is_ok());
    assert!(store.read("topics/pets/mochi.md").await.is_ok());

    let dreams_log = shore_daemon::memory::dreams_log::read_dreams_log(&data_dir, "Shore")
        .await
        .unwrap()
        .expect("dreams log should be written by compaction");
    assert!(dreams_log.contains("Updated memory files"));

    let direct =
        markdown_query::format_direct_response("ramen", &store.search_text("ramen").await.unwrap());
    assert!(direct.contains("people/user.md"));
}
