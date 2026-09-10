# Shore reliability and design audit

Audited 2026-09-10 at commit `1e2ad2fdafca31b13bea8ec54d87ffb9385ac94c`.

The main recurring problem is inconsistent ownership of state. Threads exist in the conversation engine, but several surrounding services still operate on a character alone. Individual message writes are serialized, but whole turns and conversation replacements are not. Information also disappears as requests pass through multiple representations. These are concrete behavior problems, not objections to file count or coding style.

This report contains **18 findings**. P1 means a correctness or availability problem to prioritize; P2 means a narrower defect or a structural reliability problem. “Reproduced” means a local probe exercised the relevant production functions, using temporary databases and fake providers where needed. “Code trace” means the behavior follows from the referenced implementation but was not reproduced end to end.

No application fixes, dependency updates, deployment, or live database changes were made during this audit.

## Findings at a glance

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| 01 | P1 | Concurrent turns and conversation rewrites have no shared owner | Reproduced |
| 02 | P1 | Cancelling a chat does not cancel its running tools | Reproduced |
| 03 | P1 | Automatic compaction can compact the wrong thread and resurrect archived messages | Reproduced |
| 04 | P1 | New-message events cross thread boundaries | Reproduced + client code trace |
| 05 | P1 | Config reload sends home-thread history to side-thread clients | Reproduced + client code trace |
| 06 | P1 | Malformed tool arguments lose their rejection flag and can execute | Reproduced |
| 07 | P1 | A valid thread named `threads` resolves to the wrong database | Reproduced |
| 08 | P1 | Reading a legacy file can overwrite newer database state | Reproduced |
| 09 | P1 | MCP servers can stall on an unread stderr pipe | Reproduced with a local subprocess |
| 10 | P2 | Clearing one thread resets other threads' frozen prompts | Reproduced |
| 11 | P2 | Generated images disappear when tool messages are merged for display | Reproduced |
| 12 | P2 | Failed or skipped background compaction is represented as successful compaction to zero turns | Reproduced conversion + caller trace |
| 13 | P1 | Subscription accounting is globally overridden by character order | Reproduced + ledger code trace |
| 14 | P2 | Small updates rewrite whole histories, transcripts, and client snapshots | Code trace + synthetic timing |
| 15 | P2 | Git tools ignore cancellation and collect unlimited process output | Code trace |
| 16 | P2 | Environment reload retains removed values and mutates state before validation | Reproduced removal + loader trace |
| 17 | P2 | Dice input can request billions of synchronous iterations | Reproduced validation; execution deliberately omitted |
| 18 | P2 | Dependency freshness is enforced too late in the development cycle | Hook inspection; policy added after review |

## 01. Concurrent turns and conversation rewrites have no shared owner

**Trigger:** Two clients submit to the same thread, or a user clears/edits the conversation while a response is running.

The router tracks generations by **session**, then character/thread. Different sessions can therefore generate against the same engine simultaneously. Even within a session, superseding a request calls its abort callback and starts the replacement without awaiting settlement. `SnapshotGate.withActivity` permits concurrent activities. The message-store mutex protects individual mutations, not a complete user/assistant turn.

**Observed:** Two paused fake providers completed in reverse order and persisted:

```text
user:A
user:B
assistant:reply to B
assistant:reply to A
```

In a separate probe, the real `/clear` implementation completed while generation C was waiting. When C finished, the supposedly cleared active conversation contained only `assistant:reply to C`.

Regeneration is particularly fragile because persistence replaces everything after the **current** last user turn, without identifying the turn originally being regenerated. The engine already exposes `historyRewriteGeneration()`, but no production caller uses it to reject stale generation results.

