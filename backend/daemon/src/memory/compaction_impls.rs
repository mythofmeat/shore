//! Production implementations of the compaction traits.
//!
//! `RealCompactionLlm` — sends prompts to shore-llm via `LlmClient`, returns raw text.
//! `RealConversationManager` — archives with retention.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use chrono::Local;
use tracing::debug;
use uuid::Uuid;

use crate::engine::segments::{CompactionManifest, SegmentEntry};
use shore_config::models::{hardcoded_provider_defaults, ImageGenSettings, ResolvedModel};
use shore_config::providers::ProviderRegistry;
use shore_ledger::{CallType, LedgerClient};
use shore_llm::credentials::{read_candidate_env, resolve_key_candidates_for};
use shore_llm::types::{GenerateResponse, LlmRequest};

use super::compaction::{CompactionError, CompactionLlm, ConversationManager, RetentionParams};

// ---------------------------------------------------------------------------
// Image generation configuration
// ---------------------------------------------------------------------------

/// Resolved image generation configuration extracted from raw TOML catalog.
#[derive(Debug, Clone)]
pub struct ImageGenConfig {
    pub provider: String,
    pub model_id: String,
    pub api_key: String,
    pub base_url: Option<String>,
    /// Default size for OpenAI path (e.g. "1024x1024").
    pub size: String,
    /// Optional quality hint for OpenAI path (e.g. "hd").
    pub quality: Option<String>,
    /// OpenRouter aspect ratio (e.g. "1:1", "16:9").
    pub aspect_ratio: Option<String>,
    /// OpenRouter image size (e.g. "1K", "2K", "4K").
    pub image_size: Option<String>,
}

/// Resolve image generation config from the model catalog.
///
/// `default_ref` is `defaults.image_generation` — a `provider:model_id`
/// identity. `image_gen` holds optional per-model category settings keyed by
/// the same identity. Transport (`base_url`) and credentials resolve through
/// `providers`, reusing the same `[providers.*]` key-fallback contract as chat.
pub fn resolve_image_gen_config(
    default_ref: Option<&str>,
    image_gen: &std::collections::BTreeMap<String, ImageGenSettings>,
    providers: &ProviderRegistry,
) -> Result<ImageGenConfig, String> {
    // Identity: the configured default, else the sole settings-overlay key.
    // With multiple overlay entries and no default, fail rather than silently
    // pick one — the choice would be arbitrary (BTreeMap order).
    let target = if let Some(t) = default_ref {
        t
    } else {
        let mut keys = image_gen.keys();
        match (keys.next(), keys.next()) {
            (Some(only), None) => only.as_str(),
            (Some(_), Some(_)) => {
                return Err(
                    "multiple [image_generation.\"provider:model_id\"] entries are \
                     configured but defaults.image_generation is unset; set \
                     defaults.image_generation to choose one"
                        .to_owned(),
                );
            }
            _ => {
                return Err("no image generation model configured; set \
                     defaults.image_generation = \"provider:model_id\" and configure \
                     [providers.<provider>] (see CONFIGURATION.md)."
                    .to_owned());
            }
        }
    };

    let Some((provider_key, model_id)) = target.split_once(':') else {
        return Err(format!(
            "image generation model '{target}' must be a `provider:model_id` identity \
             with transport under [providers.<provider>]"
        ));
    };
    if provider_key.is_empty() || model_id.is_empty() {
        return Err(format!(
            "image generation model '{target}' is not a valid `provider:model_id` identity"
        ));
    }

    // Transport: registry base_url, else the hardcoded provider default, else
    // None (the SDK default endpoint).
    let base_url = providers
        .get(provider_key)
        .and_then(|e| e.base_url.clone())
        .or_else(|| hardcoded_provider_defaults(provider_key).fields.base_url);

    // Credentials: the `[providers.<p>].keys[]` fallback chain; first env-set
    // candidate wins.
    let candidates = resolve_key_candidates_for(provider_key, providers, None);
    if candidates.is_empty() {
        return Err(format!(
            "image generation provider '{provider_key}' is disabled in \
             [providers.{provider_key}]"
        ));
    }
    let api_key = candidates
        .iter()
        .find_map(read_candidate_env)
        .ok_or_else(|| {
            let envs: Vec<&str> = candidates.iter().map(|c| c.env.as_str()).collect();
            format!(
                "image generation API key not set for provider '{provider_key}'; \
             set one of these env vars: {}",
                envs.join(", ")
            )
        })?;

    let settings = image_gen.get(target);
    let size = settings
        .and_then(|s| s.size.clone())
        .unwrap_or_else(|| "1024x1024".to_owned());
    let quality = settings.and_then(|s| s.quality.clone());
    let aspect_ratio = settings.and_then(|s| s.aspect_ratio.clone());
    let image_size = settings.and_then(|s| s.image_size.clone());

    Ok(ImageGenConfig {
        provider: provider_key.to_owned(),
        model_id: model_id.to_owned(),
        api_key,
        base_url,
        size,
        quality,
        aspect_ratio,
        image_size,
    })
}

