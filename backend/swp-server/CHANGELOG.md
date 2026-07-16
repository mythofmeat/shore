# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.10](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.9...shore-swp-server-v0.1.10) - 2026-07-16

### Other

- updated the following local packages: shore-config

## [0.1.9](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.8...shore-swp-server-v0.1.9) - 2026-07-04

### Other

- Per-message model provenance for the memory agent ([#309](https://github.com/mythofmeat/shore-core/pull/309))

## [0.1.8](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.7...shore-swp-server-v0.1.8) - 2026-06-22

### Other

- updated the following local packages: shore-config

## [0.1.7](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.6...shore-swp-server-v0.1.7) - 2026-06-18

### Other

- updated the following local packages: shore-config

## [0.1.6](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.5...shore-swp-server-v0.1.6) - 2026-06-15

### Other

- updated the following local packages: shore-config

## [0.1.5](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.4...shore-swp-server-v0.1.5) - 2026-06-12

### Other

- updated the following local packages: shore-protocol

## [0.1.4](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.3...shore-swp-server-v0.1.4) - 2026-06-12

### Other

- updated the following local packages: shore-config

## [0.1.3](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.2...shore-swp-server-v0.1.3) - 2026-06-11

### Other

- *(swp-server)* decompose the lib.rs long-function waiver ([#262](https://github.com/mythofmeat/shore-core/pull/262))

## [0.1.2](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.1...shore-swp-server-v0.1.2) - 2026-06-11

### Other

- too_many_lines threshold 100 -> 80 ([#199](https://github.com/mythofmeat/shore-core/pull/199)) ([#244](https://github.com/mythofmeat/shore-core/pull/244))

## [0.1.1](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v0.1.0...shore-swp-server-v0.1.1) - 2026-06-10

### Added

- *(memory)* deep-idle archive with autonomous-message retention ([#235](https://github.com/mythofmeat/shore-core/pull/235))

## [2.1.0](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v2.0.2...shore-swp-server-v2.1.0) - 2026-06-09

### Added

- *(protocol)* tolerate unknown ServerMessage frame types ([#228](https://github.com/mythofmeat/shore-core/pull/228))

### Other

- Sub-agent delegation, opt-in [tools] config, and `shore tools` ([#226](https://github.com/mythofmeat/shore-core/pull/226))

## [2.0.2](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v2.0.1...shore-swp-server-v2.0.2) - 2026-06-05

### Other

- updated the following local packages: shore-config

## [2.0.1](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v2.0.0...shore-swp-server-v2.0.1) - 2026-06-05

### Other

- updated the following local packages: shore-config

## [2.0.0](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.15...shore-swp-server-v2.0.0) - 2026-06-04

### Other

- control-flow & type-surface strictness (else_if_without_else / impl_trait_in_params) ([#155](https://github.com/mythofmeat/shore-core/pull/155)) ([#196](https://github.com/mythofmeat/shore-core/pull/196))
- integer & float arithmetic discipline ([#153](https://github.com/mythofmeat/shore-core/pull/153)) ([#194](https://github.com/mythofmeat/shore-core/pull/194))
- ban variable shadowing (shadow_same/reuse/unrelated) ([#151](https://github.com/mythofmeat/shore-core/pull/151)) ([#192](https://github.com/mythofmeat/shore-core/pull/192))
- Enable import & literal hygiene lints ([#154](https://github.com/mythofmeat/shore-core/pull/154)) ([#185](https://github.com/mythofmeat/shore-core/pull/185))
- enable string_slice + str_to_string ([#152](https://github.com/mythofmeat/shore-core/pull/152))
- enable unsafe-block + assert-message hardening ([#156](https://github.com/mythofmeat/shore-core/pull/156))

## [1.8.15](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.14...shore-swp-server-v1.8.15) - 2026-06-03

### Other

- Correctness ratchet Tier 2: draconian clippy::restriction + rustc paranoia lints ([#115](https://github.com/mythofmeat/shore-core/pull/115)) ([#144](https://github.com/mythofmeat/shore-core/pull/144))

## [1.8.14](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.13...shore-swp-server-v1.8.14) - 2026-06-02

### Other

- updated the following local packages: shore-config

## [1.8.13](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.12...shore-swp-server-v1.8.13) - 2026-05-31

### Other

- Correctness ratchet: strict clippy + panic hygiene + dep checks ([#114](https://github.com/mythofmeat/shore-core/pull/114))

## [1.8.12](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.11...shore-swp-server-v1.8.12) - 2026-05-31

### Other

- updated the following local packages: shore-config

## [1.8.11](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.10...shore-swp-server-v1.8.11) - 2026-05-30

### Fixed

- *(replay)* track provider provenance; strip non-portable thinking on provider switch ([#99](https://github.com/mythofmeat/shore-core/pull/99))

## [1.8.10](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.9...shore-swp-server-v1.8.10) - 2026-05-29

### Other

- updated the following local packages: shore-config

## [1.8.9](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.8...shore-swp-server-v1.8.9) - 2026-05-28

### Other

- updated the following local packages: shore-protocol, shore-config

## [1.8.8](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.7...shore-swp-server-v1.8.8) - 2026-05-27

### Other

- updated the following local packages: shore-protocol, shore-config

## [1.8.7](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.6...shore-swp-server-v1.8.7) - 2026-05-22

### Other

- updated the following local packages: shore-protocol

## [1.8.6](https://github.com/mythofmeat/shore-core/compare/shore-swp-server-v1.8.5...shore-swp-server-v1.8.6) - 2026-05-21

### Other

- release v1.8.5 ([#21](https://github.com/mythofmeat/shore-core/pull/21))

## [1.8.5](https://github.com/mythofmeat/shore-core/releases/tag/shore-swp-server-v1.8.5) - 2026-05-20

### Added

- [**breaking**] remove text-to-speech support

### Other

- *(release)* publish binary crates to crates.io, split arch package ([#20](https://github.com/mythofmeat/shore-core/pull/20))
- adopt release-plz for version bumps and changelog
- Push usage budget warnings
- Show archived conversation segments in history
- Fix remote desktop notifications
- Add desktop notification listener
- Replace regenerated response swipe UX with alts
- Merge branch 'main' into feat/models-provider-overhaul
- Add daemon config hot reload
- Reorganize workspace layout
