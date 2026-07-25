//! Shared connection manager for SWP clients.
//!
//! Provides a `spawn_connection()` function that spawns a background task
//! managing the daemon connection with automatic reconnect and exponential
//! backoff. Used by shore-tui and shore-matrix.

use crate::protocol::client_msg::ClientMessage;
use crate::protocol::server_msg::ServerMessage;
use crate::swp_client::{discover_or_default, SWPConnection, ServerAddr, SyncDecision, SyncState};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use tracing::{debug, error, info, warn};

/// Events sent from the connection task to the application loop.
#[derive(Debug)]
pub enum ConnEvent {
    Connected {
        server_name: String,
        characters: Vec<crate::protocol::types::CharacterInfo>,
        history: Vec<crate::protocol::types::Message>,
        active_start: usize,
        config: serde_json::Value,
        selected_character: Option<String>,
    },
    Message(ServerMessage),
    Disconnected(String),
}

/// Commands sent from the application loop to the connection task.
#[derive(Debug)]
pub enum ConnCommand {
    Send(ClientMessage),
    Shutdown,
}

/// Spawn a connection manager task.
///
/// Returns channels for bidirectional communication. The task automatically
/// reconnects on disconnection with exponential backoff (500ms → 15s).
///
/// - `addr`: optional explicit TCP address (`host:port`)
/// - `config`: optional config path for service discovery
/// - `client_id`: protocol-level client type (e.g. `"tui"`, `"bridge"`)
/// - `app_name`: human-readable application name (e.g. `"shore-tui"`, `"shore-matrix"`)
/// - `character`: optional character to select on connect
pub fn spawn_connection(
    addr: Option<String>,
    config: Option<String>,
    client_id: &str,
    app_name: &str,
    character: Option<String>,
) -> (mpsc::Sender<ConnCommand>, mpsc::Receiver<ConnEvent>) {
    let (event_tx, event_rx) = mpsc::channel(256);
    let (cmd_tx, cmd_rx) = mpsc::channel(64);

    let owned_id = client_id.to_owned();
    let owned_app = app_name.to_owned();

    let _ignored = tokio::spawn(connection_loop(
        addr, config, owned_id, owned_app, character, event_tx, cmd_rx,
    ));

    (cmd_tx, event_rx)
}

/// Compute next backoff duration, doubling each time up to the cap.
fn next_backoff(current: Duration, max: Duration) -> Duration {
    current.saturating_mul(2).min(max)
}

fn resolve_addr(addr: Option<&str>, config: Option<&str>) -> crate::swp_client::Result<ServerAddr> {
    if let Some(explicit) = addr {
        return Ok(ServerAddr(explicit.to_owned()));
    }
    discover_or_default(config)
}

/// Whether a connected session ended for good or should trigger a reconnect.
enum SessionOutcome {
    Exit,
    Reconnect,
}

async fn connection_loop(
    addr: Option<String>,
    config: Option<String>,
    client_id: String,
    app_name: String,
    character: Option<String>,
    event_tx: mpsc::Sender<ConnEvent>,
    mut cmd_rx: mpsc::Receiver<ConnCommand>,
) {
    let mut backoff = Duration::from_millis(500);
    let max_backoff = Duration::from_secs(15);

    loop {
        let resolved = match resolve_addr(addr.as_deref(), config.as_deref()) {
            Ok(resolved) => resolved,
            Err(e) => {
                error!(error = %e, "failed to resolve daemon address");
                let _resolve_fail_sent = event_tx
                    .send(ConnEvent::Disconnected(format!(
                        "address resolution failed: {e}"
                    )))
                    .await;
                sleep(backoff).await;
                backoff = next_backoff(backoff, max_backoff);
                continue;
            }
        };
        info!(addr = ?resolved, client = %app_name, "attempting connection");

        match SWPConnection::connect(&resolved, &client_id, &app_name, character.clone()).await {
            Ok((mut conn, hello, history)) => {
                info!(
                    server = %hello.server_name,
                    characters = hello.characters.len(),
                    history_len = history.messages.len(),
                    "connected to daemon"
                );
                backoff = Duration::from_millis(500);
                let mut sync_state = SyncState::new(history.revision);

                let _connected_sent = event_tx
                    .send(ConnEvent::Connected {
                        server_name: hello.server_name,
                        characters: hello.characters,
                        history: history.messages,
                        active_start: history.active_start,
                        config: history.config,
                        selected_character: history.selected_character,
                    })
                    .await;

                // Main receive/send loop
                match run_connected_session(&mut conn, &event_tx, &mut cmd_rx, &mut sync_state)
                    .await
                {
                    SessionOutcome::Exit => return,
                    SessionOutcome::Reconnect => {}
                }
            }
            Err(e) => {
                warn!(error = %e, "connect failed");
                let _ignored = event_tx
                    .send(ConnEvent::Disconnected(format!("connect failed: {e}")))
                    .await;
            }
        }

        // Exponential backoff before reconnect
        info!(
            backoff_ms = backoff.as_millis(),
            "reconnecting after backoff"
        );
        sleep(backoff).await;
        backoff = next_backoff(backoff, max_backoff);
    }
}