// ---------------------------------------------------------------------------
// Compaction tail shape
// ---------------------------------------------------------------------------

/// Number of new entries appended to the chat prefix when building a
/// compaction request: one `role:"user"` ("compact now") plus one
/// `role:"system"` (the compaction instruction). The system entry sits at
/// a fixed index immediately after the user entry; the compaction tool
/// loop pushes assistant + user(tool_result) AFTER that, so the system
/// entry's position never shifts across iterations.
///
/// Why the inline `role:"system"` shape:
///
/// The compaction instruction is pushed inline via
/// [`shore_llm::types::LlmRequest::push_inline_system`] at build time, so
/// its *index* in `messages` is fixed before the tool loop starts. Each
/// sidecar adapter then handles it the way that provider dialect expects
/// (Anthropic-family providers merge into the preceding user; OpenAI-family
/// providers either emit a real `role:"system"` or wrap it as a user with
/// `<system_instruction>` XML). Because the inline system index is fixed, any
/// provider-side merge/wrap target is fixed too, so the bytes at every
/// position ≤ the system index are byte-stable across tool-loop rounds and
/// Anthropic's content-addressed prefix cache stays valid.
///
/// The earlier `system_suffix` affordance was removed precisely because it
/// re-expanded the instruction at the *moving* tail on every `generate()`
/// call, busting the cache; see `push_inline_system`'s doc-comment for the
/// full history (PRs #80, #84).
///
/// The regression contract is pinned by
/// `compaction_tool_loop_keeps_compact_now_user_byte_stable_across_rounds`
/// in this module.
pub const COMPACTION_TAIL_ENTRY_COUNT: usize = 2;

/// Apply the canonical compaction tail to a chat-shape request.
///
/// The caller is responsible for having rebuilt the request against the
/// compaction model (e.g. via `LedgerClient::build_request_with_provider_keys`
/// with chat's `system`/`tools`/`messages`). This helper makes the "what to
/// append" step a single named operation rather than two open-coded field
/// mutations, so the wire-shape invariant is visible at every call site.
///
/// The compaction instruction is pushed inline as `{"role":"system",...}`
/// — see [`COMPACTION_TAIL_ENTRY_COUNT`] for why this is the only safe
/// shape across the compaction tool loop.
fn append_compaction_tail(
    request: &mut LlmRequest,
    user_prompt: serde_json::Value,
    system_prompt: &str,
) {
    request.messages.push(user_prompt);
    request.push_inline_system(system_prompt);
}

// ---------------------------------------------------------------------------
// RealCompactionLlm
// ---------------------------------------------------------------------------

/// Production `CompactionLlm` backed by `LedgerClient` (ledger-tracked LLM calls).
///
/// Returns raw LLM text — the compaction library handles XML parsing.
#[derive(Debug)]
pub struct RealCompactionLlm {
    client: LedgerClient,
    model: ResolvedModel,
    /// Snapshot of the provider registry so the request honors
    /// `[providers.<name>].keys`. Without this, compaction would only
    /// look at `model.api_key_env` and fail with `MissingApiKey` for
    /// users who configure provider-level keys.
    providers: ProviderRegistry,
    character: String,
}

impl RealCompactionLlm {
    pub fn new(
        client: LedgerClient,
        model: ResolvedModel,
        providers: ProviderRegistry,
        character: String,
    ) -> Self {
        Self {
            client,
            model,
            providers,
            character,
        }
    }

