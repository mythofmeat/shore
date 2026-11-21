use super::*;
use serde_json::json;

fn frame(value: serde_json::Value) -> ServerMessage {
    serde_json::from_value(value).unwrap()
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

#[test]
fn setting_a_threads_pins_refreshes_the_thread_list() {
    let mut app = App::default();
    let _ = handle_server_message(
        &mut app,
        frame(json!({
            "type": "command_output", "name": "thread_pins",
            "data": { "character": "ada", "home": "main", "current": "main", "threads": [
                { "id": "main", "created_at": "2026-11-21T00:00:00Z", "compaction": true, "home": true, "current": true },
                { "id": "tale", "created_at": "2026-11-21T00:00:00Z", "compaction": false, "home": false, "current": false, "pins": ["!date"] },
            ] },
        })),
    );
    assert_eq!(
        app.threads
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["main", "tale"]
    );
}
