// Tests index into fixtures freely: an out-of-bounds panic in a test is just an
// assertion failure, so `indexing_slicing` is exempted there (same rationale as
// the `allow-{unwrap,expect,panic}-in-tests` clippy.toml settings). Production code stays
// locked by the workspace lints.
#![cfg_attr(
    test,
    expect(
        clippy::indexing_slicing,
        reason = "out-of-bounds indexing in tests is an assertion failure, not a service panic"
    )
)]
// Tests do arithmetic on fixture values freely: an overflow panic in a test is
// an assertion failure, not a service panic (same rationale as the
// `indexing_slicing` exemption above). Production code stays locked by the
// workspace lints.
#![cfg_attr(
    test,
    expect(
        clippy::arithmetic_side_effects,
        reason = "overflow in tests is an assertion failure, not a service panic"
    )
)]
// Tests divide fixture values freely: truncating division on test data is a
// threshold computation, not a service correctness hazard (same rationale as
// the `arithmetic_side_effects` exemption above). Production code stays locked
// by the workspace lints.
#![cfg_attr(
    test,
    expect(
        clippy::integer_division,
        reason = "truncating division in tests is a threshold computation, not a service hazard"
    )
)]

#[cfg(test)]
pub mod test_support;

pub mod auto_discovery;
pub mod autonomy;
pub mod cache_keepalive;
pub mod call_store;
pub mod characters;
pub mod commands;
pub mod content_util;
pub(crate) mod convert;
pub mod effective_catalog;
pub mod engine;
pub mod handler;
pub mod handshake;
pub mod hot_reload;
pub mod ledger;
pub mod llm;
pub mod mcp;
pub mod memory;
pub mod notifications;
pub mod preferences;
pub mod prompts;
pub mod runtime_state;
pub mod sandbox;
pub mod swp_server;
mod sync;
pub mod templates;
pub mod tool_rpc;
pub mod tools;
pub mod transcript_capture;
