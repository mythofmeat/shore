//! Re-exports the shared connection manager from shore-swp-client.

pub use shore_swp_client::conn_manager::{ConnCommand, ConnEvent};

/// Spawn the TUI connection manager.
pub fn spawn_connection(
    addr: Option<String>,
    config: Option<String>,
    character: Option<String>,
) -> (
    tokio::sync::mpsc::Sender<ConnCommand>,
    tokio::sync::mpsc::Receiver<ConnEvent>,
) {
    shore_swp_client::spawn_connection(addr, config, "tui", "shore-tui", character)
}
