# Cache keepalive

Keepalive sends billable, one-output-token requests containing a character's
chat prefix to refresh an explicit prompt cache between turns. It is off by
default. Setting `cache_ttl` alone does not enable it. A provider-wide
`cache_keepalive` setting is an opt-in inherited by its eligible models;
check provider defaults and saved preferences when a model appears opted in
without a per-model setting.

Keepalive is useful when you expect to reuse a substantial cached prefix
before the idle ceiling and the avoided cache-write cost exceeds the sum of
refresh costs. Each ping still pays for cached input, uncached suffixes, and
output. A cold ping can pay to write the whole prefix again. NanoGPT paid
routes charge money; subscription routes can consume the subscription's
token allowance. Shore requires an enabled explicit cache and an interval
shorter than its TTL, checks usage budgets, and only starts automatic pings
after a completed chat turn reports cache reads or writes. It does not
predict financial break-even. Small prompts that never enter the cache do
not start automatic pings.

## Settings and precedence

| Setting | Meaning | Default |
| --- | --- | --- |
| `cache_ttl` | Provider cache lifetime hint; not a ping cadence | Anthropic SDK: `1h`; otherwise unset |
| `cache_keepalive` | `off`, or an interval such as `55m` | Off |
| `cache_keepalive_max` | Model's maximum idle time for automatic pings | Unset; inherits global ceiling |
| `[cache].keepalive_max` | Global idle ceiling | `12h` |

The idle ceiling is **effective model `cache_keepalive_max` > global
`[cache].keepalive_max` > built-in `12h`**. The global default and fallback
share the same constant. Changing the ceiling does not enable keepalive.
Pings and heartbeat calls do not extend the idle window. Non-heartbeat,
non-keepalive generation calls establish activity; an explicit activation
that successfully primes a cache also starts a new window.

Model settings start with the resolved catalog/provider defaults. Saved
chat preferences then apply in this order, with later values winning:
global defaults, character defaults, global model settings, character model
settings. Subagents have their own preference layers. Inspect the effective
value, saved values, and their scopes together:

```sh
shore model setting --model nanogpt:anthropic/claude-haiku-4.5 --json
```

Automatic keepalive is supported for the Anthropic SDK and Claude models
using `sdk = "nanogpt"`. NanoGPT's Gemini, DeepSeek, and other non-Claude
models use implicit caching and cannot opt into this feature. Other SDKs
cannot opt in either. Unsupported settings loaded from existing files are
disabled; attempting to enable them through the settings command fails
before making a provider call. Explicit `off` and clearing a saved setting
are always allowed.

Set the TTL before the cadence, for example:

```sh
shore model setting cache_ttl 1h --model nanogpt:anthropic/claude-haiku-4.5 --global
shore model setting cache_keepalive 55m --model nanogpt:anthropic/claude-haiku-4.5 --global
shore model setting cache_keepalive_max 90m --model nanogpt:anthropic/claude-haiku-4.5 --global
```

Supported wire TTLs are `5m` and `1h`. The adapters normalize other nonempty
TTL values to `5m`; use the supported spellings. Cadence must be positive
and strictly shorter than that effective TTL. Changing the TTL to a value
shorter than an existing cadence disables the cadence at resolution time.

## Disable it

For the current character and model:

```sh
shore model setting cache_keepalive off
```

For a named model across characters, set `off` with `--model ... --global`;
a character-specific override still wins. `--reset` removes a saved value
and exposes inherited settings, so it does not necessarily turn keepalive
off. To remove provider-wide opt-in, remove its cadence or set:

```toml
[providers.nanogpt.defaults]
cache_keepalive = "off"
```

Reload edited configuration. Model/settings changes rebuild the affected
cached request and apply the current policy. The audit for issue #217
traced the reported NanoGPT default to an explicit provider defaults block
containing `cache_ttl = "1h"` and `cache_keepalive = "55m"`; there was no
built-in NanoGPT cadence. The model gate prevents that inherited cadence
from arming non-Claude models.

