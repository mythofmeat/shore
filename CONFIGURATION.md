# Configuration

Shore loads `config.toml` from `$XDG_CONFIG_HOME/shore/` unless `--config` is provided. The config loader also supports includes and `conf.d/` overlays; see `examples/config.toml` for a complete commented file.

## Environment

Common variables:

| Variable | Purpose |
| --- | --- |
| `SHORE_CONFIG_DIR` | override config directory |
| `SHORE_DATA_DIR` | override data directory |
| `SHORE_RUNTIME_DIR` | override runtime directory |
| `SHORE_CACHE_DIR` | override cache directory |
| `SHORE_ADDR` | daemon address override |
| `SHORE_CHARACTER` | default CLI character |
| `ANTHROPIC_API_KEY` | Anthropic provider key |
| `OPENROUTER_API_KEY` | OpenRouter provider key |
| `OPENCODE_API_KEY` | OpenCode Go subscription key |
| `TAVILY_API_KEY` | web search key |

A `.env` file in the config directory is loaded on startup.

## Client Connection

The `shore` CLI resolves the SWP daemon address in this order:

1. `--addr` or `SHORE_ADDR`
2. `$XDG_CONFIG_HOME/shore/client.toml`
3. the local `$XDG_RUNTIME_DIR/shore/instances.json` daemon registry
4. the default `127.0.0.1:7320`

Use `client.toml` when clients run on a different machine from the daemon:

```toml
default_address = "100.64.0.10:7320"
```

The packaged `shore-notify.service` also reads the optional
`$XDG_CONFIG_HOME/shore/notify.env` environment file. For a remote notifier,
set `SHORE_ADDR=100.64.0.10:7320` there or use `client.toml`.

## Hot Reload

The daemon watches supported config inputs and reloads runtime config after
changes settle briefly. This is always enabled.

Reloaded without restart:

- `config.toml`, explicit `include = [...]` TOML files, and `conf.d/*.toml`
- `.env`
- `characters/<Character>/config.toml`
- character discovery when character directories or legacy `character.md` files change

Hot reload updates model catalogs, defaults, behavior/tool settings, memory
settings, usage budgets, autonomy config, and merged per-character config for
future work. It keeps the previous runtime config if the changed files fail to
parse or validate.

Startup-owned settings still require a daemon restart, including `[daemon]`
listener settings, `[connections.matrix]`, `[notifications]`, and
startup-only `[advanced]` diagnostics toggles. Shore logs these as
restart-required when it sees them change.

The watcher deliberately ignores `characters/<Character>/workspace/**`,
including prompt files and `workspace/memory/**`. Those files keep the normal
compaction/reload activation boundary described below.

## Minimal Config

```toml
[defaults]
model = "anthropic:claude-sonnet-4-6"   # provider:model_id
display_name = "Ren"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[providers.anthropic.defaults]
cache_ttl = "1h"
```

## `[daemon]`

```toml
[daemon]
addr = "127.0.0.1:7320"
unsafe_allow_remote_access = false
allowed_hosts = []
```

Non-loopback binds require `unsafe_allow_remote_access = true`. `allowed_hosts` is only a source-IP filter, not auth or TLS.

## `[defaults]`

```toml
[defaults]
model = "anthropic:claude-sonnet-4-6"   # initial chat model when a character has none selected
embedding = "openai:text-embedding-3-large"
image_generation = "openai:dall-e-3"
display_name = "Ren"
stream = true

# Optional: pin background tasks (heartbeat/compaction/dreaming) to a
# specific model. When this section is omitted, background tasks follow
# whichever model the character is currently using for chat.
[defaults.background]
model = "anthropic:claude-haiku-4-5"   # blanket model for every background task
# heartbeat = "openrouter:..."         # per-task overrides (optional)
# compaction = "anthropic:claude-sonnet-4-6"
# dreaming = "anthropic:claude-sonnet-4-6"
```

