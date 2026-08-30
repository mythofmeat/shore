# Memory recall

Shore retrieves relevant memories before each fresh user turn and injects them
into the prompt, so the character does not have to decide to go looking. The
retrieval itself lives outside shore, in a Hindsight instance shore connects to
directly:

```toml
[memory.backend]
url = "http://mcp-hindsight:8888/mcp/"
# bank = "qifei"      # defaults to the character name

[memory.recall]
mode = "inject"       # off | inject
max_memories = 6
max_tokens = 2048
query_from = "user"    # user | recent; defaults to the latest user message
recent_messages = 2    # only used by query_from = "recent"
timeout = "30s"
# preamble = "Relevant private notes:"  # defaults to shore's explanatory text

# [memory.recall.min_scores]
# reranker = 0.1     # drop results Hindsight scored below this
```

`memory.backend.url` is the base a Hindsight instance serves; the bank becomes
the last path segment, so one base serves every character and each gets its own
bank without its own config entry. `bank` overrides the default when two
characters should share one, or when the bank is named differently from the
character.

Shore owns this connection: `MemoryBackends` holds one `McpClient` per
character, opened on first use and reopened after a transport failure. It is
deliberately not an `[mcp.*]` server. Those exist to put tools in front of the
model, and this is the opposite — the daemon calls `recall` itself with
`{ query, max_tokens, query_timestamp }` plus `min_scores` when configured, and
keeps the first `max_memories` results, so the character never sees the tool and
never decides to use it.
Routing memory through the model-facing registry is what made it possible to
break memory silently by writing the server entry in the wrong file.

By default the query is the latest user message; `query_from = "recent"` restores the older behavior of
joining the last `recent_messages` messages regardless of role. The timestamp
of the latest user message anchors Hindsight's temporal ranking. A reply is read
from `results` or `memories`, and a date from `occurred_start` or `occurred_at`,
so both hindsight's shape and a plainer one parse.

## Score floors

`memory.recall.min_scores` is passed through to Hindsight, which drops results
scoring below the floor on any named score (`final`, `reranker`, `semantic`,
`keyword`). It is empty by default and nothing is sent when it is.

