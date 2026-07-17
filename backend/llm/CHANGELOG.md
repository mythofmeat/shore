# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.12](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.11...shore-llm-v0.1.12) - 2026-07-17

### Other

- updated the following local packages: shore-config

## [0.1.11](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.10...shore-llm-v0.1.11) - 2026-07-17

### Other

- updated the following local packages: shore-config

## [0.1.10](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.9...shore-llm-v0.1.10) - 2026-07-16

### Other

- updated the following local packages: shore-config

## [0.1.9](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.8...shore-llm-v0.1.9) - 2026-07-04

### Other

- updated the following local packages: shore-protocol

## [0.1.8](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.7...shore-llm-v0.1.8) - 2026-06-22

### Other

- updated the following local packages: shore-config

## [0.1.7](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.6...shore-llm-v0.1.7) - 2026-06-18

### Added

- *(providers)* add opencode-go subscription provider ([#290](https://github.com/mythofmeat/shore-core/pull/290))

## [0.1.6](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.5...shore-llm-v0.1.6) - 2026-06-16

### Other

- updated the following local packages: shore-call-store

## [0.1.5](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.4...shore-llm-v0.1.5) - 2026-06-15

### Added

- unified observability store for LLM calls (shore log --api/--heartbeat/--dreaming) ([#278](https://github.com/mythofmeat/shore-core/pull/278))

## [0.1.4](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.3...shore-llm-v0.1.4) - 2026-06-12

### Other

- updated the following local packages: shore-protocol

## [0.1.3](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.2...shore-llm-v0.1.3) - 2026-06-12

### Other

- updated the following local packages: shore-config

## [0.1.2](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.1...shore-llm-v0.1.2) - 2026-06-11

### Fixed

- *(llm)* redact api_key from Debug output to stop tracing-log leak ([#242](https://github.com/mythofmeat/shore-core/pull/242))

### Other

- burn down production string_slice panic-safety waivers ([#243](https://github.com/mythofmeat/shore-core/pull/243))
- too_many_lines threshold 100 -> 80 ([#199](https://github.com/mythofmeat/shore-core/pull/199)) ([#244](https://github.com/mythofmeat/shore-core/pull/244))

## [0.1.1](https://github.com/mythofmeat/shore-core/compare/shore-llm-v0.1.0...shore-llm-v0.1.1) - 2026-06-10

### Other

- updated the following local packages: shore-protocol, shore-config

## [12.0.1](https://github.com/mythofmeat/shore-core/compare/shore-llm-v12.0.0...shore-llm-v12.0.1) - 2026-06-09

### Other

- Sub-agent delegation, opt-in [tools] config, and `shore tools` ([#226](https://github.com/mythofmeat/shore-core/pull/226))

## [12.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v11.0.0...shore-llm-v12.0.0) - 2026-06-07

### Fixed

- *(sidecar,daemon)* keep quiet streams alive with ping keepalives + retry tool loops ([#223](https://github.com/mythofmeat/shore-core/pull/223))

## [11.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v10.0.0...shore-llm-v11.0.0) - 2026-06-05

### Added

- *(tools)* unify tool-loop cap as per-model max_tool_iterations (default unlimited) ([#215](https://github.com/mythofmeat/shore-core/pull/215))
- *(keepalive)* per-model cache_keepalive + global cap, decouple from heartbeat ([#213](https://github.com/mythofmeat/shore-core/pull/213))

### Breaking

- **LlmRequest field addition**: The `LlmRequest` struct now includes a `keepalive_interval: Option<std::time::Duration>` field (line 89 in `types.rs`). This transient daemon-side scheduling hint carries the resolved per-model cache-keepalive interval for the autonomy manager's standalone keepalive subsystem.

  **Migration**: Update all code that constructs `LlmRequest` directly to include the new field:

  ```rust
  // Before (10.0.0):
  // let request = LlmRequest {
  //     sdk: Sdk::Anthropic,
  //     model: "claude-sonnet-4-20250514".into(),
  //     api_key: "sk-test".into(),
  //     ...
  // };

  // After (11.0.0):
  let request = LlmRequest {
      sdk: Sdk::Anthropic,
      model: "claude-sonnet-4-20250514".into(),
      api_key: "sk-test".into(),
      // ... other fields ...
      keepalive_interval: None,  // or Some(Duration::from_secs(3300)) for 55m
  };
  ```

  Set `keepalive_interval` to `Some(interval)` when keepalive is enabled for the model, or `None` when disabled. The field is marked `#[serde(skip)]` and never sent to providers. See PR [#213](https://github.com/mythofmeat/shore-core/pull/213).

## [10.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v9.0.0...shore-llm-v10.0.0) - 2026-06-05

### Fixed

- *(ledger)* record cache write billed before a mid-stream error ([#204](https://github.com/mythofmeat/shore-core/pull/204))

## [9.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v8.0.0...shore-llm-v9.0.0) - 2026-06-04

### Other

- control-flow & type-surface strictness (else_if_without_else / impl_trait_in_params) ([#155](https://github.com/mythofmeat/shore-core/pull/155)) ([#196](https://github.com/mythofmeat/shore-core/pull/196))
- integer & float arithmetic discipline ([#153](https://github.com/mythofmeat/shore-core/pull/153)) ([#194](https://github.com/mythofmeat/shore-core/pull/194))
- ban variable shadowing (shadow_same/reuse/unrelated) ([#151](https://github.com/mythofmeat/shore-core/pull/151)) ([#192](https://github.com/mythofmeat/shore-core/pull/192))
- Enable import & literal hygiene lints ([#154](https://github.com/mythofmeat/shore-core/pull/154)) ([#185](https://github.com/mythofmeat/shore-core/pull/185))
- rename `preserve_prior_turns` to `replay_prior_thinking` ([#188](https://github.com/mythofmeat/shore-core/pull/188))
- enable string_slice + str_to_string ([#152](https://github.com/mythofmeat/shore-core/pull/152))
- Add zai discovery base_url; rewrite examples provider-first
- enable unsafe-block + assert-message hardening ([#156](https://github.com/mythofmeat/shore-core/pull/156))

## [8.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v7.0.2...shore-llm-v8.0.0) - 2026-06-03

### Other

- make LlmClient construction fallible via try_new() ([#119](https://github.com/mythofmeat/shore-core/pull/119))

## [7.0.2](https://github.com/mythofmeat/shore-core/compare/shore-llm-v7.0.1...shore-llm-v7.0.2) - 2026-06-03

### Other

- Deprecate static [chat.*]/[tools.*] catalog ([#139](https://github.com/mythofmeat/shore-core/pull/139))
- Embedding dimensions: preserve unset (None) instead of defaulting to 1536
- Address CodeRabbit review on #172 ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Native DeepSeek + Moonshot providers via the Vercel AI SDK ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Disable reasoning on OpenRouter via reasoning.effort="none" ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Unify embedding/image_generation onto provider:model_id shape ([#140](https://github.com/mythofmeat/shore-core/pull/140)) ([#169](https://github.com/mythofmeat/shore-core/pull/169))
- Correctness ratchet Tier 2: draconian clippy::restriction + rustc paranoia lints ([#115](https://github.com/mythofmeat/shore-core/pull/115)) ([#144](https://github.com/mythofmeat/shore-core/pull/144))

## [7.0.1](https://github.com/mythofmeat/shore-core/compare/shore-llm-v7.0.0...shore-llm-v7.0.1) - 2026-06-02

### Other

- LLM sidecar migration ([#123](https://github.com/mythofmeat/shore-core/pull/123)) — consolidated + OpenRouter SDK ([#128](https://github.com/mythofmeat/shore-core/pull/128))

## [7.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v6.0.3...shore-llm-v7.0.0) - 2026-05-31

### Breaking

- **RequestLog and ResponseLog now implement Copy**: Both `RequestLog` and `ResponseLog` structs gained Copy trait implementations (copy_impl_added). Adding Copy is typically non-breaking; most code requires no changes. However, this may break in rare edge cases involving:
  - Explicit negative trait bounds (e.g., `where T: !Copy`)
  - Generic constraints that require `!Copy` semantics

  **Migration**: Most code needs no changes; no `.clone()` calls are required. If you have explicit `!Copy` bounds or similar generic constraints on these types, remove or relax those bounds:

  ```rust
  // Before (7.0.0):
  // fn process<T: !Copy>(log: T) { ... } // breaks if T is RequestLog or ResponseLog

  // After (7.0.0):
  // Remove or relax the !Copy constraint:
  fn process<T>(log: T) { ... }
  // Or, if needed, adjust the constraint to allow Copy types
  ```

- **LlmClient::new and LlmClient::with_payload_logging now require #[must_use]**: The `inherent_method_must_use_added` lint now applies to `LlmClient::new` and `LlmClient::with_payload_logging`. Callsites that create an `LlmClient` but don't use the return value will now trigger compiler warnings.

  **Migration**: Ensure all callsites use the returned `LlmClient` instance, or explicitly annotate with `let _ =` if the warning is intentional:

  ```rust
  // Before (7.0.0):
  // LlmClient::new(config); // warning not emitted

  // After (7.0.0):
  let client = LlmClient::new(config); // use the client
  // or
  let _ = LlmClient::new(config); // explicitly ignore if needed
  ```

### Other

- [codex] Add correctness ratchet tier 2/3 coverage ([#121](https://github.com/mythofmeat/shore-core/pull/121))
- Correctness ratchet: strict clippy + panic hygiene + dep checks ([#114](https://github.com/mythofmeat/shore-core/pull/114))

## [6.0.3](https://github.com/mythofmeat/shore-core/compare/shore-llm-v6.0.2...shore-llm-v6.0.3) - 2026-05-31

### Other

- updated the following local packages: shore-config

## [6.0.2](https://github.com/mythofmeat/shore-core/compare/shore-llm-v6.0.1...shore-llm-v6.0.2) - 2026-05-30

### Fixed

- *(anthropic)* model-aware thinking; restore reasoning on Opus 4.8/4.7 ([#103](https://github.com/mythofmeat/shore-core/pull/103))

## [6.0.1](https://github.com/mythofmeat/shore-core/compare/shore-llm-v6.0.0...shore-llm-v6.0.1) - 2026-05-30

### Other

- updated the following local packages: shore-protocol

## [6.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v5.0.0...shore-llm-v6.0.0) - 2026-05-29

### Other

- *(config)* [**breaking**] rename max_tokens to max_output_tokens ([#94](https://github.com/mythofmeat/shore-core/pull/94))

## [5.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v4.0.1...shore-llm-v5.0.0) - 2026-05-28

### Breaking

- **`LlmRequest::system_suffix` field removed**: The `system_suffix: Option<String>` field has been removed from `LlmRequest` and replaced with the `push_inline_system(&mut self, content: impl Into<String>)` method. The old field was a footgun that caused cache-prefix drift during tool loops because `preprocess_request` re-expanded it at the current tail on every `generate()` call.

  **Migration**: Replace all uses of `system_suffix` with `push_inline_system`:

  ```rust
  // Old (5.0.0 removed this):
  // let mut request = LlmRequest {
  //     system_suffix: Some("Be concise.".into()),
  //     ..
  // };

  // New (5.0.0):
  let mut request = LlmRequest { /* fields */ };
  request.push_inline_system("Be concise.");
  ```

  The new method appends a `role:"system"` message at a fixed index in the `messages` array, preserving Anthropic's content-addressed prefix cache across tool-loop iterations. See PRs [#80](https://github.com/mythofmeat/shore-core/pull/80), [#84](https://github.com/mythofmeat/shore-core/pull/84), and [#89](https://github.com/mythofmeat/shore-core/pull/89) for implementation details.

### Fixed

- *(cache)* pin librarian/heartbeat system instruction at fixed slot ([#89](https://github.com/mythofmeat/shore-core/pull/89))

## [4.0.1](https://github.com/mythofmeat/shore-core/compare/shore-llm-v4.0.0...shore-llm-v4.0.1) - 2026-05-28

### Fixed

- *(llm)* auto-route anthropic/* through Anthropic SDK + scope wrap_inline_system to slug ([#82](https://github.com/mythofmeat/shore-core/pull/82))
- *(compaction)* pin system instruction at a fixed messages slot ([#80](https://github.com/mythofmeat/shore-core/pull/80))

## [4.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v3.0.0...shore-llm-v4.0.0) - 2026-05-27

### Fixed

- *(cache)* mirror TS daemon-ts cache behavior + wire-shape tests ([#71](https://github.com/mythofmeat/shore-core/pull/71))
- *(compaction)* drive a tool loop; guard archive on memory writes ([#43](https://github.com/mythofmeat/shore-core/pull/43)) ([#72](https://github.com/mythofmeat/shore-core/pull/72))

## [3.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v2.0.1...shore-llm-v3.0.0) - 2026-05-22

### Breaking

- `StreamEvent` added a new `ReasoningDetails { details: serde_json::Value }`
  variant for opaque provider-side reasoning metadata. The enum is exhaustive,
  so downstream `match` arms must handle the new variant.
- Inserting `ReasoningDetails` shifted the discriminants of the variants that
  follow it: `RedactedThinking` (4 → 5), `ToolUse` (5 → 6), and `Done`
  (6 → 7). Any consumer relying on the numeric discriminant via `as isize`
  (e.g. in FFI bindings or wire encodings) must be regenerated.

### Other

- [codex] stabilize OpenRouter Anthropic cache tool loops ([#29](https://github.com/mythofmeat/shore-core/pull/29))

## [2.0.1](https://github.com/mythofmeat/shore-core/compare/shore-llm-v2.0.0...shore-llm-v2.0.1) - 2026-05-22

### Fixed

- fix anthropic provider discovery ([#27](https://github.com/mythofmeat/shore-core/pull/27))

### Fixed

- Use Anthropic's native Models API headers and metadata shape for provider
  discovery.

## [2.0.0](https://github.com/mythofmeat/shore-core/compare/shore-llm-v1.8.5...shore-llm-v2.0.0) - 2026-05-21

### Other

- [codex] remove Claude Code transport ([#24](https://github.com/mythofmeat/shore-core/pull/24))
- release v1.8.5 ([#21](https://github.com/mythofmeat/shore-core/pull/21))

## [1.8.5](https://github.com/mythofmeat/shore-core/releases/tag/shore-llm-v1.8.5) - 2026-05-20

### Fixed

- fixed another claude caching during tool use issue

### Other

- *(release)* publish binary crates to crates.io, split arch package ([#20](https://github.com/mythofmeat/shore-core/pull/20))
- adopt release-plz for version bumps and changelog
- Switch property-matrix modulo checks to is_multiple_of
- Move LLM request timeout off the shared client onto per-call generates
- Guard Anthropic cache prefix invariants
- Add per-key spend attribution, cost provenance, and usage-kind grouping
- Add e2e tests pinning the 2026-05-14 refactor invariants
- Split API payload debug logs into chat / long-retention tiers
- Centralize compaction-tail shape + pin cache-breakpoint preservation
- Single source of truth for <system_instruction> tag spelling
- Collapse zai translate_messages into openai via ProviderContext flags
- Promote trailing-system instruction to LlmRequest::system_suffix
- Move disposable state to cache dir
- Remove built-in local embedder; require OpenAI-compatible profile
- Add Claude Code image attachment bridge
- Reject Claude Code image input early
- Add Claude Code native session replay
- Document Claude Code image input gap
- Add Claude Code partial streaming
- Extend Claude Code subprocess retention
- Harden Claude Code subprocess completion
- Fix Claude Code state rewrite regressions
- Fix Claude Code background and history regressions
- fix fixtures and background sessions
- harden keyed mcp sessions
- address provider review follow-ups
- claude_code regression probe
- surface usage and Max subscription telemetry
- long-lived subprocess cache
- allocate mcp session and splice tool ledger for claude_code
- Merge branch 'main' into worktree-claude-code-spike
- consolidate documentation
- Auto-refresh provider catalogs and bulk + completable refresh CLI
- Merge branch 'feat/embeddings' of github.com:mythofmeat/silvershore into feat/embeddings
- Preserve prior-turn thinking by default
- Surface static catalog in model_settings; default base_url for discovery
- Merge branch 'main' into feat/models-provider-overhaul
- Fix five regressions surfaced in provider-overhaul review
- Fix five regressions in provider-overhaul model resolution
- Merge remote-tracking branch 'origin/main' into feat/models-provider-overhaul
- Fix OpenAI-compatible reasoning replay
- Move MEMORY.md canonical path to workspace root
- Reorganize workspace layout
