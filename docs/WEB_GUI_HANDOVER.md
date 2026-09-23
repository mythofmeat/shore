# Web GUI handover — issue #214

Updated 2026-09-23. Work continues toward the full issue. Configurable keyboard shortcuts now join
browser display preferences, core conversation controls and ordinary-request recovery. Full terminal
workflow parity, release/security auditing and actual GitHub CI/merge-gate evidence remain outstanding.

## Configurable keyboard checkpoint — 2026-09-23

This continuation began at `23b741ab`. Required toolchain and dependency updates ran first; Bun 1.4.2,
Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13, cargo-sweep 0.8.0, sccache 0.18.0 and actionlint
1.7.12 were current. Daemon dependencies were unchanged; Cargo updated lru 0.18.4 to 0.18.5.
Dependency-only commit `29cc6049` followed all three Rust baseline checks. The focused daemon
baseline passed, then the actual browser reproduction failed at the missing Keyboard shortcuts control.

The browser now provides a binding editor, key recording, separate normal/global scopes, saved argument
presets, open-form/run modes, edit/remove and reset. Its action choices derive from all current named
operations, core requests, generated view preferences and existing browser-local destinations. Operation
and conversation arguments use the canonical validators and existing request/dispatch paths; actions
requiring confirmation still open a review before dispatch. Send-current-draft uses the existing composer
persistence and admission path, while a saved message template leaves that draft intact.

Bindings persist per key/scope, synchronize across tabs, retain unsaved local changes after storage
failures and offer retry/reset with a workspace notice. There are at most 128 active bindings and 32 KiB
of UTF-8 JSON per binding. Default removal persists; deleting custom bindings removes their records.
Typing, native editing/navigation keys, repeated keydown, IME composition and modal controls are
protected; an explicitly bound cancellation action remains available in dialogs. Ctrl and Command are
separate browser modifiers. All defaults now use the same binding mechanism.

Configuration presets consult the live schema: secret or unknown values cannot be persisted, and
execution rechecks classification. Omitted/null values remain valid read/form presets. The value
control is masked while its classification is unknown or secret. Tests also reject an injected secret
preset at execution. Other arguments are local-device data; shortcuts do not promise encrypted storage.

Verification passed all eight required daemon commands: 7,910 tests across 282 files, 68 current
mutation passes, three unchanged independent capture groups and the compiled build. All 21 keyboard
mutation cases were killed. All 39 Playwright journeys passed together. Browser generation/assets
and capability inventory checks passed, and the mobile editor was visually inspected. The dependency
refresh passed all three Rust checks (1,493 tests, 15 existing ignored tests, existing Clippy warnings).
No Rust source changed in the keyboard feature. The build used local compilation when the cache
server was unavailable. Logs use `keyboard-` under `out/issue-214/resume-2026-09-23/`.
This checkpoint does not complete issue #214 or establish actual GitHub CI/required merge gates.

This does not establish full terminal-local parity. Next, finish the actual UiCommand/input workflow
audit: image galleries with navigation, reopening action output, expanded draft editing and undo
after send/editor handoff, and the remaining focus/scroll/help equivalents. Existing image opening, message editing and
activity screens need executable mappings and real-flow coverage of their terminal options. Broader
event/media/concurrency, security, packaging and CI acceptance work remains open.

## Display preferences checkpoint — 2026-09-23

This continuation began at `96a3eb6f`. Required Bun/Rust toolchain and dependency updates ran before
investigation and found no manifest or lockfile changes. Current build-tool releases were checked;
sccache 0.18.0 was restored from the official release with its published SHA-256 verified. In this
environment use `PATH=/tmp/shore-214-tools/bin:$PATH` and `RUSTC_WRAPPER=` for Cargo checks; the system
sccache remains 0.17.0 and `~/.cargo/bin` is absent. The focused post-refresh baseline passed. The
actual browser reproduction failed at the missing Display preferences control before implementation.

All nine terminal view keys now have browser controls: timestamps, thinking, tools, subagent,
compaction, images, metadata, usage and budget. Choice lists are generated from the Rust-produced
terminal capability inventory. Coverage checks read actual rendering calls and enum branches and
reject deliberately omitted choices, controls, readers or modes. The browser preserves its existing
visible-content defaults, with usage off and budget focus automatic. Boolean controls toggle directly;
usage and budget also expose the terminal's cycle order, including named budgets when several exist.

