# Architecture

Shore is a daemon-centered AI character engine. The daemon owns state; clients
observe and send commands over SWP.

This file is the compact system manual: runtime shape, load-bearing invariants,
security boundaries, observability, and validation expectations.

## Workspace Crates

| Path | Crate | Role |
| --- | --- | --- |
| `core/protocol` | `shore-protocol` | SWP wire types |
| `core/config` | `shore-config` | config loading, model catalog, character paths |
| `core/swp-client` | `shore-swp-client` | client connection/discovery helpers |
| `backend/swp-server` | `shore-swp-server` | TCP server, registry, session routing |
| `backend/daemon` | `shore-daemon` | engine, memory, autonomy, tools, generation |
| `backend/llm` | `shore-llm` | provider request/stream handling |
| `backend/mcp` | `shore-mcp-client` | MCP client (connect external MCP servers, list/call tools) |
| `backend/ledger` | `shore-ledger` | usage, pricing, Anthropic cache tracking |
| `backend/call-store` | `shore-call-store` | compressed SQLite store for call payloads + transcripts |
| `backend/diagnostics` | `shore-diagnostics` | shared diagnostic formatting |
| `clients/cli` | `shore-cli` | CLI client |
| `dev/test-harness` | `shore-test-harness` | integration harness and mock server |

Out-of-tree clients live in separate repositories and consume the core
library crates (`shore-protocol`, `shore-config`, `shore-swp-client`,
`shore-diagnostics`) from crates.io:

