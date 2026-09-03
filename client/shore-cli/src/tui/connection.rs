pub(crate) use shore_common::swp_client::conn_manager::{ConnCommand, ConnEvent};

pub(crate) fn spawn_connection(
    addr: Option<String>,
    character: Option<String>,
    thread: Option<String>,
) -> (
    tokio::sync::mpsc::Sender<ConnCommand>,
    tokio::sync::mpsc::Receiver<ConnEvent>,
) {
    shore_common::swp_client::spawn_connection(addr, None, "tui", "shore", character, thread)
}