Preferences persist per field in browser local storage and synchronize between tabs without
replacing unrelated changes. Legacy reasoning/tool choices migrate. Failed writes retain the open
tab's choices, report the failure inside and outside the dialog, and support retry/reset; remote changes preserve
unsaved local choices. Display settings remain browser-local. Keyboard customization and other local-workflow
parity still require separate work.

Hidden inline images retain an explicit full-size action. Reasoning/tool choices affect completed
and live blocks; subagent and compaction choices filter activity and compaction progress while
keeping action results inspectable. Message metadata includes available provider/model details and
live token/timing totals. Stream totals follow TUI accumulation, including first-token timing and
numeric bounds. Up to 256 completed message metadata records remain in the open workspace; history
reconciliation retains matching records, selection changes/sign-out clear them. Reloaded history does
not contain token/timing metadata in the canonical protocol, so it shows available message details.

The usage readout requests the shared budget operation on enable, conversation/message changes,
warnings and a 30-second refresh. Failed refreshes mark retained readings stale. Off/always/warn,
automatic/cap/pace, case-insensitive names and named scopes follow terminal behavior. Shared fixtures
exercise the browser policy and actual terminal renderer, including warning priority, pace fallback,
ties, unavailable names and metadata accumulation. Four browser journeys exercise every control's
visible effect, multiple tabs, reload, write failure/retry, subagent/tool streams, compaction,
explicit image opening, named budgets and quiet warning-only behavior.

Verification passed all eight required daemon commands: 7,902 tests in 281 files, 67 current
mutation passes, three unchanged independent capture groups and the compiled build. All 26 new
mutation cases were killed. All three Rust checks passed: 1,493 tests, 15 existing ignored tests and
existing Clippy warnings. All 35 Playwright journeys passed together, including the final reproduction
and fix for a save-failure notice disappearing when its dialog closed. Browser generation/assets,
capability inventory and workflow lint checks passed, and the mobile layout was inspected. The build
used local compilation when the cache server was unavailable. Logs use `preferences-` under
`out/issue-214/resume-2026-09-23/`. This checkpoint does not complete issue #214.

Next, compare the actual `UiCommand`/keymap inventory with browser-local workflows and keyboard
handling. The browser currently has the action-palette and send shortcuts but no binding editor.
The broader presentation audit should also exercise budget-name edge cases and consecutive spectator
responses, alongside the remaining event/media/concurrency, security, packaging and CI acceptance work.

## Core conversation controls checkpoint — 2026-09-23

This continuation began at `b248e154`. Bun upgrade, daemon latest dependency update/install,
Rust stable update, Cargo incompatible upgrade/update and current build-tool release checks found
no new updates. The previous full baseline remains applicable; the focused browser/workspace and
inventory baseline passed. The actual browser reproduction then failed at the absent Message
options control.

`OperationCatalogue.requests` now discovers message, regeneration and cancellation from the same
registrations used by the shared engine handler. Payload schemas come from the canonical Rust wire
types; metadata covers every user field and each request describes its completion contract.
Cancellation stays on the existing control path. The source inventory and browser coverage tests
reject missing registrations, actions, input fields and nested renderer kinds.

The composer exposes streaming, the compatibility absence-time field and original image paths.
The absence field is explicitly labeled as currently unused by this daemon. Streaming now suppresses
start/chunk frames for the issuing client when disabled, while keeping completed responses and
spectator progress. The real browser reproduction caught the previously ignored stream flag.
Original image paths retain the existing protocol meaning: unmatched names create omitted-upload notices; they do not read
files on the daemon host. The existing image picker supplies upload bytes, filenames and MIME types.
Message options persist with the per-tab draft through reload and recovery; successful sends clear
submitted one-shot options while retaining streaming preference. Regeneration exposes both streaming
and guidance; the action palette includes all three core requests. Browser submissions validate
against the generated canonical client-message schema.

Picker and shared admission limits now import the same constants: 16 uploaded images, 5 MiB each,
20 MiB decoded total and UTF-8 filename/media-type bounds. A real browser journey checks complete
payloads, draft reload, rendered uploads and omission notices, non-streamed send/regeneration,
composer focus and active cancellation. Another checks picker rejection without draft loss.

Final verification passed all eight required daemon commands: 7,880 tests across 280 files,
66 mutation passes free of stale patterns, three unchanged independent capture groups, and the
compiled build. All three Rust checks passed: 1,492 tests, 15 existing ignored tests and existing
Clippy warnings. All 31 Playwright journeys passed, as did browser generation/assets and inventory
checks. The 16 core-request and 32 router mutation cases were all killed. Logs use `core-` under
`out/issue-214/resume-2026-09-23/`. This is a checkpoint within the full issue.