| Crate | Repo |
| --- | --- |
| `shore-tui` (terminal UI) | [mythofmeat/shore-tui](https://github.com/mythofmeat/shore-tui) |
| `shore-gui` (Tauri desktop) | [mythofmeat/shore-gui](https://github.com/mythofmeat/shore-gui) |
| `shore-gui-godot` (Godot client) | [mythofmeat/shore-gui-godot](https://github.com/mythofmeat/shore-gui-godot) |
| `shore-matrix` (Matrix bridge) | [mythofmeat/shore-matrix](https://github.com/mythofmeat/shore-matrix) |
| `shore-mcp` (debug/development MCP bridge — distinct from the in-tree `shore-mcp-client`) | [mythofmeat/shore-mcp](https://github.com/mythofmeat/shore-mcp) |

## State Model

Authoritative state lives in the daemon:

- active character
- conversation log and message alternatives
- generation lifecycle
- memory and compaction state
- heartbeat/autonomy scheduling
- ledger/cost/cache state
- tool execution

Clients attach, receive snapshots/events, and send SWP messages. CLI, TUI, GUI,
Matrix, and MCP must not become alternate sources of character truth.
`hello` character metadata carries optional base64 avatar data, and
`new_message` events carry the authoritative character name and message origin.
Passive clients such as desktop notifiers can therefore label and icon messages
without reading the daemon's local config filesystem.

Handshake and push `History` snapshots contain the active `active.jsonl` tail
only, keeping passive clients and bridges fast. Bounded log/history command
responses may include compacted `segments/` before that active tail; the SWP
`active_start` index marks the first message that remains in prompt context so
clients can draw an archive boundary without treating old scrollback as active
model context.

## File Layout

Config:

```text
$XDG_CONFIG_HOME/shore/
  config.toml
  .env
  characters/<Character>/avatar.png
  characters/<Character>/workspace/
    SOUL.md
    USER.md
    AGENTS.md
    TOOLS.md
    MEMORY.md     # active memory: dated, pruned, prompt-visible
    memory/       # markdown long-term memory
```

Data:

```text
$XDG_DATA_HOME/shore/<Character>/
  active.jsonl
  active_prompt/
    SOUL.md
    USER.md
    AGENTS.md
    TOOLS.md
    MEMORY.md
  compaction.json
  deferred_edits.jsonl
  segments/
  dreams/
  images/
    attachments/
    generated/
```

Global data:

```text
$XDG_DATA_HOME/shore/ledger.db
```

Cache:

```text
$XDG_CACHE_HOME/shore/cache_forensics.jsonl
$XDG_CACHE_HOME/shore/providers/<Provider>/models.json
$XDG_CACHE_HOME/shore/characters/<Character>/workspace_index.json
$XDG_CACHE_HOME/shore/resized/
$XDG_CACHE_HOME/shore/calls.db
```

The observability store (`calls.db`, a compressed SQLite database owned by the
`shore-call-store` crate) records every LLM call's request/response — chat, tool
loops, heartbeat, dreaming, compaction — as zstd-compressed blobs, plus curated
heartbeat/dreaming transcripts. It is always on and replaces the old
operator-pruned `debug/api_logs*` JSON dumps. Payloads compress well (the
repeated prompt context across calls collapses), so the footprint is a fraction
of the raw bytes. The daemon self-rotates it on an hourly task: a 14-day window
plus a 512 MiB disk backstop (oldest-first eviction, pages reclaimed via
`incremental_vacuum`). `api_key` is redacted. It is observability only — never
authoritative conversation state.

## Runtime Flow

Generation:

1. Receive an SWP client message.
2. Append the user message to `active.jsonl`.
3. Assemble the prompt from `active_prompt/` and active conversation messages.
4. Stream the LLM response.
5. Run tool loops if the provider returns tool calls.
6. Persist assistant/tool messages.
7. Emit final stream metadata after persistence.
8. Trigger compaction if thresholds require it.

The final `StreamEnd` is emitted only after persistence, so immediate follow-up
commands see durable state. During tool use, clients may see intermediate
`StreamEnd(tool_use)` events; they should buffer one assistant turn across tool
phases.

Persisted assistant messages carry provenance stamps: `provider_key` (the
provider entry that minted the content, used by the thinking-replay
portability filter) and `model` (the model id, audit metadata for history
tooling). Tool-loop intermediates, heartbeat-minted autonomous messages, and
regeneration alternatives are stamped the same way; each alternative carries
its own stamps because regenerated bodies can come from a different
provider/model than their siblings. Messages persisted before provenance
tracking simply lack the fields. History tooling surfaces the stamps:
`search_chat_logs` reports each result's minting model and can filter by it,
and the `model_history` tool summarizes per-model usage over time from the
usage ledger (which predates per-message stamping).

Regeneration uses the same prompt assembly path, but the prompt view stops at
the last real user turn so the model does not see the response being
regenerated. The daemon does not rewrite `active.jsonl` until the replacement
response has completed; then it atomically replaces the assistant/tool tail and
stores the old and new visible assistant bodies as selectable alternate
responses on the active assistant message. Selecting a prior alternate rewrites
the active tail to that response and advances the history rewrite generation, so
stateful providers do not keep remembering the discarded active response.

## Config Runtime

The daemon loads config at startup and keeps a runtime copy in the message
handler, command context, autonomy manager, and character registry.

Manual `config_reset`, manual `config_reload`, and automatic hot reload use the
same application path: parse config, replace runtime config, invalidate merged
per-character config caches, rescan character discovery, update autonomy
runtime config, and push fresh snapshots to connected sessions. `config_reload`
(CLI: `shore config reload`) differs from `config_reset` in that it preserves
runtime overrides, aborts with the parse error when the on-disk config is
invalid, and can additionally activate staged prompt edits (below) after the
client confirms with the user.

The watcher covers config TOML inputs, `.env`, `conf.d/`, and per-character
`config.toml` overlays. It deliberately ignores
`characters/<Character>/workspace/**` so prompt and memory edits keep their
explicit compaction/reload boundary.

Startup-owned settings such as daemon listener, Matrix supervision,
notifications, and startup diagnostics require restart.

## Prompt And Cache

Prompt assembly reads prompt-visible files from `active_prompt/`, not directly
from editable workspace files.

Normal chat uses:

- active `SOUL.md`
- active `USER.md`
- active `AGENTS.md`
- active `TOOLS.md`
- active `MEMORY.md`
- current conversation messages
- stable capability/tool guidance

Heartbeat additionally uses heartbeat runtime affordances.

Prompt-visible workspace files are:

- `SOUL.md`
- `USER.md`
- `AGENTS.md`
- `TOOLS.md`
- `MEMORY.md`

When a model writes or edits one of these files through workspace tools, the
workspace file changes immediately, but the path is queued in
`deferred_edits.jsonl`. Normal prompt assembly keeps using the old snapshot until
compaction/reload refreshes `active_prompt/` and clears the queue. A daemon
restart does not refresh the snapshot: the provider cache is server-side and
survives restarts, so prompt bytes stay byte-identical until an explicit
boundary. Boundaries are compaction (manual, inline, or autonomy-driven) and a
confirmed `shore config reload`, which reports the differing files and asks
before activating them (the next call pays a one-time cache write).

Unexpected Anthropic cache invalidation is a serious regression. Things that
should not bust cache include ordinary workspace edits, ordinary markdown memory
writes, tool loop bookkeeping, activity tracking, image cache warmups, and
compaction of the recent conversation tail when the pinned system prompt prefix
is unchanged. Expected cache breakpoints include activating staged prompt edits
at compaction/reload, editing old conversation messages, changing
model/provider/cache settings, and changing prompt templates or tool
definitions in code.

Cache invalidation accounting is split into two layers:

| Layer | Expected invalidation paths | Must stay cache-stable |
| --- | --- | --- |
| Provider-side Anthropic prompt cache | Cache TTL expiry without a successful keepalive, model/provider/cache setting changes, thinking-mode shape changes, prompt template or tool definition changes, activation of staged prompt-visible edits, edits to already-cached conversation history, and explicit cache breakpoint/debug overrides. | Ordinary workspace writes, markdown memory writes before active-prompt activation, tool-loop bookkeeping, activity stats, image cache warmups, and compaction of only the recent conversation tail when the pinned system prefix is unchanged. |
| Shore cached `last_request` reuse | Successful chat requests replace it; successful compaction clears it because the conversation tail changed. Heartbeat and keepalive may rebuild it from disk. | Clearing `last_request` must not clear the cache keepalive deadline by itself; the pinned provider-side system prefix may still be worth refreshing. |

Local regression tests should cover request-shape invariants before live
provider checks are run. In particular, Anthropic cache-control placement tests
must account for generated chat histories, tool-loop tails, system anchors, the
four-breakpoint provider limit, and the rule that the active final user message
is never itself a message breakpoint. Live cache economics are validated by the
gated `#[ignore]` Rust probes in `dev/test-harness/tests/`
(`live_cache_regression.rs`, `live_compaction_cache.rs`), which drive a real
provider through a multi-turn tool loop; the long-running idle keepalive soak
lives at `scripts/cache-tests/keepalive-24h.sh`. For driving a whole feature
end-to-end against real providers and MCP servers — isolated from the live
daemon — use the runnable harness at `scripts/e2e/` (`daemon.sh`); deterministic,
in-CI coverage of the same paths (including MCP tools and sub-agents under a mock
LLM) lives in `dev/test-harness` and `backend/daemon/tests/suite/`.

An observed cache-read decrease while the ledger believes the cache is warm is
not an expected invalidation path. It is recorded as `UnexpectedWrite` and must
be treated as a regression signal unless explained by a known deliberate
breakpoint above. A read decrease whose accompanying write is under 1% of the
read is not flagged: that shape is a shorter request (edit/regen) hitting a
still-warm prefix and recaching its tail, and the baseline follows the shorter
prefix. The warm/cold state machine encodes Anthropic-specific
invariants (the provider-side prompt-cache TTL, keepalive cadence, and monotonic
prefix growth), so anomalies are evaluated **only for Anthropic-family calls**
(native or `anthropic/...`-routed). Other providers report cache metrics with
different semantics and are not tracked — with two exceptions that feed an
already-existing tracker without creating one: a compaction on any provider
resets the state machine (it rewrites the conversation the Anthropic prefix is
built from, so the post-compaction baseline must not be the stale one), and
foreground `message`/`tool_loop` calls update the activity anchor below. Only
`message` calls feed the message
cache-read baseline; keepalive pings, heartbeats, subagents, and memory queries
each run on a different prefix and are never compared against it. A
`KeepaliveMiss` (cache went cold without a keepalive bridging the gap) is
suppressed when the idle gap exceeds the keepalive ceiling
(`[behavior.autonomy].cache_keepalive_max`): past that point the
keepalive subsystem deliberately stops pinging, so the cold start is expected.
The daemon pushes the configured ceiling into the ledger's trackers at startup
and on config reload (mirroring the usage-budget push), so the classifier and
the keepalive subsystem always judge against the same value.
The gap is measured from the last foreground activity (`message`/`tool_loop`) —
the same anchor the keepalive's own ceiling uses — never from pings or
background calls, which would shrink the apparent gap and misflag the
by-design overnight stop as a miss.
A `ColdKeepalive` (a keepalive ping with `cache_read == 0` and
`cache_write > 0`) flags the keepalive *itself* paying a cache creation instead
of refreshing a warm prefix — the keepalive's most expensive failure mode. It is
judged per-observation (not from the warm/cold state machine, which interleaved
multi-model traffic on the per-character timeline can thrash), so it stays
reliable regardless of surrounding call types. Note the state machine is keyed by
character, not by `(character, model)`; background ticks pinned to a different
model share the timeline, which is why state-machine-derived anomalies are
advisory and the per-observation `ColdKeepalive` check is the dependable signal.
Tool-loop calls keep a separate short-lived cache-read baseline because their
request prefix advances through newly completed `tool_result` blocks; within a
loop that baseline must not drop, and the first tool-loop continuation after a
warm message must not rewrite the prefix with zero cache read. Request-shape tests should keep tools, system blocks, and
already-existing messages byte-preserved for every generation variant; only
configured tool-surface changes or explicit/manual history edits may change
that prefix.

## Memory

Runtime long-term memory is markdown under:

```text
characters/<Character>/workspace/memory/**/*.md
```

Curated markdown files are authoritative. SQLite/vector/RAG memory is not part
of normal runtime memory. Optional semantic indexes are rebuildable ranking aids.

`MEMORY.md` lives at the workspace root and is prompt-visible through
`active_prompt/MEMORY.md`. It is the character's **active memory**: a dated,
continuously pruned scratchpad carrying what is live right now — current state,
conversational throughlines, and thin pointers to where deeper material lives.
Its purpose is instant conversation-to-conversation continuity, so it is scoped
to the temporary and the current, not used as storage. Long-term memory is the
job of every other file and folder in the workspace. It is not the character
definition, user profile, standing behavior, or tool guide.

Entries in `MEMORY.md` are dated. Compaction and dreaming re-date an entry when
they update or re-confirm it, and reap low-priority entries older than ~2 weeks —
relocating anything still valuable into a `memory/` file. Heartbeat carry-forward
notes land here too: a single active-memory surface, visible in every kind of
turn, replaced the separate heartbeat-only file that models used
interchangeably with it.

Compaction turns older conversation material into durable markdown memory,
archives compacted messages into `segments/`, retains configured recent turns,
updates `MEMORY.md` with carry-forward throughlines, and activates deferred
prompt edits. Dreaming may later reorganize the memory files and `MEMORY.md`.
Archived segments stay available to client history/log views through bounded,
lazy pages, but prompt assembly and normal history snapshots use only the
retained active tail.

Compaction is single-flight per character. Manual `shore memory compact`,
idle-triggered compaction, and the deep-idle archive share the same guard, so
a second pass returns `busy` instead of racing against the same active
transcript and memory files.

An optional deep-idle archive (`[memory.compaction] archive_after`) draws a
clean-slate boundary after extended inactivity: the remaining active tail is
archived to `segments/` so the next exchange starts fresh. Because the
compaction LLM always sees the full conversation (the keep-N split only
controls retention), a tail left by a prior compaction is already covered by
memory and is archived as a pure file move with no LLM pass — the one
sanctioned bypass of the "zero memory writes → no archive" guard, which exists
to protect *uncovered* content. Uncovered turns get a real keep-0 compaction
pass first. A trailing run of unanswered autonomous messages (persisted with
`origin: "autonomous"`) is always retained so the user still sees it on
return, and a leftover autonomous tail alone never re-triggers the archive.
A deep-idle archive empties `active.jsonl`, but the heartbeat does not go
dormant as a result: whenever the active conversation has no usable user turn,
the heartbeat request is rebuilt against a synthetic anchor turn so ticks keep
firing and reflecting on memory until the user returns. This does not require a
compaction segment to exist — the character's system prompt and
memory are reason enough to act, and the same rebuild gives the keepalive ping a
stable system+tools prefix to keep warm even with an empty `active.jsonl` (so the
cache stays hot overnight rather than going cold the moment the conversation is
archived). The only state that still skips is a conversation genuinely mid-turn
(a dangling tool-result tail), where anchoring would build an invalid request.

Dreaming is an opt-in scheduled AI librarian pass. When autonomy and
`[memory.dreaming]` are enabled, the character uses memory/workspace tools in
a background pass to inspect, dedupe, consolidate, and mark stale or
superseded memory.
The schedule is a five-field cron expression. The due-check gates the entire
pass, including the optional pre-dream compaction — an idle tick where no
dream is due does no pre-sweep work. Dreaming may edit prompt-visible
files; those edits follow the same deferred activation rule.

The workspace carries its own git history. Before a live compaction or
dreaming pass, the daemon ensures the workspace is a git repository
(initializing one with a local identity when `.git` is missing; pre-existing
repositories, including their identity config, are left alone). Both passes
are prompted to commit their changes in small, explained chunks through the
`git` tool — the commit messages carry the reasoning and sources for each
memory change. Those commits are attributed
to the character (`<character> <slug@shore.local>`), injected per-commit rather
than written to the repo's config, so an operator committing in the same
workspace keeps their own git identity and stays distinguishable in the log.
The daemon never configures a remote, and the model cannot push (`push` is
refused by the git tool): history is local unless the operator adds a remote. If a compaction archive fails after
the model already committed, the daemon records the rolled-back file restores as
a `revert:` commit so history matches the tree. Git bootstrap and commits are
best-effort: a host without git still compacts and dreams normally, just
without history.

Pushing is daemon policy, not the model's: with `[memory] git_push` enabled,
the daemon runs a plain `git push` (honoring the repo's own remote/upstream)
after a successful pass. It is off by default, skips silently when no remote is
configured, and a failed push is logged but never fails the pass — the commit
is already durable locally (and offsite if the operator backs up the workspace).

The dreams audit log lives at:

```text
$XDG_DATA_HOME/shore/<Character>/DREAMS.md
```

It is daemon-written and is not memory. Machine-readable dreaming state,
staged outputs, and legacy diagnostic reports live under
`$XDG_DATA_HOME/shore/<Character>/dreams/`. Legacy workspace artifacts under
`.dreams/**`, `dreams.md`, `MEMORY.md`, and `memory/dreaming/**` are excluded
from ordinary memory-source ingestion.

Search is lexical or hybrid semantic+lexical. The workspace-wide hybrid index is
stored at `$XDG_CACHE_HOME/shore/characters/<Character>/workspace_index.json`;
markdown files remain authoritative and the index can be deleted and rebuilt.
Search/index walks the whole workspace tree (including `memory/`, excluding
`.git`) with configurable file-size, file count, and total-byte limits.

## Tools And Security

Workspace tools operate inside `characters/<Character>/workspace/`.

Rules:

- Paths must stay inside the character workspace.
- Symlink and traversal escapes are bugs.
- Workspace file tools treat `memory/...` as a normal workspace subdirectory.
- Prompt-visible files cannot be deleted; their edits apply to the workspace
  file immediately but only become prompt-active at the next compaction/reload
  boundary.

### Sub-agent delegation

`[subagents.<name>]` entries surface as `ask_<name>(query)` tools on the primary
character. Dispatch routes any `ask_*` call to `ToolContext::run_subagent`, which
the chat tool context implements by resolving a (cheap) model, building a request
with the agent's prompt + its configured tool subset, and running the shared
`run_tool_loop` against a discard output sink — only the agent's final text
returns as the tool result. Sub-agent spend is recorded under `CallType::Subagent`
(continuation rounds reuse `CallType::ToolLoop`, mirroring the heartbeat path).

Load-bearing invariants:

- **Nesting is capped at one level.** A sub-agent's nested loop runs against a
  guard context whose `run_subagent` is the trait default (`NotImplemented`), and
  the offered tool subset never contains `ask_*` (those are not in the static
  registry). A hallucinated `ask_*` call therefore errors instead of recursing.
- **Background ticks run sub-agents without a client channel.** The chat
  generation path wires a `SubagentRuntime` with the live client channel; the
  heartbeat and dreaming paths wire one via `SubagentRuntime::background`, whose
  `direct_tx` is `None` so the nested loop's frames are drained (not streamed to
  a UI) while the agent still runs and returns its summary. Only compaction
  leaves the runtime `None`, so `ask_*` there returns `NotImplemented`. All
  background wiring is gated on configured sub-agents to skip the config clone
  when none exist.
- **Tool ordering is stable.** `ask_*` defs are appended after the static tool
  surface in config (`BTreeMap`) order, keeping the cache prefix byte-stable.

### MCP client

`[mcp.<name>]` entries declare external MCP servers the daemon connects to as a
client (`backend/mcp` = `shore-mcp-client`, over `rmcp`). At startup the
`McpRegistry` connects every server, calls `tools/list`, and flattens the
discovered tools into one list namespaced `mcp__<server>__<tool>`. Dispatch
routes any `mcp__*` call to `ToolContext::mcp_call`, which the chat tool context
forwards to the registry; the registry resolves the server/tool from the pinned
list and issues the `tools/call`. Servers themselves are never daemon code.

Load-bearing invariants:

- **The tool surface is discovered once and pinned.** Tools are listed at connect
  time, sorted by full name, and held for the registry's lifetime; MCP defs are
  appended *after* the static + `ask_*` surface. This keeps the Anthropic cache
  prefix byte-stable across turns — a live `tools/list` per turn would reshuffle
  it. A reconnect (hot-reload) re-lists and may shift the prefix once.
- **Grants are fail-closed globs.** `enabled_tools` / sub-agent `tools` entries
  match MCP names exactly or by trailing-`*` glob (`tool_pattern_matches`). A tool
  a server adds later is not granted until a pattern covers it.
- **Sub-agents can use MCP; the nesting cap still holds.** The sub-agent guard
  context forwards `mcp_call` to its parent (so a sub-agent's loop can call MCP
  tools) but still leaves `run_subagent` at the `NotImplemented` default, so the
  one-level recursion cap is unaffected. A sub-agent's `mcp__server__*` grant is
  expanded against the live registry when its tool subset is built.
- **Hot-reload swaps the registry atomically.** On config reload the handler
  rebuilds the registry only when the `[mcp.*]` section changed (compared against
  the source config the registry was built from), then swaps the `Arc`. In-flight
  generations keep their snapshot; the old registry is gracefully shut down if
  uniquely owned, else cleaned up on `Drop` (rmcp kills stdio children on drop).
- **Trust boundary.** An MCP server is arbitrary external code, and since the
  removal of `exec` it is the only way arbitrary programs reach the host.
  Exposure is opt-in via the allowlists, and stdio servers are
  spawned with a cleared environment (only `PATH`, `HOME`, and the configured
  `env` pass through) so the daemon's provider keys are not leaked to them.
- **Scope.** MCP applies to the chat path and the heartbeat (the character
  acting autonomously): both wire the registry into their `SharedToolContext`
  for execution, and the heartbeat keepalive rebuild (`rebuild_request_from_disk`)
  includes the *same* filtered MCP defs chat does — so the warmed prefix matches
  the chat prefix and the keepalive stays a net positive. The autonomy manager
  holds the registry and snapshots it into each per-character `TickContext`
  (refreshed on reload for future ticks; running ticks keep their snapshot, like
  `loaded_config`). The **dreaming/librarian** sweep is intentionally excluded:
  it uses a fixed, character-tool-independent toolset (`build_librarian_tool_defs`),
  so MCP tools never enter memory maintenance.

`git` is the only tool that spawns a process, and the program it spawns is
always `git`. There is no general command execution: the daemon runs a
character, not a terminal.

- the tool takes a `subcommand` and an `args` array, never a command line
- no shell is invoked, and nothing is parsed out of a string — pipes,
  redirects, substitution, and `;` chaining are inert data
- the subcommand slot is guarded: a token starting with `-` is refused, so
  git's global flags (`-c`, `--exec-path`, `--git-dir`, `--work-tree`,
  `--config-env`) can never precede the subcommand. This retires the argv walk
  the exec-era validator needed to find those flags — the structure now
  excludes them
- destructive and history-rewriting subcommands are refused: `reset
  --hard/--merge/--keep`, `clean -f`, `rebase`, `filter-*`, `restore`, forced
  `checkout`/`switch`, branch/tag/ref deletion, `gc`, `reflog expire`, `stash
  drop/clear/pop`. `checkout` of a *pathspec* (`checkout HEAD -- <path>`) is
  refused with them: it discards uncommitted work exactly as `restore` does,
  being the older spelling of it. Branch operations still work
- repo-controlled execution surfaces are neutralized on every spawn
  (`core.hooksPath=/dev/null`, `core.attributesFile=/dev/null`, prepended
  before the subcommand): an operator may import a repository carrying hooks
  or filter drivers, and the model committing its memory must not run them.
  The daemon's own calls (`run_git`) and the model's (`handle_git`) share one
  constant so they cannot drift
- `push` is refused (network egress is daemon policy, not the model's — see
  above), as are `config` and remote modification (`remote add`/`set-url`)
- path-like arguments must stay inside the character workspace
- the command runs in the workspace or a validated subdirectory
- dry-run memory passes block `git` entirely; live passes allow it so they can
  commit their own memory changes
- the `edit` and `delete` tools reject paths under `.git/`

The allowlist and git denylist are a fat-finger guard, not containment — they
cannot fully enclose a programmable surface like `git`. Underneath them sits a
**capability sandbox** (`sandbox.rs`, Linux only). Every program a tool spawns —
`git` is the only one today — is re-executed through the daemon binary's hidden
`__sandbox-exec` mode, which — single-threaded, before `execve` — applies:

- **`no_new_privs`**, so privileges cannot be regained across `execve`;
- **Landlock**: readable everywhere, writable only under the character
  workspace and the standard build-tool caches (`~/.cargo`, `~/.rustup`,
  `~/.npm`, `~/.cache`, temp dirs). An escape cannot write to `~/.ssh`, the
  daemon's `~/.config/shore` (other characters' memory, the keys `.env`), or
  the rest of the system;
- **seccomp**: blocks IPv4/IPv6 socket creation (no network egress; AF_UNIX
  and local lookups still work), namespace tricks (`unshare`/`setns`/`mount`/
  namespace `clone` flags), and `ptrace`. `clone3` returns `ENOSYS` so glibc
  falls back to the screened `clone`.

`[tools.sandbox].mode` selects `auto` (default — enforce when the kernel
supports Landlock, else log a warning and fall back to denylist-only), `on`
(require it; the tool call fails when it cannot be enforced), or `off`.
`[tools.sandbox].allow_network` (default `false`) lifts the seccomp network cut.
The key is named for the mechanism, not for `git`, so a future tool that spawns
a process is confined by the same settings. The design goal is invisibility:
local-repo git workloads and cached `cargo`/`npm` builds are unaffected; only
dangerous or malicious actions are blocked.

The sandbox and the denylist are complementary, not redundant:

| Mechanism | Protects | Against |
|---|---|---|
| Destructive git denylist | Memory **integrity** | The model foot-gunning its own history (`reset --hard`, `rebase`, …) |
| Capability sandbox | The **system** + network | A git escape (hooks, filters) reaching outside the workspace |

The sandbox confines the workspace *from the rest of the system*; it does not
protect the workspace from itself (the workspace **is** the memory — a
sandboxed `git reset --hard` still rewrites history), which is why the denylist
remains the memory-integrity layer above it. Non-Linux platforms keep
denylist-only behavior.

Remote daemon access is explicit. Non-loopback binding requires:

```toml
[daemon]
unsafe_allow_remote_access = true
allowed_hosts = ["100.64.0.2"]
```

`allowed_hosts` is a source-IP allowlist only. It is not authentication or TLS.
Use a private overlay network such as Tailscale or WireGuard.
Remote clients do not discover daemons through the local instances registry;
they should use `SHORE_ADDR`, `--addr`, or
`$XDG_CONFIG_HOME/shore/client.toml`.

Provider keys come from environment variables or `.env` in the config directory.
Do not commit real keys, captured Authorization headers, or private profile
data.

## Autonomy

Autonomy is implemented as heartbeat state plus an async manager. It is disabled
by default.

Heartbeat ticks:

1. Rebuild the latest prompt from disk.
2. Inject heartbeat runtime affordances.
3. Run a bounded tool loop.
4. Extract an optional user-facing message — from a `<sendMessage>` tag or an
   intercepted `sendMessage` tool call (last-wins).
5. Schedule the next wake or fall back to the configured interval.

The heartbeat-only capabilities `set_next_wake` and `sendMessage` are **not
declared tools**. The tools array is the head of the Anthropic cache prefix, so
declaring a heartbeat-only tool — or otherwise letting the chat and heartbeat
tool arrays diverge — would invalidate the whole cache (tools → system →
messages). Instead the heartbeat prompt instructs the model to call them, and
the tool loop intercepts the (undeclared) calls by name: `set_next_wake` updates
the wake schedule, `sendMessage` routes to the user-message sink. A model
emitting a `tool_use` for an undeclared name round-trips through the API fine;
the harness handles it. Sub-agents (`ask_*`), by contrast, **are** declared (so
they're identical in both arrays) and are made to work in background ticks by
wiring a runtime — see the sub-agents section.

Heartbeat does not force recap files or daily memory notes. Durable notes happen
only when the character uses write-capable tools. Dormancy stops autonomous LLM
calls until user engagement resumes.

Cache keepalive is a **standalone** subsystem, fully decoupled from heartbeat: it
does not observe the heartbeat's next-wake schedule or its dormancy guard. It is
governed by exactly two knobs — a per-model ping cadence (`cache_keepalive`,
`"off"` or a literal interval; Anthropic defaults to `55m`, every other sdk to
`off`) and a global idle ceiling (`[behavior.autonomy].cache_keepalive_max`,
default 12h). It pings the prompt cache every cadence-interval while the
character is idle, and stops once `cache_keepalive_max` elapses since the last
**real** activity — measured from the last real message, never reset by a ping.
Real activity reschedules the timer and restarts the idle clock, but only a call
that ran on the **same model the keepalive pings** counts: a background tick
(heartbeat/dreaming) pinned to a cheaper model does not warm the foreground
model's cache, so it must not advance the ping or reset the idle clock —
otherwise the cache silently expires between pings and every ping pays a full
cache recreation. A model switch retargets the keepalive and always pauses
pinging until a real call warms the new model's prefix — an armed timer carried
across the switch would fire a ping at a cold cache. Compaction clears any
cached request body that contains
the old conversation tail, but does not cancel the keepalive deadline; a later
keepalive can rebuild from disk to keep stable pinned system prompt sections
warm. `cache_keepalive` is a literal cadence and is unrelated to the
Anthropic-only `cache_ttl` wire setting that enables 1h caching.

The subsystem's governing invariant is **never ping a cache it cannot prove
warm** — a ping that lands cold pays a full cache creation for a user who may
be gone for hours, turning the cost-saver into a cost-center. Two mechanisms
enforce it beyond the ceiling. Failed or skipped pings (budget block, provider
outage, missing request) retry on a short exponential backoff only while the
last confirmed warm is younger than the ping interval plus a small grace;
past that the prefix is beyond any plausible TTL and the keepalive disarms
until the next real warm, rather than letting retries outlive a budget block
and pay a full cold write the moment the budget resets. And because the
provider-side cache outlives the daemon process, the armed schedule (target
model, cadence, last-warm and last-activity anchors) is persisted in
`autonomy_state.json` and re-armed on startup — but only when the persisted
warm is younger than one ping interval, so a restart can never revive a ping
against a prefix that may have gone cold while the daemon was down.

## Provider Boundary

`shore-llm` owns provider-specific request construction, streaming, response
parsing, retry behavior, content block handling, thinking/reasoning block
translation, and cache breakpoint placement.

Provider wire behavior should be verified with recorded or live provider
responses before release when request formatting, streaming, tool use, thinking,
or cache economics are in scope. Live checks may cost money.

## Clients And Bridges

`shore-matrix` bridges Matrix rooms to SWP messages. Embedded mode manages a
conduwuit-compatible homeserver; external mode connects to an existing Matrix
server. Matrix is a client bridge, not a trusted state store.

`shore-mcp` is for development and agent-driven verification. It speaks to the
daemon through the same SWP path as other clients. Its default profile is
isolated; main-profile writes require explicit writable attachment.

## Observability

Useful commands:

```sh
RUST_LOG=shore_daemon=debug,shore_llm=debug,shore_swp_server=debug shore-daemon
SHORE_MATRIX_RUST_LOG=shore_matrix=debug shore-daemon
RUST_LOG=shore_cli=debug shore status
shore status
shore status --diagnostics
shore usage
shore usage --budget
shore usage --by-kind
shore usage --by-api-key
shore usage --anomalies
shore log --heartbeat
shore log --dreaming
shore log --events
shore log --api
shore log --api <id>
shore memory dreams
```

The usage ledger records provider/model, raw `call_type`, finish reason,
configured API key name, token counts, cache TTL, cache state/anomalies, and
cost components plus cost provenance. When OpenRouter includes `usage.cost`,
Shore stores that provider-reported billed total and marks the row
`provider_reported`; catalog pricing is still used as a fallback estimate when
the provider does not report a total. `shore usage --by-kind` rolls raw rows
into user-facing categories such as `message_no_tools`, `message_with_tools`,
`heartbeat`, `compaction`, and `dreaming`; `shore usage --by-api-key` groups
spend by the friendly configured key name, with historical rows shown as
`unknown`.

Subscription providers are a deliberate exception to per-token cost accounting.
A flat-rate provider (currently `opencode-go`, OpenCode's subscription gateway)
has no meaningful marginal cost per call, so its rows are recorded with
`total_cost = 0` and `cost_source = "subscription"` — token counts, timing, and
transcripts are still captured for observability, but the call contributes
nothing to any usage budget or spend total. The same invariant runs in the
other direction at enforcement time: a subscription call is never blocked by a
usage budget, since throttling a zero-cost call would be meaningless. The
predicate lives in one place (`shore_ledger::is_subscription_provider`) so the
recording and enforcement paths can never disagree.

The observability store (`calls.db`, see File Layout) captures the full
request/response of every LLM call plus curated heartbeat/dreaming transcripts.
`shore log --api` lists recent calls (filter with `--call-type`); `shore log
--api <id>` dumps one call's decompressed request/response. `shore log
--heartbeat` and `shore log --dreaming` render the curated transcripts — what
each background tick/pass thought, the tools it ran with their results, and the
model/provider that actually served it (the blind spot the raw ledger row can't
show). `shore log --events` keeps the heartbeat operational event ring (tick
fired / dormant / woke / timeout). `--json` on any of these returns the raw
rows. Unlike the ledger (durable cost state in the data dir), the store is
disposable observability in the cache dir and self-rotates.

Usage budgets are configured under `[usage]` and evaluated directly against the
ledger before each LLM call. Budget windows use the configured calendar
timezone (`local` by default), can scope by provider/model/API key/character or
usage kind, and can warn, block, or pause background work. Compaction is allowed
over blocking budgets by default so context reduction can still lower future
spend; operators can disable that globally or per budget. `shore usage
--budget` reports current budget state and optional spike warnings, and
`--json` exposes the same data for clients. When a completed call crosses a
budget warning threshold, the daemon records that budget/window/threshold and
emits a request-scoped `usage_warning` frame plus the matching notification
event, so CLI/TUI clients can surface it without polling `shore usage`.

Long-running daemon service logs default to a scoped filter:
`warn,shore_daemon=info,shore_llm=info,shore_ledger=info,shore_swp_server=info`.
The daemon-supervised Matrix bridge gets its own `RUST_LOG` from
`SHORE_MATRIX_RUST_LOG`, defaulting to
`warn,shore_matrix=info,matrix_sdk_crypto::backups=error`, so routine Matrix
SDK sync and key-backup chatter does not dominate the daemon's systemd journal.
Service logs use a single-line human format with the event sentence first,
followed by structured event fields and span context:
`LEVEL target: message | fields: key=value ... | spans: span{field=value}`.

Persistent surfaces:

| Surface | Location |
| --- | --- |
| Usage ledger | `$XDG_DATA_HOME/shore/ledger.db` |
| Conversation log | `$XDG_DATA_HOME/shore/<Character>/active.jsonl` |
| Compacted segments | `$XDG_DATA_HOME/shore/<Character>/segments/` |
| Active prompt snapshot | `$XDG_DATA_HOME/shore/<Character>/active_prompt/` |
| Deferred prompt edits | `$XDG_DATA_HOME/shore/<Character>/deferred_edits.jsonl` |
| Dreams audit log | `$XDG_DATA_HOME/shore/<Character>/DREAMS.md` |
| Dreaming state | `$XDG_DATA_HOME/shore/<Character>/dreams/` |
| Image attachments and generated outputs | `$XDG_DATA_HOME/shore/<Character>/images/` |

Disposable cache surfaces:

| Surface | Location |
| --- | --- |
| Cache forensics | `$XDG_CACHE_HOME/shore/cache_forensics.jsonl` |
| Provider model discovery | `$XDG_CACHE_HOME/shore/providers/<Provider>/models.json` |
| Workspace embedding index | `$XDG_CACHE_HOME/shore/characters/<Character>/workspace_index.json` |
| Resized image cache | `$XDG_CACHE_HOME/shore/resized/` |
| Observability store (call payloads + transcripts) | `$XDG_CACHE_HOME/shore/calls.db` |

Runtime surfaces:

| Surface | Location |
| --- | --- |
| TUI log | `$XDG_RUNTIME_DIR/shore/tui.log` |

Enable cache forensics with:

```toml
[advanced]
cache_forensics = true
```

Provider request bodies can include sensitive conversation context; do not paste
private logs into docs or commits.

## Validation

Use the narrowest useful check first:

```sh
python3 scripts/harness-check.py
cargo fmt --all --check
cargo test -p shore-daemon engine::prompt
cargo test -p shore-daemon tools::workspace
cargo test -p shore-daemon memory::deferred_edits
cargo test -p shore-daemon --test suite
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

CI also runs a visibility-only coverage report:

```sh
cargo llvm-cov --workspace --all-targets --lcov --output-path lcov.info
```

Release build gate:

```sh
cargo build --release -p shore-daemon -p shore-cli
```

The workspace correctness ratchet is intentionally compiler-enforced. Clippy
pedantic runs workspace-wide, cleaned crates deny panic-hygiene and lossy-cast
lints at the crate root, and Tier 2 also denies bare `#[allow]` suppressions,
panics/unwraps inside `Result` functions, `let _ =` discards of must-use values,
ignored return values, and unchecked `as` conversions. The low-noise Tier 2 set
also locks ref-counted pointer clone style, single-variant wildcard matches,
`dbg!`, stdout/stderr print macros, `std::process::exit`, `mem::forget`,
undocumented unsafe blocks, one unsafe op per `unsafe {}` block, assert
messages, `unsafe_code`, elided lifetimes in paths, unused qualifications,
missing `Debug` implementations, and unreachable `pub` items.
Import and literal hygiene is locked too: no wildcard imports (`use foo::*`),
separated numeric-literal suffixes (`1_u64`, not `1u64`), and descriptive
(non-single-char) lifetime names. String discipline is locked too:
`string_slice` bans `&s[i..j]` (a panic class on non-char-boundary byte
indices) and `str_to_string` prefers `.to_owned()` over `.to_string()` on
`&str`. Arithmetic discipline is locked too: `integer_division` forces
truncating `/` to be acknowledged, `modulo_arithmetic` flags `%` sign-surprises,
and `float_arithmetic` flags precision/NaN-prone float math (float-heavy
functions carry a reasoned function-level `#[expect]`). Control-flow and
type-surface strictness is locked too: `else_if_without_else` requires every
`else if` chain to end in a final `else` so the fall-through case is handled
explicitly, and `impl_trait_in_params` bans `fn f(x: impl Trait)` in favor of an
explicit named generic. (The adjacent `pattern_type_mismatch` lint is
deliberately not enabled: it is a situational `restriction`-group lint that
fights idiomatic match ergonomics.) Suppressions must use
`#[expect(..., reason = "...")]`.

Before a release, also run relevant cache tests, live provider smoke tests if
provider behavior changed, and Matrix live verification if Matrix behavior
changed.

## Correctness Ratchet

### Rationale

The ratchet exists so that heavy AI-assisted development cannot silently
degrade the codebase. It is a CI ratchet: quality-gating checks that block
merges and can only hold or improve over time, never regress. The long-term
aim is to make it as close to *impossible for bad code to compile* as the lint
surface allows — minimal exceptions, minimal escape hatches. Every gate is a
pure internal-hardening change, invisible to end users, leaving the daemon
functional after every merge.

### Rollout Convention

New lints land through a fixed sequence so the baseline only tightens:

- **Spike one crate first.** Enable the lint on a single crate to get a real
  violation count before committing to a workspace-wide cleanup.
- **Stage `warn` → per-crate lock → workspace promotion.** Start as a workspace
  `warn`, then add `#![deny(...)]` at the crate root once a crate is clean, then
  promote to `[workspace.lints]` so new crates inherit the baseline
  automatically. CI's `-D warnings` keeps the promoted set hard.
- **No bare suppressions.** There are `0` bare `#[allow]` in the tree. Every
  suppression is a reasoned `#[expect(..., reason = "...")]`, so a suppression
  that stops being needed fails the build instead of lingering.

### Tier Model

- **Tier 1** — `clippy::pedantic` workspace-wide, panic-hygiene and lossy-cast
  lints deny-locked per crate, `deny.toml` dependency hygiene, and
  `#[expect(..., reason = …)]` discipline.
- **Tier 2** — draconian `clippy::restriction` plus rustc paranoia: no panics
  or unwraps inside `Result` functions, no `let _ =` discards of must-use
  values, no ignored return values, no unchecked `as` conversions, locked
  ref-counted clone style, banned `dbg!`/print macros/`process::exit`/
  `mem::forget`, documented unsafe blocks, no unreachable `pub` items, and no
  variable shadowing (a binding can never silently shadow another, so data flow
  stays explicit).
- **Tier 2/3 tests** — `insta` snapshots, `proptest` round-trips, and a
  `cargo-llvm-cov` coverage job for visibility.

The Validation section above lists the currently enforced set; this section is
the convention every new gate follows.

## Removed Runtime Architecture

These are no longer normal runtime architecture:

- authoritative SQLite memory entries table
- LanceDB/vector store as memory source of truth
- passive RAG prompt injection
- separate collation pipeline
- interactive memory shell
- `character.md` as the active character definition path
- compaction-generated recap prompt files
- `memories/` as a runtime memory directory

SQLite is still used for the usage ledger and may appear in migration
tooling/history.
