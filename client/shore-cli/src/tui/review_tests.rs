use super::*;
use serde_json::json;

fn frame(value: serde_json::Value) -> ServerMessage {
    serde_json::from_value(value).unwrap()
}

fn history(thread: &str, rid: Option<&str>, text: &str) -> ServerMessage {
    frame(
        json!({"type":"history", "rid":rid, "selected_character":"ada",
        "selected_thread":thread, "messages":[{"msg_id":"reply", "role":"assistant",
        "content":text, "timestamp":""}], "config":{}, "revision":2}),
    )
}

fn start_reply(app: &mut App) -> String {
    let rid = app.next_request_id("message");
    let _ = handle_server_message(app, frame(json!({"type":"stream_start", "rid":rid})));
    let _ = handle_server_message(
        app,
        frame(json!({"type":"stream_chunk", "rid":rid, "text":"partial reply"})),
    );
    rid
}

fn end_reply(app: &mut App, rid: &str, reason: &str) {
    let _ = handle_server_message(
        app,
        frame(json!({"type":"stream_end", "rid":rid,
        "content":"finished reply", "finish_reason":reason, "is_final":true,
        "metadata":{"model":"test", "tokens":{"input":0,"output":1,"cache_read":0,"cache_write":0},
        "timing":{"total_ms":1,"ttft_ms":1}}})),
    );
}

#[test]
fn cancellation_key_keeps_the_response_owned_until_acknowledged() {
    let mut app = App::default();
    let rid = start_reply(&mut app);
    let action = input::handle_event(
        &mut app,
        crossterm::event::Event::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('c'),
            crossterm::event::KeyModifiers::ALT,
        )),
    );
    assert!(matches!(
        action,
        Action::Send(ConnCommand::Send(ClientMessage::Cancel(_)))
    ));
    end_reply(&mut app, "unrelated", "cancelled");
    assert!(
        app.stream.active,
        "an unrelated cancellation must not stop the reply"
    );
    end_reply(&mut app, &rid, "cancelled");
    assert!(!app.stream.active);
    assert!(
        !app.entries
            .iter()
            .filter_map(ConversationEntry::as_turn)
            .any(|turn| turn.is_streaming())
    );
    assert!(
        app.notifications
            .iter()
            .any(|note| note.content == "generation cancelled")
    );

    app.input.mode = app::InputMode::Normal;
    let retry_action = input::handle_event(
        &mut app,
        crossterm::event::Event::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('r'),
            crossterm::event::KeyModifiers::NONE,
        )),
    );
    let Action::Send(ConnCommand::Send(ClientMessage::Regen(regen))) = retry_action else {
        panic!("regeneration must be available after cancellation");
    };
    let retry_rid = regen.rid.unwrap();
    assert_ne!(retry_rid, rid);
    assert!(app.stream.active);
    end_reply(&mut app, &rid, "cancelled");
    assert!(app.stream.active);
    end_reply(&mut app, &retry_rid, "end_turn");
    assert!(!app.stream.active);
    assert_eq!(
        app.entries.last().unwrap().as_turn().unwrap().joined_text(),
        "finished reply"
    );
}

#[test]
fn reconnect_retires_navigation_and_accepts_new_history_updates() {
    let mut app = App {
        character_name: "ada".into(),
        thread_name: "main".into(),
        ..App::default()
    };
    let nav = app.next_request_id("switch");
    app.pending_navigation = Some(nav.clone());
    let _ = handle_conn_event(&mut app, ConnEvent::Disconnected("socket lost".into()));
    let _ = handle_conn_event(
        &mut app,
        ConnEvent::Connected {
            server_name: "test".into(),
            characters: vec![],
            history: vec![],
            active_start: 0,
            config: json!({}),
            selected_character: Some("ada".into()),
            selected_thread: Some("main".into()),
        },
    );
    let _ = handle_server_message(&mut app, history("side", Some(&nav), "stale"));
    let _ = handle_server_message(&mut app, history("main", None, "fresh history"));
    assert!(app.pending_navigation.is_none());
    assert_eq!(app.thread_name, "main");
    assert_eq!(
        app.entries.last().unwrap().as_turn().unwrap().joined_text(),
        "fresh history"
    );
}

#[test]
fn failed_sends_restore_images_even_after_the_cleared_draft_was_collected() {
    for server_rejection in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let clipboard = tmp.path().join("clipboard.png");
        let bytes = b"\x89PNG\r\n\x1a\npayload";
        std::fs::write(&clipboard, bytes).unwrap();
        let mut app = App {
            draft_daemon: "localhost:9090".into(),
            character_name: "ada".into(),
            thread_name: "main".into(),
            ..App::default()
        };
        let mut saved = draft_snapshot(&app);
        saved.text = "caption".into();
        saved.images.push(clipboard.to_string_lossy().into_owned());
        draft::save(tmp.path(), "previous", &saved, &[clipboard]).unwrap();
        initialize_drafts(&mut app, tmp.path().to_owned());
        let persisted_image = app.pending_images.first().unwrap().clone();
        let action = input::handle_event(
            &mut app,
            crossterm::event::Event::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
        );
        let Action::Send(ConnCommand::Send(message)) = action else {
            panic!("expected a message");
        };
        draft::save(
            tmp.path(),
            &app.request_prefix,
            &draft_snapshot(&app),
            &app.paste_temp_paths,
        )
        .unwrap();
        assert!(!Path::new(&persisted_image).exists());
        if server_rejection {
            let rid = app.stream.rid.clone();
            let _ = handle_server_message(
                &mut app,
                frame(json!({"type":"error", "rid":rid,
                "code":"internal_error", "message":"rejected"})),
            );
        } else {
            let _ = handle_conn_event(&mut app, ConnEvent::SendFailed(message));
        }
        assert_eq!(app.input.text, "caption");
        assert_eq!(
            std::fs::read(app.pending_images.first().unwrap()).unwrap(),
            bytes
        );
        draft::save(
            tmp.path(),
            &app.request_prefix,
            &draft_snapshot(&app),
            &app.paste_temp_paths,
        )
        .unwrap();
        for path in app.paste_temp_paths {
            std::fs::remove_file(path).unwrap();
        }
    }
}

#[tokio::test]
async fn rejected_extra_command_does_not_retire_the_live_reply() {
    for local_queue in [false, true] {
        let mut app = App {
            connection_status: ConnectionStatus::Connected,
            ..App::default()
        };
        let rid = start_reply(&mut app);
        let rejected = ClientMessage::Command(Command {
            rid: Some(app.next_request_id("status")),
            name: "status".into(),
            args: json!({}),
        });
        if local_queue {
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            tx.try_send(ConnCommand::Send(ClientMessage::Cancel(
                shore_common::protocol::client_msg::Cancel {},
            )))
            .unwrap();
            send_conn_command(&mut app, &tx, ConnCommand::Send(rejected)).await;
        } else {
            let _ = handle_conn_event(&mut app, ConnEvent::SendFailed(rejected));
        }
        assert!(matches!(app.connection_status, ConnectionStatus::Connected));
        assert_eq!(app.stream.rid.as_deref(), Some(rid.as_str()));
        end_reply(&mut app, &rid, "end_turn");
        assert!(!app.stream.active);
        let turn = app.entries.last().unwrap().as_turn().unwrap();
        assert_eq!(turn.joined_text(), "partial reply");
        assert_eq!(turn.metadata.as_ref().unwrap().model, "test");
    }
}