## Verified checkpoint — ordinary request recovery, 2026-09-23

This continuation began at `92cea9ab` after the branch was reconciled with main. Required dependency
updates ran first. Bun 1.4.2, Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13, cargo-sweep 0.8.0,
sccache 0.18.0 and actionlint 1.7.12 are current. The refresh updated `ai` to 7.0.111, `openai` to
7.22.0, and Rust's `instability` to 0.3.14. Commit `2d1291f1` contains only those dependency changes,
after all eight daemon and all three Rust baseline checks passed (7,854 Bun tests; 1,489 Rust tests,
15 ignored). The system sccache remains 0.17.0; the current installation is in `~/.cargo/bin`.

The saved browser reproduction still failed after those updates: a Bash write happened, but page
reload removed the uncertain-outcome notice. The integrated implementation records mutation
admission before shared dispatch, retains bounded typed results before forwarding them, and exposes
owner-scoped request history and acknowledgement routes. Messages and regeneration are included.
Read-only operations and session selection do not consume history slots; configuration read policies
are now explicit in the executable catalogue.

Request outcomes use the existing private recovery database, origin/token binding and original
sign-in expiry. There are at most 32 records per sign-in and 256 overall, with 64 KiB per retained
result. Running and uncertain records are never evicted to admit another mutation; oldest terminal
records may be removed. Inputs are not stored separately, but typed results can contain tool inputs
and output. Configuration secrets remain redacted. Confirmed outcomes survive restart; running
records become uncertain. Neither reload nor restart replays a mutation. This is outcome tracking,
not an exactly-once/idempotent request protocol: dismissing or expiring a record removes its duplicate
ID guard. Cache removal and signing out also remove recovery.

The request-history dialog displays all outcomes and retained results, with a workspace notice for
uncertainty. Review in one tab updates the others. Saving admission must succeed before execution;
failure to save a completion closes the transport and leaves an uncertain record. Current selection
comes from the live session router, not the peer's initial snapshot. The underlying command handlers,
cancellation semantics and TCP transport remain shared.

New actual browser journeys cover reload, repeated reload, second-tab review, compiled-daemon restart
from an empty working directory, and SIGKILL after the real tool handler committed but before its
result was delivered. All assert one file write and no automatic replay. HTTP/storage tests cover
ownership, expiry, rotation, capacity, duplicate IDs, selection changes, typed/bounded results and
persistence failures. Configuration browser checks include the retained HTTP results. The phase
coverage check deliberately rejects an omitted uncertainty renderer. The new mutation pass kills
15/15 mutants.

Checkpoint verification: all eight required daemon checks passed (7,874 tests across 279 files,
65/65 current mutation passes, three unchanged independent captures). All three Rust workspace
checks passed (1,492 tests, 15 ignored; existing Clippy/ts-rs warnings remain). All 29 Playwright
journeys passed together, including compiled-binary and process-crash recovery. Browser generation,
embedded-assets reproducibility and capability inventory checks passed. Desktop/mobile review
screenshots were inspected. This is local evidence, not an actual GitHub CI run or required merge gate.

Logs for this continuation are in `out/issue-214/resume-2026-09-23/`. Chromium is restored under
`/tmp/shore-214-tools/playwright`. Use `PATH="$HOME/.cargo/bin:/tmp/shore-214-tools/bin:$PATH"` for the
current tools, and `PLAYWRIGHT_BROWSERS_PATH=/tmp/shore-214-tools/playwright` for browser verification.
The older WIP patch is historical and must not be reapplied to this implementation.

## Historical checkpoint and estimate — 2026-09-20

- Objective: <https://github.com/mythofmeat/shore/issues/214>, including full CLI/TUI capability parity
  and enforced CI gates. A working chat UI or registration of named commands does not complete it.
- Branch: `feat/web-ui`.
- Worktree: `/home/eshen/dev/shore-feat-web-ui`.
- Starting revision for this continuation: `bd419249` — configuration compatibility fixes after the
  archive-transfer checkpoint (`ca557d5b` in this checkout).
- Verified feature commits from this continuation:
  - `a68bbe52` — recover archive outcomes after daemon restart.
  - `8ffd72a2` — cancel queued commands and resumable compaction.
  - `e0889d08` — recover drafts and attachments across tabs and reloads.
