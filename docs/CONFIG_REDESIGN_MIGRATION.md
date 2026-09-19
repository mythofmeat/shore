# Configuration redesign: disposition and migration

This is the implementation and compatibility guide for the [flat configuration design](CONFIG_REDESIGN.md).
The reader and offline migration command are implemented; the first stable release
and its removal boundary have not been scheduled.

## Running a migration

Use the new client and a matching local daemon executable on the machine that
owns the configuration. An explicit data directory includes global and character
preferences and thread model pins in the same validated transaction:

```sh
shore config migrate --config /path/to/config.toml --data-dir /path/to/data
shore config migrate --config /path/to/config.toml --data-dir /path/to/data --write
```

The first command prints source files and key changes with all values omitted.
Stop the daemon before `--write`; the writer acquires its data-directory lease.
Use `--daemon /path/to/shore-daemon` when the matching binary is not beside the
client or on PATH. Files retain their permissions and comments. Backups remain
beside each changed file; the recovery journal identifies them if rollback fails.
Dotted-key ordering and final newlines can change with `toml_edit` formatting.
A second run reports that the files are already current.

Nonempty literal ntfy tokens require manual relocation to an environment variable.
Reserved legacy names, conflicting catalog aliases, per-model transport overrides,
and inheritance that cannot be preserved across characters require the manual
actions shown in the plan. If catalog conversion changes the implicit first chat
model, select the intended `chat.model` explicitly before migrating. No files are
written when any manual action or semantic difference remains.

## Resolution invariants

Every model-consuming feature uses the same `model` scalar and qualified
`provider:model_id` values. Chat, embedding, and image place optional per-model
overrides directly under their quoted qualified identities. Provider defaults
are flat fields on `providers.<name>`. No alias catalog or `profiles` table is
required to use discovery or an explicit model ID.

Chat selection remains thread pin, character saved selection, global saved
selection, then `chat.model`. A background task uses its own `model`, otherwise
the applicable active chat selection. A subagent uses its definition's `model`,
then `subagents.model`, then its current active-character fallback. Embedding and
image use their respective `model` fields. Preserve existing unresolved-reference
warnings and fallback behavior in this redesign; changing that policy is not
needed to flatten configuration.

Provider-wide chat settings overlay built-in defaults, then qualified chat
settings overlay the provider. Chat sampler preferences retain their order:
global defaults, character defaults, global model, character model. Subagent
samplers retain their separate global/character model and named-subagent layers;
do not apply chat sampler defaults to them. Background role overrides and thread
pins retain their current behavior. SDK applicability checks stay in force.

Preference files remain in their data-directory scopes. Do not copy a saved
selection, favorites, or model settings into the main config. Migration must
preserve the deployed combination of provider-wide caching, saved per-model
SDK/output/reasoning overrides, and separate subagent-model preferences. Never
normalize provider names or model IDs: `-` and `_` are not interchangeable.

Root config, ordered includes, sorted `conf.d` files, and character overlays
retain their precedence. Tables merge; arrays replace. Root `budgets` remains an
array, including the existing character-scoping behavior when an overlay declares
that array. `usage.timezone` continues to apply to budgets and usage reporting.

## Option disposition

The tables inventory the surface at `bf450f70`. Braces enumerate **all** fields in
a group; unchanged suffixes are retained unless a row says otherwise. “Remove”
means a warned legacy setting during the migration window followed by an explicit
removal error, not an ignored field. Existing removal errors remain errors.

### Server, conversation, and background

