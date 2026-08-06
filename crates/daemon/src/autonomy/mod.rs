//! What is left of the things an autonomy tick can decide to do — and nothing
//! that decides them.
//!
//! **This module does not compile, deliberately.** See below.
//!
//! The loop is TypeScript. `llm-sidecar/src/autonomy/` holds the heartbeat
//! clock, the activity tracker, the per-tick trigger decision,
//! `autonomy_state.json` and `heartbeat.jsonl`, and it is pinned against the
//! Rust that used to do all of that by the frozen fixtures in
//! `llm-sidecar/tests/autonomy_fixtures/`. That Rust is gone.
//!
//! What is left in `manager.rs` is the heartbeat tick, verbatim. It is the last
//! one (#12), and until it lands the rest of this module is a *specification*:
//! the port reads it, generates fixtures from it, replays those against
//! TypeScript, and then this directory goes.
//!
//! ## What in it has already ported
//!
//! **The cached request** and everything around it — `AutonomyState::last_request`,
//! `cache_last_request`, `invalidate_cached_request`, `reprime_decision`,
//! `reprime_keepalive_from_tick`, `heartbeat_rebuild_messages`,
//! `history_is_between_turns`, `heartbeat_idle_anchor_message`,
//! `rebuild_request_from_disk`, and the on-demand ping's `KeepalivePing` —
//! is `llm-sidecar/src/autonomy/{rebuild,last_request}.ts` and
//! `src/commands/keepalive.ts`, pinned by
//! `tests/autonomy_fixtures/last_request_parity.json`.
//!
//! **The deep-idle archive** — `execute_deep_idle_archive`,
//! `execute_deep_archive_pure`, `execute_deep_archive_compaction` and
//! `reload_engine_and_apply_deferred` — is
//! `llm-sidecar/src/autonomy/deep_archive.ts`, pinned by
//! `tests/autonomy_fixtures/deep_archive_parity.json`. Its gate
//! (`execute_deep_archive_if_still_idle` and `release_deep_archive_trigger`)
//! had already gone to `runner.ts` with the deciding.
//!
//! One thing that arm did here has no equivalent on this side and became a
//! field rather than a state write: the LLM arm sets the turn counts on success
//! and *deliberately leaves `deep_archive_done` alone*, because a pass that
//! wrote no memory returns the same zero a successful one does. `runner.ts` was
//! inferring the flag from "did not fail", so it declared the idle period
//! finished after a pass that had archived nothing. It is reported explicitly
//! now — see `AutonomyActionResult.deepArchiveDone`.
//!
//! **Idle compaction** — `execute_idle_compaction` — is
//! `llm-sidecar/src/autonomy/idle_compaction.ts`. It is the one port in this
//! module with no parity fixture, and the reason is worth keeping: the pass it
//! runs, the bookkeeping it ends on and the state writes it made are each
//! already pinned somewhere else, so what remained to carry across was which
//! pieces it calls and in what order. A generated fixture would have recorded
//! nothing a test double does not. `tests/idle_compaction.test.ts` and
//! `scripts/mutate_idle_compaction.py` hold it instead.
//!
//! The four steps it and the deep archive both end on — reload the engine, drain
//! the deferred edits, invalidate the cached body, re-point the keepalive — ran
//! from two separate bodies here and are one function there
//! (`autonomy/post_archive.ts`). Two copies of the same four steps is how a fix
//! to one silently misses the other.
//!
//! Two differences from `execute_idle_compaction`, both argued for rather than
//! engineered around. A missing engine no longer refuses the pass: the Rust
//! required a `registry` so the post-pass reload could happen, and a compaction
//! that happened but did not reload beats one that did not happen. And missing
//! LLM dependencies report a failure instead of returning early — the early
//! return left `compaction_triggered` set, so nothing compacted that character
//! again until a user message cleared it, and reproducing a latch leak reachable
//! only from a context with no model wired is not worth it.
//!
//! None of it is **deleted here**, and that is deliberate rather than an
//! oversight: the heartbeat tick calls the shared pieces, and a specification
//! with holes in it is a worse specification. They go with it. `POST
//! /v1/keepalive/prefix` and its client half *are* deleted, on both sides — that
//! was the bridge, and the bridge is what had to die.
//!
//! The dream sweep was a fourth. It is not being ported — dreaming was deleted
//! outright in `cf55dff4`, and its paths here went with it rather than staying
//! on as a specification for something nothing will build.
//!
//! ## Why it is left broken
//!
//! Every one of those bodies also did bookkeeping — releasing the compaction
//! latch, moving the activity clock, writing the turn counts, pushing log
//! lines — and all of that is the sidecar's now. Making them compile again
//! means either reshaping them to take that state as parameters and return
//! events, or stubbing it. Both are work the port deletes, and both make the
//! bodies a less faithful record of what the daemon actually did.
//!
//! So they are untouched and the crate is red. `main` is what is installed;
//! `dev-ts` is a rewrite track. The bar is behavioural identity at the end,
//! established by the fixtures — not a tree that builds at every step.

pub mod manager;