- The final wrap-up commit changes documentation only. Unfinished ordinary request recovery was
  saved as an ignored local patch and removed from the working tree; see the resumption notes below.
- The user wants verified commits as work progresses, with dependency updates kept separate.
- GitHub checked on 2026-09-20: issue open, no comments, and no PR for `feat/web-ui`.
  Issue status/comments and the absence of a branch PR were rechecked on 2026-09-23.
  No progress comment, acceptance-checkbox update, or merge-policy change has been published.

Before these three checkpoints, the planning estimate was another 5–9 hours of active work plus
external CI/merge-policy waiting. That is historical, not an updated estimate. The earlier
“two-thirds complete” estimate was not measured and was too optimistic as a time forecast.
Re-estimate from the remaining concrete gaps when resuming; capability, release and CI work
still require substantial verification.

## Implemented and verified

- Optional, default-off web serving, authenticated same-origin transport, shared local sessions,
  bounded connections/queues, and frontend assets embedded into the daemon executable.
- Rust-canonical schemas and generated bindings/validators; all 56 named operations registered for
  execution and discovery. Core message/regen/cancel requests now use executable registrations, discovered schemas and browser controls.
- Conversation/navigation, structured generated actions, schema-backed settings, providers/models,
  diagnostics, memory/segments, a manual tool workbench, usage reports, and character archives.
  Screen presence does not prove every terminal option/event/local workflow is covered.
- Authenticated, session-owned browser archive picking/downloading through controlled artifacts and
  shared command dispatch. Collision refusal, confirmed deletion, restoration, media preservation,
  reload/reconnect tracking, and no automatic replay of uncertain imports.
- Selected independent TCP/WebSocket conformance, actual CLI/TUI/browser journeys, deliberate
  coverage-omission probes, and compiled-executable tests from an empty working directory.

For `ac0141fa`, all eight required daemon checks passed, with **8,278 tests across 268 files**;
all three Rust workspace checks passed; **13 Playwright journeys** passed, including archive
download/restore in the compiled executable. Browser generation and capability inventory checks
passed. Transfer/archive mutation passes killed **30/30 mutants**; **62/62 staleness passes** were
current. Independent recordings were unchanged. One new test's unsafe matcher type was fixed;
final lint/typecheck and the affected suite passed after that fix.

Recent preceding commits: `f5967f28` (archive contracts), `cf7af65f` (usage), `a584bc84` (manual tools),
and `85f916d2` (memory/segments). [WEB_GUI.md](WEB_GUI.md) contains the longer implementation record.
Local logs under `out/issue-214/` are useful evidence but are ignored and are not proof of GitHub CI:
`transfer-browser-full.log`, `transfer-lint-final.log`, `transfer-typecheck-final.log`,
`transfer-generation-final.log`, `transfer-mutations-final.log`, `transfer-mutations.log`,
`bun_test.log`, `bun_run_rerecord_check.log`, and the `cargo_*` logs.

Archive restart checkpoint verification: all eight required daemon checks and all three Rust workspace
checks passed. The Bun suite passed 7,789 tests across 273 files; Rust passed 1,486 tests with 15
ignored. All 15 Playwright journeys passed, including compiled-binary restart recovery. Browser
and inventory generation checks passed, independent captures were unchanged, recovery/archive
mutation passes killed 35/35 mutants, and all 63 staleness passes were current. Full browser checks
also required repairing stale configuration/model/tool fixtures left by the earlier migration.
Logs are in `out/issue-214/resume-2026-09-20/`. Existing Clippy and ts-rs warnings remain.

## Remaining workstreams

These overlap and are not equal-sized tickets.

1. **Recovery and cancellation:** archive restart recovery, ordinary request outcomes, session
   command/compaction cancellation and local drafts/attachments are implemented. Continue the broader
   media recovery audit. Verify revision gaps, stale/duplicate events, thread
   switches during streams, multiple tabs, and terminal/browser concurrency against actual outcomes.
2. **Exhaustive capability coverage:** audit real CLI/TUI variants, options, special runners, core
   message/regen/cancel requests, input fields, meaningful results, known events and useful local
   preferences/keyboard workflows. Close gaps rather than claiming useful capabilities are platform
   exceptions. Extend executable operation/field/renderer/event omission checks across the inventory.
3. **Advanced workflows:** finish diagnostics/event presentation, live manual-tool progress,
   large usage exports, richer message/media handling, and remaining local presentation
   behavior. Preserve designed workflows as well as the generated action fallback.
