//! Types and helpers shared by the Silvershore daemon and its clients.
//!
//! Everything here is used by at least two binaries; daemon-private code lives
//! in `shore-daemon` instead.

pub mod config;
pub mod diagnostics;
pub mod protocol;
pub mod swp_client;
