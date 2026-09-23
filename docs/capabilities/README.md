# Application capability inventory

This directory tracks the implementation of [issue #214](https://github.com/mythofmeat/shore/issues/214).
The browser must provide every application capability in this inventory. The inventory is a migration
input, **not evidence that a browser workflow exists**. Implemented browser workflows and their
verification are recorded in [WEB_GUI.md](../WEB_GUI.md); full parity remains unfinished.

## Reproducible source inventory

- `terminal.generated.json` is produced from the actual Clap command tree, including hidden commands,
  every argument, aliases, defaults, enum choices, arity, conflicts, and environment variable names.
  It also records examples passed through the actual `to_swp_command` mapping, the complete `ViewKey`
  preferences, and the production key bindings and shortcut menu. A null example mapping means that
  a special runner or local workflow must be accounted for; it is not an exception from browser parity.
- `daemon.generated.json` combines the executable operation registry, the remaining legacy dispatch
  paths and every generated wire type. It includes characterless dispatch, core message/regen/cancel
  requests, results, images, tools, warnings, and all known server-event variants. Its
  `legacy_operations` list makes unmigrated contracts explicit. Registered operation schemas validate
  all 56 named operation payloads; no legacy names remain. Core request variants and exhaustive
  terminal field/event/local-workflow coverage remain separate parity work. The inventory itself is
  not a runtime validator.

Regenerate from `client/`, then from `daemon/`:

```sh
cargo test -p shore-common --lib export_bindings
cargo test -p shore-common --lib export_operation_schemas
cargo test -p shore-cli export_capability_inventory -- --ignored
```

```sh
bun run inventory:generate
```

The normal Rust and daemon test suites compare the inventories against the running source. Review
regenerated differences together with the corresponding browser controls and conformance fixtures.
These gates detect source drift. The migrated registry also enforces handler/contract bindings and
input-field metadata. Browser checks cover generated controls, live settings types and current
browser journeys. Complete field/result/event accessibility and transport conformance remain
required gates; metadata alone does not establish a usable browser control.

## Capability mappings

The generated terminal inventory is the exhaustive list of command paths and declared options. The
table below records the browser destination and semantics required by each family. A destination in
this table is a required destination, not proof of an implemented GUI registration. No application operation is excluded.

| Terminal capability | Shared operation or browser equivalent | Required options and observable behavior |
| --- | --- | --- |
| Leading character/thread flags | Browser session selection, `switch_character`, `switch_thread` | Per-tab identity; selection survives reconnect; stale updates cannot cross conversations. |
| Leading daemon address | The serving daemon's same-origin endpoint | TCP discovery/address syntax is terminal-specific; remote browser access uses an explicitly secured web origin. |
| Bare `shore` | Conversation workspace | Character/thread navigation, composer, transcript, optional details panels; empty-character onboarding. |
| `msg send` | `message`; `inject_system` for system mode | Text, multiple images, stream choice; uploads and server paths distinguished. Preserve interruption versus confirmed failure. |
| `msg regen` | `regen` | Optional ephemeral guidance; responsive cancellation; alternatives, metadata and warnings. |
| `msg edit` | `get`, `edit` | Stable message target; in-app multiline editor; cancel pending fetch/edit; save without changing another message after concurrent updates. |
| `msg delete` | `delete` | Multiple references resolve against one snapshot; tool-loop deletion semantics; confirmation. |
| `msg alt` | `list_alternatives`, `alt` | List, previous, next, first, last, numeric selection; arbitrary assistant reference. |
| `log` | `log`, `get`, `history_page` | Turns, role, single reference, follow, content-only, structured results, reasoning, tools, nested subagent tools; full history navigation. |
| `compact` | `compact` | Keep zero or more turns; restart paused work; inspect progress, partial completion and recovery. |
| `clear` | `clear` | Archive without summary; immediate exclusion; note; safeguard and resulting segment visibility. |
| `segments` and every subcommand | `segments` | List/show/include/exclude/label/note/retry; clearing labels/notes; messages and retain status. |
| `character` | `list_characters`, `character_info`, `create_character`, `switch_character`, `delete_character` | Avatars, metadata, bootstrap status; create/select from empty state; deletion confirmation and optional downloadable backup. |
| `thread` and every subcommand | `list_threads`, `switch_thread`, `create_thread`, `thread_label`, `thread_model`, `thread_home`, `archive_thread`, `fork_thread` | Labels including clearing, model pins including reset, compaction, home/warm state, fork source and turn limit, archive outcomes. Hidden thread-model remains an application capability. |
| `export`, `import` | `export_character`, `import_character` through transfers | Authenticated local file selection/download; controlled artifact ownership, limits, expiry and cleanup; same archive safety rules. |
| `status` | `status` | All sections, optional section filter, inspect every result field including new fields. |
| `model` and every subcommand | `list_models`, `model_info`, `switch_model`, `model_settings`, `set_model_setting`, `reset_model`, `favorite_model` | Search/all/favorites; chat, all/named background roles, all/named subagents; named model without switching; global setting scope; reset one setting or role selection. |
| `provider` | `list_providers`, `list_provider_models`, `refresh_provider_models`, `refresh_all_provider_models` | Status and redacted credentials, hidden models, one/all refresh, failure and recovery. |
| `config` | `config`, `config_schema`, `config_check`, `config_reload`, `tools` | Effective/default values, all/filter, JSON/TOML download, path labelled server-side, schema choices/writability/scope; reload preview and confirmation for prompt invalidation. |
| `trace` summary | Diagnostics navigation | The special runner's overview must remain available alongside detailed views. |
| `trace calls` | `call_log` | List/count/call-type, inspect call, compare previous or explicit call, full wire payload, structured download. |
| `trace heartbeat`, `trace recall` | `transcript` | Both transcript kinds; count, calls/tools/recall details, structured download. |
| `trace events`, `trace errors` | `heartbeat_log`, `error_log` | Count, event details, provider-key fallback warnings, errors. |
| `trace subagent` | `subagent_trace` | Stored list/count and parent tool-use ID detail; nested activity. |
| `debug` summary and heartbeat controls | `heartbeat_tick_now`, `heartbeat_set_dormant`, `heartbeat_set_active`, `keepalive_ping_now`, `session_activate` | Manual actions, scheduling outcomes, cache status and long-running results. |
| `debug tool`, `debug subagent` | `run_tool` | Dynamic tool schema forms; describe; named argument pairs and nested collections; raw/untruncated output; configured availability, timeouts and real side effects. |
| `usage` and every subcommand | `usage` | Period, provider, API-key name, model, call-type; group by all six dimensions; budgets/cache/anomalies/limits; CSV and TSV download. |
| `view` | Persistent browser display preferences | Every generated `ViewKey` and value, including named budget selection; no loss of images/editing/drafts under a platform-specific label. |
| `ui insert`, `ui normal`, `ui scroll` | Composer focus and keyboard transcript navigation | Home/end, line/page/top/bottom movement and keyboard-accessible controls. Exact terminal modes need not be copied. |
| `ui images`, `ui image` | Media picker, clipboard paste, attachment queue, full-size viewer | Add/remove/clear; image captions, multi-image navigation, draft/reconnect recovery. |
| `ui subagents`, `ui output` | Optional activity and result panels | Current and stored subagent activity; reopen and inspect last action output. |
| `ui editor`, `ui edit-cancel` | Built-in draft/message editor | Multiline editing, undo/redo, discard pending edit, recover text and attachments. `$EDITOR` process execution is terminal-specific. |
| `ui cancel` | `cancel` | Control routing must bypass long-running mutation queues. |
| `ui help`, `ui palette` | Searchable actions, settings and shortcuts | Keyboard access, choices/completion, help; schema-generated controls and designed workflows. |
| `ui bind`, `ui unbind` | Browser shortcut customization | Bind/unbind application actions and save preferences; reserve browser-owned keys explicitly. |
| `ui quit` | Disconnect/close workspace | Detach peer and preserve drafts; browser window closure stays browser-owned. |
| `completions` | Shell-specific exception | Installing shell completion scripts has no application effect; GUI action discovery replaces command completion. |
| `complete` | Dynamic GUI choices and help | Every generated completion kind still maps to characters, threads, models, providers, status sections, tools/subagents, settings and config choices. The helper process itself is shell-specific. |
| `--json`, `--toml`, content/display flags | Inspectable results, preferences and supported downloads | Output formatting is a presentation adapter; meaningful data and supported export formats must remain accessible. |

## Workflows outside the command tree

These require explicit browser scenarios in addition to command/option coverage:

- `tui/draft.rs` and draft lifecycle tests: per-conversation drafts, concurrent client ownership,
  attachment persistence/recovery, interrupted editing, pruning without deleting another draft.
- `tui/app/input.rs` and `tui/input.rs`: Unicode cursor movement, multiline paste, word deletion,
  undo/redo, input history, edit cancellation while the fetch is outstanding, picker search,
  keyboard confirmation/cancellation, favorite toggling and output pagination.
- `tui/images.rs`, `tui/clipboard.rs`, `terminal_images.rs`: clipboard/picker attachments, inline
  images, full-size image navigation, captions and recovered media. Terminal escape sequences and
  terminal graphics protocols are narrow presentation exceptions; viewing the media is not.
- `tui/app/stream.rs`, `notifications.rs`, `cache.rs`, `usage.rs`, `compaction.rs`: text and thinking
  streams, tool and nested subagent activity, phase/progress, usage/cache/provider/config warnings,
  model and timing metadata, compaction activity and result inspection.
- `swp_client/sync.rs`, `conn_manager.rs`, `tui/connection.rs`: correlation, independent selection and
  revision watermarks, full versus delta history, stale/duplicate rejection, revision-gap recovery,
  disconnect/reconnect/restart, selection during streaming and uncertain mutations.
- `run.rs` special runners: character creation/selection/deletion, edit fetch-and-save, config reload
  preview/confirm/apply, dynamic completion, persisted client selection, log-follow and summaries.

The generated examples exercise `to_swp_command`; they do not execute these special runners. Their
null mappings must be replaced by real workflow evidence in the final parity gate, not accepted as
covered. Known events require exhaustive policies tied to handlers; a generic unknown-frame fallback
may only serve genuinely future events.
