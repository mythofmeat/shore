//! Types and helpers shared by the Silvershore clients.
//!
//! Everything here is used by `shore` and `shore-tui`, which are all the Rust
//! left in the repo. The daemon is TypeScript under `daemon/` and speaks to
//! both over SWP, so anything it needs is either on the wire (`protocol`) or
//! duplicated deliberately (`dirs`, whose whole job is finding the socket
//! before there is anyone to ask).

pub mod image_protocol;
pub mod dirs;
pub mod protocol;
pub mod swp_client;
pub mod token;

#[cfg(test)]
mod test_env;
