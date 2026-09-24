use crate::protocol::client_msg::ClientMessage;
use crate::protocol::server_msg::ServerMessage;
use crate::swp_client::sync::{SyncDecision, SyncState};
use crate::swp_client::{SWPConnection, ServerAddr, discover_or_default};
use crate::token::TokenSource;
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
    token: TokenSource,
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
        SessionTarget {
            character,
            thread,
            token,
        },
        event_tx,
        cmd_rx,
    ));

    (cmd_tx, event_rx)
}

#[derive(Debug, Clone, Default)]
struct SessionTarget {
    character: Option<String>,
    thread: Option<String>,
    token: TokenSource,
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

async fn await_without_queueing<F: Future>(
    future: F,
    event_tx: &mpsc::Sender<ConnEvent>,
    cmd_rx: &mut mpsc::Receiver<ConnCommand>,
) -> Option<F::Output> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            biased;
            _ = event_tx.closed() => return None,
            output = &mut future => return Some(output),
            command = cmd_rx.recv() => match command {
                Some(ConnCommand::Shutdown) | None => return None,
                Some(ConnCommand::Send(message)) => {
                    if event_tx.try_send(ConnEvent::SendFailed(message)).is_err() {
                        return None;
                    }
                }
            },
        }
    }
}

async fn send_event(
    event: ConnEvent,
    event_tx: &mpsc::Sender<ConnEvent>,
    cmd_rx: &mut mpsc::Receiver<ConnCommand>,
) -> bool {
    matches!(
        await_without_queueing(event_tx.send(event), event_tx, cmd_rx).await,
        Some(Ok(()))
    )
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
                if !send_event(
                    ConnEvent::Disconnected(format!("address resolution failed: {e}")),
                    &event_tx,
                    &mut cmd_rx,
                )
                .await
                {
                    return;
                }
                if await_without_queueing(sleep(backoff), &event_tx, &mut cmd_rx)
                    .await
                    .is_none()
                {
                    return;
                }
                backoff = next_backoff(backoff, max_backoff);
                continue;
            }
        };
        info!(addr = ?resolved, client = %app_name, "attempting connection");

        let attempt = SWPConnection::connect_in_thread(
            &resolved,
            &client_id,
            &app_name,
            target.character.clone(),
            target.thread.clone(),
            &target.token,
        );
        let Some(result) = await_without_queueing(attempt, &event_tx, &mut cmd_rx).await else {
            return;
        };
        match result {
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

                if !send_event(
                    ConnEvent::Connected {
                        server_name: hello.server_name,
                        characters: hello.characters,
                        history: history.messages,
                        active_start: history.active_start,
                        config: history.config,
                        selected_character: history.selected_character,
                        selected_thread: history.selected_thread,
                    },
                    &event_tx,
                    &mut cmd_rx,
                )
                .await
                {
                    return;
                }

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
                if !send_event(
                    ConnEvent::Disconnected(format!("connect failed: {e}")),
                    &event_tx,
                    &mut cmd_rx,
                )
                .await
                {
                    return;
                }
            }
        }

        info!(
            backoff_ms = backoff.as_millis(),
            "reconnecting after backoff"
        );
        if await_without_queueing(sleep(backoff), &event_tx, &mut cmd_rx)
            .await
            .is_none()
        {
            return;
        }
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
                        let Some(result) = await_without_queueing(conn.send(&msg), event_tx, cmd_rx).await else {
                            return SessionOutcome::Exit;
                        };
                        if let Err(e) = result {
                            error!(error = %e, "send failed, disconnecting");
                            if !send_event(ConnEvent::SendFailed(msg), event_tx, cmd_rx).await {
                                return SessionOutcome::Exit;
                            }
                            if !send_event(ConnEvent::Disconnected(format!("send failed: {e}")), event_tx, cmd_rx).await {
                                return SessionOutcome::Exit;
                            }
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
                        if !send_event(ConnEvent::Disconnected("server shutdown".into()), event_tx, cmd_rx).await {
                            return SessionOutcome::Exit;
                        }
                        return SessionOutcome::Reconnect;
                    }
                    Ok(ServerMessage::Ping(_)) => {
                    }
                    Ok(server_msg) => {
                        let decision = sync_state.observe(&server_msg);
                        if matches!(decision, SyncDecision::Resync) {
                            if !send_event(ConnEvent::Disconnected("history revision gap".into()), event_tx, cmd_rx).await {
                            return SessionOutcome::Exit;
                        }
                            return SessionOutcome::Reconnect;
                        }
                        if matches!(decision, SyncDecision::DropStale) {
                            debug!(
                                latest_revision = sync_state.latest_revision(),
                                "dropping stale sync message"
                            );
                            continue;
                        }
                        if !send_event(ConnEvent::Message(server_msg), event_tx, cmd_rx).await {
                            debug!("event receiver dropped, exiting connection loop");
                            return SessionOutcome::Exit;
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "connection lost");
                        if !send_event(ConnEvent::Disconnected("connection lost".into()), event_tx, cmd_rx).await {
                            return SessionOutcome::Exit;
                        }
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

    #[tokio::test(start_paused = true)]
    async fn revision_gap_notifies_the_ui_before_reconnecting() {
        use tokio::io::AsyncWriteExt;

        let (client, mut server) = tokio::io::duplex(4096);
        let mut conn = SWPConnection::from_raw_stream(client);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let (_cmd_tx, mut cmd_rx) = mpsc::channel(1);
        let mut sync_state = SyncState::new(2, Some("ada"), Some("side"));
        server
            .write_all(
                concat!(
                    "{\"type\":\"stream_start\",\"rid\":\"reply\",\"regen\":false}\n",
                    "{\"type\":\"history\",\"messages\":[],\"revision\":4,",
                    "\"selected_character\":\"ada\",\"selected_thread\":\"side\",",
                    "\"delta\":{\"base_revision\":3,\"after\":\"missing\"}}\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let outcome = tokio::time::timeout(
            Duration::from_secs(1),
            run_connected_session(&mut conn, &event_tx, &mut cmd_rx, &mut sync_state),
        )
        .await
        .unwrap();

        assert!(matches!(outcome, SessionOutcome::Reconnect));
        assert!(matches!(
            event_rx.try_recv().unwrap(),
            ConnEvent::Message(ServerMessage::StreamStart(_))
        ));
        assert!(
            matches!(event_rx.try_recv().unwrap(), ConnEvent::Disconnected(_)),
            "the UI must discard the abandoned stream before reconnecting"
        );
        assert!(
            event_rx.try_recv().is_err(),
            "the invalid delta must not reach the UI"
        );
        assert_eq!(sync_state.latest_revision(), 2);
        assert_eq!(sync_state.selected_thread(), Some("side"));
    }

    #[tokio::test]
    async fn send_failure_returns_the_unsent_message() {
        let (client, server) = tokio::io::duplex(64);
        drop(server);
        let mut conn = SWPConnection::from_raw_stream(client);
        let (event_tx, mut event_rx) = mpsc::channel(2);
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
        assert!(
            matches!(event_rx.recv().await.unwrap(), ConnEvent::Disconnected(_)),
            "a socket failure must also tell the UI to reconnect"
        );
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{ConnCommand, ConnEvent, Duration, spawn_connection};
    use crate::token::TokenSource;

    const HANG_GUARD: Duration = Duration::from_secs(5);

    fn token() -> TokenSource {
        TokenSource::Given("test-token".into())
    }

    #[tokio::test]
    async fn shutdown_interrupts_a_peer_that_never_sends_hello() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (tx, mut rx) = spawn_connection(
            Some(listener.local_addr().unwrap().to_string()),
            None,
            "test",
            "test",
            None,
            None,
            token(),
        );
        let (mut socket, _) = listener.accept().await.unwrap();
        tx.send(ConnCommand::Shutdown).await.unwrap();
        assert!(
            tokio::time::timeout(HANG_GUARD, rx.recv())
                .await
                .unwrap()
                .is_none()
        );
        let mut byte = [0_u8];
        assert_eq!(
            tokio::io::AsyncReadExt::read(&mut socket, &mut byte)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn shutdown_interrupts_reconnect_backoff() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        drop(listener);
        let (tx, mut rx) =
            spawn_connection(Some(address), None, "test", "test", None, None, token());
        assert!(matches!(
            tokio::time::timeout(HANG_GUARD, rx.recv()).await.unwrap(),
            Some(ConnEvent::Disconnected(_))
        ));
        tx.send(ConnCommand::Shutdown).await.unwrap();
        assert!(
            tokio::time::timeout(HANG_GUARD, rx.recv())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn disconnected_messages_fail_promptly_without_waiting_for_the_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (tx, mut rx) = spawn_connection(
            Some(listener.local_addr().unwrap().to_string()),
            None,
            "test",
            "test",
            None,
            None,
            token(),
        );
        let (_socket, _) = listener.accept().await.unwrap();
        tx.send(ConnCommand::Send(
            crate::protocol::client_msg::ClientMessage::Regen(crate::protocol::client_msg::Regen {
                rid: Some("pending".into()),
                stream: true,
                guidance: None,
            }),
        ))
        .await
        .unwrap();
        assert!(matches!(
            tokio::time::timeout(HANG_GUARD, rx.recv()).await.unwrap(),
            Some(ConnEvent::SendFailed(_))
        ));
        tx.send(ConnCommand::Shutdown).await.unwrap();
    }
}

#[cfg(test)]
mod blocked_io_tests {
    use super::{
        ConnCommand, ConnEvent, Duration, SessionOutcome, run_connected_session, send_event,
    };
    use crate::protocol::client_msg::{ClientMessage, Command};
    use crate::swp_client::{SWPConnection, sync::SyncState};

    async fn settle() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn rejecting_an_extra_command_keeps_the_original_socket_and_response() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

        let (stream, peer) = tokio::io::duplex(8);
        let mut conn = SWPConnection::from_raw_stream(stream);
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(8);
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel(2);
        let task = tokio::spawn(async move {
            let mut sync = SyncState::new(0, None, None);
            run_connected_session(&mut conn, &event_tx, &mut cmd_rx, &mut sync).await
        });
        let command = |rid: &str| {
            ConnCommand::Send(ClientMessage::Command(Command {
                rid: Some(rid.into()),
                name: "status".into(),
                args: serde_json::json!({}),
            }))
        };
        cmd_tx.send(command("original")).await.unwrap();
        let mut reader = BufReader::new(peer);
        assert_eq!(reader.read_u8().await.unwrap(), b'{');
        cmd_tx.send(command("extra")).await.unwrap();
        let rejected = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(rejected, ConnEvent::SendFailed(ClientMessage::Command(Command { rid:Some(ref rid), .. })) if rid == "extra")
        );
        let mut line = String::from("{");
        let _read = reader.read_line(&mut line).await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line)
                .unwrap()
                .get("rid")
                .and_then(serde_json::Value::as_str),
            Some("original")
        );
        reader
            .write_all(b"{\"type\":\"stream_start\",\"rid\":\"original\"}\n")
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(reply, ConnEvent::Message(ref frame) if frame.request_id() == Some("original"))
        );
        assert!(
            event_rx.try_recv().is_err(),
            "a rejected extra command must not announce a disconnect"
        );
        cmd_tx.send(ConnCommand::Shutdown).await.unwrap();
        assert!(matches!(task.await.unwrap(), SessionOutcome::Exit));
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_interrupts_a_full_event_queue() {
        let (event_tx, _event_rx) = tokio::sync::mpsc::channel(1);
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel(1);
        event_tx
            .try_send(ConnEvent::Disconnected("existing".into()))
            .unwrap();
        let sending = tokio::spawn(async move {
            send_event(
                ConnEvent::Disconnected("pending".into()),
                &event_tx,
                &mut cmd_rx,
            )
            .await
        });
        settle().await;
        assert!(!sending.is_finished(), "it must still be blocked");
        cmd_tx.send(ConnCommand::Shutdown).await.unwrap();
        assert!(
            !tokio::time::timeout(Duration::from_millis(250), sending)
                .await
                .unwrap()
                .unwrap()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_interrupts_a_write_to_a_peer_that_is_not_reading() {
        let (stream, _peer) = tokio::io::duplex(8);
        let mut conn = SWPConnection::from_raw_stream(stream);
        let (event_tx, _event_rx) = tokio::sync::mpsc::channel(1);
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel(2);
        cmd_tx
            .send(ConnCommand::Send(ClientMessage::Command(Command {
                rid: Some("blocked".into()),
                name: "status".into(),
                args: serde_json::json!({}),
            })))
            .await
            .unwrap();
        let task = tokio::spawn(async move {
            let mut sync = SyncState::new(0, None, None);
            matches!(
                run_connected_session(&mut conn, &event_tx, &mut cmd_rx, &mut sync).await,
                SessionOutcome::Exit
            )
        });
        settle().await;
        assert!(!task.is_finished(), "it must still be blocked");
        cmd_tx.send(ConnCommand::Shutdown).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), task)
                .await
                .unwrap()
                .unwrap()
        );
    }
}
