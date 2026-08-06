//! The three things an autonomy tick can decide to do — and nothing that
//! decides them.
//!
//! **This module does not compile, deliberately.** See below.
//!
//! The loop is TypeScript. `llm-sidecar/src/autonomy/` holds the heartbeat
//! clock, the activity tracker, the per-tick trigger decision,
//! `autonomy_state.json` and `heartbeat.jsonl`, and it is pinned against the
//! Rust that used to do all of that by the frozen fixtures in
//! `llm-sidecar/tests/autonomy_fixtures/`. That Rust is gone.
//!
//! What is left in `manager.rs` is the heartbeat tick, idle compaction and the
//! deep-idle archive, verbatim. They are next (#12), and until they land they
//! are a *specification*: the port reads them, generates fixtures from them,
//! replays those against TypeScript, and then this directory goes.
//!
//! ## What in it has already ported
//!
//! The cached request and everything around it — `AutonomyState::last_request`,
//! `cache_last_request`, `invalidate_cached_request`, `reprime_decision`,
//! `reprime_keepalive_from_tick`, `heartbeat_rebuild_messages`,
//! `history_is_between_turns`, `heartbeat_idle_anchor_message`,
//! `rebuild_request_from_disk`, and the on-demand ping's `KeepalivePing` —
//! is `llm-sidecar/src/autonomy/{rebuild,last_request}.ts` and
//! `src/commands/keepalive.ts`, pinned by
//! `tests/autonomy_fixtures/last_request_parity.json`.
//!
//! They are **not deleted here**, and that is deliberate rather than an
//! oversight: the three remaining actions call them, and a specification with
//! holes in it is a worse specification. They go with the last of the three.
//! `POST /v1/keepalive/prefix` and its client half *are* deleted, on both
//! sides — that was the bridge, and the bridge is what had to die.
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
