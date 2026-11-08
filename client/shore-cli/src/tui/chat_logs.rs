use shore_common::protocol::operations::MessageCopy;

const STAMP: &[u8] = b"0000-00-00 Aaa 00:00  ";
const TARGET_MARK: &str = "\u{25b6} ";

pub(crate) fn is_chat_log_tool(name: &str) -> bool {
    matches!(name, "search_chat_logs" | "read_chat_logs")
}

pub(crate) fn line_message_id(line: &str) -> Option<&str> {
    let entry = line.strip_prefix(TARGET_MARK).unwrap_or(line);
    let stamped = entry.len() >= STAMP.len()
        && entry.bytes().zip(STAMP).all(|(byte, shape)| match shape {
            b'0' => byte.is_ascii_digit(),
            b'A' | b'a' => byte.is_ascii_alphabetic(),
            _ => byte == *shape,
        });
    if !stamped {
        return None;
    }
    let tail = entry.get(entry.rfind("  ")?.checked_add(2)?..)?;
    tail.split(' ').next().filter(|id| !id.is_empty())
}

pub(crate) fn listed_message_ids(output: &str) -> impl Iterator<Item = &str> {
    output.lines().filter_map(line_message_id)
}

pub(crate) fn copies_note(copies: &[MessageCopy]) -> Option<String> {
    (!copies.is_empty()).then(|| {
        copies
            .iter()
            .map(crate::output::commands::message_copy_label)
            .collect::<Vec<_>>()
            .join(" · ")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_message_a_chat_log_result_lists_is_found_by_its_id_and_nothing_else() {
        let search = [
            "Mara: 3 matches, showing 1–3, best match first",
            "",
            "2026-11-01 Sun 10:00  sam    [the keeper's name is [Mara]]  u1",
            "2026-11-01 Sun 10:01  frank  [story] (heartbeat) [Mara] rows  m_0b9c · also in main, harbor",
            "2026-11-01 Sun 10:02  sam      m_import_st_9f2e",
            "",
            "Next page: offset=3",
        ]
        .join("\n");
        assert_eq!(
            listed_message_ids(&search).collect::<Vec<_>>(),
            ["u1", "m_0b9c", "m_import_st_9f2e"]
        );

        let read = [
            "u1 in main: 1 before, 1 after (UTC)",
            "",
            "2026-11-01 Sun 09:58  frank  (heartbeat)  h1",
            "2026-11-01 Sun 09:58 was when the light went out",
            "",
            "· · · 2 h later · · ·",
            "",
            "\u{25b6} 2026-11-01 Sun 10:00  sam  u1",
            "the keeper's name is Mara",
            "",
            "2026-11-01 Sun 10:01  frank  a1",
            "Mara it is",
        ]
        .join("\n");
        assert_eq!(
            listed_message_ids(&read).collect::<Vec<_>>(),
            ["h1", "u1", "a1"]
        );

        let overview = "2026-11-01 Sun: 1 conversation, 2 messages that day (split at gaps of 90+ min, UTC)\n\n10:00 → 10:01  2 msgs  first: the keeper's name is Mara";
        assert_eq!(listed_message_ids(overview).count(), 0);
    }

    #[test]
    fn a_chat_log_result_shows_the_thread_and_segment_of_each_message_it_lists() {
        use crate::tui::connection::ConnCommand;
        use crate::tui::{App, handle_server_message, render_app_to_string};
        use serde_json::json;
        use shore_common::protocol::client_msg::ClientMessage;
        use shore_common::protocol::server_msg::ServerMessage;

        let frame = |value: serde_json::Value| -> ServerMessage {
            serde_json::from_value(value).unwrap_or(ServerMessage::Unknown)
        };
        let output = [
            "Mara: 2 matches, showing 1–2, best match first",
            "",
            "2026-11-01 Sun 10:00  sam    the keeper's name is [Mara]  u1",
            "2026-11-01 Sun 10:01  frank  [story] [Mara] rows out  u3 · also in main",
        ]
        .join("\n");
        let mut app = App::default();
        let loaded = handle_server_message(
            &mut app,
            frame(json!({
                "type": "history", "selected_character": "ada", "selected_thread": "main", "config": {}, "revision": 1,
                "messages": [
                    {"msg_id": "m_reply", "role": "assistant", "content": "", "timestamp": "2026-11-02T09:00:00Z",
                     "content_blocks": [
                        {"type": "tool_use", "id": "t1", "name": "search_chat_logs", "input": {"query": "Mara"}},
                        {"type": "tool_result", "tool_use_id": "t1", "content": output},
                        {"type": "text", "text": "Found her."},
                     ]},
                ],
            })),
        );
        let lookup = |effect: &crate::tui::UiEffect| -> Vec<(Option<String>, serde_json::Value)> {
            effect
                .cmds
                .iter()
                .filter_map(|command| match command {
                    ConnCommand::Send(ClientMessage::Command(sent)) if sent.name == "segments" => {
                        Some((sent.rid.clone(), sent.args.clone()))
                    }
                    ConnCommand::Send(_) | ConnCommand::Shutdown => None,
                })
                .collect()
        };
        let both = json!({ "action": "find", "msg_ids": ["u1", "u3"] });
        let first = lookup(&loaded);
        assert_eq!(
            first.iter().map(|(_, args)| args).collect::<Vec<_>>(),
            [&both],
            "one lookup for the whole result"
        );
        let found = |rid: Option<String>, u1_excluded: bool| {
            frame(json!({
                "type": "command_output", "name": "segments", "rid": rid,
                "data": {"character": "ada", "found": [
                    {"msg_id": "u1", "copies": [{"thread": "main", "segment": 3, "excluded": u1_excluded}]},
                    {"msg_id": "u3", "copies": [
                        {"thread": "main", "segment": 1, "excluded": true},
                        {"thread": "story", "segment": null, "excluded": false},
                    ]},
                ]},
            }))
        };
        let _ = handle_server_message(
            &mut app,
            found(first.into_iter().next().and_then(|(rid, _)| rid), false),
        );
        let screen = render_app_to_string(&mut app, 160, 30).unwrap_or_default();
        assert!(
            screen.contains("the keeper's name is [Mara]  u1  ‹main segment 3›"),
            "{screen}"
        );
        assert!(
            screen.contains(
                "[Mara] rows out  u3 · also in main  ‹main segment 1, excluded · story, not archived›"
            ),
            "{screen}"
        );
        assert!(!screen.contains("best match first  ‹"), "{screen}");

        let excluded = handle_server_message(
            &mut app,
            frame(json!({
                "type": "command_output", "name": "segments", "rid": "palette-exclude",
                "data": {"character": "ada", "thread": "main", "action": "exclude", "segment": {
                    "index": 3, "first_message_at": null, "last_message_at": null, "compacted_at": "2026-11-01T00:00:00Z",
                    "message_count": 2, "excluded": true, "label": null, "note": null, "memory_before": null, "memory_after": null,
                }},
            })),
        );
        let again = lookup(&excluded);
        assert_eq!(
            again.iter().map(|(_, args)| args).collect::<Vec<_>>(),
            [&both],
            "excluding a segment looks the listed messages up again"
        );
        let _ = handle_server_message(
            &mut app,
            found(again.into_iter().next().and_then(|(rid, _)| rid), true),
        );
        let refreshed = render_app_to_string(&mut app, 160, 30).unwrap_or_default();
        assert!(
            refreshed.contains("the keeper's name is [Mara]  u1  ‹main segment 3, excluded›"),
            "{refreshed}"
        );
    }
}
