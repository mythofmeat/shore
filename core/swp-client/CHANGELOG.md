# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.14](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.13...shore-swp-client-v0.3.14) - 2026-07-16

### Other

- updated the following local packages: shore-config

## [0.3.13](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.12...shore-swp-client-v0.3.13) - 2026-07-04

### Other

- Per-message model provenance for the memory agent ([#309](https://github.com/mythofmeat/shore-core/pull/309))

## [0.3.12](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.11...shore-swp-client-v0.3.12) - 2026-06-22

### Other

- updated the following local packages: shore-config

## [0.3.11](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.10...shore-swp-client-v0.3.11) - 2026-06-18

### Other

- updated the following local packages: shore-config

## [0.3.10](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.9...shore-swp-client-v0.3.10) - 2026-06-15

### Other

- updated the following local packages: shore-config

## [0.3.9](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.8...shore-swp-client-v0.3.9) - 2026-06-12

### Fixed

- *(daemon)* classify image uploads by magic bytes and declared mime type ([#272](https://github.com/mythofmeat/shore-core/pull/272))

## [0.3.8](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.7...shore-swp-client-v0.3.8) - 2026-06-12

### Other

- updated the following local packages: shore-config

## [0.3.7](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.6...shore-swp-client-v0.3.7) - 2026-06-11

### Other

- *(swp-client)* decompose the connection.rs long-function waiver ([#263](https://github.com/mythofmeat/shore-core/pull/263))

## [0.3.6](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.5...shore-swp-client-v0.3.6) - 2026-06-11

### Other

- too_many_lines threshold 100 -> 80 ([#199](https://github.com/mythofmeat/shore-core/pull/199)) ([#244](https://github.com/mythofmeat/shore-core/pull/244))

## [0.3.5](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.4...shore-swp-client-v0.3.5) - 2026-06-10

### Added

- *(memory)* deep-idle archive with autonomous-message retention ([#235](https://github.com/mythofmeat/shore-core/pull/235))

## [0.3.4](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.3...shore-swp-client-v0.3.4) - 2026-06-09

### Fixed

- *(swp-client)* stop History snapshots from dropping paired NewMessage ([#233](https://github.com/mythofmeat/shore-core/pull/233))

## [0.3.3](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.2...shore-swp-client-v0.3.3) - 2026-06-09

### Added

- *(protocol)* tolerate unknown ServerMessage frame types ([#228](https://github.com/mythofmeat/shore-core/pull/228))

### Other

- Sub-agent delegation, opt-in [tools] config, and `shore tools` ([#226](https://github.com/mythofmeat/shore-core/pull/226))

## [0.3.2](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.1...shore-swp-client-v0.3.2) - 2026-06-05

### Other

- decompose all non-test long functions ([#198](https://github.com/mythofmeat/shore-core/pull/198)) ([#212](https://github.com/mythofmeat/shore-core/pull/212))

## [0.3.1](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.3.0...shore-swp-client-v0.3.1) - 2026-06-05

### Other

- updated the following local packages: shore-config

## [0.3.0](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.11...shore-swp-client-v0.3.0) - 2026-06-04

### Other

- control-flow & type-surface strictness (else_if_without_else / impl_trait_in_params) ([#155](https://github.com/mythofmeat/shore-core/pull/155)) ([#196](https://github.com/mythofmeat/shore-core/pull/196))
- integer & float arithmetic discipline ([#153](https://github.com/mythofmeat/shore-core/pull/153)) ([#194](https://github.com/mythofmeat/shore-core/pull/194))
- ban variable shadowing (shadow_same/reuse/unrelated) ([#151](https://github.com/mythofmeat/shore-core/pull/151)) ([#192](https://github.com/mythofmeat/shore-core/pull/192))
- Enable import & literal hygiene lints ([#154](https://github.com/mythofmeat/shore-core/pull/154)) ([#185](https://github.com/mythofmeat/shore-core/pull/185))
- enable string_slice + str_to_string ([#152](https://github.com/mythofmeat/shore-core/pull/152))
- enable unsafe-block + assert-message hardening ([#156](https://github.com/mythofmeat/shore-core/pull/156))

## [0.2.11](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.10...shore-swp-client-v0.2.11) - 2026-06-03

### Other

- Correctness ratchet Tier 2: draconian clippy::restriction + rustc paranoia lints ([#115](https://github.com/mythofmeat/shore-core/pull/115)) ([#144](https://github.com/mythofmeat/shore-core/pull/144))

## [0.2.10](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.9...shore-swp-client-v0.2.10) - 2026-06-02

### Other

- updated the following local packages: shore-config

## [0.2.9](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.8...shore-swp-client-v0.2.9) - 2026-05-31

### Other

- Correctness ratchet: strict clippy + panic hygiene + dep checks ([#114](https://github.com/mythofmeat/shore-core/pull/114))

## [0.2.8](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.7...shore-swp-client-v0.2.8) - 2026-05-31

### Other

- updated the following local packages: shore-config

## [0.2.7](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.6...shore-swp-client-v0.2.7) - 2026-05-30

### Fixed

- *(replay)* track provider provenance; strip non-portable thinking on provider switch ([#99](https://github.com/mythofmeat/shore-core/pull/99))

## [0.2.6](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.5...shore-swp-client-v0.2.6) - 2026-05-29

### Other

- updated the following local packages: shore-config

## [0.2.5](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.4...shore-swp-client-v0.2.5) - 2026-05-28

### Other

- updated the following local packages: shore-protocol, shore-config

## [0.2.4](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.3...shore-swp-client-v0.2.4) - 2026-05-27

### Other

- updated the following local packages: shore-protocol, shore-config

## [0.2.3](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.2...shore-swp-client-v0.2.3) - 2026-05-22

### Other

- updated the following local packages: shore-protocol

## [0.2.2](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.1...shore-swp-client-v0.2.2) - 2026-05-21

### Other

- updated the following local packages: shore-config

## [0.2.1](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.2.0...shore-swp-client-v0.2.1) - 2026-05-20

### Other

- updated the following local packages: shore-config

## [0.2.0](https://github.com/mythofmeat/shore-core/compare/shore-swp-client-v0.1.0...shore-swp-client-v0.2.0) - 2026-05-20

### Added

- [**breaking**] remove text-to-speech support