    fn build_compaction_request(
        &self,
        system: &str,
        compact_now_user: serde_json::Value,
        chat_request: LlmRequest,
    ) -> Result<LlmRequest, CompactionError> {
        // Compaction is, semantically, chat with one extra system message
        // appended. We rebuild against the compaction model+sampler
        // settings so the LLM call goes to the compaction model, but the
        // cacheable prefix — `system`, `tools`, `messages` — comes through
        // verbatim from chat. Anthropic's prompt-cache hash covers all
        // three, so this is the lever that keeps compaction's call hitting
        // the cache chat seeded for this conversation. The compaction
        // instruction is pinned at a fixed inline `role:"system"` slot via
        // `push_inline_system` (see `append_compaction_tail`); the sidecar's
        // provider adapter may merge/wrap it, but the canonical daemon slot
        // is stable before any tool-loop continuation is appended.
        //
        // `chat_request` is either the live in-memory `last_request` (cache
        // is warm) or a chat-shape request rebuilt from disk via
        // `handler::build_chat_shape_request_from_disk` (cache is cold). The
        // wire shape is identical either way — that's the whole point of
        // unifying the two paths.
        let mut request = LedgerClient::build_request_with_provider_keys(
            &self.model,
            &self.providers,
            chat_request.messages,
            chat_request.system,
            chat_request.tools,
            None,
        )
        .map_err(|e| CompactionError::Llm(e.to_string()))?;
        append_compaction_tail(&mut request, compact_now_user, system);

        request.rid = None;
        request.forensic_character = Some(self.character.clone());
        // Compaction is low-frequency and high-value for cache-regression
        // forensics — route its payload log to the long-retention tier.
        request.retain_long = true;

        Ok(request)
    }
}

impl CompactionLlm for RealCompactionLlm {
    fn build_initial_request(
        &self,
        system: &str,
        compact_now_user: serde_json::Value,
        chat_request: LlmRequest,
    ) -> Result<LlmRequest, CompactionError> {
        let chat_msg_count = chat_request.messages.len();
        let chat_tools_count = chat_request.tools.as_ref().map_or(0, Vec::len);
        let request = self.build_compaction_request(system, compact_now_user, chat_request)?;
        debug!(
            system_len = system.len(),
            chat_msg_count, chat_tools_count, "compaction: initial request built from chat prefix"
        );
        Ok(request)
    }

    fn generate<'src>(
        &'src self,
        request: &'src mut LlmRequest,
    ) -> Pin<Box<dyn Future<Output = Result<GenerateResponse, CompactionError>> + Send + 'src>>
    {
        Box::pin(async move {
            let t0 = std::time::Instant::now();
            let (resp, _fallback_events) = self
                .client
                .generate_with_credential_fallback(
                    request,
                    &self.model,
                    &self.providers,
                    CallType::Compaction,
                    &self.character,
                    false,
                )
                .await
                .map_err(|e| CompactionError::Llm(e.to_string()))?;
            debug!(
                elapsed = ?t0.elapsed(),
                content_len = resp.content.len(),
                content_blocks = resp.content_blocks.len(),
                finish_reason = %resp.finish_reason,
                "compaction: LLM generate round done"
            );
            Ok(resp)
        })
    }
}

/// Production `ConversationManager` that archives conversations to segment
/// files with message retention.
#[derive(Debug)]
pub struct RealConversationManager {
    character_dir: PathBuf,
}

impl RealConversationManager {
    pub fn new(character_dir: &Path) -> Self {
        Self {
            character_dir: character_dir.to_path_buf(),
        }
    }