## Lifecycle and cost guards

| Path | Schedule and prefix behavior | Source in `daemon/src/` |
| --- | --- | --- |
| Completed chat turn | Saves the completed prefix; enables its cadence only when usage reports cached reads or writes | `handler/persistence.ts`, `cache/last_request.ts` |
| Ordinary generation observation | Records activity and prefix fingerprint; actual cache hits clear prior ping misses | `runtime.ts`, `cache/keepalive.ts` |
| Scheduler tick | Checks idle ceiling, in-flight state, prefix staleness, and usage budget before sending | `cache/schedule.ts`, `cache/keepalive.ts` |
| First automatic ping with zero cache reads | Disarms that schedule, even when cache writes are also zero | `cache/keepalive.ts` |
| Second consecutive automatic miss after re-arming | Halts all keepalive for the daemon lifetime; heartbeat hits do not clear chat misses | `cache/keepalive.ts`, `cache/tracker.ts` |
| Ping reads cache but writes at least 1,000 tokens | Emits `rewrote`; continues with the refreshed prefix | `cache/keepalive.ts`, `cache/tracker.ts` |
| Failure or skipped ping | Exponential retry delay; invalidates after the last confirmed warmth exceeds cadence plus five minutes | `cache/schedule.ts` |
| Model, sampler, or thread change | Disarms old schedule, invalidates the stored request, then rebuilds using current settings | `handler/command_dispatch.ts`, `handler/deps.ts` |
| Prompt/config/MCP changes, compaction, archive | Invalidates/rebuilds the request; rebuilding alone does not assert cache warmth; an unrebuildable request disarms | `handler/deps.ts`, `runtime.ts`, `memory/compaction/run.ts`, `autonomy/post_archive.ts` |
| Character deletion | Disarms, unregisters autonomy, and invalidates the cached request | `handler/deps.ts` |
| Heartbeat | Rebuilds chat input when needed without marking it warm; separate heartbeat calls neither extend chat idle time nor reset its misses | `autonomy/heartbeat_request.ts`, `cache/keepalive.ts` |
| Restart | Restores recent timestamps using the configured global ceiling; a rebuilt prefix applies current model cadence/ceiling before sending | `autonomy/state_file.ts`, `autonomy/service.ts`, `cache/last_request.ts` |
| Manual ping | One billable diagnostic call; requires explicit cache support and budget, respects daemon halt, does not itself start a cadence | `commands/keepalive.ts` |
| Session activation | Resumes a scheduled prefix, or pays one priming call for an opted-in model; primes only when usage reports cache reads/writes | `commands/activate.ts` |

Request-body invalidation and scheduler disarming are separate operations:
`LastRequestCache.invalidate()` removes the body and clears its miss count;
its callers decide whether to disarm first or rebuild a still-live schedule.
Rebuilding preserves applicable recent timestamps but never manufactures a
new warm timestamp. Persisted state contains scheduling metadata, not a
request body or credentials. A snapshot older than its cadence is not
restored as warm.

## Observe and diagnose

Keepalive outcomes appear in the event stream as `sent`, `cold`, `rewrote`,
`failed`, `skipped`, or `halted`. Provider attempts are recorded in the
usage ledger as `call_type = "keepalive"`, including failed attempts.
`shore status` reports `keepalive_halted` with its reason and timestamp.
After correcting the cause of a daemon-wide halt, restart the daemon.

The current CLI exposes these deliberate, potentially billable operations:

```sh
shore debug keepalive_ping_now
shore debug session_activate
```

Activation that reads and writes no cached tokens reports that its priming
call was billed and leaves the schedule disarmed. Manual ping reports the
read/write token counts and whether it used a cached or rebuilt request.
Neither operation bypasses unsupported-cache or daemon-halt guards.

See [NanoGPT transport and live audit](NANOGPT.md) for provider-specific
evidence and the limits of the tested cache behavior.
