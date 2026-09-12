# Web GUI handover — issue #214

Updated 2026-09-13. **Implementation is paused at the user's request.** This file does not itself
authorize resuming work.

## Checkpoint and estimate

- Objective: <https://github.com/mythofmeat/shore/issues/214>, including full CLI/TUI capability parity
  and enforced CI gates. A working chat UI or registration of named commands does not complete it.
- Branch: `feat/web-ui`.
- Worktree: `/home/eshen/dev/shore/.worktree/feat/web-ui`.
- Last implementation commit: `ac0141fa` — `feat(web): add controlled character archive transfers`.
- Implementation was committed and the tree was clean at the pause. No restart-recovery code or
  restart-specific reproduction has been written. Only dependency refresh and baselines followed.
- The user wants verified commits as work progresses, with dependency updates kept separate.
- GitHub checked on 2026-09-13: issue open, no comments, last update 2026-09-10T11:56:15Z.
  No progress comment, acceptance-checkbox update, or merge-policy change has been published.

The user reports approximately eight hours of work so far. Budget **another 6–10 hours of active
work**, plus external CI/merge-policy waiting, as a rough planning range rather than a commitment.
The earlier “two-thirds complete” estimate was not measured and was too optimistic as a time
forecast. Allow roughly 2–3 hours for recovery/cancellation, 2–4 for capability gaps, and 2–3 for
release/security checks and CI. Reassess from a concrete gap audit on resumption; hidden parity gaps
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

## Remaining workstreams

These overlap and are not equal-sized tickets.

1. **Recovery and cancellation:** daemon-restart archive outcomes and crash-orphan cleanup; visible
   reconciliation of uncertain mutations; responsive advanced-operation cancellation; durable
   drafts/attachments and media recovery. Verify revision gaps, stale/duplicate events, thread
   switches during streams, multiple tabs, and terminal/browser concurrency against actual outcomes.
2. **Exhaustive capability coverage:** audit real CLI/TUI variants, options, special runners, core
   message/regen/cancel requests, input fields, meaningful results, known events and useful local
   preferences/keyboard workflows. Close gaps rather than claiming useful capabilities are platform
   exceptions. Extend executable operation/field/renderer/event omission checks across the inventory.
3. **Advanced workflows:** finish diagnostics/event presentation, tool/memory progress and
   cancellation, large usage exports, richer message/media handling, and remaining local presentation
   behavior. Preserve designed workflows as well as the generated action fallback.
4. **Security and release coverage:** complete payload/redaction/resource audits, remaining compiled
   advanced journeys, incompatible old-tab DOM recovery, and package/container/release integration.
   Existing embedded-assets/deep-link/default-off/archive tests cover only part of this requirement.
5. **CI and completion evidence:** execute generation/parity/conformance/browser/security gates in
   actual PR CI and inspect results. Coordinate required merge-policy changes separately, as the
   issue requests. Audit every acceptance criterion with evidence of the appropriate scope before
   declaring completion. No required merge gate has been changed or assumed.

## Next task: archive restart recovery

Start with `daemon/src/web/archives.ts`, `auth.ts`, `server.ts`,
`daemon/src/browser/archives.tsx`, and canonical payloads in
`client/shore-common/src/protocol/web.rs`. Existing tests are
`daemon/tests/web_archives.test.ts`, `daemon/tests/browser/transfers.e2e.ts`, and
`daemon/tests/browser/packaged.e2e.ts`.

Both authentication sessions and transfer records currently live in memory. Artifacts use private
`shore-web-archive-*` temporary directories. Reload/WebSocket reconnect within one daemon process
is covered; process restart loses records and a hard crash bypasses cleanup. An import may commit
before completion is observed. Restart must not turn that uncertainty into a safe-to-retry failure.

Before the pause, a fresh toolchain/dependency refresh found no changes. Baselines passed **58 daemon
tests** across transfers/transport/workspace, daemon typechecking, and `cargo test -p shore-common`.
Write and run the actual restart/crash reproduction before implementation. No recovery design was
selected: durable sessions versus separate recovery credentials were only considered.

Useful investigation findings to validate when resuming:

- The daemon already acquires a data-directory lease before starting web serving. See
  `daemon/src/daemon/run.ts` and `daemon/src/daemon/data_directory_lease.ts`.
- `startWebServer` receives an authentication predicate; daemon startup has the underlying token.
  Durable authentication would need explicit treatment of token rotation, logout, expiry, origins,
  cookie ownership and credential storage. Preserve session isolation.
- Character names allow dots and many other characters. Character data lies directly under the
  data root; character cache lies under `cache/characters/`. Recovery state must not collide with a
  character's paths or be deleted/exported as character data.
- Character export snapshots the main `shore.db` before filtering. Private web/session records must
  not accidentally enter character archives.
- Matching installed SQLite documentation is in
  `daemon/node_modules/bun-types/docs/runtime/sqlite.mdx`. Existing storage uses transactions and
  `synchronous = FULL`. The `engine/atomic.ts` rename helpers do not fsync writes.
- Keep disabled-web behavior free of web-specific runtime work. Reuse shared handlers and session
  semantics. Preserve original ownership/expiry and distinguish confirmed from uncertain outcomes.

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

At the pause: Bun 1.4.2, Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13, cargo-sweep 0.8.0,
sccache 0.17.0. Rustup is package-managed with self-update disabled; its installed version was
current. Rust checks bypassed the unavailable sccache service using `RUSTC_WRAPPER=`. Do not
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
> `/home/eshen/dev/shore/.worktree/feat/web-ui`. Read `AGENTS.md`, `docs/WEB_GUI_HANDOVER.md`,
> `docs/WEB_GUI.md`, and the current GitHub issue. The last implementation checkpoint is `ac0141fa`.
> Keep the full issue scope intact and make verified commits as you go, separating dependency
> upgrades. Start by reproducing archive outcome loss and orphan cleanup after daemon restart/crash;
> no recovery implementation has been started. Preserve session ownership, authentication security,
> shared dispatch and uncertain-mutation semantics. Continue through the remaining parity, recovery,
> release/security and CI checklist. Do not treat the 56 named registrations or existing green tests
> as proof of full parity. Coordinate merge-policy changes separately. Report concrete progress and
> remaining gaps; only mark completion after verifying every acceptance criterion.
