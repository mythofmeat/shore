use crate::protocol::client_msg::ClientMessage;
use crate::protocol::server_msg::ServerMessage;
use crate::swp_client::sync::{SyncDecision, SyncState};
use crate::swp_client::{SWPConnection, ServerAddr, discover_or_default};
use tokio::sync::mpsc;
use tokio::time::{Duration, sleep};
use tracing::{debug, error, info, warn};

#[derive(Debug)]
pub enum ConnEvent {
    Connected {
        server_name: String,
        characters: Vec<crate::protocol::types::CharacterInfo>,
        history: Vec<crate::protocol::types::Message>,
        active_start: usize,
        config: serde_json::Value,
        selected_character: Option<String>,
        selected_thread: Option<String>,
    },
    Message(ServerMessage),
    SendFailed(ClientMessage),
    Disconnected(String),
}

#[derive(Debug)]
pub enum ConnCommand {
    Send(ClientMessage),
    Shutdown,
}

pub fn spawn_connection(
    addr: Option<String>,
    config: Option<String>,
    client_id: &str,
    app_name: &str,
    character: Option<String>,
    thread: Option<String>,
) -> (mpsc::Sender<ConnCommand>, mpsc::Receiver<ConnEvent>) {
    let (event_tx, event_rx) = mpsc::channel(256);
    let (cmd_tx, cmd_rx) = mpsc::channel(64);

    let owned_id = client_id.to_owned();
    let owned_app = app_name.to_owned();

    let _ignored = tokio::spawn(connection_loop(
        addr,
        config,
        owned_id,
        owned_app,
        SessionTarget { character, thread },
        event_tx,
        cmd_rx,
    ));

    (cmd_tx, event_rx)
}

#[derive(Debug, Clone, Default)]
struct SessionTarget {
    character: Option<String>,
    thread: Option<String>,
}

impl SessionTarget {
    fn follow(&mut self, sync_state: &SyncState) {
        self.character = reconnect_target(sync_state, self.character.take());
        self.thread = reconnect_thread(sync_state, self.thread.take());
    }
}

fn next_backoff(current: Duration, max: Duration) -> Duration {
    current.saturating_mul(2).min(max)
}

fn resolve_addr(addr: Option<&str>, config: Option<&str>) -> crate::swp_client::Result<ServerAddr> {
    if let Some(explicit) = addr {
        return Ok(ServerAddr(explicit.to_owned()));
    }
    discover_or_default(config)
}

fn reconnect_target(sync_state: &SyncState, previous: Option<String>) -> Option<String> {
    sync_state
        .selected_character()
        .map(str::to_owned)
        .or(previous)
}

fn reconnect_thread(sync_state: &SyncState, previous: Option<String>) -> Option<String> {
    sync_state.selected_thread().map(str::to_owned).or(previous)
}

enum SessionOutcome {
    Exit,
    Reconnect,
}

async fn connection_loop(
    addr: Option<String>,
    config: Option<String>,
    client_id: String,
    app_name: String,
    mut target: SessionTarget,
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

        match SWPConnection::connect_in_thread(
            &resolved,
            &client_id,
            &app_name,
            target.character.clone(),
            target.thread.clone(),
        )
        .await
        {
            Ok((mut conn, hello, history)) => {
                info!(
                    server = %hello.server_name,
                    characters = hello.characters.len(),
                    history_len = history.messages.len(),
                    "connected to daemon"
                );
                backoff = Duration::from_millis(500);
                let mut sync_state = SyncState::new(
                    history.revision,
                    history.selected_character.as_deref(),
                    history.selected_thread.as_deref(),
                );

                let _connected_sent = event_tx
                    .send(ConnEvent::Connected {
                        server_name: hello.server_name,
                        characters: hello.characters,
                        history: history.messages,
                        active_start: history.active_start,
                        config: history.config,
                        selected_character: history.selected_character,
                        selected_thread: history.selected_thread,
                    })
                    .await;

                let outcome =
                    run_connected_session(&mut conn, &event_tx, &mut cmd_rx, &mut sync_state).await;

                target.follow(&sync_state);

                match outcome {
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

        info!(
            backoff_ms = backoff.as_millis(),
            "reconnecting after backoff"
        );
        sleep(backoff).await;
        backoff = next_backoff(backoff, max_backoff);
    }
}

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
                            let _send_fail_sent = event_tx.send(ConnEvent::SendFailed(msg)).await;
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
    use crate::protocol::client_msg::ClientMessageBody;

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

    #[test]
    fn reconnect_target_follows_the_session() {
        let sync = SyncState::new(3, Some("poppy"), Some("eval"));
        assert_eq!(
            reconnect_target(&sync, Some("Yuna".into())),
            Some("poppy".into())
        );
    }

    #[test]
    fn reconnect_target_keeps_the_startup_character_when_none_was_selected() {
        let sync = SyncState::new(0, None, None);
        assert_eq!(
            reconnect_target(&sync, Some("Yuna".into())),
            Some("Yuna".into())
        );
        assert_eq!(reconnect_target(&sync, None), None);
    }

    #[test]
    fn reconnect_thread_follows_the_session_then_falls_back_to_the_startup_thread() {
        let sync = SyncState::new(3, Some("poppy"), Some("eval"));
        assert_eq!(
            reconnect_thread(&sync, Some("main".into())),
            Some("eval".into())
        );

        let unselected = SyncState::new(0, None, None);
        assert_eq!(
            reconnect_thread(&unselected, Some("eval".into())),
            Some("eval".into())
        );
        assert_eq!(reconnect_thread(&unselected, None), None);
    }

    #[tokio::test]
    async fn send_failure_returns_the_unsent_message() {
        let (client, server) = tokio::io::duplex(64);
        drop(server);
        let mut conn = SWPConnection::from_raw_stream(client);
        let (event_tx, mut event_rx) = mpsc::channel(1);
        let (cmd_tx, mut cmd_rx) = mpsc::channel(1);
        let mut sync_state = SyncState::new(0, None, None);
        let message = ClientMessage::Message(ClientMessageBody {
            rid: None,
            text: "keep this".into(),
            stream: true,
            images: vec!["photo.png".into()],
            image_data: vec![],
            absence_seconds: None,
        });
        cmd_tx.send(ConnCommand::Send(message)).await.unwrap();

        let outcome =
            run_connected_session(&mut conn, &event_tx, &mut cmd_rx, &mut sync_state).await;

        assert!(matches!(outcome, SessionOutcome::Reconnect));
        let event = event_rx.recv().await.unwrap();
        let failed_message = match event {
            ConnEvent::SendFailed(ClientMessage::Message(failed)) => Some(failed),
            ConnEvent::Connected { .. }
            | ConnEvent::Message(_)
            | ConnEvent::SendFailed(
                ClientMessage::Hello(_)
                | ClientMessage::Regen(_)
                | ClientMessage::Command(_)
                | ClientMessage::Cancel(_),
            )
            | ConnEvent::Disconnected(_) => None,
        };
        assert!(
            failed_message.is_some(),
            "expected the failed message to be returned"
        );
        let Some(failed) = failed_message else {
            return;
        };
        assert_eq!(failed.text, "keep this");
        assert_eq!(failed.images, vec!["photo.png"]);
    }
}
