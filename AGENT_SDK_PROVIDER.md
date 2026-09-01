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

- **Streaming** via `includePartialMessages`; text and thinking deltas are forwarded as they
  arrive.
- **Usage** (`input`, `output`, `cache_read`, `cache_creation`) is reported to the ledger.
- **Reasoning effort** passes through: `low` / `medium` / `high` / `xhigh` / `max`. `off` and
  `adaptive` are dropped, because the SDK takes a named level or nothing.
- **Harness suppression**: `settingSources: []`, every built-in tool disallowed, and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` so a turn costs one API request rather than two.

### Conversation history

The Agent SDK cannot be seeded with assistant turns — `query()` accepts user messages only — so
the SDK owns history and shore tracks which session corresponds to which conversation.

`$SHORE_DATA_DIR/claude_agent_sessions.json` maps a conversation (character + ledger) to a
session id plus a hash of every message delivered so far. Each turn:

| Situation | Action |
|---|---|
| Incoming history extends what was delivered | `resume` the session, send only the new user message |
| History diverges partway (regeneration, an edit) | `resume` + `resumeSessionAt` the last kept assistant turn + `forkSession` |
| No common prefix, or no session yet | Fresh session; prior turns replayed as text, assistant ones wrapped in `<prior_assistant_turn>` |

The fork anchor **must** be an assistant uuid. The SDK does not echo a `user` message back for a
string prompt, so user uuids are never observable; anchoring on them silently forks from the end
of the session and the regenerated turn still sees the turn it was supposed to replace.
`tests/claude_agent_sessions.test.ts` pins this.

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

- **`total_cost_usd` is deliberately unset.** The SDK computes it locally from a bundled price
  table; on a subscription it is not real money. Feeding it to the ledger would show spend that
  never happened.
- **No `temperature` / `top_p`.** The SDK exposes no sampling controls.
- **Packaging.** `@anthropic-ai/claude-agent-sdk` pulls a ~205 MB native Claude Code binary and
  spawns it as a subprocess. That has not been reconciled with `bun --compile`, makepkg, or the
  brew tap yet, so treat this as dev-only until it has.
- **Session book is not garbage collected.** Entries accumulate per character + ledger. It is a
  small JSON file, but nothing prunes it.
- **Compaction desync.** Shore compacting a conversation changes the message prefix, so the next
  turn falls back to a cold start with a text replay. Correct, but it pays a full cache write.

## Removing it

1. Delete `daemon/src/llm/providers/claude_agent.ts` and
   `daemon/tests/claude_agent_sessions.test.ts`.
2. Revert the four one-line touches: the `Sdk` union and `SDK_VARIANTS` in `daemon/src/llm/types.ts`,
   the import and table entry in `daemon/src/llm/providers/table.ts`, the effort case in
   `daemon/src/llm/settings.ts`, and the sdk-picker suggestion list in
   `client/shore-cli/src/tui/ui.rs`.
3. Restore the expected variant list in `daemon/tests/config_captures/model_resolution.json`.
4. `bun remove @anthropic-ai/claude-agent-sdk`.

Nothing else in shore refers to it.
