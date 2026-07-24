# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The usage chip reports a budget's pace when it is the more pressing of the
  two limits — a pace past its own `pace_warn_at` outranks a cooler cap even at
  a lower percentage — and pace warnings no longer clobber cached cap figures.

## [0.1.13](https://github.com/mythofmeat/shore-tui/compare/v0.1.12...v0.1.13) - 2026-07-15

### Fixed

- *(tui)* switch models by provider-qualified name ([#30](https://github.com/mythofmeat/shore-tui/pull/30))

## [0.1.12](https://github.com/mythofmeat/shore-tui/compare/v0.1.11...v0.1.12) - 2026-06-21

### Fixed

- *(tui)* persist view prefs reliably ([#28](https://github.com/mythofmeat/shore-tui/pull/28))

## [0.1.11](https://github.com/mythofmeat/shore-tui/compare/v0.1.10...v0.1.11) - 2026-06-09

### Added

- *(setting)* mirror daemon's cache_keepalive and max_tool_iterations keys ([#27](https://github.com/mythofmeat/shore-tui/pull/27))
- *(tui)* add sub-agent section toggle ([#25](https://github.com/mythofmeat/shore-tui/pull/25))

## [0.1.10](https://github.com/mythofmeat/shore-tui/compare/v0.1.9...v0.1.10) - 2026-06-05

### Other

- *(tui)* drop redundant clear/memory/quit commands ([#23](https://github.com/mythofmeat/shore-tui/pull/23))

## [0.1.9](https://github.com/mythofmeat/shore-tui/compare/v0.1.8...v0.1.9) - 2026-06-04

### Added

- *(setting)* sync model-settings surface with shore-core 0.8 ([#21](https://github.com/mythofmeat/shore-tui/pull/21))

## [0.1.8](https://github.com/mythofmeat/shore-tui/compare/v0.1.7...v0.1.8) - 2026-06-02

### Added

- *(tui)* render status messages as floating toast notifications ([#20](https://github.com/mythofmeat/shore-tui/pull/20))
- *(tui)* in-view usage budget monitor with warn-only mode ([#18](https://github.com/mythofmeat/shore-tui/pull/18))

### Fixed

- *(tui)* reconcile :setting keys with the daemon's sampler ([#17](https://github.com/mythofmeat/shore-tui/pull/17))

## [0.1.7](https://github.com/mythofmeat/shore-tui/compare/v0.1.6...v0.1.7) - 2026-05-29

### Other

- *(build)* add size-optimized release profile ([#15](https://github.com/mythofmeat/shore-tui/pull/15))

## [0.1.6](https://github.com/mythofmeat/shore-tui/compare/v0.1.5...v0.1.6) - 2026-05-29

### Fixed

- *(tui)* render thinking/tools/text interleaved and stream from one source ([#12](https://github.com/mythofmeat/shore-tui/pull/12))

### Other

- *(tui)* adopt a Turn/Block conversation model ([#14](https://github.com/mythofmeat/shore-tui/pull/14))
- gitignore

## [0.1.5](https://github.com/mythofmeat/shore-tui/compare/v0.1.4...v0.1.5) - 2026-05-29

### Fixed

- *(tui)* trust matching-rid model_settings responses instead of dropping them ([#9](https://github.com/mythofmeat/shore-tui/pull/9))

## [0.1.4](https://github.com/mythofmeat/shore-tui/compare/v0.1.3...v0.1.4) - 2026-05-28

### Fixed

- *(tui)* stop pinning model_settings to an unresolvable model name ([#7](https://github.com/mythofmeat/shore-tui/pull/7))

### Other

- gitignore

## [0.1.3](https://github.com/mythofmeat/shore-tui/compare/v0.1.2...v0.1.3) - 2026-05-27

### Fixed

- *(tui)* stop wiping sampler settings on orphaned model_settings responses ([#4](https://github.com/mythofmeat/shore-tui/pull/4))

## [0.1.2](https://github.com/mythofmeat/shore-tui/compare/v0.1.1...v0.1.2) - 2026-05-20

### Other

- *(arch)* disable debug split package
- Merge pull request #2 from mythofmeat/dev
- Bump shore-protocol and shore-swp-client to 0.2
- Remove TTS (text-to-speech) integration

## [0.1.1](https://github.com/mythofmeat/shore-tui/compare/v0.1.0...v0.1.1) - 2026-05-19

### Other

- *(package)* pacman-install alsa-lib for alsa-sys → rodio
- *(release-plz)* use secrets: inherit (picks up REPO_ARCH_TOKEN)
