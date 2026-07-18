# LLM Sidecar IPC Contract

Status: implemented (2026-06-02). The LLM **wire** (provider SDK calls) lives
in a Bun **sidecar** that uses official vendor SDKs, while the Rust daemon,
prompt assembly, tool loop, memory, and SWP server stay byte-for-byte
unchanged. Zero user-visible behavior change except "OpenAI-compatible
providers stop mangling tool loops."

## The seam (why this is small)

The daemon talks to the wire through a narrow interface (`backend/daemon` →
`shore_llm`):

- `LlmClient::stream_raw(&LlmRequest) -> StreamReader` (`backend/llm/src/lib.rs:312`)
- `LlmClient::generate(&LlmRequest) -> GenerateResponse` (`lib.rs:332`)
- `LlmClient::image_generate(&ImageGenerateParams) -> ImageGenerateResponse` (`lib.rs:351`)

`stream_raw` calls `providers::stream` (`backend/llm/src/providers/mod.rs`), which
returns a `DuplexStream` carrying **newline-delimited JSON `StreamEvent` lines**.
The daemon's `StreamConsumer::consume` (`backend/llm/src/stream.rs:38`) reads those
lines and never sees raw provider SSE. **That NDJSON `StreamEvent` vocabulary is
the contract** — it already exists, is serde-stable, and is covered by the
`stream.rs` test suite.

The Rust `providers::stream`/`generate`/`image_generate` entrypoints now POST to
the sidecar and return a reader over the sidecar's response. The retired Rust
chat/image adapters (`anthropic.rs`, OpenAI chat/image, `gemini.rs`, `zai.rs`,
and their stream helpers) have been removed; embeddings remain in Rust because
they are still a small OpenAI-compatible HTTP call.

## Transport

**Unix domain socket, HTTP/1.1, one request per call.** Recommended over stdio:

- The daemon already models "read NDJSON lines from an async reader"; an HTTP
  response body over a UDS drops straight into `stream_raw`'s existing
  `BufReader` return shape.
