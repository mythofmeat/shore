# hindsight

[hindsight](https://github.com/vectorize-io/hindsight) as shore's memory backend.
It ships its own MCP server, so unlike the mem0 experiment there is no wrapper to
write: shore talks to it directly.

Shore calls `recall` before each turn and injects the result as a transient
prompt block. `backfill.py` imports archived conversations. There is no live
ingest yet — new conversations reach memory only when backfill is re-run.

## How it wants to be fed

hindsight is document-shaped, not message-shaped. One archived segment becomes
one document of `Name (timestamp): text` lines, and hindsight chunks it itself.
Feeding it small batches of messages is the mem0 mistake: an exchange split
across a chunk boundary loses the setup for its own punchline.

`document_id` upserts, so a rerun replaces a document and its memories rather
than duplicating them. That is why this importer has no cursor, no boundary and
no resume state — re-running the range is the recovery path.

`context` is the highest-leverage field. It is injected into the extraction
prompt, and it is where the character's relationship to the user is described so
that teasing is not recorded as biography.

Raw memories are *expected* to overlap; observations are the deduplicated layer,
reconciled by cosine similarity. Judge quality with `types=["observation"]`, not
by counting raw rows.

## Configuration

| variable | value |
| --- | --- |
| `HINDSIGHT_API_LLM_PROVIDER` | `zai` |
| `HINDSIGHT_API_LLM_BASE_URL` | `https://api.z.ai/api/coding/paas/v4` |
| `HINDSIGHT_API_LLM_MODEL` | `glm-5.3-flash` |
| `HINDSIGHT_API_LLM_API_KEY` | the ZAI key |
| `HINDSIGHT_API_EMBEDDINGS_PROVIDER` | `local` |
| `HINDSIGHT_API_LLM_TIMEOUT` | `900` |

The embedder runs on CPU, and the database is hindsight's embedded Postgres, so
only extraction leaves the machine.

`HINDSIGHT_API_LLM_TIMEOUT` **must** be raised from its 120s default. ZAI takes
150-400s for a segment; at the default every retain fails with a connection
timeout and stores nothing.

hindsight reads its key only from `HINDSIGHT_API_LLM_API_KEY` and offers no
indirection, and compose does not interpolate `${...}` from `env_file`. So the
key is set as a second line in `config/.env`:

    ZAI_API_KEY=...
    HINDSIGHT_API_LLM_API_KEY=...

Both must be rotated together.

## Banks

A bank is a character. The bank id is in the **URL**, not in a tool argument, so
each character points at its own endpoint from its own config overlay:

```toml
# config/characters/qifei/config.toml
[mcp.hindsight]
url = "http://mcp-hindsight:8888/mcp/qifei/"

[memory.recall]
mode = "inject"
server = "hindsight"
max_memories = 6
query_from = "user"
timeout = "3s"
```

`memory.recall.tool` defaults to `recall` and `max_tokens` to 2048, which is
what hindsight wants, so neither needs to be written down.

The latest user message is the recall query by default, avoiding the character's
own previous reply dominating retrieval. `query_from = "recent"` restores the
older last-`recent_messages` behavior for comparison. Recall fails open after
`timeout`, so a slow or cold Hindsight server does not block the turn.

Do **not** grant `mcp__hindsight__*` to any character. The daemon calls `recall`
itself; granting it would hand the decision back to the model.

The control plane at `:9999` browses memories, entities and the relation graph.

## Backfilling

Run one segment first and read what it produced:

    python backfill.py --history data/shore-data/history.db \
      --character qifei --user Ren --pronoun his --limit 1

`--dry-run` lists the work without calling the model. `--since YYYY-MM-DD` stops
at a date. Widen `--limit` once single-segment runs look right.

Segments already imported are skipped by default, so an interrupted import
resumes rather than starting over and `--limit` counts what is left to do rather
than what was considered. `--redo` re-imports them anyway, which is what to use
after changing the context wording, since `document_id` upserts and the old
memories are replaced.

Every run prints the text of each memory it created. `--quiet` reduces that to
counts.

Turn auto-consolidation **off** for a bulk import. It runs after every retain,
competes with the next document's extraction for the same LLM, and gets slower as
the bank fills -- measured at 55s for the first batch of 8 memories and 100s for
the second, against a 176s extraction running beside it. Set

    HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false

for the duration, then consolidate once at the end:

    curl -XPOST http://127.0.0.1:8888/v1/default/banks/qifei/consolidate -d '{}' \
      -H 'Content-Type: application/json'

and remove the variable afterwards, so day-to-day retains consolidate as they
land. Leaving it off permanently means observations -- the deduplicated layer
recall should be reading -- never get built.

## Order of operations

`memory.recall` is only understood by a daemon built after the recall layer was
made tool-name-configurable. Rebuild and restart `shore-daemon` **before**
enabling `[memory.recall]`; an older daemon calls a `search` tool that hindsight
does not expose, and recall fails open on every turn.