It exists because a query that names its subject and a query that does not are
not two points on one scale. Measured on the qifei bank: a topical query scores
0.99/0.98/0.94 on its top three, while a contentless one ("what did you mean by
that") scores ~1e-5 flat across every result. In the flat case the ordering is
sigmoid-tail noise, so `max_memories` slices six arbitrary memories off an
unranked list and the preamble presents them as relevant. A floor turns that turn
into an empty recall instead.

Hindsight warns that reranker scores are not calibrated across queries, so the
floor is not shipped with a default. Derive it from a labelled archive:
`contrib/hindsight/recall_eval.py report` prints the reranker distribution per
label and what each candidate floor would keep and drop.

## The read path

`runGenerationCore` calls recall before it builds the request, using the latest
user message as the query by default. What comes back is appended as a single
`system`-role message at the **tail of the messages array**, after everything
real, and is never persisted. Adapters that have no mid-conversation `system`
role fold such a turn into a user turn inside `<system_instruction>`; the recall
block is exempt because `<recalled_memories>` already frames it, so it reaches
the wire under one tag rather than two.

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

The timeout covers Hindsight's entire retrieval and reranking pipeline; it does
not make that pipeline faster. On a CPU-only Hindsight deployment the local
cross-encoder normally dominates recall latency because it scores every fused
query-memory pair. Enable Hindsight's quality-identical length-bucketed batching
before reducing search quality:

```yaml
environment:
  - HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING=true
```

Hindsight documents that optimization as a 36–54% speedup. Shore's default 30s
deadline then leaves headroom for a cold or contended CPU without making every
turn wait indefinitely. If the reranker still approaches the deadline, cap
`HINDSIGHT_API_RERANKER_MAX_CANDIDATES`; that trades recall coverage for speed,
so compare it with `contrib/hindsight/recall_eval.py` before deploying it.
`memory.recall.min_scores.reranker` improves result quality but does not save the
reranking work, because that floor is applied after candidates have been scored.

`memory.recall.preamble` replaces the explanatory paragraph at the start of the
`<recalled_memories>` block. It is inserted verbatim and is not a template. Set it
to `""` to omit the paragraph while retaining the tagged fact list. The shipped
default says that the lines are notes rather than conversation and may be
ignored; keep that framing unless a character needs different wording.

`shore trace recall` shows the query, latency, injected count, and the first 12
ranked candidates with Hindsight's `final`, `reranker`, `semantic`, and `keyword`
scores. `--json` exports the same data. Scores are diagnostic: Hindsight defines
them as relative within one query, not calibrated confidence across queries, so
shore does not apply a score floor without measurements from the actual bank.

## The write path

Live ingest is opt-in and follows the same archive boundary as
`contrib/hindsight/backfill.py`:

```toml
[memory.compaction]
write_memory = false

[memory.retain]
enabled = true
user_name = "Ren"            # defaults to defaults.display_name
possessive_pronoun = "his"   # defaults to "their"
timeout = "15s"              # MCP submission deadline, not extraction time
```

One committed segment becomes one `shore:<character>:seg<N>` document with the
same `content`, `context` and `document_id` as the backfill script, so a segment
imported by either is byte-identical. The daemon omits `update_mode`, whose
default is already `replace`.

### What the segment column means

`memory_doc` is a column on `history_segments`, not a queue table: the archive
writes it `pending` in the same statement that inserts the segment, so a crash
cannot leave the two disagreeing and there is no second transaction to keep in
step. Four more columns on the same row carry the rest of the state:
`memory_doc_op` (the accepted operation), `memory_doc_attempts`,
`memory_doc_due` (the next time the worker may touch this segment) and
`memory_doc_expires` (when an unconfirmed submission is given up on).

| `memory_doc` | meaning |
|---|---|
| *null* | no work: retain was off when it archived, the segment held no text, or it was excluded before anything was sent |
| `pending` | queued for submission |
| `submitted` | Hindsight accepted a `retain`; extraction has **not** been confirmed |
| `stored` | the operation finished **and** `get_document` found the document |
| `failed` | submission gave up after ten attempts |
| `delete_failed` | deletion gave up after ten attempts |

`stored` is the only state that means the memories exist. Accepting a document
is not storing it.

### Submission is not ingestion

Hindsight's `retain` is asynchronous: it answers in milliseconds with
`{"status": "accepted", "message": "Memory storage initiated", "operation_id":
"..."}` and runs the 90-400 second extraction in its own worker. Only that exact
shape — `status` of `accepted` **and** a non-empty `operation_id` — counts as
acceptance. An empty, malformed or unrecognised reply leaves the segment
queued and records what came back, because a reply shore cannot read is a reply
that proves nothing.

The worker then follows the operation it was given. `get_operation` reports
`pending`/`processing` while extraction runs, and the segment is re-checked once
a minute:

- `completed` — `get_document` must also find the document before the segment
  becomes `stored`. A completed operation that stored nothing is resubmitted.
- `failed` or `cancelled` — resubmitted, carrying Hindsight's `error_message`.
- `not_found` — the operation row was pruned; the document decides. Present is
  `stored`, absent is a resubmission.
- still running after 30 minutes — resubmitted.

Resubmission is safe because `document_id` upserts with replace semantics, but
it is not free: it pays for extraction again. So before any resubmission, and
whenever the daemon restarts holding a submission it never got an id for, the
worker reconciles against the server first — `get_document` for a document that
already landed, then `list_operations` for one still in flight, whose rows carry
the `document_id` they were submitted for. Only when Hindsight has neither does
shore pay again. The MCP `retain` tool takes no caller-supplied `operation_id`,
so this reconciliation is how an ambiguous acknowledgement is resolved.

Failure is bounded the same way it always was: the attempt count and last error
live on the segment, retries back off exponentially to a 60-second ceiling, and
the tenth failed submission moves the segment to `failed` (or `delete_failed`).
Failed work is terminal across restarts, and confirmation polling never spends
an attempt — only a real submission does. `shore segments` shows the failure;
after fixing the cause, `shore segments retry N` queues that segment again with
a fresh attempt count.

### The worker does not poll history.db

Every wake-up is a deadline. After each pass the worker asks each character for
`MIN(memory_doc_due)` over its actionable segments and sleeps until the earliest
one; a character with nothing queued reports no deadline and its `history.db` is
not reopened at all. New archive, exclusion and retry work wakes it immediately
through `noteWork`. On top of that there is one deliberate safety sweep an hour,
which exists only to catch work that arrived without a wake-up.

### In-band failures

Hindsight's MCP tools report failure **in band**: the JSON-RPC result carries
`isError: false` and the payload itself says what went wrong. Measured against a
live server, `retain` answers `{"status": "error", "message": "Invalid timestamp
format ..."}` and `get_document` answers `{"error": "Document '...' not
found"}`. `McpClient.call` only throws on `isError`, so the worker inspects every
reply and raises `HindsightToolError` on those shapes. Without that check a
rejected `retain` is indistinguishable from a successful one, and the segment is
marked stored having never been sent.

`delete_document` is the exception that matters: deleting a document that is not
there answers `{"status": "deleted", "document_deleted": 0}`, a success. A
missing-document delete is therefore terminal, not an error to retry.

### Exclusion

Exclusion is read off the same column, and which state a segment is in decides
what has to happen:

- excluded while `pending` and never submitted — the column is cleared and the
  segment is never read;
- excluded after any submission attempt, ambiguous ones included — a delete is
  queued, because the attempt may have landed;
- excluded while `submitted` — the delete waits for the operation to reach a
  terminal state before calling `delete_document`, so an extraction still in
  flight cannot recreate the document behind the delete;
- excluded while `stored` — `delete_document`, then the column is cleared;
- `shore segments exclude N` on a segment backfill imported adopts it as
  `stored` first, so the same path removes it.

Re-including a segment whose document was deleted queues a fresh retain.
Re-including one that is still `stored` or `submitted` leaves it alone: the
document is already there or on its way, and re-sending would pay for the same
extraction twice.

`memory.retain.enabled` requires `write_memory = false`: Hindsight owns the
retrieved layer instead of running the compaction LLM that rewrites memory
files. Existing `MEMORY.md` and workspace notes are not deleted and remain in
the always-present prompt, so they can still be hand-curated.

The switch is read inside `runCompactionPass`, off the **character's** effective
config, so every trigger obeys it: the idle pass, the deep-idle archive, and a
manual `shore compact`. With it off the pass archives and queues the segment for
retain without loading a compaction model at all, and answers `status: "rotated"`
rather than `"compacted"`. A `[memory.compaction]` block in a character file is
enough; the global config does not have to agree.

`contrib/hindsight/backfill.py` remains the **historical** import and repair
tool — for segments archived before live retain was switched on, and for
repairing a range by hand. It is not the recovery path for new segments; the
daemon confirms and resubmits those itself. Because `document_id` upserts, the
script carries no cursor and no resume state, so re-running a range is
idempotent.

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
