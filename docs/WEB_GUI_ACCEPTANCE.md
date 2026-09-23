# Issue #214 acceptance evidence and remaining work

Updated 2026-09-23 against the current [issue](https://github.com/mythofmeat/shore/issues/214),
working tree and GitHub API. This is an execution checklist, not an anti-drift gate or a claim of parity.
The command/option audit checkpoint follows `a044ffc0`; all eight required daemon checks and all 51
browser journeys passed, including 7,932 daemon tests, current mutation patterns, unchanged independent
captures, the compiled build, generation/assets and inventory checks. The preceding shared batch passed
all three Rust checks (1,493 tests, 15 ignored). The daemon Docker image built, enabled/disabled runtime
smokes passed, and actual compiled Rust CLI workflows passed against the current daemon.

| Issue acceptance requirement | Current authoritative evidence | Remaining closure work |
| --- | --- | --- |
| Optional serving; disabled operation preserves the terminal | `src/web/server.ts`, daemon startup tests, `tests/browser/packaged.e2e.ts`, preceding Rust baseline | Include these in final verification; recheck disabled runtime work, not just HTTP refusal. |
| Complete CLI/TUI capabilities, options, local workflows and mappings | Rust-generated inventory; executable local/display gates; `browser_terminal_coverage.ts` maps all 72 non-UI commands and 281 arguments to canonical controls or justified adapters | Structural gates and representative omission tests passed, complemented by real workflows. Keep this coverage in final verification. |
| Same shared daemon implementations and sessions | `src/web/server.ts` attaches local SWP peers; `tests/daemon_run.test.ts` runs independently reset TCP/web scenarios, including exact manual-tool image bytes and correlated progress | Preserve this routing in final verification; no duplicate backend. |
| One authoritative operation contract and executable registration | Rust-canonical operation definitions, generated schemas/validators, `src/commands/registry.ts`, capability and registration tests | Run final regeneration and omission checks; preserve canonical ownership for any new result/event fields. |
| Designed screens and generated actions cover operations and fields | `src/browser/forms.ts`, dedicated screens, recursive schema coverage, terminal field mappings and real workflows | Generated forms expose canonical fields and complete results; representative omissions fail. Keep these in final verification. |
| Schema-backed settings, redaction, defaults, scope and restart reporting | `tests/browser/settings.e2e.ts`, schema/operation tests, live configuration controls | Final verification and inclusion in the cross-surface completeness gate. |
| TCP/web conformance and real workflows include state, errors, options and events | Independent reset fixtures, explicit known-event policies/branches, actual compiled Rust CLI workflows, 51 browser journeys and omission tests | Complete remaining failed-media ownership and live-state limit cases. |
| Synchronization, concurrent clients, restart and cancellation | Shared sync fixtures; transport, draft, request/archive restart, cancellation, and real concurrent TCP/browser edit and active-thread-switch tests | Full suite passed; retained-media ownership remains in the media audit below. |
| Authenticated browser transfers and media recovery | Archive/transfer/restart, gallery and manual-tool browser tests; exact original-image downloads and retained-result reload; controlled artifacts | Finish failed-tool-media ownership and resource audit. Clipboard paste is covered by the draft journey. Retained results over 64 KiB explicitly omit their data; live-only originals are not persisted without limit. |
| Authentication, origins, rendering, secrets, limits and cleanup | `tests/web_transport.test.ts` covers pre-attach auth, host/origin/TLS, session expiry, queues and cleanup; settings/diagnostic tests check redaction | Audit final rendering and retained state/resource limits, with explicit cases for any gaps. |
| Packaged daemon, no source checkout, stale-tab recovery | Empty-directory compiled-binary browser test; Docker build/runtime enabled and disabled; stale-tab browser reload test prevents incompatible attachment and recovers | Verified. Re-run applicable package checks if subsequent source changes affect them. |
| Actual PR CI, required merge checks and deliberate omission failures | `.github/workflows/verify.yml` contains generation, inventory and browser jobs; mutation passes detect representative omissions | No PR exists for `feat/web-ui`, so there is no actual PR CI evidence yet. Required checks/rulesets are externally constrained as described below. Finish implementation, run required checks, create the reviewable PR and verify CI. |

Paths beginning with `src/`, `scripts/` or `tests/` above are relative to `daemon/`.

## Work order

1. Local workflows and the wider terminal command/field mappings passed full verification.
2. Manual-tool progress/media and cross-tab sign-out passed full verification. Close the remaining
   media/event/concurrency cases using shared operations and real client flows.
3. Operation/field/result/event structural coverage and omission checks passed. Maintain them while
   closing the remaining media/resource cases; avoid duplicating already established conformance.
4. Finish security/resource, package/container and stale-tab checks; run final daemon/Rust/browser
   verification and reproducibility checks.
5. Publish the reviewable implementation for actual CI and coordinate required merge policy.

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
sccache 0.18.0 and actionlint 1.7.12 were current on this refresh. Both dependency updates produced
no changes. An explicit `generic-array` 0.14.9 update was rejected because `crypto-common` 0.1.7
requires exactly 0.14.7 through the optional `ratatui-termwiz` dependency chain. The lockfile retains
0.14.7; this upstream constraint is not a completed update.
