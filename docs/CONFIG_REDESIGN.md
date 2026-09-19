# Flat configuration design

Status: implemented for [#227](https://github.com/mythofmeat/shore/issues/227),
awaiting its first stable release. The reader accepts these examples, and the
offline migration command converts legacy files after checking all scopes.
No deployed config was changed. See the [generated reference](CONFIG_REFERENCE.md)
and [migration guide](CONFIG_REDESIGN_MIGRATION.md).

Use flat feature sections: `[chat]`, `[heartbeat]`, `[compaction]`, `[tools]`,
`[subagents]`, `[cache]`, and `[notifications]`. A section names the thing being
configured. Nested tables name an actual provider, subagent, tool, server, or
model. Avoid intermediate `behavior`, `background`, `integrations`, `definitions`,
`profiles`, and `defaults` tables.

The main design constraint is the distance between a user's decision and its
setting. A heartbeat interval is `heartbeat.interval`. A subagent is
`subagents.internet`. Provider discovery is `providers.deepseek.discover`.
There is no fixed quota of top-level headings: optional features can have their
own sections without adding anything to a user's file.

## What the deployed configuration actually uses

The revision is based on a read-only inspection of `/opt/docker/silvershore`:
the main config, all seven `conf.d` TOML files, the Compose mount definitions,
and the global/character model-preference files in the mounted data directory.
No character `config.toml` overrides were present. A stored setting shows what
has been configured; this inventory does not claim every setting is exercised
by the running binary or every stored model identity still resolves.

| Observed use | Consequence for the design |
| --- | --- |
| Heartbeats every 6h, minimum 4h, up to 20 idle turns | Give heartbeat a direct section with short, specific names. |
| Compaction after 50m idle, 4–50 turns, 500,000 context tokens, no retained turns, Git push enabled | Keep these distinct controls and put them together under `[compaction]`. They are actively tuned. |
| Three enabled subagents, each in its own include, with substantial prompts and tool grants | Keep `[subagents.<name>]` and the existing file split. Put the enabled list and shared model directly in `[subagents]`. |
| Five providers, four with discovery; one provider sets cache TTL and keepalive | Keep the five existing provider headings and flatten the nested discovery/default settings within them. |
| Chat selection in character preferences, plus 24 model-setting entries, two subagent-model entries, and 12 global favorites | Preserve model/preference scopes. The main config does not need a copied list of every model or an explicit chat selection. |
| Model settings include reasoning effort (16 entries), output limits (11), SDK overrides (6), image support, sampling, and caching | Keep those controls. Their absence from `config.toml` does not mean they are unused. |
| One weekly budget with daily pacing, a Thursday reset, a heartbeat pause action, and a compaction exception | Preserve that policy as one flat `[[budgets]]` entry. A simple cost ceiling would lose real behavior. |
| ntfy with a 10s generation threshold | One notification table should be sufficient to select delivery and its destination. |
| One HTTP MCP server; no per-tool overrides, retrieval tuning, static model profiles, Matrix config, retry overrides, or diagnostics in these files | Leave those features available in the reference; omit them from the starter and common example. |

Two subagent include files contain no active declarations. Environment variable
names alone do not establish feature use: old integration credentials remain in
the deployment even when there is no corresponding active config section.

## The main file

This is the shape of the inspected main file, with personal names and the
notification destination replaced. Its explicit controls and numeric values are
preserved. The separate provider/subagent files remain separate. `conf.d` still
loads automatically, so no new `include` directive is necessary.

```toml
[chat]
display_name = "Alex"
user_timestamps = "always"

[embedding]
model = "local:BAAI/bge-small-en-v1.5"

[image]
model = "openrouter:google/gemini-3-pro-image"

[cache]
keepalive_for = "20h"

[heartbeat]
enabled = true
interval = "6h"
min_interval = "4h"
max_idle_turns = 20

[compaction]
write_memory = true
idle_after = "50m"
min_turns = 4
max_turns = 50
keep_recent_turns = 0
max_context_tokens = 500000
git_push = true

[tools]
enabled = ["bash", "search", "search_chat_logs", "activity_heatmap", "web_search", "set_next_wake"]

[subagents]
enabled = ["internet", "memory", "music"]
model = "deepseek:deepseek-flash"

[[budgets]]
name = "weekly"
character = "assistant"
cost_usd = 15
period = "week"
pace_period = "day"
reset_day_of_week = "thursday"
reset_hour = 8
warn_fractions = [0.9, 1.0]
limit_action = "block"
pace_warn_fractions = [0.35, 1.0]
pace_warn_action = "pause_heartbeat"
allow_compaction = true

[notifications]
via = "ntfy"
topic = "<your-notification-topic>"
min_generation_duration = "10s"
```

All ten headings in this main file are at the root. There are no empty parent
sections or model catalog scaffolds. Omitted settings retain their built-in
defaults; in particular compaction stays enabled by default. Keep explicitly
written defaults such as `write_memory = true` during migration, because they
express a choice that should survive a future default change.

`cache.keepalive_for` means the maximum idle period during which automatic
keepalive is allowed, measured from the same activity boundary used today.
Keepalive pings and heartbeats do not extend it. Provider `cache_ttl` still
controls the provider cache lifetime, and `cache_keepalive` controls ping cadence.
The three values retain different jobs.

The stored chat selection remains in preferences. Setting `chat.model` would
provide a fallback, not silently replace that selection. Likewise, omitting
`heartbeat.model` and `compaction.model` preserves their active-chat fallback.
This example is a format sketch, not a claim that the inspected provider/model
references have all been validated against a live service.

## The included definitions

The provider files already have five headings; retain that layout and simplify
the fields inside them. Credentials remain environment
references, discovery becomes a boolean, and shared chat settings sit beside
the connection they apply to:

```toml
[providers.deepseek]
api_key_env = "DEEPSEEK_API_KEY"
discover = true

[providers.nanogpt]
api_key_env = "NANOGPT_API_KEY"
discover = true
cache_ttl = "1h"
cache_keepalive = "55m"

[providers.claude_agent]
discover = true

[providers.zai-sub]
api_key_env = "ZAI_API_KEY"
discover = true

[providers.local]
base_url = "http://embeddings:80/v1"
api_key_env = "LOCAL_EMBEDDINGS_KEY"
```

`discover` retains the existing default, false. `ignore_models` is the optional
ordered discovery-filter list. Provider-wide settings remain lower precedence
than model-specific and saved settings, and retain SDK applicability checks:
moving a NanoGPT cache setting must not enable caching on unsupported models.

Subagent includes keep the existing names, prompts, and tool lists verbatim.
For example, this abbreviated definition illustrates the syntax; it is not a
replacement for the deployment's prompt:

```toml
[subagents.internet]
description = "Research questions on the web"
prompt = "Find evidence and report your sources."
tools = ["web_search", "bash", "search", "search_chat_logs"]

[mcp.listening_stats]
url = "http://mcp-listening-stats:3000/mcp"
```

Each subagent can still set `model`, `timeout`, and `max_tool_rounds` directly.
Registration never grants access: `subagents.enabled`, `tools.enabled`, and each
subagent's `tools` list keep their separate meanings. Keeping the enabled list
also preserves its array-replacement behavior in character overrides.

## Where everything belongs

| Section | One-sentence charter |
| --- | --- |
| `chat` | User identity, context presentation, and the fallback chat model. |
| `embedding`, `image` | The selected model and optional model-specific settings for that capability. |
| `providers.<name>` | Connection, credentials, discovery, and shared chat settings for one provider. |
| `heartbeat`, `compaction` | One background task's schedule, limits, side effects, and optional model. |
| `subagents` / `subagents.<name>` | Shared subagent selection/grants and named subagent definitions. |
| `tools` / `tools.<name>` | Tool grants and shared or named execution limits. |
| `cache` | The global idle limit for model prompt-cache keepalive. |
| `budgets[]` | A complete spending rule, including matching, pacing, and enforcement. |
| `notifications` | Which notifications to send and how to deliver them. |
| `mcp.<name>`, `matrix`, `web_search` | The connection and service-specific options for that integration. |
| `retrieval` | Workspace indexing and retrieval limits. |
| `daemon` | Listener and diagnostics controls. |
| `usage` | Accounting/report timezone; spending rules themselves are `budgets[]`. |

The last four rows are optional reference material, not compulsory starter
sections. `usage.timezone` stays available because it affects reports as well as
budget windows; flattening the budget array must not change accounting time.

The few nested tables have concrete purposes:

```toml
[chat."provider:model_id"]
max_output_tokens = 16384

[embedding."provider:model_id"]
dimensions = 1536

[image."provider:model_id"]
quality = "standard"

[tools.bash]
timeout = "10m"
```

These are optional per-identity overrides, not aliases or an inventory that must
be maintained. Capability sections all select via `model` and all place overrides
directly under the quoted `provider:model_id`. Existing `[chat.<provider>.<alias>]`
entries migrate to this qualified form. Discovery and explicit IDs work without
an override table; saved preferences remain separate and take precedence.

Scalar names in mixed tables are reserved: `model`, `enabled` in `subagents`, and
`enabled`, `timeout`, `max_result_chars` in `tools`. Reject collisions with an
existing named definition explicitly during migration. Capability override keys
contain a provider separator, so they cannot collide with plain scalar fields.
The schema distinguishes scalars from named tables and rejects unknown fields.

## Simplify decisions as well as headings

- Notifications use `via = "off" | "notify_send" | "ntfy" | "command"`, with
  default `off`. ntfy's `url`, `topic`, and `token_env`, or a command's `command`
  argv, live in that same table. `events` is a list of event names, defaulting to
  `autonomous_message` and `message_complete`. This removes the second enable
  switch, backend wrapper, and six-boolean events table. `via` is a new spelling
  so an old `backend = "ntfy"` without `enabled` never starts sending on upgrade.
- Heartbeat has one enable switch. Fold the two old gates using their effective
  AND after layering; compaction retains its independent enable switch.
- Each background task has its own optional `model`. Remove the shared
  `defaults.background.model` knob by materializing it into the two task model
  settings only where they previously inherited it. There is no third place to
  inspect when deciding what runs a heartbeat.
- Keep the budget's compaction exception, which is used here; remove its global
  duplicate through the documented inheritance-preserving migration.
- Remove the unused global stream flag and the three unenforced memory-file
  ceilings. Keep per-tool limits available: absence in this deployment does not
  make them useless for a long Bash build or a slow MCP service.
- Put `cache_forensics` directly under `daemon`, retries directly under `chat`,
  and retrieval controls directly under `retrieval`. Their defaults keep them
  out of the common config. No new umbrella sections.

Keep existing setting names when they are already clear. Keys and Shore-owned
enum values use `snake_case`; byte/character/token limits state their numeric
units, durations remain strings (`"50m"`, `"6h"`), and money remains `cost_usd`.
Shorten repeated context (`heartbeat.interval`, `subagents.model`) rather than
introducing abbreviations. `max_tool_rounds` consistently means a model/tool
iteration. Budget warning fractions remain fractions; changing their spelling
does not turn `0.9` into a percentage. User-defined identities and vendor payloads
are never case-normalized or punctuation-normalized.

## Compatibility and delivery

Keep the first proposal's migration guarantees: old configs work with warnings
for at least 180 days and two subsequent stable releases; removed keys then
produce specific migration errors. The first release must publish the actual
date. Normalize simple aliases before merging each source; preserve include
order, character overlays, preference scopes, array replacement, and explicit
false/zero values. Complex folds must preserve effective behavior across all
characters or stop with a concrete manual action.

Migration is an explicit offline `shore config migrate --config <path>` plan,
with `--write` to apply it, format-preserving edits, backups, semantic checks,
and idempotence. Startup never rewrites files. Schema, CLI/TUI completion,
generated reference, and starter examples ship with the new reader and writer.
The starter should show a small working setup, with the complete optional surface
in the reference. It should not print hundreds of commented defaults.

The [complete disposition and migration appendix](CONFIG_REDESIGN_MIGRATION.md)
maps every current app option plus provider/model settings, defines the tricky
conversions, and records verification and implementation acceptance criteria.
Review this shape before implementing renames.
