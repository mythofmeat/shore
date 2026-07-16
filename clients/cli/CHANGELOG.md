# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.7.1](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.7.0...shore-cli-v2.7.1) - 2026-07-16

### Other

- updated the following local packages: shore-config, shore-swp-client

## [2.7.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.6.3...shore-cli-v2.7.0) - 2026-07-15

### Added

- *(config)* add shore config reload with confirmed prompt activation ([#316](https://github.com/mythofmeat/shore-core/pull/316))

## [2.6.3](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.6.2...shore-cli-v2.6.3) - 2026-07-04

### Other

- Per-message model provenance for the memory agent ([#309](https://github.com/mythofmeat/shore-core/pull/309))

## [2.6.2](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.6.1...shore-cli-v2.6.2) - 2026-06-22

### Other

- update Cargo.lock dependencies

## [2.6.1](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.6.0...shore-cli-v2.6.1) - 2026-06-18

### Other

- updated the following local packages: shore-config, shore-swp-client

## [2.6.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.5.4...shore-cli-v2.6.0) - 2026-06-15

### Added

- unified observability store for LLM calls (shore log --api/--heartbeat/--dreaming) ([#278](https://github.com/mythofmeat/shore-core/pull/278))

## [2.5.4](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.5.3...shore-cli-v2.5.4) - 2026-06-12

### Other

- updated the following local packages: shore-protocol, shore-swp-client

## [2.5.3](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.5.2...shore-cli-v2.5.3) - 2026-06-12

### Other

- updated the following local packages: shore-config, shore-swp-client

## [2.5.2](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.5.1...shore-cli-v2.5.2) - 2026-06-11

### Other

- *(cli)* extract branch bodies from handle_log_command ([#245](https://github.com/mythofmeat/shore-core/pull/245)) ([#267](https://github.com/mythofmeat/shore-core/pull/267))
- *(cli)* decompose the transcript.rs long-function waiver ([#264](https://github.com/mythofmeat/shore-core/pull/264))

## [2.5.1](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.5.0...shore-cli-v2.5.1) - 2026-06-11

### Fixed

- *(cli)* scaffold canonical workspace layout in character --create ([#248](https://github.com/mythofmeat/shore-core/pull/248))

### Other

- burn down production string_slice panic-safety waivers ([#243](https://github.com/mythofmeat/shore-core/pull/243))
- too_many_lines threshold 100 -> 80 ([#199](https://github.com/mythofmeat/shore-core/pull/199)) ([#244](https://github.com/mythofmeat/shore-core/pull/244))

## [2.5.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.4.0...shore-cli-v2.5.0) - 2026-06-10

### Added

- *(memory)* deep-idle archive with autonomous-message retention ([#235](https://github.com/mythofmeat/shore-core/pull/235))

## [2.4.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.3.0...shore-cli-v2.4.0) - 2026-06-09

### Added

- *(cli)* hide reasoning/tools in `shore log` by default ([#231](https://github.com/mythofmeat/shore-core/pull/231))

## [2.3.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.2.0...shore-cli-v2.3.0) - 2026-06-09

### Added

- *(protocol)* tolerate unknown ServerMessage frame types ([#228](https://github.com/mythofmeat/shore-core/pull/228))
- *(cli,model-setting)* inspect + tune background-task models ([#225](https://github.com/mythofmeat/shore-core/pull/225))

### Other

- Sub-agent delegation, opt-in [tools] config, and `shore tools` ([#226](https://github.com/mythofmeat/shore-core/pull/226))

## [2.2.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.1.2...shore-cli-v2.2.0) - 2026-06-05

### Added

- *(model-setting)* expose cache_keepalive + fix max_tool_iterations CLI surface ([#217](https://github.com/mythofmeat/shore-core/pull/217))

## [2.1.2](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.1.1...shore-cli-v2.1.2) - 2026-06-05

### Other

- decompose all non-test long functions ([#198](https://github.com/mythofmeat/shore-core/pull/198)) ([#212](https://github.com/mythofmeat/shore-core/pull/212))

## [2.1.1](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.1.0...shore-cli-v2.1.1) - 2026-06-05

### Other

- updated the following local packages: shore-config, shore-swp-client

## [2.1.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.0.6...shore-cli-v2.1.0) - 2026-06-04

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
- align `shore model setting` columns

## [2.0.6](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.0.5...shore-cli-v2.0.6) - 2026-06-03

### Other

- Remove the dead `thinking_enabled` model setting ([#164](https://github.com/mythofmeat/shore-core/pull/164))
- Capability-aware `shore model setting` + single-source capabilities.toml ([#162](https://github.com/mythofmeat/shore-core/pull/162)) ([#165](https://github.com/mythofmeat/shore-core/pull/165))
- Correctness ratchet Tier 2: draconian clippy::restriction + rustc paranoia lints ([#115](https://github.com/mythofmeat/shore-core/pull/115)) ([#144](https://github.com/mythofmeat/shore-core/pull/144))

## [2.0.5](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.0.4...shore-cli-v2.0.5) - 2026-06-02

### Other

- updated the following local packages: shore-config, shore-swp-client

## [2.0.4](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.0.3...shore-cli-v2.0.4) - 2026-05-31

### Other

- [codex] Add correctness ratchet tier 2/3 coverage ([#121](https://github.com/mythofmeat/shore-core/pull/121))
- Correctness ratchet: strict clippy + panic hygiene + dep checks ([#114](https://github.com/mythofmeat/shore-core/pull/114))

## [2.0.3](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.0.2...shore-cli-v2.0.3) - 2026-05-31

### Other

- updated the following local packages: shore-config, shore-swp-client

## [2.0.2](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.0.1...shore-cli-v2.0.2) - 2026-05-30

### Fixed

- *(replay)* track provider provenance; strip non-portable thinking on provider switch ([#99](https://github.com/mythofmeat/shore-core/pull/99))

## [2.0.1](https://github.com/mythofmeat/shore-core/compare/shore-cli-v2.0.0...shore-cli-v2.0.1) - 2026-05-29

### Fixed

- *(cli)* cohesive thinking / tool / result rendering in the transcript ([#97](https://github.com/mythofmeat/shore-core/pull/97))

## [2.0.0](https://github.com/mythofmeat/shore-core/compare/shore-cli-v1.8.11...shore-cli-v2.0.0) - 2026-05-29

### Other

- *(config)* [**breaking**] rename max_tokens to max_output_tokens ([#94](https://github.com/mythofmeat/shore-core/pull/94))

## [1.8.11](https://github.com/mythofmeat/shore-core/compare/shore-cli-v1.8.10...shore-cli-v1.8.11) - 2026-05-28

### Fixed

- *(usage)* render budget reset times in local AM/PM + show window in CLI ([#86](https://github.com/mythofmeat/shore-core/pull/86))

## [1.8.10](https://github.com/mythofmeat/shore-core/compare/shore-cli-v1.8.9...shore-cli-v1.8.10) - 2026-05-28

### Fixed

- *(cli)* make model setting work for discovered models + add sdk override ([#81](https://github.com/mythofmeat/shore-core/pull/81))

## [1.8.9](https://github.com/mythofmeat/shore-core/compare/shore-cli-v1.8.8...shore-cli-v1.8.9) - 2026-05-27

### Fixed

- *(cli)* improve shore config output and add --toml/--all flags ([#76](https://github.com/mythofmeat/shore-core/pull/76))
- *(cli)* size model-list columns to widest value ([#74](https://github.com/mythofmeat/shore-core/pull/74)) ([#75](https://github.com/mythofmeat/shore-core/pull/75))
- *(compaction)* drive a tool loop; guard archive on memory writes ([#43](https://github.com/mythofmeat/shore-core/pull/43)) ([#72](https://github.com/mythofmeat/shore-core/pull/72))

## [1.8.8](https://github.com/mythofmeat/shore-core/compare/shore-cli-v1.8.7...shore-cli-v1.8.8) - 2026-05-22

### Fixed

- *(cli)* align shore usage columns and surface local reset time ([#33](https://github.com/mythofmeat/shore-core/pull/33))

## [1.8.7](https://github.com/mythofmeat/shore-core/compare/shore-cli-v1.8.6...shore-cli-v1.8.7) - 2026-05-21

### Other

- [codex] add role filtering to shore log ([#25](https://github.com/mythofmeat/shore-core/pull/25))

### Added

- Add `shore log --role` filtering for user, assistant, and system messages,
  with `character` accepted as an assistant-role alias.

## [1.8.6](https://github.com/mythofmeat/shore-core/compare/shore-cli-v1.8.5...shore-cli-v1.8.6) - 2026-05-21

### Other

- [codex] remove Claude Code transport ([#24](https://github.com/mythofmeat/shore-core/pull/24))
- release v1.8.5 ([#21](https://github.com/mythofmeat/shore-core/pull/21))

## [1.8.5](https://github.com/mythofmeat/shore-core/releases/tag/shore-cli-v1.8.5) - 2026-05-20

### Added

- [**breaking**] remove text-to-speech support

### Fixed

- lazy-load longer conversations
- fix heartbeat dreaming and memory overlaps

### Other

- *(release)* publish binary crates to crates.io, split arch package ([#20](https://github.com/mythofmeat/shore-core/pull/20))
- adopt release-plz for version bumps and changelog
- Push usage budget warnings
- Add usage budgets
- Prettify tool block formatting
- Align user-facing counts with turns
- Add per-key spend attribution, cost provenance, and usage-kind grouping
- Add hour-based usage windows (e.g. --last 4h)
- Show archived conversation segments in history
- Fix remote desktop notifications
- Add desktop notification listener
- Fix client disconnects when sending images
- Replace regenerated response swipe UX with alts
- surface usage and Max subscription telemetry
- Auto-refresh provider catalogs and bulk + completable refresh CLI
- Fold reasoning into model settings; nest matrix under connectors
- Rename discovery.visibility to discovery.ignore
- Persist heartbeat log, surface schedule in shore status
- Move dreaming state to data dir
- Merge branch 'main' into feat/models-provider-overhaul
- Fix five regressions surfaced in provider-overhaul review
- Fix five regressions in provider-overhaul model resolution
- Surface provider + sampler commands in the CLI and TUI
- Add per-provider API key fallback with non-sticky rotation
- Wire preferences into dispatch, commands, and generation path
- Merge branch 'main' into fix/dreams
- Reorganize workspace layout
