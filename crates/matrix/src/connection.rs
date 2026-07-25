//! Re-exports the shared connection manager from shore-common.

pub use shore_common::swp_client::conn_manager::{ConnCommand, ConnEvent};

/// Spawn the Matrix bridge connection manager.
///
/// `character` is the SWP handshake character selector. Pass `None` for
/// character discovery; pass `Some(name)` to speak as that character on the
/// resulting connection.
pub fn spawn_connection(
    addr: Option<String>,
    config: Option<String>,
    character: Option<String>,
) -> (
    tokio::sync::mpsc::Sender<ConnCommand>,
    tokio::sync::mpsc::Receiver<ConnEvent>,
) {
    shore_common::swp_client::spawn_connection(addr, config, "bridge", "shore-matrix", character)
}
