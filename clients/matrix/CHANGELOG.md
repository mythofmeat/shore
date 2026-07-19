# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0](https://github.com/mythofmeat/shore-matrix/compare/v0.1.5...v0.2.0) - 2026-06-12

### Fixed

- *(bridge)* send Matrix images as base64 image_data, not just temp paths ([#14](https://github.com/mythofmeat/shore-matrix/pull/14))

### Fixed

- *(bridge)* send Matrix image uploads as base64 `image_data` (with the event's declared mime type) instead of relying solely on the legacy shared-filesystem path mechanism, which silently dropped images whenever the daemon couldn't see the bridge's temp dir (systemd `PrivateTmp`, remote daemons). The temp path is still sent alongside for older daemons.
- *(bot)* sanitize the Matrix image event body before building the temp filename — it's remote input, and a path separator in it broke the write or escaped the temp dir

### Other

- *(deps)* shore-protocol 0.10 / shore-swp-client 0.3.8 / shore-config 0.15; shore-protocol and shore-swp-client are temporarily patched to a pinned shore-core commit for `ImageUpload.mime_type` until the next shore-protocol release is published

## [0.1.5](https://github.com/mythofmeat/shore-matrix/compare/v0.1.4...v0.1.5) - 2026-06-11

### Fixed

- *(provision)* re-provision when saved state belongs to a different character ([#12](https://github.com/mythofmeat/shore-matrix/pull/12))

## [0.1.4](https://github.com/mythofmeat/shore-matrix/compare/v0.1.3...v0.1.4) - 2026-06-09

### Other

- *(deps)* upgrade to shore-swp-client 0.3.4 for the mirror_all fix ([#10](https://github.com/mythofmeat/shore-matrix/pull/10))

## [0.1.3](https://github.com/mythofmeat/shore-matrix/compare/v0.1.2...v0.1.3) - 2026-06-09

### Added

- *(bridge)* mirror full conversation per character (mirror_all) ([#9](https://github.com/mythofmeat/shore-matrix/pull/9))

### Fixed

- *(bot)* reconnect the Matrix sync loop instead of dying on first error ([#5](https://github.com/mythofmeat/shore-matrix/pull/5))
- *(homeserver)* stop orphaning tuwunel and double-spawning on the DB lock ([#4](https://github.com/mythofmeat/shore-matrix/pull/4))

### Other

- *(deps)* de-drift core crates to current published versions ([#7](https://github.com/mythofmeat/shore-matrix/pull/7))

## [0.1.2](https://github.com/mythofmeat/shore-matrix/compare/v0.1.1...v0.1.2) - 2026-05-20

### Other

- *(arch)* disable debug split package

## [0.1.1](https://github.com/mythofmeat/shore-matrix/compare/v0.1.0...v0.1.1) - 2026-05-20

### Other

- release v0.1.0

## [0.1.0](https://github.com/mythofmeat/shore-matrix/releases/tag/v0.1.0) - 2026-05-19

### Added

- upgrade matrix-sdk 0.16 → 0.17 and drop the recursion-limit patch

### Other

- add release-plz workflow
- *(package)* pacman-install alsa-lib for alsa-sys → rodio
- install libasound2-dev for shore-swp-client → rodio → alsa-sys chain
- Add CI and Arch packaging
- Update prose to point at renamed shore-core repository
- Initial extraction from silvershore