    pub fn archive_and_retain(
        &self,
        _conversation_id: &str,
        params: &RetentionParams,
    ) -> Result<String, CompactionError> {
        let started = std::time::Instant::now();
        let active_path = self.character_dir.join(shore_config::ACTIVE_JSONL_FILE);

        // Use pre-read content from params to avoid TOCTOU race — the file
        // may have changed since compact() parsed the messages.
        let lines: Vec<&str> = params
            .active_content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .collect();

        let keep = params.keep_last_n.min(lines.len());
        let split_at = lines.len().saturating_sub(keep);

        let archive_lines = lines.get(..split_at).unwrap_or(&[]);
        let retained_lines = lines.get(split_at..).unwrap_or(&[]);

        // Archive the compacted portion to a segment file.
        if !archive_lines.is_empty() {
            let manifest_path = self
                .character_dir
                .join(shore_config::COMPACTION_MANIFEST_FILE);
            let mut manifest: CompactionManifest = if manifest_path.exists() {
                let mf = std::fs::read_to_string(&manifest_path).map_err(|e| {
                    CompactionError::ConversationManager(format!(
                        "failed to read compaction.json: {e}"
                    ))
                })?;
                serde_json::from_str(&mf).map_err(|e| {
                    CompactionError::ConversationManager(format!(
                        "failed to parse compaction.json: {e}"
                    ))
                })?
            } else {
                CompactionManifest::default()
            };

            let segment_index = manifest.segments.len().saturating_add(1);
            let segment_file = format!("{segment_index:04}.jsonl");
            let segments_dir = self.character_dir.join(shore_config::SEGMENTS_DIR);

            std::fs::create_dir_all(&segments_dir).map_err(|e| {
                CompactionError::ConversationManager(format!("failed to create segments dir: {e}"))
            })?;

            // Write segment (archived messages only).
            let segment_content = archive_lines.join("\n") + "\n";
            std::fs::write(segments_dir.join(&segment_file), &segment_content).map_err(|e| {
                CompactionError::ConversationManager(format!("failed to write segment file: {e}"))
            })?;

            manifest.segments.push(SegmentEntry {
                file: segment_file,
                message_count: archive_lines.len(),
                compacted_at: Local::now().to_rfc3339(),
            });
            manifest.total_compacted_messages = manifest
                .total_compacted_messages
                .saturating_add(archive_lines.len());

            let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| {
                CompactionError::ConversationManager(format!("failed to serialize manifest: {e}"))
            })?;
            std::fs::write(&manifest_path, manifest_json).map_err(|e| {
                CompactionError::ConversationManager(format!(
                    "failed to write compaction.json: {e}"
                ))
            })?;
        }

        // Write retained messages back to active.jsonl.
        let retained_content = if retained_lines.is_empty() {
            String::new()
        } else {
            retained_lines.join("\n") + "\n"
        };
        crate::engine::atomic::atomic_write(&active_path, retained_content.as_bytes()).map_err(
            |e| {
                CompactionError::ConversationManager(format!(
                    "failed to write retained messages: {e}"
                ))
            },
        )?;

        debug!(
            archived = archive_lines.len(),
            retained = retained_lines.len(),
            elapsed = ?started.elapsed(),
            "compaction: archive/retain file mutation complete"
        );
        Ok(Uuid::new_v4().to_string())
    }
}

