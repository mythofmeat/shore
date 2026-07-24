# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Budgets with a `pace_period` report a `pace` allowance for the current
  sub-window (`remaining / sub-windows left`), enforce their own action, and
  warn through the existing dedup table under a distinct scope.

## [0.1.17](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.16...shore-ledger-v0.1.17) - 2026-07-18

### Other

- updated the following local packages: shore-config, shore-llm

## [0.1.16](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.15...shore-ledger-v0.1.16) - 2026-07-17

### Other

- updated the following local packages: shore-config, shore-llm

## [0.1.15](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.14...shore-ledger-v0.1.15) - 2026-07-17

### Other

- updated the following local packages: shore-config, shore-llm

## [0.1.14](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.13...shore-ledger-v0.1.14) - 2026-07-16

### Other

- updated the following local packages: shore-config, shore-llm

## [0.1.13](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.12...shore-ledger-v0.1.13) - 2026-07-10

### Fixed

- *(keepalive)* never ping a cache we can't prove warm; persist schedule across restarts ([#312](https://github.com/mythofmeat/shore-core/pull/312))

## [0.1.12](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.11...shore-ledger-v0.1.12) - 2026-07-04

### Other

- Per-message model provenance for the memory agent ([#309](https://github.com/mythofmeat/shore-core/pull/309))

## [0.1.11](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.10...shore-ledger-v0.1.11) - 2026-06-22

### Other

- updated the following local packages: shore-config, shore-llm

## [0.1.10](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.9...shore-ledger-v0.1.10) - 2026-06-21

### Added

- *(ledger)* flag cold keepalive pings as a cache anomaly ([#297](https://github.com/mythofmeat/shore-core/pull/297))

## [0.1.9](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.8...shore-ledger-v0.1.9) - 2026-06-19

### Fixed

- *(ledger)* stop false cache anomalies on non-Anthropic + non-message calls ([#292](https://github.com/mythofmeat/shore-core/pull/292))

## [0.1.8](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.7...shore-ledger-v0.1.8) - 2026-06-18

### Added

- *(providers)* add opencode-go subscription provider ([#290](https://github.com/mythofmeat/shore-core/pull/290))

## [0.1.7](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.6...shore-ledger-v0.1.7) - 2026-06-16

### Other

- updated the following local packages: shore-llm

## [0.1.6](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.5...shore-ledger-v0.1.6) - 2026-06-15

### Added

- unified observability store for LLM calls (shore log --api/--heartbeat/--dreaming) ([#278](https://github.com/mythofmeat/shore-core/pull/278))

## [0.1.5](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.4...shore-ledger-v0.1.5) - 2026-06-12

### Other

- updated the following local packages: shore-llm

## [0.1.4](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.3...shore-ledger-v0.1.4) - 2026-06-12

### Other

- updated the following local packages: shore-config, shore-llm

## [0.1.3](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.2...shore-ledger-v0.1.3) - 2026-06-11

### Other

- *(ledger)* decompose the two client.rs long-function waivers ([#261](https://github.com/mythofmeat/shore-core/pull/261))

## [0.1.2](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.1...shore-ledger-v0.1.2) - 2026-06-11

### Other

- burn down production string_slice panic-safety waivers ([#243](https://github.com/mythofmeat/shore-core/pull/243))
- too_many_lines threshold 100 -> 80 ([#199](https://github.com/mythofmeat/shore-core/pull/199)) ([#244](https://github.com/mythofmeat/shore-core/pull/244))

## [0.1.1](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v0.1.0...shore-ledger-v0.1.1) - 2026-06-10

### Other

- updated the following local packages: shore-config, shore-llm

## [5.0.0](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v4.0.3...shore-ledger-v5.0.0) - 2026-06-09

### Other

- Sub-agent delegation, opt-in [tools] config, and `shore tools` ([#226](https://github.com/mythofmeat/shore-core/pull/226))

## [4.0.3](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v4.0.2...shore-ledger-v4.0.3) - 2026-06-07

### Other

- updated the following local packages: shore-llm

## [4.0.2](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v4.0.1...shore-ledger-v4.0.2) - 2026-06-06

### Fixed

- *(sidecar,ledger)* keep long quiet streams alive + never silently drop a call ([#221](https://github.com/mythofmeat/shore-core/pull/221))

## [4.0.1](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v4.0.0...shore-ledger-v4.0.1) - 2026-06-05

### Other

- updated the following local packages: shore-config, shore-llm

## [4.0.0](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v3.0.4...shore-ledger-v4.0.0) - 2026-06-05

### Fixed

- *(ledger)* record cache write billed before a mid-stream error ([#204](https://github.com/mythofmeat/shore-core/pull/204))

## [3.0.4](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v3.0.3...shore-ledger-v3.0.4) - 2026-06-04

### Other

- control-flow & type-surface strictness (else_if_without_else / impl_trait_in_params) ([#155](https://github.com/mythofmeat/shore-core/pull/155)) ([#196](https://github.com/mythofmeat/shore-core/pull/196))
- integer & float arithmetic discipline ([#153](https://github.com/mythofmeat/shore-core/pull/153)) ([#194](https://github.com/mythofmeat/shore-core/pull/194))
- ban variable shadowing (shadow_same/reuse/unrelated) ([#151](https://github.com/mythofmeat/shore-core/pull/151)) ([#192](https://github.com/mythofmeat/shore-core/pull/192))
- Enable import & literal hygiene lints ([#154](https://github.com/mythofmeat/shore-core/pull/154)) ([#185](https://github.com/mythofmeat/shore-core/pull/185))
- enable string_slice + str_to_string ([#152](https://github.com/mythofmeat/shore-core/pull/152))
- enable unsafe-block + assert-message hardening ([#156](https://github.com/mythofmeat/shore-core/pull/156))

## [3.0.3](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v3.0.2...shore-ledger-v3.0.3) - 2026-06-03

### Fixed

- *(ledger)* track routed-Anthropic in cache gates ([#118](https://github.com/mythofmeat/shore-core/pull/118))

## [3.0.2](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v3.0.1...shore-ledger-v3.0.2) - 2026-06-03

### Other

- Correctness ratchet Tier 2: draconian clippy::restriction + rustc paranoia lints ([#115](https://github.com/mythofmeat/shore-core/pull/115)) ([#144](https://github.com/mythofmeat/shore-core/pull/144))

## [3.0.1](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v3.0.0...shore-ledger-v3.0.1) - 2026-06-02

### Other

- updated the following local packages: shore-config, shore-llm

## [3.0.0](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v2.0.4...shore-ledger-v3.0.0) - 2026-05-31

### Breaking

- **CostRequest and BudgetCallContext now implement Copy**: Both `CostRequest` and `BudgetCallContext` structs gained Copy trait implementations (copy_impl_added). This is a breaking change for code that relied on non-Copy semantics, including:
  - Mutation or ownership assumptions (e.g., expecting exclusive ownership after a move)
  - Custom Drop behavior or cleanup logic
  - Explicit move semantics in pattern matching

  **Migration**: Audit all code that moves or stores these types. If your code relied on move-only semantics:
  - For mutation after move: Use `.clone()` explicitly or refactor to accommodate copy semantics
  - For Drop behavior: Implement cleanup through other means (e.g., wrapper types with Drop)
  - For ownership patterns: Adapt to the fact that these types are now trivially copyable

  ```rust
  // Before (3.0.0):
  // let cost_req = CostRequest { /* fields */ };
  // process(cost_req); // moves cost_req, can't be used again

  // After (3.0.0):
  let cost_req = CostRequest { /* fields */ };
  process(cost_req); // copies cost_req
  // cost_req is still available for use
  ```

### Other

- Correctness ratchet: strict clippy + panic hygiene + dep checks ([#114](https://github.com/mythofmeat/shore-core/pull/114))

## [2.0.4](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v2.0.3...shore-ledger-v2.0.4) - 2026-05-31

### Other

- updated the following local packages: shore-config, shore-llm

## [2.0.3](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v2.0.2...shore-ledger-v2.0.3) - 2026-05-30

### Other

- updated the following local packages: shore-llm

## [2.0.2](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v2.0.1...shore-ledger-v2.0.2) - 2026-05-30

### Other

- updated the following local packages: shore-llm

## [2.0.1](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v2.0.0...shore-ledger-v2.0.1) - 2026-05-29

### Other

- updated the following local packages: shore-config, shore-llm

## [2.0.0](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v1.8.10...shore-ledger-v2.0.0) - 2026-05-28

### Fixed

- *(usage)* render budget reset times in local AM/PM + show window in CLI ([#86](https://github.com/mythofmeat/shore-core/pull/86))

## [1.8.10](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v1.8.9...shore-ledger-v1.8.10) - 2026-05-28

### Other

- updated the following local packages: shore-llm

## [1.8.9](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v1.8.8...shore-ledger-v1.8.9) - 2026-05-27

### Other

- updated the following local packages: shore-config, shore-llm

## [1.8.8](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v1.8.7...shore-ledger-v1.8.8) - 2026-05-22

### Other

- updated the following local packages: shore-llm

## [1.8.7](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v1.8.6...shore-ledger-v1.8.7) - 2026-05-22

### Other

- updated the following local packages: shore-llm

## [1.8.6](https://github.com/mythofmeat/shore-core/compare/shore-ledger-v1.8.5...shore-ledger-v1.8.6) - 2026-05-21

### Other

- [codex] remove Claude Code transport ([#24](https://github.com/mythofmeat/shore-core/pull/24))
- release v1.8.5 ([#21](https://github.com/mythofmeat/shore-core/pull/21))

## [1.8.5](https://github.com/mythofmeat/shore-core/releases/tag/shore-ledger-v1.8.5) - 2026-05-20

### Fixed

- *(ledger)* re-fire usage warning each generation while over budget

### Other

- *(release)* publish binary crates to crates.io, split arch package ([#20](https://github.com/mythofmeat/shore-core/pull/20))
- Merge pull request #12 from mythofmeat/fix/usage-warning-refires-over-budget
- adopt release-plz for version bumps and changelog
- Fix tool-loop prompt cache tracking
- Push usage budget warnings
- Add usage budgets
- Add per-key spend attribution, cost provenance, and usage-kind grouping
- Fix OpenRouter-routed Anthropic cache-write pricing
- Centralize background-task model resolution
- Fix cache keepalive fallback behavior
- surface usage and Max subscription telemetry
- Recognize OpenRouter-routed Anthropic in usage pricing and cache health
- Fix five regressions surfaced in provider-overhaul review
- Preserve chat cache during dreaming
- Implement AI librarian dreaming
- Reorganize workspace layout
