# Issue #214 acceptance evidence and remaining work

Updated 2026-09-23 against the current [issue](https://github.com/mythofmeat/shore/issues/214),
working tree and GitHub API. This is an execution checklist, not an anti-drift gate or a claim of parity.
The local-workflow checkpoint follows `6a1380d5`; all eight required daemon checks and all 47 browser
journeys passed, including 7,923 daemon tests, current mutation patterns, unchanged independent
captures, the compiled build, generation/assets and inventory checks.

| Issue acceptance requirement | Current authoritative evidence | Remaining closure work |
| --- | --- | --- |
| Optional serving; disabled operation preserves the terminal | `src/web/server.ts`, daemon startup tests, `tests/browser/packaged.e2e.ts`, preceding Rust baseline | Include these in final verification; recheck disabled runtime work, not just HTTP refusal. |
| Complete CLI/TUI capabilities, options, local workflows and mappings | Rust-generated `docs/capabilities/terminal.generated.json`, `docs/capabilities/README.md`, browser screens and shortcuts | Editor/undo, output reopening, focus/scroll/help and the executable local gate are implemented with focused browser/omission evidence. Their full verification passed; audit the wider terminal-to-operation field mapping. |
| Same shared daemon implementations and sessions | `src/web/server.ts` attaches local SWP peers; `tests/daemon_run.test.ts` runs independently reset TCP/web scenarios | Maintain this routing for remaining manual-tool media/progress work; no duplicate backend. |
| One authoritative operation contract and executable registration | Rust-canonical operation definitions, generated schemas/validators, `src/commands/registry.ts`, capability and registration tests | Run final regeneration and omission checks; preserve canonical ownership for any new result/event fields. |
| Designed screens and generated actions cover operations and fields | `src/browser/forms.ts`, dedicated screens, `scripts/browser_coverage.ts`, browser form and workflow tests | Audit the terminal-to-operation field gate alongside the new executable local-workflow gate. Review explicit options and meaningful results rather than treating registration as usability proof. |
| Schema-backed settings, redaction, defaults, scope and restart reporting | `tests/browser/settings.e2e.ts`, schema/operation tests, live configuration controls | Final verification and inclusion in the cross-surface completeness gate. |
| TCP/web conformance and real workflows include state, errors, options and events | `tests/daemon_run.test.ts` covers reset fixtures for operation families; 47 verified browser journeys | Forward manual-tool progress/media, finish known-event behavior audit, and connect representative omissions to required parity checks. |
| Synchronization, concurrent clients, restart and cancellation | Shared Rust/browser sync fixtures; transport, draft, request-restart, archive-restart and cancellation tests | Verify terminal/browser concurrent updates and switching during active streams; close any uncovered event ordering cases and retained-media ownership gaps. |
| Authenticated browser transfers and media recovery | Archive/transfer/restart browser tests; upload limits; gallery tests; controlled artifact implementation | Manual-tool images/progress; clipboard/failed-tool-media and original-versus-prepared image recovery audit. Do not claim live-only originals persist across reload. |
| Authentication, origins, rendering, secrets, limits and cleanup | `tests/web_transport.test.ts` covers pre-attach auth, host/origin/TLS, session expiry, queues and cleanup; settings/diagnostic tests check redaction | Audit final rendering and retained state/resource limits, with explicit cases for any gaps. |
| Packaged daemon, no source checkout, stale-tab recovery | Compiled-binary browser test from an empty directory; transport test rejects stale contracts; Dockerfile builds browser assets | Verify relevant package/container builds and the actual stale-tab recovery UI. |
| Actual PR CI, required merge checks and deliberate omission failures | `.github/workflows/verify.yml` contains generation, inventory and browser jobs; mutation passes detect representative omissions | No PR exists for `feat/web-ui`, so there is no actual PR CI evidence yet. Required checks/rulesets are externally constrained as described below. Finish implementation, run required checks, create the reviewable PR and verify CI. |

Paths beginning with `src/`, `scripts/` or `tests/` above are relative to `daemon/`.

## Work order

1. Local-workflow implementation, executable mappings and full verification are complete. Continue
   the wider terminal-to-operation field audit in group 3.
2. Close manual-tool progress/media and the remaining media/event/concurrency cases using shared
   operations and real client flows.
3. Complete the operation/field/result/event coverage audit and enforce omissions with executable
   checks. Reuse existing conformance evidence; add scenarios only for uncovered requirements.
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