- UDS is loopback-only by construction (satisfies the "non-loopback access must
  be explicit" rule — there is no port, no network surface). Socket file lives
  under the daemon runtime dir, mode `0600`.
- Concurrency for free: compaction, dreaming, heartbeat, and chat run
  concurrent LLM calls; separate HTTP requests need no custom multiplexing.
- Cancellation for free: Rust `AbortSignal`/drop → close connection → Bun
  `request.signal` aborts → forward to the SDK's abort.
- Clean error mapping via HTTP status (below).

Socket path passed to the sidecar via `--socket <path>` (or `SHORE_LLM_SOCKET`).

**Keeping long, quiet turns alive.** `Bun.serve` closes a connection after a
period of inactivity, and the idle timer runs *while a response streams*. A
max-effort reasoning turn (or a long `generate` for compaction/dreaming) can go
quiet for minutes — the model thinks while the provider emits only `ping`s,
which are not forwarded as content `StreamEvent`s — so an idle close would cut
the connection mid-flight (daemon sees "unexpected EOF during chunk size line" →
`LlmError::IncompleteStream`).

Two mechanisms guard against this:

- **Streaming (`/v1/stream`): `ping` keepalives.** The pump races each provider
  event against a heartbeat timer (`HEARTBEAT_MS`); when the provider is quiet it
  writes a `{"type":"ping"}` event so bytes keep flowing and the socket never
  goes idle. This is unbounded — it covers arbitrarily long thinking. NOTE: the
  per-request `server.timeout(req, 0)` is a **no-op for a streaming
  `ReadableStream` body** in Bun 1.3.x (the idle timer fires at 10s regardless),
  which is why the keepalive — not a timeout override — is load bearing here.
- **Non-streaming (`/v1/generate`, `/v1/image`): per-request `server.timeout`.**
  These handlers await a single JSON response, and there
  `server.timeout(req, 0)` *does* disable the idle timeout for the wait (verified
  on Bun 1.3.x), covering the idle stretch while the provider works.

`/healthz` is unaffected (no timeout override, no body to keep alive).

The Rust daemon sidecar transport is the default chat/generate/image path:

```toml
[advanced.llm_sidecar]
enabled = true
# optional; default is <runtime_dir>/llm.sock
socket_path = "/run/user/1000/shore/llm.sock"
```

The `enabled` switch remains for config compatibility and emergency diagnostics,
but the legacy Rust chat/image provider implementations have been removed; with
`enabled = false`, chat/generate/image calls return a configuration error.

### Endpoints

| Method | Path           | Request body        | Response                            |
|--------|----------------|---------------------|-------------------------------------|
| POST   | `/v1/stream`   | `SidecarRequest`    | `application/x-ndjson` StreamEvents |
| POST   | `/v1/generate` | `SidecarRequest`    | `application/json` GenerateResponse |
| POST   | `/v1/image`    | `ImageRequest`      | `application/json` ImageResponse    |
| GET    | `/healthz`     | —                   | `200 ok` (startup/supervision)      |

## Request frame — `SidecarRequest`

The serialized `LlmRequest` (`backend/llm/src/types.rs`), already serde-derived,
**minus** the `#[serde(skip)]` transient fields (`api_key_name`, `rid`,
`forensic_character`, `retain_long`) which stay Rust-side. Fields the sidecar
consumes:

```jsonc
{
  "sdk": "anthropic" | "openrouter" | "openai" | "zai" | "gemini",   // dialect → which SDK
  "model": "anthropic/claude-opus-4.8",
  "api_key": "...",                 // bearer; sidecar applies x-api-key vs Authorization
  "base_url": "https://openrouter.ai/api/v1",  // optional override
  "messages": [ /* provider-native blocks, ALREADY ASSEMBLED by Rust */ ],
  "system":   [ /* system blocks */ ],          // optional
  "tools":    [ /* tool defs */ ],              // optional
  "max_tokens": 8192,
  "temperature": 1.0,               // optional
  "top_p": 0.95,                    // optional
  "provider_options": { "cache_ttl": "5m", "thinking": {...} },  // optional
  "provider_key": "deepseek"        // optional; provider-specific behavior
}
```

Notes:
- `messages`/`system`/`tools` arrive **fully assembled** (Anthropic-canonical
  block shape — the daemon's `engine/prompt.rs` already produced them). The
  sidecar's per-SDK adapter converts canonical → that SDK's wire shape.
- `api_key` crosses the boundary. UDS `0600` keeps it host-local; acceptable,
  documented. Never logged by the sidecar.
- **Thinking replay is decided by the daemon, transmitted faithfully by the
  adapters.** The daemon's `replay_prior_thinking` strip
  (`maybe_strip_prior_thinking`) controls which assistant turns still carry
  thinking blocks when a request arrives; the OpenAI-compatible adapter emits
  whatever survives as `reasoning_content` (Kimi K2.5+/K3
  preserved-thinking-history mode requires this; backends that treat the field
  as output-only surface an API error rather than a silent drop). The old
  deepseek/kimi tool-loop bug (see `project_deepseek_reasoning_replay_bug`) was
  the retired Rust `openai.rs` replaying reasoning in the wrong shape
  unconditionally — the fix is the faithful, daemon-gated mapping, not a
  blanket ban.

## Stream response — `StreamEvent` NDJSON (the existing vocabulary)

One JSON object per line. Tag field is `type`, snake_case. Defined at
`backend/llm/src/types.rs:155`, consumed at `stream.rs:81`.

```jsonc
{"type":"start","model":"<model>"}                         // exactly once, first
{"type":"text","text":"<delta>"}                           // incremental
{"type":"thinking","text":"<delta>"}                       // incremental
{"type":"thinking_signature","signature":"<opaque>"}       // see ordering
{"type":"redacted_thinking","data":"<opaque>"}             // complete block
{"type":"tool_use","id":"<id>","name":"<name>","input":{}} // CONSOLIDATED (full input)
{"type":"ping"}                                            // keepalive, any time, ignored
{"type":"done",
 "content":"<final text string>",
 "finish_reason":"end_turn|tool_use|max_tokens|stop_sequence|refusal",
 "usage":{"input_tokens":N,"output_tokens":N,
          "cache_read_tokens":N,"cache_creation_tokens":N,
          "total_cost_usd":0.0},                            // cost optional
 "timing":{"total_ms":N,"time_to_first_token_ms":N}}        // exactly once, last
```

### Ordering rules (load-bearing — `StreamConsumer` relies on them)

1. `start` first, once.
2. `text`/`thinking`/`tool_use` interleave in true arrival order. The consumer
   flushes a pending text/thinking buffer into a content block whenever the
   block type changes, so order = persisted block order.
3. `thinking_signature` MUST follow its `thinking` deltas and precede the next
   non-thinking event — the consumer attaches it to the thinking block on flush
   (`stream.rs:130`, `flush_thinking`). An orphan signature (no preceding
   thinking) is discarded.
4. `tool_use` is **one consolidated event with the full parsed `input`** — NOT
   start/delta/done. The consumer pushes a complete `ToolUse` block and a
   `ToolUseEvent` for the tool loop (`stream.rs:143`).
5. `done` last, once. `content` is the final assembled **text string** (not a
   blocks array); the structured blocks are accumulated by the consumer from the
   granular events above. EOF before `done` → `LlmError::IncompleteStream`.
6. `ping` is a payload-free keepalive that may appear any number of times after
   `start` and before `done`/`error`. It carries no content and the consumer
   ignores it; its only effect is keeping the socket from going idle.

## Non-streaming response — `GenerateResponse`

`/v1/generate` returns one JSON (`types.rs` `GenerateResponse`):

```jsonc
{ "content":"<text>", "content_blocks":[...], "finish_reason":"...",
  "usage":{...}, "timing":{...}, "model":"..." }
```

Same `usage`/`timing` shapes as streaming. `content_blocks` is the full
structured sequence (text/thinking/tool_use) — the sidecar builds it from the
single completion.

## Error model (matches current behavior — no daemon change)

- **Pre-stream failure** (bad request, upstream 4xx/5xx before any event): sidecar
  returns non-2xx with body → Rust maps to `LlmError::HttpStatus{status, body}`.
- **Connection failure**: → `LlmError::Request`.
- **Mid-stream upstream failure** (after `start`): sidecar closes the connection
  without `done` → Rust `StreamConsumer` returns `LlmError::IncompleteStream`.
  This matches today exactly: `StreamEvent` has **no** error variant, so we do
  NOT add one (that would touch the daemon). Granularity is unchanged from
  status quo.
- **Refusal**: NOT a wire concern. `LlmError::Refusal` is never produced by the
  providers — it's a *post-response* decision in the Rust retry layer:
  `is_refusal(content, finish_reason)` (`retry.rs:156`) checks
  `finish_reason == "content_filter" | "refusal"` or refusal phrases in
  <500-char content, and `should_retry_refusal` acts on the completed
  `StreamResult`. The sidecar just passes `finish_reason` through faithfully.
  Zero sidecar work, zero daemon change.

## SDK coverage (`Sdk` enum: Anthropic, Openrouter, Openai, Zai, Gemini)

| `sdk`     | Sidecar adapter            | Status        |
|-----------|----------------------------|---------------|
| anthropic | `@anthropic-ai/sdk`        | `providers/anthropic.ts` — native, incl. Claude-via-OpenRouter (cache/thinking control) |
| openrouter | `@openrouter/sdk`         | `providers/openrouter.ts` — **the normalized path for all non-Anthropic providers** (deepseek/kimi/glm/minimax/gpt). One typed `reasoningDetails` round-trip; no per-vendor reasoning matrix. |
| openai    | `openai`                   | `providers/openai.ts` — DIRECT native OpenAI / OpenAI-compatible (when NOT going via OpenRouter) |
| gemini    | `@google/genai`            | `providers/gemini.ts` — distinct wire (below) |
| zai       | `openai` + Z.ai thinking body | `providers/zai.ts` — DIRECT Z.ai, incl. coding-subscription base URLs OpenRouter can't bill against (below) |

The daemon's per-provider config picks the dialect: an `openrouter` provider sends
`sdk:"openrouter"`; a direct OpenAI provider sends `sdk:"openai"`; a Z.ai
subscription provider sends `sdk:"zai"`. (Rust `Sdk` enum must gain the
`Openrouter` variant + provider mapping — daemon-side, part of the wiring PR.)

**Gemini** (`generativelanguage.googleapis.com/v1beta/models/{m}:streamGenerateContent?alt=sse`):
distinct wire — system prompt goes in `systemInstruction` (not a message), tools
are `functionDeclarations`, thinking is `thinkingConfig{thinkingBudget|thinkingLevel}`
(3.x maps `reasoning_effort` strings → `thinkingLevel`). Build on `@google/genai`,
which models all three first-class.

**Z.ai** — speaks OpenAI chat-completions for messages/tools, but is NOT a plain
base_url swap (`src/llm/providers/zai.ts`):
- dual base URLs — `api.z.ai/api/paas/v4` vs `…/coding/paas/v4`, toggled by the
  `zai_subscription` provider option;
- custom thinking control in the request body:
  `"thinking":{"type":"enabled","clear_thinking":<bool>}` (the
  `zai_clear_thinking` option) — NOT OpenAI's `reasoning_effort`;
- a `reasoning_content` field.
Use the official Z.ai JS SDK if a maintained one exists; otherwise the `openai`
SDK pointed at the Z.ai base_url with the thinking/clear_thinking fields injected
via the SDK's extra-body passthrough. Either way it's a dedicated adapter.
(Unlike the OpenAI adapter, which replays surviving thinking-block *text* as
`reasoning_content`, Z.ai replays only the verbatim `zair:` carrier bytes, and
only under Preserved Thinking — `clear_thinking: false` with thinking enabled;
otherwise nothing is replayed.)

## TS adapter gap (what must change to emit the contract)

The current adapters emit a different in-house `ChatEvent` union
(`src/llm/types.ts`): `text_delta`, `thinking_delta`, `tool_use_start`,
`tool_use_input_delta`, `tool_use_done`, `done{content: ContentBlock[]}`. To emit
the `StreamEvent` NDJSON above:

1. Emit `start{model}` on stream open.
2. `text_delta` → `text`; `thinking_delta` → `thinking` (rename only).
3. **Add `thinking_signature`** from Anthropic `signature_delta` — REQUIRED for
   thinking replay + cache correctness. (Currently not surfaced.)
4. **Add `redacted_thinking`** from Anthropic redacted blocks.
5. Collapse `tool_use_start`+`input_delta`+`done` into one `tool_use{id,name,input}`
   (parse accumulated `argsJson`). The adapter already accumulates this.
6. `done`: emit `content` as the final **string**, `finish_reason` (map
   `stopReason`), `usage` in snake_case (+ `total_cost_usd` passthrough from
   OpenRouter `cost`), and `timing{total_ms, time_to_first_token_ms}` (sidecar
   measures: ttft = first post-`start` event; total = at `done`).

## Stays Rust-side (explicitly NOT moved)

`preprocess_request`, credential resolution (`credentials.rs`), cache-forensics +
`debug_log` payload logging (operate on `LlmRequest` pre-send), model
`discovery`/catalog, connection-level retry wrapper, and the **tool loop**
(`engine/tools.rs`). The sidecar is a stateless per-call function:
`SidecarRequest in → StreamEvent NDJSON out`.

## Supervision / packaging

- `bun build … --banner='#!/usr/bin/env bun'` emits
  `backend/llm-sidecar/dist/shore-llm-sidecar` as an executable Bun-script bundle
  (a single minified script with a shebang, ~1.4MB) — not a `--compile` binary.
  Packagers should treat it as an executable Bun script and depend on `bun`.
- By default, `shore-daemon` configures `shore-llm` to use the configured socket
  path, defaulting to `<runtime_dir>/llm.sock`.
- The daemon starts a sidecar supervisor when `shore-llm-sidecar` is found on
  `PATH` or next to the running daemon. It spawns
  `shore-llm-sidecar --socket <path>`, creates the socket directory, polls
  `GET /healthz`, restarts with backoff on spawn/health/exit failures, and
  SIGTERMs the child on daemon shutdown.
- If the binary is absent, the daemon logs a warning and continues; this keeps
  manually managed development sidecars possible at the configured socket path.
- The Arch `shore-daemon` PKGBUILD installs both binaries.
- The Debian/Pi helper at `contrib/debian/build-shore-daemon-deb.sh` builds a
  `.deb` that installs both `shore-daemon` and `shore-llm-sidecar`.

## Retry (resolved — stays Rust-side, unchanged)

`RetryPolicy{max_retries:2}` with exponential backoff lives *above* the wire
(`retry.rs`): retries on `IncompleteStream`, HTTP 5xx, and 429; never on other
4xx; falls back to the configured fallback model on exhaustion. This is unchanged.
**The sidecar must DISABLE the official SDKs' built-in retry (`maxRetries: 0`)** so
we don't double-retry and the existing Rust semantics stay identical; the sidecar
surfaces upstream status as HTTP status so `should_retry_error` keys off the
mapped `LlmError::HttpStatus{status,…}`.

## Image generation (resolved)

`POST /v1/image`. `image_generate` dispatches to the OpenAI images API for ALL
providers (`providers/mod.rs:157` → `openai::image_generate`), so this is one
thin `openai` SDK `images.generate` call regardless of `provider_key`. The
existing `src/llm/images.ts` likely already covers it.

Request (`ImageGenerateParams`): `{provider_key, model, api_key, base_url,
prompt, size?, quality?, aspect_ratio?, image_size?}`.
Response (`ImageGenerateResponse`): `{url, revised_prompt, timing:{total_ms}}`.

## Open items before cutover

All design open-items and build tasks are resolved: Z.ai runs on `openai` +
extra_body, the **Gemini** adapter is built on `@google/genai`, and `anthropic.ts`
emits `thinking_signature` + `redacted_thinking`. No remaining build tasks.
```