| Current key | Proposed key / decision | Why keep it, or why remove it |
| --- | --- | --- |
| `daemon.addr` | `daemon.listen_addr` | Host/container deployments need to choose their listener. Keep CLI/env precedence. |
| `cache.forensics` | `daemon.cache_forensics` | Diagnostic capture is an explicit storage/privacy choice, not cache policy. |
| `defaults.display_name` | `chat.display_name` | A remote daemon's OS user is not necessarily the human's name. Retain `$USER`, then `User`, as fallbacks. |
| `defaults.stream` | Remove | No live consumer reads this default; streaming is requested by the client/protocol. Delete the key; no replacement TOML setting. |
| `behavior.user_message_timestamps` | `chat.user_timestamps` | Users need control over timestamps in model context. Keep `auto`, `always`, `never`. |
| `memory.thinking.replay_prior_thinking` | `chat.reasoning_replay` | Replay changes context cost and continuity. Keep `all` / `none`; adapt only where the provider supports it. |
| `defaults.background.model` | Remove shared form; materialize `heartbeat.model` and `compaction.model` where inherited | Each task has one explicit model setting and its active-chat fallback. Preserve legacy inheritance during migration. |
| `defaults.background.{heartbeat,compaction}` | `<task>.model` | A task-specific model belongs next to that task's mechanics. |
| `behavior.autonomy.enabled` and `behavior.autonomy.heartbeat.enabled` | Fold into `heartbeat.enabled` | Both currently gate heartbeat. Effective legacy value is their AND, using the old defaults `false` and `true`. Compaction remains independently enabled. |
| `behavior.autonomy.heartbeat.fallback_heartbeat_interval` | `heartbeat.interval` | Controls cadence when no wake is scheduled. |
| `behavior.autonomy.heartbeat.minimum_heartbeat_latency` | `heartbeat.min_interval` | Bounds model-requested wake frequency and cost. |
| `behavior.autonomy.heartbeat.dormant_after_heartbeat_turns` | `heartbeat.max_idle_turns` | Bounds unanswered heartbeat work. |
| `behavior.autonomy.heartbeat.dormant_after_idle_time` | `heartbeat.idle_timeout` | Stops background activity after prolonged user absence. |
| `behavior.autonomy.heartbeat.wrap_up_grace_rounds` | `heartbeat.max_wrap_up_rounds` | Bounds the model/tool rounds allowed to finish background work. |
| `memory.compaction.{enabled,write_memory,archive_after,min_turns,max_turns,max_context_tokens,keep_recent_turns}` | `compaction.{same fields}` | Users choose whether to write memory, when to rotate, and how much context to retain. The deployment explicitly tunes five of these controls. Preserve their distinct triggers and validation. |
| `memory.compaction.idle_trigger` | `compaction.idle_after` | Express the idle threshold directly; retain whole-second validation. |
| `memory.git_push` | `compaction.git_push` | Compaction's post-pass push is an explicit external side effect. Keep the existing opt-in default. |
| `memory.file_limits.{max_note_bytes,max_index_bytes,max_prompt_bytes}` | Remove | The old edit helper distinguishes notes, `MEMORY.md`, and prompt files, but current Bash dispatch never enforces these limits. Delete the keys; do not advertise them as write restrictions or replace them with a new unenforced ceiling. |

The stream and file-limit removals are based on live call sites, not merely a
lack of example configs: see [tool dispatch](../daemon/src/tools/dispatch.ts),
[old file-limit helpers](../daemon/src/tools/workspace.ts), and
[message routing](../daemon/src/handler/router.ts). Recheck these call sites
when implementing. Adding an actual workspace or prompt limit would need its
own defined enforcement point and is outside this rename/migration pass.

### Tools and retrieval

| Current key | Proposed key / decision | User need |
| --- | --- | --- |
| `tools.enabled_tools` | `tools.enabled` | Explicit tool grants; retain wildcard semantics and disabled-by-default behavior. |
| `tools.{timeout,max_result_chars}` | Keep | Bound process runtime and model-visible output. |
| `tools.config.<tool>.{timeout,max_result_chars}` | `tools.<tool>.{same fields}` | Bash builds and small lookup tools need different limits. These are documented, functioning overrides; retain them. |
| `tools.enabled_subagents` | `subagents.enabled` | Grant subagents separately from ordinary tools, beside their definitions. |
| `defaults.subagent_model` | `subagents.model` | A shared delegated-work model can differ from chat. |
| `subagents.<name>.{description,prompt,tools,model,timeout}` | `subagents.<name>.{same fields}` | Preserve named behavior, least-needed tool grants, model choice, and time bounds. |
| `subagents.<name>.max_iterations` | `subagents.<name>.max_tool_rounds` | Bound delegated model/tool work using the same term as model settings. |
| `memory.retrieval.mode` | `retrieval.mode` | Keep `auto`, `lexical`, `hybrid`, `vector` for differing quality/cost needs. |
| `memory.retrieval.max_file_bytes` | `retrieval.max_file_bytes` | Exclude very large files from indexing. |
| `memory.retrieval.max_indexed_files` | `retrieval.max_files` | Bound index size by file count. |
| `memory.retrieval.max_total_indexed_bytes` | `retrieval.max_total_bytes` | Bound aggregate indexing work independently of per-file size. |
| `memory.retrieval.max_embed_chars_per_file` | `retrieval.max_embedding_chars_per_file` | Bound per-file embedding cost. |
| `memory.retrieval.binary` | `retrieval.binary` | Keep `skip`, `metadata`, `try_embed`; all already meet the naming convention. |

