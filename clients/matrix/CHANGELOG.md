# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
