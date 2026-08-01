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