### Integrations

| Current key | Proposed key / decision | User need |
| --- | --- | --- |
| `connections.matrix.{enabled,user_id,room_id}` | `matrix.{same fields}` | Enable and route a Matrix connection. |
| `connections.matrix.homeserver` | `matrix.homeserver_url` | Make the endpoint type explicit. |
| `connections.matrix.mirror_all` | `matrix.mirror_user_messages` | This controls mirroring user messages originating outside Matrix, not all events. |
| `notifications.{enabled,backend}` | Fold into `notifications.via` | One selector: `off`, `notify_send`, `ntfy`, `command`. Legacy enablement remains authoritative during conversion; the new default is `off`. |
| `notifications.command` | Keep | Command argv stays a list; no shell-template revival. |
| `notifications.generation_threshold` | `notifications.min_generation_duration` | Suppress completion notifications for short generations. |
| `notifications.events.{autonomous_message,cache_warning,compaction_complete,error,message_complete,usage_warning}` | Fold into `notifications.events`, a list of these enum values | Independently choose useful notifications without six booleans. Preserve effective legacy selections after layering. |
| `notifications.ntfy.{url,topic}` | `notifications.{same fields}` | Choose the server and destination. |
| `notifications.ntfy.token` | Replace with `notifications.token_env` | Consistent environment-based secret handling. Nonempty literals require manual secret relocation; never put their contents in a warning or migration diff. An empty token can be removed safely. |
| `tools.web_search.api_key_env` | `web_search.api_key_env` | Keep Tavily credential selection. |
| `tools.web_search.result_limit` | `web_search.max_results` | Bound retrieved output and cost. |
| `tools.web_search.search_depth` | `web_search.depth` | Enum: `basic`, `advanced`, `fast`, `ultra_fast`; retain current default `advanced`. Translate `ultra_fast` to Tavily's `ultra-fast` on the wire. |
| `tools.web_search.include_answer` | `web_search.include_answer` | Users choose whether to include the provider's answer summary. |
| `mcp.<name>.{command,args,env,url,headers}` | `mcp.<name>.{same fields}` | Preserve stdio/HTTP transport and server authentication. Keep transport exclusivity validation. |
| `mcp.<name>.cwd` | `mcp.<name>.working_dir` | Explicitly name the process working directory. |

