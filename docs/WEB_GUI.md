# Optional browser client — implementation record

Implementation resumed on 2026-09-23. See [the handover and resume prompt](WEB_GUI_HANDOVER.md)
for the current checkpoint, verified results, remaining work and the next task.

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

### Bounded local peer lifecycle

The existing `Server.attachLocal` path now accepts optional outgoing message/UTF-8 byte budgets and
an abort signal. Both its broadcast subscription and direct-reply inbox apply those budgets. A
bounded peer that overflows either stage detaches and reports overflow; it cannot continue after
silently losing state. Drained frames release their byte allowance, and detachment discards queued
frames. Other peers remain attached. Existing connectors retain their default queue configuration.

Server shutdown also detaches local peers. Attach and legacy full-history refresh waits observe
cancellation, so a closed tab cannot create a late session and a stalled history load cannot hold
shutdown open. Sending after detachment fails. Tests exercise these races through the actual local
peer/session router, including oversized initial history and stalled refreshes.

This local-peer change is a prerequisite for the browser adapter described below.
The installed Bun 1.4.2 types and matching [WebSocket documentation](https://bun.com/docs/runtime/http/websockets)
provide native payload, backpressure and connection lifecycle controls; use those controls alongside
the bounded in-process peer rather than relying on a browser socket to bound upstream queues.

Lifecycle validation: all eight required daemon checks passed with 8,133 tests, including the
existing TCP and Matrix suites. The server mutation pass kills all eleven mutants, including a
new real-socket disconnect-during-history test that catches a stale session or handler error.
All Rust workspace tests, formatting and Clippy passed after a
checked-JSON-access correction in the new correlation test. The contract commit was amended with
that correction. No generated contract changes were needed for the local-peer lifecycle work.

### Optional authenticated browser transport

The daemon now supports a default-off web listener using Bun's native HTTP, TLS and WebSocket
implementation. It binds before opening runtime stores, accepts API requests only after the shared
handler starts, and closes on initialization failure or daemon shutdown. Disabled serving does not
create a listener, authentication timers or web sessions. TCP remains available in either mode.

```toml
[daemon.web]
enabled = true
bind_addr = "127.0.0.1:7340"
```

All web settings are visible through the existing configuration schema and require restart. Bind
addresses must use an IP literal or `localhost`. A non-loopback listener additionally requires
`tls_cert`, `tls_key` and an exact HTTPS `public_origin`. For example, a listener on `0.0.0.0:7340`
can use `public_origin = "https://shore.example:7340"` with certificate/key paths on the daemon host.
A loopback listener can instead sit behind a same-origin HTTPS reverse proxy: configure the public
HTTPS origin and preserve the public Host header and WebSocket upgrades. Direct remote plaintext
listeners and remote HTTP origins are rejected. Provider credentials are never part of this setup.

The browser signs in by posting `{ "token": "…" }` to `/api/login` with the existing daemon client
token. The response sets an opaque, host-only, HttpOnly, SameSite=Strict session cookie; HTTPS also
sets Secure and uses the `__Host-` prefix. Tokens and cookies do not appear in returned JSON or URLs.
Sessions expire after eight hours, including open sockets; logout immediately revokes the cookie
and every socket using it. In-memory authentication sessions are bounded to twice the connection
limit. Restarting the daemon invalidates them. All API routes require the exact browser Origin and
Host, reject cross-site/same-site fetches and query parameters, and return no-store security headers.

`POST /api/session` reports the authenticated session and contract fingerprint. `GET /api/swp`
upgrades only after authentication, origin checks and an exact `shore-web-1.<fingerprint>` subprotocol
match. A stale contract receives HTTP 409 with `reload_required` before any peer/history access.
The fingerprint includes generated wire inventory and Rust-owned operation/web schemas. HTTP login,
session and problem payloads also derive from Rust definitions; CI checks their generated artifacts.
No browser UI or static assets are served by this transport milestone.

Each WebSocket sends a normal SWP hello with `client_type: "web"`, then waits for server hello/history.
The adapter applies the same wire decoder and admission rules as TCP, then forwards messages through
`attachLocal`. Each tab has independent character/thread selection. Commands and generation requests
require a distinct pending ASCII request ID of 1–128 bytes without NUL. The shared request-completion
event releases pending allowance after the command/provider settles. Cancel uses the existing immediate control route. Creation now
refreshes the shared runtime, indexes and autonomy before acknowledgement, and shared routing preserves the original
request ID when a generation is cancelled or superseded.

Default limits are 16 sockets, 32 pending requests per socket, 32 MiB incoming frame size, 32 MiB
aggregate pending request bytes, 128 incoming messages per second (32 MiB total), and 32 MiB queued
bytes at each outgoing stage. `max_connections` accepts 1–256 and `max_queued_bytes` accepts 1 KiB–128
MiB. Local queues also cap at 128 frames. Login bodies cap at 4 KiB, sign-in attempts at 60 per minute,
and hello messages at 64 KiB. Hello/attachment and network drain each have a ten-second deadline.
Binary messages are rejected. Overflow closes the affected peer with an explicit reconnect/resync
reason; a partially buffered native send is never resent. Logout/expiry, stalled attachment, socket
failure and daemon shutdown all detach the local peer. Existing shared image limits still apply.

Transport tests use real HTTP(S) and WebSocket connections, with a locally trusted test certificate
and certificate verification enabled. They cover authentication-before-history, origin/Host/token
URL rejection, cookie revocation/expiry, native HTTP limits, malformed frames, session/request/byte
limits, distinct tabs, stale contracts, a paused network reader and shutdown. Full-daemon journeys
create/select a character from an empty installation, send, fork with advanced options, and compare
persisted history with TCP; a held provider is cancelled 33 times without exhausting request slots.
Creation and cancellation failures were reproduced before their shared-path fixes. Startup failures
are checked for released listeners, instance registration and data-directory ownership. These tests
exercise transport clients, not a browser DOM or the still-unimplemented GUI.

An executable smoke test copied the compiled daemon into a temporary directory and ran it from
otherwise empty working directories. Disabled web left TCP commands available and no HTTP listener;
enabled web authenticated and returned history over WebSocket. Both exited cleanly on SIGTERM.
This exposed and fixed two shared TCP lifecycle defects: connections arriving between bind and serve
were left unmanaged, and a disconnected client's pending 30-second ping timer delayed process exit.
The listener now closes early connections and the message loop cancels its timer on every exit using
the [standard abortable timer API](https://nodejs.org/api/timers.html#cancelling-timers).
A real-socket test and a child-process test exercise these paths;
deliberately removing either cleanup is detected. Frontend assets/deep links and the full packaged
browser workflow remain part of the later release milestone.

Transport validation: all eight required daemon commands passed with 8,175 tests; all 55 mutation
passes have current source patterns. The browser mutation pass killed all ten mutants, the TCP
server pass all twelve, the daemon startup pass all twenty-five, and routing killed thirty-one
with one previously documented equivalent retained. Tightening configuration assertions recovered
all thirteen uncovered cases in the broader validation mutation run, which now kills all eighty-five
mutants. A separate ping-timer cleanup mutation is also detected by the child-process regression.
Rust workspace tests, formatting and Clippy also pass for the final transport changes.
Actionlint accepts the generation workflow. Logs remain in `out/issue-214/`; GitHub execution and
merge-policy enforcement remain unverified.

### Browser connection and synchronization foundation

The browser connection layer now signs in with the existing cookie API, negotiates the contract,
waits for a complete initial history, and reconnects with its last confirmed character/thread.
Rust-owned schemas cover the complete current wire. Browser validators are generated ahead of time
using [Ajv standalone generation](https://ajv.js.org/standalone.html), preserving the strict CSP;
a bundled-validator test disables dynamic code generation. Known malformed events stop the connection.
Unknown future events remain explicitly inspectable and additive fields survive validation.

Shared, independently specified event sequences in `fixtures/protocol/sync.json` run in both Rust
and TypeScript. They check distinct snapshot/message revision watermarks, duplicates, stale/foreign
events, missing deltas, null/main thread compatibility and selection changes to older revisions.
A gap triggers a fresh connection and complete history. Transport interruption rejects pending
promises with an uncertain-outcome error and publishes the request plus its original selection for
reconciliation. Requests are never automatically replayed. Cookie expiry requests sign-in;
incompatible contracts request a page reload before peer attachment. Client requests and queued
bytes are bounded, and cancellation bypasses pending request admission.

The shared handler sends opt-in `request_finished` events directly to the issuing peer even after
it selects another thread. Outcomes distinguish completion, failure, cancellation and supersession.
Failure details therefore remain visible without mixing background stream content into the current
thread. The completion event follows actual handler/provider settlement, so cancelled providers
that ignore abort cannot free pending allowance while continuing to run. Existing terminal clients
do not announce the new capability and preserve their previous event sequence. Golden Rust tests
cover correlation and all outcomes.

Native WebSocket tests exercise the actual browser connection class: sign-in/out, bounded pending
requests, controls, correlated completion, uncertain mutations, selected-thread reconnect, revision
gaps, expiry, stale contracts and malformed/future events. Full-daemon tests restart the daemon at
the same address, sign in again, and recover the selected thread and persisted question/answer.
A separate held-provider journey switches threads mid-stream and still receives completion for the
original request. Deliberately removing that completion reproduces the timeout through this journey.
These are transport/state tests; browser DOM workflows, rendering, drafts and user-facing outcome
reconciliation are still outstanding.

State-layer validation: all eight required daemon checks passed with 8,197 tests and all 56 mutation
passes free of stale source patterns. The new browser-state mutation pass killed all ten mutants,
including replaying an uncertain mutation, accepting stale contracts and delivering discontinuous
history. Rust workspace tests, formatting and Clippy passed. Browser validator regeneration and
the capability inventory check passed; Actionlint accepted the expanded PR generation workflow.

UI tooling preparation: React/React DOM 19.3.0, their matching type packages and Playwright 1.63.0
were installed at their current stable releases in a separate dependency change. All eight daemon
checks passed again with 8,197 tests before UI implementation. Playwright's downloaded Chromium
153.0.8010.12 headless shell successfully launched and rendered a test page in this environment;
the browser cache is at `/tmp/shore-214-tools/playwright`. No browser application or end-to-end GUI
coverage is implied by this tooling smoke test.

### Conversation contracts and rich history

Twenty-one named operations now have Rust-canonical input/result pairs and executable handler
registrations. The latest slice covers log/history paging, individual messages, editing, deletion,
alternative listing/selection, system instructions and operation discovery. Discovery uses the same
registry as dispatch and reports actual character/thread availability; it remains usable with no
characters or a character whose configuration cannot load. Thirty-five legacy names remain.

The browser's typed operation client validates inputs before submission, validates correlated results
after confirmed completion, rejects malformed/missing/duplicate results and reports confirmed failures.
Additive result fields remain inspectable. Its validators are generated ahead of time from the same
Rust schemas and run without dynamic code generation. CLI log/get runners validate their paired
results while retaining additive JSON output; log/get/edit/delete/system-message mappings use canonical
inputs. Existing captured command results remain independent assertions. Previously ignored or
unsupported input fields now receive explicit validation errors.

The migration reproduced a real history failure: persisted tool results containing structured text
and images could not pass the browser's old string-only wire schema. Rust now owns the recursive
text/block result shape and inline image source. History and terminal stream blocks preserve these
values. A shared rich-history fixture checks lossless Rust/browser decoding, and TUI tests exercise
the existing image viewer's entries, including recovery from a stream with no preceding chunks.

A native browser-connection journey starts with no characters, discovers available actions, creates
and selects a character, sends and regenerates a turn, selects an alternative with precedence options,
edits and inspects a message, pages history, adds instructions and deletes messages. It compares the
resulting history with TCP and persisted engine state. Separate transport tests reject invalid inputs,
wrong/missing/duplicate results and confirmed failures. These are application/transport journeys;
the visible browser application remains the next implementation slice.

Verification: all required daemon checks passed after fixing lint/type errors and moving stale
mutation probes to the registry. The full suite passed 8,206 tests; the final changed-test run passed
201 tests, including a new log-filter assertion. All 57 mutation passes are free of stale patterns.
The five new browser-operation mutants, all 22 dispatch mutants and three relocated mutation probes
were killed. Rust workspace tests, formatting and Clippy passed. Inventory/validator regeneration
checks and Actionlint passed. The compiled daemon ran from empty working directories with web both
disabled and enabled; TCP, authenticated WebSocket history and clean shutdown worked in both cases.

### First browser workspace

The optional listener now serves a React conversation workspace, cookie sign-in, character/thread
navigation and deep links. Conversation controls include send/stop, guided regeneration, message
editing/deletion, alternative inspection/selection, system instructions and earlier-history paging.
Thread creation and advanced forks use the shared contracts. A searchable action dialog renders
every field of the 21 currently registered operations, including optional/null distinctions,
enumerations, numbers, booleans and string collections. Destructive actions show the exact submitted
values for confirmation. Complete command results remain inspectable.

The connection and workspace state are separate from React. History deltas replace only their suffix,
preserve earlier pages, detect missing anchors and retain image bytes omitted by incremental updates,
matching the TUI. Draft text is stored per character/thread; reasoning/tool preferences are local.
Interrupted requests remain visible for explicit reconciliation and are never replayed. Stream text,
reasoning, tools, subagent activity, warnings, phases and structured result/configuration data have
declared handling and inspectable presentations. The activity panel currently retains the latest
100 non-token events. Image selection uses the existing message upload path, with browser size/type
limits; the viewer accepts embedded raster data, supports download and never treats a server path
as an arbitrary fetch URL. Attachments remain in memory while the page is open.

Browser JavaScript and CSS are built into a generated module imported by the daemon, with hashed asset
URLs and the embedded release contract. The normal daemon build constructs the frontend. Public
HTML/assets do not attach peers or disclose history; API requests retain the existing authentication,
Origin checks and CSP. Browser code has its own DOM-only TypeScript project. The container now copies
the generated capability data and constructs its frontend during image creation.

Coverage tests inspect the actual field-renderer and event-dispatch syntax, compare them with the
canonical contracts, and deliberately remove a numeric renderer, image event handler and field
presentation to prove failures. Unsupported input schemas fail the control check. These checks cover
the migrated contracts; they do not yet close the remaining terminal inventory or legacy operations.

Two real Chromium tests pass: a complete workspace journey (including advanced fork options,
confirmation/cancellation, independent thread state, draft reload, escaped hostile text, image
upload/viewing, CSP and phone navigation), and a copied compiled executable launched from empty working
directories with web both disabled and enabled. The latter checks TCP availability, actual browser
sign-in, character creation, embedded assets, deep-link reload and shutdown. Desktop and phone
screenshots were reviewed. All eight required daemon checks passed with 8,211 tests and 57 current
mutation passes; browser assets/validators and the capability inventory regenerate exactly. The PR
workflow installs Chromium and runs the browser suite. Container build and runtime verification are
recorded in `out/issue-214/`. GitHub execution and merge-policy enforcement remain unverified.

### Provider catalogue and discovery

The canonical catalogue now includes `list_providers`, `list_provider_models`,
`refresh_provider_models` and `refresh_all_provider_models` (25 registered operations;
31 legacy names remain). These bind the existing provider handlers. All four use global
configuration and work without a selected character, including batch refresh. The former
special route for single-provider refresh has been removed.

Inputs reject misspelled fields and string/number boolean substitutes; omitted or null
`include_hidden` still means false. Results type key availability, cache counts and timestamps,
static/discovered model metadata, subscription details, and each batch success/failure/skip.
Rust and browser validators require the batch `ok` flag to match its result shape. Required
nullable result fields must be present. CLI and TUI provider commands use canonical inputs and
validate results before rendering, retaining additional fields in JSON views.

The Providers panel shows key availability without key values, discovery status, cache freshness,
model capabilities, filtered model search, hidden models, and single/batch refresh outcomes.
Partial failures remain visible alongside successes and skipped providers. The generated action
forms also offer live provider choices and preserve the explicit-null filter option.

The browser journey uses the real daemon plus a local discovery HTTP fixture, starting before any
character exists. It verifies refresh/cache changes, hidden-model selection, model search, partial
failure and skip details, generated controls, mobile layout, and the absence of direct browser
provider requests or exposed fixture credentials. The CLI socket flow rejects malformed provider
results and retains additional fields; TUI rendering and Rust/TypeScript contract regressions cover
the same result guarantees. The original independent provider captures remain intact; formerly
coerced invalid input examples now explicitly assert rejection at the canonical input boundary.

All eight required daemon checks passed (8,213 tests), along with the Rust workspace suite,
formatting and Clippy. Generated browser assets/validators and both capability inventories were
checked. All three browser journeys passed, including the compiled daemon, and the provider,
command-path and dispatch mutation passes killed 90/90 probes. Evidence remains under
`out/issue-214/` and the task's temporary verification logs.

### Settings and configuration parity

The canonical catalogue now includes `config`, `config_schema`, `config_check`, `config_reload`
and `tools`: 30 registered operations, with 26 legacy names remaining. Configuration kinds,
sources, schema entries, mutation/reload results, invalidation details and tool access all have
Rust-owned bindings. The actual TypeScript configuration readers use those generated kind/source
types, and `config_schema` derives its live entries from the existing parser metadata.

The Settings panel provides searchable keys, effective values and defaults, typed booleans,
numbers, enums, durations and collection editors, live value suggestions, writable/optional status,
restart notices, configuration checks, reload preview/apply, prompt-snapshot choice and tool access.
Non-writable sections remain inspectable and link to their individual fields. The generated action
forms include configuration-key suggestions and hide secret values in password inputs. Secret
metadata comes from the daemon's existing redaction paths. Successful secret writes clear the input,
rejected writes retain the draft, and uncertain configuration requests hide submitted values in the
activity/reconciliation view. Settings drafts remain in memory while their dialog stays open.

Configuration operations use the selected character when available and also work globally before
character creation. Reload without a character can preview/apply global configuration; prompt
snapshot activation still requires a selected character. Both routes use the same configuration
handlers and post-processing. Null reload flags remain false; malformed flags and keys are rejected
before mutation. The original independent captures remain intact, with formerly coerced invalid
examples now explicitly rejected at the canonical boundary.

The shared list parser now accepts quoted collections without splitting commas inside arguments,
while retaining the existing simple comma-separated syntax. Rejected secret edits no longer echo
the submitted secret in the error prefix. Reload retains restart requirements computed before
configuration adoption. A native daemon journey verifies these reload effects, persisted rollback
of a rejected secret edit, and matching TCP/browser reads.

CLI configuration adapters and the reload special runner use canonical inputs and validate results
before formatting. The TUI did not apply reload previews because it waited for a missing `applied`
field while the daemon sends `applied: false`. A real pseudo-terminal/local-socket regression first
reproduced the missing apply request, then passed with the canonical preview/apply flow. Prompt
activation remains opt-in, with separate correlated requests and no preview replay.

The browser journey edits every supported scalar family, preserves an embedded comma in a list,
retains rejected input, confirms persisted values after reload, exercises global reload/check/tool
access, verifies secret redaction and reviews the mobile layout. Coverage checks walk live settings
and actual field renderers, and demonstrably fail on a missing numeric renderer or unsupported kind.
Each browser journey now owns a fresh daemon fixture and configuration directory through
[Playwright test fixtures](https://playwright.dev/docs/test-fixtures), after the combined suite
exposed a settings change leaking into the subsequent conversation journey.

Settings validation: all eight required daemon checks passed, including 8,217 tests and all 57
mutation-staleness passes. Rust workspace tests, formatting and Clippy passed, including the actual
terminal reload regression. All four browser journeys passed, and generated browser assets,
validators and operation inventories are current. The three affected mutation passes killed 101
mutants and retained one pre-existing, explicitly documented equivalent mutant. Temporary-storage
quota failures were resolved by clearing this task's disposable download cache before rerunning
the full daemon and Rust checks successfully. GitHub execution and merge-policy enforcement remain
unverified.

### Models, role selection and sampler preferences

The seven model operations now use the canonical Rust catalogue: `list_models`, `favorite_model`,
`model_info`, `switch_model`, `reset_model`, `model_settings` and `set_model_setting`. This brings
the registry to 37 operations, with 19 legacy names remaining. Inputs require names for favorites
and keys for setting writes, reject unknown fields and constrain background targets and preference
scopes. Selection and reset results add a `target` discriminant while retaining existing result
fields, so clients validate the required details for current, thread, character and role outcomes.
The shared model, catalogue and sampler-schema implementations consume generated types.

The Models & roles panel provides model search, hidden-model and favorite filters, explicit favorite
updates, thread chat selection, all/named background and subagent targets, role reset, named-model
inspection, and global/character sampler preferences. Effective values, saved layers and sources
remain visible together. The existing live sampler registry supplies setting kinds, applicability,
suggestions and slider hints. Vendor objects use recursive named fields and typed arrays, booleans,
numbers, strings and null controls. No raw JSON entry is required. The action catalogue also exposes
every model operation with live model, subagent and setting-key suggestions.

The expanded real flows reproduced and corrected shared reporting errors: global preferences were
invisible before character selection, inherited background/subagent roles incorrectly reported a
thread-only chat pin, and subagent model information used chat sampler preferences. Model information
now uses the existing target-aware settings resolver. Background settings can also be inspected
without an attached character. The independent legacy capture remains unchanged; its former
characterless-background error is explicitly adapted in the test to the now-supported result.

The CLI mapping and model-selection special runner use canonical inputs and validate model results
before formatting; the TUI validates those results too. Real command-line and pseudo-terminal
journeys exercise targeted selection, global vendor settings and malformed-result rejection. An
independent-world TCP/WebSocket scenario compares all seven operations, correlated results/errors,
global and character preference files, role configuration and thread pins after every command.
It covers divergent background roles, shared/named subagents, preference precedence, clears and
invalid inputs. The browser journey exercises global settings before onboarding, persisted favorites
and preferences after reload, hidden models, chat/background/subagent selection, role reset,
structured vendor settings and a narrow mobile viewport. Renderer coverage walks live provider
settings and fails when a required renderer is removed.

Model validation includes 8,225 daemon tests, the required daemon checks, Rust workspace
tests/formatting/Clippy, all five browser journeys, and current generated browser validators/assets
and capability inventories. Five affected mutation passes killed 202 mutants, with one pre-existing,
documented equivalent mutant retained. They check inherited sources, discovery metadata,
preference-key and model preservation, absent versus cleared settings, all scope fields, numeric
coercion, legacy replay booleans and wire ordering. The existing independent captures were not regenerated.
Full application parity, GitHub CI execution and required merge gates remain unfinished.

### Diagnostic inspection and runtime controls

Eleven diagnostic operations now use the canonical Rust contracts and executable registry:
`status`, `error_log`, `heartbeat_log`, `call_log`, `transcript`, `subagent_trace`,
`heartbeat_tick_now`, `heartbeat_set_dormant`, `heartbeat_set_active`, `keepalive_ping_now`
and `session_activate`. There are 48 registered operations and eight legacy names remaining.
Inputs preserve nullable optional filters, signed call IDs and zero-count semantics. Call inspection,
index health, stored traces, diagnostic rings and runtime outcomes have concrete result types.
Captured provider/transcript bodies retain their original open payloads. Status sections can name
future fields, which remain available in the original result. Runtime prerequisites and provider-call
effects come from the registry. Signed integer validation rejects IDs outside JavaScript's safe range.

The Diagnostics panel provides status sections, call filtering and ID lookup, full wire captures,
previous/explicit call comparisons, heartbeat and memory-recall transcripts, heartbeat events,
errors and key fallbacks, and stored subagent runs with parent-ID filtering and retained expiry
metadata. Readable results keep a complete JSON inspector; every inspector now offers a JSON
download. Runtime controls activate sessions, schedule heartbeats, change active/dormant state
and send keepalive pings. Availability follows the live catalogue; failures retain filters and the
last inspected call. Zero means all matching stored calls/transcripts/subagents, while zero recent
entries returns none from diagnostic rings and heartbeat logs.

CLI status/trace/debug mappings use canonical inputs. Both terminal renderers now derive registered
result validation from the canonical catalogue, so adding an operation also enables validation in
the generic terminal path. Real CLI and pseudo-terminal journeys exercise full wire/diff arguments,
transcript sources, status JSON, runtime outcomes, malformed results and scrolling through complete
raw results. An independent-world TCP/WebSocket journey compares all eleven operations, filtered
captures, errors, correlated completion and resulting heartbeat state. The browser journey covers
onboarding availability, empty and unlimited filters, safe rendering of HTML-like capture text,
redacted wire-header downloads, future payload fields, comparison errors and recovery, expired
subagent messages, all runtime controls and mobile layout. A broader payload/redaction audit and
reconnect/concurrency/cancellation coverage remain part of the unfinished issue.

Diagnostic validation passed all required daemon checks with 8,229 tests, the three required Rust
checks, all six browser journeys, and browser-generation/inventory checks. Five affected mutation
passes killed 133 mutants; all 57 staleness passes are current. Independent legacy captures remain
unchanged. GitHub CI execution and required merge gates remain unverified.

### Memory and segment workflows

`compact`, `segments` and `clear` now use canonical Rust input/result contracts, registered daemon
handlers and generated browser validators. There are 51 registered operations and five legacy names
remaining: `run_tool`, `usage`, `delete_character`, `export_character` and `import_character`.
Segment label/note arguments preserve omission, explicit null and empty text. All five compaction
outcomes retain their distinct fields, including paused checkpoints and partial writes. Shared
argument policies control preview effects and confirmations in both the dedicated panel and the
generated action form. Unknown policy fields fail discovery.

Memory & segments provides retained-turn controls, previews, resume/restart, archive-only clearing,
segment inspection, include/exclude, label/note edits and failed memory retry. Archived messages,
memory revisions and complete downloadable JSON stay inspectable. Errors preserve the last selected
segment and unsaved metadata. An executable renderer gate checks every canonical compaction status
and demonstrates failure when the paused renderer is removed.

The real browser preview exposed a shared credential propagation bug: chat could use the daemon's
configured environment while compaction's rebuilt requests fell back to the process environment.
Compaction, autonomous compaction and cache rebuild assembly now pass the configured environment
through the existing credential resolver. Tests supply the provider key only through daemon options.
The cache fixture now exercises successful keepalive requests after rebuilding instead of depending
on that missing-key failure to skip the request.

Two browser journeys cover all compaction outcomes, confirmations, retained history, failed-memory
retry, metadata clearing, failed lookup recovery, downloads, reload persistence and mobile layout.
A 34-step independent-world TCP/WebSocket journey compares results, errors, request completion,
active history, archived segments, memory file contents and checkpoint state, including side-thread
isolation. Real CLI and pseudo-terminal tests cover the three commands, explicit argument forms,
all compaction result variants, malformed results, scrolling and archive confirmations.

Memory validation passed all eight required daemon checks with 8,234 tests, all three Rust workspace
checks, all eight browser journeys, and generation/inventory checks. The five affected mutation
passes killed 85/85 mutants, and all 58 staleness passes are current. One old segment probe addressed
a directory argument superseded by durable storage; it now mutates the actual active-message read,
with explicit assertions that clearing a side thread preserves home's active messages. The Rust
checks bypassed an unavailable sccache service using `RUSTC_WRAPPER=`. GitHub CI execution, required
merge gates and the remaining acceptance criteria are still unverified or unfinished.

### Manual tool workbench

`run_tool` now uses canonical Rust input/result contracts, a registered daemon handler and generated
browser validators. There are 52 registered operations and four legacy names remaining: `usage`,
`delete_character`, `export_character` and `import_character`. Tool and subagent CLI mappings use
the canonical input type. Results distinguish complete tool definitions from execution reports,
including rejected inputs, failures, truncation, full output and nested calls. Read-only descriptions
skip execution confirmation in the browser and TUI; an actual manual run still asks for review.

The workbench discovers built-ins, configured subagents and connected MCP tools, displays each live
schema and edits its fields. Controls preserve multiline strings, optional omissions, nested objects
and arrays, booleans, nullable values, enums and typed dictionaries. String overrides use the daemon's
existing schema-based conversion and override matching structured arguments. Unsupported schema
constructs explicitly select the structured advanced editor, with full server validation. The
generated action form also exposes every canonical option. Complete definitions and results have
JSON downloads; execution errors preserve the arguments and last selected definition.

A browser journey exercises file creation and replacement, rejected arguments and recovery, full
output beyond the configured window, subagent reads, a real MCP server with nested/nullable inputs,
the generated form and mobile layout. A 15-step independent-world TCP/WebSocket journey compares
definitions, results, errors, completion and resulting files. Real CLI and pseudo-terminal journeys
exercise structured inputs, string overrides, description/run confirmations, both result variants,
raw nested output and malformed-result rejection. An executable schema/control gate covers every
built-in and subagent schema plus a representative MCP schema, with deliberate renderer omissions.

Before implementation, toolchains and dependencies were refreshed again. Bun 1.4.2, Rust/Cargo
1.98.1, cargo-edit 0.13.13, cargo-sweep 0.8.0 and sccache 0.17.0 matched current stable releases.
Both dependency update/install sequences completed without changes. The package-managed rustup
cannot self-update; its installed 1.29.1 matches the upstream stable manifest. Baseline daemon and
CLI checks passed before the absent browser workbench was reproduced. Rust checks continue to
bypass the unavailable sccache service with `RUSTC_WRAPPER=`.

Tool validation passed all eight required daemon checks with 8,238 tests, all three Rust workspace
checks, all nine browser journeys, and browser-generation/inventory checks. Three affected mutation
passes killed 44/44 mutants, and all 59 staleness passes are current. Independent legacy recordings
remain unchanged. GitHub CI execution and required merge gates remain unverified.

Live manual-tool progress, targeted cancellation, recovery after closing/reconnecting the workbench,
and broader dynamic MCP schema coverage remain unfinished acceptance work.

### Usage reports and exports

`usage` now uses a canonical Rust contract and registered handler, with 53 registered operations
and three legacy names remaining: `delete_character`, `export_character` and `import_character`.
The normal command dispatcher has no unregistered execution branches. Usage can run before a
character is selected because its handler reads the shared ledger and effective configuration.
The missing-ledger error remains unchanged. CLI filters preserve their existing explicit nulls,
and the TUI's automatic budget refresh also uses the typed operation.

All six result modes have typed fields, including grouped totals, budget and pace scopes, cache
coverage/anomalies, unsettled attempts, rate-limit readings and cached subscription quotas. The
existing ledger, budget, cache and provider modules reference generated types rather than maintain
separate report shapes. The original query, budget and export implementations remain in use.

Usage & budgets provides period/character/provider/key-name/model/call-type filters, all grouping
dimensions, budget meters, cache and provider-limit views, full inspectors and CSV/TSV downloads.
Tables expose additional fields and keep full precision in downloadable JSON. Errors preserve the
entered filters and last report. The generated form exposes all options and preserves the daemon's
mode precedence. Budgets use their configured scopes; report filters do not redefine those scopes.

A real browser journey covers reports before onboarding, every view/grouping, combined filters,
empty results, invalid-period recovery, export downloads, mode precedence and mobile layout. A
22-step independent-world TCP/WebSocket comparison checks results, errors and completion while
asserting the ledger's calls, attempts and warning records remain unchanged. CLI and pseudo-terminal
journeys check all report variants, exact filters, CSV/TSV bytes, full-result scrolling and malformed
results. Removing an export renderer fails the executable coverage check.

Toolchain/dependency refreshes again found no changes; the stable versions recorded for the tool
increment remain current. The package-managed rustup self-update limitation and sccache bypass
remain the same. Fresh daemon and CLI baselines passed before reproducing the missing usage screen.

Usage validation passed all eight required daemon checks with 8,244 tests, all three Rust workspace
checks, all ten browser journeys, and browser-generation/inventory checks. The usage, browser
operation and dispatch mutation passes killed 45/45 mutants; all 60 staleness passes are current.
The API key filter probe initially survived and now fails assertions for configured names and
older unnamed records. Independent legacy recordings remain unchanged. GitHub CI execution and
required merge gates remain unverified.

Large-export transfer limits, reconnect/restart recovery and complete local usage/budget display
preferences remain part of the unfinished acceptance work.

### Character archive contracts

`export_character`, `import_character` and `delete_character` now have canonical Rust inputs and
results, generated validators and registered daemon handlers. All 56 named operations are registered;
both dispatch entry points now use the registry exclusively. The inventory rejects legacy switch
branches even when regenerating its output, and checks registration keys against canonical names.
Representative omissions and reintroduced legacy branches fail executable tests.

The existing archive implementation still owns snapshots, extraction rules, collision refusal,
backup-before-delete ordering, storage restoration and cleanup. Its result types now reference the
generated contracts. CLI exports/imports use typed arguments, while the special deletion runner
uses typed input and validates the complete result before reporting success or clearing saved
selection. JSON output retains additional result fields. Optional backup paths remain omitted when
unused; explicit null backup arguments remain invalid. Missing archive support is reflected in
discovery and enforced by dispatch.

The generated browser actions expose every existing option, with character choices, clearly labelled
daemon-host paths and full results. Deletion requires the repeated name and an explicit review;
backing out makes no change. A browser journey covers missing files, relative-path refusal, export,
collision refusal, deletion with a backup, restoration and chatting with the restored character.
This is coverage of intentionally supported server paths. Browser-local file picking and controlled
downloadable artifacts still require the transfer adapter and designed archive workflow.

A 12-step comparison runs independently through TCP and WebSocket, checking correlated results and
errors, byte-for-byte preservation of an existing export, backup creation, and restored workspace,
media, messages and usage rows while preserving another character. Its comparison normalizes fixture
root paths and request IDs; export byte counts are checked against the actual file and excluded from
cross-world equality because archive timestamps and root paths affect compression. Real CLI journeys
cover normal/JSON output, backups and omission, refusal without confirmation, extra result metadata
and malformed-result rejection. A real TUI journey covers both archive commands and complete JSON
metadata. The existing TUI restriction on character deletion remains visible in its inventory.

The required dependency refresh found no project dependency changes. Bun 1.4.2, Rust/Cargo 1.98.1,
rustup 1.29.1, cargo-edit 0.13.13, cargo-sweep 0.8.0 and the installed sccache 0.17.0 remain current.
A redundant Cargo reinstall of sccache failed when its temporary compilation reached the disk quota;
the failed build directory was removed, and the existing current binary remains installed. Rust
checks continue to bypass the unavailable cache service. Fresh baselines passed 76 daemon tests and
968 CLI unit tests before the missing archive action was reproduced in the browser.

Archive validation passed all eight required daemon checks with 8,246 tests, all three Rust
workspace checks, all eleven browser journeys, and browser-generation/inventory checks. The three
affected mutation passes killed 41/41 mutants, and all 61 staleness passes are current. Independent
legacy recordings remain unchanged. Browser transfers, the remaining acceptance work, GitHub CI
execution and required merge gates are not complete.

### Browser archive transfers

The Character archives screen now accepts a file from the browser computer and downloads prepared
exports as attachments. It remains accessible before character selection. Uploads require an explicit
import review; backing out does not submit an import. Existing-character collisions remain refusals.
The screen also links to the clearly labelled daemon-path operations and confirmed character deletion.
Completed operation metadata remains inspectable, including memory rebuild information.

Authenticated same-origin HTTP adapters own private temporary directories and opaque UUID handles.
The browser filename is display metadata, never a daemon path. Handles belong to the current sign-in:
tabs using that session can recover transfer status after reload or WebSocket reconnection, while a
different sign-in cannot enumerate or use them. Imports and exports attach an unselected local peer
and send the registered command through shared session routing. No HTTP route calls archive handlers
directly. Explicit null local selection avoids loading a conversation for this global operation;
ordinary local peers retain their existing automatic selection behavior.

One archive command worker is permitted alongside the configured browser socket capacity. It has
32-message/1-MiB delivery bounds and a five-minute operation deadline. Transfers accept at most 64 MiB
compressed data each, reserve at most 256 MiB across stored uploads/exports, allow four records per
sign-in and 32 overall, expire after 15 minutes, and bound request duration to one minute. These limits
are enforced on the server, including counted streaming uploads and concurrent reservations.
The shared archive implementation receives trusted internal processing limits: 256 MiB and 20,000
entries, with regular files and directories only. Native daemon-path commands retain their existing
limits and link handling. The database snapshot limit applies to the full shared database before its
character filter, so browser export can refuse a small character in a larger database. The screen
shows this processing limit; daemon-path export remains available for larger native workflows.

Successful imports remove their temporary upload; completed downloads remove the temporary export.
Interrupted downloads release their file and can be retried until expiry. Failed operations remove
their bytes while retaining their result; sign-out, expiry and shutdown abort work and clean up files
and peers. Active imports cannot be removed through the public endpoint. A transfer handle is never
imported twice: confirmed failures remain failures, while interrupted or invalid completion reports
remain uncertain and direct the user to inspect characters/history. Reloading does not resend a
mutation. Transfer outcomes currently live in the daemon process; daemon-restart reconciliation and
crash-orphan cleanup remain part of the broader recovery work.

Adversarial extraction tests exposed an asynchronous error-path bug in the existing tar filter.
It now uses the installed tar implementation's documented abort API so policy violations reject the
archive promise instead of escaping it. Resource tests verify expanded size, entry count, links,
snapshot limits and preservation of other characters. Transfer tests cover authentication and origin,
ownership, controlled file modes/paths, bounds, interruption, expiry/sign-out/shutdown, malformed
responses, correlation and prevention of mutation replay. The browser journey downloads a real
archive, refuses a collision, deletes with confirmation, restores through the picker, reloads the
tracked outcome, views the restored image at full size, and continues the conversation. Untrusted
filenames render as text. Removing the uncertain-phase renderer fails generated-contract coverage.
The packaged-binary journey also downloads and restores a character from an empty working directory,
alongside its existing disabled-web and TCP checks.

The dependency/toolchain refresh found no further updates from the stable versions recorded above.
Fresh baselines passed before the missing archive screen was reproduced. Transfer validation passed
all eight required daemon checks with 8,278 tests, all three Rust workspace checks, all 13 browser
journeys, and browser-generation/inventory checks. The transfer and archive mutation passes killed
30/30 mutants, including loss of trusted processing limits in shared dispatch; all 62 staleness passes
are current. Independent recordings remain unchanged. An unsafe matcher type in one new test was
corrected before the final lint, typecheck and affected-suite runs. Full issue parity, restart
recovery, GitHub CI execution and required merge gates remain unfinished.

Remaining work follows the issue's sequence:

1. Continue the capability contracts through core message/regen/cancel requests,
   remaining terminal adapters and all event/result types. Add field/result renderer coverage and
   narrow platform mappings. Audit remaining special runners and local flows.
2. Audit all exposed payloads/redaction and extend controlled transfers to large exports.
   Complete reconciliation of uncertain outcomes, archive restart recovery and media recovery.
3. Extend the initial workspace with the remaining dedicated screens,
   richer message formatting, complete media/draft persistence, and all local presentation workflows.
4. Close the remaining advanced workflows: expanded diagnostics coverage, large usage exports,
   expanded memory recovery and cancellation, keyboard customization and every known event.
5. TCP/WebSocket deterministic conformance and real CLI/TUI/browser journeys: state/results/errors,
   confirmations, advanced options, empty state, failures, reconnect/restart, concurrency, media and
   cancellation. Demonstrate deliberate omission failures for operations, fields, renderers/events.
6. Audit remaining package/release integrations and expand compiled-binary journeys to the remaining
   advanced workflows. Embedded assets, deep links, empty-directory startup and default-off behavior
   now have executable/browser coverage; incompatible-tab presentation still needs DOM coverage.
7. Run all required verification plus browser, generation, security and parity gates in PR CI.
   Coordinate repository merge-policy changes separately, as requested by the issue. No merge-policy
   change has been made or assumed. Full completion requires evidence for every acceptance criterion.

### Archive restart recovery, 2026-09-20

The continuation started at `bd419249`. Toolchains and dependencies were refreshed before diagnosis:
Bun 1.4.2, Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13, cargo-sweep 0.8.0 and actionlint
1.7.12 were current; sccache was updated to 0.18.0 using the checksum-verified upstream release binary.
Both package managers found no manifest/lock changes. Baselines passed 58 daemon tests, typechecking,
and 520 shore-common tests. Actual browser/process reproductions then demonstrated loss of confirmed
import outcomes on restart and orphan uploads after SIGKILL following a committed import.

Web serving now opens a separate private recovery database while holding the daemon's existing data
directory lease. Its cache namespace includes the canonical data-directory hash; it is outside all
character data/cache/export paths. Session credentials are hashed, original session/transfer expiry
is preserved, and origin or daemon-token changes invalidate old recovery state. Logout deletes the
session and its outcomes durably. Disabled web serving does not open this store.

The store uses Bun's installed SQLite transaction API and rollback journaling with
[`synchronous = EXTRA`](https://www.sqlite.org/pragma.html#pragma_synchronous), including directory
synchronization after journal removal. The import state is saved before shared session dispatch.
Confirmed outcomes survive restart; an unfinished import becomes uncertain and cannot be retried with
the same handle. Recovery never infers success merely from a character name. Temporary uploads,
exports, database snapshots and extraction files are confined to the owned artifact directory and
cleaned at restart. Uploads/exports that lost their bytes explicitly ask the user to prepare them
again. Cache removal discards sign-ins and outcomes; legacy unowned temporary files are not swept
globally. Session and artifact limits remain enforced, with a 64 MiB recovery database page ceiling.

The new process fixture stops delivery after the actual import handler returns, proving recovery of
a committed but unconfirmed mutation. Browser journeys exercise normal shutdown, SIGKILL, automatic
reconnect, page reload, visible imported/uncertain outcomes, orphan cleanup and no replay. Focused
tests cover ownership, credential secrecy, expiry, logout, token/origin changes, separate data roots,
symlink boundaries, startup failure cleanup and failed persistence before dispatch. Archive export
checks exclude the recovery database and bearer credentials.

The full browser run also exposed stale test setup left by the earlier configuration/tool migration.
Browser fixtures now use canonical settings and model identities, current provider discovery options,
and the Bash tool for file operations. The diagnostics journey no longer selects the removed
`memory_recall` source (the canonical transcript contract only supports heartbeat). The tool journey
still verifies reviewed file changes, rejected arguments, overrides, untruncated downloads, nested
subagent calls and structured MCP fields. All 15 browser journeys passed together after these repairs.

Checkpoint verification: all eight required daemon checks passed; the full Bun suite reported
7,789 tests across 273 files, and all three independently re-derived captures were unchanged.
The Rust workspace suite reported 1,486 passing tests and 15 ignored, with formatting and Clippy
passing (existing warnings remain). All 15 Playwright journeys passed, including compiled-binary
restart recovery. Browser-generation and capability-inventory checks passed. Recovery/archive
mutation passes killed 35/35 mutants; all 63 staleness passes were current. Local logs are under
`out/issue-214/resume-2026-09-20/`; they do not establish GitHub CI or required merge gates.

### Shared command and compaction cancellation, 2026-09-20

After the restart-recovery checkpoint (`a68bbe52`), a routed-command reproduction showed that cancel
left a blocked command's signal untouched. The actual browser also had no accessible stop control
while a tool modal was open. The shared handler now registers queued commands before they start,
handles cancel on the existing control path, and aborts only commands belonging to that session.
Cancelled queued mutations cannot begin; later requests remain usable. Disconnect still suppresses
undeliverable replies. If a handler returns a confirmed result while cancellation is arriving, that
result and its actual completion are delivered, preserving paused compaction and tool reports.

The workbench, memory panel and generated actions expose Stop active work outside their disabled
forms. This is a per-tab/session control, including that session's queued commands and selected chat
turn; it is not a new targeted-cancellation protocol. The UI keeps cancellation-requested information
visible and explains that changes already made can remain. The actual MCP fixture completes a file
write after receiving cancellation; its result correctly says that stopping is unconfirmed and the
browser never automatically repeats it. This uses the installed MCP SDK's AbortSignal support and
the existing Shore MCP error handling, consistent with the
[MCP cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).

Compaction now propagates the command signal through model calls and nested tools. A deeper actual
flow found that the generic provider loop could start another call after its tool was cancelled.
The loop now checks the signal before starting a provider call. Compaction also checks after model
settlement and immediately before archival: cancellation preserves the checkpoint, partial writes
and active history. Explicit resume continues an interrupted model call without repeating completed
tools, or archives a fully completed checkpoint without issuing another model request. Preview
cancellation follows the same checkpoint safeguards.

Tests cover control-queue bypass, cancellation before queued work starts, cross-session isolation,
confirmed-result races, cancelled-provider admission, late cancellation before archival, preview
cancellation, real Bash termination, MCP late effects, and actual TCP/WebSocket equivalence for
provider and nested-tool compaction cancellation. Full issue work remains: ordinary uncertain
mutation recovery, durable attachments/drafts, live manual-tool progress, capability/local-preference
coverage, release/security audits and actual PR/required-check evidence.

Checkpoint verification: all eight required daemon checks passed, with 7,799 Bun tests across
273 files. All three Rust workspace checks passed (1,486 tests, 15 ignored; existing warnings).
The 18 browser journeys passed, including three new cancellation flows and the packaged daemon.
Browser generation and inventory checks passed, and all three independent captures were unchanged.
The cancellation pass killed 12/12 mutants; the router pass killed 31/32 with its existing reviewed
equivalent survivor. All 64 staleness passes were current. The archive-boundary mutant initially
survived; an additional complete compaction-pass regression now kills it and verifies explicit
resume without another model call. Logs use the `cancel-` prefix under the continuation log directory.

### Browser draft and attachment recovery, 2026-09-20

The original browser journeys reproduced two losses: reload dropped selected image bytes, and a
second tab overwrote the first tab's text for the same conversation. The composer now keeps text,
image bytes and a send-review marker in browser-local IndexedDB. Attachments are stored separately
so ordinary text edits do not rewrite their bytes. Saving reports completion only after the full
transaction commits, using the browser's strict durability option; quota/permission failures stay
visible with the current content open and an explicit retry. Failed saves remain in memory across
conversation switches and keep the browser's unsaved-work warning active. Mobile layouts expose the same status.
Browser data clearing, private-session expiry and browser storage eviction can still remove drafts;
this is local recovery, not a remote backup. See the browser's
[IndexedDB transaction lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction).

Each tab remembers its own per-conversation draft. An origin-scoped
[Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) detects duplicated tab
session storage and forks the inherited draft instead of taking over the original. Browsers without
Web Locks conservatively copy on recovery. Transactional revision checks also fork conflicting
writes and reject stale discard requests. Saved drafts can be inspected across conversations,
copied into an empty matching composer, and explicitly discarded with confirmation. Recovered
copies preserve the source until it is discarded. Existing text-only drafts migrate after a
successful save. Nothing is sent during restoration.

The store admits at most 64 drafts and 128 MiB of accounted text/image data. It refuses new writes
when full and retains other drafts for explicit cleanup. The later core-request checkpoint aligns picker/paste validation with shared admission:
5 MiB per file, 20 MiB decoded total and a 16-image count bound. Clipboard
images now use the same picker validation and persistence. Removing images deletes unreferenced
stored attachment bytes transactionally. Drafts remain on this device across sign-out.

Before dispatching a message, the composer attempts to persist a send-review marker. Confirmed
completion clears only the submitted text/images that were not changed while the request ran.
Interruption, cancellation or reload retains the draft and asks the user to inspect history before
sending it again. Failed browser storage is explicitly reported; it does not disable messaging.
The marker conservatively records possible delivery, not a proven server outcome. Recovery of
uncertain ordinary commands remains separate work.

Actual browser journeys cover reload and one-time send with image bytes, independent and duplicated
tabs, closed-tab and clipboard recovery, interrupted sends without replay, storage failure/retry,
stale concurrent discard refusal, and capacity refusal without eviction. The ordinary workspace
journey also covers thread-specific restoration and the explicit review after cancellation.
Browser-only source is typechecked with the DOM-enabled browser project; daemon tests retain their
existing Bun type environment. Full issue acceptance, broader media/parity and CI work remain open.

Checkpoint verification: all eight required daemon checks passed, including 7,799 Bun tests,
64 current mutation-staleness passes and three unchanged independent captures. All 26 browser
journeys passed; after the unsaved-memory safeguard and optional-MIME accounting correction, the
eight draft journeys plus the workspace and packaged-executable journeys passed again (10/10).
Final lint, typecheck, compiled build and browser/inventory generation checks passed. The change is
browser-only; the preceding cancellation checkpoint's full Rust verification remains unchanged.
Desktop and mobile screenshots were inspected, including visible saving status on mobile. Logs
use the `drafts-` prefix in `out/issue-214/resume-2026-09-20/`.


### Ordinary request outcome recovery, 2026-09-23

Dependency refresh and a tested baseline preceded reproduction. `ai` 7.0.111, `openai` 7.22.0 and
`instability` 0.3.14 were committed separately in `2d1291f1`; current stable toolchain versions are
recorded in the handover. All eight daemon checks and three Rust checks passed for that baseline.
The actual browser then reproduced a committed Bash effect whose uncertainty disappeared on reload.

Rust-canonical request-history contracts now pair retained results with the existing
`OperationResponse`. The WebSocket adapter uses the executable catalogue's effective operation policy
to track mutations, plus core message/regeneration requests, before shared dispatch. It captures the
live router selection and retains validated results before forwarding completion. The private
recovery database stores sign-in-owned records; list/acknowledge routes use the same authentication,
origin checks, redaction boundary and security headers as the existing transfer adapters. No command
handler is duplicated and no input is automatically replayed.

Completed, failed, cancelled and superseded outcomes retain their actual lifecycle meaning. Lost
connections and restarts convert running requests to uncertainty. Results are limited to 64 KiB;
invalid, duplicate, mismatched and oversized results are explicitly omitted. Inputs are not stored
separately, though a result may itself include tool inputs or output. Configuration results remain
redacted. At most 32 records per sign-in and 256 overall are retained. Admission may prune oldest
terminal records, but never running or uncertain records. If only those records fill the history,
new mutations are refused until space becomes available. Expiry never extends the sign-in lifetime;
logout and token/origin rotation remove ownership. This is bounded outcome retention, not durable
idempotency after dismissal, expiry or cache loss.

The browser polls for owner-scoped outcomes across tabs and reloads, displays a persistent uncertainty
notice, and provides a request-history dialog for results and explicit review. Failure to persist
admission prevents dispatch. Failure to persist completion closes delivery and preserves uncertainty,
including when the disconnect write also fails; an on-disk running record becomes uncertain at next
startup. Read-only config calls now have explicit effect policies instead of filling mutation slots.
The generated phase coverage test demonstrates failure when its uncertainty renderer is removed.

Actual browser/process journeys exercise repeated reload, second-tab review, confirmed result recovery
in a compiled daemon launched from an empty directory, and SIGKILL after a real Bash effect but before
its handler result was delivered. They verify one file write and no replay. Storage and WebSocket tests
cover current selection, authentication, cross-owner denial, duplicate IDs, retention bounds,
acknowledgement, expiry, rotation, redaction and write failures. Desktop/mobile review layouts were
inspected. The new mutation pass kills all 15 mutants. All eight required daemon checks passed:
7,874 tests across 279 files, 65 current mutation-staleness passes, three unchanged independent
captures and a compiled build. All three Rust workspace checks passed (1,492 tests, 15 ignored;
existing warnings remain). All 29 browser journeys passed together. Browser generation/assets and
capability inventory checks passed. Logs are under `out/issue-214/resume-2026-09-23/`. These results
do not establish actual GitHub CI or merge-policy enforcement. Full issue #214 acceptance remains open.


### Core conversation request discovery and controls, 2026-09-23

The canonical operation catalogue now has a separate `requests` collection for message,
regeneration and cancellation. Rust wire schemas define the fields and completion events. The
executable registrations describe those fields and construct the plans consumed by the shared
engine handler, preserving the cancellation control path. Source inventory and executable browser
coverage include these request schemas; deliberate omission of a request, field, action route or
required nested control fails verification.

Message options expose streaming, the reserved absence-time field and original image names. The
absence field is explicitly labeled as having no response effect in this daemon. Disabling streaming
suppresses start/chunk frames for the requester while preserving completed results and spectator
progress; real browser verification reproduced the previously ignored flag. Original paths are
omission labels when uploads are unavailable, as in the terminal clients; they do not open daemon
files. File selection and clipboard paste supply actual image bytes, names and MIME types. Both
use the server's admission constants: 16 images, 5 MiB each, 20 MiB decoded total and bounded UTF-8
metadata. The browser also validates outgoing requests with generated client-message validators.

Options are stored with each tab's draft and survive reload and recovery. Confirmed completion
clears unchanged text, uploads and one-shot options while retaining the streaming preference;
changes made during a request remain intact. The regeneration dialog includes streaming and
guidance. The action palette now reaches the composer, regeneration and active cancellation.
Actual browser verification covers these controls, sent payloads, rendered uploads and omitted
image notices, reload, focus restoration, cancellation and picker limits. Full CLI/TUI local
presentation coverage and the broader issue acceptance audit remain open.


Verification passed all eight required daemon commands (7,880 tests in 280 files, 66 mutation
passes free of stale patterns, three unchanged capture groups and the compiled build), all three
Rust workspace commands (1,492 tests; 15 existing ignored tests), all 31 Playwright journeys and
browser generation/assets/inventory checks. All 48 targeted core-request/router mutants were
killed. Clippy reports existing warnings. The working logs use the `core-` prefix in
`out/issue-214/resume-2026-09-23/`. No actual PR CI run or merge-policy change is claimed.
