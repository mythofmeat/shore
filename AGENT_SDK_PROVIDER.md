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

**Credentials.** With no API key configured the SDK uses the Claude Code OAuth credentials found
via `CLAUDE_CONFIG_DIR` — that is the subscription path, and the point of the exercise. Setting a
key for the provider makes it use that key (and bill normally) instead.

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
to a session id plus a hash of every message delivered so far. The hash covers every content
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
it never did. `tests/claude_agent_sessions.test.ts` pins all of this.

## What is not available yet

### Tools — none

**This is the big one. A character on this provider has no tools at all.** For qifei that means
no `read`, `edit`, `search`, `git` or `activity_heatmap`, and none of the `internet`, `memory`,
`music` or `lights` subagents. Judge the provider knowing that is missing.

The obstacle is structural rather than fiddly. Shore's tool loop lives *outside* the provider —
`genericToolLoopEvents` drives it, and the provider only ever streams a `tool_use` event and gets
called again later with the result. The Agent SDK runs its own loop and expects to execute tools
itself through handlers it owns. Bridging them means one of:

1. Register shore's tools as SDK MCP tools (`createSdkMcpServer`) whose handlers call back into
   shore's dispatcher. This needs the provider to reach the tool executor, which the
   `SidecarProvider` contract deliberately does not hand it, and it moves the loop into the SDK —
   bypassing shore's dispatch, permission and tracing paths.
2. Let the SDK use its *own* built-in tools (`Read`/`Edit`/`Grep`/`Bash`) with `cwd` pointed at
   the character workspace. Cheap, and a decent fit for qifei's file tools, but it is a second
   tool implementation with different semantics and no shore subagents.

Neither is a small change, and which one is right depends on whether this provider turns out to
be worth keeping.

### Other gaps

- **`total_cost_usd` is deliberately unset** — though so is Anthropic's. Cost comes from shore's
  own pricing catalogue, and `subscription = true` already suppresses it, so this is not a
  difference from the other providers. The SDK does compute a figure locally from a bundled price
  table, and it is not fed to the ledger: on a subscription it is not real money.
- **No `temperature` / `top_p`.** The SDK exposes no sampling controls.
- **Packaging.** `@anthropic-ai/claude-agent-sdk` pulls a ~205 MB native Claude Code binary and
  spawns it as a subprocess. That has not been reconciled with `bun --compile`, makepkg, or the
  brew tap yet, so treat this as dev-only until it has.
- **Session book is only partly garbage collected.** Archiving a thread drops its entry, but
  nothing else does: entries accumulate per character + ledger + thread, and every fork mints a
  new session id. Deleting a character leaves its sessions behind. It is a small JSON file.
- **Compaction desync.** Shore compacting a conversation changes the message prefix, so the next
  turn falls back to a cold start with a text replay. Correct, but it pays a full cache write.

## Removing it

1. Delete `daemon/src/llm/providers/claude_agent.ts`,
   `daemon/src/llm/providers/agent_sessions.ts`,
   `daemon/src/testing/fake_agent_query.ts`,
   `daemon/tests/claude_agent_sessions.test.ts`,
   `daemon/tests/claude_agent_stream.test.ts` and
   `daemon/scripts/mutate_claude_agent.py`.
2. Revert the four one-line touches: the `Sdk` union and `SDK_VARIANTS` in `daemon/src/llm/types.ts`,
   the import and table entry in `daemon/src/llm/providers/table.ts`, the effort case in
   `daemon/src/llm/settings.ts`, and the sdk-picker suggestion list in
   `client/shore-cli/src/tui/ui.rs`.
3. Drop the `forgetThreadSessions` import and its call in `archiveThread`
   (`daemon/src/engine/threads.ts`), and the two mutants and three tests that cover it.
4. Restore the expected variant list in `daemon/tests/config_captures/model_resolution.json`.
5. `bun remove @anthropic-ai/claude-agent-sdk`.

`engine/threads.ts` is the only module outside the provider that reaches into it, which is why the
session book lives in its own file: pruning on archive does not drag the SDK into the thread path.
