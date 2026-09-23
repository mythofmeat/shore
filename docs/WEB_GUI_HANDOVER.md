# Web GUI handover — issue #214

Updated 2026-09-23. Implementation and local verification cover the audited issue scope, including
terminal command/options and local workflows, media/recovery, resource/security cases and packaging.
Draft PR #232 carries the implementation. Its live CI results and the external required-merge-policy
constraint determine the remaining acceptance status; this record does not claim that constraint is resolved.

## Active PR and final retention work — 2026-09-23

CI run `35834354211` at `78714bff` completed Rust verification successfully, including generated
exports and dirty-diff enforcement. The daemon native helper, lint/type checks, browser generation
and full tests passed, but mutation staleness failed under the runner's Python 3.12: probing a long
mutant description as a filename raised `ENAMETOOLONG`. Local Python is 3.14.7; Python 3.14's
[documented pathlib behavior](https://docs.python.org/3/library/pathlib.html#querying-file-type-and-status)
already returns false for that probe. The daemon job now uses `actions/setup-python@v7`, `3.x` and
`check-latest: true` to select the latest stable interpreter. Actionlint and all 72 mutation staleness
passes succeeded before this workflow-only correction was committed. No application or mutation
helper code changed. Logs are `ci-python-*`, `pr-232-third-daemon.log` and `pr-232-rust-verified.log`
under the current output directory. The next complete CI run still needs to verify captures,
packaging and browser journeys on the runner.

The user explicitly approved publication to `git@github.com:mythofmeat/shore.git`; draft
[PR #232](https://github.com/mythofmeat/shore/pull/232) is open. Verified merge `55dfd0cc` incorporates
`origin/main` at `d1e5a16a`, including its Claude Agent reasoning fix. The React dependency conflicts
were resolved by preserving the web dependencies. Bun latest/install and Cargo upgrade/update found
no new changes. All eight daemon checks, all three Rust checks, generation/inventory and all 51 browser
journeys passed before that merge was committed and pushed. GitHub now reports the PR mergeable.

The next actual CI run, `35833124915`, reached the Rust tests and exposed an independent fixture
assumption: two connection-manager lifecycle tests had no explicit token and depended on local
configuration or another test initializing one. Running those tests with `SHORE_TOKEN` unset and an
empty XDG configuration reproduced both exact failures. They now initialize the same fixture token
as the existing handshake tests. The isolated reproduction passes all three lifecycle tests; all three
Rust workspace checks passed again before committing this test-only correction. Logs use
`ci-lifecycle-*`; no daemon source changed in this follow-up. The daemon CI job remained at the native-helper build after more than 12 minutes. Its 25-minute
budget left insufficient room for the remaining full suites, so the timeout is now 45 minutes.
The verified token-fixture correction and timeout change are published together for a new full run;
consult the PR for its final result.

The first actual CI run, `35831202015`, failed on missing job prerequisites: daemon tests required the
native patch helper before `bun test`; three Rust image tests launch Bun, absent from that job. The
workflow now builds the helper before daemon tests with stable Rust, and installs Bun plus daemon
dependencies for Rust tests. The daemon timeout accommodates the cold helper build. Actionlint passes.
All required local checks passed before committing the workflow correction separately from the
source fixes. The PR displays the current CI results; the first failed run is retained as evidence of
the corrected prerequisites.

Stash `dc1c1a8e` was applied, retaining the stash as a backup. The three-image fixture now returns
three distinct valid PNGs. Its real-browser reproduction exposed two additional causes beyond omitted
media: live originals lost their owner when provisional tool history merged under the completed
message ID; then the raw completion event overwrote the richer canonical history with only final
text. The browser now transfers ownership only when the exact tool-result block moves into a newly
arriving canonical message, and duplicate message IDs cannot overwrite already saved history.
Omitted/preparation-failed original images remain in the existing correlated `tool_result.images`
field without being added to model input. The three-image view/delete browser flow now passes.

Live previews now retain up to 512 Ki UTF-16 characters each for text and reasoning, 64 tool blocks
with a combined 512 Ki-character serialized budget, 100 activity entries with 64 Ki-character
inspection previews, and 128 live images within a conservative 16 Mi-character payload budget.
Existing streams remain capped at 32. Visible notices explain shortened previews or released images;
canonical history and full operation results are unchanged. Private state and notices clear on
sign-out/conversation changes as applicable. The large-response browser flow remains cancellable.
Twenty-seven focused tests passed, and all 27 targeted resource/image mutation cases were killed.
All eight daemon checks passed: 7,937 tests in 288 files, 104,909 assertions, 72 current mutation
passes, three unchanged capture groups and the compiled build. All three Rust checks passed: 1,493
tests, 15 ignored, clean formatting and existing Clippy warnings. Generation/assets and inventory
checks passed, followed by all 54 browser journeys in 3.5 minutes, including the three new cases.
The refreshed Docker build and enabled/disabled runtime checks passed. Actual compiled Rust CLI
create/send/edit/fork/status/manual-tool/original-image workflows passed again. Logs begin with `retention-` in
`out/issue-214/resume-2026-09-23/`; the first CI failure log uses `pr-232-first-ci-failures.log`.

No known implementation gap remains from this audit. Actual PR CI must be assessed from the latest
run linked on [PR #232](https://github.com/mythofmeat/shore/pull/232); local success is not a substitute
for that evidence. The required-merge-policy API and rulesets API were both rechecked after the first
CI run and still return the GitHub plan constraint below. No billing, visibility or policy changes
were authorized or made. Do not mark the original issue complete while that requirement remains open.

## Current acceptance audit — 2026-09-23

The shared manual-tool batch is committed as `a044ffc0`. The same refreshed dependency/toolchain
baseline and all its full-suite checks underpin this continuing audit. No dependencies changed.
The daemon Docker image built successfully with current base images. Container runtime smoke checks
passed in both enabled and disabled modes: native TCP handshake in both, embedded deep-link HTML,
JavaScript and authenticated sign-in when enabled, no listener or web cache when disabled, and clean
shutdown. Buildx needed a writable metadata directory (`BUILDX_CONFIG=/tmp/shore-214-buildx`); no
credential or global Docker configuration was changed. Logs are `container-*` in the current output
directory. The first smoke script used an incorrect entrypoint; the corrected run uses the actual
`src/daemon/run.ts` package entrypoint and both modes pass.

The command/option gate in `scripts/browser_terminal_coverage.ts` now links all 72 non-UI Clap commands
(281 arguments including presentation/help, 102 wire examples) to canonical fields or explicitly
justified browser adapters. It checks actual syntax trees,
generated wire-example fields, finite choices and full result visibility. Four focused tests pass,
including deliberately omitted commands, options, choices, operations, controls, results and defaults.
The separate UI/display gates remain in effect. All eight required daemon checks passed: 7,932 tests
across 287 files, 104,869 assertions, 71 current mutation passes, three unchanged independent captures
and the compiled build. Generation/assets and inventory checks passed. All 51 browser journeys passed
together in 3.4 minutes. No Rust source or shared behavior changed in this audit batch; the preceding
shared batch passed all three Rust checks. Logs are `audit-*-final.log` in the current output directory.

Two new real-browser journeys pass: incompatible session contracts show Reload workspace without
opening a WebSocket, and the reload recovers; native TCP messages/edits and browser edits converge,
while switching away from an active generation permits an independent side-thread conversation.
The concurrency fixture negotiates the existing `request-lifecycle` capability; cancel has no request
ID or completion of its own and applies to the browser's selected thread. The final cleanup now stops
the held generation after returning to main. This does not change
production cancellation semantics. The full browser suite passed with the common fixture exposing
its TCP port. Remaining work: failed/preparation-omitted media ownership and aggregate live-state
resource bounds, final verification,
reviewable PR and actual CI; required merge policy still has the documented GitHub plan constraint.

The compiled Rust CLI was rebuilt and exercised against a fresh real daemon fixture: create a character,
send, edit, fork, inspect status, run bash, and read an image. All commands completed successfully, and
the JSON manual-tool report contained the original PNG bytes. Logs are `audit-cli-build.log`,
`audit-native-client.json` and `audit-native-daemon.log` in the current output directory. This complements
the native TCP/browser concurrency journey with actual Rust frontend execution.

## Current shared manual-tool work — 2026-09-23

The local-workflow batch is committed as `515aa230`; its full verification is recorded below.
The next required refresh produced no manifest/lockfile changes: Bun 1.4.2, Rust/Cargo 1.98.1,
rustup 1.29.1, cargo-edit 0.13.13, cargo-sweep 0.8.0, sccache 0.18.0 and actionlint 1.7.12 remain
current. Rustup needed an approved metadata write outside the worktree; Bun's read-only temporary
cache was resolved with `BUN_TMPDIR=/tmp` and `BUN_INSTALL_CACHE_DIR=/tmp/shore-214-bun-cache`.
Cargo-edit and cargo-sweep were reinstalled under `/tmp/shore-214-tools`. The combined installation
reported a pre-existing sccache binary; its installed version matches the official latest release,
so no overwrite was necessary. The existing generic-array pin remains the upstream constraint.
The fresh manual-tool baseline passed 45 unit tests, the existing independently reset TCP/web
conformance journey, and the browser tool-workbench journey. The actual browser reproduction then
failed because a successful manual read of an image had no image control in its result.

The verified implementation forwards existing manual tool frames through the shared session
emitter and stamps image frames with the originating request ID. Rust-canonical `ToolRunReport` now
has optional image references; original live bytes take precedence over prepared model copies.
Bindings and operation/web schemas were regenerated. The browser renders those images in the
workbench, generic action results, reopened output and retained request history, using the existing
safe image gallery and downloads. Per-run progress is correlated by `OperationClient`, with up to
64 recent activity entries and 16,000 characters per entry. Manual root tool frames do not create a
phantom active chat response; completed manual requests clear their live subagent stream entries.
Manual media is marked separately so later chat history does not adopt it through reused tool IDs.

The new browser journey passes exact-byte downloads from the workbench, reopened output and request
history after reload, as well as a live tool-start update before completion. The existing workbench
journey also passed. Focused unit/transport checks passed 97 tests. Both independently reset TCP/web manual-tool conformance tests pass, with fixture roots normalized
and actual request IDs, tool IDs and image bytes checked. The new media-ownership test also passes. The shared SDK's installed `Client.callTool` result path and
matching [MCP tools schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts)
were inspected; this fixes Shore's frame capture, without replacing the SDK's existing media parsing.

Conformance, ownership/lifecycle tests, targeted mutation probes and all required verification passed.
Review retained-image/result limits honestly: request history retains
at most 64 KiB per result, so a larger result is explicitly marked omitted; original images are not
promised to persist without limit. The manual runner now retains only tool/image frames needed for its result, while forwarding all
progress; it no longer keeps stream chunks in that private list. The broader aggregate
media/stream/activity memory bounds remain part of the pending audit.
All 14 targeted manual-tool mutation cases were killed. The cross-tab sign-out browser audit
reproduced an old shortcut-result dialog reappearing after a new sign-in. Private dialog state now
clears on sign-out, an epoch prevents late shortcut results reopening it, and workspace errors clear.
That browser journey and both manual-tool journeys passed together. All three required Rust checks
passed: 1,493 tests, 15 explicitly ignored, formatting clean, and Clippy completed with existing warnings.
All eight daemon checks passed: 7,928 tests across 286 files and 104,861 assertions, 71 current mutation
passes, three unchanged independent capture groups, and the compiled build. Generation/assets and
inventory checks passed. All 49 browser journeys passed together in 3.2 minutes. The daemon Docker
image also built successfully; container runtime and actual stale-tab UI checks follow in the acceptance
audit. No PR has been published, and the wider field/event/resource audit remains open.
Logs for this batch begin with `manual-` under `out/issue-214/resume-2026-09-23/`.

## Local editing, output and navigation checkpoint — 2026-09-23

This checkpoint follows `6a1380d5`. Follow [the acceptance checklist](WEB_GUI_ACCEPTANCE.md)
for remaining work against all 12 issue criteria; do not infer completion from checkpoint counts.
The user correctly challenged repeated time estimates. Do not repeat an ungrounded remaining-hours
estimate. Continue toward the full original scope and report concrete evidence.

The required refresh found no manifest or lockfile changes. It did expose an upstream constraint:
`crypto-common` 0.1.7 pins transitive `generic-array` to 0.14.7 through optional `ratatui-termwiz`;
an explicit update to 0.14.9 was rejected. Current top-level dependencies/toolchains were checked.
The focused baseline passed 20 tests and all eight existing draft browser journeys. Actual browser
reproductions then failed for undo after a successful send and the missing expanded editor.

`text_history.ts` and composer changes add bounded text undo/redo shared by the composer
and expanded editor, native history input events, keyboard controls, selection restoration, IME
composition grouping and programmatic send/restore checkpoints. Text history is held only in the
open composer, bounded to 200 snapshots and 8 MiB per stack; current text is not truncated. Attachments,
request options and pending-send state remain separate from text undo. The expanded editor saves
through existing draft storage, preserves edits on close/reload, and shows the latest saved assistant
reply in a separate reference region. Editor/undo/redo are configurable local shortcut targets.

All four new text-history unit tests and all three editor browser journeys pass. The preceding combined
browser run passed the existing eight draft journeys and two editor journeys; its third editor test
exposed focus/undo behavior and now passes after correction. Tests cover exact text/selection recovery,
no extra send, no restored attachments, autosave/reload, last-reply separation, keyboard opening/closing,
and native undo not changing an inactive composer behind another dialog. The mobile editor was
visually inspected. Logs use `editor-` under `out/issue-214/resume-2026-09-23/`.

The installed React DOM textarea implementation and the matching [React 19.3 documentation](https://react.dev/reference/react-dom/components/textarea)
were inspected, along with [Input Events Level 2](https://www.w3.org/TR/input-events-2/). React assigns
programmatic value changes; it does not provide application-level undo across send/editor transitions.
Two further real-flow failures were fixed: editor opening initially focused the modal Close button,
and native undo with another dialog open could reach the previously edited textarea. Focus now restores
after the modal opens, and native history events act only on the focused editor.

The rest of this local-workflow batch now includes last-action output reopening with original
conversation context; automatic reads and post-action view refreshes do not replace it, and sign-out
clears it even when a request completes late. A browser reproduction confirmed that opening the tool
workbench previously replaced a deliberate action result with its background catalogue fetch; the
corrected flow now passes. Workspace help exposes all/quick/config palettes, line-based transcript
scrolling, composer start/end-of-line focus, transcript focus and the current keyboard reference.
Quick actions derive from the generated terminal shortcuts. Scroll presets accept whole lines from
0 to 65535. Configurable edit cancellation discards the edit form while preserving the saved message
and separate draft. Attachment picking/clearing and sign-out are also shortcut targets.

`browser_local_coverage.ts` and its tests account for every generated `shore ui` command, field and
finite choice against actual browser handlers/readers. Representative omitted handlers, implementations,
scroll controls and newly unaccounted terminal fields fail. This is structural enforcement paired with
real browser journeys, not a usability proof. The focused suite passed 46 tests; all three editor and
three local-workflow browser journeys pass. The mobile help layout was inspected. All 15 new local
mutation cases and all 21 updated keyboard mutation cases were killed. All eight required daemon checks passed: 7,923 tests across 285 files and 104,790 assertions;
70 mutation passes with current patterns; three unchanged independent capture groups; and the
compiled build. Generation/assets and inventory checks passed. All 47 browser journeys passed
together in 3.1 minutes, including the empty-directory compiled binary and disabled-web behavior.
Logs are `local-*-final.log` under `out/issue-214/resume-2026-09-23/`. No Rust source or protocol contract changed in this batch.

Next shared-operation work is confirmed at `commands/run_tool.ts`: its `send` callback stores frames
in a private array, the registry does not pass `session.emit`, and canonical `ToolRunReport` has no
images. Existing independently reset TCP/web tool conformance is in `tests/daemon_run.test.ts`; extend
that fixture and `tests/browser/tools.e2e.ts`. Forwarding needs request-correlation review:
`handler/commands.ts` currently stamps tool/stream frames but not `send_image`. Also check the browser
stream lifecycle: a manual tool has tool frames without `stream_end`, while a completed
`request_finished` currently leaves those entries alone. Avoid creating a permanently active chat
response while showing workbench progress. Docker Engine 29.8.1 is reachable, so container verification
can run in the final packaging group; it is not presently an environment blocker.

GitHub required-status-check and ruleset API reads both returned HTTP 403, explicitly requiring GitHub
Pro or public repository visibility. No billing, visibility or merge-policy change was attempted. This
is an external constraint on final acceptance, not a reason to stop unaffected implementation.

## Conversation image gallery checkpoint — 2026-09-23

This continuation began at `4977bfcf`. Required Bun/Rust/tooling and dependency updates ran again before
investigation, with no version or manifest changes. The focused post-refresh baseline passed. The actual
browser reproduction failed at the missing Next image control. Two later real-flow reproductions exposed
duplicate tool image representations and an image remaining after deletion of its tool-result message.

The Images toolbar action and configurable local shortcut open a conversation gallery. Inline image
buttons open the corresponding entry, with captions, previous/next, Left/Right, Home/End, Escape,
downloads, a position count and earlier-history loading. The selected entry survives history updates;
standalone diagnostic/archive images remain viewable. The existing raster MIME/base64 restrictions
remain in place, unavailable/undecodable data has a visible notice, and download names are sanitized.

The workspace now consumes `send_image` and `tool_result.images` as visible media. Original image bytes received live
remain available alongside any differently prepared model copy; byte-identical inline copies use the
named caption, while distinct named attachments remain distinct. Live named media retains at most 128
entries. Attachments merge into canonical history without losing bytes in byte-free updates. Tool images
bind to newly arriving canonical tool-result content, and deletion or replacement removes their cached
original. Reused tool IDs cannot attach a new image to old history. Conversation switches and sign-out
clear the live media cache and close the gallery. Reload restores canonical message images; an original
tool image that exists only in the live event cache is not persisted by this change. These changes are browser-only; the wire contract and
shared tool implementation are unchanged.

The real browser journeys cover two attachments, exact downloaded bytes, mouse/keyboard navigation,
reload, earlier-history completion, a real read-tool image, inline/gallery reconciliation, deleting its
tool loop, another image-producing request, character switching and sign-out. All 17 targeted media
mutants were killed, and the mobile gallery was visually inspected. All eight required daemon checks
passed: 7,916 tests across 283 files, 69 current mutation passes, three unchanged independent capture
groups and the compiled build. Browser generation/assets and inventory checks passed. All 41 browser
journeys passed together after updating two older full-size image assertions to check their actual
captions. Lint and type checks passed again after those test updates. No Rust source or dependencies
changed in this checkpoint; the preceding dependency baseline passed all three Rust checks. Logs use
`gallery-` under `out/issue-214/resume-2026-09-23/`. GitHub currently has no PR for `feat/web-ui`.

Next, finish expanded draft editing and undo after send/editor handoff, reopening action output, and the
remaining focus/scroll/help equivalents. The manual Tool workbench still captures progress/media frames
inside `run_tool` instead of forwarding them; its report does not include images. That is a separate
confirmed gap. Broader media/event/concurrency and resource-limit auditing remains open, including
ownership of a `send_image` frame when no corresponding tool-result image is produced. This checkpoint
does not complete issue #214 or establish actual GitHub CI/required merge gates.

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
