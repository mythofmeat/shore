# hindsight

[hindsight](https://github.com/vectorize-io/hindsight) as shore's memory backend.
It ships its own MCP server, so unlike the mem0 experiment there is no wrapper to
write: shore talks to it directly.

Shore calls `recall` before each turn and injects the result as a transient
prompt block. A durable background worker retains newly archived segments;
`backfill.py` imports conversations archived before that worker was enabled.

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
| `HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING` | `true` |

The embedder runs on CPU, and the database is hindsight's embedded Postgres, so
only extraction leaves the machine.

Recall's expensive step is normally the local cross-encoder, not Postgres: it
scores each fused query-memory candidate on CPU. Length-bucketed batching groups
similarly sized pairs to avoid padding waste and is quality-identical; Hindsight
documents a 36–54% speedup. If it is still too slow,
`HINDSIGHT_API_RERANKER_MAX_CANDIDATES` bounds that work, but unlike batching it
can discard a relevant candidate before reranking and should be measured with
`recall_eval.py`.

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

A bank is a character. The bank id is a **path segment** under the base URL, and
shore appends it, so one base serves every character:

```toml
# config/characters/qifei/config.toml
[memory.backend]
url = "http://mcp-hindsight:8888/mcp/"
# bank = "qifei"   # defaults to the character name

[memory.recall]
mode = "inject"
max_memories = 6
query_from = "user"
timeout = "30s"
# preamble = "Relevant private notes:"
# wrap_before = "<recalled_memories>\n"
# wrap_after = "\n</recalled_memories>"

[memory.compaction]
write_memory = false

[memory.retain]
enabled = true
user_name = "Ren"
possessive_pronoun = "his"
```

`max_tokens` defaults to 2048, which is what hindsight wants, so it does not
need to be written down. The tool names are not configurable: shore calls
`recall` and `retain` because those are the tools a Hindsight bank exposes.
`wrap_before` and `wrap_after` are empty by default and are inserted verbatim
around the complete preamble-and-memory text when configured.

The latest user message is the recall query by default, avoiding the character's
own previous reply dominating retrieval. `query_from = "recent"` restores the
older last-`recent_messages` behavior for comparison. Recall fails open after
`timeout`, so a slow or cold Hindsight server does not block the turn. Twelve
seconds is the default: it leaves headroom above normal CPU reranking latency
once bucketed batching is enabled, while remaining a firm fail-open bound.
`preamble` replaces shore's explanatory paragraph inside `<recalled_memories>`;
an empty string leaves the tagged fact list bare.

Hindsight is not an `[mcp.*]` server and must not be declared as one. Shore
opens its own connection and calls `recall` and `retain` itself, so the tools
never enter any character's tool surface and the model never decides whether to
use them.

`user_name` defaults
to `defaults.display_name`, and `possessive_pronoun` defaults to `their`; set
both explicitly to keep live documents byte-identical to the arguments used for
manual backfill. The retain timeout is only the deadline for Hindsight to accept
an asynchronous job. Extraction continues in Hindsight and does not block the
archive or user turn.

New segments are sent to Hindsight as they are archived; `backfill.py` stays the
tool for everything archived before that was switched on, and for repairing a
document that never landed. The daemon marks the segment row `pending` in the
same statement that commits it, sends one `retain` call, and marks it `stored`.
It does not follow Hindsight's extraction operation — `document_id` upserts, so
re-sending is the recovery path. Hindsight reports tool failures in the reply
body rather than as MCP errors, so the worker reads every reply for an error
payload and leaves the segment queued on one. Retries use exponential backoff
capped at 60 seconds and stop after ten attempts. The durable failed state and
last error appear in `shore segments`; once the cause is fixed, run
`shore segments retry N` to requeue that segment. A segment excluded before it
is sent is never read; excluding one already sent deletes its document.

Turning off automatic memory writes does not erase `MEMORY.md` or workspace
notes. They remain always-present, hand-curated context; Hindsight replaces the
compaction LLM's ongoing updates and supplies the retrieved layer.

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

## Measuring recall

`shore trace recall` shows live queries, latency, the injected memories, and up
to 12 scored candidates. Use `shore trace recall --json` when the raw transcript
is useful. Hindsight's scores rank candidates within a query; they are not
calibrated confidence values across queries, so do not choose a fixed floor from
a few appealing score examples.

`recall_eval.py` provides the repeatable offline check. It reads archived turns
from `history.db` without modifying them and calls Hindsight's REST recall path
without writing to the bank. `retrieval_targets` asks for the smallest specific
older fact whose absence would materially change the next reply, instead of
paraphrasing the message or assembling broad background coverage. It knows that
the visible dialogue, character/user identities, `MEMORY.md`, and workspace
state are already supplied elsewhere. `NO_RECALL` skips Hindsight when no
particular older memory is needed.

Before spending anything on retrieval, preview six target queries from an
existing collection. This calls only the rewrite model and produces a local HTML
page:

    python recall_eval.py preview-rewrites \
      --input /tmp/recall-cases.jsonl --character qifei --user-name Ren \
      --output /tmp/retrieval-target-preview.html

Once those outputs look like retrieval requests rather than summaries, reuse
the valid `user` recalls and run only the new targets through Hindsight:

    python recall_eval.py refresh-rewrites \
      --input /tmp/recall-cases.jsonl --character qifei --user-name Ren \
      --output /tmp/recall-targets.jsonl

Do not expand that collection into a giant CSV. Build a local review page:

    python recall_eval.py review \
      --input /tmp/recall-targets.jsonl --output /tmp/recall-targets-review.html

The page selects 24 cases spread across the archive and compares the top three
results from `user` and `retrieval_targets`. The sides are shuffled per case; query
text, variant names, and scores stay hidden until after the judgment. It shows
the exact recent dialogue supplied to the rewrite model, stores progress only in
browser local storage, and exports compact JSON containing no conversation or
memory text. **Neither is useful** means both result sets were unusable; inspect
the generated query before deciding whether generation or retrieval caused it.

For GLM-5.3-Flash, rewriting uses the model-supported
`reasoning_effort=max`, an 8192-token completion budget shared by reasoning and
the final answer, a 120-second offline timeout, and the provider's native
sampling defaults. Do not send the
older `thinking.type=disabled` field: GLM-5.3-Flash exposes `low`, `high`, and
`max` reasoning effort, not a non-thinking mode. Every collected case records
the model, endpoint, reasoning budget, prompt version, exact instructions, and
rewrite token usage. Clear refusals and provider safety blocks are recorded as
failed rewrites, receive no Hindsight call, and are excluded explicitly from the
comparison count. Review refuses older rewrite collections without provenance
rather than silently mixing incompatible runs.

After exporting the judgments from the page:

    python recall_eval.py report \
      --input ~/Downloads/shore-recall-comparison-REPLACE_ME.json

The report keeps rewrite time separate from Hindsight recall time and reports
rewrite token totals, so the same archive can compare the quality and operating
cost of a faster or cheaper rewrite model without confusing its latency with the
retriever's. When testing a model that does not use GLM-5.3-Flash's effort
contract, pass `--rewrite-reasoning-effort default`; this omits the reasoning
field rather than guessing at another model's controls. Keep `--limit` and
`--sample` identical so each run selects the same archived turns.

Only after choosing a query strategy, build the separate score-calibration page:

    python recall_eval.py calibrate \
      --input /tmp/recall-targets.jsonl --variant retrieval_targets \
      --output /tmp/qifei-recall-calibration.html

That page samples ten cases and asks for `useful`, `harmless`, or `distracting`
on only the top six memories. Scores remain hidden until each label is chosen.
Export its judgments and pass that JSON to `report` to see the score distribution
and threshold ladder. This keeps query selection and score-floor calibration as
two independent decisions.

The collector refuses to overwrite an existing output file. Add `recent` to
`--variants` only when it is genuinely worth collecting; it need not be included
in the human comparison. `review-csv` preserves the old expanded CSV workflow
for an existing analysis, but it is not the default review path.

## Order of operations

`memory.recall` and `memory.retain` require a current daemon. Rebuild and restart
`shore-daemon` **before** enabling either section; an older daemon rejects the
retain table and older recall builds call a `search` tool that Hindsight does
not expose.
