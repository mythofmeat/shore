# Web GUI handover — issue #214

Updated 2026-09-20. The user resumed implementation. Full issue completion remains outstanding.

## Checkpoint and estimate

- Objective: <https://github.com/mythofmeat/shore/issues/214>, including full CLI/TUI capability parity
  and enforced CI gates. A working chat UI or registration of named commands does not complete it.
- Branch: `feat/web-ui`.
- Worktree: `/home/eshen/dev/shore-feat-web-ui`.
- Starting revision for this continuation: `bd419249` — configuration compatibility fixes after the
  archive-transfer checkpoint (`ca557d5b` in this checkout). This continuation adds archive restart
  recovery; see the implementation record and current Git history for its verified commit.
- The user wants verified commits as work progresses, with dependency updates kept separate.
- GitHub checked on 2026-09-20: issue open, no comments, and no PR for `feat/web-ui`.
  No progress comment, acceptance-checkbox update, or merge-policy change has been published.

The user reports approximately eight hours of work so far. Budget **another 5–9 hours of active
work**, plus external CI/merge-policy waiting, as a rough planning range rather than a commitment.
The earlier “two-thirds complete” estimate was not measured and was too optimistic as a time
forecast. Allow roughly 2–3 hours for recovery/cancellation, 2–4 for capability gaps, and 2–3 for
release/security checks and CI. Reassess from the remaining concrete gap audit; hidden parity gaps
or failing CI could extend this estimate.

## Implemented and verified

- Optional, default-off web serving, authenticated same-origin transport, shared local sessions,
  bounded connections/queues, and frontend assets embedded into the daemon executable.
- Rust-canonical schemas and generated bindings/validators; all 56 named operations registered for
  execution and discovery. Separate message/regen/cancel variants still need complete integration.
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

1. **Recovery and cancellation:** archive restart recovery and session command/compaction cancellation
   are implemented in this continuation. Finish visible reconciliation of other uncertain mutations; durable
   drafts/attachments and media recovery. Verify revision gaps, stale/duplicate events, thread
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

## Next work

Continue the broader recovery audit: uncertain ordinary
mutations across reload/restart, drafts plus attachments, media recovery, and real concurrent-client
outcomes. Then close the capability/event/local-preference inventory and package/CI gaps listed above.
Do not treat the restart checkpoint as full parity or as proof of GitHub CI/required merge gates.

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

At this continuation: Bun 1.4.2, Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13,
cargo-sweep 0.8.0, sccache 0.18.0, actionlint 1.7.12. Both dependency update commands found no changes.
The sccache update used the checksum-verified upstream binary in `/tmp/shore-214-tools/bin/`.
Rustup is package-managed with self-update disabled; its installed version was current.
Rust checks bypassed the unavailable sccache service using `RUSTC_WRAPPER=`. Do not
repeatedly reinstall an already-current sccache: a redundant rebuild previously hit disk quota.

Previous local runs used these conveniences; re-establish them if the temporary paths disappear:

```sh
export PATH="/tmp/shore-214-tools/bin:$PATH"
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

> Resume https://github.com/mythofmeat/shore/issues/214 on `feat/web-ui` in
> `/home/eshen/dev/shore-feat-web-ui`. Read `AGENTS.md`, `docs/WEB_GUI_HANDOVER.md`,
> `docs/WEB_GUI.md`, and the current GitHub issue. Read the latest archive restart recovery checkpoint above.
> Keep the full issue scope intact and make verified commits as you go, separating dependency
> upgrades. Continue durable drafts/attachments and the remaining recovery/parity audit.
> Archive restart recovery has been implemented and reproduced through actual process/browser journeys.
> Preserve session ownership, authentication security,
> shared dispatch and uncertain-mutation semantics. Continue through the remaining parity, recovery,
> release/security and CI checklist. Do not treat the 56 named registrations or existing green tests
> as proof of full parity. Coordinate merge-policy changes separately. Report concrete progress and
> remaining gaps; only mark completion after verifying every acceptance criterion.