/// Drive one connected session's receive/send select loop. Returns
/// [`SessionOutcome::Exit`] when the manager should stop entirely (shutdown or
/// closed channels) or [`SessionOutcome::Reconnect`] when the connection
/// dropped and a reconnect should be attempted.
async fn run_connected_session(
    conn: &mut SWPConnection,
    event_tx: &mpsc::Sender<ConnEvent>,
    cmd_rx: &mut mpsc::Receiver<ConnCommand>,
    sync_state: &mut SyncState,
) -> SessionOutcome {
    loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(ConnCommand::Send(msg)) => {
                        if let Err(e) = conn.send(&msg).await {
                            error!(error = %e, "send failed, disconnecting");
                            let _send_fail_sent = event_tx.send(ConnEvent::Disconnected(
                                "send failed".into()
                            )).await;
                            return SessionOutcome::Reconnect;
                        }
                    }
                    Some(ConnCommand::Shutdown) => {
                        info!("shutdown requested, closing connection");
                        return SessionOutcome::Exit;
                    }
                    None => {
                        info!("command channel closed, exiting connection loop");
                        return SessionOutcome::Exit;
                    }
                }
            }
            msg = conn.recv() => {
                match msg {
                    Ok(ServerMessage::Shutdown(_)) => {
                        info!("server sent shutdown");
                        let _server_shutdown_sent = event_tx.send(ConnEvent::Disconnected(
                            "server shutdown".into()
                        )).await;
                        return SessionOutcome::Reconnect;
                    }
                    Ok(ServerMessage::Ping(_)) => {
                        // Keepalive — ignore
                    }
                    Ok(server_msg) => {
                        if matches!(sync_state.observe(&server_msg), SyncDecision::DropStale) {
                            debug!(
                                latest_revision = sync_state.latest_revision(),
                                "dropping stale sync message"
                            );
                            continue;
                        }
                        if event_tx.send(ConnEvent::Message(server_msg)).await.is_err() {
                            debug!("event receiver dropped, exiting connection loop");
                            return SessionOutcome::Exit;
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "connection lost");
                        let _conn_lost_sent = event_tx.send(ConnEvent::Disconnected(
                            "connection lost".into()
                        )).await;
                        return SessionOutcome::Reconnect;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_next_backoff_doubles() {
        let max = Duration::from_secs(15);
        assert_eq!(
            next_backoff(Duration::from_millis(500), max),
            Duration::from_secs(1)
        );
        assert_eq!(
            next_backoff(Duration::from_secs(1), max),
            Duration::from_secs(2)
        );
        assert_eq!(
            next_backoff(Duration::from_secs(2), max),
            Duration::from_secs(4)
        );
    }

    #[test]
    fn test_next_backoff_caps_at_max() {
        let max = Duration::from_secs(15);
        assert_eq!(next_backoff(Duration::from_secs(8), max), max);
        assert_eq!(next_backoff(Duration::from_secs(15), max), max);
        assert_eq!(next_backoff(Duration::from_secs(30), max), max);
    }

    #[test]
    fn test_next_backoff_full_sequence() {
        let max = Duration::from_secs(15);
        let mut b = Duration::from_millis(500);
        let expected = [1000, 2000, 4000, 8000, 15000, 15000];
        for &ms in &expected {
            b = next_backoff(b, max);
            assert_eq!(b, Duration::from_millis(ms));
        }
    }

    #[test]
    fn test_resolve_addr_explicit_tcp() {
        let addr = resolve_addr(Some("127.0.0.1:9090"), None).unwrap();
        assert_eq!(addr.0, "127.0.0.1:9090");
    }
}
