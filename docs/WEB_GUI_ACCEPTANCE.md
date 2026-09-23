# Issue #214 acceptance evidence and remaining work

Updated 2026-09-23 against [issue #214](https://github.com/mythofmeat/shore/issues/214).
The checkpoint before review passed all eight daemon checks (7,937 tests, 72 current mutation passes,
three unchanged capture groups and compiled build), all three Rust checks (1,493 tests, 15 ignored),
generation/assets and inventory checks, and all 54 browser journeys. All 27 targeted image/resource
mutants were killed. Docker build/runtime checks passed with web enabled and disabled, as did actual
compiled Rust CLI workflows. Logs are under `out/issue-214/resume-2026-09-23/retention-*`.

This records concrete coverage, not a proof of identical subjective usability. The original issue
remains open because required merge-check policy cannot currently be established on this repository.
Actual GitHub CI results are attached to [draft PR #232](https://github.com/mythofmeat/shore/pull/232).

| Issue acceptance requirement | Authoritative evidence |
| --- | --- |
| Optional serving; disabled operation preserves the terminal | `src/web/server.ts`, startup tests, `tests/browser/packaged.e2e.ts`, enabled/disabled Docker runtime smoke checks with native TCP handshake and no disabled web cache |
| CLI/TUI capabilities, options and local workflows | Rust-generated inventory; executable terminal/local/display gates; all 72 non-UI commands and 281 arguments map to canonical controls or narrowly justified adapters, with deliberate omission failures |
| Shared daemon implementations and sessions | Local SWP peer attachment; independently reset TCP/web scenarios in `tests/daemon_run.test.ts`, including manual-tool image bytes and correlated progress |
| Authoritative operation contract and executable registration | Rust operation definitions, generated schemas/validators, executable registry and capability/registration tests; reproducibility checks |
| Designed screens and generated actions cover operations, fields and results | Dedicated screens, recursive schema controls, terminal mappings, complete result inspection and real browser journeys; omitted controls/results fail coverage |
| Schema-backed settings and redaction | Actual settings workflows, schema/operation tests, effective/default values, scope, editability, server validation and restart reporting |
| TCP/web conformance and observable workflows | Independent reset fixtures, explicit known-event policies/branches, actual compiled Rust CLI flows, 54 browser journeys and omission tests |
| Synchronization, concurrent clients and recovery | Shared sync fixtures, duplicate/stale/revision-gap tests, request/archive restart, cancellation, concurrent TCP/browser edits and active-stream thread switching |
| Authenticated transfers and media recovery | Archive/transfer/restart, clipboard/picker drafts, exact original-image downloads, retained-result reload, three-image omission/deletion flow and controlled artifacts; 64 KiB retained-result omissions are explicit |
| Authentication, rendering, secrets, limits and cleanup | `tests/web_transport.test.ts`, literal-HTML browser case, raster-only media tests, secret-redaction flows, bounded live previews/activity/media, cancellation under large output and sign-out/selection cleanup |
| Packaged daemon and stale-tab recovery | Empty-directory compiled-binary browser flow, current Docker build/runtime, incompatible-tab handshake prevention and successful reload |
| Actual PR CI and required merge gates | [PR #232 checks](https://github.com/mythofmeat/shore/pull/232/checks) run daemon, Rust, generation, inventory and browser coverage. The first run exposed missing build/runtime prerequisites; the workflow now builds the native patch helper before daemon tests and installs Bun/dependencies for Rust cross-client tests. Required merge policy remains externally blocked below. |

Paths beginning with `src/`, `scripts/` or `tests/` are relative to `daemon/`.
Review the latest actual PR CI outcomes separately from the local evidence, and resolve the repository plan/policy constraint before
claiming the required-merge-gate criterion complete. No automatic merge or issue closure is included.

## Review corrections

The review reproductions exposed four gaps despite the prior passing suites. Delayed IndexedDB
completion could send a draft into a newly selected conversation; unrelated broadcast history could
disconnect browser and archive peers; reconnecting could leave a permanent live response card; and
compaction role listings and reset results could report the character model instead of the thread model.

The composer now checks its mounted state, connection generation and current selection after saving.
Interrupted sends retain their text and attachments. Broadcast subscriptions filter by the current
session before applying byte and message limits, with another selection check before delivery.
Connection loss retires departed live previews. Compaction reporting follows the thread chat model,
while heartbeat and subagents retain character inheritance, including reset results and UI guidance.

Regression coverage includes real-browser delayed saves during character changes, thread changes,
navigation away and back, and reconnects; reconnecting mid-generation and sending again; compaction
listing, inspection, override and reset; bounded WebSocket/local queues with unrelated traffic; and
an actual archive export and download while an oversized unrelated history is broadcast.

Verification after these corrections passed all eight required daemon checks (7,941 tests, 72
mutation passes free of stale patterns, three unchanged capture groups and compiled build), all
three Rust checks (1,493 tests, 15 ignored, existing Clippy warnings), browser/assets and inventory
checks, and all 59 browser journeys. One MCP deadline timing test failed during concurrent daemon
and browser runs; its isolated suite and the complete daemon rerun passed. Logs and reproduction
traces are under `out/issue-214/review-2026-09-23/`. The prior Docker and targeted mutation execution
evidence above predates these corrections; those checks were not rerun for this update.

## Confirmed external constraint

On 2026-09-23, both `GET /repos/mythofmeat/shore/branches/main/protection/required_status_checks`
and `GET /repos/mythofmeat/shore/rulesets` returned HTTP 403 with:

> Upgrade to GitHub Pro or make this repository public to enable this feature.

This is evidence that required-merge-gate acceptance cannot currently be established through these
repository features. No billing, visibility or merge-policy changes have been made. Implementation
and CI preparation can continue; the repository owner must resolve the plan/policy constraint before
the original required-gate criterion can be claimed complete.

## Dependency refresh constraint

Bun 1.4.2, Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13, cargo-sweep 0.8.0,
sccache 0.18.0 and actionlint 1.7.12 were current on the earlier refresh. The review refresh reconfirmed
Bun, Rust/Cargo, rustup and Cargo tooling, and updated DeepSeek to 3.0.51, Moonshot to 3.0.55,
AI SDK to 7.0.112 and OpenAI to 7.23.0 in a separate dependency commit. Client dependency updates
produced no changes. An explicit `generic-array` 0.14.9 update was previously rejected because `crypto-common` 0.1.7
requires exactly 0.14.7 through the optional `ratatui-termwiz` dependency chain. The lockfile retains
0.14.7; this upstream constraint is not a completed update.