**Evidence:** [router](../daemon/src/handler/router.ts#L313), [generation persistence](../daemon/src/handler/generation.ts#L328), [tail replacement](../daemon/src/engine/message_store.ts#L547), [activity gate](../daemon/src/snapshot_gate.ts#L13), [clear](../daemon/src/commands/segments.ts#L128).

**Simplification:** Give each `(character, thread)` one turn coordinator. Bind generation to a turn ID and conversation generation. Cancellation, regeneration, clear, edit, archive, and final persistence must participate in that lifecycle. A short write mutex alone is insufficient; stale results must also be rejected.

## 02. Cancelling a chat does not cancel its running tools

**Trigger:** Cancel while an MCP call, web request, or subagent is executing.

The generation signal reaches the model stream, but `buildToolContext` does not accept or set a parent signal. `streamTurn` passes that context into `toolPhase` unchanged. `sharedToolDeps` receives a turn containing a signal but does not propagate it into the tool context. Consequently `dispatchWithinDeadline` creates a tool timeout signal without the user's cancellation signal.

**Observed:** Through the real generation and tool-loop path, a fake MCP tool received a signal with `aborted: false` after the user signal became `aborted: true`. The tool remained in flight until the probe explicitly released it.

This makes a cancelled operation continue consuming resources and potentially applying changes after the client has been told it was cancelled. It also aggravates finding 01 when the user starts another turn.

**Evidence:** [tool-context construction](../daemon/src/handler/tool_context.ts#L23), [tool-phase assembly](../daemon/src/handler/generation.ts#L439), [shared dependencies](../daemon/src/runtime.ts#L485), [deadline wrapper](../daemon/src/tools/dispatch.ts#L375).

**Simplification:** Carry a single required execution context containing the parent signal through every tool path. Combine it with local deadlines at the execution boundary. Test cancellation through an actual generation, not just a tool called directly with a signal.

## 03. Automatic compaction can compact the wrong thread and resurrect archived messages

**Trigger:** A non-home thread reaches an automatic compaction threshold.

`maybeCompact` reads the selected engine's turn/token counts, but invokes `runner.run(character, config)` without a thread. The runner defaults to the character's home thread. Afterwards it reloads the originally selected engine. This path also never consults the selected `ThreadRecord.compaction` flag. Manual compaction has a separate path that does pass `engine.thread`.

**Observed:** With six messages in each of `main` and `side`, and `side.compaction = false`, triggering inline compaction from `side` produced:

```text
main on disk:       2 messages
main cached engine: 6 messages
side:               6 messages
```

Appending to the stale main engine then wrote **seven** active messages, bringing the four archived messages back into the active conversation.

**Evidence:** [trigger and reload](../daemon/src/handler/turn.ts#L195), [runner adapter](../daemon/src/memory/compaction/run.ts#L506), [home-thread default](../daemon/src/memory/compaction/run.ts#L163), [manual path](../daemon/src/commands/compact.ts#L59).

**Simplification:** Use one compaction operation taking an explicit conversation identity and returning a structured outcome. Resolve eligibility, archive, invalidate/reload the matching engine, and update that thread's scheduling state through the same operation.

## 04. New-message events cross thread boundaries

**Trigger:** A message is produced in one thread while another client views a different thread of the same character.

History snapshots contain `selected_thread`; `new_message` does not contain any thread identifier. Server filtering checks only the character for new-message events. The Rust sync layer likewise checks only the character and advances a message revision watermark even though revisions belong to individual thread engines.

**Observed:** A new-message event representing a side-thread message passed `eventMatchesSession(..., selectedThread = "main")`. The wire type cannot express the missing distinction.

**Impact:** Foreign messages can appear in another thread's client stream. A high revision from one thread can suppress later legitimate new-message events from another. Full snapshots and incremental events disagree about routing.

**Evidence:** [event filtering](../daemon/src/swp/routing.ts#L70), [wire event type](../daemon/src/protocol/NewMessage.ts), [event emission](../daemon/src/handler/persistence.ts#L199), [Rust sync](../client/shore-common/src/swp_client/sync.rs#L44).

**Simplification:** Put the same explicit conversation identity on all conversation events. Deduplicate by conversation and event/message identity, with revisions scoped consistently. Update the Rust protocol source and regenerate TypeScript.

## 05. Config reload sends home-thread history to side-thread clients

**Trigger:** Reload config while a client has a non-home thread selected.

`pushHistorySnapshots` enumerates each session's character but calls `handshake.history(character)` without `router.threadFor(sessionId)`. It directly sends the result, bypassing broadcast thread filtering.

**Observed:** A mock session selected on `side` caused a history request with arguments `["ada"]` and received a snapshot for `main`.

The client treats a snapshot naming another thread as a selection change. The server's session selection is not changed by this refresh. The client can therefore show home-thread history while subsequent input is still routed to the side thread; reconnect selection can also inherit the mistaken history selection.

**Evidence:** [reload snapshots](../daemon/src/handler/deps.ts#L541), [handshake interface](../daemon/src/swp/connection.ts#L46), [client selection update](../client/shore-common/src/swp_client/sync.rs#L44), [reconnect selection](../client/shore-common/src/swp_client/conn_manager.rs#L90).

**Simplification:** Centralize “refresh this session's current conversation” and use it for reload, reconnect, and selection refresh. Distinguish a refresh from an intentional selection change.

## 06. Malformed tool arguments lose their rejection flag and can execute

**Trigger:** A provider produces truncated or otherwise invalid JSON for a tool whose schema permits an empty object.

`parseToolArgs` returns `{ input: {}, input_error: ... }`. Provider stream events retain the error. The generic loop converts those events into `ContentBlock` objects without the error, then converts the blocks back into `ToolUseEvent` objects without it. The executor's explicit `input_error` rejection never sees the flag.

**Observed:** A stream event created from `parseToolArgs('{"scope":')` traversed `genericToolLoopEvents` and executed the fake MCP tool once with empty arguments. Calling `argumentRejection` directly would have rejected the same original event.

For tools with optional filters, empty arguments can mean a substantially broader operation than intended. Required-field validation happens to protect some tools, but does not repair the lost information.

**Evidence:** [parser](../daemon/src/llm/tool_args.ts), [first lossy conversion](../daemon/src/llm/providers/generic_loop.ts#L137), [second conversion](../daemon/src/llm/providers/generic_loop.ts#L220), [executor rejection](../daemon/src/tools/execute.ts#L240), [current direct tests](../daemon/tests/tool_args_rejected.test.ts).

**Simplification:** Preserve one validated tool-call representation through dispatch. Validation failure should be an explicit variant that cannot be transformed into an executable empty argument object.

## 07. A valid thread named `threads` resolves to the wrong database

**Trigger:** Create a thread with the accepted ID `threads`.

Durable storage derives database location and ownership by searching a pseudo-filesystem path for the last `/threads/` component. The thread's name is indistinguishable from that structural directory name.

**Observed:**

```text
input:     /tmp/data/ada/threads/threads/active.jsonl
data root: /tmp/data/ada
owner:     threads
key:       threads/threads/active.jsonl
```

The intended data root is `/tmp/data`, and the intended owner is `ada`. Reads/writes therefore address a nested `ada/shore.db`, while archive operations use the actual top-level history database. This creates split storage and inconsistent export/deletion behavior.

**Evidence:** [path inference](../daemon/src/storage/files.ts#L4), [accepted thread IDs](../daemon/src/engine/threads.ts#L24), [engine storage paths](../daemon/src/engine/conversation.ts#L90).

**Simplification:** Pass `{ dataDir, character, thread, stateKind }` directly to storage. Do not reverse-engineer database ownership from a fabricated filename. Add name-collision cases when replacing this compatibility layer.

## 08. Reading a legacy file can overwrite newer database state

**Trigger:** A stale legacy file reappears after a restore, interrupted cleanup, or an older writer touches the data directory.

`readState` checks the filesystem first. If a file exists, it unconditionally imports it with an upsert and removes the file. It never checks whether newer state already exists in SQLite. “Read” is therefore also a destructive migration operation, repeatedly available during normal runtime.

**Observed:** After storing `new DB content`, placing a legacy file with `old restored file` at the equivalent path, and reading the state, the database permanently contained `old restored file`.

The SQL-database migration code has conflict preservation, but this file-state migration path does not.

**Evidence:** [read and upsert](../daemon/src/storage/store.ts#L100), [startup file import](../daemon/src/storage/prepare.ts#L12), [SDK book has a similar read/import pattern](../daemon/src/llm/providers/agent_sessions.ts#L80).

**Simplification:** Run explicit, versioned migration before normal access. Existing DB state should win unless a deliberate conflict-resolution operation says otherwise; preserve conflicting source content for inspection. Normal reads should not replace authoritative state.

## 09. MCP servers can stall on an unread stderr pipe

**Trigger:** A stdio MCP server writes enough diagnostic output.

Shore creates `StdioClientTransport` with `stderr: "pipe"` but never consumes its stderr stream. The installed SDK pipes the child into a `PassThrough` stream exposed for the caller to read. That stream eventually applies backpressure to the child.

**Observed:** A local fake server initialized successfully when quiet. The same server, writing 2 MiB to stderr before initialization, remained blocked after one second and never reached the marker immediately after those writes. No network service was involved. The probe terminated its own subprocess afterwards.

This is also a diagnostic failure: the output needed to explain a broken integration is hidden in an unread pipe.

**Evidence:** [MCP connection](../daemon/src/mcp/client.ts#L79). Verified against the installed SDK's `dist/esm/client/stdio.js`, which exposes the piped stream via `stderr`.

**Simplification:** Retain the transport and drain stderr immediately into a bounded logger, or deliberately inherit/discard it. Close the transport on connection failure as well.

## 10. Clearing one thread resets other threads' frozen prompts

**Trigger:** Edit a canonical prompt file, then clear or compact a different thread of the same character.

Conversation state is per thread, but frozen prompts and the deferred-edit queue are stored once per character. `/clear` deletes that character-wide snapshot. A subsequent request in an ongoing thread rebuilds it from current canonical files, changing that thread's supposedly frozen context without rotating its conversation.

**Observed:** Main's frozen `SOUL.md` was `Ada`. After changing the canonical file to `Ada changed` and clearing `side`, preparing main again returned `Ada changed`.

This can change behavior mid-conversation and invalidate expensive provider prefixes. The same lifecycle mismatch appears in deferred edits, which decide emptiness using the home thread alone.

**Evidence:** [snapshot storage](../daemon/src/memory/deferred_edits.ts#L252), [global reset](../daemon/src/memory/deferred_edits.ts#L287), [clear reset](../daemon/src/commands/segments.ts#L171), [home-only emptiness check](../daemon/src/memory/deferred_edits.ts#L311).

**Simplification:** Give each active conversation a prompt snapshot identity. Canonical character files can remain shared; adopting an updated snapshot must be scoped to the conversation that is starting or rotating.

## 11. Generated images disappear when tool messages are merged for display

**Trigger:** Generate an image in a tool round, then finish with a normal assistant response.

`attachGeneratedImage` attaches the image to the assistant message that issued the tool call. `mergeGroup` combines the round's content but takes `images` only from the final assistant message. The normal final response has an empty images array. Matrix mirroring of the completed response also reads that final message's images.

**Observed:** Merging an assistant image-generation call carrying one image, its tool result, and a final assistant reply produced a displayed message with `images: []`.

The immediate `send_image` frame can make the feature appear to work until history is refreshed or the client reconnects. The underlying image file is not necessarily lost.

**Evidence:** [image attachment](../daemon/src/tools/execute.ts#L254), [display merge](../daemon/src/engine/merge.ts#L104), [final message construction](../daemon/src/handler/persistence.ts#L227), [Matrix mirror](../daemon/src/connections/matrix/mirror.ts#L33).

**Simplification:** Define a turn-level result containing its text, tool activity, and media. All display and delivery paths should project from that result, or at minimum aggregate and deduplicate images across the whole merged group.

## 12. Failed or skipped background compaction looks like success to zero turns

**Trigger:** Compaction hits its token ceiling, or a pass returns no outcome because another branch owns the relevant coverage.

The compactor already produces a useful discriminated result. `runCompaction` and `handleCompactionOutcome` collapse several outcomes into a number. A truncated result returns `0`, and an absent result also returns `0`. Inline and idle callers interpret a returned number as successful retained-turn count and call completion handlers.

**Observed:** Passing a truncated outcome through the real background adapter returned `0` despite explicitly logging that the conversation was not archived. The inline caller then has no way to distinguish this from successful compaction retaining zero turns.

Manual compaction exposes a separate, richer outcome path, so the same operation has different error semantics depending on how it started.

**Evidence:** [number-returning wrapper](../daemon/src/memory/compaction/run.ts#L82), [truncated conversion](../daemon/src/memory/compaction/background.ts#L79), [inline completion](../daemon/src/handler/turn.ts#L229), [idle completion](../daemon/src/autonomy/idle_compaction.ts), [manual outcome handling](../daemon/src/commands/compact.ts#L97).

**Simplification:** Keep the structured result through every caller. Only actual rotation should reset scheduling counts; paused, truncated, busy, and no-work outcomes need explicit handling.

## 13. Subscription accounting is globally overridden by character order

**Trigger:** Two character configs use the same provider name but disagree on `subscription`.

`applySubscriptionProviders` walks global and character configs into one process-global set. Later characters overwrite earlier ones. The ledger classifies every call using only that global provider set, even though it has the call's character. Subscription classification discards provider-reported dollar cost and stores zero.

**Observed:** With one paid and one subscription character, reversing their enumeration order changed `isSubscriptionProvider("audit")` from `true` to `false`. Both characters' calls are classified according to whichever setting won globally.

**Impact:** Usage reporting and budget enforcement can undercount paid calls or charge subscription calls as paid. This is an application accounting defect; the probe did not make billable calls.

**Evidence:** [global configuration merge](../daemon/src/runtime.ts#L539), [process-global set](../daemon/src/ledger/store.ts#L170), [ledger cost classification](../daemon/src/ledger/store.ts#L553), [character config merge](../daemon/src/config/loader.ts).

**Simplification:** Resolve accounting policy from the effective configuration for each call and record that policy with the call. Avoid mutable global provider classification when credentials and provider settings can vary by character.

## 14. Small updates rewrite whole histories, transcripts, and client snapshots

**Trigger:** Long conversations, large subagent/tool payloads, or frequent SDK transcript appends.

An active message mutation clones the entire message array, serializes all messages to JSONL, and compresses/replaces one state blob. SDK transcript append similarly decompresses and parses all entries, rebuilds a UUID map, serializes everything, and recompresses the full transcript. The common storage helper opens a database, applies schema/PRAGMAs and checks migration state on each access.

Separately, each engine mutation broadcasts a full merged history snapshot and synchronously embeds image files, including alternatives. Intermediate tool messages cause these operations too. Multiple layers therefore scale with total conversation size for a small append; a sequence of growing appends performs quadratic cumulative work.

**Measured:** Appending a tiny entry to a synthetic SDK transcript containing 1 MiB of random bytes encoded as base64 took 6.0–10.6 ms; with 8 MiB it took 46.8–55.2 ms, across five appends each. This is a local synthetic measurement, not a production latency estimate. The synchronous work blocks the daemon event loop.

**Evidence:** [active mutation](../daemon/src/engine/message_store.ts#L695), [SDK append](../daemon/src/llm/providers/claude_agent_history.ts#L25), [storage open](../daemon/src/storage/store.ts#L47), [history broadcast](../daemon/src/engine/conversation.ts#L359), [synchronous media embedding](../daemon/src/engine/wire_images.ts).

**Simplification:** Store active messages and SDK entries as independently addressable rows/chunks; retain one initialized connection per store; send ordinary message deltas and use snapshots for synchronization. Fetch media by stable ID rather than resending every attachment with every mutation. More compression alone will not fix this write/read amplification.

## 15. Git tools ignore cancellation and collect unlimited process output

**Trigger:** A Git command runs slowly or emits a large diff/log.

The dispatcher calls `handleGit` without a signal. The process runner accepts no signal or deadline, never kills the child on cancellation, and buffers all stdout/stderr before resolving. The outer tool deadline merely stops waiting after its grace period. Output truncation happens after the complete output has already been collected.

**Impact:** Timed-out commands can keep running and modifying the workspace; a large output can exhaust memory despite the configured tool-result character limit. The wrapper accurately warns that some timed-out work may still be running, but the built-in process implementation never attempts cancellation in the first place.

**Evidence:** [dispatch](../daemon/src/tools/dispatch.ts#L210), [deadline/drain](../daemon/src/tools/dispatch.ts#L362), [process invocation](../daemon/src/tools/workspace.ts#L1228), [unbounded buffers](../daemon/src/tools/workspace.ts#L1343).

**Simplification:** Use one process runner that accepts the execution signal, terminates and reaps the process, and bounds or spools output while reading. Correcting finding 02 alone will not fix this lower-level omission.

## 16. Environment reload retains removed values and mutates state before validation

**Trigger:** Remove a key from `.env`, or reload an invalid config alongside environment changes.

`applyDotenv` assigns current keys into the existing environment but does not remember or remove keys previously supplied by the file. `loadRawConfigTable` applies this mutation before parsing/validating TOML. A failed reload that advertises “keeping the running config” can therefore still change credentials used by subsequent calls.

**Observed:** Loading `AUDIT_KEY=old`, replacing the file with an empty file, and loading again left `AUDIT_KEY` equal to `old`. No real credential values were inspected.

**Evidence:** [assignment-only reload](../daemon/src/config/dotenv.ts#L62), [environment mutation before parsing](../daemon/src/config/loader.ts#L184), [failed-reload handling](../daemon/src/handler/deps.ts#L497).

**Simplification:** Parse config and its environment overlay into a candidate snapshot, validate it, then adopt both together. Track file-owned values separately from the inherited process environment so removing an override has defined behavior.

## 17. Dice input can request billions of synchronous iterations

**Trigger:** A model calls `roll_dice` with a very large count.

The parser accepts counts up to `u32::MAX`; execution allocates an array of every roll and loops synchronously. There is no practical operation limit. The async timeout wrapper cannot interrupt JavaScript that does not yield.

**Observed:** `parseDiceNotation("4294967295d6")` accepted a count of `4,294,967,295`. Execution of that input was deliberately omitted. The tool schema only requires a notation string.

This small utility can freeze or crash the entire daemon. Preserving a Rust integer range does not establish an appropriate application limit.

**Evidence:** [parser](../daemon/src/tools/basic.ts#L33), [synchronous execution](../daemon/src/tools/basic.ts#L96), [tool schema](../daemon/src/tools/registry.ts#L106).

**Simplification:** Enforce a modest explicit maximum roll count before execution. Use practical resource limits at input validation, rather than expecting a generic timeout to bound synchronous work.

## 18. Dependency freshness is enforced too late in the development cycle

**Trigger:** Investigate or implement a fix before checking whether current dependencies already solve the problem.

The pre-commit hook runs `bun update --latest` and `cargo upgrade --incompatible` before verification and stops for review when manifests change. This implements an intentional project requirement: use current upstream fixes and discover compatibility problems early. The original audit recommendation to move updates out of the hook did not account for that requirement and is withdrawn.

**Impact:** A commit-time check alone arrives after the investigation and implementation. An agent may already have spent hours duplicating an upstream fix or working around a limitation that no longer exists.

**Evidence:** [Bun upgrade](../.githooks/pre-commit#L65), [Cargo upgrade](../.githooks/pre-commit#L97). These commands were inspected, not executed during the audit.

**Revised recommendation:** Update all project toolchains and dependencies at the start of work, establish a tested baseline, and reproduce the original problem again before implementing a fix. Inspect the installed upstream implementation before duplicating functionality. Keep dependency changes in separate commits and retain the existing hook as a final freshness and verification backstop.

**Follow-up:** The root [AGENTS.md](../AGENTS.md) now requires this workflow and relevant tests before committing. The hook remains unchanged. This adds an agent policy; it does not claim that dependency updates or a new automated start-of-work gate have been executed or implemented.

## Suggested repair order

1. Fix conversation ownership and identity together: 01, 03, 04, 05, 07, and 10. Establish one explicit conversation reference and lifecycle rather than adding more character/thread exceptions.
2. Fix execution correctness: 02, 06, 09, and 15. Carry cancellation and validation information intact, and own subprocess lifetime/output.
3. Fix persistence and accounting boundaries: 08 and 13. Reads and other characters' configuration must not silently rewrite authoritative state or billing policy.
4. Unify result handling and projections: 11 and 12. Preserve turn media and structured compaction outcomes through every caller.
5. Address amplification and operational predictability: 14, 16, 17, and 18.

Several fixes can be small initially, but local patches need tests at the boundaries that previously dropped information. In particular, direct tests of a parser, cancellation helper, or compaction runner do not establish that the assembled generation path preserves their contracts.

## Validation and scope

Baseline verification on the audited worktree:

- `cd daemon && bun test`: **8,079 passed**, 0 failed, 251 files.
- `cd client && cargo test --workspace`: **1,178 passed**, 0 failed, 14 ignored, including integration and documentation tests.
- Separate disposable probes exercised real generation, clearing, compaction, storage, event routing, tool dispatch, config-refresh orchestration, prompt snapshots, and accounting configuration. Fake providers were controlled to expose ordering and cancellation behavior. All assertions in the completed combined probe passed, confirming the unwanted behaviors described above.
- A separate local MCP subprocess probe compared quiet initialization with initialization preceded by stderr output. A separate synthetic transcript probe measured small-append cost.

The broad passing suites do not contradict these findings: the probes cover interactions the existing tests do not establish. For example, the malformed-argument tests verify the parser and executor directly, while the defect sits in the conversions between them.

Reviewed areas include daemon startup and ownership, migration/state storage, conversation persistence and alternatives, routing and Rust synchronization/reconnect, generation/retry/tool-loop assembly, SDK session handling, tools and MCP, compaction/autonomy, prompt snapshots, configuration reload, usage accounting, Matrix mirroring, character archive flows, and verification hooks. Inspection depth varied; this is a general reliability audit, not a claim that every line or provider-specific behavior has been proven correct.

External model APIs, live Matrix rooms, the installed daemon/database under `/opt/docker/silvershore`, crash/power-loss recovery, and prolonged production load were not exercised. There are no claims here about actual historical billing errors or how frequently the reproduced races occur in the user's installation.
