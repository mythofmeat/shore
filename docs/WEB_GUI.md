# Optional browser client — implementation record

Full scope: [issue #214](https://github.com/mythofmeat/shore/issues/214). Completion means a usable
graphical alternative for the union of CLI/TUI application workflows, with enforceable anti-drift
checks. The generated action interface is a capability floor alongside designed conversation,
navigation, settings, model, diagnostics, usage and memory workflows.

## Schema ownership decision

Rust remains canonical for SWP envelopes, events and existing wire value types, as specified in
`daemon/src/protocol/README.md`. Extend that path for operation payloads: define typed inputs and
results in `client/shore-common`, generate TypeScript with ts-rs, and derive runtime JSON Schemas from
the same Rust definitions. Use those schemas for server validation and GUI controls. Schemars 1.2.2
has been added in a separate dependency change; its installed implementation supports explicit
2020-12 schemas and distinct deserialize/input and serialize/result contracts. All Rust workspace
checks pass with the addition. Do not hand-edit generated protocol files or duplicate validators/UI schemas.

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
types, local workflows and planned browser equivalents. The inventory and first contract migration
are implemented. They do not implement a browser or satisfy full parity.

Inventory foundation validation: all eight required daemon commands passed with 8,116 tests; all
three Rust workspace commands passed. Actionlint 1.7.12 accepted the new PR workflow. The workflow
runs baseline and inventory/generation checks, but has not yet been executed on GitHub and does not
claim to enforce the unimplemented GUI/conformance gates. No branch protection has been changed.

### Character and thread contract migration

`client/shore-common/src/protocol/operations.rs` now owns the inputs and results for twelve operations:
character listing, creation, selection and inspection, and thread listing, creation, selection,
archiving, forking, home selection, labeling and model pinning. Its operation pairs generate Rust
callers, TypeScript discriminated requests/results, and deserialize/serialize JSON Schemas. The
daemon registry binds those contracts to the existing handlers, with scope, prerequisites, effects,
confirmation requirements and metadata for every input field. Discovery uses those registrations.
Input validation runs before engine loading and handler side effects. Result validation runs at the
handler boundary and after session-selection annotations. Optional null inputs from existing clients
remain valid; invalid types and undeclared input fields produce correlated request errors.

The CLI's special character creation and character/thread selection runners use typed operation
calls and deserialize their paired results. The remaining CLI/TUI mappings still use the existing
wire path. The source inventory explicitly records 43 legacy operation names; they remain migration
work, not exceptions. The normal suites exercise missing handler/contract bindings, omitted field
metadata, invalid arguments/results, typed request correlation, empty-install character creation,
and advanced thread forking over the actual authenticated TCP connection. Existing golden and
behavioral assertions remain independent of the generated schemas.

Regenerate schemas with `cargo test -p shore-common --lib export_operation_schemas` from `client/`.
Normal Rust tests also export the schemas and TypeScript bindings. CI checks those generated files
for changes and untracked additions. GUI field/result renderer coverage and WebSocket conformance
remain unimplemented.

Migration validation: all eight required daemon checks passed with 8,124 tests. Rust workspace
tests, formatting and Clippy passed, and Actionlint accepted the updated generation workflow. The
dispatch and navigation mutation passes killed every applicable mutant after retargeting moved
handler registrations; all 54 mutation passes have no stale patterns. Local logs remain in
`out/issue-214/`. GitHub execution and merge-policy enforcement are still unverified.

Remaining work follows the issue's sequence:

1. Continue the contract migration through the 43 legacy names, core message/regen/cancel requests,
   remaining terminal adapters and all event/result types. Add field/result renderer coverage and
   narrow platform mappings. Audit remaining special runners and local flows.
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
