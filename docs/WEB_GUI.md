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

Remaining work follows the issue's sequence:

1. Continue the contract migration through the 43 legacy names, core message/regen/cancel requests,
   remaining terminal adapters and all event/result types. Add field/result renderer coverage and
   narrow platform mappings. Audit remaining special runners and local flows.
2. Audit all exposed payloads/redaction and add authenticated controlled upload/download adapters.
   Implement the visible reconciliation workflow for uncertain outcomes and media recovery.
3. Browser presentation state and designed screens: history/delta merging, drafts/preferences, navigation/composer,
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
