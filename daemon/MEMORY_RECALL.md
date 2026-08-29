# Memory recall

Shore retrieves relevant memories before each fresh user turn and injects them
into the prompt, so the character does not have to decide to go looking. The
retrieval itself lives outside shore, in an MCP server that exposes a retrieval
tool:

```toml
[mcp.hindsight]
url = "http://mcp-hindsight:8888/mcp/qifei/"

[memory.recall]
mode = "inject"       # off | inject
server = "hindsight"
tool = "recall"       # defaults to "recall"
max_memories = 6
max_tokens = 2048
query_from = "user"    # user | recent; defaults to the latest user message
recent_messages = 2    # only used by query_from = "recent"
timeout = "3s"
```

The bank a server answers for is part of its URL, not a call argument, so each
character points at its own endpoint from its own config overlay.

`memory.recall.server` names the `[mcp.<server>]` entry to call and
`memory.recall.tool` the tool on it, defaulting to `recall`; shore calls
`mcp__<server>__<tool>` itself with `{ query, max_tokens, query_timestamp }`,
then keeps the first `max_memories` results. By default the query is the latest
user message; `query_from = "recent"` restores the older behavior of
joining the last `recent_messages` messages regardless of role. The timestamp
of the latest user message anchors Hindsight's temporal ranking. A reply is read
from `results` or `memories`, and a date from `occurred_start` or `occurred_at`,
so both hindsight's shape and a plainer one parse. Deliberately do **not** grant
that tool to any character: `McpRegistry.call` resolves against the full tool
surface while the model's tool list is built separately from
`tools.enabled_tools`, so the daemon calls it and the character never sees it.
Granting it would hand the decision back to the model, which is the problem this
exists to solve.

## The read path

`runGenerationCore` calls recall before it builds the request, using the latest
user message as the query by default. What comes back is appended as a single
`system`-role message at the **tail of the messages array**, after everything
real, and is never persisted.

The placement is a cache decision, not a stylistic one. Anthropic caching is a
prefix match over `tools -> system -> messages`, so a block that changes every
turn invalidates everything after it. Putting it in the system prompt would throw
away the whole message cache on every turn: measured over 687 real calls, 21,028
tokens per call are served from cache and only 218 are fresh, so that placement
would have turned about $0.75 of input cost into about $72 a month.

At the tail, every turn before the last is byte-identical, so the frozen-boundary
breakpoints still hit. Simulating two consecutive turns, the identical content
prefix is 4 messages with injection against 5 without, and two of the three
breakpoints written on the first turn are still readable on the second. The cost
is exactly one message: the adapter folds the block into the preceding user turn,
so the last-message breakpoint lands on a turn that will not repeat.
`tests/recalled_memory_injection.test.ts` pins these properties.

A fourth breakpoint on the last real message would recover even that one; there
is room under the four-marker limit, but it means changing `tsMessageBreakpoints`
for every provider path, so it is deliberately left alone until the injected
version has been watched in `shore usage` for a while.

Recall fails open. An unavailable server, a malformed reply, or the configured
`timeout` logs a diagnostics entry and the turn proceeds with no block. Recall
does not run on a regenerate.

## The write path

Live ingest is opt-in and follows the same archive boundary as
`contrib/hindsight/backfill.py`:

```toml
[memory.compaction]
write_memory = false

[memory.retain]
enabled = true
# server = "hindsight"       # defaults to memory.recall.server
user_name = "Ren"            # defaults to defaults.display_name
possessive_pronoun = "his"   # defaults to "their"
timeout = "15s"              # MCP submission deadline, not extraction time
```

One committed segment becomes one `shore:<character>:seg<N>` document with the
same content and relationship context as the backfill script. The archive
transaction records retain intent before the active-file swap and enqueues work
in the same transaction that commits the segment. A daemon crash cannot expose
an uncommitted segment to Hindsight or lose a committed segment's pending work.
The worker calls Hindsight's asynchronous `retain`, so the 90-400 second
extraction runs behind Hindsight rather than blocking compaction or the turn
that triggered it. The worker follows accepted operations to completion,
serializes them per character, and retries submission or extraction failures
with exponential backoff; the stable document id makes a retry converge on one
document.

Hindsight's current MCP `retain` returns an operation id but does not accept a
caller-supplied one. A connection loss after Hindsight accepted a submission
can therefore repeat extraction cost on retry, although the stable document id
still prevents duplicate final documents. The REST retain endpoint closes that
last ambiguity; the MCP surface does not yet expose its idempotency key.

`memory.retain.enabled` requires `write_memory = false`: Hindsight owns the
retrieved layer instead of running the compaction LLM that rewrites memory
files. Existing `MEMORY.md` and workspace notes are not deleted and remain in
the always-present prompt, so they can still be hand-curated.

