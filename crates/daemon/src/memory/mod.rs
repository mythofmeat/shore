//! Memory subsystem.
//!
//! Active memory for characters is markdown-first:
//! - runtime workspace tools read and write markdown files directly
//! - compaction writes markdown files directly
//! - protected character/user/system edits are staged by [`deferred_edits`]

pub mod compaction;
pub mod compaction_impls;
pub mod deferred_edits;
pub mod dreaming;
pub mod dreams_log;
pub mod markdown_query;
pub mod markdown_store;
pub mod retrieval;
pub mod workspace_index;
