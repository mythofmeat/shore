#![expect(
    clippy::expect_used,
    clippy::panic,
    clippy::unwrap_used,
    reason = "integration tests fail fast on setup/assertion failures (mirrors clippy.toml's allow-unwrap/expect/panic-in-tests, which does not reach helper code outside #[test] fns)"
)]
#![cfg_attr(
    target_os = "linux",
    expect(
        clippy::print_stderr,
        reason = "the sandbox suite prints a skip notice when the kernel lacks Landlock"
    )
)]

mod helpers;

mod autonomy;
mod compaction;
mod concurrency;
mod discovery_ignore;
mod e2e;
mod guardrails;
mod heartbeat;
mod key_fallback;
mod ledger;
mod memory_integration;
mod message_integrity;
mod pipeline;
mod preferences_persist;
mod providers;
mod recovery;
mod sandbox;
mod spawn_bind_zero;
mod static_setup;