Exclusion is part of the durable queue state. A segment excluded before submit
is never read. Excluding an already-submitted segment first attempts to cancel
its Hindsight operation, then calls `delete_document`; including it queues a
fresh upsert. This cleanup also applies when `shore segments exclude N` first
adopts a segment created by the manual backfill path.

`contrib/hindsight/backfill.py` remains the historical import and repair tool.
Because `document_id` upserts, it carries no cursor and no resume state:
re-running a range is both idempotent and the recovery path.

The mem0 ingest service was removed on 2026-08-29 and is archived on the
`mem0-archive` branch. Two conclusions from that build still hold:

- **Ingest archived segments, not the live conversation.** Compaction retains
  `keep_recent_turns` and archives the rest, so a turn is archived exactly when
  it falls out of the live window -- which is the moment memory has to start
  carrying it. While a turn is still in context, recalling it only duplicates
  text the prompt already holds.
- **Honour exclusion before ingest.** `shore segments exclude N` and
  `shore clear --exclude` set a flag. Hindsight also exposes cancellation and
  `delete_document`, which provide the after-the-fact backstop mem0 lacked.

## Watching it

`shore trace recall` is the read-side view:

```console
shore trace recall
```

Every turn recall ran, newest first: what it searched on, each memory it
injected, and how long it took. This is the view for "is it working" and for
judging whether the memories were any good -- the same text the character saw,
without digging a call id out of `shore trace calls`.

Entries are stored as `memory_recall` transcripts in the call store, beside the
heartbeat and sub-agent runs, so they inherit its retention and rotation.

```console
shore trace errors
```

The `Memory recall` section stays terse on purpose: status, how many memories
came back, elapsed. No recalled text, so a glance at errors never spills the
contents of her memory.

## Measured

### Why the previous design was replaced, 2026-08-28

200 real `qifei` turns from 2026-07-01 to 2026-08-28 were replayed against a copy of the live
archive (37,325 archived messages, 48,297 chunks, 89% embedded). Each turn saw only material
that predated it. Selector: `anthropic:claude-haiku-4-5`. 100 turns where the character did
invoke a memory tool in its reply, 100 where it did not.

**The selector did not discriminate.**

| | character queried memory | it did not | difference |
| --- | --- | --- | --- |
| selected at least one candidate | 82% | 76% | +6pp (z = 1.04) |
| requested a deeper lookup | 50% | 34% | +16pp (z = 2.32) |

Selection fires on 79% of all turns at a rate the label does not move. `deep_lookup_ids` is the
only output that separates the two groups, and shadow mode records it without acting on it.

**Both halves lost the material.**

On the 95 positive turns whose real `ask_memory` report cited workspace files:

| | rate |
| --- | --- |
| a cited file reached the candidate list | 36% |
| a cited file survived selection | 16% |

The selector discarded 19 of the 34 cited files retrieval did surface. Path extraction from the
subagent's prose is approximate and the workspace has moved since those turns, so read these as
a floor.

**Retrieval, not the selector, was the cost.**

Sequential, one turn at a time:

| stage | ms |
| --- | --- |
| query embedding, remote | 1,300-5,100 |
| vector scan over 43,240 embeddings | ~1,000 |
| history lexical FTS | 2,900-6,700 |
| workspace search | 1,300-5,000 |
| retrieval total, both sources in parallel | 14,000-31,000 |
| selector call | 1,400-3,000 |

`runGenerationCore` awaits this before building the chat request, so shadow mode adds 14-31
seconds to a turn that is not yet using the result. `withHistoryIndexLock` is held across the
whole hybrid search including the remote embedding round trip, so concurrent turns serialise.

Passing the raw 4,000-character recent-conversation blob as the lexical query is a large part of
it. The stopword-trimmed `lexicalHistoryQuery` form, which today only runs when no embedder is
configured, returned the same eight hits about three times faster:

```
history lexical  raw=5288ms/8 hits   trimmed=1928ms/8 hits
history lexical  raw=6504ms/8 hits   trimmed=1876ms/8 hits
history lexical  raw=6117ms/8 hits   trimmed=1681ms/8 hits
```

Whether the trimmed query retrieves as well is unmeasured; its last-12-terms heuristic loses
topicality.

**Cost.**

4,758 input and 79 output tokens per call, no cache traffic. At 19.5 user turns a day that is
$2.97 a month on Haiku 4.5. Before `cache_ttl` was stripped from the selector request every call
wrote its whole payload to a 1h cache it never read, at twice the base input price: 200 calls
cost $1.03 rather than $2.02.

`search_chat_logs` also returns each hit's neighbouring messages; `historyCandidates` reads only
`text` and drops them, so the selector judges each excerpt without its surrounding turns.