4. **Security and release coverage:** complete payload/redaction/resource audits, remaining compiled
   advanced journeys, incompatible old-tab DOM recovery, and package/container/release integration.
   Existing embedded-assets/deep-link/default-off/archive tests cover only part of this requirement.
5. **CI and completion evidence:** execute generation/parity/conformance/browser/security gates in
   actual PR CI and inspect results. Coordinate required merge-policy changes separately, as the
   issue requests. Audit every acceptance criterion with evidence of the appropriate scope before
   declaring completion. No required merge gate has been changed or assumed.

## Archive restart recovery checkpoint

Actual browser/process reproductions first showed that a normal restart lost a confirmed import and
that SIGKILL after the shared import handler committed left an orphan upload. Both now have regression
journeys in `daemon/tests/browser/archive_restart.e2e.ts`; the crash fixture holds delivery of the
actual import result rather than substituting a successful implementation.

`daemon/src/web/recovery.ts` stores hashed session credentials and archive metadata in a private SQLite
database under `cache/web/<hash-of-canonical-data-directory>/`. The main character database and its
exports contain no recovery tables. Startup already holds the data-directory lease. Recovery is only
opened when web serving is enabled. The database binds to the origin and daemon token; changing either
invalidates old sessions and transfers. Logout is durable; restart never extends the original expiry.

An import is durably marked `importing` before dispatch. Recovery preserves confirmed outcomes and
converts unfinished imports to `uncertain`, without replay. Temporary uploads, downloads, snapshots
and extraction directories live under the owned recovery directory and are removed on restart.
Incomplete uploads/exports become explicit failures that can be prepared again. This design preserves
outcomes, not temporary archive bytes. Clearing/changing the cache also clears sign-ins and outcomes.
Legacy unowned `/tmp/shore-web-archive-*` directories from older versions cannot be safely attributed
to this daemon and are not swept globally.

Read `daemon/tests/web_recovery.test.ts`, the archive tests, the two process/browser journeys, and
`daemon/scripts/mutate_web_recovery.py` for ownership, expiry, rotation, private storage, orphan cleanup,
staging and dispatch-order evidence. The browser still directs users to inspect characters/history
for an uncertain import; it does not claim a transactionally proven outcome from character existence.

## Shared command/compaction cancellation checkpoint

Following `a68bbe52`, the continuation adds cancellation of running and queued session commands,
visible stop controls in tool/memory/generated-action modals, and delivery of confirmed outcomes
that race cancellation. Compaction propagates the signal to providers and tools, retains its
checkpoint and active history when stopped, and resumes without repeating completed writes.
The generic provider loop now refuses to start a fresh model call after cancellation. Actual
Bash, compaction and MCP browser journeys plus TCP/WebSocket conformance cover these changes.
MCP cancellation remains explicitly unconfirmed; its server may still complete an external effect.
This is a session-wide control, not a new targeted request protocol. Read the latest implementation
record in `WEB_GUI.md` and the current commit history for verification of this checkpoint.

All eight daemon checks and all three Rust checks passed for this checkpoint: 7,799 Bun tests,
1,486 Rust tests with 15 ignored, 18 browser journeys, unchanged independent captures and current
generation/inventory. The cancellation pass killed 12/12 mutants; router killed 31/32 with one
previously documented equivalent survivor. All 64 staleness passes were current. Logs have the
`cancel-` prefix under `out/issue-214/resume-2026-09-20/`.

## Draft and attachment recovery checkpoint

The draft/attachment continuation uses IndexedDB, separate attachment records, per-tab ownership,
revision-safe writes/discards, explicit saved-draft recovery and a persistent send-review marker.
Eight actual browser journeys cover reload, close, cloned/concurrent tabs, paste, interrupted send,
storage failure, unsaved conversation switches and bounds. All eight required daemon checks passed
(7,799 tests, 64 current staleness passes, three unchanged captures). All 26 browser journeys passed;
the 10 affected draft/workspace/packaged journeys passed again after final safeguards. Final lint,
typecheck, build and generation/inventory checks passed. See the latest `WEB_GUI.md` record and
commit history; logs use the `drafts-` prefix in the continuation directory.

## Next work

Continue the broader media and concurrency audit, then close the capability/event/local-preference
inventory, advanced workflow and package/CI gaps listed above. Ordinary uncertain-command recovery
is implemented in the current continuation; archive recovery and draft/attachment recovery remain
separate verified mechanisms. Do not treat these checkpoints as full parity or GitHub CI evidence.

