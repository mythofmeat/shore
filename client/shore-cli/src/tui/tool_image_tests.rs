use super::app::Block;
use super::ui::scenario_tests::Harness;
use super::{ServerMessage, handle_server_message};
use crossterm::event::KeyCode;

fn read_flow(markdown: bool) -> serde_json::Value {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../daemon/tests/support/read_image_preview.ts");
    let output = std::process::Command::new("bun")
        .arg(script)
        .arg(if markdown { "markdown" } else { "image" })
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "read failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn read_image_is_visible_when_the_result_arrives_and_after_reload() {
    assert_read_preview(false);
}

#[test]
fn markdown_read_images_are_visible_when_the_result_arrives_and_after_reload() {
    assert_read_preview(true);
}

fn assert_read_preview(markdown: bool) {
    let flow = read_flow(markdown);
    for live in [false, true] {
        let mut h = Harness::new();
        let frames = if live {
            h.app.stream.active = true;
            flow.get("live").unwrap().as_array().unwrap().clone()
        } else {
            vec![flow.get("history").unwrap().clone()]
        };
        for frame in frames {
            let message: ServerMessage = serde_json::from_value(frame).unwrap();
            let _ = handle_server_message(&mut h.app, message);
        }
        let refs = h
            .app
            .entries
            .iter()
            .filter_map(|entry| entry.as_turn())
            .flat_map(|turn| &turn.blocks)
            .find_map(|block| {
                if let Block::ToolResult { images, .. } = block {
                    Some(images.clone())
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(refs.len(), 1, "the read result retains its image");
        let image = refs.first().unwrap();
        assert!(
            image.data.is_some(),
            "remote clients need embedded image bytes"
        );
        let screen = h.render_quiet();
        if markdown {
            assert!(
                screen.contains("![Chart](../chart.png)"),
                "the Markdown source remains visible beside its image: {screen}"
            );
        }
        assert!(
            !screen.contains("[Image attached]"),
            "image must not be flattened: {screen}"
        );
        let transmitted = h.app.image_cache.get(&image.path).is_some();
        if std::env::var_os("SHORE_TEST_REQUIRE_IMAGE_TRANSMISSION").is_some() {
            assert!(transmitted, "the PTY check must transmit the read image");
        }
        if transmitted {
            assert_eq!(
                h.app.image_index.len(),
                1,
                "the preview is available to the viewer"
            );
            assert!(
                screen.contains('\u{10EEEE}'),
                "the terminal receives Kitty image placeholders: {screen}"
            );
            h.press(KeyCode::Esc);
            h.press(KeyCode::Char('o'));
            assert_eq!(h.app.fullscreen, Some(0), "the read image opens fullscreen");
            assert!(
                h.render_quiet().contains('\u{10EEEE}'),
                "fullscreen renders the image"
            );
            h.press(KeyCode::Esc);
        } else {
            assert!(
                screen.contains("[image:"),
                "unsupported terminals retain an image label: {screen}"
            );
        }
        h.press(KeyCode::Esc);
        h.press(KeyCode::Char('p'));
        assert!(
            h.render_quiet().contains("[image:"),
            "hiding previews preserves the label"
        );
        assert!(
            h.app.image_index.is_empty(),
            "hidden images leave the viewer index"
        );
        h.app.show_tools = false;
        assert!(
            !h.render_quiet().contains("[image:"),
            "hiding tool results hides their images"
        );
    }
}

#[test]
fn read_image_stays_in_its_subagent_or_compaction_result() {
    let flow = read_flow(false);
    for lane in ["research", "compaction"] {
        let mut h = Harness::new();
        for frame in flow.get("live").unwrap().as_array().unwrap() {
            let mut tagged = frame.clone();
            let fields = tagged.as_object_mut().unwrap();
            let _ = fields.insert("subagent".into(), lane.into());
            let _ = fields.insert("task_id".into(), "background-read".into());
            let _ = handle_server_message(&mut h.app, serde_json::from_value(tagged).unwrap());
        }
        assert!(
            h.app.entries.is_empty(),
            "background reads stay out of the chat turn"
        );
        let blocks = if lane == "compaction" {
            h.app.show_compaction = true;
            &h.app.compaction.as_ref().unwrap().blocks
        } else {
            h.app.open_subagent_panel();
            &h.app.subagent_tasks.first().unwrap().blocks
        };
        let images = blocks
            .iter()
            .find_map(|block| {
                if let Block::ToolResult { images, .. } = block {
                    Some(images)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(images.len(), 1, "the background result retains its preview");
        let transmitted = h
            .app
            .image_cache
            .get(&images.first().unwrap().path)
            .is_some();
        let screen = h.render_quiet();
        if std::env::var_os("SHORE_TEST_REQUIRE_IMAGE_TRANSMISSION").is_some() {
            assert!(
                transmitted,
                "the PTY check must transmit the background image"
            );
        }
        assert!(
            screen.contains(if transmitted { "\u{10EEEE}" } else { "[image:" }),
            "the {lane} result displays its preview: {screen}"
        );
    }
}
