# Invariants asserted in prose, now deleted

Pass 2: decide which of these become a test or an assert.

## src/time.ts:1

```
/**
 * RFC 3339 with the local UTC offset, matching `chrono::Local::now().to_rfc3339()`.
 *
 * The daemon stamps message timestamps, segment manifests and deferred-edit
 * entries in local time rather than UTC, so anything that writes one of those
 * needs this exact shape.
 *
 * Deliberate divergence: the Rust emits nanosecond precision, JavaScript only
 * has milliseconds, so this writes three fractional digits where the Rust wrote
 * nine. Padding with six zeros would claim a precision that is not there.
 * Nothing parses this field — `engine/segments.ts` carries it as an opaque
 * string and the message store never reads it back as a date.
 *
 * This lived privately in `memory/deferred_edits.ts` and `memory/compaction_writer.ts`,
 * character-identical in both. `commands/conversation.ts` would have been the
 * third copy.
 */
```

## src/instances.ts:1

```
/**
 * Which daemons are running, and where to reach them.
 *
 * Ported from `crates/daemon/src/swp_server/registry.rs`. Named for what it
 * holds rather than where the Rust filed it — this is daemon discovery, not
 * part of the SWP protocol, and "registry" is already three other things here.
 *
 * One JSON file at `$SHORE_RUNTIME_DIR/instances.json`, written by a daemon at
 * startup and shutdown, and read by every CLI that needs to find one. The
 * entries carry the resolved data and config directories so a client can read
 * the same ledger and the same `config.toml` without being told where they are.
 *
 * # Dead entries prune themselves
 *
 * A daemon that is killed never unregisters, so every operation — including
 * `list` — first drops entries whose PID is gone. That is why a read can write:
 * the alternative is a registry that fills with corpses and a client that
 * dials one.
 *
 * The liveness probe is signal 0, which asks the kernel about a PID without
 * sending anything. It has three answers, not two: alive, dead, and *unknown*
 * — a PID owned by another user answers `EPERM`, which means it exists. Only a
 * definite `ESRCH` prunes.
 *
 * # The lock is not the Rust's lock
 *
 * The Rust holds `flock` on a stable sidecar file for the whole
 * read-modify-write. There is no portable `flock` here, so this uses the other
 * classic: an exclusively-created lock file, whose *existence* is the lock.
 *
 * The two differ in exactly one way and it is the one that matters. `flock` is
 * released by the kernel when the process dies; a lock file is not, so a daemon
 * killed mid-write would wedge every later reader forever. {@link STALE_LOCK_MS}
 * is the answer: a lock older than that is assumed abandoned and broken. It is
 * generous, because breaking a lock someone still holds is the failure this is
 * trying to prevent, and a write here takes microseconds.
 */
```

## src/instances.ts:55

```
/** One daemon instance, exactly as it appears in the file. */
```

## src/instances.ts:113

```
// Always dirty: a re-registration with identical fields still has to
```

## src/instances.ts:114

```
// reach disk, because the previous entry may have been pruned as dead
```

## src/instances.ts:171

```
// — a crash between `open` and `write` leaves exactly this.
```

## src/instances.ts:181

```
/**
   * Write via a sibling temp file and a rename.
   *
   * Beside the target rather than in a temp directory, because `rename` is only
   * atomic within one filesystem. `fsync` before the rename so a machine that
   * loses power finds either the old file or the new one, never a renamed
   * length of zeroes.
   */
```

## src/instances.ts:224

```
/**
 * Whether an entry with this liveness goes.
 *
 * A named decision rather than a comparison in the filter, because the answer
 * is three-way and only one of the three prunes. `unknown` — a probe that
 * failed for its own reasons — leaves the entry alone: deleting a daemon
 * because the kernel would not answer a question about it is the failure this
 * whole probe exists to avoid.
 */
```

## src/instances.ts:237

```
/**
 * Take the lock, and answer with how to release it.
 *
 * `wx` fails if the file exists, which is the whole mechanism: creation is
 * atomic, so exactly one caller can succeed. Waiting is a sleep-and-retry loop
 * because there is nothing to block on — and a lock whose file is older than
 * {@link STALE_LOCK_MS} is broken rather than waited on, since its holder is
 * the one thing that cannot tell us it died.
 */
```

## src/instances.ts:284

```
/**
 * Whether a PID names a live process.
 *
 * Signal 0 checks existence and permission without delivering anything.
 * `EPERM` is a *live* process owned by someone else, so only `ESRCH` counts as
 * dead — anything else is unknown and is left alone, because pruning on a
 * probe that failed for its own reasons deletes a running daemon.
 */
```

## src/instances.ts:294

```
/**
   * The probe. A parameter because the third branch is otherwise unreachable
   * from a test — signal 0 on a real PID only ever answers `ESRCH` or `EPERM`
   * — and what it decides is whether an unrecognised failure deletes a running
   * daemon from the registry.
   */
```

## src/call_store.ts:1

```
/**
 * Unified, compressed, queryable store for the daemon's observability records.
 *
 * Two kinds of record share one SQLite database:
 *
 * - **calls** — the raw provider request/response for *every* LLM call (chat,
 *   tool loops, heartbeat, dreaming, compaction, …). Each payload is stored as
 *   a zstd-compressed blob; the repeated prompt context across calls compresses
 *   away, so the on-disk footprint is a fraction of the raw bytes.
 * - **transcripts** — the curated, readable heartbeat/dreaming view (reasoning,
 *   tool I/O, the model/provider that served the call), stored as a compressed
 *   JSON blob.
 *
 * Retention is time-based ({@link CallStore.rotate} deletes rows older than a
 * cutoff) with a total-size backstop that evicts oldest-first. The store is
 * observability only — never authoritative conversation state — and lives in
 * the cache dir.
 *
 * The Rust this came from guards the connection with a mutex and recovers the
 * guard on poison. There is nothing to guard here: `bun:sqlite` is synchronous
 * and this process has one thread, so a statement cannot be interleaved with
 * another. `busy_timeout` still matters, because a *second process* — the
 * Rust CLI reading the same file — is a real writer.
 */
```

## src/call_store.ts:194

```
// auto_vacuum must be set before the schema is created to take effect on
```

## src/call_store.ts:218

```
/**
   * The open handle, for schema inspection. The store owns exactly one
   * connection per path, and a second `Database` on the same file would race
   * this one's WAL — so anything that needs to read `PRAGMA table_info` or
   * `sqlite_master` borrows this rather than opening its own.
   */
```

## src/call_store.ts:295

```
/**
   * Return call summaries (newest first) matching `filter`. A nullish field
   * matches everything; `limit === 0` means no limit.
   *
   * The `id DESC` tiebreak is deliberate and untestable. Two calls recorded in
   * the same second are common — a tool loop makes several — and without a
   * second sort key their relative order is whatever the query plan happens to
   * produce. Every plan SQLite picks here happens to produce descending rowid
   * already, so no test can tell the tiebreak from its absence; it is written
   * down because "whatever the plan happens to produce" is not a contract.
   */
```

## src/call_store.ts:381

```
/**
   * Prune rows older than `cutoff`, then evict oldest call rows until the total
   * compressed blob size is at or under `maxTotalBytes`. Reclaims freed pages so
   * the on-disk size actually shrinks. The newest call row is always kept, even
   * if it alone exceeds the cap (payloads are never truncated).
   */
```

## src/call_store.ts:397

```
// `(ts_unix, id)`) is excluded from the delete set so it is always kept,
```

## src/call_store.ts:507

```
/**
 * The stored `ts`, spelled the way `DateTime<Utc>::to_rfc3339` spells it.
 *
 * Two differences from `toISOString`, and both are visible in `call_log`
 * output because the string is stored verbatim and handed back unparsed. The
 * offset is `+00:00` rather than `Z`. And the fraction is omitted when it is
 * zero and printed otherwise — chrono's `AutoSi` picks 0, 3, 6 or 9 digits,
 * and a `Date` only ever has 3, so matching it means dropping `.000` and
 * keeping everything else.
 */
```

## src/call_store.ts:559

```
/**
 * Bring an existing on-disk schema up to current.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters a table that already exists, so a
 * column added to {@link SCHEMA} after a DB was first created stays invisible to
 * that DB forever — both reads and writes that name the column then fail. Each
 * step here is idempotent: a fresh DB built straight from `SCHEMA` already has
 * these columns, so the guards make migration a no-op. Add future column
 * additions here, not just to `SCHEMA`.
 */
```

## src/call_store.ts:585

```
/**
 * Whether `table` has a column named `column`. `table` is always a hardcoded
 * schema identifier here, never user input, so interpolating it into the
 * `PRAGMA` (which cannot bind identifiers) is safe.
 */
```

## src/transcript_capture.ts:1

```
/**
 * The curated transcript a background tool loop leaves behind.
 *
 * Ported from `crates/daemon/src/transcript_capture.rs`.
 *
 * The `calls` rows already hold every LLM call's request and response, so this
 * looks redundant and is not. Tool *outputs* live in the *next* call's request,
 * in whatever wire shape that provider wanted — reconstructing them on read
 * means re-deriving one provider's dialect from another's. A background loop has
 * each result in normalized form at the moment it dispatched it, so it writes
 * one curated entry per call instead: the reasoning, the visible text, and each
 * tool call paired with its full output. `shore log --heartbeat` reads these.
 *
 * Best-effort throughout. A transcript is something a person reads afterwards,
 * and failing a heartbeat because its diary entry would not write is the wrong
 * trade every time.
 */
```

## src/transcript_capture.ts:38

```
/**
 * Split a response into the three things a reader wants.
 *
 * Blank thinking is dropped and redacted thinking becomes a placeholder, so the
 * reasoning list says "the model thought here and you may not see it" rather
 * than going silently empty. Text blocks join with newlines because a provider
 * may split one paragraph across several, and `tool_use` blocks are skipped —
 * their content arrives via `tools`, with the output the response itself does
 * not carry.
 */
```

## src/characters.ts:1

```
/**
 * The character registry: which characters exist, and one live conversation
 * engine per character.
 *
 * Port of `crates/daemon/src/characters.rs`, pinned by
 * `tests/engine_fixtures/characters_parity.json`.
 *
 * Almost everything here is a **cache**, and every one of them has different
 * invalidation rules. That is the whole module, and it is why the fixture is
 * scripted runs rather than single calls:
 *
 * | cache | filled by | invalidated by |
 * |---|---|---|
 * | `#available` | construction | `refresh`, `reloadRuntimeState` |
 * | `#engines` | first `getOrCreate` | `reloadRuntimeState`, and only for characters that vanished |
 * | `#charConfigs` | first `effectiveConfig` | `invalidateConfigs`, `setGlobalConfig`, `reloadRuntimeState` |
 *
 * The per-character config cache stores its own **absence** — a character with
 * no `config.toml` caches "no override", so writing that file afterwards
 * changes nothing until something invalidates. That is deliberate in the Rust
 * and reproduced here; it is also the single most surprising thing in the file.
 *
 * # Two directories that are assumed equal and are not checked
 *
 * Discovery walks {@link CharacterRegistry}'s own `configDir`. Per-character
 * overrides are looked up under `globalConfig.dirs.config`, because that is
 * what `loadCharacterConfig` takes. They are the same directory everywhere in
 * production and nothing enforces it — hand `setGlobalConfig` a config loaded
 * from elsewhere and overrides silently stop being found while every character
 * stays available. Pinned rather than fixed: the daemon does not do it, and
 * "fixing" it here would put the port out of step with the Rust for a case
 * that cannot arise.
 */
```

## src/characters.ts:139

```
/**
   * Scan for characters and prepare each one's workspace.
   *
   * A static factory rather than a constructor because preparing the workspace
   * is asynchronous here — the Rust did it with blocking I/O inside `new`.
   * `onHistory` replaces the Rust's `broadcast::Sender<ServerMessage>`, which
   * the registry only ever cloned into new engines.
   */
```

## src/characters.ts:158

```
/**
   * Re-scan and prepare every character found.
   *
   * A failed workspace preparation is logged and skipped, not thrown: one
   * unwritable character directory must not stop the daemon seeing the others.
   */
```

## src/characters.ts:206

```
/**
   * The engine for a character, created on first use and cached after.
   *
   * The Rust returned `Arc<Mutex<ConversationEngine>>` and callers held the
   * lock across a whole turn. There is no data race to prevent here, but the
   * mutual exclusion was doing real work: it stopped two turns for the same
   * character interleaving at an `await`. **Whoever drives a turn has to
   * serialize it** — the registry hands out a shared engine and does not do it
   * for them. Left to the caller rather than invented here, because no caller
   * has been ported yet and the shape of that serialization is theirs to pick.
   */
```

## src/characters.ts:247

```
/**
   * The config a character runs under: its merged override if it has one, the
   * global config otherwise. Cached either way.
   *
   * Membership is not checked. `effectiveConfig` on a character that does not
   * exist returns the global config rather than throwing, and caches that —
   * which is what makes it safe to call before resolution has happened.
   *
   * A character config that fails to load is a **warning**, and the character
   * falls back to the global config. It is not fatal, and the failure is
   * cached like any other miss, so the file is not re-read on every turn.
   */
```

## src/characters.ts:278

```
/**
   * Pin an in-memory config for one character, outranking its file.
   *
   * Deliberately never written back to disk: this is how runtime config
   * commands take effect, and `invalidateConfigs` is how they are undone.
   */
```

## src/characters.ts:332

```
/**
   * Pick a character: the requested one if it exists, or the only one if there
   * is exactly one and none was requested.
   *
   * An empty string is a *request*, not an absence, and fails as not-found —
   * `Option<&str>` distinguishes them and so does this.
   */
```

## src/characters.ts:352

```
/**
 * Rust's `Vec<String> != Vec<String>` — positional, not a set compare.
 *
 * Written positionally because that is what the Rust does, though on these
 * inputs the two cannot disagree: `discoverCharacters` sorts and directory
 * names are unique, so two equal-length lists with equal contents are equal
 * element-wise. A mutant that swaps this for a set compare is an unkillable
 * equivalent, and is left in the harness saying so rather than deleted.
 */
```

## src/runtime.ts:1

```
/**
 * Everything the daemon builds once, before it serves anything.
 *
 * Ported from the assembly half of `crates/daemon/src/main.rs` —
 * `create_runtime_dirs`, `build_llm_client`, `build_autonomy_manager`, the
 * `CharacterRegistry`/`McpRegistry` construction inside
 * `build_server_and_handler`, and `spawn_call_store_rotation`.
 *
 * # Why this is a module rather than a few lines in `serveSidecar`
 *
 * Because the pieces are mutually dependent and the order is load-bearing in
 * ways nothing checks:
 *
 * - The **ledger file has to exist** before the first call is recorded.
 *   `ledgerFor` memoises a failed open, so a missing file is not one lost row —
 *   it is every row for the life of the process, and `shore usage` reporting a
 *   quiet month is the only symptom.
 * - The **MCP registry is built before the autonomy service**, because a
 *   heartbeat's tool surface has to be the one chat sees. A background tick
 *   offering fewer tools than the foreground writes a prompt prefix the next
 *   chat turn cannot reuse — the keepalive then pays for a cache write and buys
 *   nothing. This is the same reason `handler/context.ts` makes `mcpToolDefs` a
 *   thing its caller has to state.
 * - The **keepalive is built before the cache**, because arming is what reads
 *   the cadence off a body, and the cache is what does the arming.
 *
 * # Assembly here, clocks in {@link startRuntimeClocks}
 *
 * Building this runs I/O — it opens files and connects MCP servers — but it
 * starts no timers and registers no observers. Those are a *server's* effects,
 * and the split is the same one `serveSidecar` already made for the keepalive:
 * a runtime that merely exists should not be ticking.
 */
```

## src/runtime.ts:74

```
/** Provider adapters by sdk. Required, because the caller owns the table. */
```

## src/runtime.ts:97

```
/**
   * The file the daemon was pointed at, which every reload re-reads exactly.
   *
   * Resolved rather than passed through: `--config` re-homes the whole config
   * directory, so with no flag this is `<config>/config.toml` *after* the
   * loader has decided where `<config>` is. A reload that guessed instead would
   * quietly re-resolve XDG and could read a different file than startup did.
   */
```

## src/runtime.ts:108

```
/**
   * The live MCP registry, behind a holder so a `[mcp]` reload can swap it
   * (#28). Read it as `runtime.mcp.current` at the moment you need it, never
   * once into a long-lived object — that is what made the section unreloadable.
   */
```

## src/runtime.ts:212

```
/**
 * Start the three clocks and the ledger observer.
 *
 * Separate from assembly because these are what make a runtime *run*: the
 * keepalive spends money on a schedule, the autonomy tick starts heartbeats,
 * and the rotation pass deletes rows. A test that wants a registry and a cache
 * should not inherit any of them.
 */
```

## src/runtime.ts:237

```
/**
 * The executor's notifications, each bound to the event that gates it.
 *
 * Named functions rather than lambdas at the call site because the event name
 * *is* the decision: `[notifications.events]` has a toggle per event, and a
 * message filed under the wrong one obeys a switch the user set for something
 * else. The Rust chose per call site and so do these — `AutonomousMessage` at
 * `manager.rs:1837` for a delivered heartbeat message, `CompactionComplete` at
 * `manager.rs:625` for the deep archive's pure-archive arm.
 *
 * Idle compaction gets neither, and that is the port rather than a gap: its
 * notification is fired from *inside* the pass, where the "ran but wrote no
 * memory" outcome exists. See `memory/compaction/run.ts`.
 */
```

## src/runtime.ts:281

```
/**
 * Open the payload store, or carry on without capture.
 *
 * Capture is always on when it can be: every LLM call is recorded to the
 * compressed, bounded store behind `shore log`. A store that will not open
 * disables capture and never blocks the daemon.
 */
```

## src/runtime.ts:300

```
/**
 * Make sure the ledger file and its schema exist, then let go of it.
 *
 * Opened and closed rather than held: every reader and writer goes through
 * `ledgerFor`, which opens lazily and memoises. What this call is for is the
 * *creation* — `Ledger.open` refuses a file that is not there, and a recorder
 * that finds nothing caches the failure and silently stops billing.
 */
```

## src/runtime.ts:317

```
/**
 * `[mcp]` as the registry wants it.
 *
 * Exported because the reload path compares against it: `matchesConfig` is only
 * honest if both sides were built the same way, and a second transcription of
 * this loop is how the comparison starts reporting a change that is not one —
 * which would respawn every stdio child on an unrelated config edit (#28).
 */
```

## src/runtime.ts:351

```
/**
 * The tool backends that do not depend on which character is talking.
 *
 * Exported because this *is* the background turn's whole tool context and it is
 * also the base a chat turn extends (`handler/deps.ts` adds the two
 * per-character ones). Shared rather than written twice: the two paths' tool
 * surfaces have to agree, and the cheapest way for them to disagree is for one
 * of them to grow a backend the other did not.
 *
 * Two fields a chat turn wants are absent here, and both for the same reason:
 * **`activityStats` and `deferEdit`** are per-character, and this object is
 * shared. The Rust's `build_tool_context` for a heartbeat set neither, so
 * their absence from a background tick is the port rather than a gap.
 *
 * `runSubagent` *is* here, and it is the background flavour — the Rust's
 * `SubagentRuntime::background`. No client channel, because a tick has no live
 * turn to stream a nested loop into, and no conversation tail, so
 * `{{active_history:}}` degrades to nothing. The sub-agent still runs and still
 * returns its summary. A chat turn replaces it with one bound to its own
 * session; compaction strips it, which is the Rust's rule and is why `ask_*`
 * answers `NotImplemented` there.
 */
```

## src/runtime.ts:384

```
// background executor and would otherwise pin whatever registry existed at
```

## src/diagnostics.ts:74

```
/**
   * `Option<String>` in the Rust, and both spellings of "none" arrive.
   *
   * `handler/persistence.ts` writes an explicit `null` on the success path
   * because it builds the row in one literal; a failure path that never set the
   * field leaves it absent. {@link omitAbsent} erases the difference before
   * anything reads it, so the two are the same row — accepting both here is
   * what says that out loud rather than making one caller pick.
   */
```

## src/diagnostics.ts:103

```
/**
 * One credential-fallback rotation event for the multi-key path.
 *
 * Recorded whenever the daemon abandons a configured provider key on a
 * classified credential failure (missing/invalid/quota/budget/account rate
 * limit). The payload intentionally never carries the API key value or the env
 * var contents — only the friendly key names plus status/reason metadata.
 */
```

## src/diagnostics.ts:125

```
/** Sanitized reason. Never contains secrets. */
```

## src/notifications.ts:1

```
/**
 * Push notifications for autonomous events.
 *
 * Port of `crates/daemon/src/notifications.rs` plus the `[notifications]`
 * subtree of `crates/common/src/config/app.rs`. Three backends: `notify-send`
 * (Linux desktop), ntfy (mobile push), and a user shell command template.
 *
 * Dispatch is fire-and-forget by design — a notification that fails must not
 * disturb the generation that triggered it, so every delivery error is logged
 * and dropped.
 */
```

## src/notifications.ts:39

```
/**
 * Per-event toggles.
 *
 * The doc comment on the Rust struct says "All default to true (fire when
 * enabled)". Five of the six do. `message_complete` is `#[serde(default)]` on a
 * `bool`, so it defaults to **false** — every ordinary chat reply would
 * otherwise raise a desktop notification. The comment is stale; the defaults
 * below are what the code does.
 */
```

## src/notifications.ts:62

```
/** Only fire `message_complete` when generation took longer than this.
   *  Zero means always. */
```

## src/notifications.ts:122

```
/**
 * How serde phrases the accepted set for `deny_unknown_fields` and for an
 * unknown enum variant. Shared with `config/providers.ts` in spirit but not in
 * code — that copy is private to its module and the two lists never overlap.
 *
 * That copy also carries a two-field branch (`` `a` or `b` ``), which this one
 * does not: nothing in the `[notifications]` subtree has exactly two fields, so
 * the branch was unreachable and mutation testing could not tell it from its
 * own absence. Add it back alongside the first two-field table.
 */
```

## src/notifications.ts:141

```
/**
 * The first unknown key, in **document order**.
 *
 * Not code-point order, which is what the model catalog and provider registry
 * use — and the difference is the parse path, not a disagreement. Those two
 * receive a materialized `toml::Table`, which is a `BTreeMap`, so iterating it
 * sorts. This section is deserialized straight off the document by
 * `toml::from_str`, which visits keys as it reads them, so `zzz` before `aaa`
 * reports `zzz`. Pinned both directions in the fixture, because getting it
 * backwards is invisible until a config has two unknown keys.
 */
```

## src/notifications.ts:305

```
// always in range.
```

## src/notifications.ts:313

```
/**
 * Escape a string for embedding in a single-quoted shell argument.
 *
 * `'` becomes `'\''` (end quote, escaped quote, re-open), backticks are
 * dropped, and `$(` is defanged to `(`.
 *
 * Two things this deliberately does not do, both inherited:
 *
 * * It does **not** wrap the result in quotes, despite the Rust doc comment
 *   saying it does. The `{title}`/`{body}` placeholders are substituted into
 *   the user's own template, and the template supplies the quoting — that is
 *   why the `'` escaping is written for a single-quoted context.
 * * It leaves `;`, `&`, `|`, `>` and newlines alone. Inside the single quotes
 *   the template is expected to provide, none of them are metacharacters, and
 *   the quote escaping is what keeps content from escaping that context. A
 *   template that omits the quotes is a template that runs its own content;
 *   this function is defence in depth, not the boundary.
 *
 * Rust's `str::replace` replaces *every* occurrence. JavaScript's
 * `String.replace` with a string pattern replaces only the first, so all three
 * of these must be `replaceAll` — a single backtick left behind is the whole
 * difference between escaped and not.
 *
 * The backtick pass must precede the `$(` pass: removing a backtick can *create*
 * a `$(` that was not in the input (`` $`( ``). The quote pass is order-free
 * against both — `'\''` contains no backtick and no `$` — so only that one pair
 * is load-bearing, and mutation testing agrees.
 */
```

## src/notifications.ts:434

```
/**
   * Fire-and-forget dispatch. Returns immediately; delivery happens on its own
   * and its failures are logged, never raised.
   */
```

## src/notifications.ts:446

```
/**
   * Fire a `message_complete` notification, but only when generation took at
   * least as long as the configured threshold. A threshold of zero always
   * notifies — the comparison is skipped rather than trivially true, so a
   * generation that reported `0 ms` still fires.
   */
```

## src/notifications.ts:457

```
/**
   * The threshold half of {@link notifyMessageComplete}, separated so it can be
   * checked without dispatching.
   *
   * The zero test is redundant — `totalMs >= 0n` is already always true — and it
   * is kept because the Rust carries the same redundancy (`threshold_ms > 0 &&
   * total_ms < threshold_ms`), where it reads as the documented "0 means always
   * notify". Mutation testing duly finds it unkillable.
   */
```

## src/memory/markdown_store.ts:1

```
/**
 * The markdown memory store — a character's memory as inspectable files.
 *
 * Ported from `crates/daemon/src/memory/markdown_store.rs`, pinned by
 * `tests/memory_fixtures/markdown_parity.json`.
 *
 * There is no database. Memory is `characters/{name}/workspace/memory/` and
 * every entry is a plain markdown file — no frontmatter, no index, no schema.
 * The model chooses the filenames and the folder structure; this module only
 * confines them to the directory and reads them back.
 *
 * # What is deliberately invisible
 *
 * `listAll` and therefore `searchText` skip four names at the *top level*:
 * `.dreams/`, `dreaming/`, `dreams.md` and `memory.md`. Those are the dreaming
 * subsystem's own scratch space and the curated index, and surfacing them in
 * retrieval would feed the model its own notes about its notes. The check
 * looks at the first path component only, so `topics/dreams.md` is an ordinary
 * memory file — the fixture pins both halves of that.
 *
 * `read`, `write` and `delete` do *not* apply the filter. `MEMORY.md` has to
 * be writable by name; it is only retrieval that hides it.
 *
 * # Confinement
 *
 * Every entry point routes its caller-supplied path through {@link resolve},
 * which refuses `..`, absolute paths, and anything whose resolved location
 * leaves the store — including via a symlink, checked against the nearest
 * existing ancestor so a file that does not exist yet cannot skip the check.
 * `listAll` re-checks on the way out, since a symlink planted inside the store
 * is reached by walking rather than by naming.
 */
```

## src/memory/markdown_store.ts:49

```
/**
 * Top-level names retrieval never returns.
 *
 * The Rust compared with `to_ascii_lowercase`. Plain `toLowerCase` is used
 * here because the two cannot disagree while every name in this list is ASCII:
 * a lowercase form only reaches one of them if the input was ASCII already.
 * Adding a non-ASCII name would break that, and would need the narrower fold.
 */
```

## src/memory/markdown_store.ts:101

```
/**
 * `chrono`'s `DateTime::to_rfc3339` on a local timestamp.
 *
 * The fractional second follows chrono's `AutoSi`: omitted entirely when the
 * time lands on a whole second, otherwise three digits. Coarse filesystems do
 * produce whole-second mtimes, so the zero case is reachable and worth
 * matching rather than always printing `.000`.
 *
 * Deliberate divergence: chrono prints six or nine digits when the timestamp
 * has sub-millisecond precision, and JavaScript's `Date` has none to print.
 * Nothing parses this field — it is displayed — so the shape is what matters.
 */
```

## src/memory/markdown_store.ts:162

```
/** Always canonical: confinement compares resolved paths on both sides. */
```

## src/memory/markdown_store.ts:237

```
/**
   * Delete an entry, and its parent directory if that leaves it empty.
   *
   * The prune goes exactly one level and never touches the store root. An
   * emptied grandparent is left behind — reproduced rather than deepened,
   * because a recursive prune racing a concurrent `write` into a sibling
   * directory is a worse failure than a stray empty folder.
   */
```

## src/memory/markdown_store.ts:262

```
/**
   * Ranked text search across every entry.
   *
   * Deliberately crude — substring counting, no index, no embeddings — so that
   * markdown-only retrieval works without a shadow database to keep in sync.
   * The score itself is never returned; only the resulting order is
   * observable, which is why the fixture leans on a case where two entries tie
   * and break on path.
   */
```

## src/memory/markdown_store.ts:369

```
// `join` normalizes, unlike Rust's `Path::join`. Safe only because the
```

## src/memory/markdown_store.ts:377

```
/**
   * Refuse a resolved path that leaves the store.
   *
   * When the target does not exist — which `write` relies on — the check moves
   * up to the nearest ancestor that does. A symlinked parent directory escapes
   * exactly as well as a symlinked file, and checking only the leaf would miss
   * it. Walking off the top of the filesystem without finding anything
   * resolvable is not an error; it means the store root itself is gone, and
   * the subsequent operation reports that better than this would.
   */
```

## src/memory/markdown_store.ts:412

```
/**
 * Score one entry against a lowercased query and its terms.
 *
 * Path beats heading beats body, and the whole query counts for far more than
 * any single term. A heading match implies a body match — the heading is a
 * line of the body — so the reachable totals are sparser than the six weights
 * suggest, and swapping the heading and body weights is invisible on any
 * entry that matched in the heading. The fixture's eleven-entry case is built
 * around the few arrangements where it is not.
 *
 * The score itself never leaves this function, so a small numeric change to
 * any one weight cannot be observed at all. What the fixture does pin is that
 * none of the six is dropped and no pair of them is transposed.
 */
```

## src/memory/compaction_writer.ts:1

```
/**
 * The writer half of compaction — the side that freezes conversation history.
 *
 * Ported from `RealConversationManager` in
 * `crates/daemon/src/memory/compaction_impls.rs`, pinned by
 * `tests/memory_fixtures/compaction_writer_parity.json`.
 *
 * `engine/segments.ts` is the reader and landed first, deliberately, with a
 * note that its writer "still lives in Rust and moves with the memory module".
 * This is that move: `compaction.json` and `segments/` are now written by
 * TypeScript, and #12's ownership rule is satisfied for both files.
 *
 * # This never parses a message
 *
 * `archiveAndRetain` is line-based from end to end. It splits `active.jsonl`
 * on newlines, moves a prefix of those lines into a segment file, and writes
 * the rest back. A line that is not valid JSON is carried across verbatim —
 * the fixture pins `not json at all` and a truncated `{"unclosed":` surviving
 * into a segment untouched. That is deliberate in the Rust and worth keeping:
 * compaction must not be able to destroy a message it merely failed to parse.
 *
 * # The manifest counts segments, not files
 *
 * The next segment number comes from `manifest.segments.length + 1`, so a
 * manifest that disagrees with what is on disk will overwrite an existing
 * segment rather than skip past it. Reproduced rather than fixed: the manifest
 * is the authority on the reader side too, and making the writer scan the
 * directory instead would make the two halves disagree about what exists.
 */
```

## src/memory/compaction_writer.ts:147

```
/**
   * Move all but the last `keepLastN` messages into a new segment.
   *
   * Returns a fresh conversation id. The Rust returned a v4 UUID and no caller
   * derives anything from it, so this does the same.
   *
   * Ordering is load-bearing: the segment and the manifest are written before
   * `active.jsonl` is truncated. A crash between them re-archives on the next
   * pass, which is recoverable; the reverse order would drop messages.
   */
```

## src/memory/compaction_writer.ts:162

```
// The clamp is load-bearing, not defensive. Without it a `keepLastN` above
```

## src/memory/markdown_query.ts:30

```
/**
 * Count the store's files by bucket.
 *
 * `daily/` and `images/` are prefixes, so `daily.md` and `sub/daily/x.md` are
 * both topic files. Everything that is not one of the two folders counts as a
 * topic, which means the three buckets always sum to the total.
 */
```

## src/memory/markdown_query.ts:64

```
/**
 * The first `limit` characters of `text`.
 *
 * Characters, not UTF-16 code units: Rust counts `char`s, so a limit of 2 over
 * `"🌊🌊🌊"` yields two emoji, where `text.slice(0, 2)` would yield one. The
 * fixture pins exactly that case.
 */
```

## src/memory/markdown_query.ts:100

```
// could never have matched anyway. Mutation testing confirms removing it
```

## src/memory/markdown_query.ts:114

```
// anyway. Kept because the window should be well formed where it is
```

## src/memory/markdown_query.ts:123

```
// always contains the line that just matched, and that line is non-blank
```

## src/memory/markdown_query.ts:124

```
// by the check above, so the filter can never remove everything. Mutation
```

## src/memory/markdown_query.ts:125

```
// testing found the guard unkillable, which is what sent me looking.
```

## src/memory/lines.ts:9

```
/**
 * Split like Rust's `str::lines()`.
 *
 * Three differences from a plain `split("\n")`, all of them observable:
 *
 * 1. A trailing `\r` is stripped, so a CRLF file yields the same lines as an
 *    LF one. Without this the `\r` rides along into every downstream trim,
 *    comparison and excerpt.
 * 2. A trailing newline does *not* produce an empty final element — `"a\n"` is
 *    one line, not two. This is load-bearing wherever line *count* matters,
 *    and it is why `excerptForQuery`'s window does not run off the end.
 * 3. An empty string is zero lines, not one.
 *
 * Interior blank lines are kept. Rust keeps them and the excerpt logic depends
 * on seeing them: `"a\n\nb"` is three lines, and its middle one is skipped by
 * name rather than by never existing.
 */
```

## src/memory/lines.ts:32

```
/**
 * The characters Rust's `str::trim*` family strips: the Unicode `White_Space`
 * property, which is exactly what `char::is_whitespace` tests.
 *
 * JavaScript's own `trim` uses a *different* set, and it differs in both
 * directions:
 *
 * - It strips **U+FEFF**, the byte-order mark, which Rust leaves alone. A file
 *   saved with a BOM therefore looks like it begins with its heading to JS and
 *   like it begins with a stray character to Rust — a 50-point swing in the
 *   lexical score, since the heading weight never applies.
 * - It does *not* strip **U+0085** (NEL), which Rust does.
 *
 * Both cases are pinned; neither is hypothetical, as a BOM is what several
 * Windows editors write by default.
 */
```

## src/memory/workspace_index.ts:177

```
/**
 * Walk the workspace, refresh the embedding index, and rank files by
 * `combinedScore`. Files with no signal at all are dropped.
 *
 * Concurrent calls against the same index file serialize; different characters
 * hold different locks and do not block each other.
 */
```

## src/memory/workspace_index.ts:203

```
// otherwise redo the same prune and re-mark the same skips.
```

## src/memory/workspace_index.ts:235

```
/**
 * Per-index-path serialization of the load → mutate → save sequence.
 *
 * A single-threaded event loop is not enough on its own: `hybridSearch` awaits
 * between reading the index and writing it, so a heartbeat tick and a user
 * message can interleave and lose one of their updates.
 *
 * Entries are never removed, matching the Rust's `DashMap`. The map holds one
 * settled promise per character, and deleting on the way out would risk
 * dropping a lock a caller had already queued behind.
 */
```

## src/memory/workspace_index.ts:308

```
/**
 * Read each candidate's content and work out which need a fresh embedding.
 *
 * Freshness is the `(size, mtime, model, char cap)` tuple — no content hash.
 * The miss case is an editor that preserves mtime across a content change;
 * agent edits through `write`/`edit` always bump it, and any later real edit
 * self-corrects.
 */
```

## src/memory/workspace_index.ts:494

```
/**
 * Score every candidate, drop the ones with no signal, and sort best-first.
 *
 * The lexical half is normalized against the best lexical score *in this
 * result set*, not an absolute scale — so the top lexical hit always
 * contributes its full weight regardless of how many terms happened to match.
 */
```

## src/memory/workspace_index.ts:588

```
// mutation testing duly finds this line unkillable. It stays because the
```

## src/memory/workspace_index.ts:618

```
// oversize file is recorded but never read, so letting its size
```

## src/memory/workspace_index.ts:753

```
// batch instead of an empty one: the first document of a batch is always
```

## src/memory/workspace_index.ts:755

```
// `if end == start { end += 1 }` rescue, which can never fire for that
```

## src/memory/workspace_index.ts:788

```
/**
 * Cosine similarity, accumulated in f32 exactly as the Rust did.
 *
 * The rounding is the point. These scores reach the model as decimals, and an
 * f64 accumulation of the same vectors gives a visibly different number.
 */
```

## src/memory/workspace_index.ts:821

```
/**
 * Read the index, or start empty.
 *
 * Any problem — missing file, invalid JSON, a record with the wrong shape —
 * yields an empty index rather than an error. The index is a cache: rebuilding
 * it costs embedding calls, and refusing to search because it is corrupt would
 * cost the search entirely.
 */
```

## src/memory/workspace_index.ts:930

```
/**
 * Persist the index, or complain and carry on.
 *
 * A search that cannot cache its vectors is slower, not broken — so a failure
 * here must not take the query down with it.
 */
```

## src/memory/retrieval.ts:1

```
/**
 * Choosing the embedder from config.
 *
 * Ported from `crates/daemon/src/memory/retrieval.rs`, pinned by
 * `tests/memory_fixtures/workspace_index_parity.json`.
 *
 * There is no bundled local embedder. Semantic search needs an
 * OpenAI-compatible embeddings endpoint — hosted or self-hosted
 * (text-embedding-inference, llama.cpp's `/v1/embeddings`) — and when nothing
 * is configured, hybrid search degrades to lexical at the call site. That is
 * why every failure here is a plain sentence: it is shown to whoever has to
 * fix the config, and it is not an exception the caller must handle.
 *
 * Identity is a bare `provider:model_id`. Transport and credentials come from
 * `[providers.<provider>]`, on the same key-fallback contract chat uses;
 * optional `[embedding."provider:model_id"]` settings carry `dimensions`.
 */
```

## src/memory/retrieval.ts:48

```
/**
 * The embedding identity to use: the configured default, else the sole
 * `[embedding.*]` key.
 *
 * With several entries and no default, this fails rather than picking one.
 * The Rust's comment for that was "the choice would be arbitrary (BTreeMap
 * order)" — which is also why a plain object is fine here despite the Rust
 * using an ordered map. The only branch that reads more than one key is the
 * one that refuses to choose.
 */
```

## src/memory/retrieval.ts:137

```
// `u32`, so that conversion cannot fail on any platform shore runs on. The
```

## src/memory/retrieval.ts:138

```
// guard is dropped rather than reproduced as an unreachable branch.
```

## src/memory/deferred_edits.ts:80

```
/**
 * Snapshots left behind by prompt files that no longer exist: the pre-rename
 * `<recent_memory>` block, and `HEARTBEAT.md` from before heartbeat
 * carry-forward folded into `MEMORY.md`. Removed opportunistically when the
 * snapshot directory is re-seeded, so they do not accumulate forever.
 */
```

## src/memory/deferred_edits.ts:129

```
/**
 * Content of a file if it is present and not blank, else undefined.
 *
 * Mirrors the Rust's `read_to_string(..).ok().filter(non-blank)` — note that
 * an unreadable file is indistinguishable from a missing one here. That is
 * load-bearing at every call site: a permissions error on SOUL.md degrades to
 * "no soul" rather than failing the turn.
 */
```

## src/memory/deferred_edits.ts:146

```
/**
 * The canonical source a prompt-visible path is copied from. The memory index
 * needs no special case: `memoryIndexPath` resolves to exactly this, since
 * both live at the workspace root. See MEMORY_INDEX_FILE.
 */
```

## src/memory/deferred_edits.ts:191

```
/**
 * Prompt-visible paths waiting for activation, deduplicated and sorted.
 *
 * Sorted because the Rust collected into a `BTreeSet`, so callers see
 * alphabetical order rather than the order edits arrived. Unparseable lines,
 * lines without a string `path`, and paths that are not prompt-visible are all
 * skipped rather than failing the read — a corrupt queue must not be able to
 * block a compaction boundary.
 */
```

## src/memory/deferred_edits.ts:232

```
/**
 * Queue a deferred refresh. A path that is not prompt-visible is silently
 * ignored — most workspace writes are ordinary memory files and must not
 * enqueue anything.
 */
```

## src/memory/deferred_edits.ts:292

```
/**
 * Copy one canonical file into the snapshot.
 *
 * `seedOnly` is the difference between "make sure something is there" and
 * "make it current". The third branch is the interesting one: on a refresh,
 * a canonical file that has been *deleted* removes the snapshot too, so
 * deleting SOUL.md eventually takes it out of the prompt. On a seed it does
 * not, because a seed must never destroy a snapshot it did not create.
 */
```

## src/memory/deferred_edits.ts:326

```
/**
 * Create the workspace-first layout and migrate anything left by the older
 * per-character config layout into it.
 *
 * Every step is "copy if the destination is missing" — never overwrite. A
 * character that has already been migrated must survive this being run again
 * on every snapshot check, which it is.
 */
```

## src/memory/deferred_edits.ts:377

```
/**
 * Make sure a snapshot exists, without disturbing one that already does —
 * this runs on ordinary turns, so it must not activate a pending edit.
 */
```

## src/memory/deferred_edits.ts:432

```
/** Recursive copy that never overwrites an existing destination file. */
```

## src/memory/compaction/prompts.ts:1

```
/**
 * The two compaction prompt templates.
 *
 * What is left of `crates/daemon/src/memory/compaction/parser.rs` after the
 * dead half came out — see the deletion note below.
 *
 * The templates are read from the `prompts/` tree that already owns them
 * rather than copied into string literals, so there is one copy and it is the
 * one a person edits. `include_prompt!` strips exactly one trailing newline;
 * {@link stripOneTrailingNewline} is that rule, and it matters because these
 * strings are substituted into a request whose bytes are a cache prefix.
 *
 * # The XML parser is gone
 *
 * `parse_compaction_response`, `extract_write_ops` and `extract_xml_tag`
 * parsed a `<memory><write path="...">` payload out of the model's prose. They
 * had no caller left: the tool-loop redesign (the same change that introduced
 * the "no writes, no archive" guard) made memory writes arrive as `edit` tool
 * calls, and nothing has read the XML form since. The only thing still calling
 * those functions was their own unit tests. `MemoryFileOp` outlived them,
 * because the dry-run preview still describes an intended write with a path
 * and a body — it now comes from the tool call's arguments rather than from
 * parsed XML, and it lives in `types.ts` with the rest of the vocabulary.
 */
```

## src/memory/compaction/types.ts:11

```
/**
 * A message from a conversation, as compaction sees it.
 *
 * Flattened from the stored `Message` by the caller — compaction never reads
 * `active.jsonl` itself, it is handed the parse. The two booleans are the
 * whole of what the split logic looks at beyond `role`.
 */
```

## src/memory/compaction/types.ts:22

```
/**
   * True when a user message's content blocks are *all* tool results — a
   * tool-loop intermediate rather than a real user turn. The turn split walks
   * past these so a loop is never cut in half.
   */
```

## src/memory/compaction/types.ts:94

```
/**
   * True if the loop ended because it hit the per-model `max_tool_iterations`
   * cap rather than the model stopping cleanly. Always false when the cap is
   * unlimited, which is the default.
   */
```

## src/memory/compaction/types.ts:117

```
/**
 * Which failure this is.
 *
 * Four of the Rust enum's five variants, plus one it did not have. The missing
 * fifth is `Parse`, which had no constructor left: `parse_compaction_response`
 * was the only thing that ever built one, and it went with the rest of the XML
 * parser (see `prompts.ts`). The one remaining mention is a match arm in the
 * command surface, which is a reader, not a writer.
 *
 * The addition is `busy`. The Rust raised the already-running refusal in two
 * places with two different types — `commands/state/memory.rs` made it
 * `ErrorCode::Busy` and `memory/compaction/background.rs` made it an
 * `io::ErrorKind::WouldBlock` — because the guard was taken separately in each.
 * Flattening the two assemblies into one (`compaction/run.ts`) leaves one
 * raiser, and it has to carry enough for `shore compact` to still answer
 * `busy` rather than `internal_error`. Hence a kind of its own, and a message
 * with no prefix on it, which is what the command reported.
 */
```

## src/memory/compaction/types.ts:142

```
/**
 * A compaction failure.
 *
 * `message` reproduces the Rust `Display`, prefix included, because the
 * strings reach an operator through the command surface. `kind` is what the
 * handler branches on.
 */
```

## src/memory/compaction/types.ts:183

```
/**
 * The LLM half of a compaction pass.
 *
 * The manager drives the tool loop itself — it owns the path filter, the
 * rollback list and the "no writes, no archive" guard — so this is only the
 * two things the manager cannot do:
 *
 * 1. {@link buildInitialRequest} produces the first request for a pass by
 *    extending a chat-shape request with the compaction tail.
 * 2. {@link generate} runs a single round against an already-built request.
 *
 * `chatRequest` carries chat's `(system, tools, messages)`, either from the
 * cached `last_request` (warm) or rebuilt from disk (cold). Either way the
 * wire shape is what chat's next turn would have sent. The implementation
 * rebuilds it against the compaction model and appends the "compact now" user
 * message plus an inline `role:"system"` entry carrying the instruction at a
 * fixed slot — the only shape that stays byte-stable across the tool loop, and
 * so the only one that keeps chat's cache prefix extending cleanly.
 */
```

## src/memory/compaction/types.ts:231

```
/**
 * The slice of the tool layer a compaction pass reaches for.
 *
 * The Rust took a `&dyn ToolContext` and called two free functions on it —
 * `tools::dispatch_tool` and `content_util::dispatch_result_to_output`, always
 * as a pair, always in that order — plus two git helpers from
 * `tools::workspace`. Compaction never used the rest of `ToolContext`, and it
 * cannot: it hands the model's input straight through and only inspects the
 * result's success. Narrowing the dependency to what is actually reached keeps
 * a 4,700-line module out of this one's type surface, and folds the
 * dispatch/render pair into the single call it always was.
 */
```

## src/memory/compaction/types.ts:256

```
/**
   * Make sure the workspace is a git repository before a live pass starts, so
   * the model's own `git` commits land somewhere. Best-effort in the Rust and
   * best-effort here: it never throws.
   */
```

## src/memory/compaction/archive.ts:1

```
/**
 * The write half of a compaction pass: archive what was compacted, keep the
 * rest.
 *
 * Ported from `RealConversationManager::archive_and_retain` in
 * `crates/daemon/src/memory/compaction_impls.rs`, pinned by
 * `tests/memory_fixtures/compaction_assembly_parity.json`.
 *
 * `engine/segments.ts` has been waiting for this since it ported — it is the
 * reader for exactly these files, and until now nothing on this side wrote
 * them. Three things happen, in this order:
 *
 * 1. The conversation is split **by line**, from the end. Not by message and
 *    not by turn: `keepLastN` arrives already computed by the pass, which did
 *    the turn arithmetic, and this only has to agree with it about what a line
 *    is. Blank lines are dropped first, so a stray newline cannot shift the
 *    split by one.
 * 2. The archived part becomes the next numbered segment, and the manifest
 *    grows an entry. The number comes off the manifest's own length, so a
 *    manifest that was never written starts at `0001`.
 * 3. What is left is written back to `active.jsonl`, atomically.
 *
 * # The split is computed against what the pass read, not what is on disk
 *
 * `activeContent` is the bytes the pass parsed its messages from, and they are
 * what gets split — the file may have grown since. That is deliberate in the
 * Rust and kept here: computing the split against a file that moved underneath
 * the pass would archive a different set of messages than the one the model was
 * shown.
 *
 * It has a cost, and the fixture records it rather than hiding it: a turn that
 * arrives *during* a pass is in neither half, so the retained write drops it.
 * Fixing that means merging, which is a design decision rather than a port's.
 */
```

## src/memory/compaction/archive.ts:65

```
/**
 * Split, archive, and rewrite. Returns a fresh conversation id.
 *
 * The id is a plain uuid and nothing reads it back — the Rust returned one and
 * the pass logs it. It is here because the interface says so.
 */
```

## src/memory/compaction/archive.ts:158

```
/**
 * How many segments a character has, for the callers that only want the count.
 *
 * The **manifest**, not the directory. This counted `.jsonl` files when it
 * landed and that was wrong: the Rust's `SegmentReader::load(dir).segment_count()`
 * reads `compaction.json`, and `engine/segments.ts` says in its own header that
 * the manifest is the authority and the files are not — with a fixture pinning
 * a manifest that disagrees with what is on disk.
 *
 * The two answers differ exactly when an archive crashed between writing a
 * segment and updating the manifest, or when a segment file was removed by
 * hand. Both callers use this for `has_prior_context`, which decides whether the
 * model is told it is missing earlier context, so the looser count would have
 * claimed prior context from an orphan file the reader cannot actually read.
 */
```

## src/memory/compaction/llm.ts:30

```
/**
 * Entries appended to the chat prefix when a compaction request is built: one
 * `role:"user"` ("compact now") and one `role:"system"` (the instruction).
 *
 * The system entry sits immediately after the user entry, and the tool loop
 * pushes assistant + tool-result turns *after* both, so its index never shifts
 * across rounds. That fixed index is the invariant:
 *
 * The instruction goes inline via {@link pushInlineSystem} at build time, so its
 * position in `messages` is settled before the loop starts. Each provider
 * adapter then handles it the way its dialect expects — Anthropic-family
 * providers merge it into the preceding user turn, OpenAI-family providers emit
 * a real `role:"system"` or wrap it as a user turn with `<system_instruction>`
 * — and because the index is fixed, whatever the adapter merges into or wraps
 * is fixed too. Every byte at or before that position is stable round to round,
 * which is what keeps the content-addressed prefix cache valid.
 *
 * The earlier `system_suffix` affordance was removed for exactly this: it
 * re-expanded the instruction at the *moving* tail on every call, busting the
 * cache on every round.
 */
```

## src/memory/compaction/llm.ts:53

```
/**
 * Apply the canonical compaction tail to a chat-shape request.
 *
 * One named operation rather than two open-coded field mutations, so the
 * wire-shape invariant is visible wherever it is applied. See
 * {@link COMPACTION_TAIL_ENTRY_COUNT} for why the instruction rides inline.
 */
```

## src/memory/compaction/llm.ts:109

```
/**
   * The Rust set three more fields here: `rid = None` (a compaction is not the
   * chat turn whose trace id it would otherwise inherit), `forensic_character`,
   * and `retain_long` — compaction is low-frequency and high-value for
   * cache-regression forensics, so its payload log goes to a longer retention
   * tier than per-turn chat. All three were `#[serde(skip)]` transients that
   * never reached a provider, and `SidecarRequest` deliberately does not carry
   * them: they cross in the call context instead, "where they cannot be
   * mistaken for provider input". They are the generate seam's to set, with the
   * rest of that context, and land with it.
   */
```

## src/memory/compaction/llm.ts:134

```
// and the compaction tail plus every tool-loop round would otherwise
```

## src/memory/compaction/llm.ts:137

```
// The elements are shared, which is correct: they are never mutated.
```

## src/memory/compaction/background.ts:121

```
/**
 * Push the workspace memory history after a successful pass, when
 * `[memory] git_push` is on.
 *
 * Only for `compacted` — a pass that archived nothing has nothing new to push —
 * and best-effort, since a failed push must never undo an archive that already
 * happened. Shared by the background and manual compaction paths, which is why
 * it is a function rather than four lines at each call site.
 */
```

## src/memory/compaction/run.ts:1

```
/**
 * Everything a compaction pass needs, resolved and handed to the pass.
 *
 * Ported from `run_compaction` and `resolve_compaction_deps` in
 * `crates/daemon/src/memory/compaction/background.rs`, together with the
 * `prepare_and_run_compaction` half of
 * `crates/daemon/src/commands/state/memory.rs`, pinned by
 * `tests/memory_fixtures/compaction_assembly_parity.json`.
 *
 * `background.ts` said in its own header that this "lands with `handler/`,
 * which is also where its one caller lives". It has three callers, and that is
 * the reason it is one function: the idle trigger, the inline compaction a chat
 * turn schedules, and `shore compact`. The Rust had two copies of this
 * assembly — one in `background.rs` and one in `commands/state/memory.rs`,
 * differing in which error type they raised and whether a dry run was possible
 * — and a difference between them was a difference in what the model was shown.
 *
 * # What it resolves
 *
 * - **The effective config**: global with the character's overlay merged over
 *   it, so a per-character `[memory]` or `[models]` setting applies to a
 *   background pass exactly as it does to a turn.
 * - **The two templates**, per character, then global, then the bundled
 *   default.
 * - **The background model**, which is `[models.background.compaction]` before
 *   the app default. No model is a refusal, not a fallback.
 * - **The chat-shape request the pass extends.** The cached `last_request`
 *   first, because it is already warm against the provider's prompt cache;
 *   otherwise one rebuilt from disk to the same wire shape, so the next chat
 *   turn can still hit the prefix this seeds.
 * - **The tool context**, which is the same one a turn builds minus the
 *   sub-agent runtime — a compaction pass has no client to stream to and
 *   nothing to delegate to.
 *
 * # The guard is the first thing and the last thing
 *
 * `tryBeginCompaction` writes a lock the whole pass runs under. Two passes over
 * one character would archive the same segment twice and race the retained
 * write, so a second caller is refused rather than queued — a compaction whose
 * trigger fired while another was running is a compaction whose trigger will
 * fire again.
 *
 * It is claimed *before* the conversation is read, which is observable: a
 * character with nothing to compact and the slot already taken is refused as
 * busy, not as empty. `commands_fixtures/compact_parity.json` records both
 * orderings so the two cannot be swapped quietly.
 *
 * # Unported: the `compaction_complete` notification
 *
 * `handle_compaction_outcome` in `crates/daemon/src/memory/compaction/
 * background.rs` fires one, and it fires a *different* one for each outcome —
 * "N entries from M turns" when the pass wrote memory, and "ran but wrote no
 * memory, will retry" when it did not. Nothing here does.
 *
 * It belongs here rather than at a caller, and that is the reason it is still
 * missing: the no-memory-writes text needs the tool-round count and the
 * rejected paths, which only the outcome carries. A caller notifying on
 * "compaction returned" would send the wrong sentence for the outcome that most
 * needs the right one — the silent failure where the conversation is *not*
 * archived and the user is waiting for it to be. `runtime.ts` deliberately
 * wires no compaction notifier for the same reason.
 */
```

## src/memory/compaction/run.ts:104

```
/** What the tool context needs beyond the config — never a sub-agent runner. */
```

## src/memory/compaction/run.ts:193

```
// Opt-in and best-effort: a push that fails must never undo an archive that
```

## src/memory/compaction/run.ts:253

```
// refuses on its own with a message that says so.
```

## src/memory/compaction/run.ts:282

```
/**
 * The tool surface a compaction pass reaches for.
 *
 * The context is a turn's, minus the sub-agent runtime — `buildToolContext`
 * leaves that out unless a runner is passed, and this never passes one. What is
 * added is the rendering: a pass hands the model a string, so a tool's value
 * becomes text and its failure becomes text with a flag, which is what
 * `content_util::dispatch_result_to_output` did.
 */
```

## src/memory/compaction/run.ts:333

```
/**
 * The body the pass extends: the cached one, or one rebuilt to match it.
 *
 * The cached `last_request` is preferred because it is the body a chat turn
 * just sent, so extending it lands on a prompt prefix the provider still has.
 * Rebuilding produces the same wire shape from disk — same system blocks, same
 * tool surface, same messages — so a pass that had no cache still seeds a
 * prefix the next chat turn can hit.
 */
```

## src/memory/compaction/run.ts:374

```
/**
 * The assembly as `handler/turn.ts` wants it.
 *
 * The inline compaction a chat turn schedules is the same pass as the idle
 * trigger's, and it was injected into the generation driver as a
 * `CompactionRunner` because this had not ported. This is that injection's
 * value.
 *
 * `config` is passed per call rather than read off `deps`: the driver holds the
 * character-effective config for the turn it is finishing, and handing that one
 * over is what keeps an inline pass running under the same settings the turn
 * did.
 *
 * `cachedRequest` is a lookup for the same reason one runner serves every
 * character: the body worth extending is the one *this* character last sent.
 * Holding a single request here would hand Ada's conversation to Nova's pass —
 * same shape, entirely the wrong bytes, and the pass would notice nothing.
 */
```

## src/memory/compaction/manager.ts:1

```
/**
 * A compaction pass: split the conversation, let the model write memory, and
 * archive only if it did.
 *
 * Ported from `crates/daemon/src/memory/compaction/mod.rs`, the densest file in
 * the daemon, pinned by `tests/memory_fixtures/compaction_parity.json`.
 *
 * # The rule the whole file exists for
 *
 * A pass archives the active conversation **only when at least one allowed
 * memory write actually landed**. Zero writes returns `no_memory_writes` and
 * leaves `active.jsonl` untouched. Before the tool-loop redesign the parser
 * path fell through to archive when the model emitted tool calls instead of the
 * XML payload it expected, which silently cleared the transcript without
 * updating a single memory file. Every guard here is downstream of not letting
 * that happen again: the path filter, the rollback list, and the split between
 * "the model called tools" and "the model wrote memory".
 *
 * # What did not come across
 *
 * Four things in the Rust had no caller left at the commit this was ported
 * from, verified by grep across `crates/` rather than assumed:
 *
 *   - **`IdleTimer`, `notify_activity`, `idle_timer()`** — a `tokio::select!`
 *     between a sleep and a notification, deciding when a conversation had gone
 *     quiet enough to compact. The autonomy tick answers that now, from stored
 *     timestamps rather than a live timer, and it is already ported:
 *     `autonomy/tick.ts`'s `compactionReason` is the idle trigger. A second,
 *     unreachable copy of the same decision is exactly the drift that made the
 *     tick worth having.
 *   - **`should_force_compact` / `has_enough_turns`** — likewise superseded, by
 *     `CharacterAutonomy.shouldCompactNow` in `autonomy/runner.ts`. That one is
 *     load-bearing where these were not: saying yes there takes the latch.
 *   - **`build_prompt`** — `#[cfg(test)]`, a flattened-prompt helper for tests
 *     of a prompt shape that is no longer built.
 *   - The XML response parser — see `prompts.ts`.
 *
 * With the timer and the trigger predicates gone, the manager reads exactly one
 * field of `CompactionConfig`, which is why it takes {@link CompactionSettings}
 * rather than the whole struct. The rest of that struct is read by the autonomy
 * layer, which models its own slice of it.
 */
```

## src/memory/compaction/manager.ts:71

```
// ── Single-flight guard ─────────────────────────────────────────────────
```

## src/memory/compaction/manager.ts:73

```
/**
 * Character data roots with a compaction pass in flight.
 *
 * Manual and idle-triggered compaction both mutate the same active transcript,
 * segment manifest, markdown files and prompt-refresh queue, so a slow provider
 * response must not overlap with another pass against the same pre-compaction
 * window. Keyed by data root rather than character name because tests host
 * separate daemon instances for one character in a single process.
 *
 * The Rust held a `tokio::Mutex` per key and returned an RAII guard; here the
 * key is simply present or absent and the guard has a {@link CompactionRunGuard.release}
 * to call, since JavaScript has no drop. It is also a `Symbol.dispose`, so
 * `using guard = tryBeginCompaction(...)` releases on scope exit.
 */
```

## src/memory/compaction/manager.ts:129

```
/**
 * Render the final compaction user message.
 *
 * Beyond `{{char}}`/`{{user}}` this strips the legacy `{{#if recap}}...{{/if}}`
 * blocks and the `{{recap}}` placeholder, because recaps are no longer
 * generated. Existing memory is not inlined: the model already has the
 * `MEMORY.md` index in its system prompt and reaches whole files through its
 * own `read`/`search` tools.
 *
 * **Divergence, deliberate.** The Rust searched for `{{/if}}` from the start of
 * the string on every iteration, not from the `{{#if recap}}` it had just
 * found. A template whose first `{{/if}}` came *before* its first
 * `{{#if recap}}` therefore spliced a growing copy of its own middle back in
 * and never terminated — an operator with a hand-edited `compact.md` could hang
 * the pass. Here the closer is looked for after the opener, so a malformed
 * template strips what it can and stops. For any template where the two are in
 * the order the syntax implies, the two agree exactly, which is every template
 * shipped and every one pinned.
 */
```

## src/memory/compaction/manager.ts:241

```
/**
 * May a compaction pass write here?
 *
 * Three allowances and two refusals, in the order they are decided:
 *
 *   - `MEMORY.md` at the workspace root — compaction's job includes updating
 *     the conversational throughline.
 *   - The other root prompt files (`SOUL.md`, `USER.md`, `AGENTS.md`,
 *     `TOOLS.md`), because the compaction prompt asks the model to distill
 *     durable facts into them. These go through the same deferred-edit queue as
 *     chat-turn edits, so they only become prompt-active at the boundary this
 *     pass is creating.
 *   - Anything under `memory/`, except the dreaming artifacts, so a compaction
 *     cannot stomp on what a dream wrote.
 *
 * Absolute paths and any `..` component are refused before any of that.
 * `resolvePath` enforces confinement again at write time; failing closed here
 * as well keeps this documented guard self-contained, at the layer whose job is
 * to keep compaction inside its own corner of the workspace.
 */
```

## src/memory/compaction/manager.ts:262

```
// Order copied exactly: the `./` strip runs before the backslash rewrite, so
```

## src/memory/compaction/manager.ts:296

```
/**
 * What a pass accumulates while the model works: the writes that landed (with
 * their previous content, for rollback), the paths the filter refused, every
 * tool name in call order, and the previews a dry run would have written.
 */
```

## src/memory/compaction/manager.ts:329

```
/**
 * Run one tool call from the compaction loop, wrapping the canonical dispatch.
 *
 *   - `delete` is always refused. `git` is allowed so the pass can commit its
 *     writes — the tool is git-only by construction, so compaction does not
 *     have to read a command line to know that — but not during a dry run,
 *     which runs no commands at all.
 *   - In a dry run `edit` is blocked and the intended path recorded, so the
 *     preview is still useful.
 *   - For a live `edit` the path filter runs, and the resolved file's previous
 *     content is snapshotted so a downstream archive failure can roll it back.
 *
 * Everything else passes through untouched.
 */
```

## src/memory/compaction/manager.ts:371

```
// The Rust pushed the refused path onto `rejectedPaths` here. Nothing
```

## src/memory/compaction/manager.ts:372

```
// read it: a dry run always returns the `dry_run` outcome, which has no
```

## src/memory/compaction/manager.ts:505

```
/**
 * Alternate `generate()` and tool dispatch until the model ends cleanly or the
 * round budget runs out.
 *
 * `stop_after_dispatch`: a compaction's output is the writes it accumulated,
 * not a closing message, so a capped pass has nothing to spend another call on.
 * The chat path chooses otherwise.
 */
```

## src/memory/compaction/manager.ts:574

```
/**
 * The one config field a pass reads.
 *
 * `CompactionConfig` has six more — `enabled`, `idle_trigger`, `archive_after`,
 * `min_turns`, `max_turns`, `max_context_tokens` — and every one of them is
 * read by the autonomy layer deciding *whether* to compact, never by the pass
 * itself. See the module note on what was dropped.
 */
```

## src/memory/compaction/manager.ts:614

```
/**
 * The workspace root for path resolution and previous-content snapshots.
 *
 * Prefers the markdown store's parent, which is canonical in production, and
 * falls back to the tool context for dry runs without a store. When both exist
 * they must agree: `edit` resolution and the git bootstrap use the
 * store-derived root while the model's own `git` runs against the tool
 * context's, and if those were different trees a pass would commit one and roll
 * back the other. They are always the same in production, so this fails fast
 * rather than quietly operating on two repositories.
 */
```

## src/memory/compaction/manager.ts:641

```
// written otherwise, so a root that does not exist yet still matches itself.
```

## src/memory/compaction/manager.ts:685

```
// The Rust refused an empty conversation here and again below on a zero
```

## src/memory/compaction/manager.ts:733

```
// The guard: no allowed write means the transcript stays where it is.
```

## src/memory/compaction/manager.ts:782

```
/**
 * Build the compaction system prompt and the single "compact now" user turn,
 * then hand both to the LLM impl to extend chat's request with.
 *
 * The instruction rides as an inline `role:"system"` entry at a fixed slot
 * rather than a system suffix, because that is what keeps the compact-now slot
 * byte-stable across the tool loop — and so keeps chat's cache prefix extending
 * cleanly instead of being invalidated by every round.
 */
```

## src/tools/mcp_registry.ts:1

```
/**
 * Live MCP connections and the dynamic tool surface they contribute.
 *
 * Ported from `crates/daemon/src/tools/mcp_registry.rs`, pinned by
 * `tests/tools_fixtures/mcp_parity.json`.
 *
 * Each `[mcp.<name>]` config entry is connected at startup (and on hot-reload),
 * all of them concurrently, with a bounded retry for HTTP servers only — see
 * {@link connectWithRetry} for why the two transports are treated differently.
 * The tools discovered from every server are flattened into one list,
 * namespaced `mcp__<server>__<tool>`, sorted by that full name, and **pinned
 * for the registry's lifetime**. Pinning is what keeps the outbound tool
 * surface — and therefore the Anthropic cache prefix — stable across turns: a
 * server is listed once at connect, never re-listed mid-session.
 *
 * A connection that dies is rebuilt underneath that pinned list rather than
 * re-listed ({@link McpRegistry.reviveClient}), so recovering from an outage
 * costs nothing in cache terms. Changing the surface is a `[mcp]` reload's job,
 * and swapping the whole registry is how that is done (`handler/deps.ts`).
 */
```

## src/tools/mcp_registry.ts:29

```
/** One discovered MCP tool. Owned, because names and schemas are runtime facts. */
```

## src/tools/mcp_registry.ts:62

```
/**
 * Resolve `raw` against `base`, leaving absolute paths untouched.
 *
 * **Not `path.join`.** `path.join` normalizes, so it collapses
 * `plugins/../sibling` to `sibling`; Rust's `PathBuf::push` does not, and the
 * difference decides which directory a server is launched in. `..` and
 * symlinks are left for the OS to resolve, exactly as the Rust leaves them.
 *
 * Bare `.` components are dropped so a `./`-prefixed entry does not produce a
 * `<base>/./x` path in logs. That matches Rust's `Components`, which also
 * collapses empty segments — so `a//b` becomes `a/b` — while keeping `..`.
 */
```

## src/tools/mcp_registry.ts:134

```
/** Injected so tests do not spend real time asleep. */
```

## src/tools/mcp_registry.ts:154

```
/**
 * Connect `spec`, retrying the HTTP transport and only the HTTP transport.
 *
 * The distinction is the whole point (#37). A stdio server is a child process
 * shore spawns itself: if it fails to start it will keep failing to start, and
 * retrying just respawns a broken process on a loop. An HTTP server is a
 * network peer with an independent lifecycle, where "not listening yet" is the
 * overwhelmingly common transient and resolves on its own within seconds.
 *
 * Every HTTP connect error is retried rather than only the connection-refused
 * shaped ones. Classifying failures across the SDK's transport and the fetch
 * stack underneath it is guesswork that rots, and the cost of being wrong is
 * asymmetric: retrying a genuinely bad URL wastes the backoff window once at
 * startup, while *not* retrying a slow server costs the session its cache
 * prefix.
 */
```

## src/tools/mcp_registry.ts:195

```
/** What became of one `[mcp.<name>]` entry. Reported, never thrown. */
```

## src/tools/mcp_registry.ts:208

```
/**
 * Bring up one server, resolving to an outcome instead of rejecting.
 *
 * Never rejecting is what lets the servers run concurrently without one bad
 * entry deciding the fate of the batch: `Promise.all` over rejecting tasks
 * would abandon the others' results while their connects stayed in flight,
 * leaking transports nothing holds a reference to.
 */
```

## src/tools/mcp_registry.ts:259

```
/**
 * How to rebuild a connection that died, kept only for registries that were
 * built by connecting. A hand-assembled one has no specs and no connector, so
 * it simply never revives.
 */
```

## src/tools/mcp_registry.ts:320

```
/**
   * Connect every configured server and discover its tools.
   *
   * A server that fails to connect or list is logged and skipped — a bad
   * server never takes the daemon down, and the surface it would have
   * contributed is simply absent. A server that connects but fails `tools/list`
   * is shut down rather than left running with no tools.
   *
   * HTTP servers get a bounded retry before they are given up on; stdio
   * servers get one attempt, as before. See {@link connectWithRetry} for why
   * the two differ, and why exhausting the retries is worth an `error` rather
   * than a `warn`.
   */
```

## src/tools/mcp_registry.ts:348

```
// Determinism survives it because nothing is decided here: the outcomes
```

## src/tools/mcp_registry.ts:350

```
// the tool list and the log lines all come out exactly as the serial
```

## src/tools/mcp_registry.ts:369

```
// model works around a tool it never knew it was missing, which
```

## src/tools/mcp_registry.ts:406

```
// rebuilt through exactly the path that built it, including a connector a
```

## src/tools/mcp_registry.ts:429

```
/**
   * Tool defs whose full name matches any allowlist pattern, in pinned order.
   *
   * Filtering, never reordering: a config listing its patterns in a different
   * order offers the same surface in the same sequence. Overlapping patterns
   * offer a tool once, because the filter runs over the tools rather than over
   * the patterns.
   */
```

## src/tools/mcp_registry.ts:481

```
/**
   * Rebuild a dead connection in place, keeping the pinned tool surface.
   *
   * This is the mid-session half of #37, and the reason it is cheap: the tool
   * list is *not* re-listed. Only the transport underneath is replaced, so
   * `allTools` is byte-identical before and after and the cache prefix never
   * moves. A full registry rebuild — the obvious fix — would move it, which is
   * the very cost the issue is about.
   *
   * It follows that a server which came back offering a *different* tool list
   * does not get its new surface here. That is the existing pinning contract
   * ("a server that gains a tool mid-session does not get it offered until the
   * next reload"), not a new limitation, and honouring it is what keeps the
   * prefix stable. `[mcp]` reload remains the way to adopt a changed surface.
   *
   * HTTP only, matching the startup asymmetry: a stdio child that exited is a
   * process shore would have to respawn, and respawning a crashing server on
   * every tool call is the loop the startup path already refuses to enter.
   */
```

## src/tools/model_history.ts:53

```
/**
 * A bound rebased to UTC, spelled the way chrono's `to_rfc3339` spells it.
 *
 * Ledger timestamps are stored as RFC3339 in UTC and the query compares them
 * **lexicographically**, so a bound left at `+10:00` would sort as though its
 * wall-clock reading were UTC and silently select the wrong window.
 *
 * Two spellings matter and neither is what `Date.toISOString()` produces:
 *
 * - UTC is written `+00:00`, not `Z`.
 * - Sub-second precision is preserved at chrono's `AutoSi` widths — 0, 3, 6 or
 *   9 digits. `Date` cannot hold nanoseconds at all, so the fraction is carried
 *   through as text rather than round-tripped through a timestamp. Offsets are
 *   always whole minutes, so rebasing never disturbs it.
 */
```

## src/tools/workspace_path.ts:1

```
/**
 * Workspace path confinement.
 *
 * Ported from `resolve_roots` / `resolve_path` in
 * `crates/daemon/src/tools/workspace.rs` and the prompt-visible normalization
 * in `crates/daemon/src/memory/deferred_edits.rs`, pinned by
 * `tests/engine_fixtures/subagent_parity.json`.
 *
 * Every filesystem-touching tool routes its caller-supplied path through
 * {@link resolvePath} first. It is the single boundary that keeps a model —
 * or anything a model was persuaded to emit — from naming a file outside the
 * character's workspace. Three separate escapes are refused:
 *
 * 1. **Absolute paths.** `path.join(base, "/etc/passwd")` in Node happens to
 *    keep the base, but Rust's `Path::join` discards it outright and would
 *    have read the file. The component scan rejects the input either way, so
 *    neither language's join semantics are load-bearing.
 * 2. **`..` traversal.** Rejected on the *unnormalized* components, so
 *    `sub/../SOUL.md` is refused even though it names a file that is in fact
 *    inside the workspace. Refusing the shape rather than the destination is
 *    what makes the rule auditable.
 * 3. **Symlinks out.** A link with no `..` and no leading `/` looks clean and
 *    only shows itself once resolved, so the resolved path is compared
 *    against the resolved base.
 *
 * The comparison is done on *resolved* paths on both sides. Comparing the
 * literal strings would be defeated by any of `..`, a symlinked workspace
 * root, or a `/tmp` → `/private/tmp` style platform alias.
 *
 * `pathComponents` and `isInside` — the two pieces of the rule that are not
 * about *this* base directory — are exported for `memory/markdown_store.ts`,
 * which confines the markdown memory store the same way.
 */
```

## src/tools/workspace_path.ts:159

```
/**
 * Split the way Rust's `Path::components` does: a leading separator becomes a
 * distinct root component, and `.` segments and empty runs are dropped. `..`
 * is deliberately *not* collapsed — the caller rejects it, and collapsing
 * first would silently accept `sub/../..`.
 *
 * Backslash counts as a separator here, which the Rust's unix build does not
 * do. That is deliberate and one-directional: it can only cause more paths to
 * be refused, never fewer, and a filename containing a literal backslash is
 * not worth the ambiguity at a confinement boundary.
 *
 * Exported for `memory/markdown_store.ts`, which confines against a different
 * base and reports different messages but applies the same rule. Two copies of
 * this would be two chances to get it wrong.
 */
```

## src/tools/workspace_path.ts:184

```
/**
 * Containment on resolved paths, compared by path *component* rather than by
 * string prefix. `startsWith` would accept `/ws-secrets` as living inside
 * `/ws`, which is exactly the kind of near-miss this boundary exists to stop.
 */
```

## src/tools/workspace_path.ts:215

```
/**
 * Strip the leading separators, `./` runs and `workspace/` prefixes a caller
 * may have written, until none apply.
 *
 * The loop is not decoration: a single pass let `workspace/./SOUL.md` and
 * `./workspace/SOUL.md` through, because whichever prefix was checked first
 * left the other in place — and a path that fails to normalize is a path the
 * protected-file guard does not recognize.
 */
```

## src/tools/workspace_path.ts:242

```
/**
 * The canonical name of a prompt-visible file, if `path` names one.
 *
 * Keying the snapshot lookup on this — rather than on the caller's spelling —
 * is what stops a dressed-up traversal from selecting a snapshot file: only
 * the fixed set of names can ever match, so the lookup's argument is never
 * attacker-chosen.
 */
```

## src/tools/dispatch.ts:37

```
/**
 * `[retrieval] mode`, which decides what a `search` call with no explicit
 * `mode` gets.
 *
 * Lives here rather than on {@link RetrievalConfig} because it is the only
 * field of `[retrieval]` that no search code reads — it is consumed entirely
 * by {@link applyDefaultSearchMode}, before the handler is called.
 */
```

## src/tools/dispatch.ts:49

```
/**
 * The wiring a tool handler may need.
 *
 * The Rust was an 18-method trait with a default body per method, because a
 * trait is how you spell "some implementations supply this and others do not"
 * in a language with no structural optionality. Here that is just an optional
 * property, and the trait's defaults collapse into it: **an absent field means
 * the same thing the `None`-returning default meant** — this path is not wired
 * for that capability, and the tool depending on it reports itself
 * unavailable.
 *
 * The one thing that does *not* collapse is which error it reports.
 * `runSubagent`, `mcpCall` and `scheduleNextWake` being absent is
 * `NotImplemented`, because the name is not callable here at all;
 * `modelHistoryQuery` and `imageGenerator` being absent is `io:`, because the
 * tool is registered and routed and merely has nothing behind it. The Rust
 * drew that line and it is worth keeping — see the note on
 * {@link NotImplemented}.
 */
```

## src/tools/dispatch.ts:88

```
/**
   * Kept separate rather than bundled into the one `SearchSemantics` argument
   * `handleSearch` takes, because {@link defaultSearchMode} asks about them
   * individually: an embedder with no index and an index with no embedder are
   * distinct wirings that happen to produce the same answer.
   */
```

## src/tools/dispatch.ts:103

```
/**
   * Run a configured sub-agent. Absent is also the recursion cap: a sub-agent's
   * own loop runs against a context that leaves this out, so it cannot delegate
   * further.
   *
   * Takes the deadline's `signal` because these are the two tool families that
   * legitimately run long — `[tools.config]`'s own documentation names them —
   * and therefore the two most likely to hit their deadline. A closure that
   * ignores the signal is merely abandoned; one that honours it is stopped.
   */
```

## src/tools/dispatch.ts:118

```
/**
   * `set_next_wake`, which exists only inside a heartbeat tick.
   *
   * The Rust returned `Option<Result<…>>` and the outer `Option` meant exactly
   * "is this a heartbeat context" — so an optional method says it instead, and
   * the nesting goes away. The clamp is deliberately not applied on this side:
   * a character asking for a moment in a year is told the hour it will actually
   * get, and computing that here too would put the bound in two places to
   * drift apart.
   */
```

## src/tools/dispatch.ts:138

```
/**
 * The `mode` a `search` call gets when it names none.
 *
 * Only `auto` consults the wiring, and it demands *both* an embedder and an
 * index path — either alone falls back to lexical, because a semantic search
 * needs something to embed with and something to search.
 */
```

## src/tools/dispatch.ts:160

```
/**
 * Fill in `input.mode` when the caller left it out.
 *
 * `"mode" in input` rather than a value check, because the Rust asked
 * `input.get("mode").is_some()` — which is true for an explicit `null`. A
 * `search` called with `{"mode": null}` keeps its null and fails downstream
 * rather than silently becoming a hybrid search. A non-object input has
 * nowhere to insert and is left exactly as it came.
 */
```

## src/tools/dispatch.ts:186

```
/**
 * Flag a workspace write whose target is prompt-visible.
 *
 * A write to `MEMORY.md` or `SOUL.md` lands on disk immediately but does not
 * reach the system prompt until the next compaction boundary, and without
 * saying so the model reads its own edit back from the stale snapshot and
 * concludes the write failed. The five keys are what tell it otherwise.
 *
 * Insertion order is preserved because it is observable: the result is
 * serialized to JSON and handed to the model as text.
 */
```

## src/tools/dispatch.ts:218

```
/**
 * The `deferEdit` a context with a character directory should carry.
 *
 * The Rust guarded this with `is_prompt_visible_path` before queueing;
 * `queueDeferredEdit` already makes that check itself, so the guard is dropped
 * rather than duplicated. A queue failure is logged and swallowed — the write
 * it describes already succeeded, and failing the tool over the bookkeeping
 * would tell the model the opposite of what happened.
 */
```

## src/tools/dispatch.ts:380

```
/**
 * Cap a single tool result's contribution to the conversation.
 *
 * `[...output]` iterates **code points**, because the Rust counted
 * `chars()`. `output.length` would count UTF-16 units and cut four emoji at
 * two, reporting a character count the model can see is wrong. A limit of zero
 * leaves the output untouched.
 *
 * The cut is by code point, not grapheme, so a combining sequence can split
 * between its base and its mark. That is what the Rust did and it is left
 * alone: the alternative is a segmenter in the hot path of every tool result,
 * to move a boundary the model never sees.
 */
```

## src/tools/dispatch.ts:436

```
// Rust reported whole seconds because its deadline was a `Duration`
```

## src/tools/history.ts:1

```
/**
 * The conversation-history search tool.
 *
 * Ported from `crates/daemon/src/tools/history.rs`, pinned by
 * `tests/engine_fixtures/history_parity.json`.
 *
 * Searches the character's frozen segments and the live active window. This is
 * deliberately not filesystem search: history is transcript data, and the
 * question "what did we say about X" is not the question "which file mentions
 * X".
 *
 * # What is searchable is narrower than what is stored
 *
 * Only the user-visible chat text participates — `text` blocks, nothing else.
 * Thinking is the model's private reasoning and tool results are machine
 * payloads, and surfacing either would let the model "remember" things the user
 * never saw. `Message.content` folds tool-result text in for replay and
 * rendering, so it is specifically *not* the field searched here.
 *
 * # Characters and bytes and code units, all in one function
 *
 * The excerpt window is a *character* count, the match index the Rust computed
 * is a *byte* offset, and TypeScript's native string index is a UTF-16 code
 * unit. All three differ on the same input, and the transcripts this searches
 * are full of emoji and CJK. Every place the three could be confused is called
 * out at its site and pinned by the fixture; the short version is that this
 * module counts code points via iteration and never indexes a string directly.
 */
```

## src/tools/history.ts:107

```
// because it is what the model has been reading.
```

## src/tools/history.ts:144

```
/**
 * Fractional seconds as chrono's `AutoSi` writes them: nothing when the value
 * is zero, otherwise padded out to milli-, micro-, or nanosecond precision.
 */
```

## src/tools/history.ts:239

```
/**
 * Whether an optional minting model passes an optional *pre-normalized* filter.
 *
 * A message with no model never matches an explicit filter. Those predate model
 * tracking, and guessing that they might be the model asked for would be worse
 * than omitting them.
 */
```

## src/tools/history.ts:325

```
/**
 * Split a lowercased query into search terms.
 *
 * Two details that a plain `/\W+/` split gets wrong, both pinned:
 *
 * 1. The separator test is "not alphanumeric, and not `_` or `-`", where
 *    *alphanumeric* is the Unicode property, not ASCII. `茶` is a letter and
 *    stays part of a term; `🙂` is not and separates.
 * 2. The minimum term length is **two bytes**, not two characters. A one-letter
 *    ASCII term is dropped; a single CJK character is three bytes and is kept.
 *    A `t.length >= 2` test would throw away exactly the queries where a
 *    one-character term is the entire question.
 */
```

## src/tools/history.ts:391

```
// `excerptChars` at its 80 minimum would end the excerpt exactly where the
```

## src/tools/history.ts:468

```
/**
 * Score every message in `messages`, appending all matches.
 *
 * There is no early cutoff at `max_results` on purpose: with one, the oldest
 * segment fills the quota and recent matches are never reached at all.
 */
```

## src/tools/history.ts:556

```
// that is never negative here.
```

## src/tools/workspace.ts:1

```
/**
 * Workspace filesystem tools — read, edit, search, delete, git.
 *
 * Ported from `crates/daemon/src/tools/workspace.rs`, pinned by
 * `tests/tools_fixtures/workspace_parity.json`.
 *
 * These give the character access to a real filesystem workspace
 * (`{character}/workspace/`). `read` doubles as directory listing (a directory
 * path returns its entries), and `edit` doubles as file creation (`content`
 * writes a whole file, `edits` replaces text within one). `git` is the only
 * process-spawning tool: the workspace is a git repository and the memory
 * passes commit their own changes there.
 *
 * The confinement boundary itself is not here — `resolvePath` and its
 * component scan live in `workspace_path.ts`, which was ported ahead of this
 * module because `subagent.ts` needed it. Every handler below routes its
 * caller-supplied path through it before touching the filesystem.
 *
 * # Byte offsets became code-point offsets
 *
 * The Rust excerpt window is described in *characters* but computed in *bytes*:
 * `find_case_insensitive_match` returns byte offsets, `excerpt_line` subtracts
 * a byte-counted leading-whitespace length from them, and only then converts to
 * a `chars().count()`. Reproducing that in TypeScript would mean carrying a
 * third unit — UTF-16 code units — alongside the other two.
 *
 * Instead every offset in this module is a **code-point index**, uniformly.
 * That is not an approximation: the byte→code-point map is monotonic, and every
 * operation the Rust performs on these offsets (subtracting the leading-
 * whitespace length, clamping to the trimmed length, counting the characters
 * between two of them, stepping back N characters) is preserved by it. The one
 * thing that would break — comparing an offset in one unit against a length in
 * another — never happens, because there is only one unit left.
 */
```

## src/tools/workspace.ts:114

```
/**
 * `Value::as_u64`: a non-negative integer that fits in 64 bits.
 *
 * `serde_json` stores an unsuffixed `5` as an integer and `5.0` as a float, and
 * only the former answers `as_u64`. JavaScript has one number type, so the
 * integer test is explicit — otherwise `offset: 1.5` would round into a
 * silently different read window instead of falling back to the default.
 */
```

## src/tools/workspace.ts:142

```
/**
 * Resolve a path that is allowed to name a *directory*, including the
 * workspace root itself.
 *
 * {@link resolvePath} refuses a bare `workspace` or `memory` because a file
 * tool needs a file; a listing or a search scope does not, so this one accepts
 * them and hands back the root. An absent, empty or `"."` path is the workspace
 * root — the case that makes a bare `read` the root listing.
 *
 * The `"."` arm is a shortcut, not a rule: `resolvePath` would resolve `.` to
 * `<ws>/.`, which every consumer here treats identically (`readdir` opens the
 * same directory, and `displayPathFor` drops the `.` component before
 * comparing). Mutation testing accordingly cannot kill it. It stays because
 * naming the root is what the caller meant, and `<ws>/.` is a path that only
 * happens to work.
 */
```

## src/tools/workspace.ts:168

```
/**
 * Refuse a path whose first component is `.git`.
 *
 * `.gitignore`, `.gitattributes` and anything in a subdirectory are unaffected
 * — only an exact leading `.git` component, after an optional `workspace/`
 * prefix, is blocked.
 *
 * The component split here is Unix-only, unlike `pathComponents` in
 * `workspace_path.ts`, which also treats `\` as a separator. That module widens
 * the rule deliberately, because there it can only refuse *more* paths at a
 * confinement boundary. Here it would refuse a file legitimately named
 * `.git\notes` — a perfectly ordinary filename on Linux, and not a git internal
 * — while preventing no escape whatsoever, since the `\` is a literal character
 * in the name either way. Widening a guard that is about one directory *name*
 * buys nothing and costs a real file.
 */
```

## src/tools/workspace.ts:237

```
// of the match, so the first character *past* it is never examined, and
```

## src/tools/workspace.ts:240

```
// we are done once it ends", which is the invariant; either alone leans on
```

## src/tools/workspace.ts:303

```
// The reverse donation, which cannot change anything and is kept only because
```

## src/tools/workspace.ts:305

```
// availableAfter` — the surplus exists precisely because the text after the
```

## src/tools/workspace.ts:333

```
/**
 * Read a file's contents, or list a directory's entries.
 *
 * The path decides which: a file is read, a directory is listed, and an omitted
 * path lists the workspace root. That is why `path` is optional and why a
 * missing path cannot be an error — a bare `read` is the root listing that
 * `list_files` used to serve.
 *
 * `workspace` and `memory` are caller-facing *prefixes* rather than real
 * leading directories, so {@link resolveRoots} consumes them whole and leaves
 * an empty remainder — the one state {@link resolvePath} refuses, because a
 * file tool needs a file. The bare-prefix case is therefore dispatched to the
 * listing before the strict resolver ever sees it. The Rust did not, and
 * `read` on `memory` answered "invalid args: path is empty" (#39).
 *
 * The dispatch is on the *shape* of the path, not on `isDir`: `memory/` is
 * created lazily, and a not-yet-existing directory has to reach
 * {@link listDirectory} to get its "does not exist yet" answer rather than
 * falling back into the resolver that rejected it.
 */
```

## src/tools/workspace.ts:357

```
// Throws on an unconfigured workspace and on a blank path, exactly as the
```

## src/tools/workspace.ts:384

```
// The `?? 1` is the documented default rather than a load-bearing one: a
```

## src/tools/workspace.ts:386

```
// clamp. Written as 1 because 1 is what the schema tells the model.
```

## src/tools/workspace.ts:441

```
// its own type and its own length — never as the directory it points at,
```

## src/tools/workspace.ts:595

```
/**
 * Move a workspace file to the character's trash.
 *
 * Nothing is unlinked: the file is renamed under `{character_data}/trash/
 * {timestamp}/`, keeping its path below the workspace. A model that deletes the
 * wrong thing has made a recoverable mistake, and the timestamped root means a
 * second delete of the same path cannot overwrite the first one's copy.
 *
 * Prompt-visible files are refused outright — they are the character's own
 * definition, and losing one is not the kind of mistake a trash directory
 * makes better.
 */
```

## src/tools/workspace.ts:672

```
/**
 * The trash subdirectory's name: `%Y%m%dT%H%M%S%3fZ` in UTC.
 *
 * Millisecond precision is the collision guard — two deletes of different files
 * in the same second must not land in one directory and race each other's
 * `mkdir`.
 */
```

## src/tools/workspace.ts:706

```
/**
 * Search the workspace, semantically or lexically.
 *
 * Dispatches on the caller's `mode` *and* on whether an embedder is actually
 * wired: a `hybrid` request without one is answered lexically and told so
 * (`semantic_unavailable`) rather than refused. The same fallback catches a
 * semantic search that fails at runtime — a missing index is a degraded answer,
 * not an error, because the lexical answer was always available.
 */
```

## src/tools/workspace.ts:826

```
/**
 * Enumerate searchable files under `root`, newest first, with path order
 * breaking mtime ties so a workspace written in one burst still lists stably.
 *
 * Symlinks are skipped. Descendants found by walking are joined onto the root
 * without re-checking containment — the confinement check happened once, on the
 * caller's path — so a link pointing at `/etc/passwd` would otherwise be read
 * like any other file in the subtree.
 *
 * Unlike the embedding index's walk, there is no file-count or total-byte cap
 * here: only oversize *individual* files are skipped, and they are counted.
 */
```

## src/tools/workspace.ts:867

```
// `gitdir:` line would otherwise be read out and handed to the model.
```

## src/tools/workspace.ts:1099

```
// character survives it. Kept, because the alternative silently changes which
```

## src/tools/workspace.ts:1109

```
/**
 * How many lines each term appears on, floored at 1.
 *
 * The floor is a division guard, not a fudge: the score below divides by this,
 * and a term that appears on no line at all still has to produce a number. It
 * is also unreachable — a term with a frequency of zero appears on no line and
 * so never scores one — which is why mutation testing cannot kill it. Kept
 * because the guard is at the division, where a reader checks for it.
 */
```

## src/tools/workspace.ts:1124

```
/**
 * The highest-scoring line containing any term, with the term that scored best
 * on it.
 *
 * A term is worth `100 / (lines it appears on) + its length` — rarity first,
 * specificity as the tiebreak — and a line's score is the sum over its terms.
 * Ties go to the *earlier* line.
 *
 * `allowHeading` is the second pass. Headings are excluded first because a
 * markdown heading matching a term is usually the section title rather than the
 * answer; if nothing else matched, quoting the heading beats quoting nothing.
 */
```

## src/tools/workspace.ts:1177

```
/**
 * Global `-c` flags that neutralize repo-controlled execution surfaces: a
 * pre-existing (e.g. imported) `.git/config` or `.gitattributes` must not run
 * hooks or filter drivers when git runs. Prepended before the subcommand so
 * they apply to all of them, and passed on the command line so they outrank the
 * repo's own config.
 *
 * The model cannot inject its own `-c` — the subcommand slot rejects option
 * tokens and `git config` is denied — so these are the daemon's to set and
 * nobody else's.
 */
```

## src/tools/workspace.ts:1273

```
/**
 * Confine every path-like argument to the workspace.
 *
 * Unlike the argv form this replaces, `args` never contains the program or the
 * subcommand — the caller passes only the subcommand's own arguments. The
 * `=`-split is what catches `--git-dir=/etc`: the flag itself is not path-like,
 * its value is.
 */
```

## src/tools/workspace.ts:1299

```
/**
 * Reject a subcommand that is really a git *global* flag in disguise.
 *
 * The structured `{subcommand, args}` shape is what makes this cheap: the
 * runtime always spawns `git <subcommand> <args…>`, so `-c core.pager=…`,
 * `--exec-path=…`, `--git-dir=…` and friends can never land in the global slot
 * ahead of the subcommand the way they could when the model handed over a whole
 * command line. Guarding argv[0] closes the only remaining door.
 */
```

## src/tools/workspace.ts:1335

```
/**
 * Validate a subcommand and its arguments against the destructive denylist.
 * `sub[0]` is the subcommand name.
 *
 * Blocks history rewriting, forced discards, remote mutation, `config`, and
 * `push`. The division of labour is that the model *commits* and the daemon
 * *pushes*: network egress is daemon policy, and a repo the operator imported
 * must not have its history rewritten by something the model was talked into.
 */
```

## src/tools/workspace.ts:1363

```
// and would otherwise walk straight past the exact-match tests above.
```

## src/tools/workspace.ts:1382

```
// out of, and `restore` is denied just below for exactly that. Denying
```

## src/tools/workspace.ts:1468

```
/**
 * Run a git subcommand in the character's workspace repository.
 *
 * The only tool that spawns a process, and it is spawned directly. Everything
 * it can do is bounded by three checks: the subcommand must not be a global
 * flag, it must not be destructive or history-rewriting, and every path-like
 * argument must stay inside the workspace.
 *
 * Initializes the workspace repository when it is missing. The memory passes do
 * the same before they run, but they used to be the only ones: on the chat path
 * a character offered this tool would otherwise meet `fatal: not a git
 * repository` until the first compaction happened to create one.
 */
```

## src/tools/workspace.ts:1551

```
// A bare io error here is about the program we tried to spawn, never about
```

## src/tools/workspace.ts:1552

```
// what the model passed — but it reads exactly like a bad-argument error,
```

## src/tools/workspace.ts:1591

```
/**
 * Best-effort {@link ensureWorkspaceGitRepo}. A host without git still gets a
 * full pass, just without history, so a failure here is never fatal.
 */
```

## src/tools/workspace.ts:1641

```
/**
 * Push the workspace repository to its configured remote, honoring the repo's
 * own push config.
 *
 * Skips silently when the workspace is not a repo or has no remote: the daemon
 * never invents one. Pushing is opt-in (`[memory] git_push`) to a remote the
 * operator set up.
 */
```

## src/tools/workspace.ts:1660

```
/** Best-effort {@link gitPushWorkspace}: the pass already committed, and a
 * failed push must not undo it. */
```

## src/tools/workspace.ts:1670

```
/** The daemon's own git calls. Always carries {@link GIT_SAFETY_FLAGS}. */
```

## src/tools/subagent.ts:1

```
/**
 * Sub-agent prompt assembly.
 *
 * Ported from `crates/daemon/src/tools/subagent.rs`, pinned by
 * `tests/engine_fixtures/subagent_parity.json`.
 *
 * A `[subagents.<name>]` config entry surfaces to the primary model as a
 * single `ask_<name>(query)` tool. Invoking it runs a *nested* tool loop on a
 * (typically cheaper) model over a subset of the in-process tools, then
 * returns only the agent's final text. The bulky intermediate tool results
 * never enter the primary model's context, and the primary model's tool
 * surface stays small — that is the cost/compression win.
 *
 * What lives here is the part that decides *what the sub-agent is told*:
 * prompt macro expansion, the conversation transcript it may see, and the
 * tool subset it is offered. Driving the nested loop is the caller's job.
 *
 * # The two-phase render, and why the order is the security boundary
 *
 * A sub-agent's system prompt is built in two passes that must run in this
 * order:
 *
 * 1. {@link renderTemplate} substitutes `{{char}}` / `{{user}}` / `{{#if}}`
 *    over the **authored** prompt. That text is trusted — it came from the
 *    config file.
 * 2. {@link expandPromptMacros} expands the sub-agent-only `{{file:}}` and
 *    `{{active_history:}}` macros.
 *
 * Macro output is inserted as a **terminal**. It is never re-scanned, for
 * macros or for anything else. That is what makes the boundary hold: a chat
 * message is untrusted input, and a user who types `{{file: ~/.ssh/id_rsa}}`
 * into the conversation must not thereby cause a file read whose contents are
 * shipped to an external provider. Because expansion happens *after* the var
 * pass and its output is never revisited, the literal text survives into the
 * prompt unexpanded — visible to the sub-agent as text, inert as a macro.
 *
 * Running the passes the other way round, or looping expansion to a fixed
 * point, reopens exactly that hole.
 */
```

## src/tools/subagent.ts:57

```
/** Notified when a `{{file:}}` target is refused or unreadable. */
```

## src/tools/subagent.ts:75

```
/**
 * The `{{char}}` / `{{user}}` / `{{date}}` / `{{time}}` substitution table.
 *
 * A sub-agent runs in its own LLM call and never sees the conversation's
 * injected time markers, so `{{date}}` and `{{time}}` are the only way its
 * prompt can anchor to "now" — they are filled from the live clock rather than
 * left blank.
 */
```

## src/tools/subagent.ts:163

```
/**
 * Resolve a `{{file:}}` target, preferring the active-prompt snapshot so the
 * bytes match what the main prompt used this turn, and falling back to the
 * live workspace file for anything not snapshotted.
 *
 * A refused or unreadable path expands to the empty string, matching the
 * "unknown var → empty" degradation elsewhere. It does *not* expand to an
 * error message: the result is fed to an external model, and a message naming
 * the rejected path would echo attacker-chosen text straight into the prompt.
 *
 * The target is confined by {@link resolvePath}, the same boundary the `read`
 * and `write` tools use. Absolute paths, `..` traversal and symlinks pointing
 * out of the workspace all expand to nothing. This is not defense in depth for
 * its own sake — expanded content is handed to an external provider, so an
 * unconfined path is an exfiltration primitive.
 */
```

## src/tools/subagent.ts:191

```
// lookup key can never be attacker-chosen: `normalizePromptVisiblePath`
```

## src/tools/subagent.ts:224

```
/**
 * Render the last `n` messages as a plain `Speaker: text` transcript.
 *
 * Assistant turns are labelled with the character name, user turns with the
 * display name. Empty turns and non-text blocks (thinking, tool calls) are
 * skipped; images are annotated inline.
 *
 * An `n` that does not parse yields the empty string rather than a default or
 * an error. That is the documented degradation, and it matters that it is not
 * "show everything": `{{active_history: all}}` is a plausible thing for a
 * prompt author to write, and it must not silently ship the whole
 * conversation to a cheaper third-party model.
 */
```

## src/tools/subagent.ts:245

```
// of `length` yields an empty window either way — and is kept only because
```

## src/tools/subagent.ts:330

```
/**
 * Render a sub-agent's allowed tool list to the outbound `tools` array.
 *
 * Only registered static tools are eligible; unknown names are skipped,
 * because the config layer cannot see the daemon's tool registry and so the
 * filter has to land here.
 *
 * `ask_*` can never appear, and that is structural rather than a check:
 * sub-agent tools are not in the static registry, so a config naming one is
 * simply dropped. The recursion cap and the "no `ask_*` affordance" guarantee
 * both fall out of this single filter, which is why it is worth keeping the
 * eligibility rule to exactly "is it in the registry".
 *
 * Order is stable: static tools in the order the agent listed them, then MCP
 * expansions. A model's tool choice is sensitive to ordering, so a subset that
 * reshuffled between turns would make the sub-agent's behaviour irreproducible.
 */
```

## src/tools/images.ts:88

```
/**
 * Why the `base64` crate would reject `b64`, or `undefined` if it would not.
 *
 * `atob` and `Buffer.from(…, "base64")` are both lenient: they skip characters
 * outside the alphabet and accept unpadded input, so `"aGVsbG8"` and
 * `"!!!not-base64!!!"` decode to *something* rather than failing. The Rust
 * engine rejects both, and the difference is the model being told its image
 * failed versus being handed a truncated file.
 *
 * The messages are reproduced verbatim because they reach the model through
 * the tool result. Three shapes, in the order the crate reports them:
 *
 * - `Invalid symbol {code}, offset {i}.` — trailing period included. A `=`
 *   anywhere but the final one or two positions counts as an invalid symbol,
 *   which is how `aG=sbG8=` and `aGVsbG8===` are caught.
 * - `Invalid input length: {n}` — when `n % 4 == 1`, a length no padding can
 *   explain.
 * - `Invalid padding` — the remaining `n % 4` of 2 or 3.
 */
```

## src/tools/images.ts:119

```
// Everything from the first `=` on must also be `=`.
```

## src/tools/execute.ts:1

```
/**
 * Running one tool the model asked for.
 *
 * Ported from `execute_tool_use`, `attach_generated_image`,
 * `record_tool_diagnostics`, `emit_tool_result`, `record_tool_result_message`
 * and `record_reported_message` in `crates/daemon/src/engine/tools.rs` — the
 * third of that module's three pieces, and the only one that was ever going to
 * be ported. The other two are the daemon-driven fallback loop and the
 * NDJSON server that fed the sidecar its tools; both are seam and both delete.
 *
 * `dispatch_within_deadline` came across earlier and lives in `dispatch.ts`
 * beside the routing table it wraps. What is here is everything *around* the
 * dispatch: the two frames the client sees, the cap on what the model reads,
 * the diagnostics row, and the generated-image side channel.
 *
 * Pinned by `tests/tools_fixtures/execute_parity.json`.
 *
 * # Frames, not a channel
 *
 * The Rust pushed onto a bounded `mpsc::Sender<ServerMessage>` and ignored the
 * send result — a closed channel means the client left, which is not this
 * layer's problem. Here that is a plain sink, the same {@link ToolExecution.sendDirect}
 * shape `turn.ts` and `command_dispatch.ts` already take, and
 * `SessionRouter` supplies it once `swp_server` is wired (#18, step 5). The
 * bounded channel's backpressure is gone with it; nothing downstream of a tool
 * result was relying on being throttled by one.
 *
 * `subagent` is deliberately never set. A nested `ask_<name>` loop runs its
 * frames through a forwarder that stamps the name on the way out, so tagging
 * here would double-write a field the forwarder owns.
 *
 * # What collapsed
 *
 * - `ToolDispatchOutcome`. It was a struct of one field by the time it was
 *   read — its second, a hand-built `tool_result` JSON value for the wire, had
 *   already been folded into the block. A one-field struct is a return value.
 * - `record_tool_result_message` and `record_reported_message` were the same
 *   function, one of them with `Role::User` written in rather than passed. They
 *   existed apart because one served the daemon-driven loop and the other the
 *   socket, and those are one caller now. {@link recordReportedMessage} is both.
 */
```

## src/tools/execute.ts:69

```
/** The requesting session's channel. Must not throw and may drop. */
```

## src/tools/execute.ts:91

```
/**
 * Run one tool and return the block that carries its result.
 *
 * The order is observable and is the Rust's: announce the call, dispatch,
 * truncate, attach any generated image, record diagnostics, announce the
 * result. Truncation happens *before* the frame, persistence and the LLM
 * payload, so every replay path sees the same bounded string.
 *
 * `intermediateMessages` is read and mutated rather than appended to — the
 * generated-image path hangs an {@link ImageRef} off the assistant turn that
 * asked for the tool. It is `&mut [Message]` in the Rust for exactly that
 * reason: a slice can be edited and cannot be grown.
 */
```

## src/tools/execute.ts:244

```
/**
 * Record one turn of a tool round for persistence, exactly as the loop
 * reported it.
 *
 * The loop decides the grouping and the order — an assistant turn carrying the
 * `tool_use` blocks, then one user turn carrying the round's results together
 * in ask order. Inferring either from the tool calls is what this replaced:
 * a round's tools run concurrently, so recording each result as it landed
 * stored one message per tool in whatever order they finished.
 *
 * Provenance is left unset. The request the loop ran on carries it, and the
 * persistence layer stamps it there.
 */
```

## src/tools/execute.ts:273

```
/**
 * The tool half of one turn: run a tool, record a turn, keep the list.
 *
 * This is what a tool loop is handed instead of a socket. It exists because the
 * two calls above share the message list — the loop records the assistant turn
 * that asked for a tool, and running that tool may hang a generated image off
 * it — and because a loop should not have to hold a `ToolContext`, a
 * diagnostics ring and a frame sink to ask for one tool.
 *
 * # There is no failure this cannot express
 *
 * {@link runTool} does not reject. `executeToolUse` turns every way a tool can
 * fail into a `tool_result` with `is_error` set, which is the shape the model
 * can act on. That is the whole of what `tool_rpc.ts` needed a second failure
 * channel for: over a socket, "the tool failed" and "the call never arrived"
 * are different events, and reporting the second as the first would describe a
 * plumbing problem as something the model did. In one process the second cannot
 * happen.
 */
```

## src/tools/execute.ts:297

```
/** Record a turn the loop produced. Must precede the tools it asked for. */
```

## src/tools/web.ts:25

```
/**
 * The signal a request should actually carry.
 *
 * The 30-second cap is this module's own and always applies. A caller's signal
 * — the tool deadline from `dispatch.ts` — is *added* to it rather than
 * replacing it, so whichever fires first wins and neither can be lengthened by
 * the other. Combining them is what makes the tool deadline able to interrupt
 * a hung request at all: JavaScript cannot cancel a promise, only abort the
 * fetch underneath it.
 */
```

## src/tools/web.ts:60

```
/**
 * Truncate to at most `maxBytes` **UTF-8 bytes**, never splitting a character.
 *
 * This is `String::len()` plus `floor_char_boundary`, and there is no way to
 * spell either in terms of JavaScript string indices: `.length` counts UTF-16
 * code units (so `"🎵".length` is 2 where Rust sees 4 bytes), and `.slice()`
 * will happily cut a surrogate pair in half. Encoding to bytes and decoding
 * back is the honest translation.
 *
 * `TextDecoder` with `fatal: false` would replace a partial trailing sequence
 * with U+FFFD, which is not what `floor_char_boundary` does — it backs the cut
 * off instead — so the boundary is found first and the slice is always valid.
 */
```

## src/tools/web.ts:82

```
// The parentheses around the cast are load-bearing. `bytes[end] as number &
```

## src/tools/web.ts:122

```
/**
 * Strip HTML tags and extract readable text.
 *
 * Three phases, and they interact in ways worth knowing:
 *
 * 1. **Block removal.** `<script>`, `<style>` and `<head>` go with their
 *    contents, matched case-insensitively in ASCII. An *unclosed* one drops
 *    everything after it — the Rust breaks out of the walk rather than
 *    recovering, so a page with a stray `<script` returns only its prefix.
 * 2. **Tag removal.** Any other `<…>` becomes a single space, because block
 *    elements are word boundaries. A `<` with no `>` after it is not a tag at
 *    all and survives as literal text.
 * 3. **Entity decoding, then whitespace collapse.** Decoding runs *after* tag
 *    stripping, so `&lt;script&gt;` decodes to the literal text `<script>` and
 *    is *not* treated as a tag. This is not a sanitizer and must not be used
 *    as one.
 */
```

## src/tools/web.ts:189

```
// `\p{White_Space}` is exactly `char::is_whitespace`; JavaScript's own `\s`
```

## src/tools/web.ts:212

```
/**
 * Handle `web_search`.
 *
 * A result field the provider omits becomes `""`, not `undefined` — the model
 * reads a uniform shape and a missing title is not an error worth failing the
 * whole search over. `answer` is the exception: it is present only when Tavily
 * returned one, because an empty answer and no answer mean different things.
 */
```

## src/tools/registry.ts:1

```
/**
 * The tool-definition registry: what the model is offered, and in what order.
 *
 * Ported from the definition half of `crates/daemon/src/tools/mod.rs`, pinned
 * by `tests/tools_fixtures/tool_registry_parity.json`.
 *
 * # Order is the cache key
 *
 * Anthropic caches on a prefix match and the tools array is the head of that
 * prefix, so the order tools are offered in is load-bearing in a way that is
 * invisible until a bill arrives. Three orderings matter and all three are
 * pinned by the fixture:
 *
 * 1. **Registry order** — {@link ALL_TOOLS}, which is where the Rust's
 *    seven-module concatenation ends up. The allowlist filters this list; it
 *    never reorders it, so listing `enabled_tools` in a different order in
 *    config changes nothing.
 * 2. **Sub-agent order** — sorted by name, because the Rust held them in a
 *    `BTreeMap`. See {@link subagentToolDefs} for why that sort cannot be
 *    `.sort()`.
 * 3. **Group order** — static, then `ask_<name>`, then MCP. That is
 *    {@link assembleToolSurface}, and it is the whole reason that function
 *    exists rather than three `concat`s at the call site.
 *
 * # What is not here
 *
 * Dispatch. `dispatch_tool` and the `ToolContext` trait stay Rust until
 * `swp_server` moves, because executing a tool emits `ToolCall` / `ToolResult`
 * / `SendImage` straight onto the client stream — see #18. This file is only
 * the surface a request is built from, which has no such dependency.
 *
 * # Divergence from the Rust: one file, not seven
 *
 * Each Rust tool module carried its own `tool_defs()` and `all_tools()`
 * concatenated them, so the offer order lived in a seven-line function nowhere
 * near the definitions it sequenced. The definitions are static data and the
 * order is the part that bites, so they are one list here. The handlers stay
 * in their own modules, where they have code to be near.
 */
```

## src/tools/registry.ts:61

```
/**
 * A registered tool's static definition.
 *
 * `description` is the raw template — `{{char}}` / `{{user}}` are rendered by
 * {@link renderToolDefs} on the way out, never here, so the registry stays a
 * constant.
 */
```

## src/tools/registry.ts:92

```
/**
 * Every registered tool, in offer order.
 *
 * The order is `images, web, activity, basic, workspace, history,
 * model_history` — the concatenation order of the Rust's `all_tools()`. It
 * looks arbitrary because it is: it is whatever order the modules were added
 * in, frozen by the cache. Do not sort it.
 */
```

## src/tools/registry.ts:414

```
/**
 * The tools offered for the `enabled_tools` allowlist, in registry order.
 *
 * Tools are opt-in: only names a pattern covers are offered. Filtering, not
 * selecting — a config listing `["git", "read"]` still offers `read` first,
 * because that is where `read` sits in {@link ALL_TOOLS}.
 */
```

## src/tools/registry.ts:438

```
/**
 * Build the outbound `tools` array from the allowlist, rendering `{{char}}` /
 * `{{user}}` in each description.
 *
 * `renderTemplate` substitutes in a single pass and never re-scans its own
 * output, so a character literally named `{{user}}` renders to the text
 * `{{user}}` rather than recursing into the user's name. That is deliberate —
 * a re-scanning pass makes the cache prefix depend on the character's name in
 * a way that is not stable — and the fixture pins it.
 */
```

## src/tools/registry.ts:461

```
/**
 * Synthesize the `ask_<name>` tool defs for the configured sub-agents,
 * rendering `{{char}}` / `{{user}}` in each description.
 *
 * Offered in sub-agent-name order, not `enabled_subagents` order: the Rust
 * iterated a `BTreeMap` and filtered it by the enabled list, so reordering the
 * enabled list in config must not reorder the surface. A name in
 * `enabled_subagents` with no `[subagents.<name>]` entry is silently dropped,
 * and a duplicate entry offers the tool once — both fall out of iterating the
 * config rather than the enabled list, and both are pinned.
 */
```

## src/tools/registry.ts:499

```
/**
 * Concatenate the tool surface in offer order: static tools, then `ask_<name>`
 * delegation, then MCP.
 *
 * Anthropic caches on a prefix match, so the order the tools are offered in is
 * part of the cache key: appending a newly-enabled sub-agent in the middle
 * would invalidate every downstream block. Each group is internally stable
 * (registry order, sub-agent name order, and the MCP registry's pinned sort),
 * and this is the one place the groups are sequenced.
 *
 * Trivial enough to inline at the call site, which is exactly why it is not:
 * three `concat`s written out twice is how the two callers drift.
 */
```

## src/tools/mcp_holder.ts:36

```
/**
   * Adopt a new registry and hand back the one it replaced, for the caller to
   * shut down.
   *
   * The old registry is returned rather than shut down here, because the order
   * matters and belongs to the caller: swap first so nothing can take another
   * reference to the old one, *then* close its transports.
   */
```

## src/tools/mcp_holder.ts:50

```
/**
   * A live view for a consumer that only calls tools.
   *
   * The distinction that makes this worth having: a turn's tool *definitions*
   * are computed once, in `buildGenerationRequest`, and reused for every round
   * of its loop — so the surface a turn advertises cannot change underneath it
   * and its cache prefix is stable whatever a reload does. Dispatch is the only
   * thing that should follow the swap, and this is what lets it.
   *
   * Without it, a turn holding the replaced registry would find every remaining
   * MCP call dead once its transports closed — not one call, the rest of the
   * turn. With it, tools that still exist keep working and tools that genuinely
   * went away report exactly that, through the registry's ordinary
   * "not yet implemented". A call already on the wire when the swap lands still
   * fails; nothing can prevent that one.
   */
```

## src/tools/basic.ts:37

```
/**
 * `str::parse::<i32>()`.
 *
 * The `n === 0` branch is not redundant: `Number("-0")` is `-0`, which is a
 * distinct value in JavaScript and serializes as `-0` in JSON. Rust has no such
 * thing — `"-0".parse::<i32>()` is `0` — so `2d6-0` would otherwise report a
 * modifier of `-0` to the model.
 */
```

## src/tools/basic.ts:69

```
/**
 * Parse dice notation like `2d6+3`, `1d20`, `4d6-1`, `d8`.
 *
 * Three details are load-bearing and all three are pinned:
 *
 * - The modifier scan skips position 0, so the `-` in `d-6` is part of the
 *   *sides* and fails as `Invalid sides: -6` rather than parsing as a
 *   modifier on an absent side count.
 * - Trimming happens once, up front. Inner spaces are not removed, so `2 d 6`
 *   fails on the count `"2 "` and `2d6 +3` fails on the sides `"6 "`.
 * - A leading `+` is accepted by Rust's integer parsers, so `+2d6` is two
 *   six-sided dice. A leading `-` is not, so `-2d6` fails.
 */
```

## src/tools/basic.ts:146

```
/**
 * Roll dice according to parsed notation. Returns the individual rolls and
 * their total.
 *
 * The total saturates rather than wrapping: `count` is a `u32`, so a notation
 * asking for four billion dice would otherwise overflow the running sum.
 */
```

## src/tools/basic.ts:218

```
/**
 * Human-friendly local date, e.g. `"Saturday, April 4th, 2026"`. Feeds the
 * `{{date}}` template variable so prompts can anchor freshness to "today".
 *
 * Spelled out rather than delegated to `Intl`: the Rust used chrono's `%A`/`%B`,
 * which are always English regardless of locale, and an `Intl` call would make
 * the prompt — and therefore the cache prefix — depend on the host's locale.
 */
```

## src/tools/subagent_loop.ts:1

```
/**
 * Running a sub-agent's nested tool loop.
 *
 * Ported from `run`, `resolve_spec_and_model`, `build_request` and
 * `spawn_forwarder` in `crates/daemon/src/tools/subagent.rs`. What the
 * sub-agent is *told* — prompt macros, transcript, tool subset — is
 * `subagent.ts`; this drives the loop it is told into.
 *
 * `ask_<name>(query)` runs a whole second conversation on a (typically
 * cheaper) model, over a subset of the tools, and returns only its final text.
 * The bulky intermediate tool results never enter the primary model's context
 * and the primary model's tool surface stays small — that is the whole win.
 *
 * # The recursion cap is structural, twice over
 *
 * The nested loop runs against a context with `runSubagent` **removed**, so a
 * hallucinated `ask_*` answers `NotImplemented` instead of recursing. That is
 * the backstop. The primary guarantee is that `subagentToolSubset` only offers
 * tools from the static registry, and `ask_*` is never in it — so a
 * well-behaved model has no affordance to hallucinate from in the first place.
 *
 * # The forwarder
 *
 * The nested loop's frames are tagged with the sub-agent's name and relayed to
 * the client, so the UI renders the nested loop instead of freezing on the
 * `ask_<name>` call. It is a *view*: the intermediate tool results it shows
 * still never enter the primary model's context. A background context (a
 * heartbeat, dreaming) has no live turn to stream into, so its frames are
 * dropped — the Rust drained them off a bounded channel for the same reason
 * they are simply not forwarded here.
 *
 * # The system prompt goes top-level
 *
 * The Rust forked on SDK: Anthropic-cache providers took the prompt as an
 * inline `role:"system"` entry, everyone else took it top-level. Its stated
 * reason was to mirror dreaming and compaction, which must keep an instruction
 * at a fixed index so the chat prefix they extend stays byte-stable.
 *
 * That reason does not reach here. A sub-agent request is built from scratch —
 * one user message, no prefix to protect and nothing that can shift. What the
 * fork cost was real, though: inline on Anthropic means the adapter wraps the
 * prompt in `<system_instruction>` and merges it into the preceding user turn,
 * so it lost the system role and landed *after* the question. Top-level is
 * cached either way; `tsDefaultPlacement` anchors a breakpoint on the system
 * prefix.
 */
```

## src/tools/subagent_loop.ts:181

```
// it and their output is never re-scanned, so a chat message containing the
```

## src/mcp/client.ts:1

```
/**
 * MCP (Model Context Protocol) client.
 *
 * Ported from `crates/daemon/src/mcp/mod.rs`. The daemon is an MCP *client*:
 * each `[mcp.<name>]` config entry points at an external server — a stdio child
 * process or a remote HTTP endpoint — that it connects to, discovers tools from
 * via `tools/list`, and invokes via `tools/call`. Servers are never daemon
 * code; anything speaking standard MCP works unchanged.
 *
 * A thin, transport-agnostic wrapper, the same shape the Rust had over `rmcp`.
 * Namespacing lives in `tools/mcp_registry.ts`, not here.
 */
```

## src/mcp/client.ts:55

```
/**
 * The request itself did not complete — the transport, not the tool.
 *
 * Split out from {@link McpError} because the registry has to tell "the server
 * is not there" apart from "the tool ran and said no", and the two arrive at
 * the same catch. Only the former means the connection is worth rebuilding;
 * treating a tool's own error as a dead socket would reconnect on every failed
 * tool call.
 *
 * **Not a signal that the call did not happen.** A request can fail after the
 * server has acted on it — the response is what got lost. Anything reacting to
 * this must not re-send the call. See `McpRegistry.call`.
 */
```

## src/mcp/client.ts:183

```
/**
   * Invoke `tool` with `args`, returning a flattened JSON result.
   *
   * `args` must be a JSON object or null — a bare scalar or array is a caller
   * error, not something to forward and let the server reject.
   */
```

## src/testing/mock_provider.ts:1

```
/**
 * An OpenAI-compatible provider that answers from a script.
 *
 * Point `[providers.*]` at it and the daemon makes real provider calls —
 * through the real `openai` SDK, the real adapter, the real stream consumer —
 * against something that costs nothing, never rate-limits, and says exactly
 * what the test told it to say. It is the piece that was missing for testing
 * anything above the wire: every suite in `tests/` either stops at the request
 * it would have sent or substitutes a fake adapter, so the path from
 * `handler/turn.ts` down through `providers/openai.ts` and back up into
 * `active.jsonl` had no coverage that ran it end to end.
 *
 * Two ways in:
 *
 * ```ts
 * const mock = await startMockProvider({ script: [{ text: "hi" }] });
 * // …point a daemon at mock.url, drive it, then:
 * expect(mock.requests[0].body.messages.at(-1).content).toBe("hello");
 * await mock.stop();
 * ```
 *
 * ```console
 * $ bun run src/testing/mock_provider.ts --port 8899
 * mock provider listening on http://127.0.0.1:8899/v1 (model: mock-model)
 * ```
 *
 * The standalone form echoes the user's last message, which is enough to hold
 * a conversation in the TUI and see turns land on disk.
 *
 * # Why OpenAI-compatible
 *
 * It is the dialect with the most adapters behind it — `providers/openai.ts`
 * fronts OpenAI, DeepSeek, Kimi, xAI and every other gateway that differs only
 * by `base_url` — so one mock exercises the widest path. `sdk = "anthropic"`
 * and `sdk = "gemini"` speak different wires and would each need their own;
 * they are worth adding when something needs them, not before.
 *
 * # What it is faithful to
 *
 * The shapes the `openai` SDK parses and the adapter reads, and no more:
 * `choices[0].delta.{content,reasoning_content,tool_calls}`, `finish_reason`,
 * and a trailing `usage` chunk (the adapter sends
 * `stream_options: {include_usage: true}`, so a stream without one reports
 * zero tokens and the ledger records a free call). Tool-call arguments are
 * emitted as fragments across chunks, because a mock that always sent them
 * whole would never exercise the adapter's accumulator — which is the part
 * that can break.
 */
```

## src/testing/mock_provider.ts:150

```
// A scripted `delayMs` is the point of some tests, so the server must not
```

## src/testing/mock_provider.ts:230

```
/**
 * Echo the last user message.
 *
 * Deliberately not an empty reply: a turn that persists an empty assistant
 * message looks the same on disk as a turn that never ran, and the standalone
 * server exists to make a working turn visible.
 */
```

## src/testing/mock_provider.ts:296

```
/**
 * The same answer as SSE.
 *
 * Text and tool arguments go out in fragments rather than whole, because the
 * adapter accumulates both and an always-whole mock would leave that
 * accumulation untested. `usage` rides its own trailing chunk with an empty
 * `choices`, which is where the real API puts it under
 * `stream_options.include_usage`.
 */
```

## src/testing/mock_anthropic.ts:1

```
/**
 * An Anthropic Messages API that models the prompt cache.
 *
 * The OpenAI mock beside this one (`mock_provider.ts`) answers from a script,
 * which is enough for turn mechanics and useless for the cache: OpenAI-compatible
 * backends cache server-side and put nothing on the request to assert on.
 * `cache_control` is an Anthropic concept, and the prompt cache is where shore's
 * expensive failures live — a prefix byte moves, a 0.1× read silently becomes a
 * 2.0× write, and nothing in the response says so.
 *
 * So this mock does not just return canned SSE. It keeps a table of prefixes it
 * has seen and reports `cache_read_input_tokens` / `cache_creation_input_tokens`
 * accordingly. **A divergent byte arrives as a cache write in the ledger** —
 * the production symptom itself, not a proxy for it — which means a test can
 * assert the thing an operator would actually check:
 *
 * ```ts
 * await turn("hello");
 * await turn("and again");
 * expect(mock.lastUsage.cache_creation_input_tokens).toBe(0);  // nothing moved
 * ```
 *
 * # How the cache is modelled
 *
 * Anthropic caches at *placed breakpoints*, not as a free-running
 * longest-prefix match, and the adapter's schedule places at most four (see
 * `providers/anthropic.ts`). So:
 *
 * 1. Walk system blocks then messages in wire order, accumulating tokens.
 * 2. At every block carrying `cache_control`, hash the prefix **up to and
 *    including** that block and remember its cumulative token count.
 * 3. On a request, take the longest of those prefixes that is already in the
 *    table and unexpired — that is `cache_read_input_tokens`.
 * 4. Everything between that and the last breakpoint is
 *    `cache_creation_input_tokens`; everything after the last breakpoint is
 *    plain `input_tokens`. The three sum to the total, as they do upstream.
 * 5. Store every breakpoint prefix, so the next request can hit it.
 *
 * TTL is honoured per entry (`cache_control.ttl: "1h"`, else five minutes)
 * against an injectable clock, so warm→cold is testable without waiting.
 *
 * # What this does not prove
 *
 * That Anthropic's cache behaves the way this models it. The mock establishes
 * that **we sent identical bytes** and that our accounting of the answer is
 * right. That is the half we control and the half that has broken; the other
 * half is what the live-key check against the real API is for. Do not read a
 * green suite here as a guarantee about the provider.
 *
 * Token counts are a deterministic estimate (`~4 chars`), not Anthropic's
 * tokeniser. Tests should assert on the *split* between read/creation/input and
 * on whether a count changed between turns — never on an absolute number.
 */
```

## src/testing/mock_anthropic.ts:78

```
/** Signature for the thinking block. Defaults to a fixed non-empty string,
   *  because an unsigned thinking block is rejected on replay. */
```

## src/testing/mock_anthropic.ts:183

```
/**
 * The prefix table.
 *
 * Separated from the server so it can be unit-tested and reasoned about on its
 * own — it is the part of this file that encodes a claim about how Anthropic
 * behaves, and the live-key check validates exactly this.
 */
```

## src/engine/types.ts:1

```
/**
 * Wire-shape types mirroring `client/shore-common/src/protocol/types.rs`.
 *
 * `Message` is the canonical form post-normalize: `content` is always
 * present (derived from blocks or kept as-is for legacy data),
 * `images` and `content_blocks` arrays are always present (possibly
 * empty), and `alt_*` fields are present when the message has stored
 * alternatives.
 *
 * Serialization to JSON for the wire happens via `JSON.stringify` on
 * these objects directly; skip-if-empty / skip-if-none parity is handled
 * by omitting the field from the object rather than emitting `null`.
 */
```

## src/engine/types.ts:59

```
// array (see `encode_image_block`), so the adapter must accept them here.
```

## src/engine/types.ts:93

```
/**
   * Model id that minted this message's content, in the ledger's vocabulary.
   * Finer-grained than `provider_key`, which an aggregator shares across many
   * model families — the replay guard needs both.
   */
```

## src/engine/tool_loop.ts:1

```
/**
 * The shape every tool loop has in common.
 *
 * Ported from `crates/daemon/src/engine/tool_loop.rs`, which had already done
 * the hard part: Shore ran three hand-written copies of this control flow — the
 * chat path, the compaction pass, and the dreaming librarian — and they had
 * drifted on the one part of it that is a genuine policy choice, namely whether
 * a loop that hits its cap gives the model a final turn to see the results it
 * just asked for. That choice is [`CapBehavior`], named and made at the call
 * site, and it is preserved here exactly.
 *
 * # Why this is not `stopWhen: stepCountIs(n)`
 *
 * The AI SDK has a loop, and it is not this one. Two differences, both silent:
 *
 *   1. **The cap counts dispatch rounds, not model calls.** `stepCountIs(n)`
 *      counts steps, where a step is a model call plus its tools. A request
 *      configured for `max_tool_iterations: 2` gets three model calls out of
 *      the Rust and two out of `stepCountIs(2)`.
 *   2. **`CloseWithFinalTurn` spends a call after the cap.** The chat path's
 *      return value is the reply a user reads, so a capped run still lets the
 *      model answer with the last tool results in hand. The SDK just stops, so
 *      the user would get the tool-request turn as their reply.
 *
 * Neither shows up as an error. Both are pinned by
 * `tests/engine_fixtures/tool_loop_parity.json`, generated from the Rust.
 */
```

## src/engine/tool_loop.ts:42

```
/**
   * Stop the moment the cap is reached. The tool results from the final round
   * are appended to the request but never sent — the caller's output comes from
   * what it accumulated, not from a closing message.
   */
```

## src/engine/tool_loop.ts:67

```
/**
 * The parts of a tool loop that genuinely differ between callers.
 *
 * Appending the assistant turn is the driver's job, not [`runToolLoop`]'s, and
 * each caller does it at a different point: the background passes append inside
 * `callModel`, because every turn they see comes from there; the chat path
 * appends inside `dispatch`, because its first turn was streamed by its caller
 * and never passes through `callModel` at all. Only the tool-result turn is
 * identical everywhere, so that is the one the loop owns.
 */
```

## src/engine/tool_loop.ts:84

```
/**
   * Run one round of tool uses. Tool failures come back as result blocks with
   * `is_error` set, never as a throw — a failed tool is something the model is
   * told about, not something that ends the loop.
   *
   * `turn` is the response that asked for these tools, passed because every
   * caller needs it: to append the assistant turn, to emit a stream boundary,
   * or to pair a transcript row with the tools it went on to call.
   *
   * Appending the tool-result turn to the request is the loop's job, not the
   * driver's; `appendToolResults` is how the loop does it.
   */
```

## src/engine/tool_loop.ts:128

```
// the moment the cap is met, so the loop never comes back around with it
```

## src/engine/merge.ts:1

```
/**
 * Collapsing a tool loop into one assistant turn.
 *
 * Storage keeps the rounds apart because the provider APIs need them that way —
 * assistant `tool_use`, user `tool_result`, assistant text are separate
 * messages. Anything showing a conversation to a person wants one message:
 *
 *     [user, asst(tool_use), user(tool_result), asst(text)]
 *       -> [user, asst(thinking + tool_use + tool_result + text)]
 *
 * Ported from `crates/common/src/protocol/merge.rs` and pinned by
 * `tests/engine_fixtures/merge_parity.json`.
 *
 * That file lived in `common` because it was filed as client-side rendering,
 * but no Rust client ever called it — `merge_tool_loop_messages` was its only
 * export and its three consumers were all in the daemon. It comes across with
 * the daemon rather than staying behind with the TUI and CLI.
 */
```

## src/engine/merge.ts:152

```
// assistant seen — the closing message when there was one, otherwise the
```

## src/engine/atomic.ts:1

```
/**
 * Write-then-rename, so a reader never sees a half-written file.
 *
 * Ported from `crates/daemon/src/engine/atomic.rs`. The temp file is created
 * in the destination's own directory because `rename` is only atomic within a
 * filesystem, and a temp directory can easily be on a different one.
 */
```

## src/engine/prompt.ts:1

```
/**
 * Prompt assembly — the system blocks and the trimmed, time-marked message
 * list that every chat-shaped request is built from.
 *
 * Ported from `crates/daemon/src/engine/prompt.rs`. Pinned by
 * `tests/engine_fixtures/prompt_parity.json`, whose every value was produced
 * by driving the real Rust.
 *
 * Two things here are load-bearing for cache reuse and are easy to get subtly
 * wrong:
 *
 *   - **Token estimates count UTF-8 bytes**, not characters. Rust reaches
 *     `str::len()`, which is bytes; JavaScript's `.length` is UTF-16 code
 *     units and disagrees on everything non-ASCII. A history of Japanese text
 *     would be trimmed at a different point.
 *   - **Time markers render in local wall-clock**, so they depend on a
 *     timezone. The zone is an explicit parameter rather than the host's,
 *     because a marker that moves is a changed prefix, and a changed prefix is
 *     a cache miss on every turn.
 */
```

## src/engine/prompt.ts:50

```
/**
 * The built-in system template, used when the character has no AGENTS.md.
 *
 * Held here rather than read from disk: the Rust baked it in at compile time
 * via `include_prompt!` (which strips exactly one trailing newline, hence no
 * newline at the end of this string), and the sidecar has no reason to make it
 * a runtime file read. The character/user definitions, TOOLS.md and the memory
 * index are separate system blocks, which is why this is so thin.
 */
```

## src/engine/prompt.ts:93

```
// These are `| undefined` rather than bare optional because the repo runs
```

## src/engine/prompt.ts:202

```
/**
 * What is left for messages after the system blocks and the output
 * reservation. Saturates at zero rather than going negative — a system prompt
 * larger than the context window is a misconfiguration, but it must not
 * produce a nonsense budget.
 */
```

## src/engine/prompt.ts:219

```
/**
 * Mustache-ish rendering: `{{key}}` substitution and `{{#if key}}…{{/if}}`
 * blocks, where "truthy" means present in `vars` and non-empty.
 *
 * A tag whose key is **not** in `vars` is left verbatim, not blanked. The
 * Rust's doc comment claimed otherwise ("or empty string if key not found")
 * and so did the name of the test covering it; both were wrong about the code
 * beneath them, which only ever replaced keys it had. The fixture records what
 * actually happens.
 *
 * Nested conditionals do not work, and that behaviour is reproduced rather
 * than fixed: the close-tag search takes the *first* `{{/if}}`, which for a
 * nested block is the inner one, so the outer block ends early and a stray
 * `{{/if}}` survives into the output. No shipped template nests, and inventing
 * a different answer here would be a silent divergence in the one place a
 * divergence costs a cache prefix.
 *
 * **One deliberate divergence.** The Rust substituted variables by iterating a
 * `HashMap`, whose order is unspecified and reseeded per map — and it replaced
 * into the accumulating result, so a value containing another key's tag was
 * re-scanned or not depending on that order. Given `{a: "{{b}}", b: "B"}`,
 * `"{{a}}"` rendered as `"B"` or `"{{b}}"` at random; driven through
 * `assemble_prompt`, a character named `{{user}}` produced two different system
 * prompts across runs. A nondeterministic system prompt is a nondeterministic
 * cache prefix. This does a single pass and never re-scans what it
 * substituted, which is deterministic, and agrees with the Rust in every case
 * where the Rust agreed with itself.
 */
```

## src/engine/prompt.ts:371

```
/**
 * The relative half of a marker.
 *
 * The rounding is `f64::round`, half away from zero, and the boundaries are
 * exclusive on the way in, which produces two readings worth knowing:
 * exactly 1.5 hours is "2 hours later", and exactly 36 hours is "2 days
 * later". "1 days later" cannot be produced at all — the days arm only sees
 * gaps of 36 hours or more, which round to 2 or higher.
 */
```

## src/engine/prompt.ts:411

```
/**
 * `Saturday 2026-04-04 · 9:14 PM` — chrono's `%A %Y-%m-%d · %-I:%M %p`.
 *
 * Shared with the heartbeat prompt, which prepends the same reading as its own
 * `[Current time: …]` line. That sharing is the Rust's design and not a
 * convenience: `build_heartbeat_prompt` documented that Shore has no time tool
 * because chat gets its anchor from the marker built here and a heartbeat gets
 * one from its prompt. Two spellings of the same clock would make a character's
 * sense of the hour depend on which kind of turn it was having.
 */
```

## src/engine/prompt.ts:464

```
/**
 * Keep the newest messages that fit, drop orphaned tool-loop heads, then
 * inject time markers.
 *
 * The newest message is always kept even when it alone blows the budget —
 * sending nothing is worse than sending too much.
 */
```

## src/engine/prompt.ts:537

```
// is anything else the marker lands on `content` alone and never
```

## src/engine/conversation.ts:1

```
/**
 * The per-character conversation engine.
 *
 * Ported from `ConversationEngine` in `crates/daemon/src/engine/mod.rs`, pinned
 * by `tests/engine_fixtures/engine_parity.json`. It is a coordinator, not a
 * store: `MessageStore` owns `active.jsonl`, `SegmentReader` owns the frozen
 * segments, and this holds the two together, keeps the counters clients use to
 * detect change, and pushes a snapshot after anything that mutates.
 *
 * # Two counters, and they are not the same question
 *
 * `revision` answers "did anything change" and advances on every mutation.
 * `historyRewriteGeneration` answers "did history I already sent you change
 * *underneath* you", and advances only when existing turns are rewritten —
 * edit, delete, truncate, replace, alternate selection, reset, reload. A plain
 * append leaves it alone, and that is load-bearing rather than an
 * optimisation: long-lived provider subprocesses stay warm across an
 * append-only conversation and must be rotated when the past changes, because
 * they still remember turns that no longer exist.
 *
 * A truncate that removed nothing advances *neither*, and does not broadcast.
 * "Regenerate when there is nothing to regenerate" is a no-op, not an event.
 *
 * # Where the merge happens is observable
 *
 * `displayHistory` merges the archived half and the active half *separately*
 * and concatenates, rather than merging the concatenation. The two are not the
 * same: a tool loop split across the compaction boundary would fold into one
 * assistant turn under the second reading and swallow the boundary with it, so
 * `activeStart` — the index the client uses to grey out scrollback — would
 * point into the middle of a merged message. Merging each half keeps the
 * boundary an index that exists.
 */
```

## src/engine/conversation.ts:144

```
/**
   * Everything a client shows: archived scrollback first, then the active
   * tail, with the index where active context begins.
   *
   * A segment that fails to load is logged and skipped rather than failing the
   * call — the alternative is a client that can render nothing because one old
   * file went bad.
   */
```

## src/engine/conversation.ts:220

```
/**
   * Alternate-response bookkeeping. Setting or adding a candidate is not a
   * rewrite — the stored turns do not change, only which one is marked
   * current — but *selecting* one is, because it swaps the body of a message
   * the client and any warm provider state already have.
   */
```

## src/engine/conversation.ts:275

```
// live store, and `MessageStore` rewrites `active.jsonl` from exactly
```

## src/engine/wire_images.ts:1

```
/**
 * Filling in `ImageRef.data` before a message goes over the wire.
 *
 * Ported from the three embedding helpers in
 * `crates/daemon/src/handler/images.rs`, pinned by the snapshot cases in
 * `tests/engine_fixtures/engine_parity.json`.
 *
 * Images live on disk as paths. A client — the TUI, the matrix bridge — may be
 * on a different machine and cannot open them, so every snapshot that leaves
 * the daemon carries the bytes inline. `Message.serializeForStorage` strips
 * `data` again on the way back to disk, so this is a wire concern only and the
 * stored conversation never grows base64.
 *
 * This lives beside the engine rather than with `llm/images.ts`, which does a
 * different job: that one resolves media types and enforces a size cap for a
 * *provider* request. Here there is no cap and no type check, because the
 * client renders whatever it is handed. When the handler moves (#12, step 3)
 * these will be neighbours again.
 *
 * An unreadable path is not an error. The Rust logged and moved on, leaving
 * `data` absent — a broken attachment costs one missing image, not the whole
 * history snapshot the client needs to render anything at all.
 */
```

## src/engine/message_store.ts:1

```
/**
 * The conversation store — `active.jsonl` and everything that reads or writes
 * it.
 *
 * Ported from `crates/daemon/src/engine/messages.rs`, pinned by
 * `tests/engine_fixtures/messages_parity.json`. That fixture is operation
 * *traces* rather than single calls, because a store is stateful and the
 * interesting behaviour is what a sequence leaves on disk.
 *
 * One line of JSON per message, rewritten whole on every mutation through a
 * temporary file and a rename, so a reader never sees half a conversation. The
 * whole-file rewrite is not an oversight: edits, deletes and alternate
 * selection all change messages in place, and an append-only log would need
 * compaction to stay readable by the CLI that tails it.
 */
```

## src/engine/message_store.ts:61

```
/**
 * The human-readable summary of a set of blocks: text (and optionally tool
 * results), each trimmed, empties dropped, joined by newlines.
 *
 * Mirrors `derive_content_from_blocks_with`. Thinking and tool_use never
 * contribute — the first is not for the reader and the second is not prose.
 *
 * The trim is Rust's, not JavaScript's. The two disagree at both ends: `.trim()`
 * strips U+FEFF, which Rust keeps, and keeps U+0085, which Rust strips. A block
 * whose text is only one of those is dropped by one and preserved by the other,
 * and this function decides both what a message reads as and whether a
 * completion notification has anything to say.
 */
```

## src/engine/message_store.ts:227

```
/**
 * An alternative captured from a message: its non-blank text blocks only.
 *
 * Thinking, tool calls and tool results are all dropped — an alternative is a
 * response a person chooses between, and the machinery that produced it is not
 * part of that choice. When nothing survives, the message's own `content` is
 * used so an alternative is never empty for a message that said something.
 */
```

## src/engine/message_store.ts:485

```
/**
   * Stamp `prior` plus the just-generated response onto the last assistant
   * message in `messages`.
   *
   * Static because it runs on a tail that has not been committed to the store
   * yet. The merge is only used to *find* which message is active; the fields
   * are written to the raw message with that id, since the merged copy is a
   * clone and would be thrown away.
   */
```

## src/engine/message_store.ts:515

```
/**
   * Switch a message to one of its stored alternates.
   *
   * Two paths, and the difference matters. When the message is the current
   * tail, everything after the last real user turn is dropped and the selected
   * body replaces it — which discards the tool loop that produced the reply,
   * because that loop belongs to the response being replaced. When it is an
   * older message, it is swapped in place and the conversation after it stands.
   */
```

## src/engine/segments.ts:1

```
/**
 * Frozen conversation history — the segment files compaction leaves behind.
 *
 * Ported from `crates/daemon/src/engine/segments.rs`, pinned by
 * `tests/engine_fixtures/engine_parity.json`.
 *
 * Compaction moves older messages out of `active.jsonl` into numbered JSONL
 * files under `segments/`, and records them in `compaction.json`. Each segment
 * is immutable once written, so this side only ever reads.
 *
 * # The manifest is the authority, not the files
 *
 * `totalMessageCount` comes from the manifest's own counter and is never
 * recomputed from what the segment files contain. The two can disagree — the
 * fixture pins a manifest claiming 99 messages over three real ones — and the
 * manifest still wins. That is what the Rust did, and it matters because the
 * count feeds the client's "N archived messages" display while the files are
 * only read when someone scrolls back that far.
 *
 * The writer still lives in Rust (`memory/compaction_impls.rs`) and moves with
 * the memory module (#12, step 5). Nothing here depends on that: a segment is
 * finished the moment it is written, so reading one is not racing anybody.
 */
```

## src/engine/segments.ts:42

```
/**
 * `compaction.json`. Absent means no compaction has happened yet, which is not
 * an error — a character that has never been compacted has no history to read.
 */
```

## src/engine/segments.ts:66

```
/**
   * Read the manifest from a character directory.
   *
   * A missing `compaction.json` yields an empty reader. A *corrupt* one does
   * not: it throws, the same as the Rust, because a manifest that will not
   * parse means an unknown amount of history is silently invisible.
   */
```

## src/engine/segments.ts:96

```
// claiming otherwise; `engine_parity.json` had no case covering it, and the
```

## src/commands/memory.ts:52

```
/**
 * Counts, or hits.
 *
 * The character is the session's — there is no name argument, so this always
 * answers for whoever is talking.
 */
```

## src/commands/memory.ts:70

```
/** File counts by bucket. The three always sum to `entries`. */
```

## src/commands/memory.ts:92

```
/**
 * A text search, rendered for a person to read.
 *
 * `query` is echoed exactly as it arrived, untrimmed — the tokenizer deals with
 * the whitespace, the echo does not.
 */
```

## src/commands/dispatch.ts:1

```
/**
 * The command table: a name, and the handler it reaches.
 *
 * Ported from `crates/daemon/src/commands/mod.rs`, pinned by
 * `tests/commands_fixtures/dispatch_parity.json`.
 *
 * Every handler here has its own frozen fixture already. What this module adds
 * is the routing, and routing is where the silent failures live: an arm wired
 * to the wrong handler answers *something*, and a name missing from the table
 * becomes "unknown command" for a client that has been sending it for months.
 * So the fixture drives every name the Rust knows — and three it does not —
 * through the real dispatcher and records what came back.
 *
 * # One context, deliberately mutable
 *
 * `switch_model`, `reset_model`, `config` and `config_reset` write the active
 * model back through the context, and the dispatcher's caller mirrors it into
 * the session. That is the Rust's `&mut CommandContext`, and the same object
 * has to reach every arm for it to work — so this passes one
 * {@link CommandSession} rather than building a fresh narrow context per call.
 * The narrow contexts the individual commands declare still hold: this
 * satisfies each of them structurally.
 *
 * # Nothing is injected any more
 *
 * Two arms landed here unwired — `compact` and `keepalive_ping_now`, the only
 * two that reach an LLM — because each was blocked on a module that had not
 * ported. Both are real arms now. What they need is not a missing module but a
 * *runtime*: something that can make a provider call, reach the tool layer, or
 * ping a cached prefix. `deps.compaction` and `deps.keepalive` carry those the
 * way `deps.ledgerPath` carries `usage`'s, and an absent one still refuses with
 * `unwired` — which is what a build with no LLM client behind it would do.
 */
```

## src/commands/dispatch.ts:143

```
/**
 * Run one command against a character's conversation.
 *
 * Throws {@link CommandError}; {@link commandFrame} is what turns either
 * outcome into a frame. The split is not the Rust's — it returned the frame
 * from `dispatch` — and it exists because the characterless path needs the same
 * envelope from a different table, and building it twice is how the two drift.
 */
```

## src/commands/dispatch.ts:284

```
// this one is in discovery order because there is no current character.
```

## src/commands/dispatch.ts:308

```
/**
 * The frame a command's outcome becomes.
 *
 * A success carries the command's own name back, which is what lets a client
 * correlate an answer it did not ask for a rid on. A failure carries the code
 * the handler chose; anything thrown that is not a {@link CommandError} is an
 * internal error, because a handler that threw a bare `Error` has already
 * failed in a way no code describes.
 */
```

## src/commands/providers.ts:1

```
/**
 * Provider discovery commands: `list_providers`, `refresh_provider_models`,
 * `refresh_all_provider_models`, `list_provider_models`.
 *
 * Ported from `crates/daemon/src/commands/providers.rs`, pinned by
 * `tests/commands_fixtures/providers_parity.json`.
 *
 * # Secrets do not leave this module
 *
 * `list_providers` reports key *names*, whether each is enabled, and a boolean
 * for whether its env var currently holds a value. Not the env var's name, not
 * the value, not a prefix of it. A variable holding only whitespace reads as
 * unset — in the listing and in the key selection alike, so what the report
 * says and what a refresh would do agree.
 *
 * # A refresh only ever replaces a cache on success
 *
 * Every failure — a disabled provider, a missing key, a 500 from upstream —
 * leaves whatever was on disk exactly as it was. The daemon must never end a
 * refresh knowing about fewer models than it started with, so the write is the
 * last thing that happens and only on the success path.
 *
 * `refreshAll` follows from the same rule at the batch level: a per-provider
 * failure is aggregated into the report rather than aborting the run, because
 * one provider's expired key is no reason to leave the others stale.
 */
```

## src/commands/providers.ts:70

```
/** Whether the env var holds a non-blank value. The value itself never escapes. */
```

## src/commands/providers.ts:266

```
/**
 * A provider's merged model list: discovered (from cache) plus statically
 * configured.
 *
 * Static entries are always returned, even with no cache at all — that is the
 * manual escape hatch, and they are never filtered by `discovery.ignore`
 * either, because a hand-written catalog entry is by definition intentional.
 *
 * A provider counts as known if the registry has it *or* a static entry
 * references it, so a config that predates the registry still answers.
 */
```

## src/commands/compact.ts:1

```
/**
 * The `compact` command: run a compaction pass, and report what it did.
 *
 * Ported from the `compact` half of `crates/daemon/src/commands/state/memory.rs`
 * — `parse_compact_args`, the two guards, `compaction_err` and
 * `build_compaction_response`/`complete_compaction` — pinned by
 * `tests/commands_fixtures/compact_parity.json`.
 *
 * The pass itself is not here. `memory/compaction/run.ts` is the assembly, and
 * it is shared with the idle trigger and the inline compaction a chat turn
 * schedules; what this module adds is the three things only a *command* needs:
 * arguments off the wire, a refusal with a code on it, and a rendering.
 *
 * # Three outcomes, and only one of them changes anything
 *
 * A pass ends archived, dry, or having written no memory. Only `compacted`
 * finishes anything: it reloads the engine, drains the deferred-edit queue and
 * tells autonomy the conversation moved. The other two answer and stop, because
 * nothing on disk changed and the next trigger will try again.
 *
 * The order inside the completion is the Rust's and it matters: reload, *then*
 * apply the deferred edits. The reload is what busts the cached prompt those
 * edits would otherwise be written behind. A failed reload gives up before
 * applying them; a failed *apply* only warns, because the compaction itself
 * succeeded and the conversation is sound.
 *
 * # `turn_count` and `compacted_turns` are the same number
 *
 * All three renderings carry both, with one value between them. That is the
 * Rust's, it is a client-compatibility duplicate rather than two facts, and it
 * is reproduced rather than tidied — a client reading the older name would
 * silently get `undefined`.
 */
```

## src/commands/compact.ts:63

```
/**
 * What the command needs beyond its arguments.
 *
 * `run` is the assembly's dependencies minus the two this supplies itself: the
 * character-effective config comes from the session, and `cachedRequest` is
 * read per call rather than held, because the thing holding it is a
 * conversation's last request and that moves every turn.
 */
```

## src/commands/compact.ts:89

```
/**
 * The two arguments, and what each accepts.
 *
 * Both parses are strict in the Rust's way — `as_bool` and `as_u64` reject
 * rather than coerce — and both fold a rejection into the absent case, so
 * `{"keep_turns": "3"}` compacts with the configured retention and says
 * nothing about the string. Reproduced rather than improved: a client that has
 * been sending the wrong type has been getting the default for as long as it
 * has been sending it, and starting to refuse is the change, not the fix.
 *
 * One boundary cannot be reproduced and is not worth pretending about. Rust
 * read a `u64`, JSON on this side is a double, and above 2^53 the two stop
 * agreeing about which integers exist. `keep_turns` is a count of conversation
 * turns to retain, so the safe-integer ceiling is the honest test.
 */
```

## src/commands/compact.ts:117

```
/**
 * Run a pass on the current character's conversation.
 *
 * The character is the session's; there is no name argument, so this always
 * compacts whoever is talking.
 */
```

## src/commands/compact.ts:167

```
/**
 * A pass failure as the client sees it.
 *
 * `compaction_err`'s mapping, plus the guard. Only `insufficient_messages` is
 * the caller's fault — it means the conversation is shorter than the pass
 * needs — so it is the one that is `invalid_request`; the rest are the daemon
 * failing to do something it agreed to do. Anything that is not a
 * {@link CompactionError} reaches here from underneath the assembly (a
 * provider's own error, a missing key) and keeps its message, which is what the
 * Rust's `map_err(|e| (InternalError, e.to_string()))` produced for the same
 * failures.
 */
```

## src/commands/compact.ts:191

```
/**
 * One outcome, rendered — and, for `compacted`, finished.
 *
 * Exported because it is what the parity fixture drove: the Rust generator
 * called `build_compaction_response` with constructed outcomes rather than
 * running eight real compaction passes, and the replay does the same. `compact`
 * reaches it the same way, so it is the real path either way.
 */
```

## src/commands/compact.ts:278

```
/**
 * Put the world back in step with what the pass wrote.
 *
 * Reload, apply, notify — the same three the inline path in `handler/turn.ts`
 * runs, in the same order and with the same tolerances. The one difference is
 * the reload: inline it is a warning and a return, because a chat turn has
 * already answered the user; here it is the command's failure, because the
 * command's whole answer is what the pass did.
 */
```

## src/commands/conversation.ts:52

```
/**
 * `Value::as_u64`: a non-negative integer. `-1` and `1.5` are both `None` in
 * serde, which is why callers fall through to their default rather than
 * erroring on them.
 *
 * Integers above 2^53 lose precision here where serde held them exactly. Every
 * caller is a message count or a cursor into one conversation, so the range
 * that differs is unreachable.
 */
```

## src/commands/conversation.ts:65

```
/**
 * `str::parse::<i64>()`, exactly: an optional sign, then ASCII digits, and
 * nothing else. No decimal point, no exponent, no surrounding space, and no
 * value outside `i64` — all of which Rust rejects and JavaScript's `Number`
 * would happily accept, sending `"1.5"` down the index path instead of the
 * literal-id path where it belongs.
 */
```

## src/commands/conversation.ts:118

```
/**
 * Resolve a ref that must name an assistant message.
 *
 * An absent ref and `"last"` are not the same path: absent means "the newest
 * *assistant* message", found by scanning backwards, while `"last"` here also
 * means that — but a ref that names a user message is a hard error rather than
 * a search. So `alt` with no argument works on a conversation whose newest
 * message is the user's, and `alt --ref last` on that same conversation is
 * also fine, while `alt --ref 1` pointing at a user turn is rejected.
 */
```

## src/commands/conversation.ts:148

```
/**
 * The index `turns` user turns back from `endBound`.
 *
 * Counts by `role === "user"` alone. On the display list that is the same as
 * counting real turns, because the merge has already consumed every
 * tool-result-only user message before this sees them.
 */
```

## src/commands/conversation.ts:169

```
/**
 * How many user turns the conversation holds, for the client's scrollbar.
 *
 * The `tool_result` exclusion cannot fire on the only path that reaches this:
 * the caller always passes a merged list, and the merge has already dropped
 * those messages. Kept because it is one clause and it states what the count
 * means; the fixture would not notice either way.
 */
```

## src/commands/models.ts:1

```
/**
 * The model half of the SWP command surface: listing what is selectable,
 * describing one, switching between them, and reading or writing the per-model
 * settings.
 *
 * Ported from the command half of `crates/daemon/src/commands/state/models.rs`,
 * pinned by `tests/commands_fixtures/models_parity.json`. The parsing and
 * capability half is in `./model_settings.ts`.
 *
 * # A discovered model's qualified name is not a resolver input
 *
 * `chat.<provider>.<model_id>` is a display-only synthetic name. Feeding it back
 * to the resolver always misses, which is why the session carries a
 * *pre-resolved* {@link ModelsContext.activeResolvedModel} beside the name the
 * user typed: every path that needs the active model reads that first and only
 * falls back to resolving a string when it is absent. Persistence uses
 * `(provider, model_id)` for the same reason — an alias survives a rename of
 * the catalog key, and a discovered model has no catalog key at all.
 *
 * # `include_hidden` is per-call, and it moves more than the list
 *
 * `discovery.ignore` hides a model from `list_models` *and* from selection. The
 * flag opts past both for one call, and — since the reported active model falls
 * back to the first entry when nothing is selected — passing it can change which
 * model a fresh session reports as active. That is the Rust's behaviour and the
 * fixture pins it.
 */
```

## src/commands/models.ts:125

```
/**
 * The model this session is on.
 *
 * The pre-resolved selection wins outright — see the note at the top about
 * synthetic qualified names — and `includeHidden` is true on the fallback path
 * because the user has already explicitly chosen this selection; hiding it from
 * them now would be refusing to describe what they are using.
 */
```

## src/commands/models.ts:172

```
/**
 * The model a `background_task` selector names. `"all"` only works when every
 * task collapses to one identity; otherwise it reports the mapping so the user
 * knows which task to target instead.
 */
```

## src/commands/models.ts:493

```
/**
 * Write one sampler field into the character's or the global preferences.
 *
 * The order is load-bearing. The target model is resolved first, because the
 * capability check needs its sdk; the check runs before the file is read, so a
 * refused setting never touches it; and an entry whose sampler ends up empty is
 * removed rather than left as an empty table.
 */
```

## src/commands/model_settings.ts:1

```
/**
 * The write boundary for per-model settings: parsing the fourteen sampler keys,
 * and the capability check that guards them.
 *
 * Ported from the pure half of `crates/daemon/src/commands/state/models.rs`,
 * pinned by `tests/commands_fixtures/model_settings_parity.json`.
 *
 * # Two layers, and they reject different things
 *
 * {@link capabilityCheck} asks whether this *model* can do anything with the
 * key at all — a `gemini_generation` on an Anthropic model is refused here, and
 * so is a `reasoning_effort` value outside the sdk's graded domain. It runs
 * first, so nothing the wire would ignore reaches the preferences file.
 *
 * {@link applySamplerValue} then asks whether the value is well-typed for the
 * key, and writes it. `null` always clears, and clearing is never
 * capability-checked: there is no value to validate.
 *
 * # One list, not two
 *
 * The Rust declared `SAMPLER_KEYS` beside a fourteen-arm `match` that had to
 * agree with it, and the agreement was by hand. Here `config/preferences.ts`
 * already owns the key-to-field map, so the list, the parser table and the
 * settings type are the same fourteen entries by construction. A key that is
 * accepted but never stored is not expressible.
 */
```

## src/commands/model_settings.ts:98

```
/**
   * Rejected up front so the preferences file never carries a value the
   * request-time overlay would have to discard.
   *
   * `moonshotai` is accepted — it is an alias the wire parser takes — and
   * stored verbatim, so the file can hold a spelling the settings command
   * itself never suggests. That is the Rust's behaviour: it validates with
   * `parse_wire` and then stores the user's original string.
   */
```

## src/commands/model_settings.ts:137

```
/**
   * Routing is an object (`{ order, allow_fallbacks, … }`); a scalar would be
   * stored verbatim and mean nothing on the wire.
   *
   * The Rust then converted to `toml::Value`, which fails on JSON that TOML
   * cannot hold — a `null` anywhere in the object, at any depth. Kept, because
   * the value goes on to be written into a TOML preferences file either way.
   */
```

## src/commands/model_settings.ts:175

```
/**
 * Write one setting into `sampler`. `null` clears the field.
 *
 * Throws without touching `sampler` when the value is wrong for the key, so a
 * rejected write is never a partial one.
 */
```

## src/commands/model_settings.ts:201

```
/**
 * Refuse a setting the model's resolved sdk cannot honor, and a value outside
 * the domain it does honor.
 *
 * Clearing is always allowed — there is no value to validate — and keys outside
 * the matrix (`sdk`, `max_tool_iterations`, and anything unknown) pass through
 * to the parser, which is what rejects them.
 *
 * The `off` sentinel is not a wire value: the overlay suppresses reasoning
 * rather than sending it, so it is absent from the graded domains. On an sdk
 * whose adapter honors the off-switch it skips the domain check; on one without
 * a disable path it deliberately falls through and is rejected as out of
 * domain, because there it would silently do nothing.
 */
```

## src/commands/model_settings.ts:238

```
/**
 * How the resolved sdk treats each settable key: `honored` / `ignored` /
 * `rejected` from the matrix, or `always` for the Shore-only keys (`sdk`,
 * `max_tool_iterations`) that name no matrix field.
 *
 * Clients show only `honored` and `always` keys.
 */
```

## src/commands/keepalive.ts:1

```
/**
 * The `keepalive_ping_now` diagnostic: ping now, and say what it read.
 *
 * Ported from `AutonomyManager::keepalive_ping_now` in
 * `crates/daemon/src/autonomy/manager.rs` and its rendering in
 * `crates/daemon/src/commands/state/status.rs`, pinned by
 * `tests/autonomy_fixtures/last_request_parity.json`.
 *
 * # The point is the usage, not the ping
 *
 * A ping that reads nothing and pays a write did not keep anything warm. Without
 * this command that is only observable by waiting for the scheduler and reading
 * the ledger afterwards, which is a slow way to learn that a subsystem whose
 * whole purpose is saving money has been spending it.
 *
 * # `source` is the whole reason this could not port earlier
 *
 * `cached_last_request` versus `rebuilt_from_disk` is the distinction the
 * command exists to draw, and it was made in the rebuild-and-push path that
 * `POST /v1/keepalive/prefix` served. A *rebuilt* body that reads cold may
 * simply mean nothing was cached yet; a *cached* one that reads cold means the
 * prefix it was protecting is gone, which is the finding. With the rebuild in
 * this process the round trip collapses into a call and a retry.
 *
 * # Measuring must not move what is measured
 *
 * `pingNow` deliberately leaves the schedule alone — no backoff, no disarm on a
 * cold read. Arming from a rebuild is the exception and it is not a measurement:
 * there was no prefix at all, so there is no schedule to disturb.
 */
```

## src/commands/keepalive.ts:95

```
/**
 * The ping's outcome as the command sees it.
 *
 * Three statuses, and everything unrecognised falls in with `skipped` rather
 * than raising — a ping is a diagnostic, and a diagnostic that fails because it
 * did not recognise its own answer is worse than one that reports the answer.
 * `detail` is the empty string when the ping did not supply one, which is the
 * Rust's `unwrap_or_default` and not a missing field.
 */
```

## src/commands/keepalive.ts:126

```
/**
 * The command's answer.
 *
 * The three `note` strings are the whole product of this command and they are
 * reproduced exactly. The middle one matters most and is the least obvious: a
 * read of zero with *no* write is not a cold prefix, it is a model with caching
 * off or a non-cached fallback answering, and reporting that as a cold write
 * would send someone hunting a cache bug that is not there.
 */
```

## src/commands/errors.ts:40

```
/**
 * Map an engine failure onto a command error, as `commands::engine_err` did.
 *
 * `MessageNotFound` and `InvalidAlt` already carry the exact text the Rust's
 * `Display` produced, so they pass their message straight through. Everything
 * else — I/O, a malformed `active.jsonl`, a message that will not serialize —
 * is an internal error, which is what the Rust's catch-all arm said.
 *
 * The Rust had a fourth variant, `CharacterNotFound`. No engine method on this
 * side can raise it: it came from `reset_to_character`, which the registry now
 * owns. It is not mapped here because there is nothing to map.
 */
```

## src/commands/config.ts:1

```
/**
 * The configuration half of the SWP command surface: what the tool surface
 * looks like, whether the config is sane, what is in it, and reloading it.
 *
 * Ported from `crates/daemon/src/commands/state/config.rs`, pinned by
 * `tests/commands_fixtures/config_commands_parity.json`.
 *
 * # Four sections the Rust serialises and this does not
 *
 * `config` ships the whole `AppConfig` twice — effective and default — so the
 * client can diff them. The Rust at the fixture's commit still had
 * `memory.dreaming`, `tools.sandbox`, `connections.matrix` and
 * `defaults.dreaming`; all four were removed from the schema earlier in this
 * rewrite, and `config_fixtures/app_parity.json` pins three of them as
 * *rejected* unknown fields. So the blob this returns is the current schema's,
 * and the replay strips those four from the recorded side rather than pretending
 * the port reintroduces them. Every other field, and every value, matches.
 *
 * # Ordering is the safety property in `configReload`
 *
 * Prompts are refreshed *before* the fresh config is adopted, so that an I/O
 * failure leaves the daemon wholly on the previous state rather than half on
 * each. Validation — global, then every character overlay — happens before
 * either. The runtime hooks are an interface here rather than the Rust's
 * `ctx.autonomy` and `ctx.llm_client` because those two are separate units of
 * this phase; what this module owes them is a call, in order, which is exactly
 * what the interface says.
 */
```

## src/commands/config.ts:65

```
/** The file the daemon was pointed at; reloads re-read exactly this. */
```

## src/commands/config.ts:71

```
/**
   * The environment the daemon resolved its directories from.
   *
   * Threaded through the reloads on purpose: `load_config` in the Rust read the
   * process environment every time, so a reload always landed on the same
   * `ShoreDirs`. Here the loader takes the environment as an argument, and
   * leaving it out would let a reload silently re-resolve XDG and move the data
   * directory out from under the running daemon.
   */
```

## src/commands/config.ts:91

```
/**
 * The effective tool surface: every registered tool, whether the main character
 * has it, and which enabled sub-agents own it.
 *
 * The roster is the *registry's*, not the config's — every tool that exists
 * appears, and the config only moves `main`. Dangling references are reported
 * rather than dropped, because a typo in `enabled_tools` is otherwise silent:
 * the tool simply never turns on and nothing says why.
 */
```

## src/commands/config.ts:115

```
// mutant that removes it can be killed. It stays because the ordering is a
```

## src/commands/config.ts:203

```
/**
 * Read the config, any part of it, or set one of three runtime overrides.
 *
 * It is a set only when `key` *and* `value` are both strings; a `value` with no
 * `key` is still a read, and a non-string `key` is no key at all.
 *
 * # The read key used to be a section name and nothing else
 *
 * The Rust did one `Value::get` against the serialized `AppConfig`, so the read
 * arm accepted `defaults` and refused `defaults.stream` — while the *write* arm
 * accepted `defaults.stream` and refused `defaults`. The two grammars were
 * disjoint: every key you could set was a key you could not read back (#30).
 *
 * Read now walks dots, which makes it a superset of write and makes the command
 * behave the way its own output looks: `shore config` prints a two-level tree,
 * and `daemon.addr` is the obvious way to ask for one line of it. Write is
 * unchanged — three keys, still the only three that can move at runtime.
 */
```

## src/commands/config.ts:236

```
/**
 * The six spellings `config <key> <value>` accepts, and where each reads back from.
 *
 * Three settings, six names. The canonical paths walk like any other key; the
 * bare aliases do not, because they are shorthands for the set arm rather than
 * paths in the config tree — `model` names no section, and `autonomy.enabled`
 * sits one level above where the setting actually lives.
 *
 * Teaching the read arm to accept them would be a second read grammar, which is
 * the thing #30 is about. So a miss on one of them says where to read it
 * instead: the set arm echoes `autonomy.enabled` after a write, and a user who
 * types that back deserves the path rather than "not found".
 */
```

## src/commands/config.ts:267

```
/**
 * Walk a dotted key through the serialized config.
 *
 * Wrapped in an object rather than returned bare, because `null` is a value the
 * config really holds — `defaults.model` is null until one is set — and a bare
 * `undefined` return could not tell "absent" from "present and null". The
 * caller has to distinguish them: one is a `not_found`, the other is an answer.
 *
 * Only plain objects are walked into. A segment that lands on a scalar or an
 * array is a miss rather than an index: `allowed_hosts.0` is not a key anyone
 * writes in a config file, and refusing it keeps the read grammar the same
 * shape as the TOML the user edits.
 */
```

## src/commands/config.ts:291

```
/**
 * The three keys that can move at runtime.
 *
 * The model arm echoes the key *as spelled* while the autonomy arm echoes its
 * canonical name; that asymmetry is the Rust's and is pinned rather than
 * tidied. Setting the model also drops `activeResolvedModel`, because the
 * pre-resolved value no longer matches the name beside it and the next command
 * has to resolve again.
 */
```

## src/commands/config.ts:342

```
/** Rust's `bool::from_str`, which takes exactly `true` and `false`. */
```

## src/commands/status.ts:56

```
/**
   * Real elapsed time. Must be the same clock {@link AutonomyService} runs on:
   * `seconds_until_wake` is the difference between a wake this reads and a now
   * this supplies, and two clocks would make it a difference of nothing.
   */
```

## src/commands/status.ts:62

```
/**
   * The user's calendar, as epoch ms in UTC — the naive-local encoding the
   * activity tracker is pinned on. A separate clock from {@link now} because it
   * answers a separate question: which hour of which day, rather than how long
   * ago. The Rust read `Local::now()` inside the tracker; injecting it keeps
   * the sidecar from holding its own opinion of the machine's timezone.
   */
```

## src/commands/status.ts:106

```
/**
 * Seconds from now until `at`, negative when it has already passed.
 *
 * The Rust branched on the sign and negated the magnitude, so both directions
 * truncate *towards zero* rather than flooring. `Math.trunc` is that, exactly.
 */
```

## src/commands/status.ts:114

```
/**
 * Seconds since `at`, floored at zero.
 *
 * `Instant::duration_since` saturates rather than going negative, and a stamp
 * in the future is reachable: `last_user_at` is restored from
 * `autonomy_state.json` as a wall-clock time, so a backwards clock adjustment
 * leaves one there. Reporting a negative age would read as a message from the
 * future; reporting zero reads as "just now", which is the nearer truth.
 *
 * The clamp is the whole of it, and it makes `trunc` and `floor` here the same
 * function: they differ only on negative fractions, and every negative result
 * is on its way to zero. `trunc` is written because it mirrors
 * {@link untilSecs} and `duration_secs_i64`, not because anything can tell.
 */
```

## src/commands/status.ts:130

```
/**
 * The scheduler's state in the vocabulary the Rust CLI parses.
 *
 * Two of the sidecar's fields are dropped rather than renamed: `character`,
 * which the envelope already carries one level up, and `covered_turn_count`,
 * which is how much of the conversation the deep archive has been over — a
 * detail of the tick loop that was never on this wire.
 *
 * The four clock-derived fields are omitted when there is nothing to derive
 * them from, matching `skip_serializing_if = "Option::is_none"`. Absent means
 * "no wake is armed" / "no user message on record", which a null would blur.
 */
```

## src/commands/status.ts:202

```
// null rather than an omission — the field always answers, even if the answer
```

## src/commands/status.ts:230

```
// Null, not omitted, for a character the scheduler has never taken up —
```

## src/commands/status.ts:265

```
/**
 * Schedule an immediate heartbeat tick.
 *
 * A dormant clock still takes the request, and still says so: the tick is armed
 * but the abandonment guard will swallow it, and the warning names the command
 * that clears the guard. Answering with a plain "scheduled" would be true and
 * useless.
 */
```

## src/commands/status.ts:290

```
/** Force the abandonment guard on. */
```

## src/commands/status.ts:298

```
/** Force the abandonment guard off, and tick immediately. */
```

## src/commands/call_log.ts:23

```
/** The active character. Both commands scope to it unless told otherwise. */
```

## src/commands/call_log.ts:61

```
/**
 * Query the raw call-payload store. With `id`, return that one call's
 * decompressed request/response; otherwise return an index of recent calls
 * (newest first) filtered by `call_type` and `character` (defaulting to the
 * active character).
 */
```

## src/commands/call_log.ts:144

```
/**
 * Run a store read, reporting a failure the way the Rust's `Err` arms did.
 *
 * The prefix is a parameter because the two commands do not share one:
 * `call_log` says `call store query failed` and `transcript` says `transcript
 * query failed`. They are the same kind of failure worded for whoever asked,
 * and a client that matches on the text would see the difference.
 */
```

## src/commands/usage.ts:1

```
/**
 * `shore usage`, ported from `crates/daemon/src/commands/usage.rs`.
 *
 * That command was already a forward: the report itself — period parsing,
 * filters, the eight payload shapes, cache health, budgets — moved to
 * `ledger/usage.ts` while the daemon was still Rust, because the ledger has one
 * owner and it is the process that writes to it. What stayed behind was the one
 * thing the writer could not do alone: empty the `pricing` table the daemon's
 * own engine cached in front of.
 *
 * There is one process now, so that reason is gone, and what is left is the
 * shape the Rust command had anyway — clear the cache if asked, then hand the
 * args to the ledger. The clear is unconditional on the other flags, which is
 * what `--refresh-pricing` alongside `--budget` did in the Rust and is now the
 * whole of the refresh rather than half of it. See
 * {@link PricingEngine.clearCache}.
 *
 * Two Rust details do not survive the move, neither of them behaviour a client
 * can see. The `debug!` line that named the requested period is dropped, as
 * every ported command has dropped its tracing. And `LedgerClient::ledger_path`
 * refused a client holding an in-memory ledger — a state only its own tests
 * built — so this takes a path and has no such branch.
 */
```

## src/commands/navigation.ts:1

```
/**
 * The character half of the SWP command surface: which characters exist, what
 * one is made of, and validating a request to switch.
 *
 * Ported from `crates/daemon/src/commands/navigation.rs`, pinned by
 * `tests/commands_fixtures/navigation_parity.json`.
 *
 * # Existing and being a character are different questions
 *
 * `discoverCharacters` requires a marker file — `workspace/SOUL.md` or the
 * legacy `character.md` — so a bare directory under `characters/` is not a
 * character and never appears in a listing. But {@link characterInfo} and
 * {@link switchCharacter} both gate on the directory *existing*, so both answer
 * for a name the listing would never have offered. That is the Rust's, and it
 * is pinned rather than fixed: the two commands are how a client bootstraps a
 * character directory that does not have its `SOUL.md` yet.
 *
 * # No `CommandContext`, no engine
 *
 * The Rust threaded a whole `&ConversationEngine` through three of these four
 * functions and read exactly one thing from it — `character_name()`. It is a
 * string parameter here. `&CommandContext` went the same way: what these
 * commands actually need is the config directory, and in one case the data
 * directory, so that is what they take.
 */
```

## src/commands/navigation.ts:81

```
// one can be killed. The probe stays because not-having-an-avatar is the
```

## src/commands/navigation.ts:83

```
// thrown `EISDIR`; the catch stays because it is the only thing standing
```

## src/commands/navigation.ts:100

```
/**
 * The characters a client may choose between.
 *
 * With an `active` character it leads the list unconditionally — it is
 * prepended before discovery runs and deduplicated out of the discovered
 * names, so it appears first even when it sorts last, and appears at all when
 * it has nothing on disk. Without one the answer is discovery alone, in sorted
 * order, and an empty directory really is an empty list.
 *
 * The Rust had these as two functions because one took the engine and the other
 * could not; here the difference is the whole of it.
 */
```

## src/commands/navigation.ts:146

```
/**
 * What a character is made of: its directories, its bootstrap files, and what
 * is queued to be activated into its prompt.
 *
 * Two fields answer the same question differently on purpose.
 * `has_definition` is whether `SOUL.md` is *there*; `definition_preview` is
 * whether it could be *read*. A `SOUL.md` that is a directory reports present
 * with a null preview, and an empty one reports present with an empty preview.
 *
 * A queue that cannot be read reports nothing pending rather than failing:
 * `character_info` is what a client calls to find out why a character is
 * misbehaving, and a corrupt queue must not be the thing that stops it
 * answering.
 */
```

## src/handler/setup.ts:63

```
/**
 * No model could be resolved for this turn.
 *
 * `invalid_request`, not `internal_error`: the config is missing a
 * `[providers.*]` entry and a `[defaults].model`, which is the user's to fix
 * and nothing to do with the daemon being broken. It reached clients as
 * `internal_error` only because the generic catch in `router.ts` maps anything
 * it does not recognise that way (#31).
 */
```

## src/handler/setup.ts:81

```
/**
 * Resolve the model this generation runs on, and apply any per-model sampler
 * overlay.
 *
 * `activeModel` and `overlay` are the pair `resolveActiveModelAndOverlay` returns
 * — kept apart there rather than merged, so the overlay reaching
 * {@link applySamplerOverlay} here holds only what preferences set.
 *
 * `activeModel` is the model preference resolution already picked, and it is
 * passed through rather than re-resolved on purpose: a discovered-only model has
 * a synthetic `chat.<provider>.<model_id>` qualified name that
 * {@link findEffectiveModel} does not accept as *input*, so re-resolving it
 * would fail on exactly the models discovery exists to reach.
 *
 * With no such model, the configured `defaults.model` is looked up with hidden
 * models included — an app default is user configuration rather than a
 * discovery-cache selection, so `discovery.ignore` should not silently make a
 * name the user typed unreachable, but a *misspelled* one should still say so
 * rather than quietly becoming the first model in the catalog.
 */
```

## src/handler/setup.ts:138

```
/**
 * Assemble the prompt, warm the image cache, and build the request.
 *
 * The API key is left empty: the credential-fallback wrapper resolves and
 * rewrites it just-in-time during rotation, so baking one in here would be a key
 * that goes stale between assembly and send. The caller sets `rid` and the
 * forensic character on the way out.
 *
 * A regen sends history *through the last user turn* rather than all of it, so
 * the assistant turn being regenerated is not also in the prompt — otherwise the
 * model would continue past the answer instead of giving a different one.
 */
```

## src/handler/setup.ts:195

```
/**
 * Apply a client's one-shot overrides, last.
 *
 * Each field is independent: setting `top_p` alone must leave the model's own
 * temperature in place rather than clearing it. `thinking_budget` creates
 * `provider_options` when the model had none, which is the one case that is not
 * a plain field write.
 */
```

## src/handler/router.ts:1

```
/**
 * The message handler: what a routed message causes.
 *
 * Ported from `crates/daemon/src/handler/mod.rs` — `MessageHandler::run`,
 * `handle_routed_message`, `handle_engine_message`, `launch_generation`,
 * `spawn_generation_task`, `resolve_engine_message_character`, and
 * `cancel_generation` from `command_dispatch.rs`. Pinned by
 * `tests/handler_fixtures/router_parity.json`.
 *
 * This is the consumer `swp/server.ts` has been waiting for. `Server.routes()`
 * already yields `RoutedMessage` in arrival order and `SessionRouter` already
 * delivers to one session; what was missing is the thing in between that turns
 * one into the other. Everything it reaches — the dispatcher, the lease, the
 * turn driver, the tool phase — is already here.
 *
 * # Two speeds, deliberately
 *
 * A command answers inline: it does no LLM I/O, so making the loop wait for it
 * costs nothing and keeps the reply ordered against the request. A generation
 * is started and left to run, because it streams for as long as a model takes
 * to think, and a loop that waited for one would stall every other session.
 *
 * The consequence is the only concurrency rule here: **one generation per
 * session**, and a new one aborts the one before it. That is not a resource
 * limit, it is what a client means by sending a second message before the first
 * finished.
 *
 * # What is injected rather than held
 *
 * `runGeneration` — `handler/generation.ts`, and `handler/deps.ts` is what
 * supplies it. This module owns the orchestration *around* a generation (which
 * session, which recipients, what happens when it throws), which is separable
 * from the generation itself and is what the fixture pins.
 *
 * Config hot-reload (`HandlerControl`, the `apply_reloaded_config` path) is
 * still deliberately not here. It drives the character registry's runtime
 * reload and the schedulers; `handler/command_dispatch.ts` names the calls it
 * makes as `DispatchRuntime`, and nothing implements that interface yet.
 */
```

## src/handler/router.ts:120

```
// would be reading a value Shore never sent.
```

## src/handler/router.ts:205

```
/**
 * The rid a generation is allowed to echo back, or `null`.
 *
 * A client picks its own rid and Shore only ever reflects it, so the only
 * question is whether it can be put on a frame safely. Non-ASCII and embedded
 * NULs are rejected — `r.is_ascii() && !r.contains('\0')` in the Rust —
 * because a rid ends up in log lines and in the client's own correlation table,
 * and neither wants a frame's worth of arbitrary bytes.
 *
 * Rejection is silent and yields `null`: the frames still go out, they just
 * carry no correlation id. Failing the request would punish a client for a
 * field it can resend.
 */
```

## src/handler/router.ts:237

```
/**
 * Consumes routed messages until the stream ends.
 *
 * Held as a class because the session map and the lease outlive any one
 * message — the Rust's `MessageHandler` for the same reason.
 */
```

## src/handler/router.ts:367

```
// after: the two must not stream to the same session at once.
```

## src/handler/command_dispatch.ts:1

```
/**
 * What the dispatcher does to a command's answer after the command has run.
 *
 * Ported from the four `post_process_*` methods in
 * `crates/daemon/src/handler/command_dispatch.rs`.
 *
 * Four commands reach further than the command layer can. `config` with a value
 * and `config_reset` and `config_reload` all produce a config that subsystems
 * outside the command context are holding older copies of; `switch_character`
 * moves the session itself. The commands do their own half — writing files,
 * validating, computing what changed — and then the dispatcher does the half
 * that needs the handler: pushing the result into the registry and the
 * schedulers, and telling the client what it has to throw away.
 *
 * # Why the annotations are the dispatcher's and not the commands'
 *
 * Everything under `invalidated` is a cache the *client* keeps: the character
 * list, the per-character merged configs, the engines it thinks are live. What
 * a command knows is what it changed on disk; what invalidates a client cache is
 * what the reload turned out to move, which is the reload's return value, and
 * the reload is the handler's. `restart_required` is the same story from the
 * other side — it compares global config to global config, and the command
 * context holds the character-*merged* one, under which every character overlay
 * would read as a change.
 *
 * # One divergence
 *
 * The Rust writes `invalidated` two ways: `config_reset` inserts into whatever
 * the command already put there, `config_reload` replaces the key outright.
 * Here both merge. `configReload` returns no `invalidated` of its own, so there
 * has never been anything for it to replace, and one rule reads better than two.
 */
```

## src/handler/command_dispatch.ts:56

```
/** The global config the daemon is running on — the left side of the
   *  restart-required comparison, and never the character-merged one. */
```

## src/handler/command_dispatch.ts:84

```
/**
   * The command context's config *after* the command ran.
   *
   * `config` and the two reloads all mutate it in place, which is exactly what
   * makes it worth pushing outward — it is the new value, already validated.
   */
```

## src/handler/command_dispatch.ts:98

```
/**
 * Run a command's after-effects and fold their annotations into its output.
 *
 * Only successful commands get here: the Rust matches on `CommandOutput` and
 * leaves an `Error` alone, and on this side a command that failed threw instead
 * of returning. A command that returns something other than an object keeps its
 * answer unannotated — but its effects still run, because the config a `config`
 * set produced has to reach the registry whatever the reply happened to look
 * like.
 */
```

## src/handler/command_dispatch.ts:127

```
// Only a *set*. `config` with no value is a read, and reads must not
```

## src/handler/command_dispatch.ts:161

```
/**
 * A `config_reset`: drop every runtime override and adopt what is on disk.
 *
 * The command already re-read and validated the file; this adopts it. Because
 * the file may have grown or lost characters since startup, all three caches
 * can move, so all three are reported — `merged_character_configs`
 * unconditionally, since every merged config was rebuilt whether or not any
 * value differs.
 */
```

## src/handler/persistence.ts:1

```
/**
 * Persistence and notification for a completed generation.
 *
 * Port of `crates/daemon/src/handler/persistence.rs` — the last phase of the
 * chat pipeline. It writes the assistant turn to the conversation engine,
 * records diagnostics and session token totals, extends the cached
 * `last_request` so the heartbeat sees a conversation ending on an assistant
 * turn, and fires the completion notification.
 *
 * Everything the phase touches beyond the engine is reached through
 * {@link PersistContext} rather than the daemon's `GenContext`, which carries a
 * dozen fields this phase never reads. Same technique as `LoadedConfigView` in
 * `config/preferences.ts`: name the slice, not the struct.
 */
```

## src/handler/persistence.ts:43

```
/**
 * One row of the API-call diagnostics ring.
 *
 * The ring's own type, not a second declaration of it. There were two, agreeing
 * on ten fields and disagreeing on how `error` spells "none", which is exactly
 * the drift a duplicate exists to cause.
 */
```

## src/handler/persistence.ts:85

```
/** The requesting session's direct channel, for `usage_warning`. The Rust
   *  uses `try_send` and logs a drop; a full channel must not stall the
   *  generation that already finished. */
```

## src/handler/persistence.ts:120

```
/**
 * Phase 12: persist messages, record diagnostics, and notify.
 *
 * The engine lock is held across message assembly and append, and released
 * before the notification and budget-warning calls — those touch the network
 * and must not hold a conversation hostage.
 */
```

## src/handler/persistence.ts:155

```
// turns — and dead in the Rust for the same reason. Kept because it states
```

## src/handler/persistence.ts:179

```
/**
 * The request-as-sent plus this turn's response messages — the body every
 * `last_request` reuse path (keepalive ping, heartbeat, compaction) clones and
 * extends.
 *
 * Nothing is filtered here. This used to apply the prior-thinking replay policy
 * to the appended messages only, with a careful index clamp so it could never
 * rewrite bytes that had already gone out under a live cache entry — rewriting
 * those is what made every keepalive ping miss. The policy is applied at send
 * time now, so the same history always produces the same wire bytes and there
 * is nothing left to clamp.
 */
```

## src/handler/persistence.ts:195

```
// A shallow clone with a fresh message array: the appended turns must not
```

## src/handler/persistence.ts:197

```
// messages must survive identical, so they are shared rather than copied.
```

## src/handler/persistence.ts:203

```
/**
 * Apply generated messages to the engine, handling regeneration alternatives
 * versus a plain append.
 *
 * The two branches emit `new_message` at different points for a reason: a
 * regeneration replaces the tail in one operation and so has one revision to
 * report for every message, while an append advances the revision per message
 * and each event must carry the revision its own message landed in.
 */
```

## src/handler/persistence.ts:226

```
// Deep copies, because `emitNewMessageEvent` inlines image bytes into the
```

## src/handler/persistence.ts:344

```
// unions the daemon never puts on this path.
```

## src/handler/persistence.ts:373

```
// A provider that reports no model id must not stamp the empty string —
```

## src/handler/persistence.ts:379

```
/**
 * The response turns worth persisting — at most one.
 *
 * A degenerate empty assistant turn is dropped. A tool loop that ends without
 * the model emitting any final text yields a result with no content blocks;
 * persisting that as an empty assistant message poisons the conversation,
 * because the next request would ship a turn with empty content and Anthropic
 * rejects the whole thing ("text content blocks must be non-empty").
 */
```

## src/handler/persistence.ts:394

```
/**
 * The blocks a result should persist: its own, or a single text block
 * synthesized from `content` when a provider reported text without blocks.
 *
 * Note the guard is `blocks.length === 0 && content !== ""` — a result with no
 * blocks and no content yields nothing at all, which is what makes
 * {@link completedResponseMessages} drop the turn.
 */
```

## src/handler/persistence.ts:437

```
/**
 * The text a completion notification shows.
 *
 * Assistant turns first; if they yield nothing printable, *every* turn is
 * tried. The fallback exists because a response can be entirely tool results —
 * showing the tool output beats showing an empty notification.
 */
```

## src/handler/wire_messages.ts:1

```
/**
 * Turning an assembled prompt into the wire message list.
 *
 * Ported from the second half of `crates/daemon/src/handler/task.rs`
 * (`build_llm_messages` and the three helpers under it), pinned by
 * `tests/handler_fixtures/context_parity.json`.
 *
 * Two jobs, and they are less alike than the single function suggests:
 *
 * 1. **Project stored blocks onto the wire.** In Rust this was
 *    `WireBlock::from_content_block`, a whole second enum that existed because
 *    the stored `ContentBlock` and the wire block were different types. Here
 *    they are the same type, so the projection is identity and the function is
 *    gone rather than ported — see {@link renderMessageContent}. What survives
 *    is the *filtering*: empty text blocks are dropped, and a turn that renders
 *    to nothing is dropped with them.
 *
 * 2. **Reroute images on assistant turns.** Anthropic rejects a raw `image`
 *    block inside an assistant turn at any position, and one such turn fails
 *    the entire request — so a persisted assistant message carrying a generated
 *    image would wedge the conversation on every subsequent send. The image
 *    replays as the tool call it originally was, or folds into a text stand-in
 *    where tool blocks cannot ship. See {@link AssistantImageMode}.
 *
 * The empty-block filtering is deliberately *not* the guarantee that no empty
 * text block reaches a provider — that is the adapter's, because the tool loop
 * and the `last_request` append path never come through here. What this side
 * knows, and the adapter does not, is whether the stored blocks render to
 * anything, which is what decides between them and the derived `content`
 * string.
 *
 * What this also does not do is decide what a provider will accept.
 * Carrier-less thinking, thinking minted by another model, and prior turns'
 * thinking under a `none` replay setting all ship from here and are filtered in
 * `llm/replay.ts`, which is the only place that knows the provider.
 */
```

## src/handler/wire_messages.ts:74

```
/**
 * Deterministic `tool_use` id for a replayed generated image.
 *
 * The same history must render byte-identically across requests, processes and
 * daemon restarts or the prompt cache misses, so the id derives from the
 * image's file stem — unique per generated image — and never from randomness or
 * an unstable hash.
 *
 * The stem is Rust's `Path::file_stem`, which is not `basename` minus the last
 * dot: a leading-dot name has no extension to strip, so `.png` stems to `.png`
 * and sanitizes to `_png` rather than to the empty string.
 */
```

## src/handler/wire_messages.ts:159

```
/**
 * Render one prompt message's wire content, plus the `tool_result` blocks it
 * owes the following turn.
 *
 * Returns `undefined` for a message that rendered to nothing — a degenerate
 * persisted turn with no usable content, such as an assistant turn that ended a
 * tool loop without emitting any final text. Anthropic rejects such a turn with
 * "messages: text content blocks must be non-empty" and fails the *entire*
 * request, so a conversation whose window contained one could no longer
 * generate at all.
 */
```

## src/handler/images.ts:53

```
/**
 * The media type implied by a path's extension, or `undefined`.
 *
 * **A path with no dot at all is treated as its own extension**, so a file
 * literally named `png` reads as a PNG. That is what `rsplit('.').next()` does
 * — on a string with no separator it yields the whole string — and it is
 * reproduced rather than fixed, because the same spelling decides which
 * attachments reach the model and a stored conversation may already rely on it.
 *
 * Matching is ASCII-lowercase because `to_ascii_lowercase` was. For the four
 * extensions in the table the two rules happen to agree — there is no
 * non-ASCII character that Unicode-lowercases *into* `jpg`, `jpeg`, `png`,
 * `gif` or `webp` — so this is a guarantee about the alphabet rather than a
 * difference you can observe today. It is kept because adding an extension is
 * what would make it observable, and that is the wrong moment to discover it.
 */
```

## src/handler/images.ts:91

```
/**
 * The media type implied by an image's magic bytes.
 *
 * Consulted before the client's declared MIME type, because the bytes are the
 * only claim in an upload that the client cannot get wrong.
 */
```

## src/handler/images.ts:148

```
/**
 * Reduce a client-supplied filename to one safe path component.
 *
 * Upload filenames come straight off the wire, so they may carry separators,
 * NUL bytes, or be empty; joined into the attachments directory unchecked they
 * could escape it or fail the write. The last segment after either separator is
 * kept, NULs are dropped, and anything that reduces to nothing, `.`, or `..`
 * becomes `image`.
 *
 * The order matters: NULs are stripped *after* the split and *before* the
 * empty/dot check, so `..\0` is `..` by the time it is tested and becomes
 * `image` — a NUL cannot be used to smuggle a dot-dot past the guard.
 */
```

## src/handler/images.ts:167

```
/**
 * Choose the attachment file name for incoming bytes.
 *
 * A recognized extension is kept as-is and the bytes are never consulted;
 * otherwise one is appended, derived from the magic bytes first and the
 * client-declared type second. Everything downstream keys the media type off
 * the saved extension, so an upload without one — routine for content-addressed
 * media, where the type travels out of band — would otherwise be silently
 * dropped from every request.
 */
```

## src/handler/images.ts:212

```
/**
 * Atomically claim a destination file, de-duplicating on collision.
 *
 * The timestamp in attachment names is second-granular, so two uploads sharing
 * a filename within the same second would otherwise overwrite each other.
 * `wx` is `O_CREAT | O_EXCL`, which makes the claim atomic; on collision the
 * name gains `_1`, `_2`, … *before* the extension.
 *
 * A name whose only dot is leading — `.hidden` — has no stem, so it is treated
 * as having no extension at all and de-duplicates to `.hidden_1`. That falls
 * out of `rsplit_once` plus the non-empty-stem guard, and is pinned.
 */
```

## src/handler/images.ts:244

```
/**
 * Write bytes into the attachments directory under a timestamped,
 * extension-corrected name.
 *
 * Returns `undefined` on any failure, having logged it. A failed attachment
 * costs one image, never the turn — the message it arrived with is still worth
 * sending.
 */
```

## src/handler/images.ts:296

```
/**
 * Copy incoming images into the character's attachments directory.
 *
 * `imageData` wins outright: when a client sends base64 the legacy path list is
 * **not consulted at all**, even for paths the uploads do not cover. The two
 * lists describe the same attachments from clients of different vintages, so
 * reading both would double every image.
 *
 * The second return is the model-facing content blocks, and it is deliberately
 * always empty: attachment *paths* are kept out of what the model reads, and it
 * receives the images through the returned refs instead.
 */
```

## src/handler/images.ts:400

```
/**
 * Build the content blocks for one message: images first, then text.
 *
 * **An empty or whitespace-only text yields no text block.** Anthropic rejects
 * `{"type":"text","text":""}` with "text content blocks must be non-empty" and
 * fails the whole request, so an image-only message must not carry one. A
 * message whose images all failed to encode and which has no text yields no
 * blocks at all, and the caller drops the turn rather than sending an empty one.
 *
 * Pass `0` for `maxImageSize` to disable resizing.
 */
```

## src/handler/images.ts:434

```
/**
 * Read one image off disk and encode it for a provider request.
 *
 * Returns `undefined` — having said why — for an unsupported extension or an
 * unreadable file. The extension check happens first and without touching the
 * disk, so a `.bmp` that exists is skipped exactly like one that does not.
 */
```

## src/handler/commands.ts:1

```
/**
 * The command path: the `dispatchCommand` `handler/router.ts` injects.
 *
 * Ported from `MessageHandler::dispatch_command` and the three helpers under it
 * in `crates/daemon/src/handler/command_dispatch.rs`, pinned by
 * `tests/handler_fixtures/command_path_parity.json`.
 *
 * The table itself is `commands/dispatch.ts` and the four post-processing hooks
 * are `handler/command_dispatch.ts`. What is left, and what this is, is
 * everything between a `Command` frame arriving and the table running:
 *
 * 1. **Which of three paths the name takes.** Two never touch a character
 *    engine, and one of those is chosen *per request* rather than per name —
 *    `list_models` is characterless only while no character is selected, so
 *    that `shore complete models` works before anyone has chosen one, and so
 *    that once they have, its `active` field is the one preferences resolve.
 * 2. **Resolving the session's character** to an engine and an effective
 *    config, or failing with a message that says which of the three ways it
 *    went wrong: none on disk, several and none chosen, or one chosen that is
 *    not there.
 * 3. **Building the command context**, whose active model comes from
 *    preferences and not from the app default — with the legacy
 *    `runtime_state.json` still read underneath, as one release of migration.
 * 4. **Mirroring the active model back into the session**, because it is a
 *    cache the next command reads instead of re-resolving.
 *
 * # One deliberate divergence
 *
 * **Every path attaches the rid.** The Rust attached it on the character path
 * and on the `refresh_provider_models` bypass, and forgot it on the third:
 * `list_characters`, characterless `list_models` and `list_providers` all came
 * back with a null rid however the request was addressed. Three paths, two
 * spellings, and a client correlating by rid loses exactly those three answers.
 * The fixture records the Rust's null and the replay names this rather than
 * letting it pass.
 */
```

## src/handler/commands.ts:63

```
/** The character a request is for. Throws {@link CharacterError} when the
   *  session's selection cannot be turned into exactly one name. */
```

## src/handler/commands.ts:80

```
/** The file it was started *from* — never a character's overlay. */
```

## src/handler/commands.ts:128

```
// available. An `invalid_request`, because the client can fix it by
```

## src/handler/commands.ts:129

```
// choosing — everything below is `internal_error` because it cannot.
```

## src/handler/commands.ts:218

```
/**
 * The one characterless command the shared table does not carry.
 *
 * It is not in `runCharacterlessCommand` because it is not in the Rust's
 * `dispatch_characterless` either — that function is synchronous and this
 * command makes network calls. Routing it here keeps both tables matching
 * their Rust counterparts exactly, which is what the two fixtures check.
 */
```

## src/handler/turn.ts:1

```
/**
 * The turn driver: what happens between a client frame arriving and the
 * conversation being one turn longer.
 *
 * Ported from `crates/daemon/src/handler/task.rs` — `setup_generation`,
 * `append_user_turn`, `ensure_and_backfill_autonomy`,
 * `emit_post_persist_stream_end`, `maybe_schedule_compaction` and
 * `run_inline_compaction` — pinned by `tests/handler_fixtures/turn_parity.json`.
 *
 * The other half of `task.rs` — resolving the model and assembling the request —
 * is already in `setup.ts`, and the wire builder is in `wire_messages.ts`. This
 * is what is left: the ordering.
 *
 * # This owns `active.jsonl` now
 *
 * {@link appendUserTurn} is the write that made the daemon the owner of
 * conversation state, and porting it is what retires `POST /v1/keepalive/prefix`
 * — the last bridge #12 listed as still standing. The Rust pushed the ping body
 * up because it assembled that body from content blocks it had persisted itself.
 * The same side persists and pings now, so there is nothing to push.
 *
 * # Not wired yet
 *
 * Nothing here reaches a socket. Frames go to the two sinks on
 * {@link TurnContext}, which is what `SessionRouter` will supply when
 * `swp_server` is wired (#18, step 5) — the same arrangement `command_dispatch.ts`
 * already uses, and the reason every branch below replays against a fixture
 * without a client attached.
 *
 * # What was dropped
 *
 * `run_generation_stream`'s fork. The Rust asked `can_delegate_tool_loop`
 * whether the sidecar could drive the whole turn and, if so, handed it over
 * wholesale; otherwise it streamed here and ran the tool phase itself. Both
 * branches are this process now, so the question has one answer and the fork is
 * gone. What survives is the part that was never about the hop: after a stream
 * that stopped on `tool_use`, run the tool phase — and only when tools are
 * actually enabled.
 */
```

## src/handler/turn.ts:79

```
/** The requesting session's channel. Must not throw and may drop. */
```

## src/handler/turn.ts:100

```
/**
 * Record the incoming user turn, or capture the alternatives a regen is about
 * to replace.
 *
 * Returns the regen alternatives to thread into persistence, and `undefined` on
 * a fresh turn.
 *
 * A regen returns early and appends nothing — *including* when its body carries
 * text. The user turn a regen would append is already in the conversation; the
 * body is only there because the client reuses one frame shape for both. The
 * fallback when there is no prior assistant turn is an empty alternatives list
 * rather than `undefined`, because persistence tells the two apart: one means
 * "regenerating, nothing to keep", the other means "not a regen".
 */
```

## src/handler/turn.ts:133

```
// Only append a text block when there *is* text. An image-only message must
```

## src/handler/turn.ts:215

```
// must not stop the rest of the history from seeding the tracker.
```

## src/handler/turn.ts:251

```
/**
 * How much of the context window this turn's prompt occupied.
 *
 * Everything sent, cached or not: a cached prompt still fills the window, so
 * counting only `input_tokens` would mean the token trigger never fires once the
 * cache is warm — which is exactly when a conversation is long enough to need
 * compacting. Saturating, so a nonsense provider count cannot wrap to a small
 * number and silently disable compaction.
 */
```

## src/handler/turn.ts:269

```
/**
 * Emit `stream_end` — and only after persistence has finished.
 *
 * A client that fires an immediate follow-up command on seeing this frame (the
 * MCP bridge does) would otherwise race the persist write and read stale engine
 * state. The frame carries the id of the message that was just written and the
 * revision it produced, which is what lets a client attach the finished turn to
 * what it already rendered.
 */
```

## src/handler/turn.ts:333

```
/**
 * Run a compaction inline, and put the engine back in step with what it wrote.
 *
 * The order matters and is preserved: compact, reload, *then* apply deferred
 * edits. A character's self-edits are applied after the reload because the
 * reload is what busts the cached prompt they would otherwise be written behind.
 *
 * A failed reload returns early without applying them — the engine is out of
 * step with the files at that point, and editing on top of a stale view is worse
 * than skipping. A failed *edit* only warns: the compaction itself succeeded and
 * the conversation is sound, so it is not worth reporting as a compaction
 * failure.
 */
```

## src/handler/generation.ts:1

```
/**
 * One turn, start to finish: the `runGeneration` `handler/router.ts` injects.
 *
 * Ported from `handle_generation` and `run_generation_stream` in
 * `crates/daemon/src/handler/task.rs`, and from `stream_with_sidecar_tool_loop`
 * in `crates/daemon/src/handler/generation.rs`, pinned by
 * `tests/handler_fixtures/generation_parity.json`.
 *
 * The pieces this orders were ported before it — `setup.ts` resolves the model
 * and assembles the request, `context.ts` builds the prompt, `wire_messages.ts`
 * projects it, `llm/stream.ts` folds the stream, `persistence.ts` writes the
 * turn, `turn.ts` owns the conversation writes. What was missing is the
 * sequence, and the sequence is behaviour: **`stream_end` goes out after
 * persistence**, because a client that fires a follow-up command on seeing it
 * (the MCP bridge does) would otherwise read engine state that does not yet
 * have the turn in it.
 *
 * # The seam is gone, and with it the fork
 *
 * The Rust asked `can_delegate_tool_loop` whether the sidecar could drive the
 * whole turn. If it could, `stream_with_sidecar_tool_loop` handed the turn over
 * and the tools ran back over a socket; if it could not — a non-Anthropic
 * dialect at `9023b46d`, or a daemon whose tool socket was not serving — the
 * turn streamed here and a separate tool phase ran the loop daemon-side. Two
 * paths, both of which were about which side of a process boundary the tools
 * were on.
 *
 * There is one process now, so there is one path: when tools are enabled the
 * provider's loop runs the turn and calls {@link ToolPhase} in-process;
 * otherwise the provider streams once. The socket, the rid-addressed loop
 * registry, the `tool_rpc` field on the request and the "graceful degradation
 * to the daemon's own loop" all go with the hop. #12: *"In one process a tool
 * call is a function call."*
 *
 * # Three deliberate divergences
 *
 * 1. **A retry starts the turn's tool record over.** The Rust served tool calls
 *    into a single `Vec` for the whole call *including its retries*, so a turn
 *    whose first attempt ran two tools before failing persisted those two turns
 *    twice. Each attempt gets its own list here, and the one that succeeded is
 *    the one that persists.
 * 2. **The request the loop mutates is a copy.** The generic loop appends each
 *    round to `messages` so its next call carries them, which is the same list
 *    the Rust appended to *after* the fact from what the sidecar reported. Both
 *    at once would double every tool exchange in `last_request` — and that body
 *    is what the keepalive ping clones, where one divergent byte turns a 0.1×
 *    cache read into a 2.0× write. So the loop works on a copy and
 *    {@link applyIntermediateMessages} does the appending, once.
 * 3. **The compaction check is awaited.** The Rust spawned it detached and
 *    returned. Nothing here is blocking a thread, and awaiting is what lets a
 *    caller know the turn is actually over.
 *
 * # Not wired
 *
 * `runSubagent`, because `crates/daemon/src/tools/subagent.rs` has not ported.
 * A turn with `[subagents.*]` configured and no runner passed offers no `ask_*`
 * — see {@link ToolContextDeps}.
 */
```

## src/handler/generation.ts:176

```
/**
 * The daemon-lifetime half of the Rust's `GenContext`.
 *
 * The per-turn half — who to stream to, which signal aborts — arrives on
 * {@link GenerationParams}, because it is per-turn.
 */
```

## src/handler/generation.ts:205

```
/**
   * What the tool context needs that the config does not carry.
   *
   * Per character rather than one shared object, because two of its fields are:
   * `deferEdit` writes into *this* character's queue and `activityStats` reads
   * *this* character's tracker. A process-wide table could only leave both out,
   * which is a heartbeat's tool context — see `runtime.ts` — and not a chat
   * turn's.
   *
   * Per *turn* as well as per character, because `runSubagent` is: the nested
   * loop's frames go to the session that asked, and its history macro reads
   * this turn's conversation tail.
   */
```

## src/handler/generation.ts:225

```
/** Injected by the replay so a turn never sleeps between retries. */
```

## src/handler/generation.ts:227

```
/**
   * Overrides which loop runs a tool-using turn.
   *
   * Production picks between the two real ones by dialect, below. The parity
   * replay substitutes a loop that plays a recorded script against the
   * {@link ToolPhase} — the same thing the fixture's fake sidecar did — because
   * the Anthropic loop is the SDK's tool runner and cannot be fed canned
   * events. Each real loop is pinned by its own tests.
   */
```

## src/handler/generation.ts:389

```
// mistake because its context was an argument rather than a field; here it
```

## src/handler/generation.ts:391

```
// `LlmRequest` — it is `#[serde(skip)]`, so it lived in memory and never on
```

## src/handler/generation.ts:454

```
/**
 * Stream the turn, running its tools as the model asks for them.
 *
 * Retries and credential rotation wrap the *whole* turn, loop included, which
 * is what the Rust's sidecar-driven path did and is the only arrangement that
 * makes sense: a turn that failed on its third tool round has to start over,
 * because the provider has no way to resume one.
 */
```

## src/handler/generation.ts:507

```
// its next call carries them, and the request the caller holds must stay
```

## src/handler/generation.ts:530

```
// Inside the attempt rather than before the rotation, because a budget may
```

## src/handler/generation.ts:599

```
/**
 * Record one credential rotation: diagnostics always, a client warning only
 * when the key being abandoned opted in.
 *
 * The reason string is sanitized before it reaches either — it may quote a
 * provider's response body, and those have carried partial credentials.
 */
```

## src/handler/generation.ts:641

```
/**
 * Append the loop's own turns to the request that produced them.
 *
 * Every `last_request` reuse path — the keepalive ping, the heartbeat's cold
 * rebuild, compaction — clones this body and has to stay byte-identical to what
 * went out. Left as sent, it would replay a conversation missing every tool
 * exchange, so the ping's cache anchors miss and it rewrites the whole thing at
 * 2.0× instead of reading it at 0.1×.
 *
 * Provenance is split on purpose: the provider comes off the *request*, and the
 * model off the *result*, because a provider reports which model actually
 * served the call and that is what the thinking blocks were minted by. An empty
 * reported model leaves the field unset rather than empty — a replay reads those
 * differently.
 */
```

## src/handler/generation.ts:715

```
/**
 * `[tools]` as {@link toolPhase} reads it.
 *
 * A rename and a unit: the config keeps durations as `ConfigDuration` because
 * TOML spells them `"30s"`, and the dispatcher wants milliseconds.
 */
```

## src/handler/resize.ts:29

```
/**
 * Images at or above this on their longest side are never estimated below it.
 *
 * Text in a screenshot stops being legible well before the byte budget runs
 * out, so the estimator would happily produce something the model cannot read.
 * The floor applies to the *first* attempt only — see {@link resizeWithDims}.
 */
```

## src/handler/resize.ts:62

```
/**
 * Apply `scale` to both dimensions, never producing a zero.
 *
 * `Math.round` is half-up and Rust's `f64::round` is half-away-from-zero; the
 * two agree for every non-negative input, which is all that reaches here.
 * The `max(1)` is what stops a brutal budget from asking for a 0-pixel image,
 * which every encoder rejects.
 */
```

## src/handler/resize.ts:93

```
/**
 * First-attempt dimensions for an opaque image, which will be re-encoded as JPEG.
 *
 * Two corrections over the naive square root:
 *
 * - **`formatFactor`.** Above 3 bytes per pixel the source is almost certainly
 *   in a format far less efficient than the JPEG it is about to become — a raw
 *   or lightly-compressed PNG — so the budget is treated as 3× larger. Without
 *   it a 4 MB PNG gets scaled as though JPEG would need the same 4 MB, and the
 *   result is needlessly tiny. The threshold is strict: exactly 3.0 does not
 *   trigger it, and the fixture pins both sides.
 * - **The dimension floor.** An image that started at or above
 *   {@link DIMENSION_FLOOR} is pulled back up to it.
 */
```

## src/handler/resize.ts:125

```
/**
 * Second-attempt dimensions, corrected by how far the first encode overshot.
 *
 * `factor` is 0.85 on the transparent path and 0.9 on the opaque one — the
 * opaque retry is less pessimistic because it also drops the JPEG quality from
 * 90 to 85, so it is buying headroom twice.
 *
 * **This is not floored.** A brutal budget can and does land below
 * {@link DIMENSION_FLOOR} here, which the fixture records: a 4000×3000 source
 * with a 5 KB budget is planned at 2048×1520 and finishes at 61×46.
 */
```

## src/handler/resize.ts:148

```
/**
 * Whether any pixel is less than fully opaque.
 *
 * An image with no alpha channel at all is opaque by construction and is not
 * scanned. One with a channel is scanned, because a PNG that carries alpha and
 * never uses it is common — an editor added it — and converting it to JPEG is
 * both smaller and lossless in the ways that matter.
 *
 * `stats().isOpaque` is libvips' answer to the same question the Rust asked by
 * walking pixels: is the minimum alpha the channel maximum.
 */
```

## src/handler/resize.ts:166

```
// "assume transparency": staying PNG costs bytes, converting to JPEG would
```

## src/handler/resize.ts:167

```
// flatten transparency the caller can never get back.
```

## src/handler/resize.ts:209

```
/**
 * Transparent images stay PNG, and are only ever scaled down.
 *
 * Never converted to JPEG, however much that would save: flattening
 * transparency against a guessed background is not something the caller can
 * undo, and a wrong guess is far more visible than a larger file.
 */
```

## src/handler/resize.ts:324

```
/**
 * Bring `bytes` under `maxBytes`, or explain why it cannot.
 *
 * Returns `undefined` — meaning "send the original" — when the image is already
 * small enough, when there is no limit, when it is a GIF, or when it cannot be
 * decoded. A GIF is refused rather than flattened because resizing one means
 * dropping every frame but the first, and a still where an animation was is a
 * worse answer than a large file.
 */
```

## src/handler/resize.ts:380

```
/**
 * The cache key for one resize.
 *
 * SHA-256 over the path, the modification time in nanoseconds as a
 * **little-endian u128**, and the byte limit as a **little-endian u64**. The
 * widths are load-bearing: they are what the Rust hashed, and a key computed
 * over 8 bytes of mtime instead of 16 collides with nothing but also hits
 * nothing, silently costing a re-encode on every turn.
 *
 * Including the mtime is what makes an edited image re-encode rather than
 * serving a stale crop, and including `maxBytes` is what makes a config change
 * take effect without a manual cache clear.
 *
 * `maxBytes` accepts a bigint because a `u64` does not fit a JS number. Config
 * values are ordinary byte counts far below 2^53, but the key must still be
 * computable for anything the Rust could hash.
 */
```

## src/handler/resize.ts:481

```
// An IO guard, not a correctness one: {@link smartResize} makes the same
```

## src/handler/resize.ts:488

```
// every such image share one key per (path, limit) — acceptable, because a
```

## src/handler/resize.ts:523

```
/**
 * Populate the cache for every oversized image in a prompt, concurrently.
 *
 * Without this the first turn after a restart pays every resize serially,
 * inside the request path, while the user waits. Only files that are actually
 * over the limit are touched — the size check is a `stat`, so the common case
 * costs one syscall per image and no decode.
 *
 * Failures are swallowed by design: this is an optimisation, and the request
 * path will do the work again if it has to. The size gate is the same kind of
 * guard as the one in {@link cachedResize} and for the same reason: correctness
 * comes from `cachedResize` re-checking, so removing the gate changes nothing
 * observable — it just reads every attachment in the conversation into memory
 * to discover each one was already small enough.
 */
```

## src/handler/tool_context.ts:1

```
/**
 * The wiring a turn's tools run against.
 *
 * Ported from `build_tool_context` in `crates/daemon/src/handler/generation.rs`,
 * pinned by `tests/handler_fixtures/generation_parity.json`.
 *
 * Every field is derived from the character name and the two roots, and the
 * derivation is the whole of the behaviour: an image goes under *data*, a
 * workspace and its memory go under *config*, and the search index goes under
 * *cache*. Getting one wrong writes a character's files somewhere nothing reads
 * them back, which no test that stubs paths can catch — hence a fixture that
 * records the real ones.
 *
 * # Three optional wirings, and what each absence means
 *
 * - **No embedder.** Semantic retrieval degrades to lexical. Resolution failure
 *   is swallowed into a warning rather than raised: an unconfigured or
 *   key-less embedding provider must cost search quality, not the turn.
 * - **No image-generation config.** `generate_image` has nothing behind it and
 *   reports `io:`, because the tool is still registered and routed.
 * - **No sub-agent runtime.** `ask_*` is `NotImplemented`, which is also the
 *   recursion cap — a sub-agent's own context leaves this out, so it cannot
 *   delegate further.
 *
 * # What the Rust bundled that this does not
 *
 * `SharedToolContext` carried the `LlmClient` so `ledger_client()` could be
 * reached through the sub-agent runtime, and `HandlerToolContext` wrapped it to
 * add the autonomy manager. Neither wrapper survives: {@link ToolContext} is a
 * plain interface of what tools actually read, and the two callers that need
 * more hang it off their own closure.
 *
 * The **markdown memory store** is not opened either, and that is the one field
 * of `SharedToolContext` with no counterpart here. The Rust opened it on every
 * turn; the only thing that ever read it back was `subagent.rs` handing it to a
 * sub-agent's own context. No tool handler touches it, which is why
 * {@link ToolContext} has no slot for one — so opening it here would build a
 * field nothing reads. It comes back with the sub-agent runtime, or not at all.
 */
```

## src/handler/tool_context.ts:53

```
/** What the builder needs beyond the config, because none of it is config. */
```

## src/handler/tool_context.ts:57

```
/**
   * Runs a configured sub-agent. Wired only when `[subagents.*]` is non-empty,
   * matching the Rust — which built the runtime conditionally to avoid cloning
   * the config into an `Arc` on every turn that has no sub-agents.
   *
   * A **binder**, not the function itself, because a sub-agent's nested loop
   * runs against this very context minus its own `runSubagent` — that removal
   * is the recursion cap. So the runner cannot exist until the context does,
   * and the one place that knows both is here. A caller with nothing to pass
   * leaves `ask_*` uncallable, which is what a daemon without the runtime did.
   */
```

## src/handler/tool_context.ts:81

```
/**
 * Assemble the tool context for one turn, and seed the active-prompt snapshot.
 *
 * The snapshot is a side effect rather than a return value, and it is here
 * rather than at the call site because it is the same "prepare the character's
 * files" step the paths above describe. A failure to write one warns and the
 * context is still built: the turn can run without a baseline to diff a
 * deferred edit against.
 */
```

## src/handler/tool_context.ts:134

```
// the Rust asked the config, and a caller that always passes a runner would
```

## src/handler/tool_context.ts:135

```
// otherwise offer `ask_*` for sub-agents that do not exist.
```

## src/handler/tool_context.ts:159

```
// Attached after the object exists, because the runner closes over it: the
```

## src/handler/tool_context.ts:167

```
/**
 * `[providers.*]` as the two resolvers want it: keyed by provider, with the
 * entry's own `base_url` lifted out beside it.
 *
 * The key list is retyped on the way through, because the registry and the
 * credential resolver spell the same field differently — `warnOnFallback` in
 * the parsed config, `warn_on_fallback` in `llm/credentials.ts`, which took its
 * spelling from the wire. This is the first production caller to need both, and
 * one translation in one place is the cheaper of the two fixes.
 */
```

## src/handler/tool_context.ts:203

```
/**
 * `[memory.retrieval]` as the index reads it.
 *
 * A rename, and only a rename: the config is snake_case because it is a TOML
 * table, and `memory/workspace_index.ts` is camelCase because it is not.
 */
```

## src/handler/context.ts:1

```
/**
 * The shared "build the chat-shaped request inputs" pipeline.
 *
 * Ported from `crates/daemon/src/handler/context.rs`, pinned by
 * `tests/handler_fixtures/context_parity.json`.
 *
 * Two sites need to take a character plus its conversation history and produce
 * the message list, the system blocks, and the tool definitions an outgoing
 * request is built from: chat generation, and the heartbeat's cold rebuild.
 * They had nearly byte-identical thirty-line stretches doing it, and that
 * duplication was load-bearing in the worst way — a drift as small as one
 * forgotten step silently broke cache reuse between chat and heartbeat, which
 * shows up as a bill rather than as a failure.
 *
 * This module is the one place those steps live.
 */
```

## src/handler/context.ts:57

```
/**
   * The zone time markers render in. Defaults to the host's, which is what the
   * Rust's `chrono::Local` resolved to. A parameter only because the Rust's
   * implicit host lookup is untestable — the parity replay has to pin a zone
   * or it passes on the generator's machine and nowhere else.
   */
```

## src/handler/context.ts:147

```
// Offer order is cache-load-bearing; `assembleToolSurface` owns it.
```

## src/handler/context.ts:169

```
/**
 * Build the chat-shape request from disk — the request chat's handler would
 * build for its next turn.
 *
 * The fallback for when an in-memory `last_request` is unavailable: a daemon
 * restart, a post-compaction invalidation, a manual compact before any chat has
 * run. Both the heartbeat's cold rebuild and the compaction tail builder lean on
 * it, and the reason is the cache rather than convenience — whatever chat would
 * have sent is what they send, so the prefix lines up across all three.
 *
 * `resolved` is the model the request is anchored on: system, tools and the
 * provider key all flow from it. Compaction passes the *chat* model here on
 * purpose, because its own tool loop rebuilds against the compaction model
 * later; this call only establishes the wire shape.
 *
 * # `mcpToolDefs` is not optional in the way it looks
 *
 * The Rust had two of these, and they disagreed about MCP tools on purpose.
 * `handler/context.rs` passed `&[]` with a comment saying "not wired on this
 * path yet"; `autonomy/manager.rs`'s passed the registry's filtered defs with a
 * comment saying that omitting them would make the keepalive *strictly
 * negative* — a warmed prefix missing tools chat includes is a prefix the next
 * chat turn cannot reuse, so the ping pays for a write and buys nothing.
 *
 * Which caller is which decides it. Compaction rebuilds only to establish a
 * wire shape it immediately re-anchors on the compaction model, so its tool
 * surface never has to match chat's byte for byte. The keepalive's whole job is
 * that it does. Defaulting to empty keeps compaction's behaviour and makes the
 * keepalive's a thing its caller states.
 */
```

## src/handler/deps.ts:1

```
/**
 * The daemon's message handler, assembled from a {@link ShoreRuntime}.
 *
 * Ported from the `MessageHandlerDeps` and `GenContext` halves of
 * `build_server_and_handler`, and from `build_command_context`, in
 * `crates/daemon/src/main.rs`.
 *
 * {@link buildMessageHandlerDeps} is the whole of it; the two `build*Deps`
 * calls underneath it are separable and separately tested. Every module they
 * supply — the turn driver, the command table, the router — was written to take
 * its collaborators as arguments, and nothing has ever supplied them.
 *
 * What this mostly does is name which of the runtime's pieces answers each
 * question. The places it does more than that are the places the Rust did:
 *
 * - **Two of the tool backends are per character.** `deferEdit` writes into one
 *   character's queue and `activityStats` reads one character's tracker, so the
 *   tool context is built per turn from {@link sharedToolDeps} plus those two.
 *   A heartbeat gets the shared half alone — see `runtime.ts`.
 * - **The budget check is a read that writes.** Each threshold it reports is
 *   marked delivered, so it must run once per turn and only once, and it must
 *   not run at all when no budget is configured — otherwise every turn opens
 *   the ledger to be told there is nothing to say.
 *
 * # What is read live rather than held
 *
 * `[usage]` and the keepalive ceiling are read off `CharacterRegistry.globalConfig()`
 * per call instead of being copied into this object. The Rust held both on the
 * ledger client and had `set_usage_config`/`set_cache_keepalive_ceiling` push
 * new values in on every reload; reading through the registry is the same
 * values with nothing to forget to push. The registry's global config is what a
 * reload replaces, so a budget added at runtime is in force on the next turn.
 *
 * That is also why the two setters below are no-ops rather than gaps.
 *
 * # The command path, and the one thing it does not do
 *
 * {@link buildCommandPathDeps} supplies `handler/commands.ts`, which needs two
 * more surfaces nothing had implemented: `ConfigRuntime` — what a `config`
 * command pushes outward — and `DispatchRuntime`, what the four
 * post-processing hooks reach into.
 *
 * **`[mcp]` is not reconnected on reload** — issue #28. The Rust's `apply_reloaded_config`
 * compares the section and rebuilds the registry when it moved. Doing that here
 * means `ShoreRuntime.mcp` becoming a holder both this path *and* the autonomy
 * executor read through, because a chat turn and a heartbeat must offer the
 * same tool surface — a background tick with fewer tools writes a prefix the
 * next chat turn cannot reuse, and the keepalive then pays for a cache write
 * and buys nothing. Swapping only the copy chat sees would cause exactly that,
 * so this does nothing rather than half of it: edits to `[mcp]` need a restart,
 * and everything else in a reload lands.
 */
```

## src/handler/deps.ts:158

```
/**
 * The character registry as a turn reads it.
 *
 * `getOrCreate` is adapted rather than passed straight through because
 * `setup.ts` wants `segmentCount()` and the engine exposes the reader that has
 * it; {@link generationEngine} is where that one method's difference lives.
 */
```

## src/handler/deps.ts:205

```
// order, because arming is what reads the cadence out of a body.
```

## src/handler/deps.ts:294

```
/**
 * Budget thresholds this turn newly crossed.
 *
 * Two things it must get right. It is a **read that writes** — each threshold
 * it reports is marked delivered, so the same 80% crossing is announced once
 * per window and calling it twice per turn would swallow the second one. And it
 * **must not open the ledger when no budget is configured**, which is the
 * common case: an open per turn to be told there is nothing to say is a cost
 * with no answer.
 *
 * A ledger that will not open reports nothing rather than failing the turn. The
 * turn has already completed and been persisted by the time this runs; a
 * missing warning is worth less than the answer the user is reading.
 */
```

## src/handler/deps.ts:341

```
/**
 * The handler, assembled.
 *
 * Everything below the two `build*Deps` calls is an adapter of a few lines,
 * and each exists because this module reads a runtime piece more narrowly than
 * the piece is written — a registry that answers with a message instead of
 * throwing, a notifier that only ever files an error.
 */
```

## src/handler/deps.ts:352

```
// Fresh, and never shared with anything: a lease names a session on this
```

## src/handler/deps.ts:514

```
/**
 * The handler-owned state the four post-processing hooks reach into.
 *
 * `applyReloadedConfig` is the interesting one: it is the whole of what a
 * reload turns out to move, and the order is the Rust's — adopt into the
 * registry first, because everything after it reads the registry.
 */
```

## src/handler/deps.ts:558

```
/**
 * Adopt a freshly-loaded config everywhere that holds one.
 *
 * A module function rather than a closure on {@link dispatchRuntime} because
 * it has a second caller that has nothing to do with commands: the config
 * watcher. A `config_reload` and a file saved in `$XDG_CONFIG_HOME/shore` are
 * the same event as far as the daemon is concerned, and it would be a poor
 * kind of hot reload that did less than the command.
 */
```

## src/handler/deps.ts:571

```
// First, because it is what every read below goes through: the registry
```

## src/handler/deps.ts:584

```
/**
 * Rebuild the MCP registry when `[mcp]` moved, and only then (#28).
 *
 * **The comparison is the point, not an optimisation.** Rebuilding on every
 * reload would tear down and respawn every stdio child for an unrelated edit —
 * and each rebuild is a tool-surface change, which is a cache prefix change,
 * which costs a full write on every character's next turn. An unrelated config
 * edit must not do that.
 *
 * Order: connect the new one, swap the holder, then shut the old one down.
 * Connecting first means a total failure to connect leaves the running
 * registry in place rather than a hole; swapping before shutting down means
 * nothing can take a reference to a registry that is about to close.
 *
 * The old registry's transports close immediately. A generation already in
 * flight keeps the tool *definitions* it was assembled with — those are read
 * once in `buildGenerationRequest`, so its prefix is stable — but its `call`s
 * go through the holder and land on the new registry. A call already on the
 * wire when the swap happens fails once; that one is unavoidable without
 * keeping the old child processes alive for an unbounded time.
 */
```

## src/handler/deps.ts:626

```
// right at startup — a bad server must never take the daemon down. On a
```

## src/handler/deps.ts:632

```
// every server from the config still empties it, because then none were
```

## src/handler/deps.ts:652

```
/**
 * Re-read `config.toml` from disk and adopt it, or keep what is running.
 *
 * What the watcher calls. Two things it must get right, both of them about
 * *not* adopting:
 *
 * - **A config that will not parse changes nothing.** Someone is editing the
 *   file, and half-typed TOML reaches the watcher as often as finished TOML
 *   does. A daemon that adopted every intermediate state would spend the edit
 *   flapping between configurations.
 * - **A broken per-character overlay changes nothing either.** `loadConfig`
 *   only parses the global file, so a `characters/<name>/config.toml` that
 *   does not parse would be discovered later, one character at a time, as a
 *   silent fall back to the global config. Every overlay is validated against
 *   the new global before any of it is committed.
 *
 * Startup-owned settings that moved are warned about rather than applied. The
 * listen address and the data directory are read once, before any of this
 * exists; saying so is the only thing that can be done about them.
 */
```

## src/handler/deps.ts:729

```
// One session that has gone away must not stop the rest being told.
```

## src/handler/deps.ts:761

```
// an inline or idle pass would — otherwise the manual pass rebuilds a
```

## src/handler/lease.ts:1

```
/**
 * Which sessions see a generation's output.
 *
 * Ported from the `LastUserLease` half of `crates/daemon/src/handler/mod.rs` —
 * `LEASE_TTL`, `resolve_lease_tx`, `build_fanout_tx`, and the insert at the top
 * of `handle_engine_message`.
 *
 * A generation streams to whichever session asked for it. That is the wrong
 * answer whenever the session that asked is not the session the user is looking
 * at: a regen fired from a second frontend, a client that reconnected under a
 * new session id, a scripted `shore` invocation. The open TUI would show the
 * user's own message and then nothing, and the turn would only appear on its
 * next history load.
 *
 * So each character remembers the last session to send a real user message, and
 * generation output goes to that session as well as to the issuer.
 *
 * # The rules, and what each one is for
 *
 * - **Only a real user message takes the lease.** The lease is a guess at where
 *   the human is sitting, and typing is the only thing that proves it. A regen
 *   or a command can come from anywhere, so letting one move the lease would
 *   point the stream at a script and away from the person watching.
 * - **It lapses after an hour.** Long enough to cover a conversation, short
 *   enough that a frontend left open overnight stops receiving another
 *   frontend's turns.
 * - **A lease held by the issuer is no lease at all.** Otherwise every frame
 *   would be delivered to that session twice.
 * - **Stale leases are dropped as they are read.** Expired, or pointing at a
 *   session that has since disconnected. There is no sweeper, and none is
 *   needed: a lease nobody asks about costs one map entry.
 * - **The second recipient is chosen once, when the generation starts.** Not
 *   per frame. A frontend that connects mid-turn joins from the next turn,
 *   which is also what the Rust did — it resolved the sender before building
 *   the channel that the generation task wrote into.
 */
```

## src/handler/lease.ts:73

```
/**
   * The second recipient for `character`'s stream, or `undefined` when there is
   * none. Evicts the lease if it has lapsed or its session has disconnected.
   *
   * The Rust checked the issuer first, so an expired lease held by the issuer
   * was left in the map for some later session to evict. Checking expiry first
   * drops it either way. No caller can tell the difference — `now` only moves
   * forward, so a lease that has lapsed can never be used again by anyone — but
   * one order leaves an entry behind and the other does not.
   */
```

## src/handler/lease.ts:101

```
/**
   * A sender that delivers to the issuer and to the lease holder both.
   *
   * The Rust built a channel and spawned a task to drain it into the two
   * senders. That machinery bought nothing but the decoupling — a `send` on a
   * bounded channel is an await, same as this — so what is left is the
   * forwarding itself.
   *
   * Two things it keeps. Delivery failures are swallowed, each independently:
   * the Rust ignored both sends because a channel send can only fail by the
   * receiver being gone, and here they are real socket writes, so a frontend
   * that died mid-turn must not take the generation down with it. And the
   * message object is shared rather than cloned, which is safe because a frame
   * is serialized on the way out and nothing on either path mutates it.
   */
```

## src/daemon/auto_discovery.ts:1

```
/**
 * Keeping each provider's model list from going stale.
 *
 * Ported from `crates/daemon/src/auto_discovery.rs`.
 *
 * A pass at boot and every {@link REFRESH_INTERVAL_MS} after it. Each provider
 * that is enabled *and* has `discovery.enabled` is refreshed if its on-disk
 * cache is missing or past its TTL. `refreshOne` does the work; this decides
 * who and when.
 *
 * # Failures are per provider and never propagate
 *
 * A transient outage at one provider must not stop the daemon, and must not
 * stop the other providers being refreshed. `writeCache` is atomic, so a fetch
 * that fails or returns something unparseable leaves the previous cache exactly
 * where it was — a stale list is worth much more than no list.
 *
 * # One divergence: the config is read live
 *
 * The Rust captured a `LoadedConfig` when the loop was spawned, so enabling a
 * provider — or turning its discovery on — did nothing until the daemon was
 * restarted. That was true of everything on the reload path before
 * `hot_reload.ts` landed. This reads through the registry per pass, so a
 * provider added to `config.toml` is discovered on the next tick.
 */
```

## src/daemon/auto_discovery.ts:50

```
// A pass that overran its interval must not have a second one start beside
```

## src/daemon/auto_discovery.ts:72

```
// `clearInterval` is the whole of it. There is no second latch, because
```

## src/daemon/startup.ts:1

```
/**
 * What the daemon decides before it opens anything: the CLI, the listen
 * address, and the client token.
 *
 * Ported from the startup half of `crates/daemon/src/main.rs`.
 *
 * # There is no exposure policy here any more
 *
 * There used to be a substantial one — a non-loopback bind was refused unless
 * `unsafe_allow_remote_access` acknowledged it, `[daemon].allowed_hosts`
 * narrowed peer IPs, and roughly 200 lines here parsed socket addresses to tell
 * loopback from not. All of it existed because the protocol was
 * unauthenticated, and all of it is gone.
 *
 * Every client presents a token now (`config/token.ts`), so where the daemon is
 * bound no longer decides who can talk to it. Two things follow, and both were
 * the point:
 *
 * - **`[daemon]` is one key.** `addr`, and nothing else. There is no
 *   configuration you can get wrong, because being safe is no longer something
 *   you configure.
 * - **A bind address is just a bind address.** `0.0.0.0` needs no
 *   acknowledgement, because it no longer means "unauthenticated and
 *   reachable" — it means "reachable", and the token handles the rest.
 */
```

## src/daemon/startup.ts:67

```
/**
   * The shared secret every client must present, resolved once here.
   *
   * Resolved at startup rather than per connection so that a daemon which
   * cannot establish one fails to *start* — loudly, with somewhere to go —
   * instead of accepting connections and refusing every one of them.
   */
```

## src/daemon/startup.ts:178

```
// A refusal to start, never a fallback to "authentication off". There is
```

## src/daemon/startup.ts:180

```
// token is a daemon that must not listen.
```

## src/daemon/hot_reload.ts:1

```
/**
 * Watching the config directory, and deciding what is worth a reload.
 *
 * Ported from `crates/daemon/src/hot_reload.rs`.
 *
 * # Most of what changes under `<config>/` is not config
 *
 * The watcher is recursive because config is spread across several files — the
 * main `config.toml`, `conf.d/*.toml`, `.env`, and a `config.toml` per
 * character. But the same tree holds every character's *workspace*: `SOUL.md`,
 * `MEMORY.md`, the memory files a tool writes during a turn.
 *
 * Those are ignored, and not as an optimisation. A prompt file is part of the
 * cached prefix, and a reload is a natural place to rebuild one — so a
 * filesystem save would become a prompt activation boundary, and a character
 * editing its own memory mid-conversation would invalidate the cache it is
 * talking through. {@link pathTriggersReload} is where that line is drawn.
 *
 * # Debounce
 *
 * An editor writing a file produces several events — a temp file, a rename, a
 * chmod — and a `git checkout` produces hundreds. {@link DEBOUNCE_MS} after the
 * last one, whatever accumulated is reloaded once.
 */
```

## src/daemon/hot_reload.ts:35

```
/** The file the daemon was started with; always triggers, wherever it is. */
```

## src/daemon/hot_reload.ts:39

```
/** Re-read and adopt. Never called concurrently with itself. */
```

## src/daemon/hot_reload.ts:65

```
/**
 * Start watching, or answer `undefined` and carry on without it.
 *
 * A watcher that will not start is a warning, not a failure — the config
 * directory may not exist yet, and a daemon that refused to run because it
 * could not watch for edits would be trading the service for a convenience.
 */
```

## src/daemon/hot_reload.ts:166

```
/**
 * Whether a path under `SHORE_WORKSPACE_DIR` is worth a reload.
 *
 * Almost nothing is. A workspace root holds *only* workspaces — prompts and
 * memory, written mid-turn — so the single case that reloads is the one that
 * changes what characters exist: `<root>/<name>/SOUL.md` appearing for a name
 * the registry does not hold yet. Everything else, including edits to a known
 * character's own `SOUL.md`, is ignored for the reason in the module doc: a
 * save must not become a prompt activation boundary.
 *
 * Without `knownCharacter` nothing here triggers, matching the config-tree
 * rule, where a caller that does not care gets no workspace reloads at all.
 */
```

## src/daemon/hot_reload.ts:197

```
/**
 * Whether a changed path is one the daemon reads its configuration from.
 *
 * The rules, in the order they are applied:
 *
 * | Path | Reloads | Why |
 * |---|---|---|
 * | the config file itself | yes | wherever it is, including outside the tree |
 * | `characters/<n>/workspace/SOUL.md`, `<n>` unknown | yes | the character is *appearing* |
 * | `characters/<n>/workspace/**` | **no** | prompts and memory — see the module doc |
 * | `.env` at the root | yes | provider keys are read from it |
 * | `conf.d/` | yes | the directory itself, or any `.toml` under it |
 * | `characters/<n>` | yes | a character appearing or going |
 * | `characters/<n>/config.toml` | yes | the per-character overlay |
 * | `characters/<n>/character.md` | yes | the definition discovery reads |
 * | anything else `.toml` | yes | `models.toml`, and whatever else is added |
 * | anything else | no | |
 *
 * # Why `SOUL.md` gets an exemption from the workspace rule
 *
 * `discoverCharacters` keys on `workspace/SOUL.md`, so that file is not only a
 * prompt — its *existence* is what makes a directory a character. Ignoring it
 * unconditionally means the sequence that creates one is invisible: the
 * `characters/<n>` event fires while the directory is still empty and finds
 * nothing, and the write that would have made it discoverable is swallowed. A
 * new character was therefore not picked up until some unrelated config edit
 * happened to trigger a reload.
 *
 * `knownCharacter` is what keeps this from reopening what the rule is for. An
 * edit to the `SOUL.md` of a character the registry already holds is still
 * ignored, so a save is still not a prompt activation boundary and a character
 * rewriting its own prompt still cannot invalidate the prefix it is talking
 * through. Only the first appearance reloads, and it can only happen once.
 *
 * Without the predicate every workspace path is ignored, which is the Rust's
 * behaviour and the behaviour of every caller that does not care.
 */
```

## src/daemon/hot_reload.ts:274

```
// everything under it are never reported — only `characters`. Ignoring it
```

## src/daemon/hot_reload.ts:278

```
// Safe to reload on, because a deep write reports its own path: a character
```

## src/daemon/hot_reload.ts:280

```
// never a bare `characters`. Verified rather than assumed — it is the whole
```

## src/daemon/run.ts:1

```
/**
 * Starting the daemon: bind, assemble, register, serve, and stop cleanly.
 *
 * Ported from `run_daemon` and `build_server_and_handler` in
 * `crates/daemon/src/main.rs`. The policy this runs on is `startup.ts`; the
 * pieces it assembles are `runtime.ts` and `handler/deps.ts`. What is left here
 * is the *order*, and every step below is where it is for a reason.
 *
 * # The order
 *
 * ```text
 * resolveStartup            policy first: a refused bind opens nothing
 * new Server                the broadcast the registry is built with
 * server.bind()             a real port before anything records one
 * register instance         discovery can find it from here on
 * createRuntime             stores, MCP, characters, the autonomy loop
 * setHandshakeProvider      closes the cycle the broadcast opened
 * handler.run(routes)       a consumer before there can be a message
 * server.serve()            accept
 * ```
 *
 * Two of those are subtle enough to be worth stating.
 *
 * **Bind before the runtime.** Opening databases and spawning MCP servers takes
 * real time, and the one failure most likely at startup is a port already in
 * use — a second daemon, or the one systemd has not finished stopping. Binding
 * first means that failure costs nothing and is reported as itself.
 *
 * **The handler starts before `serve`.** A connection that hand-shakes while
 * nothing is draining {@link Server.routes} queues its messages and is never
 * answered. `bind` and `serve` are separate precisely so this can go between
 * them.
 *
 * # What is not here yet
 *
 * `spawn_background_services` had three tasks. Two have ported and start
 * below: the config watcher (`hot_reload.ts`) and provider auto-discovery
 * (`auto_discovery.ts`). The third, the sidecar supervisor, does not move at
 * all — it supervises the process this port is being written into.
 */
```

## src/daemon/run.ts:66

```
/**
 * How long to wait for each shutdown step before giving up on it.
 *
 * Bounded rather than awaited outright, as the Rust's `tokio::time::timeout`
 * around every join. A hung MCP server must not be the difference between a
 * clean exit and systemd resorting to SIGKILL — at which point the autonomy
 * state file is what does not get written.
 */
```

## src/daemon/run.ts:80

```
/** One adapter per dialect. Required, because the caller owns the table. */
```

## src/daemon/run.ts:94

```
/**
   * Refresh provider model lists on a schedule. On by default.
   *
   * Off is for a test, which must not make a network request to be told a
   * provider it invented is unreachable.
   */
```

## src/daemon/run.ts:142

```
// Where the secret came from — never the secret. A person debugging "my
```

## src/daemon/run.ts:148

```
// Said once, at the moment it becomes true, because it is the only time a
```

## src/daemon/run.ts:208

```
// never appears — and the watcher below cannot watch a directory that is not
```

## src/daemon/run.ts:209

```
// there, which is exactly the first run where a character is about to be
```

## src/daemon/run.ts:273

```
// Watched rather than polled, and it does exactly what `config_reload` does
```

## src/daemon/run.ts:345

```
/**
 * Start a daemon and run it until a signal says otherwise.
 *
 * `SIGTERM` is what systemd sends and `SIGINT` is Ctrl-C; both mean the same
 * thing here. Registered once and removed on the way out, so a caller that
 * starts a second daemon in the same process does not inherit the first's.
 */
```

## src/llm/capture.ts:1

```
/**
 * Recording every provider call's request and response into the payload store.
 *
 * This is the writer behind `shore log` and `[advanced].api_payload_logging`.
 * The port defined {@link CallStore.recordCall}, opened the store at startup and
 * logged "call payload store enabled" — and then never called it. `calls.db`
 * held only the rows the Rust daemon had written, so the log built for
 * answering "what did we actually send?" was empty for exactly the window in
 * which a cache bug needed it.
 *
 * # One row per provider entry point, not per model call
 *
 * The Rust drove tool loops daemon-side, so every model call was its own
 * `stream()` and got its own row. Here the Anthropic loop runs *inside*
 * `stream()`, so one row can cover several model calls and its response body
 * carries several `call_complete` events. The row's headline usage and finish
 * reason come from the terminal event, which is the aggregate for the whole
 * loop; per-call accounting is the ledger's job (one row per `call_complete`)
 * and per-call cache placement is `cache_forensics.jsonl`'s. Reach for those
 * when the question is about one call rather than one request.
 *
 * # Never in the way
 *
 * A capture failure must not fail a call that otherwise worked, so every store
 * write is wrapped. The stream wrapper is a passthrough generator: events reach
 * the caller as they arrive and the row is written when the stream ends,
 * including when it ends by throwing.
 */
```

## src/llm/capture.ts:59

```
/**
 * The request as sent, minus what must not be stored.
 *
 * `api_key` is replaced rather than dropped, so a reader can still see *that* a
 * credential was attached — the Rust wrote the same `[REDACTED]` sentinel.
 * `context` is omitted entirely: it is daemon-side labelling that never reaches
 * a provider, and it carries the resolved `[usage]` budget config, so storing it
 * would put a copy of that in every row for no diagnostic gain. Its useful
 * fields are already the row's own columns.
 */
```

## src/llm/capture.ts:74

```
// A request that will not serialize must still produce a row, or the
```

## src/llm/capture.ts:123

```
// Diagnostics are never worth failing a call over.
```

## src/llm/capture.ts:148

```
// the last one seen so a loop that never reached `done` still reports
```

## src/llm/types.ts:1

```
/**
 * Sidecar IPC contract + internal adapter types.
 *
 * The CONTRACT section mirrors the Rust wire types 1:1 (see
 * `crates/daemon/src/llm/types.rs`, which is the authority). The Rust daemon
 * serializes an `LlmRequest` to `SidecarRequest`; the sidecar streams
 * `StreamEvent` NDJSON back, which `StreamConsumer` (`crates/daemon/src/llm/stream.rs`)
 * already knows how to parse. Field names are snake_case to match serde.
 *
 * The LEGACY section below holds the pre-migration adapter shapes
 * (`ChatRequest`/`ChatEvent`/...). The adapters still speak these; they move to
 * the contract types in the adapter-reshape task. Don't add new callers.
 *
 * Anthropic-style content blocks are the canonical in-process representation
 * because our on-disk format stores blocks this way and Anthropic is the picky
 * one about block ordering. The `thinking` block's `signature` is opaque bytes
 * replayed verbatim — never inspected, regenerated, or normalized.
 *
 * The daemon sends the conversation UNFILTERED. Deciding what each provider
 * accepts — carrier-less thinking, cross-model replay, the prior-thinking
 * strip — happens in `llm/replay.ts`, on this side of the seam.
 */
```

## src/llm/types.ts:46

```
/**
 * One conversation turn, mirroring Rust `WireMessage`
 * (`crates/daemon/src/llm/types.rs`). The two must change together.
 *
 * `content` is **unfiltered**: it carries every block the daemon stores,
 * including thinking with no carrier and thinking minted by a different model.
 * Deciding what a given provider accepts is this side's job — see
 * `llm/replay.ts`. Until that moved, the daemon filtered before sending and
 * this type was `ContentBlock[] | string` describing bytes it could not check.
 */
```

## src/llm/types.ts:89

```
/**
 * One labelled block of system prompt, mirroring Rust `SystemBlock`
 * (`crates/daemon/src/llm/types.rs`). The two must change together.
 *
 * `label` is cache-load-bearing: the Anthropic adapter anchors the system
 * breakpoint on the last block that is NOT `memory_index`, because that block
 * churns on every dreaming and compaction pass.
 *
 * This arrived as `string | Array<{type, text, cache_control?, _label?}>` — an
 * Anthropic `TextBlockParam` with the label smuggled in under an underscore,
 * which the adapter had to `delete` before sending or leak a field no provider
 * knows. It also had a shape fork the daemon could not express in a type: a
 * one-block system prompt serialized as a bare string, dropping its label.
 */
```

## src/llm/types.ts:105

```
/** `system` | `character` | `user` | `tools_guidance` | `memory_index`.
   * Never sent to a provider. */
```

## src/llm/types.ts:120

```
/**
 * One tool offered to the model, mirroring Rust `ToolDefinition`
 * (`crates/daemon/src/llm/types.rs`).
 *
 * The field names are Anthropic's spelling because that is what the daemon has
 * always emitted, but this is a provider-*neutral* shape: each adapter maps it
 * to its own wire format. Do not pass it to a provider unchanged outside the
 * Anthropic adapter.
 *
 * Order is significant — it is part of Anthropic's cache prefix — so adapters
 * must forward the array in the order received.
 */
```

## src/llm/types.ts:135

```
/** JSON Schema for the tool's arguments; always an object schema. */
```

## src/llm/types.ts:146

```
/**
 * Per-provider knobs, mirroring Rust `ProviderOptions`
 * (`crates/daemon/src/llm/types.rs`). The two must change together.
 *
 * This was `Record<string, unknown>` on both sides until it accumulated three
 * keys the daemon wrote and no adapter read. Every field below has a reader in
 * this directory; adding one without a reader is now a type error at the
 * daemon's build, not a silent no-op at runtime.
 *
 * Absent knobs are omitted by the daemon rather than sent as null, so
 * `undefined` unambiguously means "not configured".
 */
```

## src/llm/types.ts:159

```
/** Named effort (`low`/`medium`/`high`/`max`/`adaptive`) or a provider-specific
   * string. Never `"off"` — the daemon rewrites that to `thinking_enabled: false`. */
```

## src/llm/types.ts:162

```
/** Only ever `false`, meaning "explicitly disable reasoning". Adapters that can
   * turn thinking off on an always-on model act on it; the rest omit reasoning. */
```

## src/llm/types.ts:174

```
/** Z.ai `clear_thinking`. `false` is load-bearing — it enables the
   * Preserved-Thinking replay path — so this is a tri-state, not a flag. */
```

## src/llm/types.ts:181

```
/**
 * Per-call labels from the daemon — mirrors Rust `CallContext`
 * (`crates/daemon/src/llm/types.rs`). The two must change together, and the
 * shape is pinned in `wire_parity.json`.
 *
 * This is daemon bookkeeping, not part of the LLM request: who the call is for,
 * what kind it is, which key paid, where to write the row. It arrives beside
 * the request rather than inside it, so none of it can reach a provider.
 *
 * The ledger row is written here because this side makes the call, and so is
 * the only side that sees each call of a tool loop separately — and the only
 * one that can record a failed call at the moment it fails. `cache_ttl` and
 * `reasoning_effort` arrive already resolved so a row's shape does not depend
 * on two implementations of the same resolution agreeing.
 */
```

## src/llm/types.ts:211

```
/**
   * `[usage]`, so this side can refuse a call that would exceed a budget.
   *
   * Carried **per call** rather than pushed once and cached, deliberately. A
   * cached config is one restart away from being empty, and an empty budget
   * list does not fail loudly — it silently allows everything, which is the
   * expensive direction. Sending it every time costs a few hundred bytes on a
   * request that is about to cost money.
   *
   * Absent, or present with no budgets, means nothing to enforce.
   */
```

## src/llm/types.ts:278

```
/**
 * The event vocabulary every provider adapter emits and `StreamConsumer` folds
 * into a turn. Mirrors Rust `StreamEvent`
 * (`#[serde(tag = "type", rename_all = "snake_case")]`).
 *
 * Ordering rules live with the code that depends on them, in
 * `llm/stream.ts`'s `handle`: which events flush a pending text or thinking
 * buffer, and therefore what order the persisted blocks come out in. They used
 * to be prose in `docs/LLM_SIDECAR_IPC.md`, which described this as an NDJSON
 * wire format between two processes. There is one process, the events never
 * serialize, and the doc had drifted — it stated as a rule that this union has
 * no `error` variant.
 */
```

## src/llm/types.ts:335

```
// thinking turn sends only provider `ping`s, which we do not forward). Its
```

## src/llm/types.ts:436

```
/**
 * A wire turn as the adapters' converter shape.
 *
 * Four adapters each carried a private copy of this, and every copy existed
 * only to widen a bare-string `content` into a text block. `WireMessage.content`
 * is now always blocks, so the conversion is a projection — kept as one function
 * because the two types are still distinct (`TurnMessage` has the legacy
 * `images` field the daemon never populates).
 */
```

## src/llm/types.ts:469

```
/** Empty string disables caching; otherwise a TTL like "1h" / "5m". */
```

## src/llm/credentials.ts:1

```
/**
 * Deciding whether a failure means "try the next API key".
 *
 * Ported from `crates/daemon/src/llm/credentials.rs`, pinned by
 * `tests/llm_fixtures/llm_decisions_parity.json`.
 *
 * A provider can declare ordered named keys. When a request fails in a
 * credential-shaped way — key missing or rejected, quota or account budget
 * exhausted, a rate limit clearly scoped to this key — the caller abandons that
 * key and retries the same request with the next one. Everything else is left
 * to the retry policy.
 *
 * # Both directions of a wrong answer cost something
 *
 * Classifying a real credential failure as transient means retrying a key that
 * cannot work, three times, and then failing the turn with a key still unused.
 * Classifying a *transient* failure as credential-shaped means burning through
 * every configured key on what was a passing 503, and arriving at
 * "all keys exhausted" when nothing was wrong with any of them. The classifier
 * is deliberately conservative in the second direction: a generic 429 is not a
 * credential failure, because those are usually global bursts.
 *
 * Secrets never leave this module's caller: candidates carry the *name* of an
 * env var, and only friendly key names reach a client.
 */
```

## src/llm/credentials.ts:65

```
// A stream that died mid-flight must not rotate: the provider already
```

## src/llm/credentials.ts:77

```
// A budget refuses the *call*, not the credential. Rotating would ask every
```

## src/llm/credentials.ts:164

```
/** Surfaced to clients on fallback. Never the value. */
```

## src/llm/fallback.ts:1

```
/**
 * Transient retry, and rotating across a provider's configured API keys.
 *
 * Ported from `crates/daemon/src/handler/generation.rs` (`stream_with_retry`)
 * and `crates/daemon/src/handler/key_fallback.rs`, pinned by
 * `tests/llm_fixtures/fallback_parity.json`.
 *
 * Two layers, deliberately separate, wrapping every outbound call:
 *
 * 1. {@link streamWithRetry} absorbs *transient* failures — 5xx, network
 *    blips, a stream that ends without its done event — with exponential
 *    backoff on the same key.
 * 2. {@link streamWithCredentialFallback} sits above it and rotates to the
 *    next configured key when a failure is *credential*-shaped. Each candidate
 *    gets the full transient budget before its key is abandoned.
 *
 * # Why the order matters
 *
 * Getting it backwards burns every configured key on what was a passing 503
 * and reports "all keys exhausted" when nothing was wrong with any of them.
 * Retrying inside the rotation is what keeps a transient failure from looking
 * like a credential one.
 *
 * # Invariants carried over verbatim
 *
 * - **Rotation is not sticky.** Every request restarts at the first enabled
 *   key. A rotation on the previous call never short-circuits this one's
 *   resolution, so a key that recovers is picked up immediately.
 * - **A missing environment variable rotates without touching the network.**
 *   It is a credential failure like any other.
 * - **Mid-stream failures never rotate.** Once bytes are flowing the provider
 *   has accepted the credential and the user may have seen partial output, so
 *   an interrupted stream falls through to the retry layer instead.
 * - **Secrets never leave the caller.** Candidates carry the *name* of an
 *   environment variable; only friendly key names, status codes and sanitized
 *   reasons reach a client or a diagnostics record.
 */
```

## src/llm/fallback.ts:62

```
/**
 * A short description of a failure, safe to surface.
 *
 * Response bodies are dropped entirely rather than truncated: a provider's
 * 4xx body can echo part of a credential, internal ids, or quota figures
 * verbatim, and a warning is exactly the wrong place for any of it. Only the
 * status survives. Provider-supplied *messages* are usually benign and are
 * kept, capped defensively.
 */
```

## src/llm/fallback.ts:91

```
// rather than left to a default so that a future classifier change is a
```

## src/llm/fallback.ts:129

```
/**
 * The user-facing sentence for one rotation.
 *
 * Tailored per failure kind so it reads naturally whatever the cause. Never
 * includes a status body, an environment value, or the key.
 */
```

## src/llm/fallback.ts:166

```
/**
 * Delay before the attempt after `attempt`: `base * 2^attempt`.
 *
 * Saturating, not wrapping. The Rust used `saturating_mul`/`saturating_pow`
 * throughout, so a pathological base or attempt count clamps at `u64::MAX`
 * instead of wrapping round to a near-zero delay and hammering the provider.
 * BigInt does the arithmetic because the clamp point is past what a double
 * represents exactly.
 */
```

## src/llm/fallback.ts:196

```
/** Injected so tests do not spend real time asleep. */
```

## src/llm/images.ts:45

```
/**
 * Resolve an inlined `image` content block into the same `ResolvedImage` the
 * `ImageRef` path produces.
 *
 * This is the shape the daemon actually sends: it synthesizes base64 `image`
 * blocks from a message's images and inlines them into the wire `content`
 * array (`encode_image_block` in `handler/images.rs`), and never populates a
 * separate `images` field. Adapters must therefore read images off `content`.
 *
 * Returns `undefined` — logging, never throwing — for an unsupported media
 * type or an oversized payload, matching `resolveImage`: a bad attachment
 * drops out of the turn rather than failing it.
 */
```

## src/llm/images.ts:107

```
// Check the on-disk size before reading so an oversized file never gets
```

## src/llm/forensics.ts:1

```
/**
 * Cache forensics — the append-only JSONL the daemon reads when a cache bill
 * looks wrong.
 *
 * This lives in the sidecar because the row that matters records **which
 * `cache_control` breakpoints were placed**, and placement is decided in the
 * Anthropic adapter. The daemon used to write this log; when placement moved
 * here it kept the writer and lost the data, so for a long stretch the log had
 * response rows whose `call_id` correlated with nothing and no request rows at
 * all. Cache questions were unanswerable from disk that whole time.
 *
 * One row per call, placement and usage together — there is no correlation id
 * because there is nothing to correlate.
 *
 * The daemon fills `context.forensics_dir` only when
 * `[advanced].cache_forensics` is on, so its absence is the off switch and this
 * module needs no configuration of its own. The labels themselves ride on the
 * same `CallContext` the ledger row is written from — they used to have their
 * own `ForensicsContext`, which was the same three fields sent only when
 * forensics happened to be enabled.
 */
```

## src/llm/forensics.ts:38

```
/** True when the incoming messages already carried `cache_control`.
   *
   * Observation only — placement runs regardless and `normalizeMessages` strips
   * them first. It is worth logging because a marker arriving here means one
   * leaked into persisted history, which is a bug upstream even though it no
   * longer breaks caching. */
```

## src/llm/forensics.ts:57

```
/**
 * Append one row. Best-effort: a forensics failure must never take down a call
 * that otherwise succeeded, so I/O errors are swallowed.
 */
```

## src/llm/forensics.ts:83

```
// Diagnostics are never worth failing a call over.
```

## src/llm/sanitize.ts:1

```
/**
 * Stripping orphaned `tool_use` / `tool_result` blocks from an outbound
 * request.
 *
 * Ported from `crates/daemon/src/llm/sanitize.rs`, pinned by
 * `tests/llm_fixtures/stream_parity.json`.
 *
 * Anthropic and the OpenAI family both hard-reject a conversation containing a
 * `tool_use` nothing answered, or a `tool_result` answering nothing, and
 * translation proxies mangle it in more interesting ways. Either can happen
 * legitimately — a turn interrupted between the call and the result, a history
 * trimmed to fit a context window — so this runs defensively on every request
 * rather than trying to prevent the states upstream.
 *
 * # Pairing is role-scoped, and that is load-bearing
 *
 * Only `tool_use` on an **assistant** message and `tool_result` on a **user**
 * message participate. A `tool_use` sitting on a user message is neither
 * collected as a known id nor considered for stripping — it is invisible to
 * both passes and passes through untouched. That is not obviously right, but it
 * is symmetric: the same role pair gates the collection and the filter, so
 * nothing can be stripped for failing to match an id that was never collected.
 * The fixture pins both directions.
 *
 * # `undefined` is an answer
 *
 * A conversation with no orphans returns `undefined`, meaning "send the
 * original". That is deliberately distinct from returning a cleaned copy that
 * happens to be identical: the healthy path is the overwhelmingly common one
 * and it allocates nothing.
 */
```

## src/llm/generate.ts:1

```
/**
 * One non-streaming provider call, with the credential rotation and the ledger
 * row around it.
 *
 * Ported from `LedgerClient::generate_with_config_fallback`,
 * `generate_with_credential_fallback` and `resolve_model_for_request` in
 * `crates/daemon/src/ledger/client.rs`.
 *
 * # The seam every background pass was waiting for
 *
 * Compaction, the deep archive and the heartbeat all reach a model without a
 * client attached, and each of them has been carrying an injected `generate`
 * with a note saying the real one "lands with `handler/`". This is it. The
 * streaming half of the same job is `handler/generation.ts`, and the two share
 * every piece that decides *which credential* — `resolveKeyCandidates`,
 * `streamWithCredentialFallback`, `streamWithRetry` — because a background pass
 * that rotated keys differently from a chat turn would be a second policy to
 * keep in step with the first.
 *
 * # `/v1/generate` is deliberately not rewired to this
 *
 * The endpoint looks like it should call this and must not while the Rust
 * daemon is the one calling it. `LedgerClient` does the rotation on that side,
 * one key per request, so routing the endpoint through here would rotate twice
 * and burn every credential on a single failure. The endpoint keeps its
 * one-call-one-key contract and dies with the hop (#18, step 5); this is for
 * callers already in this process.
 *
 * # Why a rotation is reported rather than logged
 *
 * A heartbeat folds its rotations into the ring buffer `shore log --heartbeat`
 * reads; a chat turn sends them to the client as a warning frame. Neither is
 * this module's to do, so both come back in {@link GenerateOutcome.fallbacks}
 * and the caller decides. The Rust returned the same vector for the same
 * reason.
 */
```

## src/llm/generate.ts:54

```
/**
 * A provider call was refused before it happened, by `[usage]`.
 *
 * An `Error` so the message survives the handler's `instanceof Error` check on
 * the way to the client, and an {@link LlmError} — via `kind` — so the retry
 * and rotation layers can classify it. Both layers cast what they catch, so a
 * plain `Error` reaching them classifies as `undefined`, which `shouldRotate`
 * reads as rotatable: a refused call would burn every configured key.
 */
```

## src/llm/generate.ts:86

```
/**
 * The two fields a rotation needs off a model: whose keys, and the legacy
 * single-key variable to fall back on.
 *
 * Narrower than {@link ResolvedModel} because the catalog spells it camelCase
 * and `llm/request.ts` spells the same model snake_case, and both reach here —
 * the compaction seam carries the wire-shaped one. Asking for the two fields
 * rather than a whole model lets either side pass without a conversion that
 * exists only to satisfy a signature.
 */
```

## src/llm/generate.ts:164

```
/**
 * Call the model, rotating through the provider's configured keys.
 *
 * `request.api_key` is overwritten per attempt, so the caller's request object
 * is mutated — as the Rust's `&mut LlmRequest` was. Callers hand over a body
 * they own; see `autonomy/heartbeat_request.ts` for what handing over one they
 * do not would cost.
 */
```

## src/llm/generate.ts:207

```
/**
 * Call the model, rotating keys when the catalog knows which ones to rotate.
 *
 * The outer half of the Rust's pair. A request the static catalog cannot place
 * still runs — on the single credential it was built with — rather than
 * failing, because "I do not recognise this model" is not a reason to refuse a
 * request that already carries a working key.
 */
```

## src/llm/request.ts:1

```
/**
 * Building an outbound LLM request from a resolved model profile.
 *
 * Ported from `crates/daemon/src/llm/mod.rs`, pinned by
 * `tests/llm_fixtures/request_parity.json`.
 *
 * A {@link ResolvedModel} is the end of config resolution — catalog entry,
 * provider registry, and the runtime preference overlay already merged. This
 * turns one into the request that goes to a provider: credential resolved,
 * sampler knobs mapped, provider-specific options derived, orphaned tool blocks
 * stripped.
 *
 * # Three entry points, because credential resolution differs
 *
 * - {@link buildRequestWithResolvedKey} takes the key as a string. It is the
 *   shared core, and the only one the rotation path calls — that path resolves
 *   candidates itself so it can rotate on a *missing* env var as readily as on
 *   a rejected key.
 * - {@link buildRequestWithProviderKeys} walks the provider registry's ordered
 *   key list. This is the right entry point for non-streaming callers, which
 *   otherwise silently ignore `[providers.<name>].keys`.
 * - {@link buildRequest} is the single-key path: the model's `api_key_env`, or
 *   the provider's conventional variable.
 *
 * # `off` is not an effort
 *
 * `reasoning_effort = "off"` is a sentinel, not a value. It becomes
 * `thinking_enabled: false` so the OpenRouter adapter can send
 * `reasoning: { effort: "none" }` and actually turn thinking off on an
 * always-on reasoning model, while every other adapter simply omits reasoning.
 * The comparison is case-sensitive, so `"OFF"` passes through as a literal
 * effort — pinned, because it is the kind of thing a port "helpfully" fixes.
 */
```

## src/llm/request.ts:83

```
/**
 * A built request, plus the daemon-side fields that never reach a provider.
 *
 * `keepalive_interval` is `#[serde(skip)]` in the Rust for a reason worth
 * keeping: it is a scheduling hint the autonomy manager reads back off the
 * cached `last_request`, not something a provider should ever see. Modelling it
 * outside {@link SidecarRequest} keeps it structurally impossible to serialize
 * by accident.
 */
```

## src/llm/request.ts:94

```
/** Which configured key this used, for diagnostics. Never the key itself. */
```

## src/llm/request.ts:100

```
/** A credential could not be resolved. Carries the variable name, never a value. */
```

## src/llm/request.ts:113

```
/**
 * The conventional base URL for a provider, when one is well-known.
 *
 * Absent for providers whose endpoint is deployment-specific — custom
 * OpenAI-compatible upstreams, on-prem — which must set `base_url` explicitly.
 */
```

## src/llm/request.ts:184

```
/**
 * Whether the provider's thinking-mode API rejects requests that omit
 * `reasoning_content` from prior assistant turns.
 *
 * DeepSeek V3.1+ and Moonshot's Kimi-thinking enforce this: stripping thinking
 * from history for them produces a 400 reading *"reasoning_content in the
 * thinking mode must be passed back to the API"*. This is a hint about shaping
 * prompt history, not a wire rule — the adapters own request conversion.
 */
```

## src/llm/request.ts:321

```
/**
 * Build a request, resolving the credential from a single environment variable.
 *
 * The model's `api_key_env` when set, otherwise the provider's conventional
 * variable. Callers with a provider registry available should prefer
 * {@link buildRequestWithProviderKeys}, which honours configured key lists.
 *
 * @throws {MissingApiKey} when the variable is unset.
 */
```

## src/llm/request.ts:441

```
// It stays because `exactOptionalPropertyTypes` is on: writing the key
```

## src/llm/request.ts:452

```
/**
 * Append an inline `role:"system"` turn at the tail.
 *
 * Used where an instruction has to sit at a fixed slot in the message list
 * rather than in the system prompt — compaction's, which must stay byte-stable
 * across its tool loop so chat's cache prefix keeps extending.
 */
```

## src/llm/discovery.ts:1

```
/**
 * Provider model discovery and its on-disk cache.
 *
 * Ported from `crates/daemon/src/llm/discovery.rs`, pinned by
 * `tests/llm_fixtures/discovery_parity.json`.
 *
 * OpenAI-compatible providers (OpenAI, OpenRouter, vLLM, Together, …) share one
 * fetcher; native Anthropic discovery needs its own auth and version headers.
 * Both land in the same `DiscoveredModel` shape and the same per-provider cache
 * file, so the rest of the daemon never has to know which dialect a catalog
 * came from.
 *
 * # Unknown is not false
 *
 * Every capability is a *tri-state*: `true`, `false`, or absent. A provider that
 * says nothing about tool use has not said it lacks tool use, and a UI that
 * collapses the two tells the user a model cannot do something it can. Every
 * accessor here returns `undefined` for "the provider did not say" and only
 * commits to `false` when the provider published a field that omitted the
 * capability.
 *
 * # The cache file is a cross-language contract
 *
 * Rust still reads and writes these files (`effective_catalog.rs`,
 * `commands/providers.rs`, `auto_discovery.rs`). Until those move, a cache
 * written here is read there and vice versa, so the serialized shape is pinned
 * byte-for-byte by the fixture — field order, two-space indent, no trailing
 * newline, and every absent optional omitted rather than written as `null`.
 * `undefined` values disappear under `JSON.stringify`, which is what makes the
 * omission fall out naturally; assigning `null` instead would produce a file
 * the Rust rejects.
 *
 * # Failures never destroy a good cache
 *
 * A corrupt or unreadable cache reads as *missing* rather than raising, because
 * a caller asking for cached models should not fall over on a bad file — the
 * user can refresh. Writes go to a sibling tmp file and rename in, so a
 * serialization or I/O failure leaves the previous catalog intact.
 */
```

## src/llm/discovery.ts:108

```
/**
 * Read a provider's cache, or `undefined` when it is absent, corrupt, or
 * written by a newer build.
 *
 * Only genuine I/O failures propagate. Everything about the file's *contents*
 * that could go wrong resolves to "no cache", because the caller's fallback —
 * refetch, or show nothing — is better than an exception.
 */
```

## src/llm/discovery.ts:494

```
/**
 * The largest index at or below `index` that starts a UTF-8 character.
 *
 * Continuation bytes match `0b10xxxxxx`; walking back off them lands on a lead
 * byte. Well-formed UTF-8 never runs more than three continuations, so the walk
 * is bounded without needing a guard.
 */
```

## src/llm/discovery.ts:526

```
// shown to clients verbatim. The default was never pinned before —
```

## src/llm/image_generate.ts:186

```
/**
 * Resolve image generation from the model catalog.
 *
 * Lived in `memory/compaction_impls.rs` for historical reasons only — it has
 * nothing to do with compaction, and its callers are the tool-context builders
 * in `autonomy` and `handler`. It belongs beside the thing it configures.
 *
 * Every failure is a plain sentence rather than an exception the caller must
 * classify: this is shown to whoever has to fix the config, and the only thing
 * a caller does with it is give up on image generation for the session.
 *
 * Identity is the configured default, or the sole settings-overlay key when
 * there is exactly one. Two overlay entries with no default is an error rather
 * than a pick: the choice would be `BTreeMap` order, which is not a decision
 * anyone made.
 */
```

## src/llm/retry.ts:1

```
/**
 * Whether a failed turn is worth trying again.
 *
 * Ported from `crates/daemon/src/llm/retry.rs`, pinned by
 * `tests/llm_fixtures/llm_decisions_parity.json`.
 *
 * This sits *below* credential rotation and above nothing: it decides retry or
 * give up. The one structural rule is that credential-shaped failures never
 * consume retry budget — they short-circuit to `fail` so the multi-key wrapper
 * above sees the error immediately and can rotate. Retrying the same rejected
 * key three times first would spend the budget on the one thing that provably
 * cannot work.
 *
 * # On refusals
 *
 * An earlier version of this module also carried `shouldRetryRefusal` and
 * `isRefusal` — a phrase-matching detector over the completed response, and a
 * fallback-model arm to react to it. Both were removed by #16: no production
 * caller ever set a fallback model, nothing constructed the `refusal` error,
 * and the detector's own tests were its only callers. Providers still report
 * `finish_reason` values of `content_filter` and `refusal`, and those still
 * reach the conversation and the ledger untouched; there is simply nothing that
 * acts on them, which is what was true in practice before as well.
 *
 * # On logging
 *
 * The Rust warned on five of its branches. Only one survives here: the
 * credential short-circuit, because `fail` from a function called
 * `should_retry` is the one outcome a reader would not predict from the error
 * alone. The rest restated the branch they sat in. `tracing` is filtered off
 * by default and `console.warn` is not, so keeping them would have meant one
 * line per attempt in the daemon's output for ordinary transient failures.
 */
```

## src/llm/retry.ts:52

```
/**
 * Decide what to do after a failed request.
 *
 * Order matters: the credential check runs before the attempt ceiling, so
 * rotation is never delayed by retry budget.
 */
```

## src/llm/stream.ts:24

```
/**
 * Where a thinking block's replay payload rides.
 *
 * The Rust folds all three into one prefixed string (`orrd:…`, `zair:…`, or a
 * bare signature) because stored history has a single slot for them, and
 * projects that back out at send time. This side has no such slot: `ContentBlock`
 * is the one type both halves use and it names all three fields, so the carrier
 * arrives at the field its provider actually reads and stays there. Nothing here
 * ever writes a prefix — see `pushAssistantTurn` in `llm/request.ts`, which is
 * the projection the Rust needs and this side does not.
 */
```

## src/llm/stream.ts:75

```
/**
 * Where relayed frames go. The Rust holds an `mpsc::Sender<ServerMessage>` and
 * drops the send result on the floor (`let _ignored = …`) — a session that has
 * gone away must not fail the generation that was streaming to it. This is the
 * same contract: `send` may do nothing, and must not throw.
 */
```

## src/llm/stream.ts:126

```
/**
   * Fold one event in. Returns the terminal {@link StreamResult} when `done`
   * arrives, `undefined` otherwise.
   *
   * A mid-stream `error` event is returned as an `LlmError` rather than thrown,
   * so the caller decides — the Rust's `?` fails the call while still handing
   * the already-billed usage to the ledger, and a thrown value would lose that
   * distinction against a genuine bug in this function.
   */
```

## src/llm/stream.ts:177

```
// two must replay the later one, not a chimera of both.
```

## src/llm/stream.ts:215

```
// blocks, because this accumulator has seen every turn of that loop in
```

## src/llm/stream.ts:322

```
/**
 * Emit a `stream_end` frame describing a completed stream.
 *
 * Call this after the message is durable — after persistence for the final
 * phase, or immediately for the intermediate `tool_use` boundaries that drive a
 * tool loop.
 *
 * `isFinal` distinguishes the terminal frame from those intermediate ones.
 * Aggregating clients use it to decide whether to keep reading, so a tool
 * loop's boundaries must set it false or the client stops at the first one.
 */
```

## src/llm/stream.ts:361

```
// revision must be an absent *key* — writing `0` would claim the message
```

## src/llm/capabilities.ts:233

```
/** Whether the model's wire rejects sampler knobs (`temperature` / `top_p`),
 *  from the Claude >=4.7 cutoff OR a per-model override. Mirrors Rust
 *  `rejects_sampling`. No adapter calls this — requests arrive with samplers
 *  already stripped, because {@link applicability} strips them during catalog
 *  resolution, which is the caller. */
```

## src/llm/capabilities.ts:291

```
/** A TOML key as a {@link Field}, or `undefined` for keys the matrix has no
 *  opinion about (Shore-only behaviors like `max_tool_iterations`, or transport
 *  like `sdk`) — which callers treat as "always applicable". */
```

## src/llm/capabilities.ts:410

```
/**
 * Whether the `reasoning_effort = "off"` sentinel is HONORED for this sdk —
 * i.e. some adapter actually suppresses reasoning when it sees it.
 *
 * - `anthropic` — omitting the thinking params yields a non-thinking request.
 * - `deepseek` / `moonshot` / `zai` — `thinking.type = "disabled"`.
 * - `openrouter` — `reasoning.effort = "none"`, a real off-switch for the
 *   always-on vendors it fronts. A few thinking-only endpoints reject it at
 *   runtime; a documented limitation.
 *
 * `openai` and `gemini` have no disable path — reasoning is model-mandatory or
 * left at the model default — so `"off"` there would be a silent no-op.
 * {@link validate} uses this to reject it at the boundary instead, which the
 * plain domain check cannot do: `"off"` is absent from the graded domains, so
 * without this it would be rejected everywhere including the sdks that honor it.
 */
```

## src/llm/capabilities.ts:438

```
/**
 * Reject a setting the model's resolved sdk cannot honor, before it reaches the
 * preferences file and later the wire.
 *
 * `probe` is the caller's value **already collapsed**: the string itself when
 * the domain matters, or `true` standing in for "some non-string value". That
 * collapse belongs to the caller (Rust built a `toml::Value` for the same
 * reason), and it has one visible consequence the fixture pins — a non-string
 * `cache_keepalive` is reported as being the value `"true"`, because the message
 * prints the probe rather than what the user typed.
 *
 * A field the sdk ignores or rejects is inapplicable: you cannot usefully set
 * something that will be dropped. Only `reasoning_effort` and `cache_keepalive`
 * have a value domain; every other honored field accepts any well-typed value.
 */
```

## src/llm/errors.ts:1

```
/**
 * The failure shapes the retry and credential-rotation layers branch on.
 *
 * Ported from `LlmError` in `crates/daemon/src/llm/mod.rs`. That enum is a
 * `thiserror` type wrapping a `reqwest::Error`, so it has no serde
 * representation; here it is a discriminated union, which is what the two
 * classifiers actually needed from it.
 *
 * `transport` covers the Rust's `LlmError::Request` — a network or connection
 * failure below the HTTP status. It is a separate variant rather than folded
 * into `incomplete_stream` because the two mean different things to a reader
 * even though both classifiers happen to treat them alike today.
 */
```

## src/llm/errors.ts:18

```
/** `LlmError::Request` — the request never produced a status. */
```

## src/llm/errors.ts:36

```
/**
   * `[usage]` refused the call before it was placed — see `ledger/gate.ts`.
   *
   * The Rust had no variant for this: the gate lived on the far side of an HTTP
   * hop, so a refusal arrived as a 402 that `check_sidecar_response` flattened
   * into `Provider`. That flattening cost two things now worth having back.
   * Rotation was the accident it *didn't* cost — `Provider` classifies as
   * `not_credential_failure`, so keys were safe — but retry was: `provider`
   * retries, so the daemon re-POSTed a deterministic policy refusal until the
   * attempt ceiling. Remote, that was a wasted round-trip. Local, it is a
   * backoff sleep the user waits through for an answer that cannot change.
   */
```

## src/llm/errors.ts:70

```
/**
 * The text to report for anything caught on a path that can raise an
 * {@link LlmError}.
 *
 * `LlmError` is a plain discriminated union rather than an `Error` subclass —
 * that is what the Rust enum ported to, and `throw`ing one is how the retry and
 * rotation layers signal upward. The consequence is that the usual
 * `e instanceof Error ? e.message : String(e)` produces the literal string
 * `[object Object]` for every one of them: a daemon with no API key configured
 * reported exactly that to the client, naming neither the provider nor the
 * variable it wanted. This is the extractor those call sites need instead.
 */
```

## src/llm/replay.ts:46

```
/**
 * Provider keys that need prior `reasoning_content` replayed regardless of the
 * user's `replay_prior_thinking`. A floor, not a preference.
 *
 * Only Moonshot is on it. Kimi K2.5+/K3 are trained in preserved-thinking-history
 * mode and degrade erratically without the replay — observed as coin-flip
 * think/no-think on byte-identical requests (657f3590).
 *
 * DeepSeek used to be here, on the claim that V3.1+ rejects a request omitting
 * prior `reasoning_content`. Measured against the live API on 2026-08-08, that
 * is false, and so is the opposite claim this repo carried in `openai.ts` (that
 * DeepSeek rejects the field on the way in). It does neither: both shapes
 * return 200, and a ~600-token `reasoning_content` on a prior assistant turn
 * moves `prompt_tokens` by exactly zero. DeepSeek accepts the field, discards
 * it server-side, and bills nothing for it — so replaying to DeepSeek is inert
 * rather than required.
 */
```

## src/llm/replay.ts:101

```
// provenance-free history would otherwise sail straight onto the Anthropic wire.
```

## src/llm/replay.ts:118

```
// predate provenance tracking don't break.
```

## src/llm/replay.ts:130

```
/**
 * Project the daemon's stored conversation onto what this provider accepts.
 *
 * A turn whose blocks all drop out is removed rather than sent empty — every
 * provider rejects an empty content array, and one such turn fails the whole
 * request.
 *
 * The `none` replay mode applies to *completed prior turns*. Thinking inside a
 * still-running tool loop is appended onto the live request by the daemon and
 * arrives here as ordinary history, so it is stripped along with the rest —
 * which is correct, because the request that carried it unstripped is the one
 * that was already sent, and this one is a new request built from the same
 * history. Both modes are prompt-cache-safe for the same reason: a given
 * history always projects to the same bytes.
 */
```

## src/llm/embed.ts:22

```
/**
 * A source of vectors.
 *
 * `modelId` identifies the model that produced a vector; index entries store
 * it so a model swap invalidates cached vectors rather than silently mixing
 * two vector spaces.
 *
 * The Rust was a `dyn`-compatible trait held as `Arc<dyn Embedder>`; an
 * interface needs no equivalent ceremony. `model_id()` and `dimensions()`
 * were methods only because a trait cannot declare fields.
 */
```

## src/llm/embed.ts:98

```
/**
 * Read the vectors out of an embeddings response.
 *
 * Every failure is a `provider` error naming the item that went wrong, because
 * a truncated or reshaped response is far more common than a transport fault
 * and "embedding failed" alone is not enough to act on.
 *
 * @throws {LlmError}
 */
```

## src/llm/providers/anthropic_loop.ts:1

```
/**
 * The Anthropic tool loop, driven here rather than in the daemon.
 *
 * Uses the SDK's `toolRunner`, which is the reason this move is worth doing:
 * the request → execute → continue cycle, the iteration cap, and cancellation
 * all come from the SDK instead of being reimplemented. Tools run in this
 * process, through the {@link ToolPhase} the caller supplies — see
 * `tools/execute.ts`.
 *
 * # Breakpoints have to be re-placed every turn
 *
 * The cache schedule anchors partly on the *last* message, so as a loop appends
 * assistant turns and tool results the breakpoints must move with them.
 * Leaving them where the first request put them means every continuation
 * re-sends the loop's whole accumulated tail uncached — and since the daemon
 * previously rebuilt each continuation from scratch, that would be a
 * regression, not a limitation carried over.
 *
 * # Why the loop is written this way
 *
 * `setMessagesParams` sets a private "the caller has taken over messages" flag,
 * and the runner then changes behaviour in two ways that are invisible from its
 * public types (read out of `BetaToolRunner`'s implementation, 0.100.1):
 *
 *   1. It stops appending the assistant turn itself. So a driver that calls
 *      `setMessagesParams` **must** append that turn, or the conversation
 *      silently loses every model reply.
 *   2. It no longer stops when the model asks for no tools — it issues one more
 *      full-price request first. So the terminal turn is detected here and the
 *      iteration broken out of, rather than left to the runner.
 *
 * Both are pinned by tests below. They rest on a private field of a beta API,
 * so an SDK upgrade should re-check them: the failure mode for (1) is dropped
 * turns and for (2) a wasted call per turn, and neither is loud.
 */
```

## src/llm/providers/anthropic_loop.ts:120

```
// collected here and recorded in the order the model asked for them, because
```

## src/llm/providers/anthropic_loop.ts:121

```
// completion order must not decide what gets stored.
```

## src/llm/providers/anthropic_loop.ts:281

```
// in one flat stream and cannot tell where one ended, so it would otherwise
```

## src/llm/providers/openai.ts:1

```
/**
 * OpenAI-compatible adapter (the sidecar contract shape).
 *
 * Fronts OpenAI and every OpenAI-compatible gateway — DeepSeek, Kimi (Moonshot),
 * xAI, NanoGPT, etc. — which differ only by `base_url`. It consumes a
 * `SidecarRequest` (canonical Anthropic-shape blocks, as the Rust daemon
 * assembled them) and emits the `StreamEvent` NDJSON vocabulary the daemon's
 * `StreamConsumer` parses.
 *
 * No client-side cache markers: OpenAI-compatible backends cache server-side.
 *
 * **Thinking replay is decided upstream, transmitted faithfully here.** The
 * `replay_prior_thinking` projection in `llm/replay.ts` controls which assistant
 * turns still carry thinking blocks by the time a request reaches this adapter;
 * whatever survives is emitted as `reasoning_content` on the corresponding
 * assistant message. Kimi K2.5+/K3 are trained in preserved-thinking-history
 * mode and degrade erratically without it.
 *
 * This comment used to claim DeepSeek rejects inbound `reasoning_content` and
 * that `replay_prior_thinking = "none"` was the fix. Measured against the live
 * API on 2026-08-08, it doesn't: the request succeeds and the field costs zero
 * prompt tokens, so DeepSeek is accepting and discarding it. `none` remains the
 * escape hatch for a backend that *does* reject the field — that failure mode
 * is real on some OpenAI-compatible gateways — but it surfaces as an API error,
 * never a silent drop here.
 *
 * The retired Rust adapter's deepseek/kimi tool-loop bug was replaying reasoning
 * in the WRONG SHAPE unconditionally; the conversion regression test now pins
 * the faithful mapping in both directions (thinking block ⇄ `reasoning_content`,
 * absent ⇄ absent).
 */
```

## src/llm/providers/openai.ts:271

```
/**
 * Convert one canonical turn into OpenAI chat-completion message(s). Exported
 * for the conversion regression test: assistant thinking blocks map to
 * `reasoning_content` exactly when present (the daemon's replay setting
 * already decided what survives — see the module docs), the bare `reasoning`
 * field is never emitted, and tool-call-only assistant turns must omit
 * `content` (not emit `null`).
 */
```

## src/llm/providers/openai.ts:324

```
// content blocks instead and never populates it. Honored first so anything
```

## src/llm/providers/vercel.ts:1

```
/**
 * Vercel AI SDK adapter — the path for DIRECT (non-OpenRouter) DeepSeek and
 * Moonshot (Kimi) access (issue #164). Both are OpenAI-compatible wires, but
 * their reasoning controls are vendor-specific; the first-party Vercel providers
 * (`@ai-sdk/deepseek`, `@ai-sdk/moonshotai`) model them as typed `providerOptions`
 * and handle `reasoning_content` round-tripping (the area that caused the old
 * Rust deepseek/kimi tool-loop bug), so we don't hand-code each vendor's quirks.
 *
 * One adapter serves both: the AI SDK exposes a unified `LanguageModel` /
 * `streamText` interface, so only the provider factory differs by `req.sdk`.
 *
 * Reasoning controls (from `provider_options`, set by the Rust daemon):
 *   - `thinking_enabled === false` (from `reasoning_effort = "off"`) → thinking
 *     `{ type: "disabled" }` — a real off-switch for always-on reasoning models.
 *   - DeepSeek `reasoning_effort` → `reasoningEffort` (low|medium|high|xhigh|max).
 *   - Moonshot `budget_tokens` → `thinking.budgetTokens`.
 *
 * Prior-turn reasoning is replayed as an assistant `reasoning` content part
 * (DeepSeek/Kimi hard-require it during a tool loop); there is no opaque
 * signature carrier as on the OpenRouter path — the text round-trips directly.
 */
```

## src/llm/providers/vercel.ts:283

```
// The originating tool_use must be in this request's history (orphan
```

## src/llm/providers/vercel.ts:304

```
// content blocks instead and never populates it. Honored first so anything
```

## src/llm/providers/anthropic_tools.ts:1

```
/**
 * Shore's tool surface, in the shape Anthropic's `toolRunner` executes.
 *
 * The Anthropic SDK owns the request → execute → continue cycle for that
 * dialect, and the price of that is handing it callables rather than being
 * asked for a list of tool calls. This is the adapter: one `BetaRunnableTool`
 * per definition, each of which runs the tool through the {@link ToolPhase} and
 * reports back in the SDK's vocabulary.
 *
 * Split out of `tool_rpc.ts`'s `daemonTools`, which did the same job over a
 * Unix socket. What changed is the middle — the call is a function call now —
 * and one thing that fell out with it: `daemonTools` needed an `onUnreachable`
 * callback that aborted the runner, because a tool that could not be *attempted*
 * had to end the turn without telling the model, and the runner formats
 * everything a tool throws as tool-result content. In one process there is no
 * such failure. `runTool` always answers.
 */
```

## src/llm/providers/anthropic_tools.ts:27

```
/**
 * Wrap each definition as a runnable tool.
 *
 * `record` is called as each result lands so the caller can assemble a round's
 * `tool_result` blocks in the order the model asked for them. The runner runs a
 * round's tools concurrently, so completion order is a race and must not decide
 * what gets stored.
 */
```

## src/llm/providers/anthropic_tools.ts:46

```
// rather than `never` keeps the derived argument type permissive — with
```

## src/llm/providers/anthropic_tools.ts:47

```
// `never`, the resulting tool will not widen to the runner's tool list.
```

## src/llm/providers/anthropic.ts:1

```
/**
 * Anthropic SDK adapter (sidecar contract shape).
 *
 * Consumes a `SidecarRequest` and emits the `StreamEvent` NDJSON vocabulary.
 * Owns the Anthropic wire behavior for the daemon's canonical request shape.
 * The pieces the SDK doesn't do natively (and we therefore keep):
 *
 *   1. cache_control breakpoint placement — default schedule only (last stable
 *      system block + last-stable-assistant + last message). The
 *      `cache_depth_turns`/`cache_pinned_position`
 *      override + env vars are intentionally NOT ported (advanced tuning,
 *      unused in practice; default placement is the parity baseline).
 *   2. per-model thinking-mode selection (`thinking_caps`) — adaptive vs
 *      enabled+budget; wrong mode is a hard 400.
 *   3. inline `role:"system"` → `<system_instruction>` user wrap (the API
 *      rejects role:system in messages[]). Always-wrap today, behind a
 *      `systemMessageStrategy` seam; opus-4.8 native system messages are a
 *      tracked post-parity follow-up.
 *   4. trivial plumbing: pass `provider_options.openrouter_provider` into
 *      `body.provider`, strip a trailing `/v1` from base_url.
 *
 * The SDK handles everything else: SSE, thinking/signature verbatim round-trip,
 * tool_use accumulation, retries, errors. Cache-forensics stays Rust-side.
 */
```

## src/llm/providers/anthropic.ts:138

```
/**
 * Map one turn's raw events to Shore events, without the surrounding `start`
 * and `done`.
 *
 * Split out because a tool loop emits many turns inside a single Shore stream:
 * one `start` at the front, one `done` at the end, and this in between for each
 * model call. Errors propagate — a caller that wants the partial usage should
 * catch and use `acc.usage`, which already holds the cache write the provider
 * reports before any output.
 */
```

## src/llm/providers/anthropic.ts:274

```
/**
 * Pure request-body builder that also reports what it decided about caching.
 *
 * Placement is computed exactly once and both returned views come from it —
 * a second implementation for reporting would be free to drift from the one
 * that actually runs, which is the whole reason the forensic log matters.
 */
```

## src/llm/providers/anthropic.ts:292

```
// never merely a no-op: `toContentBlockParam` rebuilds every block field by
```

## src/llm/providers/anthropic.ts:387

```
// The load-bearing rule is that **a message anchor must sit in the frozen
```

## src/llm/providers/anthropic.ts:423

```
/** Strip pre-existing cache_control and convert string content → block arrays
 * so the breakpoint can always land on a block. Mirrors the message half of
 * `normalize_for_caching`. */
```

## src/llm/providers/anthropic.ts:454

```
/** Index at which the most-recent assistant turn begins — the first message of
 * the trailing assistant run, walking back over assistant messages and the
 * tool-result-only user messages between them and stopping at the first genuine
 * user turn. Returns `messages.length` when there is no assistant message.
 *
 * Exported for its test, which pins it against
 * `crates/daemon/tests/fixtures/turn_boundary_parity.json`. That fixture was
 * shared with a Rust implementation while `replay_prior_thinking = last_turn`
 * needed the same boundary daemon-side; the mode is gone and this is now the
 * only implementation, but the cases still pin the walk-back rules.
 *
 * Note this runs *after* `convertInlineSystemMessages`: merging a trailing
 * `role:"system"` turn into a preceding user message both removes a message and
 * can turn a tool-result-only user into a "genuine" one (it gains a text
 * block). That only ever ends a turn earlier or shortens the array, so the
 * boundary stays conservative. Do not move this call before the conversion: the
 * breakpoint must be placed on the messages that actually go on the wire. */
```

## src/llm/providers/anthropic.ts:493

```
/** `[prev_frozen_boundary, frozen_boundary, last_msg]`, deduped, sorted.
 *
 * `frozen_boundary` is the message just before the trailing assistant turn.
 * `replay_prior_thinking` strips thinking from assistant turns *before* that
 * boundary, and the boundary only ever moves forward as turns are appended, so
 * `[0, boundary)` is byte-stable for the life of the conversation under every
 * replay mode. An anchor there survives the strip.
 *
 * Anchoring on the trailing turn itself (the old `last_stable_assistant`) does
 * not: under `last_turn` that turn loses its thinking blocks as soon as another
 * turn lands, rewriting the very bytes the anchor covers. Both message anchors
 * then miss and the read collapses to the system prefix alone — a full re-cache
 * of the whole conversation on every committed turn.
 *
 * `prev_frozen_boundary` is the same boundary one turn back — the genuine-user
 * boundary of the turn *before* the trailing one. Under the normal turn cadence
 * it is exactly the previous request's `frozen_boundary`, so it is redundant.
 * It earns its slot on the request right after a multi-round tool loop: while
 * the loop runs, `frozen_boundary` is pinned at the loop start, and when the
 * loop ends and a new assistant turn lands the boundary jumps *past the whole
 * loop* in one step — stripping every round's thinking at once. The new
 * `frozen_boundary` sits after that rewritten region and misses; the still-
 * stable prefix (before the loop) is only readable because this second anchor
 * is sitting on it. Compaction and dreaming loops run well past Anthropic's
 * ~20-block automatic lookback, so without it those reads collapse to the
 * system prefix. Three message anchors plus the one system anchor is exactly
 * the four-breakpoint provider limit. */
```

## src/llm/providers/anthropic.ts:561

```
// prevent: `messages[frozenIdx]` is always a genuine user message, and the
```

## src/llm/providers/anthropic.ts:586

```
/**
 * Re-place the cache breakpoints over a conversation that has grown.
 *
 * The schedule anchors partly on the *last* message, so inside a tool loop the
 * breakpoints have to move as assistant turns and tool results are appended.
 * Leaving them where the first request put them means every continuation
 * re-sends the loop's accumulated tail uncached.
 *
 * Existing markers are stripped first: the schedule places up to four, which is
 * also the per-request maximum, so re-placing without stripping would overflow
 * it within two turns. Both arrays are mutated in place — the caller owns them.
 *
 * A no-op when caching is off, which keeps a cache-disabled loop byte-identical
 * to one that never went through here.
 */
```

## src/llm/providers/anthropic.ts:643

```
/** Today: always "wrap" (parity with current Rust). The seam lets opus-4.8
 * native mid-conv system messages slot in later without restructuring. */
```

## src/llm/providers/anthropic.ts:713

```
// there, which is exactly what that path produces.
```

## src/llm/providers/anthropic.ts:798

```
// `thinking_enabled: false`, which never reaches an Anthropic-family model
```

## src/llm/providers/generic_loop.ts:1

```
/**
 * The tool loop for every dialect that is not Anthropic.
 *
 * The Anthropic loop is built on that SDK's `toolRunner`, which has no
 * equivalent elsewhere — so the daemon kept driving the loop for the other five
 * adapters, and `handler/generation.rs`'s `can_delegate_tool_loop` said
 * `sdk == Anthropic` for exactly that reason. This is the equivalent, written
 * once against the `SidecarProvider` interface all six already implement.
 *
 * That interface is the reason this is one file rather than five. Every adapter
 * already yields Shore `StreamEvent`s and ends with a `done` carrying a finish
 * reason — which is all a loop needs to know. Nothing here is aware of which
 * provider it is driving.
 *
 * # Where the control flow lives
 *
 * `engine/tool_loop.ts`, ported from the Rust and pinned by
 * `tests/engine_fixtures/tool_loop_parity.json`. Deliberately NOT the AI SDK's
 * `stopWhen: stepCountIs(n)`, which counts steps where the daemon counted
 * dispatch rounds and which never spends the closing call that lets a capped
 * loop answer with its last tool results in hand. See that fixture's header.
 *
 * # What the caller sees
 *
 * One flat `start` … `done`, regardless of how many model calls happened, with
 * usage summed across all of them and `content_blocks` carrying only the
 * terminal turn. Each individual call is announced as it lands via
 * `call_complete`, so its ledger row exists whether or not the loop ever
 * reaches `done`. This matches `anthropic_loop.ts` exactly.
 *
 * # Tools are function calls
 *
 * They used to be one Unix-socket round trip each, because the executors lived
 * in the daemon and the loop lived here. Both are this process now, so the loop
 * is handed a {@link ToolPhase} and calls it — and the failure taxonomy
 * collapses with the transport. There is no longer a "the daemon could not
 * attempt this" that has to end the turn without telling the model, because
 * there is no attempt that can fail to arrive.
 */
```

## src/llm/providers/generic_loop.ts:322

```
// that asked for the tool, so that turn has to be in the list by the time
```

## src/llm/providers/generic_loop.ts:323

```
// the tool dispatches. The previous round's results go first because they
```

## src/llm/providers/generic_loop.ts:324

```
// came first, not because anything downstream sorts them.
```

## src/llm/providers/generic_loop.ts:329

```
// order, so completion order never decides what gets stored. The Anthropic
```

## src/llm/providers/generic_loop.ts:330

```
// path needs a record-as-they-land callback for this because the SDK owns
```

## src/llm/providers/generic_loop.ts:427

```
// one flat stream and cannot tell where one ended, so it would otherwise
```

## src/llm/providers/openrouter.ts:1

```
/**
 * OpenRouter adapter (the sidecar contract shape) — the single path for every
 * NON-Anthropic provider.
 *
 * Built on OpenRouter's first-party `@openrouter/sdk` client. It replaces the
 * hand-cast `openai`-SDK adapter (`openai.ts`) and the Z.ai adapter (`zai.ts`):
 * DeepSeek, Kimi (Moonshot), GLM (Z.ai), MiniMax, GPT, xAI, etc. all reach
 * OpenRouter, which normalizes each vendor's bespoke reasoning shape
 * (`reasoning_content` / `reasoning_details` / `thinking.keep` / `clear_thinking`)
 * into ONE typed `reasoningDetails` array. So there is no per-provider reasoning
 * matrix here — we round-trip one opaque structure.
 *
 * The SDK is stateless (single call). The Rust daemon still owns the tool loop,
 * conversation state, prompt assembly, and memory — this is purely the wire.
 *
 * Reasoning handling:
 * - Inbound reasoning is SURFACED as `thinking` events (display/persistence).
 * - `reasoning_details` round-trips OPAQUELY: the response's `reasoningDetails`
 *   goes back to the daemon as its own `reasoning_details` event, rides the
 *   thinking block's `reasoning_details` field, and is replayed verbatim on the
 *   next turn. We NEVER reconstruct reasoning from
 *   thinking text — that wrong-shape reconstruction was the Rust deepseek/kimi
 *   400/hang bug. Preserving reasoning is a proven non-critical continuity win
 *   via OpenRouter (it does not crash-gate tool loops), so when the daemon does
 *   not yet carry the blob, replay is a safe no-op.
 */
```

## src/llm/providers/openrouter.ts:136

```
// Emit the accumulated reasoning_details exactly once, while the thinking
```

## src/llm/providers/openrouter.ts:233

```
// reasoning OFF even for always-on reasoning models (GLM/Kimi/DeepSeek), where
```

## src/llm/providers/openrouter.ts:250

```
// it through verbatim, never inferred from base_url.
```

## src/llm/providers/openrouter.ts:281

```
/**
 * One canonical turn → OpenRouter chat message(s). Assistant turns replay prior
 * `reasoning_details` (decoded from the thinking block's opaque signature
 * carrier) so OpenRouter can preserve cross-turn reasoning continuity. We never
 * send thinking TEXT back as a reasoning field — only the structured opaque
 * blob, when present.
 */
```

## src/llm/providers/openrouter.ts:339

```
// content blocks instead and never populates it. Honored first so anything
```

## src/llm/providers/openrouter.ts:384

```
// cache-miss tokens in `input_tokens` (otherwise they bill twice). Note the
```

## src/llm/providers/openrouter.ts:386

```
// the token columns must still be disjoint.
```

## src/llm/providers/gemini.ts:286

```
// resent exactly as received; the model needs them to continue its own
```

## src/llm/providers/gemini.ts:298

```
// Never minted by this adapter, and a foreign one is dropped upstream
```

## src/llm/providers/gemini.ts:370

```
// `reasoning_effort` is always a string on the wire (Rust `Option<String>`);
```

## src/llm/providers/gemini.ts:451

```
// the cache-miss tokens in `input_tokens` (otherwise they bill twice).
```

## src/llm/providers/zai.ts:1

```
/**
 * Z.ai adapter (sidecar contract shape).
 *
 * Z.ai speaks OpenAI chat completions for messages/tools, but has provider
 * specific base URLs and thinking controls. Keep it separate from the generic
 * OpenAI adapter so the Z.ai-only body fields and finish reasons stay explicit.
 *
 * Reasoning handling (Preserved Thinking, `clear_thinking: false`):
 * - Inbound `reasoning_content` is surfaced as `thinking` events AND stashed
 *   verbatim on the thinking block's own `reasoning_content` field, so it
 *   round-trips byte-exact even if the display text is later normalized.
 * - On the next turn, when Preserved Thinking is on, assistant turns replay that
 *   field as outbound `reasoning_content`. Z.ai's documented contract requires
 *   the complete, unmodified prior reasoning_content be fed back, so we replay
 *   ONLY from that field — never from display text, and never from another
 *   provider's carrier, which now cannot be mistaken for ours because it
 *   arrives under a different name. Cross-provider replay is additionally gated
 *   daemon-side by `provider_key`.
 * - When `clear_thinking` is true/omitted (Z.ai default, stateless), we never
 *   replay; the model re-thinks fresh each turn.
 */
```

## src/llm/providers/zai.ts:99

```
// Otherwise thinking is on, and the `clear_thinking` flag (nested here, NOT a
```

## src/llm/providers/zai.ts:102

```
// we omit it under `disabled` and otherwise let Z.ai's default (true) apply.
```

## src/llm/providers/zai.ts:135

```
// explicitly set `clear_thinking: false`; otherwise Z.ai's default (true)
```

## src/llm/providers/zai.ts:200

```
// Emit the verbatim reasoning carrier exactly once, while the thinking block is
```

## src/llm/providers/zai.ts:202

```
// thinking so an orphan carrier is never emitted.
```

## src/llm/providers/table.ts:1

```
/**
 * The adapter table: one entry per dialect, chosen by the request's `sdk`.
 *
 * `openrouter` is the normalized path for non-Anthropic providers (DeepSeek,
 * Kimi, GLM, MiniMax, GPT via OpenRouter). `openai`/`zai` are kept for DIRECT
 * vendor access — native OpenAI, and Z.ai's coding-subscription base URLs —
 * which OpenRouter can't serve. `deepseek`/`moonshot` are DIRECT native access
 * via the Vercel AI SDK providers (#164), which expose vendor reasoning
 * controls (thinking on/off + effort/budget). Anthropic and Gemini keep their
 * native SDKs.
 *
 * Lived in `server.ts` until that file's `/v1/*` endpoints were deleted with
 * the process boundary. It is the one thing in there the daemon still needed,
 * and it never belonged to the HTTP server: `run.ts` passes it to
 * `createRuntime`, which is the only caller.
 */
```

## src/protocol/ServerHello.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ToolCall.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/StreamMetadata.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/MessageOverrides.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ProviderFallbackWarning.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ProviderFallbackWarning.ts:3

```
/**
 * The daemon rotated from one configured provider key to another mid-request
 * because the previous key reported a credential-scoped failure (missing,
 * invalid, exhausted quota or budget, account-scoped rate limit).
 *
 * Emitted only when the previous key had `warn_on_fallback = true`. The
 * payload intentionally never carries the env var value or the API key
 * itself — only the provider key, the friendly key names, the failure
 * classification, and a sanitized human-readable reason.
 */
```

## src/protocol/ProviderFallbackWarning.ts:36

```
/**
 * Sanitized human-readable summary. Never contains secrets.
 */
```

## src/protocol/CacheWarning.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/Role.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/CommandOutput.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/Ping.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/CharacterAvatar.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/MessageOrigin.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/MessageOrigin.ts:3

```
/**
 * How a message entered the conversation.
 *
 * Persisted on [`Message`] (and echoed on `NewMessage` pushes) so that
 * history consumers can distinguish autonomous (heartbeat-initiated)
 * assistant messages from replies. `None` on a stored message means the
 * origin was not recorded (messages persisted before origin tracking, or
 * ordinary user/assistant turns where the role already implies it).
 */
```

## src/protocol/ClientMessage.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/Cancel.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ImageRef.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/Regen.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/StreamStart.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/StreamEnd.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/StreamEnd.ts:4

```
/**
 * Done streaming.
 *
 * A single `send`/`regen` can emit multiple `StreamEnd` frames when the
 * daemon is running a tool loop: one per LLM turn, so clients can render
 * tool calls as they happen. Only the frame with `is_final = true` marks
 * the end of the whole generation — clients that want the final aggregated
 * result (e.g. `collect_stream`) must keep reading until they see it.
 * Older servers that predate the field will serialize nothing; `serde`'s
 * default treats missing as `true`, preserving pre-tool-loop semantics.
 */
```

## src/protocol/StreamEnd.ts:38

```
/**
 * Sub-agent name when this boundary is from a nested `ask_<name>` loop; see
 * [`StreamStart::subagent`]. A sub-agent never emits a terminal
 * (`is_final = true`) frame, so a tagged StreamEnd never ends the primary
 * generation.
 */
```

## src/protocol/Shutdown.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ServerMessage.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/StreamChunk.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ErrorCode.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ImageUpload.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/Message.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ContentBlock.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/CharacterInfo.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/UsageWarning.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/UsageWarning.ts:49

```
/**
 * `"pace"` when the warning is about a budget's pace allowance rather than
 * its period cap; absent for the cap itself. The cost, period, and window
 * fields always describe whichever limit tripped, so a client that ignores
 * this still renders correct numbers — it just can't tell the two apart.
 */
```

## src/protocol/Command.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/Phase.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/SendImage.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/Error.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/MessageAlternative.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/MessageAlternative.ts:25

```
/**
 * Model id that minted this alternative's content. Like
 * [`MessageAlternative::provider_key`], each alternative carries its own
 * provenance because regenerated bodies can come from different models.
 * `None` for alternatives persisted before model provenance tracking, in
 * which case callers fall back to [`Message::model`].
 */
```

## src/protocol/NewMessage.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/NewMessage.ts:8

```
/**
 * Conversation message appended by the daemon.
 *
 * The frame's `origin` lives on the flattened [`Message`] (`message.origin`).
 * Because `message` is flattened, the wire shape is byte-identical to the
 * envelope-level `origin` field this struct carried historically — only the
 * Rust-side field moved.
 */
```

## src/protocol/History.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/TimingInfo.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ClientHello.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ClientHello.ts:11

```
/**
 * The shared secret, from `SHORE_TOKEN` or `<config_dir>/token`.
 *
 * `Option` on the wire and required in practice: the daemon rejects a
 * hello without one. It is optional here so that a client too old to send
 * it is refused by the *authentication* check with a message saying so,
 * rather than by the deserializer with a parse error that explains
 * nothing.
 */
```

## src/protocol/TokenCounts.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ClientMessageBody.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/protocol/ToolResult.ts:1

```
// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
```

## src/swp/server.ts:1

```
/**
 * The SWP server: accept TCP connections, hand each one to
 * {@link handleConnection}, and fan broadcast events out to all of them.
 *
 * Ported from the `Server` half of `crates/daemon/src/swp_server/mod.rs`,
 * pinned by `tests/swp_fixtures/swp_parity.json`.
 *
 * # The order everything else is built in
 *
 * This is the first thing built and the last thing started, and both ends of
 * that are forced:
 *
 * - **First**, because the character registry is constructed with this server's
 *   broadcast as its history listener, and the autonomy executor pushes
 *   delivered messages through the same channel.
 * - **Last**, because a connection that hand-shakes before `MessageHandler` is
 *   draining {@link Server.routes} queues its messages in {@link RouteQueue}
 *   and is never answered. `bind` and `serve` are separate for this: binding
 *   resolves a port-zero address without accepting anything.
 *
 * Between the two, {@link Server.setHandshakeProvider} closes the cycle — the
 * provider needs the registry that needed this server's broadcast. The Rust
 * has `set_handshake_provider` for exactly the same reason.
 */
```

## src/swp/server.ts:43

```
/**
   * Whether a client's hello carries the right token.
   *
   * Required, and deliberately not optional with a permissive default: a
   * `ServerConfig` that forgot to supply one would be an open daemon, and that
   * is exactly the failure this exists to make impossible. Tests that do not
   * care pass `() => true` and say so.
   */
```

## src/swp/server.ts:55

```
/**
 * An unbounded queue of routed messages.
 *
 * The Rust bounds this at 256 and lets `route_tx.send` apply backpressure to
 * the connection task. That backpressure never did anything useful: the
 * consumer processes commands inline and spawns generation onto its own task,
 * so the queue only grows if the daemon has already stopped making progress.
 * Left unbounded rather than reproducing a limit whose only effect would be to
 * stall a reader that cannot help.
 */
```

## src/swp/server.ts:224

```
// A write to a socket whose peer has gone must **settle**, not hang.
```

## src/swp/server.ts:225

```
// Bun does not always call the write callback for a socket that is
```

## src/swp/framing.ts:1

```
/**
 * SWP wire framing — newline-delimited JSON over a byte stream.
 *
 * Ported from `read_message` / `write_message` in
 * `crates/daemon/src/swp_server/mod.rs`, pinned by
 * `tests/swp_fixtures/swp_parity.json`.
 *
 * # The size bound is checked before allocating, not after
 *
 * The Rust accumulates a line chunk by chunk and tests
 * `bytes.len() + consume > MAX_WIRE_MESSAGE_SIZE` *before* extending its
 * buffer, so a hostile client cannot make the server allocate a gigabyte to
 * discover the line was too long. The check is cumulative, so where the
 * underlying reads happen to split does not change the answer — only how
 * early the error is raised. This port keeps both properties.
 *
 * The bound counts the trailing newline. A payload of exactly
 * `MAX_WIRE_MESSAGE_SIZE` bytes is therefore rejected once its newline is
 * counted; `MAX_WIRE_MESSAGE_SIZE - 1` is the largest that fits.
 *
 * # Rust's `trim` and JavaScript's are different sets
 *
 * The Rust parses `line.trim()`, where `str::trim` uses the Unicode
 * `White_Space` property. `String.prototype.trim` uses ECMAScript's
 * `WhiteSpace ∪ LineTerminator`. They disagree in both directions:
 *
 * - **U+0085 (NEL)** is `White_Space` but not ECMAScript whitespace. Rust
 *   strips it and parses the frame; a naive `.trim()` leaves it and
 *   `JSON.parse` throws.
 * - **U+FEFF (BOM)** is ECMAScript whitespace but not `White_Space`. Rust
 *   leaves it and `serde_json` rejects the frame; a naive `.trim()` strips it
 *   and the frame parses.
 *
 * So a naive port is wrong in both directions on the same code path — one
 * frame the daemon accepted would start failing, and one it rejected would
 * start being accepted. {@link rustTrim} reproduces `White_Space` exactly.
 */
```

## src/swp/framing.ts:66

```
/**
 * `ignoreBOM: true` is required, and its name is the opposite of what it does:
 * it means "treat U+FEFF as an ordinary character" rather than "skip it". The
 * default strips a leading BOM, which would undo the distinction above —
 * Rust's `str::from_utf8` keeps the BOM and `serde_json` then rejects the
 * frame, so a decoder that quietly removes it would *accept* frames the daemon
 * refused.
 */
```

## src/swp/framing.ts:82

```
/**
 * Serialize a `ServerMessage` as one JSON line and flush it.
 *
 * The Rust flushes after every frame, which matters: a client blocked waiting
 * on a `Ping` it never receives is indistinguishable from a dead daemon.
 */
```

## src/swp/framing.ts:138

```
// EOF. With nothing buffered this is a clean disconnect; otherwise
```

## src/swp/framing.ts:177

```
/**
 * Decode a parsed JSON value into a `ClientMessage` the way serde would.
 *
 * `JSON.parse` is not a decoder, and the three things serde does beyond it are
 * all observable:
 *
 * 1. **An unrecognized `type` is an error.** `ClientMessage` has no
 *    `#[serde(other)]` catch-all — only `ServerMessage` does, so that an
 *    *older client* can skip a frame from a newer daemon. In the other
 *    direction there is no such tolerance: a frame the daemon does not
 *    understand is a protocol error, and passing it through would hand
 *    downstream code a message with no matching arm.
 * 2. **Unknown fields are dropped.** Issue #12 lists this as one of the
 *    protocol's forward-compatibility properties. Retaining them would let a
 *    field from a newer client survive into anything that echoes a frame back.
 * 3. **`#[serde(default)]` fields are materialized.** A `message` frame with
 *    no `images` key reaches the Rust consumer as `vec![]`, never as absent,
 *    so every consumer here should see `[]` too rather than needing `?? []`.
 *
 * Optionals *without* a default (`rid`, `guidance`, `absence_seconds`,
 * `overrides`, `character`) stay absent, matching the Rust struct.
 */
```

## src/swp/handshake.ts:1

```
/**
 * What a client is told when it connects, and when it switches character.
 *
 * Ported from `crates/daemon/src/handshake.rs`.
 *
 * The transport already knows the *shape* of both snapshots —
 * `connection.ts` declares `HelloSnapshot` and `HistorySnapshot`, and ships a
 * `DEFAULT_HANDSHAKE` that answers with one character called `default` and an
 * empty history. This is the real answer: the characters actually on disk, and
 * the conversation actually in the engine.
 *
 * # Why the history snapshot is its own exported function
 *
 * Because it has three callers and only one of them is the handshake. A
 * character switch rebuilds it, and so does the command dispatcher after a
 * model change — both with an `activeModel` the caller already knows, which the
 * handshake does not have and has to resolve. The Rust shared one function for
 * exactly this reason and the two other call sites arrive with `handler/`.
 *
 * # The empty-history case is not an error
 *
 * A snapshot with no character selected, or with a character that has no
 * engine, is a real answer rather than a failure: it is what a client sees
 * before it has chosen, and what it sees when it names a character that has
 * gone. It still carries the config block, because the client renders the
 * active model from it either way.
 */
```

## src/swp/handshake.ts:38

```
/**
 * The slice of {@link CharacterRegistry} the handshake reads.
 *
 * Narrow on purpose: the Rust passed the whole registry behind a mutex because
 * that is how it shares one, and everything below reads four accessors. A test
 * needs those four and not a directory tree.
 */
```

## src/swp/handshake.ts:56

```
// The handshake never knows the active model — nothing has selected one
```

## src/swp/handshake.ts:57

```
// yet — so it always resolves from preferences. The other two callers pass
```

## src/swp/handshake.ts:64

```
/**
 * Every character, with its avatar bytes.
 *
 * The bytes travel rather than the path because a client cannot be assumed to
 * be able to read the daemon's config directory — it may not be on this
 * machine. `characterMetadata` carries that reasoning and the file probing.
 */
```

## src/swp/handshake.ts:103

```
// an empty conversation rather than a refused handshake.
```

## src/swp/handshake.ts:118

```
// to allow blocks, because the generated-image replay path returns an image
```

## src/swp/broadcast.ts:1

```
/**
 * A fan-out channel with tokio `broadcast` semantics.
 *
 * Ported alongside `crates/daemon/src/swp_server/mod.rs`, which subscribes one
 * receiver per connection to a `broadcast::channel(256)` and treats falling
 * behind as grounds for disconnection.
 *
 * # Why this is not just an event emitter
 *
 * The lag behaviour is load-bearing and an emitter does not have it. A client
 * that stops reading must not be able to make the daemon buffer without bound,
 * so each subscriber gets a fixed 256-frame ring; once it overflows, the
 * *oldest* frames are dropped and the subscriber is told how many it missed.
 * The message loop counts consecutive lags and drops the connection at three.
 *
 * Dropping the oldest rather than the newest is what makes that policy safe:
 * a client that recovers is left holding the most recent frames, so a brief
 * stall costs it scrollback rather than the current state of the stream.
 */
```

## src/swp/broadcast.ts:29

```
/** Fell behind; `skipped` frames were dropped and can never be recovered. */
```

## src/swp/routing.ts:29

```
/**
 * Decide which character a connecting client is talking to.
 *
 * The asymmetry here is deliberate in the Rust and reproduced: an *unknown*
 * requested character resolves to `null` rather than being rejected, so a
 * client naming a character that has since been deleted still connects and
 * sees the character list, instead of failing the handshake outright.
 *
 * Defaulting to the sole character when none was requested only fires when
 * there is exactly one; with two or more the client has to choose, because
 * picking for it would silently bind the session to whichever happened to sort
 * first.
 */
```

## src/swp/routing.ts:59

```
/**
 * Route one post-handshake client frame.
 *
 * `character` is the session's *live* selected character, read from the client
 * registry rather than from `session`, because a command can move the session
 * to a different character after the handshake captured it.
 */
```

## src/swp/routing.ts:75

```
// carries `skip_serializing_if = "Option::is_none"`, so the Rust never
```

## src/swp/routing.ts:122

```
/**
 * Whether a broadcast event should be written to this session.
 *
 * Request-scoped frames — stream frames, tool frames, errors, warnings — only
 * go to a session that is still registered, so a disconnecting client stops
 * receiving the tail of a generation it can no longer render.
 *
 * `unknown` is never routed. It exists only so an *older client* can skip a
 * frame from a newer daemon; the server never constructs one, so a frame
 * arriving here as `unknown` means something upstream is wrong and forwarding
 * it would put a frame on the wire that no client can interpret.
 */
```

## src/swp/session.ts:1

```
/**
 * Connected-session bookkeeping and the direct-message router.
 *
 * Ported from the `ClientInfo` / `SessionMeta` / `SessionRouter` half of
 * `crates/daemon/src/swp_server/mod.rs`, pinned by
 * `tests/swp_fixtures/swp_parity.json`.
 *
 * # The locks are gone, and that is safe rather than convenient
 *
 * The Rust guards `clients` and `direct_txs` with `RwLock` because connections
 * are handled on separate tokio tasks that genuinely run in parallel. This
 * runs on one event loop, so a synchronous read-modify-write cannot interleave
 * and the maps need no guard.
 *
 * That is load-bearing in exactly one place. The Rust holds the write lock
 * across `remove` *and* `is_empty` with a comment saying why: two clients
 * disconnecting at once could otherwise both observe an empty map and both
 * fire `AllClientsDisconnected`, cancelling generation twice. Here
 * {@link SessionRouter.unregisterSession} does both without an intervening
 * `await`, so the same double-fire is impossible for the same reason the locks
 * are unnecessary. Adding an `await` between them would reintroduce the bug.
 */
```

## src/swp/session.ts:99

```
/**
 * Per-session direct-message router and session-metadata mutator.
 *
 * "Direct" is the distinction that matters: a frame sent through here goes to
 * exactly one session, as opposed to the broadcast channel that fans out to
 * every connection.
 */
```

## src/swp/session.ts:155

```
/**
   * Send a request-scoped response to one session.
   *
   * Sending to a session that has already gone is not an error. The Rust
   * returns `Ok(())` for an absent sender, because a client disconnecting
   * while its command is in flight is ordinary rather than exceptional.
   */
```

## src/swp/connection.ts:1

```
/**
 * One client connection: the SWP handshake, then the message loop.
 *
 * Ported from `perform_handshake`, `handle_client` and `message_loop` in
 * `crates/daemon/src/swp_server/mod.rs`, pinned by
 * `tests/swp_fixtures/swp_parity.json`.
 *
 * # The per-session queue is gone
 *
 * The Rust gives every connection an `mpsc::channel(256)` so that other tasks
 * can send it a frame: the socket writer is owned by the connection's task and
 * nothing else can touch it, so a "direct" send has to be a message to that
 * task. Here the router writes to the socket itself, through
 * {@link serialSink}, which serializes concurrent writes onto one promise
 * chain. That preserves the two properties the channel was providing —
 * frames never interleave mid-line, and ordering is stable — without the
 * queue.
 *
 * One arm of the Rust's `select!` disappears with it: `direct_rx.recv()`
 * returning `None` broke the loop when every sender had been dropped. The only
 * way that happened was the session being unregistered, which already means
 * the connection is finished, so nothing observable is lost.
 *
 * The 256-frame bound is *not* lost — it lives on the broadcast side, where it
 * is what the lag policy is built on. The direct path was never the one a slow
 * client could flood.
 */
```

## src/swp/connection.ts:74

```
/**
 * The fallback used when no provider is wired.
 *
 * The Rust defaults to a single character literally named `default` and an
 * empty history. It is what a daemon with no character configuration serves,
 * and it keeps the transport testable without the rest of the daemon.
 *
 * The real one is `buildHandshakeProvider` in `swp/handshake.ts`, which answers
 * from the character registry. A daemon that serves this instead is a daemon
 * whose handshake was never attached — the Rust attaches it after construction
 * (`set_handshake_provider`) because the provider needs the registry and the
 * registry needs the server's broadcast, and something has to be built first.
 */
```

## src/swp/connection.ts:153

```
/**
 * Perform the SWP handshake: server hello, client hello, then history.
 *
 * The order matters and is not arbitrary. The server sends its hello — and the
 * character list — *first*, so the client can name a character it learned
 * about in the same exchange. History comes last because which history to send
 * is not known until the character resolves.
 */
```

## src/swp/connection.ts:233

```
/**
 * A snapshot as the frame that carries it.
 *
 * Field order and omission both follow serde. `active_start` is skipped at zero
 * (`skip_serializing_if = "is_zero"`), not just when absent, and a handshake
 * snapshot is always zero — so the field is normally not on the wire at all.
 *
 * Shared with `handler/command_dispatch.ts`, which pushes one of these after a
 * `switch_character` so the session sees the new character's conversation
 * rather than the old one's. That push carries the command's `rid`; the
 * handshake's does not, because nothing asked for it.
 */
```

## src/swp/connection.ts:259

```
/**
 * Handle one connection end to end.
 *
 * Always unregisters the session, and reports `AllClientsDisconnected` when it
 * was the last one, whether the connection ended cleanly or by error — the
 * Rust does this after `message_loop` returns, before propagating its result.
 */
```

## src/swp/connection.ts:380

```
// told or was not depending on scheduling. The frame exists for exactly
```

## src/ledger/record.ts:1

```
/**
 * Recording a call to `ledger.db` from the side that made it.
 *
 * This is the only writer. The daemon used to record from `LedgerStream`, which
 * meant a tool loop this side drove — one `start` … `done` over the wire — could
 * only become a single row summing every provider call in it. Worse, the
 * ownership could not be split: a loop that recorded two calls and then failed
 * would be double-counted by a daemon-side error row on top. So the rule is
 * simple and total — **this side records every call it attempted**, success,
 * failure, or abandonment, and the daemon records nothing.
 *
 * A call that dies before reaching the sidecar therefore leaves no row. It also
 * has no usage, so nothing is lost but the breadcrumb; the daemon logs that
 * dispatch failure separately.
 *
 * Recording never fails a call. Every entry point swallows its own errors: an
 * unwritten row is bad, a dropped response is worse.
 */
```

## src/ledger/record.ts:49

```
/** Drop every cached handle. Tests use this; the daemon never does. */
```

## src/ledger/record.ts:114

```
/**
 * Notified for each provider call that completed and was billed.
 *
 * The keepalive registers here because this is already the one funnel every
 * provider call passes through, whichever endpoint or loop made it — see
 * `autonomy/keepalive.ts`. The dependency points this way (autonomy registers
 * with the ledger, not the reverse) so recording stays ignorant of who is
 * listening: a row must be written whether or not anything cares.
 */
```

## src/ledger/record.ts:132

```
/**
 * Whether a recorded call actually reached the provider and warmed a prefix.
 *
 * `error` and `cancelled` rows exist to say the attempt happened; they carry no
 * usage and touched no cache, so treating them as activity would push a ping
 * deadline out on the strength of a call that never landed.
 */
```

## src/ledger/record.ts:153

```
// along; this is the reader it never had.
```

## src/ledger/record.ts:182

```
/**
 * Record, and never let a recording failure reach the caller.
 *
 * The observer fires outside `record`, which returns early when there is no
 * ledger path or the file will not open. Those are recording concerns; a call
 * that reached a provider warmed its prefix whether or not a row landed, and
 * tying the keepalive's clock to the ledger opening would stop the schedule for
 * a reason that has nothing to do with it.
 */
```

## src/ledger/record.ts:206

```
/**
 * Fire a desktop notification for a cache anomaly.
 *
 * Gated on forensics being on, exactly as the daemon's `notify_anomaly` was —
 * it moved here with the tracker that detects the anomaly. Best-effort:
 * `notify-send` may not exist, and its absence must not disturb the call.
 */
```

## src/ledger/record.ts:229

```
/**
 * Pass a provider stream through, recording each provider call in it.
 *
 * A stream that made several calls says so as it goes, with `call_complete`;
 * one that made a single call says nothing and is recorded from `done`. That
 * distinction is the whole design: a loop's rows are written as each call
 * lands, so a loop that fails on its third call — or that the client walks away
 * from — keeps the rows for the two that already happened and were already
 * billed. Recording at the end could only ever have written their sum, which is
 * the shape that misreports the cache.
 *
 * Rows are written *before* the event is yielded, so a daemon that never
 * receives it still has the row: the call happened either way.
 *
 * A stream that ends having recorded nothing was abandoned before its first
 * call returned — the client disconnected, or the generator threw. That leaves
 * a `cancelled` row with zero usage, which is what the daemon's
 * `LedgerStream::drop` wrote and what keeps `shore usage` honest about the call
 * having been attempted. Its zero usage is why `store.ts` keeps `cancelled` out
 * of the cache tracker.
 */
```

## src/ledger/pricing.ts:1

```
/**
 * Model pricing, ported from `crates/daemon/src/ledger/pricing.rs`.
 *
 * This side computes cost because this side makes the calls: it knows the
 * usage the moment a response lands, so pricing a row does not need a second
 * hop. The catalog comes from OpenRouter and is cached in the `pricing` table
 * of `ledger.db`, which is the same table the Rust engine used — a daemon that
 * has already fetched prices hands them over rather than making this side
 * re-fetch.
 *
 * The one piece of genuine Anthropic knowledge here is the cache-write TTL
 * tiering: a 1h write costs 2× input where a 5m write costs 1.25×, so the
 * catalog's 5m price is multiplied by 1.6 to reach the 1h price. That applies
 * to *native* Anthropic only — an OpenRouter-routed Anthropic call is billed at
 * OpenRouter's catalog price as-is.
 */
```

## src/ledger/store.ts:1

```
/**
 * Writing rows to `ledger.db`.
 *
 * Ported from the recording half of `crates/daemon/src/ledger/{store,client}.rs`.
 * This side computes cost and cache state because this side makes the calls —
 * it has the usage the moment a response lands.
 *
 * **This side owns the schema now.** It used to be the daemon's: it started
 * first, ran the migrations, and this opened a file that already existed. That
 * was right while two processes shared the file — a second schema author is how
 * two schemas drift — and it stops being right the moment the daemon is not
 * there to start first. Nothing else creates `ledger.db`, and the failure is
 * silent in the worst way: `ledgerFor` caches the open failure, every call after
 * it records nothing, and `shore usage` reports a quiet month.
 *
 * So {@link Ledger.create} carries {@link SCHEMA} and {@link MIGRATIONS}, both
 * transcribed from `crates/daemon/src/ledger/store.rs`. The migrations are not
 * optional and not historical: an installed shore has a `ledger.db` some older
 * daemon created, and the columns added after v1 are ones the readers on this
 * side already select.
 *
 * Two processes on one SQLite file is still fine in WAL — one writer, several
 * readers — which is why the connection sets `journal_mode = WAL` (shore commit
 * 297fc2a4).
 */
```

## src/ledger/store.ts:101

```
/**
 * Columns and tables added after the first schema, in the Rust's order.
 *
 * `CREATE TABLE IF NOT EXISTS` in {@link SCHEMA} covers a fresh file; these
 * cover the file an older daemon left behind. The `UPDATE` is not a schema
 * change and belongs here anyway: it backfills `cost_source` for rows written
 * before the column existed, and a row with a provider-reported total must not
 * be overwritten by a catalog estimate on the next recalculation.
 */
```

## src/ledger/store.ts:137

```
// change between rows explains an otherwise inexplicable message-level miss.
```

## src/ledger/store.ts:227

```
/** Nullable to match Rust's `Option<String>`: the writer here always sets
   *  one, but rows predating that are still readable. */
```

## src/ledger/store.ts:270

```
/**
 * The ledger, from the writer's side.
 *
 * Holds the cache trackers, because a row's `cache_state` is a function of the
 * rows before it — recording and tracking are the same act.
 */
```

## src/ledger/store.ts:288

```
/**
   * Open a ledger, creating and migrating the schema if it is not there.
   *
   * The migrations run on every open, not only on create. `ADD COLUMN` on a
   * column that exists is an error SQLite raises and this swallows, which is
   * exactly what the Rust's `add_if_missing` did — the cheap way to make the
   * step idempotent without tracking a version number.
   */
```

## src/ledger/store.ts:445

```
// then dies, and that write must be tracked. A failure that reported
```

## src/ledger/store.ts:448

```
// that is fine. The daemon never produced such a row, so this guard is new
```

## src/ledger/zoned.ts:1

```
/**
 * Wall-clock ↔ instant conversion in a named timezone.
 *
 * This exists because budget windows are anchored to a wall-clock hour and must
 * stay there across a DST transition. A weekly budget that resets Wednesday
 * 06:00 opens at 06:00 EST and closes at 06:00 EDT; every day-pace boundary
 * inside that week has to sit at 06:00 *local*. Stepping in instant space
 * instead would hold every boundary at the same UTC time, which is 07:00 local
 * after the transition — an hour off the budget's own reset hour.
 *
 * Rust gets this from chrono (`NaiveDateTime` plus `Local.from_local_datetime`).
 * There is no equivalent here: `Temporal` is not in Bun 1.3, and `Date` is an
 * instant with no wall-clock type beside it. So a naive wall-clock time is
 * represented as **epoch milliseconds interpreted as if UTC** — the standard
 * encoding, and the one that makes naive arithmetic plain addition, exactly as
 * `NaiveDateTime::checked_add_signed` is.
 *
 * The two directions are not symmetric, and that asymmetry is the whole
 * subject:
 *
 *   - instant → naive is total. Every instant has one wall-clock reading.
 *   - naive → instant is not. A wall-clock time in the spring-forward gap
 *     names no instant, and one in the autumn overlap names two.
 *
 * {@link resolveInZone} reproduces chrono's `LocalResult` handling for both:
 * ambiguous picks the earlier instant, and a gap retries an hour later before
 * falling back to reading the wall-clock as UTC.
 */
```

## src/ledger/zoned.ts:65

```
/**
 * A config `timezone` ("utc" / "local") as an IANA zone name. Anything that is
 * not exactly "utc" selects the local path, matching the Rust's `match`.
 */
```

## src/ledger/zoned.ts:94

```
/**
 * Every instant whose wall-clock reading in `timeZone` is exactly `naive`,
 * earliest first. Empty in the spring-forward gap, two long in the autumn
 * overlap, one otherwise — chrono's `LocalResult`, as an array.
 *
 * The offsets are sampled a **half-day either side** of a first guess, not
 * iteratively from the guess itself. Iterating converges: for an ambiguous
 * 01:00 during a fall-back, the offset at the guess is the one that produced
 * the guess, so re-probing returns the same instant and the second reading is
 * never found. Sampling across the transition surfaces both offsets, and a
 * candidate per distinct offset then covers every reading. Twelve hours is
 * comfortably wider than any real transition (at most an hour or two) and
 * narrower than the gap between them.
 */
```

## src/ledger/zoned.ts:118

```
/**
 * The instant at which `naive` occurs in `timeZone`.
 *
 * Mirrors the Rust's `resolve_local`:
 *   - unambiguous → that instant;
 *   - ambiguous (autumn overlap) → the **later** instant, i.e. the standard-time
 *     reading. See the note below; this is not what the Rust *looks* like it
 *     does;
 *   - nonexistent (spring-forward gap) → retry one hour later, and if that
 *     somehow fails too, read the wall-clock as UTC rather than throw. A budget
 *     boundary that cannot be resolved must still produce *a* boundary;
 *     refusing would fail every call the budget governs.
 *
 * **On the ambiguous arm.** The daemon writes
 * `LocalResult::Ambiguous(early, _) => early`, which reads as "take the earlier
 * instant". It does not: chrono fills `.0` with the standard-time reading, so
 * for `2026-11-01 01:00` in America/New_York it holds `06:00Z` (EST) and `.1`
 * holds `05:00Z` (EDT). Probed directly against chrono before writing this, and
 * pinned by the fall-back cases in the budget parity fixture. The binding name
 * is misleading; the behaviour is what a budget window actually gets, so it is
 * what this reproduces.
 */
```

## src/ledger/zoned.ts:220

```
// it always is for a window boundary.
```

## src/ledger/budget.ts:54

```
/**
 * What a budget does when it trips.
 *
 * `pause_heartbeat` exists because `pause_background` stops two kinds of spend
 * that are not the same kind at all. A heartbeat is a turn nobody asked for —
 * discretionary, and the first thing to cut. A keepalive ping is *spend to
 * avoid spend*: a small ping that stops a cached prefix from expiring, where
 * the thing it prevents is a full cache write on the character's next real
 * turn. Blocking it under budget pressure can raise the bill rather than lower
 * it — the budget goes quiet for an hour, the prefix dies, and the next user
 * message pays for the whole prefix again.
 *
 * `compaction` was already carved out of the same bucket by
 * `allow_compaction_over_budget`, which is the precedent: `pause_background`
 * was never one undifferentiated thing.
 */
```

## src/ledger/budget.ts:117

```
/**
 * `[usage]` as this gate reads it.
 *
 * A rename in the other direction to the rest of the config port: the parsed
 * config spells an unset filter `undefined` because it is a struct field, and
 * the gate spells it *absent* because it came from the wire, where the daemon
 * omitted it. Dropping the undefined-valued keys is the whole translation.
 *
 * It lives here rather than at either caller because both of them — `shore
 * usage` and the per-turn budget check — need the same one, and two spellings
 * of "which filters this budget has" would be two different sets of budgets
 * matching the same call.
 */
```

## src/ledger/budget.ts:299

```
/** Present only when the budget configures `pace_period`, so an unpaced
   *  budget serializes exactly as before. */
```

## src/ledger/budget.ts:362

```
/**
   * The `warn_at` fraction that tripped, when this block came from a warning
   * threshold rather than the limit itself.
   *
   * Its presence is what tells the two apart: `cost_limit` stays the budget's
   * real limit either way, because a message that reported $16 as the limit
   * would not reconcile with `shore usage`.
   */
```

## src/ledger/budget.ts:377

```
/** Prefix for the `usage_budget_warnings.threshold` dedup key.
 *
 *  A pace and its budget can open at the same instant — a Wednesday-anchored
 *  weekly budget starts its first day-pace exactly at the week start — so
 *  `(budget_name, period_start)` alone would collide. Prefixing the threshold
 *  text keeps the existing `UNIQUE` constraint and leaves rows already recorded
 *  for budget-scope warnings untouched. */
```

## src/ledger/budget.ts:393

```
/**
 * Extra spend to weigh against the limit without reporting it as spent.
 *
 * A tool loop is several provider calls behind one gate (#14). Passing the
 * loop's worst case here refuses up front rather than partway through, which is
 * the only refusal that leaves a well-formed transcript: stopping mid-loop
 * abandons a turn whose `tool_use` blocks already have no `tool_result` after
 * them, and Anthropic rejects that on the *next* request — turning a budget
 * overrun into a wedged conversation.
 *
 * Deliberately applied to the enforcement comparison alone and never to
 * {@link BudgetStatus.current_cost}. A projection is a forecast, and a forecast
 * in `shore usage` is a number that does not reconcile with the ledger.
 */
```

## src/ledger/budget.ts:438

```
// otherwise a person checks `shore usage`, sees room, and files a bug.
```

## src/ledger/budget.ts:597

```
/**
 * Fixed length of a pace period.
 *
 * `undefined` for `month`, which has no fixed length and can never be a pace:
 * config validation requires the pace to rank strictly shorter than the budget
 * period, and `month` is the longest. Returning nothing degrades an impossible
 * config to "no pace" instead of inventing a 30-day month.
 */
```

## src/ledger/budget.ts:618

```
/**
 * The pace sub-window containing `now`, stepped from the budget window's own
 * start so sub-windows tile the period exactly and inherit its reset anchor.
 *
 * Stepping happens in wall-clock (naive) space: across a DST transition a
 * `reset_hour = 6` day-pace stays anchored to 06:00 local rather than sliding to
 * 05:00 or 07:00. Only the final resolution back to instants is zone-aware.
 */
```

## src/ledger/budget.ts:797

```
// after four weeks) must not inflate the allowance past what is actually
```

## src/ledger/budget.ts:801

```
// `allowance` is zero exactly when the budget is already spent, in which case
```

## src/ledger/budget.ts:891

```
/**
 * Whether `call` may run. Returns the block that stopped it, or `undefined`
 * when every matching budget allows it.
 *
 * A query failure allows the call: a budget that cannot be evaluated must not
 * become an outage. Rust logs and continues here, and so does this.
 */
```

## src/ledger/budget.ts:930

```
// The projection weighs against the limit but is never reported as spent —
```

## src/ledger/budget.ts:932

```
// reads reconciles with `shore usage`. Without that, a loop refused at
```

## src/ledger/budget.ts:1027

```
/**
 * The largest configured threshold this spend has reached, or `undefined` when
 * it has reached none.
 *
 * The largest rather than the smallest because they all fire the same action,
 * so the only question the number answers is "how far past", and 100% is more
 * informative than the 80% that technically triggered first.
 *
 * A zero limit is treated as fully used, matching {@link paceStatus}: an
 * allowance of nothing cannot have room left in it.
 */
```

## src/ledger/budget.ts:1242

```
/**
 * Newly crossed budget warning thresholds, recording each
 * budget/window/threshold so future checks don't repeat the same warning.
 *
 * Once a budget is over its limit, the warning re-fires on every check
 * regardless of dedup — intermediate thresholds (50%, 80%) staying one-shot is
 * the right call for noise, but "still over budget" is an active signal the
 * operator needs to keep seeing as spend continues to accrue.
 */
```

## src/ledger/query.ts:1

```
/**
 * Aggregation and filter queries over `ledger.db`.
 *
 * Ported from `crates/daemon/src/ledger/query.rs`. The SQL is kept
 * character-for-character where it can be, because these queries are the
 * definition of what `shore usage` reports and what a usage budget counts —
 * a subtly different `WHERE` is a subtly different bill.
 *
 * Two deliberate departures from the Rust:
 *
 *   - **No `with_conn`.** Rust wraps every query in a mutex because the daemon
 *     is multi-threaded. This process is single-threaded per handle, so the
 *     functions take a `Database` directly. That also collapses Rust's
 *     `usage_totals` / `usage_totals_on` pair — the `_on` variant exists only so
 *     a caller running several totals can take the lock once, which is not a
 *     distinction here.
 *   - **Reads clamp, they do not throw.** Mirrors `ledger/convert.rs`: SQLite
 *     stores every integer as i64, and a negative or oversized count in a
 *     non-negative column is corruption, for which `0` is the only sensible
 *     reading.
 */
```

## src/ledger/query.ts:401

```
/**
 * Render a cost the way Rust's `f64::to_string` does.
 *
 * Both runtimes emit the *shortest* digits that round-trip, so `String(v)`
 * already agrees with Rust on the digits — `0.01` is `0.01` in both, and
 * reaching for `toFixed` instead would print `0.01000000000000000021`.
 *
 * They part company only on notation: Rust's `Display` is always positional,
 * while JavaScript switches to exponent form below 1e-6 and at/above 1e21. A
 * heartbeat costing 1.5e-7 is well inside that range, so expand the exponent
 * back to positional and keep the digits untouched.
 */
```

## src/ledger/query.ts:564

```
/**
 * Every repriceable row, for a forced recalculation.
 *
 * `provider_reported` rows carry the provider's own total, and `subscription`
 * rows are billed by a flat plan — repricing either from the catalog would
 * replace a true cost with an invented one. The subscription exclusion is not
 * belt-and-braces: {@link updateCosts} unconditionally rewrites `cost_source`
 * to `pricing_catalog` and sets a non-zero total, so a subscription row that
 * priced would start accruing against usage budgets. Nothing catches it today
 * only because `opencode-go/<model>` is never in OpenRouter's catalog, which is
 * luck, not a rule. The rule itself lives in `store.ts`, which writes the marker.
 */
```

## src/ledger/query.ts:604

```
/**
 * Typical cost of one *continuation* on this provider and model, for
 * projecting what a tool loop is about to spend (#14).
 *
 * Filtered by `callType`, and that filter is the whole point. A loop's
 * continuations are not priced like the turn that opened it: measured over two
 * weeks of real traffic, a `tool_loop` call averaged **$0.0145** against
 * **$0.0416** for a `message` on the same models. Averaging both together
 * prices every projected continuation at roughly three times what it costs, and
 * the gate then demands three times the headroom it needs — refusing turns that
 * would have fit, which is the failure mode nobody reports as a bug because it
 * looks like the daemon being broken.
 *
 * The **mean of the most recent calls**, not of the whole budget window: a model
 * switched to yesterday must not be priced off last week's. Rows with no cost
 * are excluded rather than counted as free — a subscription provider or an
 * unpriced model would otherwise drag the mean toward zero and project that a
 * loop costs nothing, which is the one answer that makes the gate useless.
 *
 * `undefined` when there is nothing to average, and the caller must treat that
 * as "cannot project" rather than as zero. A first loop on a new model has no
 * continuations to learn from, and refusing it on a guess would be worse than
 * the overrun.
 */
```

## src/ledger/cache_tracker.ts:1

```
/**
 * Per-character Anthropic cache warm/cold state machine.
 *
 * Ported from `crates/daemon/src/ledger/cache_tracker.rs`. Structure and field
 * names are kept deliberately close to the Rust so the two can be diffed while
 * both exist.
 *
 * It reads a sequence of recorded calls and labels each with a cache state and,
 * when something is wrong, an anomaly. It never influences a request — the
 * decisions it informs are made elsewhere, in `../autonomy/cache_keepalive.ts`
 * (ported, not yet driving the live schedule; the daemon's
 * `cache_keepalive.rs` still does).
 *
 * The invariants are Anthropic's: a 1h prompt-cache TTL, a keepalive cadence
 * that bridges idle stretches, and a cacheable prefix that grows monotonically.
 * Other providers cache with different semantics and are given a plain
 * warm/cold label with no anomalies — running them through these rules produced
 * only false positives.
 *
 * **One row per provider call is load-bearing.** This compares each call's
 * `cache_read` against the previous call's, so a row carrying a *sum* across
 * several calls reports a read no single call made, raises the baseline above
 * anything reachable, and makes the next ordinary message look like a
 * regression. See shore commit 22a2d3ff.
 */
```

## src/ledger/cache_tracker.ts:46

```
/**
   * Fingerprint of the tool definitions this call sent, or `undefined` when
   * unknown — a pre-migration row, or a call that carried no `tools` field at
   * all. Unknown on either side of a comparison means no transition, so old
   * rows keep behaving exactly as they did.
   */
```

## src/ledger/cache_tracker.ts:95

```
/**
 * Whether the prefix behind a character's last Anthropic call is still warm.
 *
 * Warm requires both halves: the call must be inside the cache TTL, and it must
 * actually have read something. A call that read nothing wrote a prefix but
 * proves nothing about one existing before it.
 *
 * An unparseable timestamp reads as cold rather than as an error — a row we
 * cannot date is one we cannot claim is fresh.
 *
 * Two callers, one rule: {@link CacheTracker.reconstruct} seeds a tracker after
 * a restart, and `usage.ts` recomputes cache health for `shore usage`. The
 * daemon kept a second copy of this in `ledger/cache_tracker.rs` for the latter;
 * it went when its reader did.
 */
```

## src/ledger/cache_tracker.ts:138

```
/** Last *foreground* activity (`message` / `tool_loop`).
   *
   *  The keepalive-miss window is measured from here, never from pings or
   *  background calls. Anchoring on the previous observation instead misread
   *  the deliberate past-the-ceiling stop: pings run all night, stop 12h after
   *  the user left, and the user's return looks like a short gap from the last
   *  ping — flagging a by-design cold start as a failure. */
```

## src/ledger/cache_tracker.ts:205

```
// 1. Compaction always goes cold. Deliberate, not a keepalive failure.
```

## src/ledger/cache_tracker.ts:258

```
// Both sides must be known. `undefined` means unknown, not "no tools", so
```

## src/ledger/cache_tracker.ts:384

```
// pre-migration row, or a call with no `tools` field — must not erase a
```

## src/ledger/tool_surface.ts:1

```
/**
 * A fingerprint of the tool surface a request carried.
 *
 * Tool definitions sit ahead of `system` and `messages` in Anthropic's cached
 * prefix, so adding, removing or re-describing one invalidates the whole cache.
 * The tracker modelled three warm→cold transitions — TTL expiry, model change,
 * a thinking toggle — and had no fourth for this, because the `calls` table had
 * no column describing the tools. The resulting full write was recorded as
 * `unexpected_write`: correct as billing, wrong as diagnosis (#33).
 *
 * Editing `enabled_tools` is rare. **MCP servers appearing and disappearing is
 * not**, and it has the same effect — a server that fails to start drops its
 * tools, one that recovers puts them back, and each transition rewrote the
 * prefix and raised an anomaly with no cause attached. A tracker that cries
 * wolf on a routine event is worse than one that says nothing, because
 * `unexpected_write` is the alert this repo relies on.
 *
 * The hash is over the definitions *as sent*, not over their names: an MCP
 * server that changes a tool's description or schema moves the prefix exactly
 * as much as one that disappears, and the fingerprint has to see it.
 */
```

## src/ledger/tool_surface.ts:30

```
/**
 * The fingerprint for a request's tools, or `undefined` when there is nothing
 * to fingerprint.
 *
 * `undefined` means *unknown*, and the tracker treats it as "do not compare" —
 * which is what keeps pre-migration rows and non-tool providers from reporting
 * a spurious change. It is deliberately **not** what an empty tool array
 * produces: "this request carried no tools" is a real surface, and a character
 * whose tools were switched off did move the prefix.
 */
```

## src/ledger/gate.ts:1

```
/**
 * The budget gate: whether a call is allowed to spend.
 *
 * This is the enforcement half of `budget.ts`, wired to the request. It moved
 * here from the daemon's `LedgerClient::enforce_usage_budget` for the same
 * reason the ledger row writer did (shore commit fe2058b3): **the side that
 * makes the call is the side that must decide whether to make it.** With the
 * check on the far side of the socket, the daemon was authorising a call it no
 * longer places.
 *
 * The daemon checked exactly two paths — `generate` and `stream_raw` — and this
 * covers exactly the same two. Image generation was never budget-checked and
 * still is not; adding it here would be a behaviour change wearing a refactor's
 * clothes.
 *
 * **A tool loop is still one check, but it is no longer one call's worth.**
 * The loop makes up to `max_tool_iterations` provider calls behind this gate,
 * so a loop starting a cent under a hard limit could spend every remaining
 * iteration and finish well past it (#14). {@link projectedLoopCost} weighs the
 * whole loop up front instead.
 *
 * Refusing *before* the loop rather than during it is the deliberate half. A
 * mid-loop refusal abandons a turn whose `tool_use` blocks have no
 * `tool_result` after them; Anthropic rejects that on the next request, so a
 * budget overrun becomes a wedged conversation. The cost of the pre-flight is
 * that it is conservative — a loop that would have finished under the limit can
 * be refused on a projection that assumed every iteration ran.
 */
```

## src/ledger/gate.ts:35

```
/**
 * The budget that refuses this call, or `undefined` when it may proceed.
 *
 * Allows the call when there is nothing to check against — no context, no
 * ledger path, no budgets, or a ledger that will not open. That mirrors the
 * daemon, which logged and allowed rather than failing the turn: a budget that
 * cannot be evaluated must not become an outage.
 */
```

## src/ledger/gate.ts:61

```
// otherwise, so `[[usage.budgets]].provider` matches what the ledger row will
```

## src/ledger/gate.ts:81

```
/**
 * Worst-case additional spend this call authorises, or `undefined` when there
 * is nothing to project.
 *
 * A request carrying tools and an iteration cap can make that many provider
 * calls before it returns. The projection is `remaining iterations x the recent
 * mean cost of a call on this model`, which is the only estimate available
 * before the loop has run.
 *
 * Three cases deliberately project nothing, and each would otherwise refuse a
 * turn on a number that means nothing:
 *
 *   - **No tools, or no configured cap.** See below on the uncapped case.
 *   - **No continuation history for this model.** A first loop on a newly
 *     configured model has nothing to average; guessing would refuse it.
 *   - **A cap of one.** The loop cannot make a second call, so there is no
 *     overrun to prevent.
 *
 * # The uncapped case is left alone on purpose
 *
 * `max_tool_iterations` has no default, and `config/models.ts` says why:
 * absent means **unlimited**. Someone who has left it there has said they do
 * not want their loops bounded, and a budget gate that invents a bound for
 * them is second-guessing a deliberate choice. So this projects nothing, and
 * enforcement stays where it was: the entry check still runs on every turn, so
 * an overrun is bounded by **one turn's loop** and the next turn is refused.
 *
 * That bound is small in practice. Over two weeks of real traffic a turn made
 * 1.7 provider calls on average — 0.68 continuations — at $0.0145 each, so a
 * typical overshoot past a budget is a few cents. This gate is for the case
 * where someone has asked to be conservative *twice*, by setting both a cap and
 * a budget; for everyone else, option 1 of #14 is the right answer and this is
 * it.
 */
```

## src/ledger/usage.ts:161

```
/**
 * The `--last` window's lower bound as an RFC 3339 string, or `undefined` for
 * no lower bound.
 *
 * `undefined` covers both `"all"` and anything unparseable, exactly as the
 * Rust's `Option` did: an argument we cannot read means the whole ledger, not
 * an error.
 */
```

## src/ledger/usage.ts:321

```
/**
 * TSV re-quoted as CSV.
 *
 * Fields are quoted only when they contain a comma, a quote, or a newline —
 * a tab does not trigger quoting, because a tab inside a field would already
 * have broken the TSV it came from.
 */
```

## src/config/effective_catalog.ts:1

```
/**
 * The effective model catalog — the static `[chat.*]` catalog merged with the
 * provider registry and its on-disk discovery cache.
 *
 * Port of `crates/daemon/src/effective_catalog.rs`.
 *
 * Conflict rules:
 *
 * * Static entries always win when matched by short or qualified name;
 *   `findModel`'s behaviour is preserved verbatim.
 * * When a discovered model and a static entry share a `(provider, modelId)`,
 *   the static entry wins — the static-by-upstream check runs before any
 *   synthetic model is built.
 * * `discovery.ignore` never affects static entries; only discovered models
 *   can be hidden.
 *
 * Sampler preferences are applied separately at request time; this module
 * resolves identity and transport only.
 */
```

## src/config/effective_catalog.ts:81

```
/** True when `discovery.ignore` would normally hide this model. Static
   *  entries are always `false`. */
```

## src/config/effective_catalog.ts:88

```
/**
 * Look up a model by name across the static catalog and the provider
 * discovery caches.
 *
 * 1. Static catalog by short or qualified name.
 * 2. Provider-prefixed `provider:model_id`. The provider must be registered
 *    and enabled. A legacy static entry sharing the same `(provider, modelId)`
 *    still wins this cycle; otherwise a discovery record is used when
 *    available, and failing that the `modelId` is trusted as-given and routed
 *    through the provider's transport.
 * 3. Bare upstream `model_id`, searched across every enabled provider's cache.
 *    Several providers carrying the same id is `ambiguous`.
 *
 * A disabled provider is *uniformly* unreferenceable — neither its
 * trusted/discovered models nor its legacy static entries resolve through
 * paths 2 or 3.
 *
 * `includeHidden` permits resolving discovered models matched by
 * `discovery.ignore`. Static entries are never hidden.
 */
```

## src/config/effective_catalog.ts:137

```
// always considered; discovered matches need both provider.enabled and
```

## src/config/effective_catalog.ts:161

```
// Hidden hits don't count toward ambiguity unless the caller opted in. A
```

## src/config/effective_catalog.ts:178

```
/**
 * Every static chat model plus every discovered model.
 *
 * Discovered models are deduplicated against static entries with the same
 * `(provider, modelId)` — one row, sourced from the static side.
 *
 * `includeHidden = false` drops discovered rows hidden by `discovery.ignore`.
 * Static rows are always included.
 */
```

## src/config/effective_catalog.ts:259

```
// A disabled provider is *uniformly* unreferenceable — never trust a stale
```

## src/config/effective_catalog.ts:332

```
// because openai-compatible discovery stamps a blanket `"openai"` for every
```

## src/config/effective_catalog.ts:355

```
// Everything else is deliberately left unset: `api_key_env` never cascades
```

## src/config/effective_catalog.ts:361

```
// sampler knobs and the rest that the discovery feed never reports.
```

## src/config/token.ts:1

```
/**
 * The shared secret every SWP client presents, and where it comes from.
 *
 * The TypeScript counterpart of `client/shore-common/src/token.rs`. The two
 * must agree on the resolution order and on the file's name, because they are
 * the two halves of one credential — and, as with {@link resolveShoreDirs}, a
 * client has to find it *before* it has a daemon to ask.
 *
 * # Why a token, and why only a token
 *
 * SWP carries no authentication of its own, and passing the connection check
 * grants a full session: every character's history, the ability to send as the
 * user, and the whole tool surface. The check is all-or-nothing, so the only
 * question is what it should be.
 *
 * It used to be an IP allowlist plus `unsafe_allow_remote_access`, a flag that
 * asked you to acknowledge the exposure rather than remove it. Both are gone:
 *
 * - **An address is not a credential.** A container bridge hands out addresses
 *   from ranges indistinguishable from an ordinary LAN's, so "allow my
 *   containers" and "allow my whole network" were the same configuration.
 * - **A flag that asks you to accept a risk is worse than not having the
 *   risk.** Being safe used to require getting the bind address, the flag and
 *   the allowlist all right at once. Now there is nothing to get right: the
 *   daemon is closed wherever it is bound.
 *
 * One mechanism, always on, no opt-out. A daemon that cannot establish a token
 * does not start.
 *
 * # This side owns the secret
 *
 * The daemon writes; clients only read (`token.rs` has no generator at all). A
 * client that minted its own credential would not be authenticating.
 */
```

## src/config/token.ts:72

```
/**
 * The daemon's token: `$SHORE_TOKEN`, else `<config>/token`, else a fresh one
 * written to `<config>/token` at mode 0600.
 *
 * Generation is what makes this invisible on a single machine: the daemon
 * writes the file, and a client on the same box resolves the same config
 * directory and reads it. Nobody types a token to run shore locally.
 *
 * @throws {TokenError} when there is no token and none can be written. That is
 * a refusal to start, deliberately, and never a fallback to "authentication
 * off" — a read-only `/config` should stop the daemon, not silently open it.
 */
```

## src/config/token.ts:110

```
/**
 * Whether a client's hello carries the right token.
 *
 * Compared as SHA-256 digests rather than as strings. That is not about
 * hashing the secret — both sides already hold it in the clear — it is to get
 * two buffers of *equal length*, because `timingSafeEqual` throws on a length
 * mismatch and returning early on one would leak the length through timing.
 *
 * The timing channel is not a realistic threat against a 256-bit secret over a
 * LAN. But `===` on a secret is the kind of thing that is only ever wrong, and
 * doing it properly costs one function.
 */
```

## src/config/preferences.ts:1

```
/**
 * Daemon-owned, durable model preferences.
 *
 * Port of `crates/daemon/src/preferences/mod.rs`.
 *
 * Storage layout:
 *
 * - `<data_dir>/preferences/models.toml` — global
 * - `<data_dir>/<character>/preferences/models.toml` — per-character
 *
 * Per-model entries are keyed by **stable provider key + upstream model_id**,
 * joined by `:` — never by display name or short alias — so preferences
 * survive renames in the static catalog and follow the same model across
 * discovered and manual entries.
 */
```

## src/config/preferences.ts:123

```
/** Every settable sampler key, in the order the Rust listed them — the order
 *  matters because `set_model_setting` joins it into its rejection message. */
```

## src/config/preferences.ts:179

```
/**
 * The `[selected]` block. Both fields must be set for the selection to be
 * valid — a partial selection is treated as "not selected".
 */
```

## src/config/preferences.ts:521

```
/**
 * The config surface the resolver needs.
 *
 * Declared here rather than imported because this module predates the loader:
 * when it landed there was no `LoadedConfig` on this side to depend on. There is
 * now — see {@link configView}, which is how a real config gets in — but the
 * narrowing has earned its keep and stays. `app` carries only the two
 * `[defaults]` keys the chain reads.
 */
```

## src/config/preferences.ts:582

```
/**
 * Resolve a saved `(provider, modelId)` selection against the effective
 * catalog. If the discovery cache was deleted, the pair is reconstructed from
 * the provider registry so cache deletion does not lose the selection.
 *
 * `includeHidden` is always true here: a previously selected discovered model
 * should keep resolving across restarts even if `discovery.ignore` would now
 * hide it. The user chose it explicitly; `discovery.ignore` scopes listing,
 * not restoration.
 */
```

## src/config/preferences.ts:688

```
/**
 * Patch a `ResolvedModel` with a sampler overlay. Returns a fresh model —
 * never mutates the catalog entry.
 */
```

## src/config/preferences.ts:705

```
// always-on reasoning model reasoning by default.
```

## src/config/preferences.ts:815

```
// resolve — almost always a typo. Warn loudly and fall back so the daemon
```

## src/config/preferences.ts:849

```
// merged model and never see the overlay, so there is nothing to gain by
```

## src/config/preferences.ts:862

```
/**
 * The active model for a chat turn, and its overlay, kept apart.
 *
 * Ported from `resolve_active_model_and_overlay` in
 * `crates/daemon/src/handler/mod.rs`. The pair goes straight to
 * `resolveGenerationModel` in `handler/setup.ts`, which decides what to do
 * when there is no model and applies the overlay itself.
 *
 * Same chain as {@link resolveChatModelForCharacter} — that is why they share
 * {@link activeSelection} — and it differs in exactly one argument: the static
 * default is `undefined`, so the overlay carries *only* what preferences say.
 *
 * The catalog's own values would change no field, since the overlay is applied
 * to the model they came from and they sit at the lowest layer. What they would
 * change is whether the overlay is *empty*, because
 * {@link samplerFromResolvedModel} always contributes `sdk` — and emptiness is
 * read twice. It is what lets the request keep the catalog entry itself as its
 * model instead of a copy, and it is what the generation log means by an
 * overlay being active. Fold the catalog in and both are true forever.
 */
```

## src/config/preferences.ts:907

```
/**
 * The preferences a character resolves under, and the model they select.
 *
 * A preferences file that cannot be read is a warning and empty defaults, not
 * a failure: it would otherwise take a character's chat down over a file that
 * only holds overrides, and the chain below still has four more steps.
 */
```

## src/config/preferences.ts:1114

```
// not, so an empty file still shows the schema. Reproduced because the file
```

## src/config/preferences.ts:1146

```
// A TOML float must keep its decimal point: `temperature = 1` re-reads
```

## src/config/preferences.ts:1148

```
// the one place the port has to know a field's TOML type, because a
```

## src/config/preferences.ts:1170

```
/** Always emits a decimal point, so the value re-reads as a TOML float. */
```

## src/config/preferences.ts:1189

```
/**
 * How serde phrases the accepted set. Two fields get `a` or `b`; three or more
 * get a comma list under `one of`. Matching this exactly is what makes the
 * unknown-field errors compare byte for byte.
 */
```

## src/config/app.ts:1

```
/**
 * `AppConfig` — the whole `config.toml` schema.
 *
 * Port of `crates/common/src/config/app.rs`, which is a serde struct tree and
 * almost nothing else: the behaviour worth porting is the *deserializer's*, not
 * any code the Rust wrote by hand.
 *
 * Field names are TOML keys, so they stay snake_case. That is the point — the
 * schema below can be read straight against `CONFIGURATION.md` and against the
 * Rust struct, and the parse errors quote the same identifiers a user typed.
 *
 * ## The walk order is load-bearing
 *
 * `parse_config_table` reaches `AppConfig` as `toml::Value::Table(t).try_into()`.
 * A `toml::Table` is a `BTreeMap` (the crate is built without `preserve_order`),
 * so serde's derived visitor consumes entries in **code point order**, not
 * document order — see {@link readStruct}. The unit tests in `app.rs` use
 * `toml::from_str`, which walks the document instead, so they cannot see the
 * difference and a port written against them alone would report a different key
 * than the daemon does. `app_parity.json` records every case through both paths
 * for exactly this reason.
 *
 * ## Overlap with the narrow views elsewhere in this tree
 *
 * `ToolsConfigView`, `SubagentConfigView` (`tools/registry.ts`),
 * `McpServerConfigView` (`tools/mcp_registry.ts`), `RetrievalConfig`
 * (`memory/workspace_index.ts`), `UsageConfig` (`ledger/budget.ts`) and
 * `NotificationsConfig` (`notifications.ts`) each read a slice of this schema.
 * They were written narrow on purpose, before there was an `AppConfig` to take
 * a slice *of*. The types here are the end state; those views get deleted as
 * their modules are cut over to a `LoadedConfig`, which is the commit after
 * `parse_config_table`.
 *
 * Do **not** reach for `notifications.ts`'s `readNotificationsConfig` from
 * here. It is correct for its own call path, which receives a document, and it
 * checks unknown fields in a pass before reading values. Arriving at the same
 * section through `AppConfig` means the table path, sorted keys, and serde's
 * interleaving of the two checks.
 */
```

## src/config/app.ts:117

```
/**
 * Deserialize a struct the way serde's derived `Visitor` does.
 *
 * The entry walk is sorted, because the source is a `BTreeMap`. Each entry is
 * resolved to a field and its value read **immediately**, before the next entry
 * is looked at — so an unknown key and a badly-typed value race, and whichever
 * sorts first is the one reported. A port that checked every key for
 * unknown-ness first and only then read values would answer differently on
 * `[behavior] zzz_unknown = 1` plus `[behavior.autonomy] enabled = "yes"`:
 * serde descends into `autonomy` (which sorts first) and reports the bad
 * boolean, never reaching `zzz_unknown`.
 *
 * Missing required fields are checked only after the walk, and in declaration
 * order rather than sorted order — a `[subagents.x]` with neither key reports
 * `description`, not whichever of the two sorts first.
 *
 * Sorting that second loop is the one unkillable mutant in this port's
 * mutation pass, and it is a true equivalent rather than a gap: `SubagentConfig`
 * is the only struct with more than one required field, and its two happen to
 * be in sorted order already. The loop stays in declaration order because that
 * is what serde does, not because a case can currently tell.
 */
```

## src/config/app.ts:162

```
/**
 * The other half of a derived struct visitor: `visit_seq`, which fills fields
 * **positionally** from a TOML array.
 *
 * `[behavior] autonomy = []` is therefore not an error — it is an
 * `AutonomyConfig` of pure defaults, and `autonomy = [true]` sets `enabled` and
 * defaults the rest. Nobody writes a config this way on purpose; the reason to
 * port it is that a mistyped `= []` must go the same way in both
 * implementations, and here it succeeds rather than failing.
 *
 * When the array runs out, each remaining field is filled from its
 * `#[serde(default)]` — and the first one that has none stops the whole parse,
 * reporting the number of fields filled *so far* rather than the array's
 * length. `advanced = []` says `invalid length 2`, not `0`, because
 * `api_payload_logging` and `cache_forensics` were defaulted before `editor`
 * (a bare `Option`, which does not count as defaulted here) ran out.
 *
 * Elements past the last field are an error — on this path. Reading the same
 * document with `toml::from_str` ignores them, which is one of only two places
 * the two paths reach different *outcomes* rather than different messages.
 */
```

## src/config/app.ts:210

```
/**
 * A struct whose only member is `#[serde(flatten)] extra: BTreeMap<..>`, under
 * `#[serde(deny_unknown_fields)]` — `[connections.telegram]` and
 * `[connections.discord]`.
 *
 * The two attributes do not compose: serde documents `flatten` as unsupported
 * alongside `deny_unknown_fields`, and what the combination actually produces
 * is a struct that accepts **nothing**. `extra` never receives a key, and any
 * key at all is rejected as unknown — with no `expected` clause, because there
 * are no declared fields to list.
 *
 * So `[connections.telegram] bot_token = "..."` is a hard config-load failure
 * today, not the "reserved for future use" the Rust's doc comment claims. That
 * is ported as-is rather than fixed: nothing reads `connections`, so the only
 * observable behaviour is the rejection, and quietly starting to accept keys
 * here would be a change to what configs load rather than a port of one.
 */
```

## src/config/app.ts:313

```
/**
 * A unit-variant enum.
 *
 * A non-string never reaches the variant check: the deserializer is asked for
 * an enum, sees a scalar, and answers first — and *which* answer depends on the
 * path. `toml::Value`'s deserializer, which is the one production goes through,
 * says `invalid type: unit variant, expected string only`. Reading the same
 * document with `toml::from_str` gets `wanted string or table` instead, which
 * is the message `notifications.ts` carries and is correct for its own path.
 */
```

## src/config/app.ts:335

```
/** `Option<T>`: TOML has no null, so a present key always carries a value. */
```

## src/config/app.ts:751

```
/**
 * The invariants that make compaction meaningful, as an error message or
 * `undefined`.
 *
 * Both turn thresholds must exceed `keep_recent_turns` — otherwise a pass would
 * have nothing to compact — and `max_turns` must not undercut `min_turns`.
 * Config load treats a violation as a hard error so the daemon refuses to start
 * (and a reload keeps the previous config) rather than silently disabling
 * compaction, and with it the deep-idle archive. A disabled config is always
 * valid.
 */
```

## src/config/app.ts:793

```
/**
 * Whether to replay prior turns' extended-thinking blocks.
 *
 * **`all` is the right answer nearly everywhere, and `none` is a compatibility
 * escape hatch — not a cost knob.** The name reads like it saves tokens. It
 * does not, on any provider Shore ships against:
 *
 * - Anthropic keeps prior-turn thinking in context by default on the models
 *   Shore runs, bills input only for the blocks actually shown to Claude, and
 *   documents no intelligence cost for preserving them. Stripping client-side
 *   removes blocks the API would have filtered for free.
 * - Gemini and Kimi K2.5+/K3 require the replay; Z.AI and OpenRouter carry it
 *   in a provider-specific envelope the adapter replays from.
 * - Native DeepSeek discards inbound reasoning server-side, so the setting is
 *   inert there either way (measured 2026-08-08; see `llm/replay.ts`).
 *
 * The one real use is a generic OpenAI-compatible backend that **rejects**
 * inbound `reasoning_content` with an API error. Set `none` for that model to
 * make the request go through.
 *
 * Both modes are prompt-cache-safe: a given history always projects to the same
 * bytes, so neither rewrites something already sent.
 *
 * ## Why there is no context-reclaiming mode here
 *
 * Anthropic's supported way to reclaim context from thinking is the server-side
 * `clear_thinking_20251015` context-editing strategy, not client-side
 * stripping. It is tunable (`keep: {type: "thinking_turns", value: N}`) where
 * this setting is binary, and it reports what it cleared instead of leaving the
 * cost inferred. Shore does not implement it, deliberately: it invalidates the
 * cache at the point where clearing occurs, which is the same trade this
 * setting makes, only stated out loud — and Shore already has a compaction
 * system that owns context pressure. Revisit if compaction starts firing
 * earlier than it should because thinking is what filled the window.
 */
```

## src/config/app.ts:830

```
/**
 * Parse the wire form, tolerating the legacy stringy bools.
 *
 * `last_turn` is a retired third mode that kept only the most-recent assistant
 * turn's thinking. It still maps to `all` rather than being rejected, because
 * rejecting it would stop the daemon starting on any config that still carries
 * it. It was removed because it is the only mode that rewrites already-sent
 * bytes: deleting the trailing turn's thinking one turn later invalidates every
 * cache breakpoint at or past that turn, so each request re-wrote an exchange
 * that `all` reads for free.
 *
 * Case-sensitive — `"All"` is not a variant.
 */
```

## src/config/app.ts:865

```
/**
 * `replay_prior_thinking` accepts the legacy bool as well as the string, via an
 * untagged `enum BoolOrStr` — hence the error text on anything that is neither,
 * which names a type the config file never mentions.
 */
```

## src/config/app.ts:933

```
/** Push the character's workspace repo after a successful compaction. A repo
   *  with no remote is skipped silently; a failed push never fails the pass. */
```

## src/config/app.ts:958

```
/**
 * Reserved for future use — and, today, unable to hold anything.
 *
 * This is the flattened `extra` map itself, not a struct wrapping it, because
 * that is what serde flattening produces on the wire: `[connections.telegram]`
 * serializes as `{}`, with no `extra` key in sight. It is always empty; see
 * {@link readFlattenOnly}.
 */
```

## src/config/app.ts:1026

```
/**
 * Per-event toggles.
 *
 * The Rust's doc comment says "All default to true (fire when enabled)". Five
 * of the six do. `message_complete` is a plain `#[serde(default)]` bool and so
 * defaults to **false** — every ordinary chat reply would otherwise raise a
 * desktop notification. The comment is stale; the defaults here are what the
 * code does.
 */
```

## src/config/app.ts:1071

```
/** Only fire `message_complete` when generation took longer than this. Zero
   *  means always. */
```

## src/config/app.ts:1164

```
/** Sub-window used to pace spend inside `period`; must be strictly shorter.
   *  Stepped from the budget's own window start, so `reset_hour` anchors both
   *  and the sub-windows tile the period exactly. */
```

## src/config/app.ts:1170

```
/**
   * Appended rather than filed next to `warn_at`, and `pace_warn_action` after
   * it, because this struct also deserializes from a positional array — a key
   * inserted mid-list would silently re-map every field after it for anyone
   * writing `budgets = [[...]]`. New keys go on the end.
   *
   * What crossing a `warn_at` threshold does, beyond the warning itself. Unset
   * means it does nothing, which is what it always did.
   */
```

## src/config/app.ts:1190

```
// Overwritten by the walk or reported missing; never observed.
```

## src/config/app.ts:1320

```
/** Deprecated and ignored. Per-call payload capture is always on; the key is
   *  still accepted so older configs keep loading. */
```

## src/config/app.ts:1360

```
/**
 * One delegated sub-agent, surfaced as an `ask_<name>(query)` tool.
 *
 * Running it spins up a nested tool loop on `model` over the listed `tools` and
 * returns the agent's final text. `ask_*` tools are never offered to a
 * sub-agent, so nesting is hard-capped at one level.
 */
```

## src/config/app.ts:1398

```
/**
 * One MCP server the daemon connects to as a client — an external process
 * (stdio) or remote endpoint (HTTP), never daemon code.
 *
 * Exactly one transport should be set, `command` or `url`. That is not enforced
 * here: `validate_mcp_servers` checks it at load time, so the schema stays a
 * schema.
 */
```

## src/config/app.ts:1506

```
/**
 * Deserialize a merged raw TOML table into an `AppConfig`.
 *
 * The table is the one `loadRawConfigTable` produces, minus the sections
 * `parse_config_table` removes first (`chat`, `embedding`, `image_generation`,
 * `providers`) — this function rejects those as unknown fields, exactly as the
 * Rust would if they were left in.
 */
```

## src/config/dirs.ts:92

```
// the relative-XDG guard was dropped from `xdgOrHome` — this runs only when
```

## src/config/dirs.ts:116

```
/**
 * `<home>/<rel>`, where `<home>` is `$HOME` when set and non-empty and the
 * **passwd entry** otherwise — not nothing. The `home` crate treats an empty
 * `HOME` as unset, so this does too.
 *
 * That fallback is why {@link resolveXdgDir}'s last resort is very nearly
 * unreachable: clearing `HOME` does not get there, because `getpwuid` still
 * answers. The fixture pins it — with the whole environment cleared, the daemon
 * resolves to the passwd home's `.config`.
 *
 * **The crate's own relative-XDG guard is not reproduced, because it cannot
 * run.** `dirs::config_dir()` re-reads `XDG_CONFIG_HOME` and ignores it unless
 * absolute — but `resolveXdgDir` only consults the platform lookup when that
 * same variable is *absent*, so the guard would always be handed `None`. The
 * Rust carries the check; here it was a branch no input could take, and
 * mutation testing found it by leaving two mutants unkillable. Dropped, with
 * the consequence recorded: a relative `XDG_CONFIG_HOME` is used as-is by both
 * halves, which is the `cfg/shore` fixture case.
 */
```

## src/config/dirs.ts:151

```
/**
   * Nothing is correct, so refuse — see {@link resolveXdgDir}.
   */
```

## src/config/dirs.ts:161

```
/**
 * Resolve one directory.
 *
 * Precedence: `overrideVar` -> `xdgVar` + `/shore` -> platform + `/shore` ->
 * `lastResort`.
 *
 * The `xdgVar` read looks like a mistake and is the Rust's, faithfully:
 * `std::env::var` yields `Ok("")` for a variable that is set but empty, and
 * `Ok` short-circuits the `or_else` that would have consulted the platform
 * lookup. So `XDG_CONFIG_HOME=""` resolves to the *relative* path `shore`, and
 * a relative `XDG_CONFIG_HOME=cfg` resolves to `cfg/shore` — both of which the
 * platform lookup would have rejected in favour of `$HOME/.config`.
 *
 * # The last resort used to be a tilde, and that was the bug (#45)
 *
 * `config`, `data` and `cache` each carried a shell-notation string literal —
 * `"~/.config"` and friends. Nothing expands a tilde, on either side of the
 * port, so reaching one produced a *relative* path whose first component was a
 * directory literally named `~`, created wherever the process happened to
 * start. They read as though they did something and never had.
 *
 * It is very nearly unreachable, which is why it never bit: clearing `HOME`
 * does not get there, because the passwd entry still answers. It needs no
 * `HOME` **and** no passwd entry for the uid — a container run as
 * `--user 1001:1001` against an image whose passwd only knows uid 1000. The
 * supported configuration sets `SHORE_CONFIG_DIR` and never arrives here.
 *
 * Refusing is the honest answer. A process that can find no home has nowhere
 * right to write, and failing at startup beats writing to `./~/.config/shore`
 * and looking fine.
 */
```

## src/config/dirs.ts:272

```
/**
 * Join path segments the way `PathBuf::push` does, which is not the way
 * `node:path`'s `join` does. Two differences, both reachable here:
 *
 * - **An absolute component replaces the whole path.** `Path::new("/data").join("/etc")`
 *   is `/etc`; `join("/data", "/etc")` is `/data/etc`. This matters because
 *   character names reach these helpers and a name is not always a directory
 *   entry — `resolve_character` accepts one off the wire. The Rust's rule is
 *   the more dangerous of the two and is reproduced rather than improved: a
 *   port that quietly confined a name the daemon does not confine would put
 *   the two halves in different places for the same input, which is worse than
 *   either rule alone. Confinement belongs where the name is admitted.
 * - **Nothing is normalized.** `PathBuf` keeps `a//b` and `a/../b` as written,
 *   where `join` collapses both. An `XDG_CONFIG_HOME` of `a/..` therefore
 *   resolves to `a/../shore` in the daemon and would resolve to `shore` under
 *   `join` — a different directory, silently.
 */
```

## src/config/dirs.ts:310

```
/**
 * `characters/{name}/workspace/`, or `{workspaceRoot}/{name}/` when a
 * workspace root is given.
 *
 * The root is passed rather than read, because every other path helper here is
 * a pure function of its base and the parity fixture drives them that way. A
 * caller that has `ShoreDirs` passes `dirs.workspace`; one that has neither
 * passes nothing and gets the default layout.
 */
```

## src/config/dirs.ts:397

```
/**
 * Character names discovered under `{config_dir}/characters/`.
 *
 * A subdirectory counts if it holds `workspace/SOUL.md` or the legacy
 * `character.md`. An unreadable `characters/` directory yields none, matching
 * the Rust's `let Ok(entries) = read_dir(..) else { return vec![] }` — note
 * that a permissions error is therefore indistinguishable from an absent
 * directory, and neither is an error.
 *
 * The result is sorted by code point, because the Rust sorts `Vec<String>` and
 * `String: Ord` compares bytes. `readdir` order is not sorted on either side,
 * so the sort is what makes this deterministic.
 */
```

## src/config/dirs.ts:418

```
// it is an unkillable mutant. It stays because it is the Rust's own guard and
```

## src/config/dirs.ts:419

```
// because it says what a character is — a directory — at the point that is
```

## src/config/dirs.ts:425

```
// discovering it. The legacy marker is checked either way, because
```

## src/config/dirs.ts:456

```
/**
 * A character's definition: `workspace/SOUL.md`, else the legacy
 * `characters/{name}/character.md`, else nothing.
 *
 * Unlike most readers in this codebase the content is *not* blank-filtered: an
 * empty `SOUL.md` is a definition of the empty string and stops the legacy
 * fallback, because the Rust branches on `read_to_string(..)` being `Ok`.
 */
```

## src/config/loader.ts:1

```
/**
 * Shore's config loading: `config.toml`, `include = [...]`, `conf.d/`, the
 * config-local `.env`, the deep merge that composes them, and the two-phase
 * parse that turns the merged table into a validated `LoadedConfig`.
 *
 * Ports `crates/common/src/config/mod.rs`. The file semantics came first
 * (cab4f1a5) because everything in that half operates on raw TOML tables and
 * could move before `app.rs` did; `parseConfigTable` and `validateConfig` are
 * the rest, and they need `AppConfig`, `ModelCatalog` and `ProviderRegistry`
 * all three.
 *
 * `deepMerge` is the whole reason the raw table is retained on a loaded config
 * at all. A character override is applied to the *unparsed* global table and
 * the result re-parsed from scratch, rather than merged field-by-field over a
 * parsed struct — so a character can set `[tools] enabled_tools` without
 * inheriting the global list, and a table it does not mention keeps every
 * global key.
 */
```

## src/config/loader.ts:75

```
/**
   * The message the Rust's `thiserror` `#[error(..)]` attribute produces.
   *
   * Only the semantic half is reproduced. The `toml` crate decorates a parse
   * error with a line/caret frame whose shape is inconsistent between
   * otherwise identical failures, and three earlier fixtures in this series
   * already stop short of it for the same reason.
   */
```

## src/config/loader.ts:109

```
/**
 * Recursively merge `overlay` into `base`, in place.
 *
 * Tables recurse; everything else is overwritten wholesale. Arrays in
 * particular are *replaced*, not concatenated — a character's
 * `tools.enabled_tools` is its own list and not an addition to the global one.
 *
 * The walk is over `overlay`'s keys in code-point order, matching the Rust's
 * iteration of a `toml::Table` (`BTreeMap`, since the `toml` crate is built
 * without `preserve_order`).
 *
 * That sort is an unkillable mutant and is kept deliberately. Every key is
 * written exactly once, so the merged *contents* cannot depend on the order;
 * what does depend on it is the merged object's own key order, which decides
 * which key a later `deny_unknown_fields` parse reports first when a document
 * has two bad ones. Every consumer in this codebase reaches that table through
 * `sortedKeys`, so nothing observes it today — but a consumer that walks the
 * table directly would, and it would then disagree with the daemon. Removing
 * the sort makes the port correct only for as long as that stays true.
 */
```

## src/config/loader.ts:187

```
// a line because the failure it makes visible is otherwise silent: the
```

## src/config/loader.ts:208

```
/**
 * Merge every `*.toml` under `dir` into `table`, in sorted filename order.
 *
 * A missing directory is not an error. Any *other* read failure is, and
 * deliberately so — the Rust distinguishes `NotFound` from a permissions or
 * I/O error precisely so that an unreadable `conf.d/` cannot silently load a
 * partial config.
 *
 * The extension test is `path.extension() == "toml"`, which is case-sensitive
 * (`.TOML` is skipped) and which yields `None` for a file named exactly
 * `.toml` — a dotfile with no stem has no extension in Rust's model, so it is
 * skipped too. Both are pinned.
 */
```

## src/config/loader.ts:254

```
/**
 * Load `config.toml` plus its `include` list and `conf.d/` overlays into one
 * raw table, without deserializing any schema.
 *
 * Ordering is load-bearing and is the Rust's: `config.toml` first, then each
 * `include` entry in the order written, then `conf.d/*.toml` sorted by path.
 * So `conf.d` wins over `include`, which wins over `config.toml` — and `include`
 * files override the very file that listed them, which reads backwards until
 * you notice `include` is removed from the table before the merge.
 *
 * A missing `config.toml` is not an error: the Rust writes a commented starter
 * file and continues with an empty table. That write is a side effect on a
 * caller-supplied directory, so it is opt-in here via `createDefault` rather
 * than fired implicitly by a function whose name says "load".
 *
 * {@link createDefaultConfig} is that effect, and `startDaemon` is what opts in.
 * Anything else — a reload, a `config --check`, a test — loads without it and
 * writes nothing.
 */
```

## src/config/loader.ts:302

```
// `include` is *removed*, not merely read, so it never reaches `AppConfig`
```

## src/config/loader.ts:399

```
/**
 * Write {@link DEFAULT_CONFIG_TOML} into a config directory that has none,
 * creating the directory first.
 *
 * This is the effect {@link loadRawConfigTable}'s `createDefault` hook exists
 * for — kept here beside the template it writes, and passed in from the daemon's
 * composition root rather than fired by the loader itself.
 *
 * Neither half is fatal. The Rust `warn!`s and continues on both, because a
 * read-only config directory is a legitimate deployment — a container with the
 * config baked in and `SHORE_ADDR` doing the rest — and a daemon that can talk
 * must not refuse to start over a starter file nobody will edit.
 *
 * Returns the path written, or `undefined` if either half failed, so the caller
 * can say where it went. A first run has no other way to find out.
 */
```

## src/config/loader.ts:438

```
/**
 * Where an advisory config diagnostic goes.
 *
 * The Rust emits these through `tracing`, whose subscriber is ambient and
 * swappable; this is the same seam, made explicit because the sidecar has no
 * ambient log context to swap. It is not decoration — `validateConfig`'s entire
 * job is deciding which bad reference blocks startup and which merely warns,
 * and five of its six advisory paths have no other observable effect. A sink
 * that could not be observed would make those paths untestable.
 *
 * `fields` are the structured key/value pairs in emission order, matching what
 * the `warn!` call site attaches.
 */
```

## src/config/loader.ts:484

```
/**
 * Deserialize a merged TOML table into a validated `LoadedConfig`.
 *
 * The model sections are lifted out before `AppConfig` — which is
 * `deny_unknown_fields` — ever sees the table, which is the only reason
 * `[chat.*]` is not an unknown-field error. Four names are lifted: `chat`,
 * `embedding`, `image_generation` and `providers`.
 *
 * `[tools]` is deliberately NOT among them. It used to be the model catalog's
 * second category and is now the tool-surface section of `AppConfig`, so
 * lifting it would silently discard the entire tool allowlist rather than fail.
 *
 * The lift is unconditional but the *use* is `as_table()`, so `chat = "nope"`
 * is removed and then silently ignored — neither an unknown field nor a catalog
 * error. Pinned, because it is invisible from any valid config.
 *
 * Order is load-bearing and is the Rust's: `AppConfig` first, so a bad section
 * name beats a bad `[providers.*]` entry; then the registry, so a bad provider
 * beats a bad `[chat.*]` model; then the catalog, which inherits the registry's
 * transport defaults; then validation.
 */
```

## src/config/loader.ts:531

```
// about that value names the key it was moved to, never the key the user
```

## src/config/loader.ts:610

```
/**
 * Cross-field validation, run once the catalog and registry exist.
 *
 * The split between reject and warn is the point of this function, and it is
 * not uniform:
 *
 * - **Chat defaults warn.** An active model can be chosen at runtime through
 *   per-character preferences, and the runtime resolver accepts discovered
 *   `provider:model_id` refs the static catalog never saw. A bad one must not
 *   stop the daemon from starting, because the fix does not require editing
 *   the file.
 * - **Enabled sub-agents reject.** Their model chain has no per-character
 *   override, so an unresolvable one would surface on first `ask_<name>` call
 *   instead. Disabled sub-agents fall back to warning — they are never exposed.
 * - **Embedding and image_generation reject.** An embedding swap invalidates
 *   every vector store, and these globals have no runtime override at all.
 *
 * The order of the checks is observable whenever a config has more than one
 * fault, since the first one throws. It is pinned by a dozen cases in
 * `validate_parity.json` and is not free to change.
 */
```

## src/config/loader.ts:709

```
/**
 * Each `[mcp.*]` server must set exactly one transport, `command` xor `url`.
 *
 * The test is presence, not non-emptiness: `command = ""` is a transport and
 * loads. That distinction does not survive a truthiness check, which is the
 * whole reason it is spelled out.
 *
 * The advisory sweep afterwards catches an `mcp__<server>__*` grant naming a
 * server with no definition, which would silently grant nothing.
 */
```

## src/config/loader.ts:735

```
// block there is always a mistake — most likely a server the operator
```

## src/config/loader.ts:768

```
/**
 * Validate `[usage]`.
 *
 * Every numeric guard here is a float comparison written as "reject the bad
 * range", so NaN — which compares false against everything — passes all of
 * them. `multiplier = nan` loads. That is the Rust's behaviour and the port
 * reproduces it rather than tightening it, because tightening it here would
 * make the sidecar reject a config the daemon accepts.
 */
```

## src/config/loader.ts:806

```
// A blank name becomes its 1-based index, so two blanks never collide with
```

## src/config/loader.ts:817

```
/** Anchors must be in range *and* belong to the period they anchor. */
```

## src/config/loader.ts:854

```
/**
 * A pace sub-window must be strictly shorter than the period it subdivides:
 * an equal pace makes the allowance the budget itself, and a longer one has no
 * defined division.
 *
 * `pace_action` / `pace_warn_at` / `pace_warn_action` with no `pace_period` are
 * rejected rather than ignored, so a typo fails at load instead of silently
 * doing nothing.
 */
```

## src/config/loader.ts:894

```
/**
 * Check the `provider_key` half of an aux (`embedding` / `image_generation`)
 * ref against the registry.
 *
 * A **disabled** provider is a hard error: it yields zero key candidates, so
 * the aux resolver can never succeed, and failing here keeps config load in
 * lockstep with runtime instead of passing validation and dying at resolve
 * time. An **absent** provider only warns — well-known keys resolve through
 * built-in transport defaults, and the credential check happens at runtime.
 */
```

## src/config/loader.ts:932

```
/**
 * `defaults.embedding` must be a `provider:model_id` identity.
 *
 * Shore ships only a hosted OpenAI-compatible embedder — there is no runtime
 * local one — so a bundled id is rejected here rather than validating and then
 * degrading to lexical search at runtime.
 */
```

## src/config/loader.ts:1025

```
/**
 * Warn when an optional default-model reference cannot be reconciled with the
 * catalog or the registry. Never throws — every caller is advisory.
 *
 * A name with an empty half is not `provider:model_id` form at all, so it falls
 * through to the generic message rather than reporting an empty provider. The
 * aux validators above make the opposite choice on the same input, which is
 * why they do not share this code.
 */
```

## src/config/providers.ts:97

```
/**
   * Gitignore-style patterns evaluated against an upstream model id.
   *
   * Patterns are evaluated in order and the last match wins. A bare pattern
   * hides matched ids; a `!` prefix un-hides them. Ids matching nothing stay
   * visible. Only discovered models are affected — manual `[chat.*]` entries
   * never are.
   */
```

## src/config/providers.ts:129

```
/**
 * A star-only glob. `*` matches any run of characters, `/` included;
 * everything else matches literally. Enough for the patterns configs actually
 * use — a vendor prefix with a trailing star, a leading star with a `/free`
 * suffix, a version prefix with a trailing star.
 *
 * The Rust indexes `&str` by byte offset while this indexes UTF-16 units, and
 * the two never disagree: every length compared here — the literal edges, the
 * search window, the cursor — is measured against the same subject in the same
 * unit, and the edges are always substrings of that subject. An earlier draft
 * converted both sides to bytes to be safe; mutation testing showed no input
 * could tell the two apart, so the conversion was removed rather than left as
 * unexplained ballast.
 *
 * `middle === ""` cannot arise from a split on a non-empty separator except
 * between adjacent stars, where skipping and not skipping agree — `indexOf("")`
 * is 0 and leaves the cursor put. The guard mirrors the Rust's own.
 */
```

## src/config/providers.ts:160

```
// A cursor past `end` yields an empty window, and an empty window never
```

## src/config/providers.ts:197

```
/**
   * Compact single-key form, folded into a synthetic `default` key at parse
   * time so downstream consumers only ever see `keys`. Always absent after
   * {@link registryFromSection}.
   */
```

## src/config/providers.ts:218

```
/**
 * The same entry in the shape `llm/credentials.ts` reads.
 *
 * The twin of `toRequestModel` in `./models.ts`, for the same reason and with
 * the same rule: the credential resolver was ported against the sidecar's
 * snake_case mirror before this module existed, so there are two spellings of
 * one Rust type. Convert here, never at a call site.
 *
 * The credentials side models only `enabled` and `keys` — deliberately, since
 * nothing about resolving a key needs transport or discovery — so this drops
 * the rest rather than renaming it. `warnOnFallback` is the single field whose
 * spelling actually differs.
 */
```

## src/config/providers.ts:315

```
// Reject it there so there is exactly one home for sdk/base_url/credentials.
```

## src/config/providers.ts:490

```
/**
 * How serde phrases the accepted set. Two fields get `a` or `b`; three or more
 * get a comma list under `one of`. Matching this exactly is what makes the
 * unknown-field errors compare byte for byte.
 */
```

## src/config/models.ts:1

```
/**
 * The model catalog: the nested `[chat.<provider>.<model>]` structure, the
 * cascade that resolves it, and the hardcoded provider defaults underneath.
 *
 * Port of `crates/common/src/config/models.rs`.
 *
 * This is the first module on the TypeScript side to own *configuration*
 * rather than receive it. Everything ported before it took a narrow view
 * struct handed down by the Rust daemon, because the Rust daemon owned config.
 * `preferences` and `effective_catalog` are the resolution layer themselves, so
 * there is nobody upstream left to hand them a view — the parsing has to live
 * here.
 */
```

## src/config/models.ts:73

```
/**
 * `to_ascii_lowercase`, not `toLowerCase`.
 *
 * No current input distinguishes the two: every off spelling is pure ASCII, so
 * for a full-Unicode fold to reach one, the input would already have to be
 * ASCII. This is a guarantee about the *next* spelling rather than a live
 * behavioural difference — add a non-ASCII one (or one containing `k`, which
 * the Kelvin sign U+212A folds into) and the two rules diverge immediately.
 */
```

## src/config/models.ts:153

```
/**
 * The configuration fields shared by provider configs, model entries and
 * resolved models. Every field is optional — absent means "inherit from the
 * next level up" (model → provider → hardcoded defaults).
 *
 * The first three — `sdk` / `apiKeyEnv` / `baseUrl` — are **transport**, not
 * behavioral overlay. Transport has a single authoritative home, the
 * `[providers.<name>]` registry entry; these survive here only for the legacy
 * static `ModelEntry` path and for {@link ResolvedModel}, where they hold
 * *resolved* transport. Don't reintroduce them as an overlay knob.
 */
```

## src/config/models.ts:283

```
/**
 * Prior-thinking replay for this model: the per-model overlay when set,
 * otherwise the global `[memory.thinking]` default.
 *
 * The one place the two-level fallback is resolved, so a caller cannot
 * silently ship the global default to a model that overrode it.
 */
```

## src/config/models.ts:297

```
/**
 * The same model in the shape `llm/request.ts` reads.
 *
 * Rust has one `ResolvedModel`. Here there are two, because the request builder
 * was ported against the sidecar's snake_case wire mirror months before the
 * catalog itself moved and grew this camelCase one. They describe the same
 * struct and the split is a port artefact rather than a design — but collapsing
 * them touches every adapter, so until that happens the conversion lives here,
 * in the module that owns the catalog spelling, and nowhere else. Do not
 * open-code it at a call site.
 *
 * Two fields are not a rename. `cacheKeepalive` is parsed here and stringly
 * over there, so it goes back through {@link ConfigDuration.toString}, which is
 * documented to round-trip through `parse` — the request builder re-parses it
 * immediately. `replayPriorThinking` and `maxToolIterations` have no
 * counterpart at all: the builder takes the replay policy as an explicit
 * argument, and nothing about a tool loop reaches a single request.
 */
```

## src/config/models.ts:397

```
// Drop sampler knobs the model's wire rejects so a baked-in default never
```

## src/config/models.ts:523

```
/**
 * The parsed model catalog.
 *
 * Every map is in Rust `BTreeMap` order — code-point sorted by key, not
 * insertion order. `firstChatModel` reads the first entry, so the order is
 * load-bearing, not cosmetic.
 */
```

## src/config/models.ts:714

```
/**
 * What to say when the catalog is empty: the state, and the two edits that fix it.
 *
 * Shared rather than written twice. `config --check` has always said this well
 * and a `send` into the same empty catalog used to answer "No model configured"
 * — true, and no help at all about where to go next (#31). One constant is what
 * keeps the two from drifting apart again.
 */
```

## src/config/models.ts:739

```
/**
 * Parse a category section (`[chat]`) into resolved models keyed by qualified
 * name.
 *
 * Provider-level defaults no longer live here — they were rehomed onto
 * `[providers.<provider>.defaults]`. Scalar keys directly under
 * `[<category>.<provider>]` are therefore rejected with a migration error.
 *
 * Keys are walked in `BTreeMap` order because the first offending key is the
 * one that throws, and that key has to be the same one Rust picks.
 */
```

## src/config/models.ts:787

```
// Credentials intentionally do NOT cascade through this path: the
```

## src/config/models.ts:802

```
// is kept because it states the intended precedence for the day
```

## src/config/models.ts:1066

```
/**
 * How `serde::de::Unexpected` renders a value: strings in double quotes,
 * every other scalar in backticks.
 *
 * Sequences and maps render as the bare type name with no value — serde's
 * `Unexpected::Seq` and `Unexpected::Map` carry nothing to print. Nothing in
 * the model catalog reaches either (its fields are all scalars), but `AppConfig`
 * does, and `[defaults] model = []` must say `invalid type: sequence, expected
 * a string` rather than inventing a rendering of the array.
 */
```

## src/config/models.ts:1260

```
/**
 * `ResolvedModel` as serde wrote it, for the command surface that ships one to
 * a client.
 *
 * Not {@link toRequestModel}, and the differences are deliberate rather than
 * incidental: this writes **every** field, spelling absent as `null` where the
 * request builder omits it, and it carries `replay_prior_thinking`, which the
 * request builder drops because the wire takes the replay policy as a separate
 * argument. Field order follows the Rust struct so a diff against a recorded
 * payload reads in the same order as the declaration.
 */
```

## src/config/dotenv.ts:1

```
/**
 * The config-local `.env`, which is where Shore's provider keys actually live.
 *
 * Ports the `dotenvy::from_path_override` call in
 * `crates/common/src/config/mod.rs::load_raw_config_table`. The Rust reached for
 * a crate; there is no equivalent dependency here, and the format is small
 * enough that the parser is cheaper than the dependency — so the grammar
 * dotenvy accepts is reproduced below rather than imported.
 *
 * # Why this file is load-bearing
 *
 * `[providers.<key>] api_key_env` names an environment variable, and
 * `readCandidateEnv` reads it off `process.env` at the moment of the call. In a
 * container nothing else populates those variables: the compose file passes
 * `TZ` and the Shore directories and no secrets at all, because the keys are
 * mounted as `/config/.env` instead. A daemon that does not read this file has
 * no credentials for any provider, and every generation fails before it reaches
 * the network.
 *
 * # `override`, not `fill`
 *
 * dotenvy has both, and the Rust chose `from_path_override`: a value in the
 * file wins over one already in the process environment. That is the direction
 * that lets the mounted file be the source of truth regardless of what the
 * image or the shell happened to export, and it is what {@link applyDotenv}
 * does.
 */
```

## src/config/dotenv.ts:211

```
// Whitespace is held back rather than appended, so trailing whitespace never
```

## src/config/dotenv.ts:212

```
// lands in the value and no trim is needed afterwards — which matters because
```

## src/config/serialize.ts:1

```
/**
 * `serde_json::to_value` for the config structs.
 *
 * The `config` command ships the effective `AppConfig` and the built-in default
 * `AppConfig` side by side so a client can show what the user actually changed.
 * That makes the serialised shape a wire format, not an implementation detail,
 * which is why this is a named function with its own parity rows rather than a
 * `JSON.stringify` at the call site.
 *
 * Four rules are the whole of it, and they are all serde's:
 *
 * - **Field names pass through.** The interfaces in `app.ts` are already spelled
 *   the way the Rust structs are, so there is no case conversion to get wrong.
 * - **`Option::None` is `null`,** not an absent key. A field that is
 *   `undefined` on this side has to appear, spelled `null`.
 * - **A `BTreeMap` is an object with sorted keys.** `subagents` and `mcp` are
 *   maps, and the Rust's ordering is the `BTreeMap`'s, so the keys are sorted
 *   by code point rather than left in insertion order.
 * - **A `ConfigDuration` is its `Display`,** which `toString` already matches.
 *
 * Object key *order* is not part of the contract — the fixture is compared
 * structurally — but the sorted map keys are, because a client that renders the
 * sub-agent roster in the order it receives shows them alphabetically.
 */
```

## src/config/serialize.ts:28

```
/**
 * One value, as serde would have written it.
 *
 * Recursive and untyped on purpose: the config tree is plain data, and a walk
 * that knows every struct by name would have to be edited every time a field is
 * added — exactly the kind of second copy that drifts.
 */
```

## src/config/duration.ts:1

```
/**
 * Systemd-style duration strings (`500ms`, `30s`, `2m`, `1h`, `2d`), the shape
 * every duration-valued config key accepts.
 *
 * Port of `crates/common/src/config/duration.rs`. A bare integer means
 * *seconds*, for backwards compatibility with the pre-suffix config format.
 *
 * Values are milliseconds held as `bigint` rather than `number`. The Rust type
 * is a `u64` and reports "duration too large" exactly at that boundary; a
 * double would round near it and disagree about which inputs are errors. Every
 * real config value is minutes-to-hours, so callers should reach for
 * {@link ConfigDuration.asMillis} and never notice.
 */
```

## src/config/duration.ts:24

```
/**
 * Trim exactly what Rust's `str::trim` trims: characters with the Unicode
 * `White_Space` property.
 *
 * Not `String.prototype.trim`, which disagrees at both ends — it strips U+FEFF
 * (which Rust keeps, making the string an invalid duration) and keeps U+0085
 * (which Rust strips, making the string a valid one). Both are reachable from a
 * hand-edited config file.
 *
 * Exported because `validateConfig` trims budget names before comparing them
 * for uniqueness, and a name is exactly as hand-edited as a duration is.
 */
```

## src/config/duration.ts:50

```
/**
   * Parse a duration string. A bare integer is seconds; otherwise a decimal
   * (optionally fractional) followed by `ms` / `s` / `m` / `h` / `d`.
   */
```

## src/config/duration.ts:141

```
/**
   * The canonical spelling: the largest unit that divides the value exactly.
   * `0` is `"0s"`. This is what gets written back to TOML, so it has to
   * round-trip through {@link ConfigDuration.parse}.
   */
```

## src/config/duration.ts:219

```
// The `"."` half of this guard is redundant with the both-halves-empty check
```

## src/config/duration.ts:220

```
// below, which catches the same input with the same message. Kept because
```

## src/config/duration.ts:233

```
// (`.s`) — which is the both-halves-empty case, and the reason the guard
```

## src/config/duration.ts:271

```
/**
 * `millis_from_secs_f64`: seconds as a float, via `Duration::try_from_secs_f64`.
 *
 * Two distinct errors, and which one fires is observable. `try_from_secs_f64`
 * rejects NaN, infinities and negatives outright; a finite value that survives
 * it can still exceed `u64` milliseconds afterwards. Sub-millisecond values
 * truncate to zero rather than rounding, because `as_millis` truncates.
 */
```

## src/config/restart.ts:1

```
/**
 * Which parts of a reloaded config a running daemon cannot pick up.
 *
 * Ported from `restart_required_changes` in `crates/daemon/src/handler/mod.rs`.
 *
 * Almost everything in the config is read per-turn, so a reload takes effect on
 * the next message. These five are read exactly once, while the process is
 * starting: `[daemon]` becomes the bound listener, `[notifications]` becomes the
 * notifier that every task was handed, `[advanced].llm_sidecar` decides whether
 * a sidecar was launched and on which socket, and the two `[advanced]` logging
 * switches decide which writers were opened. Adopting a new value for any of
 * them changes the config the daemon reports while changing nothing it does.
 *
 * So the reload still happens — that is the point of the annotation rather than
 * a refusal — and the client is told which sections it will not see move. A
 * `config_reload` puts this list in `restart_required`; the hot-reload watcher
 * logs it.
 */
```

## src/config/restart.ts:47

```
/**
 * `PartialEq` for a config section.
 *
 * The sections hold `ConfigDuration`s, which are objects and so never `===`
 * even when they mean the same length of time. {@link serializeConfigValue}
 * already renders one as its canonical string — it is how the `config` command
 * puts these same structs on the wire — so comparing the serialised forms costs
 * one walk and inherits every rule that surface already has to get right.
 *
 * The walk below is structural rather than a `JSON.stringify` comparison
 * because key order would otherwise be part of the answer. It is stable today,
 * since both configs come out of the same field-by-field builders, but nothing
 * says it has to stay that way.
 *
 * The array branch of `equal` is in the same position since
 * `[daemon].allowed_hosts` was removed: none of the three sections compared
 * here holds a list any more, so nothing reachable from this function exercises
 * it. It stays for the same reason the key-count check does.
 *
 * For the same reason, the key-*count* check in `equal` cannot be observed
 * through this function and no test can kill a mutant that drops it: `readStruct`
 * builds every section from its defaults and rejects any field it does not know,
 * none of these three sections holds a map, and a `None` serialises to `null`
 * rather than to an absent key. So both sides always have identical key sets. It
 * stays because `equal` is a general comparison and being right about one input
 * shape is not the same as being right.
 */
```

## src/autonomy/registration.ts:1

```
/**
 * Joining a chat turn to the autonomy loop.
 *
 * Two halves of one seam. `registrationFor` reads the config sections a
 * character's loop runs on; {@link TurnAutonomyBridge} is what `handler/turn.ts`
 * calls into, and it exists because the two sides disagree about time.
 *
 * # The disagreement
 *
 * {@link TurnAutonomy} is synchronous — a turn asks "should I compact?" and
 * needs the answer before it continues. {@link AutonomyService.register} is not:
 * it reads `autonomy_state.json` off disk and shuts down any runner it is
 * replacing. So the first turn for a character arrives before the loop knows
 * that character exists.
 *
 * Every write is queued behind the registration rather than dropped. The one
 * that cannot be is `shouldCompactNow`, which has to answer *now* and takes a
 * single-flight latch when it says yes — so before registration finishes it
 * says **no**. That is the safe direction: the turn after this one asks again,
 * and a conversation compacts a few turns late. Answering yes would take a
 * latch on a runner that does not exist, which releases never.
 *
 * # Why the seeding moment matters
 *
 * `ensureState` returns true exactly once per character, and that return is the
 * only signal `ensureAndBackfillAutonomy` gets to walk the conversation and
 * seed the activity tracker. Returning true twice re-seeds a heatmap that
 * already has counts in it; returning it zero times leaves a character's
 * activity blank until it has talked for a fortnight.
 */
```

## src/autonomy/registration.ts:54

```
/**
 * The `[memory.compaction]` half on its own, because a reload replaces it
 * without touching anything else — see {@link TurnAutonomyBridge.reloadConfig}.
 */
```

## src/autonomy/heartbeat_shape.ts:32

```
/**
 * Text between XML-style tags, last match wins.
 *
 * Last-wins rather than first because a model that reconsiders mid-turn writes
 * a second tag rather than editing the first, and the second is the one it
 * meant. Empty and whitespace-only bodies do not count as a match at all, so a
 * trailing `<sendMessage></sendMessage>` cannot silently erase a real message
 * earlier in the same response.
 *
 * An unclosed opening tag ends the scan. The text after it is not a message:
 * the model was cut off mid-write, and delivering the fragment would send the
 * user half a thought.
 */
```

## src/autonomy/heartbeat_shape.ts:166

```
/**
 * Put the wrap-up nudge where a provider will accept it.
 *
 * Anthropic rejects two consecutive user turns, and the request almost always
 * ends on one — the tool results from the round just finished. So the nudge
 * folds into that message as an extra block, and only becomes a message of its
 * own when the request happens to end on an assistant turn or is empty.
 */
```

## src/autonomy/heartbeat_shape.ts:187

```
/** Filled in just before the message goes on the wire, never here. */
```

## src/autonomy/rebuild.ts:1

```
/**
 * The body a heartbeat reuses and a keepalive pings, rebuilt from disk.
 *
 * Ported from `heartbeat_rebuild_messages`, `heartbeat_idle_anchor_message` and
 * `rebuild_request_from_disk` in `crates/daemon/src/autonomy/manager.rs`, pinned
 * by `tests/autonomy_fixtures/last_request_parity.json`.
 *
 * There is normally a cached `last_request` — the body a chat turn just sent,
 * still warm against the provider's prompt cache. This is what happens when
 * there is not: a restart, a compaction that invalidated it, or a character that
 * has not spoken since the process came up. The rebuild reads `active.jsonl` and
 * produces the request chat's *next* turn would have sent, so the prefix it
 * seeds is one a real turn can extend rather than a shape only background work
 * uses.
 *
 * # Empty is not "nothing to do"
 *
 * A conversation with no messages still has a system prompt and a memory index,
 * which is plenty for a heartbeat to act on and exactly what the keepalive wants
 * to keep warm. So an empty conversation gets a synthetic anchor turn rather
 * than a skip. The only real reason to skip is a conversation that is *mid-turn*
 * — a dangling tool-result tail, or a user message still waiting on an answer —
 * because anchoring onto one builds a request the provider rejects.
 *
 * # Why an anchor at all
 *
 * Providers merge the heartbeat's instruction into the immediately preceding
 * user message (`pushInlineSystem`), so a tick with no live user turn has
 * nothing to attach to. The anchor is one bracketed user message that says the
 * earlier conversation was archived. It exists only in the rebuilt in-memory
 * request and is never persisted, so it can never displace a warm chat prefix —
 * it appears only in the cold state where there is no prefix to displace.
 */
```

## src/autonomy/rebuild.ts:117

```
/**
 * The synthetic user turn a cold rebuild attaches to.
 *
 * A fresh id and timestamp per call, matching the Rust's `Uuid::new_v4()` and
 * `Local::now()`. Both are injectable so a replay can pin them; production takes
 * the defaults. The content block carries the same text as `content`, because a
 * block-less turn is an empty turn and an empty turn anchors nothing.
 */
```

## src/autonomy/rebuild.ts:142

```
/**
   * The live MCP surface. Passed rather than defaulted, because the whole point
   * of including it is that it matches what chat sends — see the note on
   * `buildChatShapeRequestFromDisk`.
   */
```

## src/autonomy/rebuild.ts:155

```
/**
 * The request chat's next turn would send, built from what is on disk.
 *
 * `undefined` for the two reasons the Rust returned `None`: the conversation is
 * mid-turn, or no chat model resolves. Both are "do not ping and do not tick",
 * and the caller's job on either is to disarm rather than to keep the old body
 * armed.
 *
 * The *chat* model, not a heartbeat one. A heartbeat applies its own override
 * after this returns; the keepalive must not, because it is refreshing chat's
 * prefix and a heartbeat-only model would warm the wrong thing.
 */
```

## src/autonomy/in_process.ts:1

```
/**
 * Running an autonomy action in this process, instead of asking the daemon to.
 *
 * The replacement for `RpcAutonomyExecutor`. That one exists because the three
 * things a tick can decide to do all reached the filesystem, MCP and sub-agents
 * — none of which lived on this side — so each became a call back over the
 * daemon's socket. All three have ported, so each becomes a function call.
 *
 * # This class holds almost nothing
 *
 * Every action is already a module: `heartbeat_tick.ts`, `idle_compaction.ts`,
 * `deep_archive.ts`. What is left here is the wiring each one needs and cannot
 * assemble for itself — the character's effective config, its conversation
 * engine, the provider adapters, the tool surface — and one translation per
 * action. Anything that looks like a decision in this file is a bug in it.
 *
 * # Where `set_next_wake` comes from
 *
 * Not from here. The clock a heartbeat moves belongs to `CharacterAutonomy`,
 * which is also what calls this, so the scheduling function arrives per tick as
 * {@link TickHooks} rather than being reached for. The alternative — this
 * holding the service that holds this — is the same wiring with a cycle in it.
 */
```

## src/autonomy/in_process.ts:117

```
// `dispatch_heartbeat_tools` exactly: it called `dispatch_tool` bare,
```

## src/autonomy/in_process.ts:131

```
// A tool's failure is text the model reads, with a flag — never a
```

## src/autonomy/in_process.ts:243

```
/**
 * The compaction seam's `generate`, which is told its model rather than
 * resolving one.
 *
 * Passed through rather than re-derived: the pass built the request against
 * that exact model, and `resolveModelForRequest` would have to find it again in
 * the static catalog — which a discovered model or a `provider:model_id` pin is
 * never in. Re-resolving would silently drop those passes to a single key.
 *
 * Exported because a chat turn's inline compaction is the same pass with a
 * different trigger, and `handler/deps.ts` needs the same call. Two spellings of
 * it would be two credential-rotation policies for one operation.
 */
```

## src/autonomy/heartbeat_loop.ts:1

```
/**
 * The heartbeat's tool loop, and the two tools it answers itself.
 *
 * Ported from `run_heartbeat_tool_loop` and `dispatch_heartbeat_tools` in
 * `crates/daemon/src/autonomy/manager.rs`.
 *
 * A heartbeat is a private turn. The character gets real tools and up to half an
 * hour of wall clock, and everything it does — every thought, every tool result
 * — is thrown away when the tick ends. The only two things that survive are what
 * it wrote to disk with a workspace tool, and whatever it asked to say. So this
 * loop's real output is not the conversation it builds; it is
 * {@link HeartbeatLoopResult}.
 *
 * # Not `runToolLoop`
 *
 * The generic loop in `engine/tool_loop.ts` counts rounds and stops. This one
 * also watches a wall clock, and when either limit is reached it does not stop —
 * it spends a one-time nudge that buys the model a grace window to finish its
 * thought and write anything durable down. That is a different control flow, not
 * a configuration of the same one, and modelling it as `CapBehavior` would mean
 * teaching the generic loop about a deadline no other caller has.
 *
 * # Two undeclared tools
 *
 * `set_next_wake` and `sendMessage` are deliberately *not* in the tools array.
 * Declaring them would make the heartbeat's array differ from chat's, and the
 * two arrays being byte-identical is what lets a heartbeat run against the
 * prefix chat already paid to cache. So the prompt tells the model they exist
 * and this loop intercepts the calls by name, rather than letting them fall
 * through to `NotImplemented` and teaching the model they do not work.
 */
```

## src/autonomy/heartbeat_loop.ts:71

```
/**
   * One model call. `undefined` ends the loop — the Rust logged the error and
   * broke, because a heartbeat that cannot reach its model has nothing to
   * retry against and the next tick is an hour away at worst.
   */
```

## src/autonomy/heartbeat_loop.ts:81

```
/** Run one declared tool. Never throws; a failure comes back with the flag. */
```

## src/autonomy/heartbeat_loop.ts:120

```
/**
 * Run every tool call from one round.
 *
 * Two names never reach the tool registry. `set_next_wake` is answered from the
 * clock, and its ring-buffer line is left to the scheduler that clamps the value
 * — pushing another one here would log the same call twice. `sendMessage` is
 * acknowledged as delivered even though nothing has been delivered yet: the text
 * was already taken into the send-message sink by the caller, and the tick will
 * persist it when it ends. Telling the model "not yet implemented" instead just
 * teaches it to retry a tool that worked.
 */
```

## src/autonomy/heartbeat_loop.ts:175

```
// with the clamped value this side never sees.
```

## src/autonomy/heartbeat_loop.ts:182

```
/**
 * Drive the tick's rounds until the model stops, the budget runs out, or a call
 * fails.
 *
 * `request` is appended to as the loop runs and is thrown away afterwards —
 * every turn the model takes here is ephemeral. It must be the tick's own copy;
 * see `heartbeat_request.ts` for what appending to the cached one would cost.
 */
```

## src/autonomy/cache_keepalive.ts:1

```
/**
 * Keeps a model's prompt cache warm during quiet stretches.
 *
 * Ported from `crates/daemon/src/cache_keepalive.rs`. Structure, field names,
 * and method names are kept deliberately close to the Rust so the two can be
 * diffed while both exist. Nothing calls this yet — the daemon still drives
 * the live schedule; see the module note at the bottom.
 *
 * **Read the comments before changing anything here.** Almost every branch in
 * this file exists because a previous version of it spent real money. The two
 * failure modes it is built to prevent:
 *
 *   - **Pinging a cold cache.** A ping that reads nothing pays a full cache
 *     write, which is strictly worse than not pinging at all — the user may be
 *     hours from returning, and the prefix will have expired again by then.
 *     Every guard that refuses to arm (`on_cache_invalidated`, the model-switch
 *     branch in `setInterval`, the staleness check in `restore`, the give-up in
 *     `onPingFailed`) is protecting this invariant.
 *   - **Pinging forever.** The idle ceiling is anchored to real user activity,
 *     never to a ping, so a run of pings cannot keep pushing its own deadline
 *     out while nobody is there.
 *
 * All instants and durations are **milliseconds**. The Rust uses
 * `tokio::time::Instant` + `Duration`; the caller supplies `now` here, which
 * keeps the module pure and total on its inputs the way `CacheTracker` is.
 *
 * It observes exactly three things:
 *
 * - `setInterval`: the active model's `cache_keepalive` cadence
 *   (`undefined` = off).
 * - `onCacheWarmed`: a *real* LLM call that ran on the **same model** whose
 *   cache we keep warm (a foreground reply, or a heartbeat/background tick that
 *   happens to use that model) — resets both the ping timer and the idle clock.
 *   A call on a *different* model (e.g. a heartbeat pinned to a cheap
 *   background model) does NOT warm this model's prompt cache, so it is
 *   ignored: counting it would push the ping out while the real cache silently
 *   expires, turning every ping into a full cache recreation.
 * - `onCacheInvalidated`: the cached prefix is known unusable (e.g. the model
 *   switched and its prefix is cold).
 *
 * **Two independent knobs govern it:**
 * - **interval** (per-model `cache_keepalive`): how *often* to ping. Anthropic
 *   defaults to `55m`; every other sdk defaults to off. The interval is a
 *   literal cadence, unrelated to the Anthropic-only `cache_ttl` wire setting.
 * - **maxIdle** (global `[behavior.autonomy].cache_keepalive_max`, default
 *   12h): the longest stretch *since the last real activity* over which we keep
 *   pinging. Once it elapses, pinging stops until the user returns. This is the
 *   user-presence / cost ceiling — keyed to the last real message, NOT to the
 *   last ping (otherwise each ping would reset the clock and it would never
 *   expire).
 */
```

## src/autonomy/cache_keepalive.ts:76

```
/**
 * Grace past the ping interval during which failed pings keep retrying. The
 * interval sits below the provider cache TTL by convention (Anthropic: 55m
 * interval, 1h TTL), so `interval + grace` approximates the moment the warm
 * prefix actually dies. Retrying past that point cannot refresh anything — the
 * next "successful" ping would land on a cold cache and pay a full write (the
 * exact cost-center this subsystem must never become) — so the keepalive
 * disarms instead and waits for the next real warm.
 */
```

## src/autonomy/cache_keepalive.ts:113

```
/**
   * Last *real* cache-warming activity (user message / heartbeat). Keepalive
   * pings do NOT update this — it anchors the `maxIdle` cutoff.
   */
```

## src/autonomy/cache_keepalive.ts:119

```
/**
   * Last confirmed cache-warming event on the target model: a real call
   * ({@link onCacheWarmed}) or a successful ping ({@link onPingSucceeded}).
   * Unlike `lastActiveAt`, pings DO update this — it tracks how fresh the warm
   * prefix itself is, not user presence. Anchors the retry give-up check and
   * the restart {@link restore} guard.
   */
```

## src/autonomy/cache_keepalive.ts:128

```
/**
   * Last confirmed warm of **the exact prefix the ping sends**, as opposed to
   * "something happened on this model".
   *
   * This is the field the ping deadline is anchored to, and the distinction is
   * the whole of #27. `onCacheWarmed` is fed by the ledger funnel, which sees
   * every real call and can only say *that* one happened — not whether it
   * refreshed the bytes a ping would send. A `memory_query`, a compaction pass,
   * or a foreground turn whose prefix differs from the cached body all arrive
   * as warms and all used to push the deadline out by a full interval.
   *
   * Eleven cold pings in one day's logs came from exactly that: a background
   * tick landing partway through the window silently moved the next ping past
   * the TTL. The effective interval was never 55 minutes — it was "55 minutes
   * after whatever ran last, on any model".
   *
   * Only two events set this, because only two prove the prefix is warm:
   * a ping that read ({@link onPingSucceeded}), and a body being cached right
   * after the call that produced it ({@link onPrefixWarmed}). `undefined` means
   * nothing has proved it, and the deadline falls back to the plain cadence.
   */
```

## src/autonomy/cache_keepalive.ts:163

```
/**
   * When the next ping must land, given what is actually known to be warm.
   *
   *     nextPingAt = min(now + interval, prefixWarmAt + interval)
   *
   * The cadence alone — `now + interval` — trusts every event's claim to be a
   * warm, and slides the deadline forward on all of them. The second term is
   * the ceiling that makes that harmless: however many events arrive, the ping
   * still lands within one interval of the last *confirmed* warm of the prefix
   * it sends. The interval sits below the provider TTL by convention (55m
   * against Anthropic's 1h), so "one interval since the confirmed warm" is the
   * same statement as "before the prefix dies", with the margin built in.
   *
   * `min`, not "anchor on `prefixWarmAt` and ignore the cadence": the cadence
   * term is what keeps a schedule that has never confirmed anything armed at
   * all, and the two agree whenever a real turn pushes a fresh body — which is
   * every ordinary turn. The clamp only bites on the events that were lying.
   */
```

## src/autonomy/cache_keepalive.ts:188

```
/**
   * A body was cached immediately after the call that produced it, so the
   * prefix a ping would send is warm as of `now`.
   *
   * Called from `LastRequestCache.set` — the push that follows a real turn.
   * Deliberately *not* called from the rebuild-from-disk path: that body was
   * assembled from `active.jsonl` and has never been sent, so nothing has
   * warmed it. Leaving the anchor alone there can only make the next ping
   * earlier, and earlier is the safe direction — the dangerous one is always
   * "ping something cold", never "ping sooner than necessary".
   */
```

## src/autonomy/cache_keepalive.ts:204

```
/**
   * Update the active model's ping cadence (`undefined` = keepalive off), e.g.
   * when a request is cached or the user switches models. Reschedules the ping
   * timer to fire one interval after the last real activity. Disabling clears
   * any pending ping.
   *
   * The schedule anchors strictly on `lastActiveAt`: if no real call has warmed
   * a prefix yet (`undefined`, e.g. at startup or right after
   * {@link onCacheInvalidated}), no ping is armed until the next
   * {@link onCacheWarmed}. This keeps the invariant that we never ping a cold
   * cache. `now` is unused for arming but retained for signature symmetry with
   * the other timer mutators.
   */
```

## src/autonomy/cache_keepalive.ts:229

```
// next real warm — exactly like `onCacheInvalidated`.
```

## src/autonomy/cache_keepalive.ts:245

```
// Same clamp: arming off the activity anchor must not reach past
```

## src/autonomy/cache_keepalive.ts:300

```
// `setInterval` must NOT re-arm off the stale timestamp. Pinging only
```

## src/autonomy/cache_keepalive.ts:308

```
/**
   * Snapshot the armed schedule for persistence, or `undefined` when there is
   * nothing worth restoring (keepalive off, never warmed, or invalidated).
   */
```

## src/autonomy/cache_keepalive.ts:329

```
/**
   * Re-arm from a persisted snapshot after a restart. The provider-side cache
   * lives on Anthropic's servers, so a restart does NOT cool it — losing the
   * schedule here is what used to turn a quick redeploy into a full cold cache
   * write on the user's next message.
   *
   * Guard: only re-arms while the snapshot's last warm is younger than one ping
   * interval (the interval sits below the cache TTL by convention, so such a
   * prefix is provably still warm). Anything staler could fire a ping at a cold
   * cache — the one thing this subsystem must never do — so it stays unarmed
   * and waits for the next real warm. Returns whether the schedule was re-armed.
   */
```

## src/autonomy/cache_keepalive.ts:349

```
// confirmed warm — and `restore` has always anchored the next ping on it
```

## src/autonomy/cache_keepalive.ts:350

```
// rather than on `now`, which is the invariant #27 asks for, already held
```

## src/autonomy/cache_keepalive.ts:359

```
/**
   * Called by the autonomy loop on each tick.
   *
   * Returns `"ping"` iff a ping is due (`nextPingAt` set and reached) and the
   * character is still within the `maxIdle` window since its last real
   * activity. Past `maxIdle`, pinging stops (the user is presumed away) until
   * real activity resumes.
   *
   * Does NOT advance `nextPingAt` — the caller must call
   * {@link onPingSucceeded} after a successful ping, or {@link onPingFailed} to
   * schedule a short retry backoff.
   */
```

## src/autonomy/cache_keepalive.ts:382

```
// Counted from the last real activity, never from a ping.
```

## src/autonomy/deep_archive.ts:1

```
/**
 * The deep-idle archive: what happens to a conversation nobody came back to.
 *
 * Ported from `execute_deep_idle_archive`, `execute_deep_archive_pure` and
 * `execute_deep_archive_compaction` in `crates/daemon/src/autonomy/manager.rs`,
 * pinned by `tests/autonomy_fixtures/deep_archive_parity.json`. The bookkeeping
 * both arms end on — `reload_engine_and_apply_deferred` and the
 * invalidate-then-reprime pair — is `post_archive.ts`, shared with idle
 * compaction because the Rust ran the same four steps from both.
 *
 * After `archive_after` of silence, whatever is left of the active conversation
 * is moved out so the next exchange starts clean. `runner.ts` decides *when*;
 * this decides *how*, and there are two answers.
 *
 * # Coverage picks the arm, and it is the expensive question
 *
 * Every user turn already covered by memory means the conversation can go
 * straight to a segment file — no model, no tokens. That deliberately steps past
 * compaction's "wrote no memory, so do not archive" guard, because that guard
 * protects *uncovered* content and coverage was established by the pass that ran
 * over the full conversation earlier. The keep-N split only decides what stays
 * in `active.jsonl`; it is not what the compaction model was shown.
 *
 * Anything else — a conversation that never reached `min_turns`, or a short
 * exchange after the last pass — runs a real keep-0 compaction first, so those
 * turns reach memory before the file is emptied.
 *
 * The comparison is **strict equality**, and the fixture holds a case where the
 * covered count is *above* the on-disk one. Both directions mean coverage is
 * uncertain, and the safe direction is always the LLM pass.
 *
 * # The trailing autonomous run is retained
 *
 * A heartbeat's `<sendMessage>` output that the user has not answered stays in
 * `active.jsonl`, so it is still there when they come back. That is the whole
 * job of the `tail` count, and it becomes `keepLastN` unchanged.
 *
 * # What it reports, and the one thing the runner could not see before
 *
 * The Rust set its own state at the end of each arm. Here that state is the
 * runner's, so an arm reports and the runner folds it in — with one field that
 * had no way to travel: `deepArchiveDone`. The Rust sets it in the pure arm and
 * on the quiesce, and **deliberately does not** in the LLM arm, because a pass
 * that wrote no memory returns the same zero a successful one does. Leaving it
 * unset is what lets the next firing retry against a conversation that is still
 * intact. `runner.ts` was inferring it from "did not fail", which marked the
 * idle period finished after a pass that had archived nothing.
 *
 * # One recorded difference from the Rust
 *
 * The quiesce arm releases the latch and sets `deepArchiveDone`, but the Rust
 * left `last_compaction_activity` alone where {@link AutonomyActionResult} lands
 * it on `onCompactionFailed`, which moves it. It is unobservable: quiesce means
 * an empty conversation or nothing but an unanswered autonomous tail, so there
 * is nothing for the idle-compaction trigger the clock feeds to act on, and
 * `deepArchiveDone` stops this trigger regardless. Recorded rather than
 * engineered around.
 */
```

## src/autonomy/deep_archive.ts:140

```
/**
 * Archive a conversation nobody came back to.
 *
 * Never throws: every failure lands as a result with `failed` set, because a
 * deep archive that could not run still has to release the latch it was holding
 * and let the next `archive_after` window try again.
 */
```

## src/autonomy/deep_archive.ts:183

```
/**
 * Every user turn is covered: move the file, keep the tail, spend nothing.
 *
 * The bytes archived are the ones this call read, not whatever is on disk by the
 * time the write happens — `archiveAndRetain`'s own header explains why, and the
 * raw content is threaded from the load above for exactly that reason.
 */
```

## src/autonomy/deep_archive.ts:199

```
// The same single-flight guard every other compaction entry point takes.
```

## src/autonomy/deep_archive.ts:243

```
/**
 * Uncovered turns exist: run a real keep-0 compaction over them first.
 *
 * `keepTurnsOverride: 0` empties the conversation, and
 * `retainTrailingAutonomous` is what still leaves the unanswered heartbeat run
 * standing — the two are not in conflict, because the retention runs after the
 * split.
 *
 * `deepArchiveDone` stays false on success, which is the Rust's comment made
 * into a field: a pass that wrote no memory returns the same zero a successful
 * one does, so the idle period is not declared finished here. The next firing
 * either finds nothing archivable and quiesces, or retries against a
 * conversation that is still intact.
 */
```

## src/autonomy/tick.ts:1

```
/**
 * What an autonomy tick may do, decided from numbers alone.
 *
 * Every loop of the autonomy manager asks the same four questions: may the
 * heartbeat run, should the active conversation be compacted, should what is
 * left of it be archived, and is it quiet enough to dream. This answers all
 * four together, because they are not independent — compaction and the deep
 * archive share a latch and must not both fire against one conversation.
 *
 * Ported from `crates/daemon/src/autonomy/manager.rs` and pinned against it by
 * `tests/tick_parity.test.ts`, which replays a sweep of input combinations
 * recorded from the Rust.
 *
 * The decision is deliberately stateless: it reads no clock, holds no lock,
 * and changes nothing. Everything it depends on arrives in {@link TickInputs},
 * and everything it concludes leaves in {@link TickDecision}. Acting on the
 * conclusion — taking the latch, running the clock, writing the log line — is
 * the caller's, because those mutate and a decision that mutates cannot be
 * replayed against another implementation.
 */
```

## src/autonomy/tick.ts:67

```
/**
 * The whole per-tick trigger decision, as a function of the numbers.
 *
 * Compaction and the deep archive are mutually exclusive: they share one
 * single-flight latch, and running both against the same conversation would
 * have the second work from what the first had already archived. Compaction
 * wins, because it is the trigger with a turn threshold behind it — the deep
 * archive exists for the short conversations the idle trigger never picks up.
 */
```

## src/autonomy/tick.ts:95

```
/**
 * Which compaction trigger, if either, this tick's numbers satisfy.
 *
 * A zero threshold is an off switch in every case, not an always-on one — which
 * is what a bare `>=` against an unset config would give.
 */
```

## src/autonomy/heartbeat.ts:1

```
/**
 * Heartbeat clock — deadline holder with abandonment guard.
 *
 * The character schedules its own next wake via the `set_next_wake` tool. This
 * holds that deadline, applies bounds, and fires when it passes. An abandonment
 * guard stops ticking once the user has been absent too long, so a character
 * nobody is talking to does not keep paying for tool loops forever.
 *
 * Ported from `crates/daemon/src/autonomy/heartbeat.rs` and pinned against it by
 * `tests/heartbeat_parity.test.ts`, which replays decision walks recorded from
 * the Rust.
 *
 * **All times are wall-clock milliseconds**, supplied by the caller. The Rust
 * used `tokio::time::Instant` and reached for `Instant::now()` in three places;
 * taking `now` as a parameter throughout keeps this module pure and total on its
 * inputs, the way `CacheKeepalive` already is. It also removes the split the
 * Rust had between a monotonic live clock and wall-clock persistence — the same
 * split that made the keepalive's schedule disagree with its own state file.
 *
 * The two guards are independent and either one trips dormancy:
 *
 * - **tick count** — `ticksWithoutUser >= maxIdleTicks`. Counts firings, so a
 *   character that wakes hourly trips sooner in wall time than one that wakes
 *   daily.
 * - **silence** — `now - lastUserAt >= maxSilentMs`. Wall-clock, so it catches
 *   the case where the schedule stretched out and the tick count never climbed.
 */
```

## src/autonomy/heartbeat.ts:48

```
/** Consecutive firings without a user message before the guard trips. */
```

## src/autonomy/heartbeat.ts:50

```
/** Wall-clock silence before the guard trips. */
```

## src/autonomy/heartbeat.ts:65

```
/** Next scheduled wake. `undefined` means none — first boot, or the guard
   *  has tripped. */
```

## src/autonomy/heartbeat.ts:76

```
/** Last user message, for the wall-clock leg of the guard. */
```

## src/autonomy/heartbeat.ts:102

```
/**
   * The bounds this clock is running on, for `shore status` to report.
   *
   * Read back off the clock rather than off the daemon's own copy on purpose: a
   * config reload that never reached this side would otherwise be invisible,
   * with the status confidently reporting the interval the daemon *meant* while
   * the loop kept running the old one.
   */
```

## src/autonomy/heartbeat.ts:126

```
/** Force active: clear the counters and tick immediately. The guard re-trips
   *  on its own if the user still does not answer. */
```

## src/autonomy/heartbeat.ts:134

```
/**
   * Seed `lastUserAt` from backfilled history, but only when nothing has set it
   * yet.
   *
   * A character bootstrapped from existing chat history would otherwise have
   * `undefined` here, and `undefined` reads as "never silent" — which would let
   * dreaming run against a conversation that has actually been idle for weeks.
   */
```

## src/autonomy/heartbeat.ts:163

```
/**
   * Called by the autonomy loop on every tick.
   *
   * 1. No deadline → set one at `lastAnchor + defaultInterval` and return.
   *    Except when already abandoned: a dormant clock must not re-arm itself,
   *    or the guard would be a speed bump rather than a stop.
   * 2. Deadline not reached → nothing.
   * 3. Deadline reached but a guard trips → clear the deadline, stay dormant.
   * 4. Otherwise fire: count it, clear the deadline, re-anchor.
   */
```

## src/autonomy/heartbeat.ts:184

```
// because reaching the deadline while abandoned must also *clear* it. The
```

## src/autonomy/heartbeat.ts:187

```
// that was never due.
```

## src/autonomy/heartbeat.ts:205

```
/**
   * The character scheduled its own next wake.
   *
   * Out-of-range values are clamped rather than rejected, so a misbehaving
   * character can never silently disable its own heartbeat by asking for a wake
   * in a year — or hammer it by asking for one in a second.
   */
```

## src/autonomy/heartbeat.ts:219

```
/**
   * A user message arrived.
   *
   * Clears the tick counter, anchors the silence guard, and pushes the next
   * wake out to at least `minWakeInterval` — but never *pulls it in*. A
   * character that scheduled a wake two days out keeps it; the floor only
   * applies when the deadline was sooner than that, or absent because this is
   * the first message or the guard had tripped.
   */
```

## src/autonomy/idle_compaction.ts:1

```
/**
 * Idle-triggered compaction: the pass a tick runs on a conversation that has
 * gone quiet.
 *
 * Ported from `execute_idle_compaction` in
 * `crates/daemon/src/autonomy/manager.rs`. `runner.ts` decides *when* — the idle
 * trigger, the turn ceiling, the token ceiling, all already ported and pinned by
 * `crates/daemon/tests/fixtures/tick_parity.json` — and this runs the pass and
 * puts the world back in step afterwards.
 *
 * # There is no fixture for this one, and that is the finding
 *
 * Everything it does is already pinned somewhere else. The pass is
 * `memory/compaction/run.ts`, pinned by the compaction fixtures; the
 * bookkeeping is `post_archive.ts`, shared with the deep-idle archive; the state
 * writes the Rust made under its mutex are the runner's now, and
 * `#applyCompaction` is what pins them. What is left here is which pieces get
 * called and in what order — behaviour, not data, and a generated fixture would
 * have recorded nothing a test double does not.
 *
 * So this is pinned by tests and a mutation pass rather than a replay, and the
 * one number worth stating outright is the one that is *absent*: no
 * `keepTurnsOverride`. The deep archive's LLM arm passes zero, which empties the
 * conversation. If this passed zero too, every idle window would archive a
 * conversation the user is still in the middle of, and it would look like
 * working code.
 *
 * # What it reports
 *
 * `turnCount` on success, `failed` on a pass that threw — both landing on
 * `#applyCompaction`, which releases the latch either way and moves the activity
 * clock so a failure waits a full window instead of retrying in ten seconds.
 * That is the Rust's two branches exactly: the success arm set
 * `active_turn_count` and `covered_turn_count` to the retained count, the
 * failure arm set neither, and both cleared the latch and stamped the clock.
 *
 * Never `deepArchiveDone` — that field belongs to the archive, and an idle
 * compaction is not the end of an idle period. The conversation it just
 * compacted is one the user can still come back to.
 *
 * # Two recorded differences from the Rust
 *
 * **A missing engine no longer refuses the pass.** The Rust required a
 * `registry` before it would start, with a comment saying the requirement was so
 * the post-pass reload could happen. Here the reload is skipped when there is no
 * engine and the pass still runs: a compaction that happened but whose engine
 * did not reload is strictly better than one that did not happen, and the deep
 * archive port already made the same call for the same reason.
 *
 * **Missing LLM dependencies release the latch instead of wedging it.** The Rust
 * returned early on a missing client or notifier without touching any state,
 * which left `compaction_triggered` set — so nothing compacted that character
 * again until a user message cleared it. Reachable only from a context with no
 * model wired at all, and reproducing a latch leak is not worth it, so this
 * reports `failed` and the next idle window tries again.
 */
```

## src/autonomy/idle_compaction.ts:71

```
/**
 * Compact a conversation that has gone idle.
 *
 * Never throws: a failed pass still has to release the latch it was holding and
 * restart the retry window, and both of those are things the *result* does.
 */
```

## src/autonomy/post_archive.ts:1

```
/**
 * What a background pass does once it has rewritten the conversation.
 *
 * `reload_engine_and_apply_deferred` from
 * `crates/daemon/src/autonomy/manager.rs`, plus the invalidate-then-reprime pair
 * that followed it on every arm that touched `active.jsonl`. The Rust ran both
 * from two separate function bodies — `execute_deep_archive_pure` and
 * `execute_idle_compaction` — which is exactly why they are one function here:
 * two copies of the same four steps is how a fix to one silently misses the
 * other, and the steps are ordered for reasons that are not locally obvious.
 *
 * # The order is load-bearing, twice
 *
 * **Reload, then apply the deferred edits.** The reload is what busts the cached
 * prompt those edits would otherwise be written behind.
 *
 * **Invalidate, then reprime.** The rebuild has to read the file the pass just
 * rewrote, so it cannot run while the pre-pass body is still cached. The Rust
 * did the invalidation under the state lock and the reprime after releasing it,
 * for the same reason.
 *
 * # Everything here warns rather than fails
 *
 * The pass already happened. A background action has nobody to report a reload
 * failure to, and refusing to finish the bookkeeping would leave the world less
 * in step than a warning does. That is the one difference from the `compact`
 * command's completion, where a failed reload *is* the command's answer.
 */
```

## src/autonomy/post_archive.ts:86

```
/**
 * Drop the cached body and point the keepalive at what is on disk now.
 *
 * Two calls rather than one, for the ordering reason in the module header. The
 * `reason` reaches nothing but a log line, and is still a parameter because it
 * is the searchable record of which path cleared the body.
 */
```

## src/autonomy/keepalive.ts:1

```
/**
 * The keepalive scheduler: deciding when to ping, and pinging.
 *
 * `cache_keepalive.ts` is the state machine — pure, total on its inputs, and
 * pinned against the Rust it was ported from. This is the part around it that
 * has effects: it holds one schedule per character, learns about real calls
 * from the ledger funnel, runs the clock, and sends the ping.
 *
 * **The prefix is pushed, not rebuilt.** A ping must be byte-identical to the
 * cached request in every field that participates in the cache prefix, and the
 * body it clones is `request + this turn's response`, assembled by the daemon in
 * `handler/persistence.rs` from its own persisted content blocks. Reconstructing
 * that here would mean reimplementing the daemon's response-persistence
 * pipeline and hoping the two agree forever; a single divergent byte turns every
 * ping from a cache read at 0.1x into a cache write at 2.0x, which is the exact
 * failure this subsystem exists to prevent. So the daemon pushes the body it
 * already built (`POST /v1/keepalive/prefix`) and this side never authors one.
 *
 * **The clock is wall clock, deliberately, and this is a fix.** The Rust ran on
 * `tokio::time::Instant` — `CLOCK_MONOTONIC` on Linux, which does not advance
 * while the machine is suspended. The thing being tracked is a prefix expiring
 * on Anthropic's servers, and that runs on wall time. Suspend a laptop for two
 * hours and the monotonic schedule barely moves: it stays armed, and the next
 * ping lands on a prefix that died during sleep. `Date.now()` notices the gap.
 * (The Rust's own persistence path already used wall clock, via
 * `rfc3339_to_instant`, so the two halves disagreed with each other.)
 *
 * Wall clock's own hazard is a clock step, and it is the lesser one here: an NTP
 * correction of seconds against a 55-minute cadence changes nothing, and a large
 * backwards step only delays a ping, which is safe. The dangerous direction is
 * always "ping something cold", never "ping late".
 */
```

## src/autonomy/keepalive.ts:59

```
/**
   * The model's `cache_keepalive` cadence, milliseconds. Absent means off,
   * which disarms rather than leaving a stale cadence running.
   *
   * Milliseconds because the config domain allows a sub-second cadence and
   * seconds would truncate it to zero — and a zero interval puts the next ping
   * at the moment of the last one, so every tick is due and the loop spins.
   */
```

## src/autonomy/keepalive.ts:80

```
/**
 * Where a ping's outcome goes. Handed in at construction so this file keeps
 * knowing nothing about the heartbeat log it ends up in.
 *
 * Synchronous and fire-and-forget on purpose: a ping must not wait on a log
 * write, and a log that loses a line costs nothing (see `heartbeat_log.ts`).
 */
```

## src/autonomy/keepalive.ts:94

```
/**
 * `POST /v1/keepalive/restore` — a schedule the daemon persisted, offered back
 * at character startup.
 *
 * The ceiling rides along because a restored character may not have been armed
 * yet, so there is no pushed prefix to read it from.
 */
```

## src/autonomy/keepalive.ts:127

```
/**
   * Machine-readable cause when skipped. `no_prefix` is load-bearing across the
   * seam: the daemon reads it to decide whether to rebuild the body from disk
   * and push before asking again. A prose `detail` would make that a
   * string-match on a log line.
   */
```

## src/autonomy/keepalive.ts:156

```
/**
 * Whether a ping that came back `200 OK` actually failed at its only job.
 *
 * Read 0 *and* paid a write means the prefix was already gone and this ping
 * recreated it at full price rather than refreshing it. Read 0 with no write
 * means caching was off or a non-cached fallback answered — not a cold write,
 * and must not be treated as one.
 *
 * The same predicate is the ledger tracker's `cold_keepalive` anomaly
 * (`ledger/cache_tracker.ts`). They are deliberately identical: the row and the
 * scheduler's reaction must agree about what happened, or `shore usage` shows a
 * cold keepalive the schedule went on believing was fine.
 */
```

## src/autonomy/keepalive.ts:176

```
/**
 * Build the ping from the cached request.
 *
 * The ping MUST be byte-identical to the cached request in every field that
 * participates in the prompt cache prefix (tools, system, model, and the
 * original message sequence) — any divergence forces a cache write at 2.0x
 * instead of a cache read at 0.1x, defeating the entire subsystem.
 *
 * The only permitted differences, mirroring the Rust `build_keepalive_ping`:
 * - `max_tokens = 1` (no generation wanted, just a cache touch)
 * - no `rid` (do not reuse a stale request id)
 * - `call_type = "keepalive"`, which is what makes the row a keepalive row and
 *   lets the tracker's `cold_keepalive` check fire
 * - one extra user message appended (Anthropic requires the conversation to end
 *   on a user turn; the cloned request ends on the assistant reply)
 *
 * Note what is NOT touched: `messages` is copied and appended to, never
 * filtered, and `system`/`tools` are passed through by reference-copy. The
 * prefix is whatever the daemon pushed.
 */
```

## src/autonomy/keepalive.ts:228

```
/**
   * Point ping outcomes at the heartbeat log.
   *
   * Set after construction rather than taken as a constructor argument because
   * the two services are mutually referential — autonomy needs the keepalive to
   * read schedules off it, the keepalive needs autonomy to write events into.
   * Until this is set, events are dropped, which is the right behaviour for a
   * bare `KeepaliveService` in a unit test.
   */
```

## src/autonomy/keepalive.ts:241

```
/**
   * Arm (or re-arm) a character from a pushed prefix.
   *
   * Mirrors the daemon's `cache_last_request`: store the body, then feed the
   * cadence to the state machine, which decides for itself whether a model
   * switch means the old prefix is cold.
   *
   * `warm` says whether the body being cached was just *sent*. A push from a
   * completed turn was, and is the only signal in the system that the exact
   * bytes a ping would send are warm right now — which is what anchors the ping
   * deadline (#27). A push from the rebuild-from-disk path was not: that body
   * was assembled from `active.jsonl` and has never been near a provider, so
   * claiming it as a warm would push the deadline out for a prefix nothing has
   * ever cached.
   */
```

## src/autonomy/keepalive.ts:305

```
/**
   * Send a ping right now and report what it read, for the
   * `keepalive_ping_now` diagnostic.
   *
   * Deliberately does **not** touch the schedule — no `onPingSucceeded`, no
   * backoff, no disarm on a cold read. Measuring must not change what is being
   * measured: firing this to ask "is the prefix still warm?" must not move the
   * real deadline or stand the schedule down.
   *
   * It is still a real billed call, so it is still recorded.
   */
```

## src/autonomy/keepalive.ts:359

```
/** Re-arm a character from its persisted snapshot after a restart.
   *  Returns whether the schedule was taken up; the guard lives in `restore`. */
```

## src/autonomy/keepalive.ts:366

```
/**
   * The live schedule for a character, or undefined when there is nothing worth
   * restoring — keepalive off, never warmed, or disarmed.
   *
   * Autonomy reads this on each tick to persist it. Undefined must *clear* the
   * persisted copy rather than leave the old one, or a restart re-arms against
   * a prefix that is already dead.
   */
```

## src/autonomy/keepalive.ts:385

```
// character — but `restore`'s staleness guard still applies, so a
```

## src/autonomy/keepalive.ts:430

```
// Budget-gated exactly like any other call. `onPingFailed`, not a silent
```

## src/autonomy/keepalive.ts:466

```
// claim the provider refused the response and billed the write without
```

## src/autonomy/keepalive.ts:467

```
// persisting it; that was tested twice and is wrong, so do not re-derive
```

## src/autonomy/keepalive.ts:470

```
// `onCacheInvalidated`, not `onPingFailed`, because this is knowledge
```

## src/autonomy/keepalive.ts:513

```
/**
 * Run `tick` on a timer until the returned handle is stopped.
 *
 * `unref` so a pending tick never holds the process open — the sidecar's
 * lifetime is the daemon's to decide, and a keepalive timer is not a reason to
 * linger.
 */
```

## src/autonomy/service.ts:1

```
/**
 * Every loaded character's autonomy, and the clock that runs it.
 *
 * `runner.ts` is one character's loop — what a tick decides and what it folds
 * back in. This is the part around it with effects: it holds one loop per
 * character, reads their state and logs off disk when they load, runs a timer,
 * and makes sure a slow tick is never overlapped by the next one.
 *
 * The same division `keepalive.ts` has from `cache_keepalive.ts`, and the same
 * reason: the decisions are pure and pinned against the Rust, the effects are
 * not and cannot be.
 *
 * ## The daemon says which characters exist
 *
 * It does not scan a directory. `character_data_dir` sanitizes a name into a
 * path and lives on the far side, and reimplementing it here would give two
 * answers to "where does this character's state live" — which is the kind of
 * disagreement that silently writes a second state file. So registration
 * carries the directory, the way the keepalive's prefix carries the body rather
 * than rebuilding it.
 *
 * ## A tick that overruns is skipped, not queued
 *
 * Every action a tick takes is an LLM round trip, so a tick can outlast the ten
 * seconds until the next one. Starting a second would compact a conversation
 * the first is still compacting. So a character with a tick in flight is passed
 * over, exactly as {@link KeepaliveService} passes over a ping in flight — and
 * the daemon refuses a concurrent action anyway, which makes this the polite
 * half of a guard that exists on both sides.
 */
```

## src/autonomy/service.ts:65

```
/**
 * What `shore status` reads back.
 *
 * Times are epoch ms and durations are ms, both raw. The daemon renders them —
 * RFC3339 stamps, "in 40 minutes", whole seconds — because how a status reads
 * is the CLI's business and the CLI is the one that stayed Rust.
 *
 * The four bounds are echoed back rather than filled in by the daemon from its
 * own config. They say what the loop *is* running on, which is the only version
 * of the number worth putting in a diagnostic: a reload that never reached this
 * side is exactly what a status should be able to show.
 */
```

## src/autonomy/service.ts:80

```
/** `"Active"` or `"Dormant"` — whether the abandonment guard has tripped. */
```

## src/autonomy/service.ts:149

```
/**
   * Join the two halves of the keepalive: its ping outcomes come here to be
   * logged, and its schedules are read from here to be persisted.
   *
   * This is what `/v1/keepalive/{drain,restore}` used to do the long way round,
   * with the daemon in the middle owning `heartbeat.jsonl` and
   * `autonomy_state.json`. Both files moved to this side in `001c594d`, and the
   * endpoints were left behind with nothing calling them — so ping outcomes
   * stopped reaching the log entirely, and the persisted schedule was written
   * but never re-armed. This wires them back up on the near side, which is
   * where the ledger port put this seam and where it belongs.
   */
```

## src/autonomy/service.ts:199

```
// because shore restarted, so a schedule still provably warm is worth
```

## src/autonomy/service.ts:211

```
// without activity, and the restore guard has already established the
```

## src/autonomy/service.ts:300

```
/**
   * A compaction the daemon ran finished.
   *
   * Distinct from one a tick asked for, which folds its own result in. This is
   * the handler's post-turn path, which this side does not drive and would
   * otherwise never hear about — leaving the turn count wrong until the user's
   * next message.
   */
```

## src/autonomy/service.ts:348

```
/**
   * The character scheduled its own next moment, mid-heartbeat.
   *
   * Answers with the hours actually used, which is what the tool tells the
   * character. `undefined` for one nobody registered — the daemon then says so
   * rather than reporting a wake that was never armed.
   */
```

## src/autonomy/service.ts:417

```
/**
 * Run `tick` on a timer until the returned handle is stopped.
 *
 * `unref` so a pending tick never holds the process open — the sidecar's
 * lifetime is the daemon's to decide, and an autonomy timer is not a reason to
 * linger.
 */
```

## src/autonomy/activity.ts:1

```
/**
 * Activity tracker — what a character has learned about when its user shows up.
 *
 * It holds one timestamp per user message and derives a handful of statistics
 * from them: how consistently the user appears, how fast they reply, which
 * hours of the day they favour, and whether the current silence is unusual. The
 * `activity` tool reads these so a character can time itself, and `shore status`
 * renders the histogram as a heatmap.
 *
 * Ported from `crates/daemon/src/autonomy/activity.rs` and pinned against it by
 * `tests/activity_parity.test.ts`, which replays message streams recorded from
 * the Rust.
 *
 * ## Time
 *
 * Timestamps are **naive local wall-clock, carried as epoch milliseconds in
 * UTC**. The Rust used `chrono::NaiveDateTime`: a calendar reading with no zone
 * attached, so subtracting two of them counts the clock's own ticks and ignores
 * any DST shift between. Representing the same thing as a UTC instant and using
 * only the `getUTC*` accessors reproduces that exactly, whereas a local-zone
 * `Date` would fold DST back in and make an autumn night an hour longer than the
 * character lived it.
 *
 * `stats()` takes both a `now` for its cache TTL and the weekday to favour.
 * They are separate because they are separate clocks: the TTL wants elapsed real
 * time, and the weekday is a calendar fact. The Rust read each from a different
 * global — `Instant::now()` and `Local::now()` — which is what kept the whole
 * computation off-limits to a fixture.
 *
 * ## What was dropped
 *
 * The Rust stored a monotonic `Instant` alongside each wall clock, documented as
 * being "for gap computation within a process lifetime". Nothing ever read it:
 * every gap in the file is computed from `wall_clock`. It is not carried here.
 */
```

## src/autonomy/activity.ts:71

```
/**
 * Whole seconds between two timestamps, in either order.
 *
 * Truncated, not rounded: the Rust took `num_seconds()` off a duration, which
 * drops the sub-second part, and real timestamps carry one. Absolute, because
 * `recordMessage` does not sort — see {@link ActivityTracker.detectSessions}.
 */
```

## src/autonomy/activity.ts:161

```
/**
   * Seed from existing chat history.
   *
   * Sorts, because history arrives in whatever order it was read in. A no-op
   * once anything has been recorded: backfilling a live tracker would double
   * every message it had already seen.
   */
```

## src/autonomy/activity.ts:397

```
/**
 * How far the latest gap sits from the usual one, in standard deviations.
 *
 * `undefined` below three gaps, because two points are not a distribution. A
 * perfectly regular rhythm has no spread to measure against and scores zero
 * rather than dividing by it.
 */
```

## src/autonomy/last_request.ts:1

```
/**
 * The one thing an autonomy action still has to remember: a request body worth
 * replaying.
 *
 * Ported from `AutonomyState::last_request`, `cache_last_request`,
 * `invalidate_cached_request`, `reprime_decision` and
 * `reprime_keepalive_from_tick` in `crates/daemon/src/autonomy/manager.rs`,
 * pinned by `tests/autonomy_fixtures/last_request_parity.json`.
 *
 * # This is the bridge, and this is where it dies
 *
 * The daemon held this body and pushed it here over `POST /v1/keepalive/prefix`,
 * because it was assembled from Rust's own persisted content blocks and one
 * divergent byte turns a 0.1× cache read into a 2.0× write silently. #12 called
 * that the last bridge still standing and said it dies when conversation state
 * moves. It has moved — `handler/turn.ts` writes `active.jsonl` — so the push
 * becomes a function call and the endpoint goes.
 *
 * # Not persisted, and that is deliberate
 *
 * It is rebuilt from disk when absent (`rebuild.ts`), which is what makes it
 * safe to drop on a restart and safe to invalidate on compaction. A persisted
 * copy would be a second thing to keep in step with `active.jsonl`, and the
 * whole reason the rebuild exists is that the file is the truth.
 */
```

## src/autonomy/last_request.ts:50

```
/**
 * Push the rebuilt body, or stand down.
 *
 * A pure function because the *choice* is the behaviour worth pinning, not the
 * call that follows it. Keeping the schedule alive across a compaction is the
 * whole reason invalidation does not simply disarm — the conversation changed,
 * but there is still a prefix worth protecting, and it is the rebuilt one. A
 * rebuild that produced nothing must disarm rather than leave the
 * pre-invalidation body armed: pinging a prefix the next real turn will not
 * reuse spends money warming the wrong thing.
 */
```

## src/autonomy/last_request.ts:65

```
/**
 * The cached body, per character.
 *
 * A class rather than a module-level map because two of these exist in a test
 * run and sharing one between them is how a fixture starts passing for the
 * wrong reason.
 */
```

## src/autonomy/last_request.ts:85

```
/**
   * A real call landed: remember its body and arm the keepalive from it.
   *
   * The Rust cached under the state lock and pushed to the sidecar after
   * releasing it, in that order, because the push was an HTTP call it did not
   * want to hold a lock across. In one process the order is still the one that
   * matters — cache first, then arm — because arming is what reads the cadence
   * off the body.
   */
```

## src/autonomy/last_request.ts:102

```
/**
   * The body is no longer the one the next turn will send.
   *
   * Dropping it is the whole of the state change; what to do about the
   * keepalive is {@link reprimeFromDisk}'s, and it is a separate call because it
   * reads `active.jsonl` and the Rust deliberately did that after releasing the
   * state lock.
   */
```

## src/autonomy/last_request.ts:117

```
/**
   * Re-point the keepalive at a body rebuilt from what is now on disk.
   *
   * Called after {@link invalidate}, and separately because the rebuild reads
   * the conversation the invalidating write just changed.
   */
```

## src/autonomy/last_request.ts:142

```
/**
 * A request as the keepalive wants it.
 *
 * The wire shape `POST /v1/keepalive/prefix` carried, minus the wire. Two
 * fields the endpoint added and this has to add too:
 *
 * - **`context.character`**, which is what keys the schedule. Already on every
 *   real call's context, so this only fills it in for a body that arrived
 *   without one.
 * - **`keepalive_interval_ms`**, the model's resolved `cache_keepalive`.
 *   Absent means keepalive is off for this model, which disarms rather than
 *   leaving a stale cadence running. It comes from the caller because it is a
 *   property of the *model*, and the Rust read it off a field of `LlmRequest`
 *   that never crossed the wire.
 *
 * What this does *not* do is stamp `call_type`. The Rust built a fresh
 * keepalive-typed context here; `buildKeepalivePing` re-stamps it on the way
 * out anyway, so doing it twice only creates somewhere for the two to disagree.
 */
```

## src/autonomy/heartbeat_tick.ts:1

```
/**
 * A heartbeat tick, end to end: build the body, run the loop, deliver whatever
 * the character asked to say.
 *
 * Ported from `execute_heartbeat_tick` and `persist_heartbeat_message` in
 * `crates/daemon/src/autonomy/manager.rs`. The two halves it strings together
 * are `heartbeat_request.ts` and `heartbeat_loop.ts`.
 *
 * # Delivery is best-effort in three separate ways
 *
 * A tick's conversation is thrown away, so the message is the only chance the
 * character has to be heard, and every step of getting it out can fail
 * independently: the engine may refuse the append, there may be no client
 * connected to push to, the desktop notifier may be absent. The Rust let each of
 * those fail on its own and carried on, and so does this. In particular the
 * notification fires even when the append failed — the character did speak, and
 * a user who is told they have a message and finds nothing in the log is better
 * off than one who is never told at all.
 *
 * # An image-only tick still delivers
 *
 * `<sendMessage>` is not the only way to say something. A tick that generated an
 * image and wrote no text has still produced something for the user, so the
 * image is the message and any words ride along as its caption.
 */
```

## src/autonomy/heartbeat_tick.ts:103

```
// applied, chat's otherwise. An empty string is the absence, not a name.
```

## src/autonomy/heartbeat_tick.ts:147

```
// never told at all.
```

## src/autonomy/heartbeat_tick.ts:194

```
// pinned background model — the common case — did not, and must not push the
```

## src/autonomy/heartbeat_log.ts:1

```
/**
 * The heartbeat event log — a bounded ring, persisted as JSONL.
 *
 * What `shore log --heartbeat` shows: the last hundred things autonomy did for
 * a character. It is a record for a person to read, not state anything depends
 * on, so it is written whole on each flush and losing a line costs nothing.
 *
 * Ported from `crates/daemon/src/autonomy/mod.rs` and pinned against it by
 * `tests/heartbeat_log_parity.test.ts`.
 *
 * ## The wire format is load-bearing
 *
 * The Rust spells its event kinds `snake_case` on the wire and `PascalCase` in
 * source, so the two can drift apart with nothing to notice. The CLI reading
 * this file skips any line it cannot parse — so a kind spelled wrong here does
 * not produce an error, it produces a log with entries missing. The fixture
 * pins every kind's exact bytes for that reason.
 *
 * Writes go through a temporary file and a rename, so a reader never sees a
 * half-written log. That matters more here than the content does: the Rust CLI
 * reads this file while the daemon is running.
 */
```

## src/autonomy/heartbeat_log.ts:29

```
/** The kinds of thing worth recording, exactly as they appear on the wire. */
```

## src/autonomy/heartbeat_log.ts:39

```
/** The abandonment guard tripped. */
```

## src/autonomy/heartbeat_log.ts:43

```
/** A tick was killed by the timeout guard. */
```

## src/autonomy/heartbeat_log.ts:115

```
/** Bind to a file, or pass nothing for a log that never touches disk. */
```

## src/autonomy/heartbeat_log.ts:139

```
// guard against corruption; `decodeEvent` would reject it either way.
```

## src/autonomy/heartbeat_request.ts:1

```
/**
 * The body a heartbeat tick runs, and the model it runs on.
 *
 * Ported from `prepare_heartbeat_request` and `apply_heartbeat_model_override`
 * in `crates/daemon/src/autonomy/manager.rs`. The four `heartbeat_override_*`
 * tests there are the specification for the override and are carried across
 * whole in `tests/heartbeat_request.test.ts`.
 *
 * A heartbeat does not build a request from scratch. It takes the body chat
 * last sent — still warm against the provider's prompt cache — and appends one
 * instruction to it. Everything here exists to make that append safe.
 *
 * # The cached body is chat's, and is never written to
 *
 * `LastRequestCache` hands back the object it is holding, and that object is
 * what the next chat turn and every keepalive ping extend. The tick appends an
 * inline system entry and then a turn per tool round; doing that to the cached
 * object would rewrite chat's history in place and leave a prefix no real turn
 * reuses. The Rust cloned under the lock for exactly this reason. So does this
 * — see {@link copyForTick}.
 *
 * # Why the override is stricter than every other background task
 *
 * `resolveBackgroundModel` falls back to the chat model when a configured name
 * does not resolve, and for compaction or dreaming that is right: some model
 * beats none. A heartbeat checks the effective catalog *first* and keeps the
 * chat model when the check fails, so a typo'd pin is a warning rather than a
 * silent demotion to whichever model the catalog happens to return. The check
 * goes through the effective catalog and not the static one because pins are
 * written `provider:model_id` with no `[chat.*]` entry behind them — the static
 * lookup rejected every valid pin, and heartbeat silently never left the chat
 * model at all.
 */
```

## src/autonomy/heartbeat_request.ts:59

```
/**
 * A shallow copy the tick may append to.
 *
 * Shallow is the whole intent: `messages` becomes a new array so pushes land
 * here, and the message objects inside stay shared because nothing ever mutates
 * one. `tools` and `system` are passed through by reference for the same
 * reason, and because sharing them is what keeps them byte-identical to chat's
 * — a rebuilt tool array would render different bytes and give up the cache
 * prefix this module exists to reuse.
 */
```

## src/autonomy/heartbeat_request.ts:101

```
/**
   * The heartbeat model, when one was applied. `undefined` means the chat model
   * stands — which is also what a misconfigured pin and a failed build produce,
   * because in both cases running on chat's model beats not ticking.
   */
```

## src/autonomy/heartbeat_request.ts:114

```
/**
 * Swap the request onto the configured heartbeat model, or leave it alone.
 *
 * Returns the request to run rather than editing the caller's, because the swap
 * replaces the whole body: credentials, base URL, sampler settings and token
 * caps all come from the new model, and the only things carried over are the
 * three that decide the cache prefix — `messages`, `system` and `tools`.
 *
 * Four ways to end up on the chat model, and only one of them is a problem:
 * nothing configured, the name does not resolve (warns), the configured model
 * *is* the one the request already uses, or the build failed for want of a key
 * (warns).
 */
```

## src/autonomy/heartbeat_request.ts:138

```
// name that does not resolve must not fall through to
```

## src/autonomy/heartbeat_request.ts:200

```
/**
   * Dispatch rounds before the wrap-up nudge. `undefined` is unlimited, leaving
   * the wall-clock deadline as the only bound.
   *
   * Read off the model the request *actually* runs on. Re-resolving it
   * independently could name a different model than the body was built for,
   * because a heartbeat pin resolves only through the effective catalog while
   * the chat lookup does not.
   */
```

## src/autonomy/heartbeat_request.ts:214

```
/**
 * Assemble the body for one tick.
 *
 * `undefined` means do not tick, for the one reason the rebuild reports:
 * the conversation is mid-turn, or no chat model resolves. Both are states
 * where a heartbeat would build a request the provider rejects.
 *
 * A cold rebuild is cached on the way through. Without that, keepalive pings
 * silently no-op after a restart until the character's next user message —
 * the rebuild is the only thing that produces a body in that window, and
 * throwing it away after one tick means paying for it again every hour.
 */
```

## src/autonomy/heartbeat_request.ts:259

```
// and refusing to run because one file is stale would trade a degraded
```

## src/autonomy/heartbeat_request.ts:281

```
// the entry's index must not depend on how long the tail has grown: every
```

## src/autonomy/heartbeat_request.ts:288

```
// messages, so a later chat turn extending the cached body never sees it.
```

## src/autonomy/state_file.ts:1

```
/**
 * `autonomy_state.json` — what a character remembers across a restart.
 *
 * Small and deliberately so: the heartbeat's deadline and idle count, how much
 * of the conversation memory already covers, and the keepalive schedule. Not a
 * database. Everything else about a tick is recomputed from scratch.
 *
 * Ported from `crates/daemon/src/autonomy/manager.rs` and pinned against it by
 * `tests/autonomy_state_parity.test.ts`.
 *
 * ## Why the shape is load-bearing
 *
 * This file is already on users' disks, and every field on the Rust side is
 * `#[serde(default)]`. A name that changes on one side does not fail to
 * parse — it reads as absent. Absent means the keepalive stays unarmed and the
 * heartbeat forgets its deadline, which is the *fail-safe* direction and
 * exactly why it would go unnoticed: the daemon starts, nothing errors, and the
 * user pays one cold cache write and one missed wake. So the fixture pins the
 * bytes, and {@link decodeState} refuses a file it does not fully understand
 * rather than filling in blanks.
 *
 * ## Times
 *
 * RFC3339 strings on disk, epoch milliseconds in memory. The Rust held these as
 * monotonic `Instant`s and converted through the delta from `Utc::now()` on
 * every save and load — an approximation that drifted a little each restart,
 * and disagreed with itself across a suspend. Wall clock throughout makes the
 * conversion exact, which is the same correction the heartbeat clock's port
 * made for the same reason.
 */
```

## src/autonomy/state_file.ts:75

```
/**
 * Render the file exactly as the daemon writes it: pretty-printed, two-space
 * indent, absent values spelled `null` rather than omitted, and no trailing
 * newline.
 */
```

## src/autonomy/state_file.ts:163

```
/**
 * Write a character's state.
 *
 * Returns whether it landed, so the caller can keep its dirty flag set and try
 * again rather than believing a write that never happened.
 */
```

## src/autonomy/runner.ts:1

```
/**
 * One character's autonomy loop.
 *
 * Holds the state, decides what a tick should do, and asks something else to do
 * it. Everything it decides with is already ported and pinned against the Rust:
 * the {@link HeartbeatClock}, the {@link ActivityTracker}, {@link tickDecision},
 * the {@link HeartbeatLog} and `autonomy_state.json`. This assembles them into
 * the loop `character_tick_loop` runs in `crates/daemon/src/autonomy/manager.rs`.
 *
 * ## What it does not do
 *
 * Execute. Running a heartbeat's tool loop, compacting a conversation and
 * archiving it all reach into the engine, the memory store, the tool registry
 * and MCP — none of which live on this side, and some of which are not going
 * to. So execution arrives as an {@link AutonomyExecutor}, and the three
 * methods on it are the whole surface the daemon still has to provide.
 *
 * That interface is the shape of the remaining work, deliberately. When the
 * daemon's autonomy module is deleted, what is left in Rust is an
 * implementation of these three calls and nothing else.
 *
 * ## Why the deep archive checks its gate twice
 *
 * Executing anything means awaiting, and a user message can land mid-await. The
 * decision at the top of a tick was taken before that, so the deep archive
 * re-checks its gate immediately before running — otherwise a character starts
 * archiving a conversation the user has just rejoined. The Rust does the same,
 * for the same reason, and the recheck is why {@link tickDecision} is cheap and
 * pure enough to call twice.
 */
```

## src/autonomy/runner.ts:51

```
/** The range `set_next_wake` accepts, in hours. Matches the clock's own bounds
 *  in milliseconds; a character asking outside it is clamped, not refused. */
```

## src/autonomy/runner.ts:56

```
/**
 * The `[memory.compaction]` half, which a config reload replaces in place.
 *
 * Split out because its lifetime differs from the two gates beside it. In the
 * Rust these six lived on the manager's shared `self.compaction`, and
 * `should_compact_now` read that field directly — so a reload changed when
 * every character compacts, at once, with no restart. See
 * {@link CharacterAutonomy.setCompactionConfig}.
 */
```

## src/autonomy/runner.ts:71

```
/**
   * Prompt-context ceiling, in tokens, past which the handler compacts.
   *
   * Only {@link CharacterAutonomy.shouldCompactNow} reads it: a tick has no
   * token count to compare against, because nothing has just been sent.
   */
```

## src/autonomy/runner.ts:82

```
/**
   * The two `[behavior.autonomy]` gates, fixed for as long as this runner is.
   *
   * The Rust snapshotted them into the spawned tick task, so a reload never
   * reached an already-running character; that is reproduced rather than
   * improved, because the clock beside them holds a live deadline the state
   * file has already recorded, and moving it mid-flight is a different change.
   */
```

## src/autonomy/runner.ts:111

```
/**
   * Set when the action ran and failed.
   *
   * Not a throw, because a failed action still has log lines worth keeping and
   * still has to release its latch. Failing to *reach* the far side is the
   * throw — see the note on {@link AutonomyExecutor}.
   */
```

## src/autonomy/runner.ts:119

```
/**
   * Whether this idle period's archive is finished. Only the deep archive says.
   *
   * It cannot be inferred from "did not fail", which is what this used to do.
   * The Rust's LLM arm sets the turn counts on success and *deliberately leaves
   * this alone*, because a pass that wrote no memory returns the same zero a
   * successful one does — so declaring the period finished there would stop the
   * next window retrying a conversation that is still fully intact. The pure
   * arm and the nothing-to-archive quiesce both do set it.
   *
   * Absent falls back to the inference, which is what an action that has not
   * ported yet still reports.
   */
```

## src/autonomy/runner.ts:176

```
/**
   * Archive what is left of a conversation nobody has returned to.
   *
   * `coveredTurnCount` is how much of the conversation memory already holds,
   * and it decides which arm runs: every user turn covered means a pure file
   * archive with no model call at all, anything less means a real keep-0
   * compaction. It is passed rather than read because it is *this* runner's
   * state — the daemon used to keep its own copy, and two copies of a number
   * that picks between a free path and a paid one is exactly the kind that
   * drifts.
   */
```

## src/autonomy/runner.ts:223

```
/** Reads the wall clock. Injected because a tick reads it more than once —
   *  see the note on rechecking above — and a test has to control both reads. */
```

## src/autonomy/runner.ts:289

```
/**
   * A user said something.
   *
   * Three things at once, and they are separate on purpose: the heartbeat's
   * silence anchor moves, the compaction clock restarts, and both single-flight
   * latches release. A character the user has come back to is not mid-idle-period
   * any more, so triggers that had already fired for it must be able to fire again.
   *
   * The activity tracker is told separately, by
   * {@link CharacterAutonomy.recordUserActivity}, because it runs on a different
   * clock and a method taking both would be two timestamps in a row that nothing
   * would notice being swapped.
   */
```

## src/autonomy/runner.ts:351

```
/**
   * A compaction the daemon ran failed.
   *
   * The latch releases so a later trigger can fire, and the activity clock moves
   * to now so the retry waits a full window instead of firing on the next tick
   * ten seconds later. The same landing a compaction the *tick* ran gets when it
   * fails, because it is the same event arriving by the other route. Mirrors
   * `notify_compaction_failed`.
   */
```

## src/autonomy/runner.ts:366

```
/**
   * Should the handler compact the conversation it has just added a turn to?
   *
   * Asked once per generation, and answered here rather than on the daemon side
   * because saying yes *takes the latch* — leaving that on the far side would
   * have the handler and the next tick each believe they were the only one
   * compacting.
   *
   * Two triggers, both floored by `minTurns` so a short conversation is never
   * worth the call. Neither is the idle trigger, which a tick runs for itself.
   *
   * The Rust checked `compaction.enabled` here and nothing else — not
   * `autonomyEnabled`, not `paused`, and notably not the latch it then sets, so
   * a handler compaction could start while a tick's was still running. Carried
   * over unchanged: a port is the wrong place to tighten a gate, and the daemon
   * refuses a concurrent action on its own side anyway.
   */
```

## src/autonomy/runner.ts:451

```
/** Force the abandonment guard on. Stays until a user message clears it. */
```

## src/autonomy/runner.ts:457

```
/** Force the abandonment guard off and tick immediately. */
```

## src/autonomy/runner.ts:463

```
/**
   * A user message, as the user's calendar saw it.
   *
   * Separate from {@link CharacterAutonomy.onUserMessage} because the clocks are
   * separate. `localAt` is a calendar reading — naive local wall clock carried
   * as epoch ms in UTC, the encoding {@link ActivityTracker} is pinned on — and
   * it answers "which hour of which day". Everything else about a user message
   * runs on real elapsed time and answers "how long has it been".
   *
   * The daemon supplies the reading rather than this side deriving one, for the
   * reason on {@link CharacterAutonomy.backfillActivity}.
   */
```

## src/autonomy/runner.ts:479

```
/**
   * Seed the activity tracker from chat history a character already has.
   *
   * `localTimestamps` are calendar readings, as above; `latestUserAt` is one
   * real instant, on the clock the heartbeat runs on.
   *
   * Both are computed by the daemon, which is where the conversation and its
   * timestamps are. Deriving the calendar readings here would need the sidecar
   * to hold its own opinion of the machine's timezone — and worse, one current
   * opinion applied to timestamps from months ago, which puts every message
   * either side of a DST boundary an hour out. `chrono`'s conversion on the
   * daemon side uses the offset that was actually in force at each instant.
   *
   * Seeding the silence anchor matters for a character bootstrapped from
   * history: without it `lastUserAt` stays unset, which the heartbeat's
   * abandonment guard reads as "never spoke to" rather than "left an hour ago".
   */
```

## src/autonomy/runner.ts:501

```
/**
   * What the `activity` tool and `shore status` read.
   *
   * `now` ages the memoised result; `localAt` says which weekday to weight the
   * histogram towards. Separate parameters because they are separate clocks —
   * the Rust read one from `Instant::now()` and the other from `Local::now()`.
   */
```

## src/autonomy/runner.ts:527

```
/**
   * Take the keepalive's current schedule so it reaches `autonomy_state.json`.
   *
   * `undefined` **clears** the persisted copy rather than leaving the last one
   * standing — keepalive off, never warmed, or disarmed all mean there is
   * nothing worth re-arming, and a stale copy would re-arm against a dead
   * prefix on the next restart. That clearing behaviour is the whole reason
   * this takes the value rather than reading a getter only when it is set.
   *
   * Dirty only on an actual change, because this runs every tick and marking it
   * unconditionally would rewrite the file forever.
   */
```

## src/autonomy/runner.ts:576

```
/**
   * One tick: decide, execute, persist.
   *
   * The persist is in a `finally` because an executor that cannot be reached
   * throws, and everything decided before it — the clock's advance, the
   * `tick_fired` line, the latch — is worth keeping. Losing it would mean a
   * heartbeat deadline that survives the throw only in memory, and a restart
   * during an unreachable daemon would forget it entirely.
   */
```

## src/autonomy/runner.ts:626

```
// on `deepArchiveDone`. The fallback — a failed archive must be able
```

## src/autonomy/runner.ts:643

```
// hours of housekeeping, at exactly the time it needs it most.
```

## src/autonomy/runner.ts:645

```
// No Rust to mirror here: this case only exists because executing moved
```

## src/autonomy/runner.ts:687

```
/**
   * Has the conversation stayed idle long enough to still be worth archiving?
   *
   * Deliberately narrower than {@link tickDecision}: it asks only what could
   * have changed while this tick was awaiting. Re-running the whole decision
   * would read the single-flight latch *this tick just took* and refuse every
   * time — the recheck would never pass, and the archive would never run. The
   * Rust's `execute_deep_archive_if_still_idle` checks these same three things
   * for the same reason.
   */
```

## src/autonomy/runner.ts:702

```
/**
   * Run the heartbeat clock, and say so in the log when the guard trips.
   *
   * A trip is: it had a deadline, the tick declined to fire, and the deadline
   * is gone afterwards. That is the only way to tell dormancy from an ordinary
   * "not yet" — both return `none`.
   */
```

## src/autonomy/runner.ts:723

```
// ceiling, and the guard governs heartbeat ticks rather than cache
```

## src/autonomy/runner.ts:724

```
// warming — a dormant character's cache is exactly the one whose next
```

## src/autonomy/runner.ts:725

```
// message would otherwise pay a cold write.
```

## src/autonomy/runner.ts:742

```
/**
   * Write the state and flush the log, if either has anything to say.
   *
   * A failed write leaves the dirty flag set, so the next tick tries again
   * rather than believing a save that never happened.
   */
```