Chat/tool selectors are `provider:model_id` references resolved through the
`[providers.*]` registry. `embedding` and `image_generation` use the same
`provider:model_id` identity (see [Embedding](#embedding) and
[Image generation](#image-generation)). A legacy `[chat.*]` alias (deprecated)
also still resolves by its short or qualified name this release. The
`[tools.*]` model catalog has been **removed** — `[tools]` is now the
tool-surface config section (see [`[tools]`](#tools)).

Important slots:

- `model` — chat default, as `provider:model_id`. Optional: if unset, chat starts on the first model in the catalog (now empty unless a deprecated `[chat.*]` entry is present), so set this. Also acts as a late-stage fallback for background tasks (see below).
- `[defaults.background]` — heartbeat, compaction, and dreaming selectors. Each task chains `background.<task> → background.model → active chat model → defaults.model → first chat model`. When no background-specific model is configured, background work tracks the character's current chat selection, so `shore model <name>` moves heartbeat/compaction/dreaming alongside chat. Set `background.model` (or a per-task key) to pin background to a different model regardless of chat selection.
  - **Inspect:** `shore model --background` prints which model each task resolves to and where the selection comes from (per-task pin, blanket pin, or inherited chat model).
  - **Tune:** `shore model setting --background <all|heartbeat|compaction|dreaming> [key [value]]` reads or sets the per-model sampler settings of the model backing that task — without switching chat to it. Settings are keyed by `provider:model_id`, so tuning a background model also affects chat if chat uses the same model. `--background all` errors if the tasks resolve to different models. `--reset` and `--global` work as with the plain `shore model setting`.
- `embedding` — optional hybrid retrieval model, as `provider:model_id` (e.g. `openai:text-embedding-3-small`)
- `image_generation` — image generation model, as `provider:model_id`

> **Deprecated:** the older top-level `defaults.heartbeat` and `defaults.dreaming` keys still parse but emit a deprecation warning and are forwarded into `[defaults.background]` at load time. Move them under `[defaults.background]` to silence the warning.

## Model Sections

Models are identified by `provider:model_id`. Declare the provider's transport
once under `[providers.<name>]`, set provider-wide behavioral defaults under
`[providers.<name>.defaults]`, and override individual models under
`[models."<provider>:<model_id>"]`. There is no separate model-catalog table to
maintain — any `model_id` the provider serves is referenceable as
`provider:model_id`.

```toml
# Built-in provider: hardcoded transport defaults, so only the key is needed.
[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[providers.anthropic.defaults]
cache_ttl = "1h"
max_output_tokens = 4096

# Custom OpenAI-compatible provider: transport on the entry.
[providers.openrouter]
sdk = "openai"
api_key_env = "OPENROUTER_API_KEY"
base_url = "https://openrouter.ai/api/v1"

# Per-model override, keyed by the canonical provider:model_id.
[models."openrouter:anthropic/claude-haiku-4-5"]
max_output_tokens = 8192
```

> **Deprecated:** the inline `[chat.<provider>.<model>]` catalog still loads
> this release but emits a deprecation warning on parse. Migrate each entry to
> a `[providers.*]` provider plus a `provider:model_id` reference (move
> behavioral fields to `[providers.*.defaults]` or
> `[models."<provider>:<model_id>"]`). Disabling a provider blocks the
> `provider:model_id` and bare-upstream-id forms (including for any legacy
> `[chat.*]` entry under it); a legacy static alias's short/qualified-name
> lookup still resolves this release.
>
> **Removed:** the `[tools.<provider>.<model>]` tool-model catalog no longer
> exists; `[tools]` is now the tool-surface config section. Define tool-loop
> models the same way as chat models (`provider:model_id`).

### OpenCode Go (subscription)

`opencode-go` is a built-in provider for [OpenCode Go](https://opencode.ai/docs/go/),
a flat-rate ($10/mo) gateway over open coding models. Like OpenRouter it fronts
many models behind one key, but it spans **two wire dialects**: most models speak
the OpenAI `/chat/completions` format (DeepSeek, Kimi, GLM, MiMo, …) while MiniMax
and Qwen speak the Anthropic `/messages` format. Discovery auto-maps each
discovered model to the right `sdk` (`qwen*`/`minimax*` → `anthropic`, everything
else → `openai`), so a single enabled provider just works:

```toml
[providers.opencode-go]
# Transport defaults are built in: base_url = https://opencode.ai/zen/go/v1,
# api_key_env = OPENCODE_API_KEY. Leave `sdk` unset so the per-model auto-map
# wins; set it only to force every model onto one dialect.
[providers.opencode-go.discovery]
enabled = true
```

Then run `shore provider refresh opencode-go` and reference any served model as
`opencode-go:<model_id>` (e.g. `opencode-go:kimi-k2.6`,
`opencode-go:minimax-m2.7`).

Because billing is a flat subscription, opencode-go calls are **excluded from
usage budgets and spend reports**: each call is still recorded (tokens, timing,
transcripts) but with `total_cost = 0` and `cost_source = "subscription"`, and
no [usage budget](#usage) can throttle one. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the cost-accounting invariant.

### Embedding

Embedding and image generation share the chat model shape: identity is a
bare `provider:model_id`, transport (`sdk`/`base_url`/`api_key_env`/`keys`)
comes from `[providers.<provider>]`, and an **optional** settings table
keyed by the same `provider:model_id` carries category knobs only. There is
no `[embedding.<alias>]` profile table — select the model with
`defaults.embedding`.

Shore only ships an OpenAI-compatible embedder; any endpoint that speaks
`/v1/embeddings` works (OpenAI, Together, Voyage's compat endpoint,
OpenRouter, or a self-hosted server like text-embedding-inference or
llama.cpp's HTTP server).

```toml
[defaults]
embedding = "openai:text-embedding-3-large"

# Transport + credentials (multi-key fallback supported via [[keys]]).
[providers.openai]
api_key_env = "OPENAI_API_KEY"

# Optional: per-model category settings (only `dimensions`).
# When omitted, Shore sends no `dimensions` on the wire and the provider
# returns the model's native width (e.g. 3072 for text-embedding-3-large).
# Set it only to request dimension-reduced vectors from models that support it.
[embedding."openai:text-embedding-3-large"]
dimensions = 1024
```

```toml
# Self-hosted (e.g. text-embedding-inference) — register it as a provider.
# `api_key_env` still has to point at a set variable; if your server doesn't
# validate keys, set it to any non-empty value.
[defaults]
embedding = "local-tei:BAAI/bge-large-en-v1.5"

[providers.local-tei]
base_url = "http://127.0.0.1:8080/v1"
api_key_env = "TEI_API_KEY"

[embedding."local-tei:BAAI/bge-large-en-v1.5"]
dimensions = 1024
```

When no embedding model is configured (and `defaults.embedding` doesn't
reference one), the workspace `search` tool's `hybrid` and `vector` modes
degrade to lexical-only at the call site. Configure an embedding model to
enable semantic search.

### Image generation

Same shape — identity `provider:model_id`, transport on `[providers.*]`,
optional settings table with `size`, `quality` (OpenAI), `aspect_ratio`,
and `image_size` (OpenRouter).

```toml
[defaults]
image_generation = "openai:dall-e-3"

[providers.openai]
api_key_env = "OPENAI_API_KEY"

[image_generation."openai:dall-e-3"]
size = "1024x1024"
quality = "hd"
```

> **Migration:** the older flat `[embedding.<alias>]` /
> `[image_generation.<alias>]` tables (with inline `model_id`/`provider`/
> `api_key_env`/`base_url`) were removed. Move identity into the
> `provider:model_id` key, transport onto `[providers.<provider>]`, and keep
> only category settings in the table. A leftover flat block now fails config
> load with a migration error.

## Providers

Provider entries are the single home for transport (`sdk` / `base_url` /
credentials) and unlock runtime model discovery. Every model is referenced as
`provider:model_id` against a registered, enabled provider. A deprecated
`[chat.<provider>.<alias>]` entry still resolves by its short/qualified name
this release — even under a disabled provider. Disabling a provider only blocks
the `provider:model_id` and bare-upstream-id forms (so a disabled provider's
models, including any legacy `[chat.*]` entry, are unreferenceable by those
forms).

### Single-key form (compact)

```toml
[providers.openai]
api_key_env = "OPENAI_API_KEY"
```

The compact `api_key_env` is folded into a synthetic key named
`default`. Combining it with explicit `[[keys]]` is rejected; pick one
form per provider.

### Multiple keys: budget/overflow rotation

```toml
[providers.openrouter]
sdk = "openai"
base_url = "https://openrouter.ai/api/v1"

[[providers.openrouter.keys]]
name = "budget"
env = "OPENROUTER_API_KEY_BUDGET"
warn_on_fallback = true

[[providers.openrouter.keys]]
name = "overflow"
env = "OPENROUTER_API_KEY_OVERFLOW"
```

Keys are tried in configured order on every request, including streaming chat
turns and non-streaming background work such as heartbeat, compaction,
dreaming, and cache keepalive. When an interactive chat request falls back away
from a key marked `warn_on_fallback = true` (e.g. an exhausted budget cap), a
one-line client warning surfaces; background rotations are recorded in logs, and
autonomy/keepalive rotations are also visible in heartbeat status. The fallback
is non-sticky: the next request retries from the top of the list.
Friendly key names are usage metadata only; Shore never sends them to providers
or logs key values. `shore usage --by-api-key` groups ledger spend by these
names, and `shore usage --api-key overflow` filters to one key.

### Provider-wide defaults

Provider-level behavioral and vendor knobs live under `[providers.<name>.defaults]`:

```toml
[providers.or-anthropic]
sdk = "anthropic"
api_key_env = "OR_KEY"

[providers.or-anthropic.defaults]
max_output_tokens = 8192
openrouter_provider = { order = ["Anthropic"] }
```

This is the same field set as the per-model overlay (`[models."provider:model_id"]`
in `preferences/`), applied provider-wide as the lowest user-config tier. It carries
behavioral defaults (`max_output_tokens`, `cache_ttl`, sampler knobs) and vendor knobs
(`openrouter_provider`, `vertex_*`, `gemini_*`, `zai_*`) onto every model the provider
resolves — discovered, trusted (`provider:model_id`), or a legacy static entry.
Transport (`sdk`/`base_url`/`api_key_env`/`keys`) belongs on the provider entry
itself and is rejected inside `[.defaults]`.

> Provider-level scalars under `[chat.<provider>]` were retired — move behavioral
> defaults to `[providers.<provider>.defaults]` and transport to
> `[providers.<provider>]`. The whole `[chat.<provider>.<alias>]` /
> `[tools.<provider>.<alias>]` catalog is now deprecated too (honored this
> release, warns on load); migrate each model to a `provider:model_id` reference.

### Discovery and filtering

```toml
[providers.openrouter.discovery]
enabled = true
# gitignore-style; last match wins. `*` opt-out, `!pattern` opt-in.
ignore = [
  "*",
  "!anthropic/*",
  "!openai/*",
  "!google/gemini-*",
]
```

Discovered models populate the cache at
`$XDG_CACHE_HOME/shore/providers/<name>/models.json`. The daemon
auto-refreshes any discovery-enabled provider whose cache is missing or
older than 24h, both at startup and on a 24h cadence while running. Run
`shore provider refresh <name>` (or `shore provider refresh` to fan out
across every discovery-enabled provider) to force a refetch out of band.
Providers with `sdk = "anthropic"` use Anthropic's native `GET /v1/models`
API. Other providers use the OpenAI-compatible `GET <base_url>/models`
shape. Well-known provider keys with default base URLs, including
`anthropic`, `openai`, and `openrouter`, can omit `base_url`; custom
providers need it.
Hidden models stay in the cache but are filtered out of `shore model` and
`shore provider models <name>` until `--all` (CLI) or `:model all` (TUI)
is used. A legacy `[chat.<provider>.<alias>]` entry is never filtered —
it is intentional.

### Effective catalog and merge order

At runtime the daemon resolves models against an effective catalog
that merges these sources (a disabled provider contributes nothing):

1. Deprecated static `[chat.<provider>.<alias>]` entries (this file), honored this release.
2. Discovered `[providers.<name>]` cache rows.
3. Trusted `provider:model_id` refs (routed via `[providers.<name>]` transport).
4. `[providers.<name>.defaults]` provider-wide behavioral/vendor defaults.
5. Hardcoded provider defaults for well-known providers.

Conflict rules:

- Static aliases always win when matched by short name (`sonnet`) or
  qualified name (`chat.openrouter.sonnet`).
- When a static entry shares `(provider, model_id)` with a discovered
  row, the static entry wins for explicit fields and the discovered
  row is hidden from listings (no duplicate row).
- Discovered models can be selected at runtime via the bare upstream
  id (`anthropic/claude-sonnet-4.5`) or the disambiguated form
  (`openrouter:anthropic/claude-sonnet-4.5`). `[defaults].model` accepts a
  `provider:model_id` reference directly — no static alias needed — and
  resolves on any enabled provider even with discovery off (the model_id is
  trusted as-given). A disabled provider's `provider:model_id` does not
  resolve.

## Sampler Preferences

`shore model setting <key> <value>` and `:setting <key> <value>` write
saved sampler overrides keyed by `(provider, model_id)`. Storage:

```text
$XDG_DATA_HOME/shore/preferences/global.toml
$XDG_DATA_HOME/shore/characters/<Character>/preferences/models.toml
```

Merge order (lowest to highest precedence):

1. Hardcoded provider defaults.
2. Discovered model metadata.
3. `[providers.<provider>.defaults]` provider-wide defaults.
4. Deprecated static `[chat.<provider>.<alias>]` overrides (honored this release).
5. Saved global preferences (`preferences/global.toml`).
6. Saved per-character preferences (`characters/<C>/preferences/models.toml`).

`reasoning_effort` accepts `low`/`medium`/`high` or `off`. On OpenRouter
models `off` is an explicit **disable** — it is sent as
`reasoning: { effort: "none" }` (rather than merely omitting the field), so a
reasoning-by-default model that supports toggling actually stops reasoning.
Dedicated thinking-only endpoints (e.g. `moonshotai/kimi-k2-thinking`) reject
disabling with a provider 400 — they cannot be turned off. On other sdks `off`
simply omits reasoning.
The legacy `shore reasoning ...` command writes through the same
store. One-shot overrides — `shore model --all <name>`, `:model all
<name>`, `shore provider refresh <name>` — apply to a single call and
are never persisted.

`max_tool_iterations` is the unified per-model cap on agentic tool-loop
rounds. It governs **every** tool loop — interactive chat, the autonomous
heartbeat, compaction, and dreaming — through one setting, resolved on the
**model > sdk > provider** overlay like the other knobs. It is honored by every
sdk (not capability-gated). **Unset (the default) means unlimited**: the loop
runs until the model stops requesting tools, bounded only by per-call HTTP
timeouts (and, for the heartbeat, its wall-clock tick deadline). Set a finite
cap with `shore model setting max_tool_iterations <n>` (n ≥ 1); clear it with
`shore model setting max_tool_iterations` (no value) to return to unlimited.

`cache_keepalive` controls how often the daemon refreshes this model's prompt
cache while the character is idle. It is either `"off"` or a duration
(`"55m"`, `"6h"`, `"30s"`) — a literal ping interval, **not** derived from any
cache TTL. It is also distinct from `cache_ttl`, which is the Anthropic-only
wire setting that *enables* 1h caching; the two are unrelated and can be set
independently. Defaults are sdk-keyed: the **Anthropic** sdk defaults to
`"55m"` (its paid 1h cache tier is worth keeping warm), every other sdk
defaults to `"off"` (their cache lifetimes are opaque and carry no
cache-write surcharge to amortize, so a default ping would be wasted spend —
opt in explicitly per model, e.g. `cache_keepalive = "6h"` for a DeepSeek
model with a long-lived context cache). Set it at runtime with
`shore model setting cache_keepalive <off|duration>` (resolved on the same
**model > sdk > provider** overlay as the other knobs); clear it with
`shore model setting cache_keepalive` (no value) to fall back to the sdk
default. The total time pings continue after the last real message is bounded
globally by `[behavior.autonomy].cache_keepalive_max`.

Writes are **capability-aware**: a setting is validated against the active
model's resolved `(sdk, model_id)` before it is persisted. A key the sdk
ignores or rejects (e.g. `cache_ttl` on a non-Anthropic model, a sampler
knob on a Claude ≥ 4.7 model, `budget_tokens` on an OpenAI/OpenRouter model)
is refused, as is a `reasoning_effort` value outside the sdk's accepted set
(the allowed set is shown in the error). The accepted `reasoning_effort`
values are grounded in the provider docs: Anthropic
`low|medium|high|xhigh|max` (plus the `adaptive`/`off` sentinels),
OpenAI/OpenRouter `minimal|low|medium|high|xhigh` (`xhigh` is their ceiling —
`max` is Anthropic-only), Gemini `minimal|low|medium|high` (with a per-model
override dropping `minimal` for Gemini 3.x **Pro**, where it is Flash-only —
see the matrix below).

Because the **OpenRouter** sdk fronts many different underlying vendors, its
capability surface is additionally resolved by the **model id** (issue #164),
not just the sdk: an entry in `core/config/capabilities.toml`'s `[[model_override]]`
table (matched by a substring of the model id) narrows the accepted
`reasoning_effort` set and/or marks samplers as rejected for that vendor.
Populated cases: OR-routed **Gemini** (`google/gemini-*`) drops `xhigh`;
OR-routed **Grok** (`x-ai/grok-*`) is `low|medium|high`; OR-routed OpenAI
**o-series** (`openai/o1|o3|o4*`) reject `temperature`/`top_p` (GPT-5 does not —
it keeps sampling). No-tier / budget-mapped vendors (`moonshotai/kimi-*`,
`deepseek/*`, `z-ai/*`, `minimax/*`) deliberately keep the generic OpenRouter
set: their reasoning is an on/off toggle that OpenRouter maps to a token-budget
ratio, so every effort value is meaningful. Unknown vendors fall back to the
generic set.

DeepSeek and Moonshot (Kimi) can also be reached **natively** (not through
OpenRouter) via `sdk = "deepseek"` / `sdk = "moonshot"` — the built-in `deepseek`
and `moonshot` providers default to these. They use the Vercel AI SDK providers
and expose native reasoning control: DeepSeek a graded `reasoning_effort`
(`low|medium|high|xhigh|max`), Moonshot a thinking on/off toggle driven by
`budget_tokens`. On both, `reasoning_effort = "off"` requests a disable
(`thinking.type = "disabled"`); models that can toggle stop reasoning, while
dedicated thinking-only variants (e.g. `kimi-k2-thinking`) reject it upstream.

In addition to the sampler knobs, the **vendor knobs** are settable per-model
through the same store: `openrouter_provider` (a routing object, e.g.
`'{"order":["Anthropic"]}'`), `vertex_project`, `vertex_location`,
`gemini_generation`, `gemini_web_search`, `zai_clear_thinking`,
`zai_subscription`. These resolve **model > sdk > provider** (a per-model value
beats a `[providers.*.defaults]` or hardcoded provider default).

`shore model setting` (no key) lists only the keys the active model's resolved
sdk honors — so the vendor knobs appear for the models that use them and are
hidden elsewhere — and shows the accepted `reasoning_effort` domain.

### Verified capability matrix

The data backing the capability checks lives in `core/config/capabilities.toml`
(compiled into both the Rust daemon and the TS sidecar). The table below is the
provider-doc audit (issue #166) for the models in rotation. Legend: ✅ honored ·
🚫 rejected (400) · ⬜ ignored (no-op) · — n/a.

| Model (sdk) | `reasoning_effort` | `temperature` / `top_p` | `budget_tokens` | thinking mode | caching | `max_output` |
|---|---|---|---|---|---|---|
| `claude-opus-4-8` (anthropic) | `low/medium/high/xhigh` (+`max`); default high | 🚫 | 🚫 (adaptive-only) | adaptive only | ✅ (1024-tok min) | 128k |
| `claude-opus-4-6` (anthropic) | `low/medium/high/xhigh` (+`max`) → budget | ✅ | ✅ (enabled, deprecated) | adaptive + enabled | ✅ | 128k |
| `deepseek-v4-pro` (openrouter) | native `{high, max}`, def high; OR folds `low/med→high`, `xhigh→max` | ⬜ (in thinking mode) | — | thinking on/off | undocumented on OR | 384k ctx |
| `kimi-k2.6` (openrouter) | thinking on/off, no tiers (OR maps) | ✅ | — | thinking on/off | undocumented | 262k ctx |
| `minimax-m3` (openrouter) | reasoning tokens, no tiers (OR maps) | ✅ (def 1 / 0.95) | — | reasoning on/off | undocumented | 1M ctx |
| `glm-5.1` (zai) | ⬜ none — `thinking: enabled/disabled` only | ✅ `[0,1]`/`[0.01,1]`, gated by `do_sample` | — | thinking (compulsory when enabled) | ✅ context caching | 128k |
| `gemini-3.1` Pro (gemini) | `low/medium/high`; `minimal` is **Flash-only** | ✅ (rec. default 1.0) | ✅ `thinkingBudget` (🚫 if combined with level) | thinkingLevel | ✅ | 64k (1M ctx) |

Vendor-knob notes: `zai_clear_thinking` is a real GLM param (default true; affects
**cross-turn** thinking blocks only); `zai_subscription` is account/auth (the GLM
Coding Plan), not an API param, so it is a runtime knob rather than matrix data.
`gemini_web_search` maps to Gemini's Google Search grounding (supported on 3.x).

Sources: Anthropic
[what's-new 4.8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
and [migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide);
[DeepSeek thinking_mode](https://api-docs.deepseek.com/guides/thinking_mode);
[OpenRouter Kimi K2.6](https://openrouter.ai/moonshotai/kimi-k2.6/api) and
[MiniMax M3](https://openrouter.ai/minimax/minimax-m3/api);
[Z.AI chat-completion](https://docs.z.ai/api-reference/llm/chat-completion) and
[GLM-5.1](https://docs.z.ai/guides/llm/glm-5.1);
[Gemini 3 developer guide](https://ai.google.dev/gemini-api/docs/gemini-3).

## Character Workspaces

Characters live under:

```text
$XDG_CONFIG_HOME/shore/characters/<Character>/workspace/
```

Expected files:

```text
SOUL.md
USER.md
AGENTS.md
TOOLS.md
MEMORY.md     # active memory: dated, pruned, prompt-visible
memory/
```

Legacy `character.md`, `user.md`, and `prompts/system.md` are migrated into the workspace on first load.

## `[behavior.autonomy]`

```toml
[behavior.autonomy]
enabled = false
cache_keepalive_max = "12h"

[behavior.autonomy.heartbeat]
enabled = true
fallback_heartbeat_interval = "1h"
dormant_after_heartbeat_turns = 3
dormant_after_idle_time = "48h"
minimum_heartbeat_latency = "1h"
wrap_up_grace_rounds = 3
```

Autonomy requires the master switch. Heartbeat controls private autonomous ticks. All duration fields accept strings like `"30s"`, `"15m"`, `"2h"`, and `"48h"`.

`cache_keepalive_max` is the global ceiling on how long the cache-keepalive subsystem keeps refreshing a model's prompt cache after the last **real** activity — a user message, or a heartbeat tick that ran on the same model the keepalive pings (a heartbeat pinned to a different background model does not refresh this model's cache and does not count; keepalive pings themselves never count). It answers "what is the longest gap between messages I'd still want a warm cache for?". Once it elapses with no real activity, pings stop until the user returns. It is independent of the heartbeat's `dormant_after_idle_time` guard (which governs ticks, not cache warming) and of the per-model ping cadence (`cache_keepalive`, below). Default `"12h"`; it does not require `[behavior.autonomy].enabled`. The usage ledger's cache-anomaly tracker uses the same value to decide whether a cold start is a `keepalive_miss` (the keepalive should have been pinging) or an expected past-the-ceiling stop, so changing it retunes anomaly classification too; the tracker anchors its gap on foreground `message`/`tool_loop` calls only. Cost intuition for sizing it: each warm ping costs roughly 0.1× the prefix at input rates, while letting the cache lapse costs one 2× cold write on the next message — at a ~12k-token Opus prefix, pinging is the cheaper side of that trade for gaps up to roughly a day.

The heartbeat's tool-round budget is the per-model `max_tool_iterations` cap (see [Model Sections](#model-sections)) — a single surface shared with chat, compaction, and dreaming. **Unset (the default) means unlimited rounds**, bounded only by the wall-clock loop deadline (~30 min). When a finite `max_tool_iterations` cap is exhausted without natural termination, the daemon appends a wrap-up nudge asking the character to record any unfinished work into `MEMORY.md` and respond `HEARTBEAT_OK` (or send a final `<sendMessage>`), and `wrap_up_grace_rounds` grants that many extra rounds for the wrap-up turn. The wall-clock deadline is a separate backstop: when it is what trips, the nudge still fires once (if `wrap_up_grace_rounds > 0`) but the loop exits on the next deadline check — the grace rounds only meaningfully extend the finite-cap path, not a deadline-bounded tick. Notes the model leaves in `MEMORY.md` are prompt-visible on every subsequent turn, heartbeat and chat alike.

## `[tools]`

Tools are **opt-in**: a tool is offered to the character only if its name
appears in `enabled_tools`, and a sub-agent's `ask_<name>` tool only if the
sub-agent appears in `enabled_subagents`. Empty (or absent) allowlists mean
nothing is offered — there is no implicit "all tools on" default.

> The section is `[tools]`, not `[tools.*]` (e.g. `[tools.<provider>.<model>]`) —
> that shape was the (deprecated) tool-model catalog section the config loader
> reserves.

```toml
[tools]
enabled_tools = [
  "web_search",
  "fetch_url",
  "generate_image",
  "check_time",
  "roll_dice",
  "activity_heatmap",
  "read",
  "write",
  "edit",
  "list_files",
  "search",
  "delete",
  "search_chat_logs",
  "model_history",
  "exec",
  "set_next_wake",   # heartbeat self-scheduling; only usable during heartbeat ticks
]
enabled_subagents = ["memory"]   # exposes ask_memory (see [subagents])
max_result_chars = 20000          # truncate each tool result past this; 0 disables

[tools.web_search]
api_key_env  = "TAVILY_API_KEY"
result_limit = 5
search_depth = "basic"
include_answer = true

# Per-tool override of the global max_result_chars:
[tools.config.search]
max_result_chars = 10000
```

The registered tool names are: `web_search`, `fetch_url`, `generate_image`,
`check_time`, `roll_dice`, `activity_heatmap`, `read`, `write`, `edit`,
`list_files`, `search`, `delete`, `search_chat_logs`, `model_history`, `exec`,
`set_next_wake`. (`model_history` reports which models generated the
character's messages over a time period, from the usage ledger — pairs with
`search_chat_logs`' per-message `model` field and filter.)
List exactly the ones you want; comment a line out to disable that tool.
Dynamic MCP tools (`mcp__<server>__<tool>`, see [`[mcp]`](#mcp)) can also be
listed here, by exact name or with a trailing-`*` glob (e.g. `mcp__hue__*`).
(`set_next_wake` is only executable during heartbeat ticks, but must be listed
for the autonomous heartbeat to schedule its own next wake.)

Run **`shore tools`** to see the effective surface: every registered tool,
whether it's enabled on the main character, which sub-agents own it, the `exec`
allowlist, and any dangling references (an `enabled_tools` / sub-agent `tools`
entry that names no real tool, or an `enabled_subagents` entry with no
definition).

The maximum number of tool-loop rounds per chat turn is the per-model
`max_tool_iterations` cap (see [Model Sections](#model-sections)), not a
`[tools]` key. It defaults to **unlimited**; the loop ends when the model
stops requesting tools.

`max_result_chars` caps how many characters a single tool result may contribute
to the conversation. It defaults to `20000` (~5k tokens of code-like output);
set it to `0` to disable truncation and preserve full tool output. A per-tool
`[tools.config.<name>]` table overrides it for that tool. When a result
exceeds the limit it is cut at a character boundary and a one-line notice
(`[tool_result truncated: showing first N of M characters]`) is appended so the
model knows output was dropped. The truncation is persisted, so the shortened
result — not the original — is what gets replayed on later turns, capping its
context cost for the rest of the conversation.

- Workspace file tools (`read`, `write`, `edit`, `list_files`, `search`, `delete`) treat `memory/...` as an ordinary workspace subdirectory.
- There is no `send_image` toggle for uploaded attachments; generated-image sending is controlled by `generate_image`.

`exec` is allowlisted and argument-sandboxed. Path-like arguments must stay inside the character workspace.

### `[tools.web_search]`

Settings for the `web_search` tool (Tavily API):

```toml
[tools.web_search]
api_key_env  = "TAVILY_API_KEY"
result_limit = 5
search_depth = "basic"
include_answer = true
```

## `[subagents]`

Sub-agents wrap a subset of the in-process tools behind a single
natural-language tool. Each `[subagents.<name>]` entry *defines* a sub-agent;
listing its name in `[tools].enabled_subagents` *exposes* it to the primary
character as one `ask_<name>(query)` tool. Calling it runs a full tool loop on a
(typically cheaper) model over the listed tools and returns only the agent's
final text — the intermediate tool results never enter the primary model's
context, and the primary model's tool surface stays small. This both lowers
cost (cheap model does the busywork) and improves tool-selection accuracy.

Definition and enablement are deliberately separate, so a sub-agent must be
opted in just like any tool:

```toml
[defaults]
# Fallback model for sub-agents that don't pin their own. Keep it cheap.
subagent_model = "anthropic:claude-haiku-4-5"

[tools]
enabled_subagents = ["memory"]   # nothing is exposed until listed here

[subagents.memory]
description = "Ask {{char}}'s archivist about past conversations and saved notes."
prompt = "You are {{char}}'s memory archivist. Search and read what's relevant, answer concisely. Say so if you find nothing."
tools = ["search", "search_chat_logs", "model_history", "read", "list_files"]
# model = "anthropic:claude-haiku-4-5"   # optional; else defaults.subagent_model → defaults.model
# max_iterations = 8                      # optional; else the model's own cap
```

**Tip — "moved, not doubled":** if you expose `ask_memory`, you usually want to
*omit* its underlying tools (`search`, `search_chat_logs`, `model_history`,
`read`, `list_files`) from the primary character's `enabled_tools`, so the character
delegates instead of doing the lookup itself. Leave them in only if you want
both a quick direct lookup and a deep delegated dig.

- `description` / `prompt` support `{{char}}` / `{{user}}` templating, plus
  `{{date}}` / `{{time}}` which expand to the daemon's local date (e.g.
  `Saturday, April 4th, 2026`) and time at dispatch. A sub-agent runs in its own
  LLM call and never sees the conversation's injected time markers, so adding
  `Today is {{date}}.` to a research prompt keeps it from treating its training
  cutoff as "now" and accepting stale sources.
- `prompt` additionally supports two sub-agent-only macros, expanded after the
  templating above. A sub-agent otherwise sees none of the character's
  definition or the live conversation, so its replies can drift off-voice and
  "poison" the character's own turn; these give it that context back:
  - `{{file: <path>}}` — inserts the contents of a workspace file, path resolved
    relative to the character's workspace (a leading `./` is optional). It
    prefers the active-prompt snapshot, so `{{file: ./SOUL.md}}` /
    `{{file: ./USER.md}}` yield the exact bytes the main prompt used this turn. A
    missing or unreadable file expands to nothing (logged at `warn`). Use it to
    hand the sub-agent the character's SOUL/USER so its answers match register
    and know who they're for. The path is **confined to the workspace** by the
    same rules the `read`/`write` tools use: absolute paths, `..` traversal, and
    symlinks pointing outside the workspace are rejected and expand to nothing
    (logged at `warn`). Expanded content is sent to the sub-agent's model — often
    a different provider than the character's — so the confinement keeps a
    mistyped path from shipping an unrelated file off-box.
  - `{{active_history: <n>}}` — inserts the last `n` conversation turns as a
    plain `Speaker: text` transcript (assistant turns labelled with the
    character name, user turns with the display name; `n` is capped at 100).
    Grounds the sub-agent in what was just said.
  - Both macros insert their content **literally** — it is never re-scanned for
    further macros. A chat message that happens to contain `{{file: ...}}` can
    never trigger a file read, mirroring the main prompt, where `SOUL.md` /
    `USER.md` are inserted raw. These macros are not expanded in `description`
    (which carries no conversation context).
- `tools` must name registered tools; unknown names are skipped with a warning.
  `ask_*` tools are never offered to a sub-agent, so **nesting is hard-capped at
  one level** — a sub-agent cannot delegate further.
- Model resolution: `subagents.<name>.model` → `defaults.subagent_model` →
  `defaults.model`.
- Sub-agent spend is recorded in the ledger under call type `subagent` (its
  own tool-loop rounds are tagged `tool_loop`), so `shore usage` attributes it
  distinctly. Each sub-agent keeps its own stable prompt prefix, so repeated
  calls to the same agent cache well.

> Sub-agents add an LLM round-trip per delegated question (latency) and a layer
> of English→query→summary translation. Use them for domains with a real schema
> worth knowing; keep atomic, precisely-known operations as direct tools.

## `[mcp]`

The daemon can act as an **MCP (Model Context Protocol) client**: each
`[mcp.<name>]` entry points at an external MCP server — a stdio child process or
a remote HTTP endpoint — and surfaces that server's tools to characters. The
server is never daemon code; anything that speaks standard MCP (`initialize` /
`tools/list` / `tools/call`) works unchanged.

On connect the daemon calls `tools/list` and registers each discovered tool as
**`mcp__<server>__<tool>`** (e.g. `mcp__hue__set_light`). Those names are then
granted exactly like any other tool — directly on the character via
`[tools].enabled_tools`, or to a sub-agent via `[subagents.<name>].tools` — using
either an exact name or an `mcp__<server>__*` glob.

```toml
# Stdio server (a child process the daemon launches).
[mcp.hue]
command = "node"
args = ["dist/index.js"]                     # or command = "npx", args = ["-y", "@me/hue-mcp"]
cwd = "/home/me/hue-mcp"                      # run the server from its own directory
env = { HUE_BRIDGE_IP = "192.168.1.42", HUE_API_KEY = "..." }

# Remote HTTP/SSE server.
[mcp.docs]
url = "http://localhost:9123/sse"

[tools]
# Grant the whole hue server to the character directly...
enabled_tools = ["mcp__hue__*"]

# ...or wrap it in a sub-agent (recommended for chatty servers):
enabled_subagents = ["lights"]

[subagents.lights]
description = "Ask {{char}} to control the smart lights."
prompt = "You control {{user}}'s Hue lights. Read state before changing it; confirm what you changed in one sentence."
tools = ["mcp__hue__*"]
model = "anthropic:claude-haiku-4-5"
```

- Each server sets **exactly one** transport: `command` (stdio) **or** `url`
  (HTTP). Setting both, or neither, is a config error. `args`, `env`, and `cwd`
  apply to stdio servers; secrets belong in `env`.
- **`cwd` sets the stdio server's working directory.** Unset, the server
  inherits the daemon's cwd (the daemon does not chdir per server). Point it at
  the server's own directory so relative `args` paths resolve and the server
  loads its own `.env` from there — a tidier alternative to listing every secret
  under `env`. Ignored by HTTP servers.
- **Glob grants are fail-closed whitelists.** `mcp__hue__*` matches every current
  hue tool; a tool the server adds later is *not* granted until a pattern covers
  it. `mcp__*` grants every MCP tool from every server.
- **Naming stability matters.** The tool surface is discovered once at connect
  and pinned for the session (sorted by full name) so the Anthropic cache prefix
  stays stable. A server that renames or adds tools shifts that prefix on the
  next reconnect.
- **Hot-reload:** editing `[mcp.*]` reconnects the affected servers without a
  daemon restart. Unrelated config edits don't churn live connections. In-flight
  generations keep the snapshot they started with.
- **Wrap chatty servers in a sub-agent.** A server exposing many verbose tools
  bloats the primary tool surface and context; `ask_<name>` collapses it to one
  affordance and keeps intermediate results out of the primary model's context.
  Small/hot servers are fine to expose directly.
- **Trust:** an MCP server is arbitrary external code. To avoid leaking the
  daemon's secrets (provider API keys live in its environment), stdio servers are
  launched with a **cleared environment** — only `PATH`, `HOME`, and the
  variables you list under `env` are passed through. Still prefer servers you
  author and keep nondestructive; be deliberate about third-party servers and
  any that read the open internet.
- **Where MCP tools apply:** the **chat path** and the **heartbeat** (the
  character acting autonomously) both offer MCP tools, and the idle
  cache-keepalive rebuilds the *same* tool surface chat does, so enabling MCP
  doesn't desync the warmed cache prefix. The **dreaming/librarian** memory sweep
  deliberately uses a fixed, character-tool-independent toolset and does **not**
  offer MCP tools.
- **Hot-reload + running ticks:** a `[mcp.*]` edit reconnects immediately for the
  chat path; an already-running heartbeat loop keeps the tool surface it was
  spawned with until the daemon restarts (same semantics as other runtime config).

## `[memory]`

```toml
[memory]
git_push = false  # push the workspace repo after a successful pass
```

The character workspace is a git repository; compaction and dreaming passes commit their memory changes there (the model commits via the git-gated `exec` tool — it cannot `push`). `git_push` is the only top-level `[memory]` key: when `true`, the daemon runs a plain `git push` (honoring the repo's own remote/upstream) after each successful compaction or dreaming pass. It is **off by default**, the daemon never configures a remote for you, a repo with no remote is skipped silently, and a failed push is logged but never fails the pass. Leave it off unless you have set up a remote you want the memory history mirrored to; offsite durability is better served by backing up the workspace directory directly.

## `[memory.compaction]`

```toml
[memory.compaction]
enabled = true
idle_trigger = "30m"
archive_after = "0s" # deep-idle archive; 0 disables (e.g. "3h")
min_turns = 8
max_turns = 16
max_context_tokens = 200000
keep_recent_turns = 2
```

When compaction is enabled, `min_turns` and `max_turns` must both be greater
than `keep_recent_turns` (otherwise a pass would have nothing to compact) and
`max_turns` must be at least `min_turns`. Violations are hard config errors:
the daemon refuses to start, and a runtime reload (`config_reset` or hot
reload) rejects the new config and keeps the previous one. This also protects
the deep-idle archive below, which only runs while compaction is enabled.

Compaction writes markdown memory notes, archives old turns, and activates staged prompt-visible edits. It also updates `MEMORY.md` with the conversational throughline so the next conversation can pick up where this one left off; dreaming reorganizes the index later. When the autonomy manager has a cached chat request, compaction reuses that prefix and appends only the carry-forward instruction (the trailing `role:"system"` message is wrapped to a `<system_instruction>` user turn by the Anthropic provider), preserving the live conversation's prompt cache. After compaction, cache keepalive keeps its existing deadline and rebuilds the request from disk if needed, so stable pinned system prompt sections can stay warm even though the old conversation tail was discarded.

Compaction runs a tool loop: the model calls `write` / `edit` on files under `memory/` and on the workspace-root prompt files (`MEMORY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`). Root prompt-file writes go through the same deferred-edit queue as chat-turn edits, so they only become prompt-active at the boundary the pass creates. Writes to any other path (`DREAMS.md`, dreaming-owned artifacts under `memory/`, paths outside `memory/`, etc.) are rejected at the dispatch wrapper. The per-model `max_tool_iterations` cap (see [Model Sections](#model-sections)) limits how many tool-use rounds a single pass may run; it defaults to **unlimited**, so the pass normally ends when the model stops calling tools. If the pass finishes with **zero** allowed memory writes — because the model used only read-only tools, only attempted disallowed paths, or hit a finite `max_tool_iterations` cap — the active conversation is **not** archived and the next trigger will retry. This is by design: silent "archive with no writes" was the failure mode of the pre-tool-loop XML path.

### Deep-idle archive (`archive_after`)

`archive_after` (default `0` = disabled) adds a second, longer idle boundary on top of `idle_trigger`: once that much time passes with no new messages, the daemon archives whatever is left of the active conversation so the next exchange starts from a clean slate — the automated equivalent of running `shore memory compact 0` before stepping away. Unlike the other triggers it is **not** gated by `min_turns`; short conversations that the regular idle trigger never picks up are exactly the ones it exists for.

The mechanism depends on memory coverage. The compaction LLM always sees the full conversation (the `keep_recent_turns` split only controls what stays in `active.jsonl`), so when the regular idle trigger has already compacted and nothing arrived since, the leftover tail is already covered by memory — the deep-idle archive then moves it to a segment file directly, with **no LLM call**. This is the one sanctioned bypass of the zero-writes guard above: the guard protects uncovered content, and coverage was established by the earlier pass. If uncovered turns do exist (a short conversation below `min_turns`, or a brief exchange after the last compaction), a real keep-0 compaction pass runs first so those turns reach memory.

Either way, a trailing run of **unanswered autonomous messages** (heartbeat `<sendMessage>` output the user never responded to) is retained in the active conversation rather than archived, so the message is still visible in the chat when the user returns — and a leftover autonomous tail alone never re-triggers the archive.

## `[memory.dreaming]`

```toml
[memory.dreaming]
enabled = false
frequency = "0 3 * * *"
minimum_inactive_time = "45m"
max_lateness = "2h"
compact_before = true
compact_to_zero = false
```

`frequency` is a five-field cron schedule: `minute hour day-of-month month day-of-week`.
It supports `*`, lists, ranges, steps, month/day names, and `0` or `7` for Sunday;
for example, `0 6 * * 1` runs Mondays at 06:00.

- `minimum_inactive_time` — minimum time since the last *user* message before a
  scheduled sweep may fire. Heartbeat/autonomy turns do not reset this clock.
- `max_lateness` — how long a missed cron occurrence stays eligible to fire
  late (daemon was down or the character was active). Beyond this the
  occurrence is skipped and the next cron tick takes over; there is no
  catch-up queue.
- `compact_before` — run an idle-style compaction (if eligible) immediately
  before the sweep so the librarian sees consolidated memory. A compaction
  failure aborts the sweep.
- `compact_to_zero` — with `compact_before`, the pre-dream compaction archives
  every chat turn instead of retaining the configured `keep_recent_turns`
  tail.

Dreaming is opt-in and requires `[behavior.autonomy].enabled = true`. It runs independently of heartbeat as a background AI librarian pass. The librarian tool loop is bounded by the per-model `max_tool_iterations` cap (see [Model Sections](#model-sections)), which defaults to **unlimited**. The character uses memory tools to inspect the existing flexible markdown layout, consolidate and dedupe durable notes, mark stale/superseded material, and update the canonical `MEMORY.md`. The daemon writes a timestamped audit entry to the dreams log automatically once the pass finishes — the model itself does not write `DREAMS.md`. Dreaming may also edit the protected prompt files (`SOUL.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`); those edits are staged through the active-prompt snapshot and take effect at the next compaction/reload boundary. When a cached chat request is available, the librarian instruction is appended after that request prefix so the existing provider-side prompt cache can be reused. The model still follows the `[defaults.background]` resolution chain: cache reuse only keeps the request *content* — when a background pin resolves to a different model than the chat request's, dreaming runs on the pinned model (same rule as compaction).

`MEMORY.md` is the index/map and replaces the old recap/digest concept. Normal chat reads `active_prompt/MEMORY.md`; edits to `workspace/MEMORY.md` only become prompt-active after compaction/reload. It should not duplicate `USER.md` or `AGENTS.md`, which remain pinned prompt files.

The dreams audit log lives at `$XDG_DATA_HOME/shore/<Character>/DREAMS.md` (data dir, not workspace) so it never bleeds into prompts or memory snapshots. Use `shore memory dreams [--limit N]` to inspect recent entries. Machine-readable dreaming staging/debug state is written under `$XDG_DATA_HOME/shore/<Character>/dreams/`.

## `[advanced]`

```toml
[advanced]
cache_forensics = false
# editor = "nvim"          # editor override, checked before $VISUAL / $EDITOR
# max_retries = 2          # LLM retry attempts before giving up
# retry_backoff = "500ms"  # base retry delay; doubles on each attempt
max_image_size = 2000000   # bytes; larger images are resized to JPEG before upload (0 = never resize)

[advanced.llm_sidecar]
enabled = true
# socket_path = "/run/user/1000/shore/llm.sock"   # default: <runtime_dir>/llm.sock
```

- `editor` — command used for editor-based flows; checked before the `$VISUAL`
  and `$EDITOR` environment variables.
- `max_retries` / `retry_backoff` — LLM retry policy. Defaults: 2 retries with
  a 500ms base delay that doubles on each attempt (exponential backoff).
- `max_image_size` — images larger than this many bytes are scaled down and
  re-encoded as JPEG before being sent to a provider. `0` disables resizing.
- `[advanced.llm_sidecar]` — the supervised TypeScript LLM wire process.
  Enabled by default; the daemon resolves the `shore-llm-sidecar` binary via
  `SHORE_LLM_SIDECAR_BIN`, then `$PATH` / next to `shore-daemon`, then the
  packaged `/usr/lib/shore` location, and supervises it over a Unix socket.
  Set `socket_path` to override the socket location (default
  `<runtime_dir>/llm.sock`).

### Diagnostics toggles

Per-call payload capture is **always on** and needs no configuration. Every LLM
request/response — chat, tool loops, heartbeat, dreaming, compaction — is
recorded to a compressed SQLite store at `$XDG_CACHE_HOME/shore/calls.db`, and
the heartbeat/dreaming tool loops additionally record curated transcripts there.
The store self-rotates (14-day window plus a 512 MiB disk backstop), so no cron
pruning is needed. Inspect it with `shore log --api` (raw payloads, filterable
by `--call-type`; `shore log --api <id>` dumps one call) and `shore log
--heartbeat` / `--dreaming` (curated transcripts). API keys are redacted, but
the store does retain raw request/response payloads (which can include user
content) as bounded-retention observability data, pruned by age and total size —
it is not authoritative application state. The legacy
`[advanced].api_payload_logging` key (and the old `debug/api_logs*` file dumps)
is deprecated and ignored — accepted only so older configs keep loading.

`[advanced].cache_forensics = true` writes Anthropic prompt-cache forensic
events under `$XDG_CACHE_HOME/shore/cache_forensics.jsonl`. The durable cache
state and anomaly summary remain in the usage ledger.

## `[memory.retrieval]`

```toml
[memory.retrieval]
mode = "auto" # auto, lexical, hybrid
max_file_bytes = 2097152
max_indexed_files = 50000
max_total_indexed_bytes = 1073741824
max_embed_chars_per_file = 4000
binary = "skip" # skip, metadata, try_embed
```

- `lexical` never calls embeddings.
- `auto` uses hybrid retrieval when an embedder is resolved and usable.
- `hybrid` requests semantic+keyword ranking but falls back to lexical if embeddings fail.
- Lexical and hybrid both scan the workspace tree (including `memory/`) for
  text files.
- `max_file_bytes` controls the per-file size cap for lexical/hybrid search.
- `max_indexed_files` and `max_total_indexed_bytes` bound workspace index walks.
- `max_embed_chars_per_file` limits how much text from each file is embedded.
- `binary` controls non-UTF8 handling for indexing:
  - `skip`: skip binary files.
  - `metadata`: track binary files as skipped metadata only.
  - `try_embed`: reserve space for future binary embedders; current OpenAI-compatible text embedders still record these as unsupported.

The hybrid index is rebuildable and non-authoritative.

## `[memory.thinking]`

```toml
[memory.thinking]
replay_prior_thinking = "all"
```

Tri-state control over how much prior-turn thinking/redacted-thinking is replayed in outgoing requests:

| value | behavior |
|-------|----------|
| `all` (default) | keep every prior turn's thinking |
| `last_turn` | keep only the most-recent assistant turn's thinking; strip older turns |
| `none` | strip all prior-turn thinking |

`all` and `none` are the historical behaviors; the legacy bool form still parses (`true` → `all`, `false` → `none`), so existing configs keep working unchanged.

`last_turn` is a middle ground: Anthropic models tend to stop producing thinking once the immediately-preceding assistant turn has none, so keeping just the last turn's thinking keeps the model reasoning while shedding most of the token cost that `all` carries forever (older thinking blocks dwarf the surrounding text). The kept turn loses its thinking on the *next* request (a moving boundary), but this was measured to be cache-safe: Anthropic's prompt cache reads the longest matching prefix and writes incrementally, so the default breakpoint schedule re-reads the stable prefix and only re-creates the changed tail — no extra breakpoint placement is needed (#191).

Stripping is only safe with providers that don't depend on prior-turn thinking (e.g. Anthropic Claude 4.x). DeepSeek V3.1+ and Moonshot Kimi-thinking reject requests that omit prior `reasoning_content` while in thinking mode, so their reasoning-replay floor forces full replay regardless of this setting. In-progress tool-loop thinking is always preserved.

This value is the **global fallback**. The quality effect is model-dependent — for example Claude Opus 4.8 is reproducibly better with less prior thinking, while minimax-m3 / glm-5.1 want it all — so it can be overridden **per model** through the preference overlay (`shore model setting replay_prior_thinking <all|last_turn|none>` / `:setting replay_prior_thinking <…>`, the same path as `reasoning_effort` etc.). An unset per-model value inherits this global default; there is no auto-promotion in either direction.

## `[notifications]`

```toml
[notifications]
enabled = false
backend = "notify_send"   # notify_send | ntfy | command
generation_threshold = "0s"

[notifications.ntfy]
url = "https://ntfy.sh"
topic = ""                # required for the ntfy backend
token = ""                # optional auth token for self-hosted instances

[notifications.command]
template = ""             # shell command; {title} and {body} are substituted

[notifications.events]
autonomous_message = true
cache_warning = true
compaction_complete = true
error = true
message_complete = false
usage_warning = true
```

`generation_threshold` only applies to `message_complete`: the notification
fires only when generation took longer than the threshold (`"0s"` = always).

Per-event toggles live under `[notifications.events]`; every event defaults to
`true` except `message_complete` (off by default — it fires on every assistant
reply, so opt in deliberately).

## `[usage]`

Usage budgets are evaluated from the SQLite ledger that powers `shore usage`.
`shore usage --budget` prints budget state and spike warnings; `shore usage
--json` and `shore usage --budget --json` return machine-readable JSON.

```toml
[usage]
timezone = "local"                  # "local" or "utc"; default: local
allow_compaction_over_budget = true # default: true

[[usage.budgets]]
name = "daily total"
period = "day"                      # hour, day, week, month
cost_usd = 10.00
warn_at = [0.5, 0.8, 1.0]
limit = "warn"                      # warn, block, pause_background

[[usage.budgets]]
name = "background"
period = "day"
usage_kind = ["heartbeat", "dreaming"]
cost_usd = 2.00
limit = "pause_background"

[[usage.budgets]]
name = "overflow key monthly"
period = "month"
provider = "openrouter"
api_key = "overflow"
cost_usd = 25.00
limit = "block"
allow_compaction_over_budget = false # optional per-budget override

[[usage.budgets]]
name = "billing cycle"
period = "month"
cost_usd = 200.00
reset_day_of_month = 15              # 1-31; clamps to last day on short months
reset_hour = 0                       # 0-23; default 0

[[usage.budgets]]
name = "work week"
period = "week"
cost_usd = 50.00
reset_day_of_week = "thursday"       # monday..sunday; default monday
reset_hour = 6

[usage.spike_warnings]
enabled = true
period = "hour"
multiplier = 3.0
min_cost_usd = 1.00
```

Budget filters are optional and combine with AND semantics. Supported filters
are `character`, `provider`, `api_key`, `model`, `call_type`, and
`usage_kind`. `usage_kind` accepts the grouped names from `shore usage
--by-kind`, such as `message_no_tools`, `message_with_tools`, `heartbeat`,
`compaction`, and `dreaming`.

`limit = "warn"` reports status only. `limit = "block"` rejects matching LLM
calls once committed ledger spend has reached the limit. `limit =
"pause_background"` rejects matching background calls after the limit while
leaving user chat available. Shore does not interrupt an in-flight generation;
limits are checked before starting the next LLM call. Compaction is allowed
over budget by default because reducing prompt context can lower the next chat
turn's cost; set `allow_compaction_over_budget = false` globally or on a
specific budget for a strict stop.

Custom reset anchors let a budget align to a billing cycle, work week, or
"my day starts at 6am" schedule instead of the default top-of-period
boundary. All anchor fields are optional; defaults preserve the historical
behavior (midnight, Monday, the 1st).

| Field | Valid on `period =` | Range | Default |
| --- | --- | --- | --- |
| `reset_hour` | `day`, `week`, `month` | 0–23 | 0 |
| `reset_day_of_week` | `week` | `monday`..`sunday` | `monday` |
| `reset_day_of_month` | `month` | 1–31, clamped to the last day on short months | 1 |

A month budget with `reset_day_of_month = 31` resets on the last calendar
day of months shorter than 31 (Feb 28/29, Apr 30, etc.), so every month
gets exactly one reset.

When committed spend crosses a `warn_at` threshold, the daemon emits one
`usage_warning` server frame to the active requester and fires the
`usage_warning` notification event. Threshold warnings are de-duped per budget,
period window, and threshold — with one exception: once committed spend is at
or above 100% of the budget, the warning re-fires on every subsequent check so
the operator keeps seeing the over-limit signal as spend continues to accrue.
The re-fired event carries `crossed_warn_at = [1.0]` regardless of which
`warn_at` thresholds the user configured.

## `[connections.matrix]`

External mode connects to an existing homeserver:

```toml
[connections.matrix]
enabled = true
mirror_all = true
homeserver = "https://matrix.example.com"
user_id = "@shore:example.com"
room_id = "!room:example.com"
trusted_user = "@user:example.com"
```

`mirror_all` (default `true`) controls what each character's bound Matrix room
shows. When `true`, the room mirrors the character's full conversation regardless
of which client drove it — user prompts sent from the CLI/TUI, assistant replies,
and autonomous messages all appear, routed by character. When `false`, only the
room you are actively chatting in from Matrix sees responses (legacy behavior).
The setting is consumed by the `shore-matrix` bridge; the daemon only stores it.

Embedded mode manages a conduwuit-compatible homeserver:

```toml
[connections.matrix]
trusted_user = "@user:shore.local"

[connections.matrix.embedded]
server_name = "shore.local"   # cannot be changed after first run
bind_address = "127.0.0.1"    # "0.0.0.0" / "::" exposes the homeserver to LAN
port = 6167
admin_user = "shore-admin"    # admin username, without @ or :server (default)
admin_password = "change-me"
# data_dir = "..."            # default: $XDG_DATA_HOME/shore/matrix-server/
# binary = "continuwuity"     # default: auto-detect (continuwuity, conduwuit, tuwunel)
```

When the daemon supervises `shore-matrix`, it sets the bridge process log filter
from `SHORE_MATRIX_RUST_LOG`. The default keeps Shore bridge lifecycle logs but
suppresses routine Matrix SDK sync and key-backup chatter:
`warn,shore_matrix=info,matrix_sdk_crypto::backups=error`.

`[connections.telegram]` and `[connections.discord]` parse (arbitrary keys are
accepted) but are reserved stubs — nothing consumes them yet.

## Validation

```sh
shore config --check
shore config
shore config --path
```

## Manual Reload

```sh
shore config reload        # validate + reload config; asks before activating
                           # changed system-prompt (workspace) files
shore config reload --yes  # activate changed prompt files without asking
```

Config TOML edits normally hot-reload on save; `shore config reload` is the
explicit counterpart that surfaces parse errors instead of logging them, and
the only command that activates edited prompt-visible workspace files
(`SOUL.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, `MEMORY.md`)
outside a compaction. Activation changes the system prompt bytes, so the
provider prompt cache goes cold and the next message pays a one-time cache
write — the command lists the differing files and asks first.
