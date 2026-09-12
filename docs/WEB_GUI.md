# Optional browser client — implementation record

Full scope: [issue #214](https://github.com/mythofmeat/shore/issues/214). Completion means a usable
graphical alternative for the union of CLI/TUI application workflows, with enforceable anti-drift
checks. The generated action interface is a capability floor alongside designed conversation,
navigation, settings, model, diagnostics, usage and memory workflows.

## Schema ownership decision

Rust remains canonical for SWP envelopes, events and existing wire value types, as specified in
`daemon/src/protocol/README.md`. Extend that path for operation payloads: define typed inputs and
results in `client/shore-common`, generate TypeScript with ts-rs, and derive runtime JSON Schemas from
the same Rust definitions. Use those schemas for server validation and GUI controls. The intended
schema derivation tool is Schemars; verify its current release and installed implementation before
adding it. Do not hand-edit generated protocol files or duplicate validators/UI schemas.

Pair an operation's input and result in the canonical catalogue so Rust and TypeScript callers keep
the association. Handler registration, scope/prerequisites, effects, confirmation and presentation
metadata reference that catalogue. The executable registry must replace the dispatch switches;
discovery comes from that registry, not the source inventory. During migration, explicitly track the
unmigrated names and keep the final parity gate failing until they are closed. Keep all existing
golden assertions as independent behavioral evidence.

The runtime validator must validate payloads before side effects and validate observable results
after the existing after-command annotations. Field names, optional/null behavior, discriminated
variants, modes, defaults and result information must match current clients. Domain validation stays
in shared daemon handlers. Genuinely open tool/config values may remain structured dynamic values;
all-operation `unknown` results may not.

## Baseline, 2026-09-12

Starting revision: `2ab99af0`, clean worktree. Required updates ran before implementation:

- Bun 1.4.0 → 1.4.2, installed at `/tmp/shore-214-tools/bin/bun` because `/usr/bin` is read-only.
- `rustup update stable`: Rust/Cargo 1.98.1 already current; rustup 1.29.1 matches the stable manifest.
- cargo-edit 0.13.13 and cargo-sweep 0.8.0 already current. sccache 0.17.0 is already installed/current;
  its attempted reinstall hit the temporary filesystem quota and the attempted build was removed.
- `bun update --latest` then `bun install`; `cargo upgrade --incompatible` then `cargo update`:
  no manifest/lock changes. `generic-array` remains at 0.14.7 because `crypto-common 0.1.7` pins it
  exactly through Ratatui → termwiz → sha2; explicitly attempting 0.14.9 confirmed that constraint.
- All eight required daemon checks passed, including 8,109 tests, mutation staleness, capture checks
  and compiled build. Rust workspace tests, formatting and Clippy passed. Local baseline logs are in
  `out/issue-214/baseline/` (ignored). These are the pre-implementation baseline, not final feature validation.

## Implementation and completion evidence

The [capability inventory](capabilities/README.md) records actual commands/options, generated wire
types, local workflows and planned browser equivalents. The current work only establishes the
inventory and its reproducibility gates. It does not implement a browser or satisfy full parity.

Inventory foundation validation: all eight required daemon commands passed with 8,116 tests; all
three Rust workspace commands passed. Actionlint 1.7.12 accepted the new PR workflow. The workflow
runs baseline and inventory/generation checks, but has not yet been executed on GitHub and does not
claim to enforce the unimplemented GUI/conformance gates. No branch protection has been changed.

Remaining work follows the issue's sequence:

1. Finish the contract foundation: canonical typed input/result contracts, runtime validation,
   executable handler/discovery registration, field/result renderer coverage, narrow exceptions,
   and independently tested representative operations. Audit special runners and all local flows.
2. Optional web transport: default-off config, loopback default, explicit secured remote setup,
   authentication before attach/history, origin checks, compatibility handshake, independent peers,
   cleanup, connection/message/upload/outbound queue limits, control routing and bounded lag policy.
3. Browser state layer and designed screens: shared revision-sequence fixtures with Rust, pending
   request correlation and uncertain mutation recovery, drafts/preferences, navigation/composer,
   streaming/alternatives/editing/media, generated action forms and schema-backed settings.
4. Close all advanced workflows: models/providers/roles, diagnostics and raw data, usage exports,
   segments/memory recovery, safe archive transfers, keyboard customization and every known event.
5. TCP/WebSocket deterministic conformance and real CLI/TUI/browser journeys: state/results/errors,
   confirmations, advanced options, empty state, failures, reconnect/restart, concurrency, media and
   cancellation. Demonstrate deliberate omission failures for operations, fields, renderers/events.
6. Embed assets in the daemon, update package/container/release workflows, and test the compiled
   binary from an empty directory, deep links, default-off behavior and incompatible stale tabs.
7. Run all required verification plus browser, generation, security and parity gates in PR CI.
   Coordinate repository merge-policy changes separately, as requested by the issue. No merge-policy
   change has been made or assumed. Full completion requires evidence for every acceptance criterion.