`docs/capabilities/README.md` now accurately records 56 registered operations and zero legacy named
operations. Core request controls are now integrated, but exhaustive terminal preferences/events remain open.
Inspect the extra `}` in the daemon Dockerfile's `COPY --chown` argument during container verification.
No container build, actual PR CI run, or merge-policy change has been completed in this continuation.

The old `out/issue-214/resume-2026-09-20/request-recovery-wip.patch` was reviewed and integrated. It is
no longer a resumable patch against the current tree. Use current sources and tests as authoritative.

Current archive limits: 64 MiB compressed per artifact, 256 MiB aggregate reserved artifact bytes,
four records per sign-in, 32 overall, 15-minute expiry, one bounded worker, five-minute operation
deadline, and processing bounds of 256 MiB/20,000 entries. The export snapshot limit applies to the
full shared database before filtering to one character.

## Resumption and verification notes

Read current `AGENTS.md` and the GitHub issue. Before investigating/implementing, refresh Bun, Rust,
Cargo tooling and both dependency sets, including major versions. In `daemon/`, run
`bun update --latest` and `bun install`; in `client/`, run `cargo upgrade --incompatible` and
`cargo update`. Establish the updated baseline and reproduce the target failure before fixing it.
Inspect installed upstream implementations and matching documentation before adding workarounds.

At the historical 2026-09-20 continuation: Bun 1.4.2, Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13,
cargo-sweep 0.8.0, sccache 0.18.0, actionlint 1.7.12. Both dependency update commands found no changes.
The sccache update used the checksum-verified upstream binary in `/tmp/shore-214-tools/bin/`.
Rustup is package-managed with self-update disabled; its installed version was current.
Rust checks bypassed the unavailable sccache service using `RUSTC_WRAPPER=`. Do not
repeatedly reinstall an already-current sccache: a redundant rebuild previously hit disk quota.

Previous local runs used these conveniences; re-establish them if the temporary paths disappear:

```sh
export PATH="$HOME/.cargo/bin:/tmp/shore-214-tools/bin:$PATH"
export BUN_TMPDIR=/tmp
export BUN_INSTALL_CACHE_DIR=/tmp/shore-214-tools/bun-cache
export PLAYWRIGHT_BROWSERS_PATH=/tmp/shore-214-tools/playwright
export RUSTC_WRAPPER=
```

Required daemon commands: `bun run lint`, `bun run lint:comments`, `bun run lint:citations`,
`bun run typecheck`, `bun test`, `bun run mutate --stale`, `bun run rerecord:check`, `bun run build`.
Required client commands: `cargo test --workspace`, `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets`. Run both groups for shared contracts/behavior.

After Rust contract changes, `cargo test -p shore-common` exports bindings/schemas. Then run
`bun run browser:generate`, `bun run inventory:generate`, `bun run browser:build`, in that order:
the browser contract includes the inventory hash. Verify with `bun run browser:check` and
`bun run inventory:check`. `bun run build` already builds the frontend; follow it with
`bun run playwright test` without an unnecessary second build.

Mutation passes temporarily rewrite production source: wait for their actual process handle to
finish before editing affected source or running ordinary tests/builds. Avoid concurrent full Bun
and Rust suites when temporary-disk quota is tight. Do not dump generated browser assets or raw
terminal capture logs; they can contain enormous single lines. Temporary log/helper paths are not
required project dependencies. Git metadata and Cargo writes may need permission escalation;
appropriate updates and commits are already authorized by the user's instructions.

## Copyable resume prompt

> Continue https://github.com/mythofmeat/shore/issues/214 in `/home/eshen/dev/shore-feat-web-ui`.
> Read current `AGENTS.md`, this handover, `WEB_GUI.md`, the GitHub issue and current git history.
> Preserve the full CLI/TUI parity objective and required CI/merge-gate evidence. Ordinary request
> recovery now joins archive recovery, responsive cancellation, and local draft/attachment recovery.
> Do not reapply the old local WIP patch. Verify current checkpoint results, keep dependency updates
> separate, and continue the remaining media/concurrency, exhaustive capability/event/local-workflow,
> advanced workflow, security/release and actual CI workstreams. Coordinate merge-policy changes
> separately. Only mark the issue complete after auditing every acceptance criterion against current
> evidence of the appropriate scope.