The web-search depth enum covers the current
[Tavily API choices](https://docs.tavily.com/documentation/api-reference/endpoint/search).
Do not restrict existing `fast` / `ultra-fast` configurations to only `basic` and
`advanced`. During migration accept `ultra-fast` with a warning and convert it.
Unknown strings get a precise validation error, not an undocumented fallback.
Matrix's existing access-token environment variable remains unchanged.

### Usage

| Current key | Proposed key / decision | User need |
| --- | --- | --- |
| `usage.timezone` | Keep | Calendar budgets depend on local/accounting time. |
| `usage.allow_compaction_over_budget` | Remove global form; materialize into each budget | Avoid two independently editable sources for one exception. See overlay handling below. |
| `usage.budgets[].allow_compaction_over_budget` | `budgets[].allow_compaction` | Each enforced budget decides whether compaction may exceed it; default false. |
| `usage.budgets[].{name,period,cost_usd}` | `budgets[].{same fields}` | Identify a budget, its calendar window, and its dollar limit. |
| `usage.budgets[].warn_at` | `budgets[].warn_fractions` | State the units of warning thresholds. |
| `usage.budgets[].limit` | `budgets[].limit_action` | State that the value is an action, not another monetary limit. |
| `usage.budgets[].warn_action` | `budgets[].warn_action` | Distinguish warning-time action from exhaustion-time action. |
| `usage.budgets[].{character,provider,api_key,model,call_type}` | `budgets[].{same fields}` | Target spending by existing ledger dimensions; `api_key` names a credential entry, never a secret. |
| `usage.budgets[].usage_kind` | `budgets[].usage_kinds` | A list of accounted usage categories. |
| `usage.budgets[].{reset_hour,reset_day_of_week,reset_day_of_month}` | `budgets[].{same fields}` | Account for provider billing boundaries. |
| `usage.budgets[].{pace_period,pace_action,pace_warn_action}` | `budgets[].{same fields}` | Detect overspending within a longer budget window. |
| `usage.budgets[].pace_warn_at` | `budgets[].pace_warn_fractions` | Match the units of ordinary warning thresholds. |

Keep period enums `hour`, `day`, `week`, `month`, full lower-case weekday names,
and action enums `warn`, `block`, `pause_background`, `pause_heartbeat`. For
`call_type` and `usage_kinds`, generate suggested values from the ledger's
vocabulary but accept explicit historical/custom labels; a closed enum would
prevent filtering imported history. Preserve matching-budget enforcement and
character scoping rather than treating the budget array as a named map.

### Model defaults, provider fields, and profile settings

| Current key | Proposed key / decision | User need |
| --- | --- | --- |
| `defaults.{model,embedding,image_generation}` | `{chat,embedding,image}.model` | Select the default within its capability. |
| `providers.<p>.{enabled,subscription,sdk,base_url,api_key_env}` | `providers.<p>.{same fields}` | Choose transport, endpoint, credentials, and accounting treatment. |
| `providers.<p>.keys[].{name,enabled,warn_on_fallback}` | `providers.<p>.keys[].{same fields}` | Preserve credential rotation, identity, and fallback warnings. |
| `providers.<p>.keys[].env` | `providers.<p>.keys[].api_key_env` | Match the single-key form. Keep the rule forbidding both forms together. |
| `providers.<p>.discovery.enabled` | `providers.<p>.discover` | Opt into discovery with one boolean, default false. |
| `providers.<p>.discovery.ignore` | `providers.<p>.ignore_models` | Filter noisy catalogs, preserving ordered/negated globs. |
| `providers.<p>.defaults` | Inline its allowed chat-setting leaves into `providers.<p>` | Shared settings need no additional heading. Transport fields remain provider fields; collisions are errors. |
| `chat.<p>.<alias>.model_id` | Identity becomes `p:model_id` in references and `chat."p:model_id"` | Remove a second naming system; no `model_id` scalar inside an override table. |
| `embedding."<identity>".dimensions` | `embedding."<identity>".dimensions` | Choose the embedding vector width. |
| `image_generation."<identity>".{size,quality,aspect_ratio,image_size}` | `image."<identity>".{same fields}` | Preserve provider-specific image controls. `size` is a dimension string; `image_size` is a provider size class, so neither is relabeled as bytes or pixels. |
| `cache.keepalive_max` | `cache.keepalive_for` | Bound the idle window for automatic keepalive; per-model override still wins. |
| `advanced.{max_retries,retry_backoff}` | `chat.{same fields}` | Users on unreliable endpoints need latency/reliability controls. Preserve current retry behavior. |

The following setting vocabulary applies consistently to provider-wide chat
settings, qualified chat overrides, saved sampler settings where supported, and
`shore model setting`. It does not make every field legal in every scope.

| Existing setting | Canonical setting / decision | User need |
| --- | --- | --- |
| `max_context_tokens`, `max_output_tokens` | Keep | Bound context and generation size. |
| `temperature`, `top_p`, `reasoning_effort` | Keep | Control sampling and reasoning within the model's supported settings. |
| `budget_tokens` | `reasoning_budget_tokens` | Disambiguate reasoning from usage budgets and context capacity. |
| `cache_ttl` | Keep | Choose provider cache lifetime. |
| `cache_keepalive` | Keep | Explicit interval or `off`. |
| `cache_keepalive_max` | `cache_keepalive_for` | Bound the idle window for automatic keepalive. |
| `replay_prior_thinking` | `reasoning_replay` | Model-scoped override of conversation replay; `all` / `none`. |
| `max_tool_iterations` | `max_tool_rounds` | Bound a model's tool loop; retain its positive-integer rule. |
| `sdk` | Keep | Provider `sdk` selects transport; a per-model override can select a different gateway transport. A legacy `defaults.sdk` remains invalid and must not be legitimized by flattening. |
| `supports_images` | Keep | Explicit override when discovery lacks or misreports image support. |
| `openrouter_provider` | `openrouter_routing` | Name the vendor-specific routing object; its nested vendor payload stays opaque and unmodified. |
| `gemini_generation` | `gemini_thinking_mode`: `auto`, `budget`, `level` | Alias/private model IDs can defeat inference. Expose the actual compatibility choice instead of a numeric model-generation override. Legacy 0 maps to `auto`, 1/2 to `budget`, and 3 or above to `level`; preserve the explicit reasoning-budget setting's priority. |
| `zai_clear_thinking` | `zai_clear_reasoning` | Keep the provider-supported conversation behavior; retain applicability checks. |
| Legacy chat-entry `api_key_env`, `base_url` | Move to `providers.<p>` | Transport belongs to the provider. Conflicting per-entry transport requires an explicitly named separate provider, not a lossy merge. |

Do not add the removed `zai_subscription` model setting back; provider
`subscription` is its existing home. Preserve existing removal diagnostics for
retired providers/SDK spellings. Settings that are ignored or rejected by an SDK
must still be reported as such in model-setting schema and validation.

Already removed keys stay removed: `memory.{backend,recall,retain}` (including
the issue's possessive-pronoun and wrapper-string candidates), `advanced.editor`
(use `$VISUAL` / `$EDITOR`), and `defaults.heartbeat`. Update the last one's
guidance to `heartbeat.model`; do not require a two-step migration
through another retired key.

## Compatibility and safe rewriting

### Published deprecation ladder

Let **R** be the first stable release containing the new reader, migration tool,
and documentation. R's release notes must publish its actual release identifier
and the date **R + 180 days**; a design proposal cannot invent a release number.
The removal release must be both after that date and after at least two
subsequent stable releases with warnings. This is a minimum compatibility window,
not automatic removal on a calendar timer.

| Stage | Behavior |
| --- | --- |
| Development (current) | Flat reader, canonical schema/starter, and explicit offline migration are available. Existing deployments are never rewritten at startup. |
| R and the compatibility window | Accept currently valid legacy configuration with deprecation warnings. Canonical keys are the only generated examples and normal completions. Legacy-only controls retain their old behavior in the compatibility reader. |
| Removal release | Legacy keys/values fail with the old path, canonical replacement or removal reason, and `shore config migrate` guidance. The offline migration reader continues to understand the previous format. |

Warnings identify the source file, full quoted key path, replacement, and
published removal boundary. Emit each once per source/path per load, including
shadowed declarations. Startup logs and `shore config --check` surface them;
`shore config keys --json` exposes structured deprecation metadata. Never log
secret values. Already-invalid or previously removed keys remain errors in R.

### One migration registry, applied before information is lost

The registry stores old/new paths as segment arrays, value transforms, scope,
deprecation stage, and removal guidance. Reuse it for TOML loading, config get/set
aliases, model-setting aliases, warnings, schema, docs, and rewrite plans. Plain
string replacement cannot distinguish a quoted model ID containing dots.

Normalize simple one-to-one aliases **per source before merging**. For example,
an included legacy `defaults.model` must override a root `chat.model`
just as an included canonical key would. Different spellings in different files
are ordinary layering. In the same source, old and new declarations of one
canonical key are an error even when values match; show both locations. Validate
unknown/removed declarations before an overlay can hide them. Invalid catalog
container types are errors rather than empty catalogs.

Preserve source provenance throughout loading and retain original syntax trees
for writing. Do not turn partially specified character configs into snapshots
of the complete global config. Empty sections, explicit false, empty arrays,
unset values, and array replacement remain distinct. Character budget arrays
continue to acquire the character scope only when declared by that overlay.

The following conversions need more than a key rename:

- **Provider tables:** move each allowed `defaults` leaf to the provider table
  and rename discovery's two leaves. Preserve transport-vs-setting validation
  before moving anything. An old defaults leaf and a new flat leaf in the same
  source conflict; declarations across sources follow ordinary precedence.
  Keep key arrays, credential fallback order, and secret references unchanged.
- **Background model inheritance:** retain the old shared background model as
  a compatibility-only fallback through merging, below each task's explicit
  old or canonical model. After resolution, materialize it into `heartbeat.model`
  and `compaction.model` only for tasks that inherited it. Check all characters
  and included sources: an included shared fallback must not become an explicit
  task override that masks a task model from an earlier file. If preserving
  source ownership and effective selection requires a manual edit, stop.
- **Heartbeat gates:** keep the two legacy gates separately through legacy
  layering, then compute their AND. Within a layer, a canonical `enabled` cannot
  coexist with either old gate. For mixed layers, canonical `enabled = x` sets
  the legacy pair to `(x, true)` at that point; later legacy declarations update
  their respective component. This defines deterministic precedence without
  conflating heartbeat with compaction. Rewrite automatically only when the
  source-layer transformation preserves that result for the global config and
  every character; otherwise retain the legacy declarations and explain the
  required combined edit.
- **Notification delivery:** retain legacy `enabled` (default false) and
  `backend` (default `notify_send`) through layering. Canonical `via = <driver>`
  sets both the enable gate and driver; `via = "off"` clears the gate without
  changing any remembered legacy driver during compatibility loading. Later
  legacy declarations update their respective component. Same-source `via`
  plus either old selector is a conflict. Only after merging, produce the
  selected driver or `off`. Preserve inactive destination/command settings;
  choosing a driver must not delete another driver's configuration.
- **Notification events:** resolve legacy event booleans with their existing
  defaults, then emit the enabled event names. A canonical list replaces the
  entire selection at its layer, including `[]`; a later legacy boolean changes
  only that event and warns. Never convert a partial old events table into a
  replacement list before its inherited values are known. Check all character
  scopes before rewriting; refuse a conversion that changes their selections.
- **Compaction budget exceptions:** evaluate the old global exception and each
  budget's explicit override after merging, with the existing `per-budget ??
  global ?? false` rule. During the window, a legacy global switch also applies
  to budgets using otherwise canonical keys when their exception is absent;
  warn about this inheritance. Explicit `allow_compaction = false` overrides it.
  Once the legacy global switch is gone, the sole per-budget setting defaults
  to false. Do not guess a budget's format from unchanged fields such as `name`.
  Rewriting legacy budget arrays must preserve each character's effective
  exception. A shared array
  inherited by characters with different global switches cannot be rewritten
  once with one value. Report that conflict and require explicit character
  budget arrays; do not silently flatten inheritance. If no budgets exist,
  dropping a global switch still requires a warning about future budgets.
- **Named-table collisions:** old subagents may be called `model` or `enabled`,
  and an old tool override may use a new reserved scalar name. Read such legacy
  tables during the window, with warnings, but require an explicit rename before
  migration can write the canonical form. Update their grants/references as one
  plan; never discard a definition or grant a replacement automatically. Move
  legacy `tools.web_search` service leaves individually so a new per-tool
  `tools.web_search.timeout` is not mistaken for service configuration.
- **Catalog aliases and transport overrides:** build the identity map from the
  old resolver, check every model selection/profile/preference/thread pin, and
  preserve effective settings and transport. Reject ambiguous merges and any
  unresolvable reference. A nonempty ntfy token always needs manual environment
  provisioning before conversion.

Keep unambiguous old spelling/value aliases in the registry: numeric durations
convert using their current units, thinking replay booleans and `last_turn`
retain their existing meaning, and keepalive's old disabled spellings become
`off`. Preserve zero's existing semantics for disabled tool timeouts and archive
triggers; keepalive intervals/windows stay positive. Dotted CLI keys need the
same quoted-segment parser as TOML map identities.

Redact notification topics as well as tokens in exported plans and fixtures:
an unguessable topic may itself be the credential for a notification channel.
The redacted example is not the text to write back to disk. Preserve the actual
destination bytes when performing a migration.

Unknown fields are errors throughout canonical app, provider, and profile
tables; the currently permissive chat-settings parser is not an escape hatch.
Do not accept obsolete struct-as-array encodings in the canonical surface.
Legacy input that used that parser behavior needs a diagnostic and explicit
table conversion. No migration may silently discard an unrecognized field.

### Migration command and editing boundary

`shore config migrate --config <path>` is a **local, offline** command that
prints a redacted plan/diff by default. `--write` applies a reviewed plan. This
command operates on the machine where those files live; it does not interpret a
remote daemon's paths as local files. It must work when an old configuration
prevents daemon startup. The daemon's check command reports source-specific deprecations using the same registry.
The complete migration plan is generated locally by the offline command.

The existing [toml_edit.ts](../daemon/src/config/toml_edit.ts) is a small
line-oriented setter/remover, not the Rust `toml_edit` crate. It refuses edits
inside inline values, does not identify individual array-of-table elements, and
can discard an assignment's inline comment. It cannot safely perform this whole
migration by composing `unset` and `set` calls.

Use Rust's format-preserving
[`toml_edit::DocumentMut`](https://docs.rs/toml_edit/latest/toml_edit/struct.DocumentMut.html)
for the offline writer, adding the latest stable crate only in the implementation
dependency commit. Consume a versioned machine-readable migration registry
exported from the daemon definitions; do not hand-maintain a second mapping in
Rust. The current crate preserves comments and formatting but documents limits
around dotted-key order and final newlines; those changes must be visible in the
diff, not hidden behind a claim of byte-identical formatting. Reuse its syntax
tree support instead of building another general TOML parser.

The local client obtains semantic plans and validates candidate file contents
through an offline helper mode of the installed daemon executable. That mode
runs the shared loader/resolver and registry without starting a server,
integrations, clocks, or provider calls. Rust owns syntax-preserving edits and
the write transaction; TypeScript owns semantic conversion and validation.
Require matching migration-protocol versions, and report a missing/incompatible
local daemon binary before writing. An exported path map alone is insufficient
to reimplement resolver behavior correctly in a second language.

For each root/include/conf.d/character file and affected preference file:

1. Read without starting integrations or making model calls. Build the complete
   file graph, preserving include order. Reject malformed include directives
   with source diagnostics rather than silently skipping their values.
2. Plan edits in their original owning files. Convert durations and enum aliases,
   move comments with their values, preserve unknown vendor payload contents,
   and list manual actions. Do not fill in all built-in defaults.
3. Validate every candidate file and compare old versus new effective behavior
   across the global config and all characters: selections, sampler settings,
   grants, budgets, background gating, transports, and restart-required values.
   A partial or ambiguous plan makes `--write` fail without changing anything.
4. Check original file hashes before writing. Create permission-preserving
   backups and same-directory temporary files. Do not follow unexpected symlinks
   or overwrite edits made since planning. Redact secrets from terminal output,
   but preserve their bytes in the files and protected backups when needed.
5. Apply while the daemon is stopped, or under a configuration transaction that
   suspends its watcher until all files validate. Individual file renames are
   atomic; a multi-file migration is not. Keep a recovery journal/backups and
   roll back failures, with an exact recovery report if rollback also fails.
6. A second migration produces an empty diff. Do not silently run `--write` on
   daemon startup, `config get`, or package upgrade.

Regular `shore config set` writes canonical keys and preserves source ownership.
If the owning declaration is a legacy alias, replace it in that source as one
validated edit. It must not add a canonical key beside the old one and create a
conflict. A conversion requiring several files or manual work directs the user
to migration rather than guessing. `config get` accepts deprecated paths during
the window and reports the canonical path; current short aliases `model`,
`stream`, and `autonomy.enabled` receive corresponding mapping/removal messages.

## Schema, examples, and implementation acceptance

The current `configSchema()` walks app settings but reports catalog sections as
opaque maps; the starter generator omits named providers. Extend the existing
schema machinery to cover app settings, provider fields, capability profiles,
map templates, and budget/key arrays. Map templates must be discoverable even
when no instance exists, while live completion still offers configured names.

Each canonical option needs a description, reason/default, units and bounds,
scope, restart requirement, enum/completion source, and applicable provider
constraints. Export aliases/removals separately with migration metadata.
Generate a minimal starter containing a working setup, a complete reference,
and representative provider, background, integration, budget, and
character-overlay examples from that metadata. Include at least one quoted
qualified identity and a budget array. Do not expand unused optional sections
into the starter.

Preserve restart requirements when moving paths: the listener, notifications,
Matrix, and cache forensics currently require restart. Do not make every
external-service setting restart-only just because another service requires it.
Audit each existing consumer and keep live-reload behavior stable.

Implementation verification covers the canonical boundary and compatibility
reader (`config_surface.test.ts`), source ownership and live commands
(`config_commands.test.ts`, `config_liveness.test.ts`), and semantic migration
across includes, characters, budgets, preferences, favorites, and thread pins
(`config_migration.test.ts`). Rust writer tests cover comments, quoted identities,
inline/dotted keys, arrays of tables, permissions, backups, concurrent edits,
and rollback after a later write fails. The generated reference and examples
have a regeneration/parse check.

An isolated real daemon/CLI run also exercises check/schema/completion, quoted
config get/set, edits to the owning include, background model selection, saved
model settings, tool execution, offline planning, refusal to write while a daemon
owns the data directory, successful migration, and an unchanged second run.
The existing daemon and Rust suites continue to cover provider adapters,
heartbeat, compaction, budget enforcement, and command consumers.

Before publishing the first stable release, fill in its actual release identifier
and the earliest removal date in the release notes. Keep the minimum 180-day and
two-subsequent-stable-release window above; development does not start that clock.
The later removal release must retain actionable tombstones and the offline legacy
reader. These are release follow-ups, not startup rewrites of existing deployments.

The reviewed design and dependency changes landed in separate commits. Keep the
public rename, compatibility reader, offline writer, and documentation together
in the first release. Run every verification command in `AGENTS.md` before the
implementation commit.

## Baseline for this proposal

Reviewed on 2026-09-20 against `bf450f70`, after running the required update
commands. Bun 1.4.2, Rust/Cargo 1.98.1, rustup 1.29.1, cargo-edit 0.13.13,
cargo-sweep 0.8.0, and sccache 0.18.0 are the current stable tools checked here.
`bun update --latest`, `bun install`, `cargo upgrade --incompatible`, and
`cargo update` made no manifest or lockfile changes.

One transitive update is blocked: `crypto-common 0.1.7` requires exactly
`generic-array 0.14.7` through `digest 0.10.7`, `sha2 0.10.9`, `termwiz 0.23.3`,
and `ratatui-termwiz 0.1.2`. Selecting `generic-array 0.14.9` fails that upstream
constraint. Direct dependencies were not held back; the existing lockfile keeps
0.14.7 until its upstream dependency permits an update.

The baseline passed daemon lint, comment/citation checks, typecheck, all 8,072
tests, all 54 stale-mutation passes, capture re-record checking (three captures,
no changes), and build. Rust workspace tests passed (1,227 passed, 14 ignored),
as did formatting and Clippy. This verifies the pre-redesign baseline, not the
proposed parser or migration behavior.

An isolated daemon and the built Rust CLI also confirmed two user-visible
problems: `shore config keys --json` reports the four catalogs only as opaque
maps, and `shore config get memory.file_limits --json` reports configured
one-byte ceilings while `shore debug tool bash` can write a six-byte memory
note successfully. The instance used temporary config/data/workspace directories
and no external model calls. All proposal examples parse as TOML, all relative
links resolve, and all 103 current app leaf patterns have explicit disposition
rows; provider/model settings are inventoried separately above. The revised main
example and five provider definitions were compared against the inspected
declarations with personal names and notification destinations replaced. This
checks the completeness of the sketch, not an implemented migration engine.
