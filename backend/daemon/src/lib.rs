// Panic-hygiene lock (see [workspace.lints] in root Cargo.toml): this crate is
// cleaned, so these can never regress. Tests are exempt via clippy.toml.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::todo,
    clippy::unimplemented,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::as_conversions,
    clippy::allow_attributes,
    clippy::allow_attributes_without_reason,
    clippy::unwrap_in_result,
    clippy::panic_in_result_fn,
    clippy::let_underscore_must_use,
    clippy::clone_on_ref_ptr,
    clippy::dbg_macro,
    clippy::exit,
    clippy::mem_forget,
    clippy::match_wildcard_for_single_variants,
    clippy::wildcard_enum_match_arm,
    clippy::wildcard_imports,
    clippy::unseparated_literal_suffix,
    clippy::single_char_lifetime_names,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::modulo_arithmetic,
    clippy::float_arithmetic,
    clippy::string_slice,
    clippy::str_to_string,
    clippy::undocumented_unsafe_blocks,
    clippy::multiple_unsafe_ops_per_block,
    clippy::missing_assert_message,
    clippy::shadow_same,
    clippy::shadow_reuse,
    clippy::shadow_unrelated,
    clippy::else_if_without_else,
    clippy::impl_trait_in_params,
    unsafe_code,
    elided_lifetimes_in_paths,
    unused_qualifications
)]
#![cfg_attr(
    test,
    expect(
        clippy::too_many_lines,
        reason = "unit-test-only long helpers are tracked in #109"
    )
)]
// Tests index into fixtures freely: an out-of-bounds panic in a test is just an
// assertion failure, so `indexing_slicing` is exempted there (same rationale as
// the `allow-{unwrap,expect,panic}-in-tests` clippy.toml settings). Production
// code stays locked by the `#![deny(...)]` above.
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
// `#![deny(...)]` above.
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
// by the `#![deny(...)]` above.
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
pub mod characters;
pub mod commands;
pub mod content_util;
pub(crate) mod convert;
pub mod effective_catalog;
pub mod engine;
pub mod handler;
pub mod handshake;
pub mod hot_reload;
pub mod memory;
pub mod notifications;
pub mod preferences;
pub mod prompts;
pub mod runtime_state;
pub mod sandbox;
mod sync;
pub mod templates;
pub mod tools;
pub mod transcript_capture;
