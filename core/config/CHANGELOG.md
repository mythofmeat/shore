# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.18.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.17.0...shore-config-v0.18.0) - 2026-07-17

### Added

- *(tools)* [**breaking**] fold write/list_files into edit/read, replace exec with git ([#325](https://github.com/mythofmeat/shore-core/pull/325))

## [0.17.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.16.0...shore-config-v0.17.0) - 2026-07-16

### Added

- *(exec)* [**breaking**] sandbox exec subprocesses with Landlock + seccomp ([#241](https://github.com/mythofmeat/shore-core/pull/241)) ([#307](https://github.com/mythofmeat/shore-core/pull/307))
- *(memory)* [**breaking**] remove HEARTBEAT.md; MEMORY.md is the single active-memory surface ([#321](https://github.com/mythofmeat/shore-core/pull/321))

## [0.16.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.15.3...shore-config-v0.16.0) - 2026-06-22

### Added

- *(mcp)* per-server cwd for stdio MCP servers ([#305](https://github.com/mythofmeat/shore-core/pull/305))
- *(mcp)* MCP client — surface external tools to characters ([#304](https://github.com/mythofmeat/shore-core/pull/304))

## [0.15.3](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.15.2...shore-config-v0.15.3) - 2026-06-18

### Added

- *(providers)* add opencode-go subscription provider ([#290](https://github.com/mythofmeat/shore-core/pull/290))

## [0.15.2](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.15.1...shore-config-v0.15.2) - 2026-06-15

### Added

- unified observability store for LLM calls (shore log --api/--heartbeat/--dreaming) ([#278](https://github.com/mythofmeat/shore-core/pull/278))

## [0.15.1](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.15.0...shore-config-v0.15.1) - 2026-06-12

### Fixed

- *(config)* reject invalid compaction turn thresholds at config load ([#269](https://github.com/mythofmeat/shore-core/pull/269))

## [0.15.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.14.0...shore-config-v0.15.0) - 2026-06-11

### Added

- *(memory)* workspace git history — compaction and dreaming passes commit their changes ([#239](https://github.com/mythofmeat/shore-core/pull/239))

### Other

- too_many_lines threshold 100 -> 80 ([#199](https://github.com/mythofmeat/shore-core/pull/199)) ([#244](https://github.com/mythofmeat/shore-core/pull/244))
- Remove vestigial private-conversation plumbing and bring docs up to date ([#238](https://github.com/mythofmeat/shore-core/pull/238))

## [0.14.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.13.0...shore-config-v0.14.0) - 2026-06-10

### Added

- *(memory)* deep-idle archive with autonomous-message retention ([#235](https://github.com/mythofmeat/shore-core/pull/235))

## [0.13.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.12.0...shore-config-v0.13.0) - 2026-06-09

### Added

- *(config)* add [connections.matrix] mirror_all flag ([#229](https://github.com/mythofmeat/shore-core/pull/229))

### Other

- Sub-agent delegation, opt-in [tools] config, and `shore tools` ([#226](https://github.com/mythofmeat/shore-core/pull/226))

## [0.12.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.11.1...shore-config-v0.12.0) - 2026-06-05

### Added

- *(tools)* unify tool-loop cap as per-model max_tool_iterations (default unlimited) ([#215](https://github.com/mythofmeat/shore-core/pull/215))
- *(keepalive)* per-model cache_keepalive + global cap, decouple from heartbeat ([#213](https://github.com/mythofmeat/shore-core/pull/213))

### Breaking

- **ModelConfigFields and ResolvedModel field additions**: Two new configuration fields have been added to the public API:
  - `ModelConfigFields` now includes `cache_keepalive: Option<CacheKeepaliveSetting>` (line 259 in `models.rs`) for per-model cache-keepalive cadence configuration.
  - `ResolvedModel` now includes `max_tool_iterations: Option<u32>` (line 407 in `models.rs`) for per-model tool-loop iteration caps.

  **Migration**: Update code that constructs these structs:

  ```rust
  // For ModelConfigFields:
  let fields = ModelConfigFields {
      sdk: Some(Sdk::Anthropic),
      // ... other fields ...
      cache_keepalive: None,  // or Some(CacheKeepaliveSetting::Every(duration))
      ..Default::default()
  };

  // For ResolvedModel (when constructed manually):
  let model = ResolvedModel {
      name: "model-name".into(),
      // ... other fields ...
      max_tool_iterations: None,  // None = unlimited, Some(n) caps at n iterations
  };
  ```

  **Field semantics**:
  - `cache_keepalive`: `None` inherits sdk defaults (Anthropic → `"55m"`, others → `"off"`), `Some(CacheKeepaliveSetting::Off)` disables keepalive, `Some(CacheKeepaliveSetting::Every(interval))` sets the ping interval.
  - `max_tool_iterations`: `None` = unlimited iterations (new default), `Some(n)` caps the tool loop at `n` rounds (n >= 1). Applied by runtime preference overlay.

  **Removed config keys**: The old fixed tool-loop caps (`[behavior.tool_use].max_iterations` and per-task `max_tool_rounds` keys) have been removed; configurations that still set them will fail to load.

  See PRs [#215](https://github.com/mythofmeat/shore-core/pull/215), [#213](https://github.com/mythofmeat/shore-core/pull/213), and [#207](https://github.com/mythofmeat/shore-core/pull/207).

### Fixed

- *(zai)* implement GLM thinking per Z.AI docs (Preserved Thinking + disable) ([#207](https://github.com/mythofmeat/shore-core/pull/207))

## [0.11.1](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.11.0...shore-config-v0.11.1) - 2026-06-05

### Fixed

- *(capabilities)* correct DeepSeek reasoning_effort domain to high|max ([#203](https://github.com/mythofmeat/shore-core/pull/203))

## [0.11.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.10.0...shore-config-v0.11.0) - 2026-06-04

### Added

- *(thinking)* tri-state replay_prior_thinking with last_turn mode ([#191](https://github.com/mythofmeat/shore-core/pull/191)) ([#200](https://github.com/mythofmeat/shore-core/pull/200))

### Other

- control-flow & type-surface strictness (else_if_without_else / impl_trait_in_params) ([#155](https://github.com/mythofmeat/shore-core/pull/155)) ([#196](https://github.com/mythofmeat/shore-core/pull/196))
- integer & float arithmetic discipline ([#153](https://github.com/mythofmeat/shore-core/pull/153)) ([#194](https://github.com/mythofmeat/shore-core/pull/194))
- ban variable shadowing (shadow_same/reuse/unrelated) ([#151](https://github.com/mythofmeat/shore-core/pull/151)) ([#192](https://github.com/mythofmeat/shore-core/pull/192))
- Enable import & literal hygiene lints ([#154](https://github.com/mythofmeat/shore-core/pull/154)) ([#185](https://github.com/mythofmeat/shore-core/pull/185))
- rename `preserve_prior_turns` to `replay_prior_thinking` ([#188](https://github.com/mythofmeat/shore-core/pull/188))
- enable string_slice + str_to_string ([#152](https://github.com/mythofmeat/shore-core/pull/152))
- enable unsafe-block + assert-message hardening ([#156](https://github.com/mythofmeat/shore-core/pull/156))

## [0.10.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.9.0...shore-config-v0.10.0) - 2026-06-03

### Other

- Address CodeRabbit review (PR #176)
- Deprecate static [chat.*]/[tools.*] catalog ([#139](https://github.com/mythofmeat/shore-core/pull/139))
- Address CodeRabbit review on #172 ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Remove the dead `thinking_enabled` model setting ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Make `reasoning_effort = "off"` settable on Kimi/moonshot ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Native DeepSeek + Moonshot providers via the Vercel AI SDK ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Per-model OpenRouter capability resolution by model id ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Make Gemini 3.1 effort override Pro-specific (CodeRabbit #171)
- Ground capability matrix in provider docs; fix Gemini 3.x Pro effort domain ([#166](https://github.com/mythofmeat/shore-core/pull/166))
- Unify embedding/image_generation onto provider:model_id shape ([#140](https://github.com/mythofmeat/shore-core/pull/140)) ([#169](https://github.com/mythofmeat/shore-core/pull/169))
- Capability-aware `shore model setting` + single-source capabilities.toml ([#162](https://github.com/mythofmeat/shore-core/pull/162)) ([#165](https://github.com/mythofmeat/shore-core/pull/165))
- Per-sdk capability matrix in code + provider/sdk tiebreak ([#138](https://github.com/mythofmeat/shore-core/pull/138)) ([#161](https://github.com/mythofmeat/shore-core/pull/161))
- Recover #137: rehome per-provider defaults onto [providers.*.defaults] (stranded by merge race) ([#160](https://github.com/mythofmeat/shore-core/pull/160))
- Correctness ratchet Tier 2: draconian clippy::restriction + rustc paranoia lints ([#115](https://github.com/mythofmeat/shore-core/pull/115)) ([#144](https://github.com/mythofmeat/shore-core/pull/144))

## [0.9.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.8.1...shore-config-v0.9.0) - 2026-06-02

### Breaking

- shore-config (0.9.0) — breaking changes to API types and enum discriminants due to LLM sidecar migration ([#123](https://github.com/mythofmeat/shore-core/pull/123)) and OpenRouter SDK consolidation ([#128](https://github.com/mythofmeat/shore-core/pull/128)); consumers must update usages accordingly

## [0.8.1](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.8.0...shore-config-v0.8.1) - 2026-05-31

### Other

- [codex] Add correctness ratchet tier 2/3 coverage ([#121](https://github.com/mythofmeat/shore-core/pull/121))
- Correctness ratchet: strict clippy + panic hygiene + dep checks ([#114](https://github.com/mythofmeat/shore-core/pull/114))

## [0.8.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.7.0...shore-config-v0.8.0) - 2026-05-31

### Added

- *(tool_use)* truncate oversized tool results ([#110](https://github.com/mythofmeat/shore-core/pull/110))

## [0.7.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.6.0...shore-config-v0.7.0) - 2026-05-29

### Fixed

- *(catalog)* apply [chat.<provider>] defaults to discovered models + kill spurious catalog warning ([#96](https://github.com/mythofmeat/shore-core/pull/96))

### Other

- *(config)* [**breaking**] rename max_tokens to max_output_tokens ([#94](https://github.com/mythofmeat/shore-core/pull/94))

## [0.6.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.5.0...shore-config-v0.6.0) - 2026-05-28

### Fixed

- *(cache)* pin librarian/heartbeat system instruction at fixed slot ([#89](https://github.com/mythofmeat/shore-core/pull/89))
- *(dreaming)* gate scheduled sweeps on inactivity, max_lateness, optional pre-compaction ([#85](https://github.com/mythofmeat/shore-core/pull/85))

## [0.5.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.4.0...shore-config-v0.5.0) - 2026-05-27

### Fixed

- *(cache)* mirror TS daemon-ts cache behavior + wire-shape tests ([#71](https://github.com/mythofmeat/shore-core/pull/71))
- *(compaction)* drive a tool loop; guard archive on memory writes ([#43](https://github.com/mythofmeat/shore-core/pull/43)) ([#72](https://github.com/mythofmeat/shore-core/pull/72))

## [0.4.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.3.0...shore-config-v0.4.0) - 2026-05-21

### Other

- [codex] remove Claude Code transport ([#24](https://github.com/mythofmeat/shore-core/pull/24))

## [0.3.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.2.0...shore-config-v0.3.0) - 2026-05-20

### Added

- *(usage)* add custom reset anchors for usage budgets

## [0.2.0](https://github.com/mythofmeat/shore-core/compare/shore-config-v0.1.0...shore-config-v0.2.0) - 2026-05-20

### Added

- [**breaking**] remove text-to-speech support
