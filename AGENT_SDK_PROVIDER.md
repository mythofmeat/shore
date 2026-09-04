# Claude Agent SDK provider (`sdk = "claude_agent"`)

An experimental shore provider that routes a character's turns through
[`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/overview) — Claude
Code packaged as a library — so chat can run on a Claude subscription instead of Anthropic API
credits.

This is here to be tried and judged, not to be depended on. It is built to be deleted cheaply
(see [Removing it](#removing-it)).

## Why it exists

Measured against qifei's real card (SOUL + USER + AGENTS, ~37k chars) on 2026-09-02, with the
wire captured through a logging proxy on `ANTHROPIC_BASE_URL`:

- **Characterization is not degraded.** Once the harness is stripped, it contributes ~200 tokens:
  a billing-header line, one sentence reading `You are a Claude agent, built on Anthropic's
  Claude Agent SDK.`, and a `<system-reminder>` carrying the account email and today's date.
- Left at its defaults it is much worse — ~25 built-in tool schemas (~12.8k tokens) ride along,
  it loads `~/.claude/settings.json` and project `CLAUDE.md`, and every turn costs a second API
  request to generate a session title. The provider turns all of that off.

## Enabling it

```toml
[providers.claude-agent]
subscription = true
sdk = "claude_agent"
discovery.enabled = false

[chat.claude-agent.opus5]
model_id = "claude-opus-5"
sdk = "claude_agent"
```

Then select `claude-agent:claude-opus-5` (or the bare `opus5` alias) as a character's chat model.

There is no model discovery endpoint, so models must be declared statically. `[chat.*]` is
deprecated but still honored; move to whatever replaces it when that lands.

**Credentials.** This sdk is *keyless*: `isKeylessSdk` (`daemon/src/llm/credentials.ts`) short-
circuits the key lookup, so a turn is always built with `api_key: ""` under the candidate name
`subscription`. Configuring a key for the provider does not change that — the key is ignored, not
preferred. The CLI subprocess therefore authenticates with the Claude Code OAuth credentials at
`<CLAUDE_CONFIG_DIR>/.credentials.json`, which is the subscription path and the point of the
exercise.

The daemon's own environment is *not* inherited by the subprocess. `buildOptions` constructs
`Options.env` from scratch, forwarding only `PATH`, `HOME`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
and `CLAUDE_CONFIG_DIR` when set. So an `ANTHROPIC_API_KEY` exported for shore's other providers
cannot reach this one and cannot silently move a character onto API billing. Two independent
guards have to fail for that to happen, and both are covered in `mutate_claude_agent.py` under
`billing:`.

Because `CLAUDE_CONFIG_DIR` is forwarded, it also selects *which* Claude account a character bills
against when several are logged in under separate config directories.

## What it does

Implements the ordinary `SidecarProvider` contract (`stream` / `generate`), so budgets, the
ledger, retries, fallback and the client stream all work as they do for any other provider.

- **Streaming** via `includePartialMessages`. The SDK forwards the model's own Anthropic stream
  events, so they are parsed by the same code the Anthropic provider uses
  (`anthropicContentEvents`): text, thinking, thinking signatures, redacted thinking and tool
  calls all arrive as they do on any other Anthropic-backed model.
- **Usage** (`input`, `output`, `cache_read`, `cache_creation`) is reported to the ledger, taken
  from the run's own result — one row per turn.
- **Finish reasons** come from the model's `message_delta`, falling back to the run's result when
  the stream never said how it ended, so a turn truncated at `max_tokens` is not reported as a
  clean stop.
- **Images** are sent rather than described. History replays as text, so each picture leaves an
  `[image attached: <type>]` marker where it was and the image itself rides along with the prompt.
  Assistant-attached images use the same `tool_pair` encoding as the Anthropic provider.
- **Reasoning effort** passes through: `low` / `medium` / `high` / `xhigh` / `max`. `off` and
  `adaptive` are dropped, because the SDK takes a named level or nothing.
- **Harness suppression**: `settingSources: []`, `tools: []` and `skills: []` (omitting either is
  not the same as turning it off), `settings: { autoCompactEnabled: false }` so the harness cannot
  summarise history shore believes is intact, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` so
  a turn costs one API request rather than two. Frames belonging to an agent the SDK ran by itself
  are ignored, and a mid-turn compaction is raised rather than absorbed.

### Conversation history

The Agent SDK cannot be seeded with assistant turns — `query()` accepts user messages only — so
the SDK owns history and shore tracks which session corresponds to which conversation.

`$SHORE_DATA_DIR/claude_agent_sessions.json` maps a conversation (character + ledger + thread)
to a session id plus a hash of every message delivered so far, and the SDK frame each assistant
turn ended on — one per round, so a turn that used tools anchors each of its rounds rather than
stamping the whole turn on the first. Getting that wrong is quiet: resuming and extending still
work, and only an edit-and-regenerate forks in the wrong place. The hash covers every content
block, not just text — an image, a tool call's arguments and a tool result's output each change
it — so two turns that differ only in what was attached are not read as one. Whitespace-only text
blocks are dropped first, mirroring `daemon/src/handler/wire_messages.ts`, so a turn hashes the
same when it is recorded as it does when it comes back on the wire. The book carries a `version`;
one written under an older hash is ignored rather than compared against, which costs a single cold
start on upgrade. The main thread is keyed exactly
as it was before threads existed, so an in-flight session survives the upgrade; a side thread
gets a session of its own, which is what makes running this provider in one thread while the
main conversation stays on another possible at all. Each turn:

| Situation | Action |
|---|---|
| Incoming history extends what was delivered | `resume` the session, send only the new user message |
| History diverges partway (an edit) | `resume` + `resumeSessionAt` the last delivered assistant turn + `forkSession`, replaying everything after it |
| Regenerating the most recent turn | Same fork, anchored one assistant turn further back; the user turn being answered is re-sent |
| No common prefix, no session yet, or no assistant turn to anchor on | Fresh session; prior turns replayed as text, assistant ones wrapped in `<prior_assistant_turn>` |

A replay is lossy but not silent: tool calls and their results come back as
`<prior_tool_call name=…>` / `<prior_tool_result>` pairs rather than being dropped, so a cold
start — which shore compacting a conversation forces — does not tell the model it said things it
has no record of doing.

Regeneration is the case worth understanding. Shore drops the assistant turn it is replacing, so
the incoming history is exactly what was already delivered — there is no diverging tail to detect.
Treating that as an ordinary extension sends the SDK an **empty prompt**, and the model answers a
blank turn. So an empty tail is read as "regenerate": fork at the assistant turn *before* the one
being replaced and re-send the user turn that follows it.

The fork anchor **must** be an assistant uuid. The SDK does not echo a `user` message back for a
string prompt, so user uuids are never observable; anchoring on them silently forks from the end
of the session and the regenerated turn still sees the turn it was supposed to replace. When no
assistant uuid is available to anchor on, the turn cold starts rather than forking blind.

A fork also resets the delivered record to the anchor. Everything after it is re-sent, because the
forked session does not contain it — keeping those entries would claim the SDK had seen messages
it never did. The SDK remints the UUID of every entry copied into a fork, so the new record drops
all parent UUIDs as well; only assistant frames observed after the fork are valid anchors in that
session. If the CLI nevertheless reports that a requested anchor is missing, shore discards that
record so a retry cold-starts instead of repeating the same deterministic failure.
`tests/claude_agent_sessions.test.ts` pins all of this.

## Tools

A character on this provider gets shore's own tools — the built-ins, whatever external MCP
servers are configured, and the `ask_*` subagents — running through shore's dispatcher, with
shore's argument validation, per-tool timeouts, result windowing, media handling and
`tool_call` / `tool_result` frames. There is no second implementation.

The bridge is that shore's tool loop lives *outside* the provider while the Agent SDK runs its
own. `turnEvents` (`daemon/src/handler/generation.ts`) already picks a loop per `sdk`, so
`claude_agent` gets its own arm alongside the Anthropic one, and that arm is handed the
`ToolPhase` the `SidecarProvider` contract deliberately withholds. `daemon/src/tools/subagent_loop.ts`
has an independent switch of the same shape; both are wired, or a subagent on this provider
would silently get no tools.

Shore's tools reach the SDK as one in-process MCP server built from `req.tools`. **The CLI applies
the `mcp__<server>__` namespace itself**, to whatever the server advertises — so shore advertises
the bare name and the prefixed form only ever exists on the model's side of the boundary. Getting
this backwards costs nothing at registration and fails on every call, so the four boundaries are
worth stating plainly (all four are verified against the real binary):

| Boundary | Name | Who chooses it |
|---|---|---|
| `req.tools`, and the ledger's tool-surface fingerprint | `read` | shore |
| MCP `tools/list` | `read` | shore |
| what the model is shown, and `canUseTool` | `mcp__shore__read` | the CLI |
| the model's own `tool_use` block, as streamed | `mcp__shore__read` | the model |
| MCP `tools/call` | `read` | the CLI |
| `dispatchTool`, and every block written to `active.jsonl` | `read` | shore |

So the table translates in exactly two places: `canUseTool` maps prefixed to bare to decide, and a
streamed `tool_use` is renamed back to bare before it is either matched to a call or persisted.
The bare name is what gets written down, so a conversation stays replayable if the character is
later moved to another provider — persisting the prefixed name would 400 every subsequent turn on
the Anthropic provider, and nothing before that point would look wrong.

Shore's own external MCP tools already arrive as `mcp__probe__echo_back`, so the model sees
`mcp__shore__mcp__probe__echo_back`. The table round-trips that; string surgery would not.

Names that collide after sanitizing, or that are too long to advertise, are refused rather than
merged or truncated.

**Result size.** The CLI will not inline an MCP result over **50,000 characters**: past that it
writes the result to a file and substitutes a pointer to it — either an `exceeds maximum allowed
tokens` error or a `<persisted-output>` block with a 2 KB preview. Both are useless here, because
the file can only be opened with the CLI's own `Read` tool, which this provider disables. The
result is not truncated, it is *gone*.

There are two separate gates and only one is tunable, so shore handles them separately: the token
gate (`MAX_MCP_OUTPUT_TOKENS`, default 25,000) is lifted in the subprocess environment, and shore
windows every result to `MCP_RESULT_CEILING_BYTES` (48,000 bytes, measured in bytes because the
CLI's limit is on encoded size) before handing it over. What the model then sees is shore's own
head/tail window and its `[tool_result truncated: …]` notice — the same treatment as every other
provider, just with a lower effective ceiling than a character's configured `max_result_chars`
when that is set above ~48 KB.

**The loop is the SDK's.** shore does not drive it, so:

- Each round is written down as the assistant's `tool_use` blocks followed by their
  `tool_result`s, in that order, which is what `engine/merge.ts` needs to fold a tool-using turn
  back into one logical turn for regeneration and alt-switching. The final reply is not recorded
  as a round — it leaves in the finished turn.
- `max_tool_iterations` is enforced in `canUseTool` rather than through the SDK's `maxTurns`.
  Exceeding `maxTurns` ends a turn on a dangling `tool_use` with no prose; denying without
  `interrupt` lets the model answer with what it has, which is what shore's own cap does.
  `maxTurns` is left as an unreachable backstop.
- Budgets are checked in the same place, so a budget that trips mid-turn stops further tools
  instead of being noticed only at the end.
- Usage is **one ledger row per turn**, taken from the run's own result — the SDK reports it
  per-turn for the main loop, which is exactly one row's worth. `ask_*` subagents still bill
  separately through their own rows, because they run shore's loop. There is no per-round
  accounting, so a report cannot break a turn down by round on this provider as it can on the
  others.
- The wire is not captured. The SDK's HTTP happens in a subprocess, so `capturedEvents` is
  deliberately not wrapped around this arm — `/calls` inspection is blind here. Use the
  `ANTHROPIC_BASE_URL` proxy trick described above instead.

Shore's prompts name tools bare (`read`, `search`), while the model sees them prefixed. In practice
the model follows the prefixed names it is given without trouble, but watch for it reaching for the
bare one.

**Verified against the real CLI.** A scratch daemon on this provider was driven through `read`,
`search`, `git`, an external stdio MCP server and an `ask_*` subagent — including all three kinds
called in parallel in one round. Tool frames render, the subagent trace lands in `subagents.jsonl`,
the ledger takes one `message` row per turn plus a separate `subagent` row, and a regenerate after
a tool-using turn resumed the session rather than cold-starting (input tokens stayed at 4).

### Other gaps

- **The streaming-input prompt form is only exercised on image turns.** `query()` takes either a
  string or an `AsyncIterable<SDKUserMessage>`, and only the latter can carry an image. A turn
  with no images still goes as a string, so the common path is unchanged; a turn with one switches
  form. The SDK documents some behaviour as differing between the two (`result.usage` is described
  as per-turn "in streaming-input sessions"), and that difference has not been checked against the
  real CLI.

- **`total_cost_usd` is deliberately unset** — though so is Anthropic's. Cost comes from shore's
  own pricing catalogue, and `subscription = true` already suppresses it, so this is not a
  difference from the other providers. The SDK does compute a figure locally from a bundled price
  table, and it is not fed to the ledger: on a subscription it is not real money.
- **No `temperature` / `top_p`.** The SDK exposes no sampling controls.
- **Packaging.** The compiled daemon cannot find the CLI this provider spawns. See
  [Packaging](#packaging) — it is the one thing keeping this dev-only.
- **Session book is only partly garbage collected.** Archiving a thread drops its entry, but
  nothing else does: entries accumulate per character + ledger + thread, and every fork mints a
  new session id. Deleting a character leaves its sessions behind. It is a small JSON file.
- **Compaction desync.** Shore compacting a conversation changes the message prefix, so the next
  turn falls back to a cold start with a text replay. Correct, but it pays a full cache write.

## Packaging

**This is what keeps the provider dev-only.** Measured against 0.3.260 on 2026-09-04.

The native CLI is not downloaded at runtime, as was previously assumed here. It ships as
platform-specific **optional npm dependencies** — `@anthropic-ai/claude-agent-sdk-linux-x64` and
friends — so `bun install` places it in `node_modules` like any other package. On this machine
that is 405 MB, because both the glibc and musl linux-x64 variants resolve; the SDK package
itself is 4.9 MB.

At runtime `sdk.mjs` finds the binary with `createRequire(import.meta.url).resolve(...)`, i.e.
ordinary `node_modules` resolution relative to its own file. That is exactly what
`bun build --compile` takes away: inside the compiled executable `import.meta.url` points into the
bundle, so resolution fails. Confirmed by compiling a probe and running it away from any
`node_modules`:

```
Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk
without --omit=optional, or set options.pathToClaudeCodeExecutable.
```

`daemon/Dockerfile` is unaffected — it runs from source with `node_modules` present, which is why
Docker already works.

### The options

1. **Point at an installed Claude Code.** `Options.pathToClaudeCodeExecutable` overrides the
   resolution entirely, and the same probe compiled with it set reaches the SDK normally. This is
   the cheapest fix and arguably the right one: the subscription path already assumes the user has
   Claude Code installed and logged in, because that is where `CLAUDE_CONFIG_DIR` credentials come
   from. Cost is a config knob, a resolution order (explicit setting → `PATH` → the platform's
   usual install location), and an error that names the setting when nothing is found. Ships
   nothing, so makepkg and the brew tap need no change beyond declaring the dependency.
2. **Ship `node_modules` beside the binary.** Abandons the single-executable property that
   `--compile` exists for, and puts 200 MB into every package.
3. **Docker only.** Already works; just say so and stop offering the compiled path for this
   provider.
4. **Leave it dev-only.** Also a real answer while the provider is still being judged.

Option 1 is small and self-contained, but it is a decision about what shore requires of a host, so
it is written down rather than taken.

## Removing it

1. Delete `daemon/src/llm/providers/claude_agent.ts`,
   `daemon/tests/claude_agent_loop.test.ts`,
   `daemon/src/llm/providers/agent_sessions.ts`,
   `daemon/src/llm/providers/claude_agent_tools.ts`,
   `daemon/src/testing/fake_agent_query.ts`,
   `daemon/tests/claude_agent_tools.test.ts`,
   `daemon/tests/claude_agent_sessions.test.ts`,
   `daemon/tests/claude_agent_stream.test.ts` and
   `daemon/scripts/mutate_claude_agent.py`.
2. Revert the four one-line touches: the `Sdk` union and `SDK_VARIANTS` in `daemon/src/llm/types.ts`,
   the import and table entry in `daemon/src/llm/providers/table.ts`, the `claude_agent` arm
   in `turnEvents` (`daemon/src/handler/generation.ts`) and in `subagentEvents`
   (`daemon/src/tools/subagent_loop.ts`), the effort case in
   `daemon/src/llm/settings.ts`, and the sdk-picker suggestion list in
   `client/shore-cli/src/tui/ui.rs`.
3. Drop the `forgetThreadSessions` import and its call in `archiveThread`
   (`daemon/src/engine/threads.ts`), and the two mutants and three tests that cover it.
4. Restore the expected variant list in `daemon/tests/config_captures/model_resolution.json`.
5. `bun remove @anthropic-ai/claude-agent-sdk`.

`engine/threads.ts` is the only module outside the provider that reaches into it, which is why the
session book lives in its own file: pruning on archive does not drag the SDK into the thread path.