impl ConversationManager for RealConversationManager {
    fn archive_and_retain(
        &self,
        conversation_id: &str,
        params: RetentionParams,
    ) -> Pin<Box<dyn Future<Output = Result<String, CompactionError>> + Send + '_>> {
        let character_dir = self.character_dir.clone();
        let owned_conversation_id = conversation_id.to_owned();

        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mgr = RealConversationManager { character_dir };
                mgr.archive_and_retain(&owned_conversation_id, &params)
            })
            .await
            .map_err(|e| {
                CompactionError::ConversationManager(format!(
                    "archive_and_retain task failed to join: {e}"
                ))
            })?
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use shore_config::models::{ModelConfigFields, Sdk};
    use tempfile::TempDir;

    fn test_compaction_model(api_key_env: &str) -> ResolvedModel {
        ResolvedModel::from_parts(
            "compact".to_owned(),
            "chat.anthropic.compact".to_owned(),
            "chat".to_owned(),
            "anthropic".to_owned(),
            "compaction-model".to_owned(),
            Sdk::Anthropic,
            ModelConfigFields {
                sdk: Some(Sdk::Anthropic),
                api_key_env: Some(api_key_env.to_owned()),
                base_url: Some("http://compaction.example".to_owned()),
                max_output_tokens: Some(777),
                temperature: Some(0.25),
                reasoning_effort: Some("medium".to_owned()),
                ..Default::default()
            },
        )
    }

    fn test_openai_compaction_model(api_key_env: &str) -> ResolvedModel {
        ResolvedModel::from_parts(
            "gpt".to_owned(),
            "chat.openai.gpt".to_owned(),
            "chat".to_owned(),
            "openai".to_owned(),
            "gpt-4o".to_owned(),
            Sdk::Openai,
            ModelConfigFields {
                sdk: Some(Sdk::Openai),
                api_key_env: Some(api_key_env.to_owned()),
                base_url: Some("http://compaction-openai.example".to_owned()),
                max_output_tokens: Some(777),
                ..Default::default()
            },
        )
    }

    /// Helper: build an Anthropic-style chat-shape request to feed into the
    /// compaction request builder. Mirrors what `prepare_chat_context` +
    /// `build_request_with_provider_keys` would produce (or what chat's
    /// in-memory `last_request` would carry).
    fn chat_shape_request(
        sdk: Sdk,
        system: Option<serde_json::Value>,
        tools: Option<Vec<serde_json::Value>>,
        messages: Vec<serde_json::Value>,
    ) -> LlmRequest {
        LlmRequest {
            sdk,
            model: "chat-model".to_owned(),
            api_key: "chat-secret".to_owned(),
            api_key_name: None,
            base_url: Some("http://chat.example".to_owned()),
            messages,
            system,
            tools,
            max_tokens: 42,
            temperature: Some(0.9),
            top_p: Some(0.8),
            provider_options: Some(json!({
                "cache_ttl": "1h",
                "chat_only": true
            })),
            provider_key: Some("anthropic".to_owned()),
            rid: Some("rid-chat".to_owned()),
            forensic_character: Some("chat-forensics".to_owned()),
            retain_long: false,
            keepalive_interval: None,
        }
    }

    #[test]
    fn compaction_request_keeps_chat_prefix_but_uses_compaction_settings() {
        let api_key_env = format!("SHORE_TEST_COMPACTION_{}", Uuid::new_v4().simple());
        std::env::set_var(&api_key_env, "compaction-secret");
        let model = test_compaction_model(&api_key_env);
        let ledger_tmp = TempDir::new().unwrap();
        let llm = RealCompactionLlm::new(
            LedgerClient::new(
                shore_llm::LlmClient::try_new().unwrap(),
                &ledger_tmp.path().join("ledger.db"),
            )
            .unwrap(),
            model,
            ProviderRegistry::default(),
            "alice".to_owned(),
        );
        let chat_request = chat_shape_request(
            Sdk::Anthropic,
            Some(json!("cached system")),
            Some(vec![json!({
                "name": "read",
                "description": "chat tool — compaction inherits it to preserve the cache prefix hash",
                "input_schema": { "type": "object" }
            })]),
            vec![
                json!({"role": "user", "content": "cached user"}),
                json!({"role": "assistant", "content": "cached assistant"}),
            ],
        );

        let request = llm
            .build_compaction_request(
                "compaction system",
                json!({"role": "user", "content": "compact now"}),
                chat_request,
            )
            .unwrap();

        std::env::remove_var(&api_key_env);

        assert_eq!(request.model, "compaction-model");
        assert_eq!(request.api_key, "compaction-secret");
        assert_eq!(
            request.base_url.as_deref(),
            Some("http://compaction.example")
        );
        assert_eq!(request.max_tokens, 777);
        assert_eq!(request.temperature, Some(0.25));
        assert_eq!(request.top_p, None);
        let tools = request
            .tools
            .as_ref()
            .expect("chat tools must pass through so the cache prefix hash matches");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "read");
        assert_eq!(request.rid, None);
        assert_eq!(request.forensic_character.as_deref(), Some("alice"));
        assert_eq!(request.system, Some(json!("cached system")));
        // The compaction prompt rides inline as a `role:"system"` entry at
        // a fixed slot right after compact_now_user. Adapters that natively
        // accept inline system messages emit it as `role:"system"`; the
        // others wrap it via `<system_instruction>` XML. Either way the
        // entry's POSITION in `messages` is fixed across tool-loop rounds,
        // which is what keeps the compact_now_user byte-stable and the
        // Anthropic cache prefix valid (see COMPACTION_TAIL_ENTRY_COUNT).
        assert_eq!(request.messages.len(), 4);
        assert_eq!(request.messages[0]["content"], "cached user");
        assert_eq!(request.messages[1]["content"], "cached assistant");
        assert_eq!(request.messages[2]["content"], "compact now");
        assert_eq!(request.messages[3]["role"], "system");
        assert_eq!(request.messages[3]["content"], "compaction system");

        let provider_options = request.provider_options.expect("provider options");
        assert_eq!(provider_options["reasoning_effort"], "medium");
        assert!(provider_options.get("chat_only").is_none());
    }

    /// Regression pin: every byte that contributes to Anthropic's cache-prefix
    /// hash (system, tools, first N messages, max_output_tokens-style sampler config
    /// when emitted in the body) must match between the chat request that
    /// seeded the cache and the compaction request the daemon issues moments
    /// later. If a future refactor changes any of these, this test fails
    /// immediately rather than going silently undetected by manifesting as a
    /// ~40% API-spend regression in production.
    #[test]
    fn compaction_request_matches_chat_prefix_byte_for_byte() {
        let api_key_env = format!("SHORE_TEST_COMPACTION_PREFIX_{}", Uuid::new_v4().simple());
        std::env::set_var(&api_key_env, "compaction-secret");
        let model = test_compaction_model(&api_key_env);
        let ledger_tmp = TempDir::new().unwrap();
        let llm = RealCompactionLlm::new(
            LedgerClient::new(
                shore_llm::LlmClient::try_new().unwrap(),
                &ledger_tmp.path().join("ledger.db"),
            )
            .unwrap(),
            model,
            ProviderRegistry::default(),
            "alice".to_owned(),
        );

        let chat_tools = vec![json!({
            "name": "read",
            "description": "exact-byte tool definition",
            "input_schema": { "type": "object", "properties": {} }
        })];
        let chat_messages = vec![
            json!({"role": "user", "content": "cached user 1"}),
            json!({"role": "assistant", "content": "cached assistant 1"}),
            json!({"role": "user", "content": "cached user 2"}),
        ];
        let chat_system = Some(json!("chat system prompt"));

        let chat_request = chat_shape_request(
            Sdk::Anthropic,
            chat_system.clone(),
            Some(chat_tools.clone()),
            chat_messages.clone(),
        );

        let request = llm
            .build_compaction_request(
                "compaction system prompt",
                json!({"role": "user", "content": "compact now"}),
                chat_request,
            )
            .unwrap();

        std::env::remove_var(&api_key_env);

        // Prefix portion: system + tools + first len(chat_messages) entries.
        assert_eq!(
            request.system, chat_system,
            "system block diverged — would invalidate Anthropic cache prefix"
        );
        assert_eq!(
            request.tools.as_deref(),
            Some(chat_tools.as_slice()),
            "tools array diverged — Anthropic hashes tools into the cache prefix"
        );
        for (i, expected) in chat_messages.iter().enumerate() {
            assert_eq!(
                &request.messages[i], expected,
                "message {i} diverged from chat prefix — cache invalidation"
            );
        }
        // The compaction-specific tail rides after the prefix: one
        // compact_now user message, then one inline `role:"system"` entry
        // (the compaction instruction). The system entry sits at a fixed
        // slot so subsequent tool-loop messages can't shift it, which is
        // what keeps the cache prefix byte-stable across compaction rounds.
        assert_eq!(request.messages.len(), chat_messages.len() + 2);
        let tail_user = &request.messages[chat_messages.len()];
        assert_eq!(tail_user["role"], "user");
        assert_eq!(tail_user["content"], "compact now");
        let tail_system = &request.messages[chat_messages.len() + 1];
        assert_eq!(tail_system["role"], "system");
        assert_eq!(tail_system["content"], "compaction system prompt");
    }

    /// The unified compaction path must work for non-Anthropic SDKs too:
    /// the compaction prompt is pushed inline as `{"role":"system", ...}`
    /// at a fixed slot regardless of provider. Each adapter then decides
    /// how to emit it on the wire — Anthropic merges into the preceding
    /// user; OpenAI-compatible providers either emit a real `role:"system"`
    /// mid-history (Z.ai) or wrap as a user with `<system_instruction>` XML
    /// (OpenRouter, most chat-completions backends). That conversion now
    /// lives in the sidecar.
    #[test]
    fn compaction_request_carries_inline_system_for_openai_sdk() {
        let api_key_env = format!("SHORE_TEST_OPENAI_COMPACTION_{}", Uuid::new_v4().simple());
        std::env::set_var(&api_key_env, "openai-secret");
        let model = test_openai_compaction_model(&api_key_env);
        let ledger_tmp = TempDir::new().unwrap();
        let llm = RealCompactionLlm::new(
            LedgerClient::new(
                shore_llm::LlmClient::try_new().unwrap(),
                &ledger_tmp.path().join("ledger.db"),
            )
            .unwrap(),
            model,
            ProviderRegistry::default(),
            "alice".to_owned(),
        );

        let chat_request = chat_shape_request(
            Sdk::Openai,
            Some(json!("chat system prompt")),
            None,
            vec![json!({"role": "user", "content": "hi"})],
        );

        let request = llm
            .build_compaction_request(
                "compaction system",
                json!({"role": "user", "content": "compact now"}),
                chat_request,
            )
            .unwrap();

        std::env::remove_var(&api_key_env);

        assert_eq!(request.sdk, Sdk::Openai);
        // Chat's system block passes through verbatim, regardless of SDK.
        assert_eq!(request.system, Some(json!("chat system prompt")));
        // The compaction instruction rides inline as a `role:"system"`
        // entry at a fixed slot; the sidecar adapter handles OpenAI-family
        // provider-specific wrapping at dispatch time.
        assert_eq!(request.messages.len(), 3);
        assert_eq!(request.messages[0]["content"], "hi");
        assert_eq!(request.messages[1]["content"], "compact now");
        assert_eq!(request.messages[2]["role"], "system");
        assert_eq!(request.messages[2]["content"], "compaction system");
    }

    // -- RealConversationManager: archive_and_retain --------------------------

    #[test]
    fn archive_and_retain_splits_messages() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let msg1 =
            r#"{"msg_id":"m1","role":"User","content":"hello","images":[],"timestamp":"t1"}"#;
        let msg2 =
            r#"{"msg_id":"m2","role":"Assistant","content":"hi","images":[],"timestamp":"t2"}"#;
        let msg3 = r#"{"msg_id":"m3","role":"User","content":"bye","images":[],"timestamp":"t3"}"#;
        let content = format!("{msg1}\n{msg2}\n{msg3}\n");
        std::fs::write(dir.join("active.jsonl"), &content).unwrap();

        let mgr = RealConversationManager::new(dir);
        let new_id = mgr
            .archive_and_retain(
                "test-conv",
                &RetentionParams {
                    keep_last_n: 1,
                    active_content: content,
                },
            )
            .unwrap();

        assert!(!new_id.is_empty());

        // Segment should have the first 2 messages.
        let seg = std::fs::read_to_string(dir.join("segments/0001.jsonl")).unwrap();
        assert!(seg.contains("m1"));
        assert!(seg.contains("m2"));
        assert!(!seg.contains("m3"));

        // active.jsonl should have only the retained message.
        let active = std::fs::read_to_string(dir.join("active.jsonl")).unwrap();
        assert!(!active.contains("m1"));
        assert!(!active.contains("m2"));
        assert!(active.contains("m3"));

        // Manifest should be updated.
        let manifest: CompactionManifest =
            serde_json::from_str(&std::fs::read_to_string(dir.join("compaction.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.segments.len(), 1);
        assert_eq!(manifest.segments[0].message_count, 2);
        assert_eq!(manifest.total_compacted_messages, 2);
    }

    #[test]
    fn archive_and_retain_keep_all() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let msg1 =
            r#"{"msg_id":"m1","role":"User","content":"hello","images":[],"timestamp":"t1"}"#;
        let msg2 =
            r#"{"msg_id":"m2","role":"User","content":"world","images":[],"timestamp":"t2"}"#;
        let content = format!("{msg1}\n{msg2}\n");
        std::fs::write(dir.join("active.jsonl"), &content).unwrap();

        let mgr = RealConversationManager::new(dir);
        let _ignored = mgr
            .archive_and_retain(
                "conv",
                &RetentionParams {
                    keep_last_n: 5, // more than available
                    active_content: content,
                },
            )
            .unwrap();

        // All messages retained, no segment created.
        let active = std::fs::read_to_string(dir.join("active.jsonl")).unwrap();
        assert!(active.contains("m1"));
        assert!(active.contains("m2"));
        assert!(!dir.join("segments").exists());
    }

    #[test]
    fn archive_increments_segment_number() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        // Create an existing manifest with one segment.
        let manifest = CompactionManifest {
            segments: vec![SegmentEntry {
                file: "0001.jsonl".into(),
                message_count: 5,
                compacted_at: "2026-01-01T00:00:00Z".into(),
            }],
            total_compacted_messages: 5,
        };
        std::fs::write(
            dir.join("compaction.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("segments")).unwrap();

        let msg = r#"{"msg_id":"m3","role":"User","content":"test","images":[],"timestamp":"t"}"#;
        let content = format!("{msg}\n");
        std::fs::write(dir.join("active.jsonl"), &content).unwrap();

        let mgr = RealConversationManager::new(dir);
        let _ignored = mgr
            .archive_and_retain(
                "conv",
                &RetentionParams {
                    keep_last_n: 0,
                    active_content: content,
                },
            )
            .unwrap();

        assert!(dir.join("segments/0002.jsonl").exists());

        let reloaded_manifest: CompactionManifest =
            serde_json::from_str(&std::fs::read_to_string(dir.join("compaction.json")).unwrap())
                .unwrap();
        assert_eq!(reloaded_manifest.segments.len(), 2);
        assert_eq!(reloaded_manifest.segments[1].file, "0002.jsonl");
        assert_eq!(reloaded_manifest.total_compacted_messages, 6);
    }

    #[test]
    fn archive_with_malformed_jsonl_lines() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let valid1 =
            r#"{"msg_id":"m1","role":"User","content":"hello","images":[],"timestamp":"t1"}"#;
        let garbage = r"corrupted{{{not valid json at all";
        let valid2 =
            r#"{"msg_id":"m2","role":"User","content":"bye","images":[],"timestamp":"t2"}"#;
        let content = format!("{valid1}\n{garbage}\n{valid2}\n");
        std::fs::write(dir.join("active.jsonl"), &content).unwrap();

        let mgr = RealConversationManager::new(dir);
        let new_id = mgr
            .archive_and_retain(
                "conv",
                &RetentionParams {
                    keep_last_n: 1,
                    active_content: content,
                },
            )
            .unwrap();
        assert!(!new_id.is_empty());

        // Segment should contain the first 2 lines (valid + garbage).
        let seg = std::fs::read_to_string(dir.join("segments/0001.jsonl")).unwrap();
        assert!(seg.contains("m1"));
        assert!(seg.contains("corrupted{{{"));
        assert!(!seg.contains("m2"));

        // active.jsonl retains only the last valid message.
        let active = std::fs::read_to_string(dir.join("active.jsonl")).unwrap();
        assert!(active.contains("m2"));
        assert!(!active.contains("m1"));

        // Manifest reflects line count (not JSON validity).
        let manifest: CompactionManifest =
            serde_json::from_str(&std::fs::read_to_string(dir.join("compaction.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.segments[0].message_count, 2);
    }

    #[test]
    fn archive_segment_write_fails_on_readonly_dir() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let msg1 =
            r#"{"msg_id":"m1","role":"User","content":"hello","images":[],"timestamp":"t1"}"#;
        let msg2 =
            r#"{"msg_id":"m2","role":"User","content":"world","images":[],"timestamp":"t2"}"#;
        let content = format!("{msg1}\n{msg2}\n");
        std::fs::write(dir.join("active.jsonl"), &content).unwrap();

        // Pre-create the segments dir as read-only so the write fails.
        let segments_dir = dir.join("segments");
        std::fs::create_dir_all(&segments_dir).unwrap();
        std::fs::set_permissions(&segments_dir, std::fs::Permissions::from_mode(0o444)).unwrap();

        let mgr = RealConversationManager::new(dir);
        let result = mgr.archive_and_retain(
            "conv",
            &RetentionParams {
                keep_last_n: 1,
                active_content: content,
            },
        );

        // Restore permissions so TempDir cleanup succeeds.
        std::fs::set_permissions(&segments_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("failed to write segment file"),
            "Expected segment write error, got: {err_msg}"
        );
    }

    #[test]
    fn archive_manifest_write_fails_on_readonly_parent() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let msg1 =
            r#"{"msg_id":"m1","role":"User","content":"hello","images":[],"timestamp":"t1"}"#;
        let msg2 =
            r#"{"msg_id":"m2","role":"User","content":"world","images":[],"timestamp":"t2"}"#;
        let content = format!("{msg1}\n{msg2}\n");
        std::fs::write(dir.join("active.jsonl"), &content).unwrap();

        // Segments dir is writable (so segment write succeeds), but make the
        // parent dir read-only AFTER writing active.jsonl so manifest write fails.
        // Actually, we need to let segments dir creation succeed then block the
        // manifest write. Easiest: pre-create segments dir, pre-create
        // compaction.json as a directory so the write fails.
        std::fs::create_dir_all(dir.join("segments")).unwrap();
        // Create compaction.json as a directory — writing to it will fail.
        std::fs::create_dir_all(dir.join("compaction.json")).unwrap();

        let mgr = RealConversationManager::new(dir);
        let result = mgr.archive_and_retain(
            "conv",
            &RetentionParams {
                keep_last_n: 1,
                active_content: content,
            },
        );

        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("compaction.json"),
            "Expected compaction.json error, got: {err_msg}"
        );
    }

    #[test]
    fn archive_empty_content_is_noop() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        // Empty active_content means nothing to archive or retain.
        let mgr = RealConversationManager::new(dir);
        let result = mgr.archive_and_retain(
            "conv",
            &RetentionParams {
                keep_last_n: 1,
                active_content: String::new(),
            },
        );

        // Should succeed — no segments created, empty active.jsonl written.
        assert!(result.is_ok());
        assert!(!dir.join("segments").exists());
    }
}
