use std::time::{Duration, Instant};

use super::*;

const WIDTH: u16 = 80;

fn metadata() -> StreamMetadata {
    StreamMetadata {
        tokens: TokenCounts {
            input: 1,
            output: 1,
            cache_read: 0,
            cache_write: 0,
        },
        timing: shore_common::protocol::types::TimingInfo {
            total_ms: 1,
            ttft_ms: 1,
        },
        model: "opus".to_owned(),
    }
}

fn image(path: &str) -> ImageRef {
    ImageRef {
        path: path.to_owned(),
        caption: None,
        data: None,
        embed: None,
        name: None,
        problem: None,
        sha256: None,
    }
}

fn reply(text: &str) -> Turn {
    Turn::text(
        Role::Assistant,
        Some("m_2".to_owned()),
        text.to_owned(),
        Vec::new(),
        "2026-11-10T00:00:01Z".to_owned(),
        None,
    )
}

fn conversation() -> App {
    App {
        entries: vec![
            ConversationEntry::user(
                "hi".to_owned(),
                Vec::new(),
                "2026-11-10T00:00:00Z".to_owned(),
            ),
            ConversationEntry::Turn(reply("hello")),
        ],
        character_name: "ada".to_owned(),
        ..App::default()
    }
}

fn last_turn(app: &mut App) -> &mut Turn {
    match app.entries.last_mut() {
        Some(ConversationEntry::Turn(turn)) => turn,
        Some(ConversationEntry::System { .. }) | None => panic!("the conversation ends in a turn"),
    }
}

fn system(content: &str, count: u32) -> ConversationEntry {
    ConversationEntry::System {
        msg_id: None,
        content: content.to_owned(),
        count,
        timestamp: "2026-11-10T00:00:02Z".to_owned(),
    }
}

fn compacting() -> CompactionRun {
    CompactionRun {
        round: 1,
        tool_name: None,
        blocks: vec![Block::Text("summary".to_owned())],
        text: "abc".to_owned(),
        thinking: "def".to_owned(),
        started_at: None,
    }
}

type Change = (&'static str, fn(&mut App));

const SHOWN: &[Change] = &[
    ("another entry", |app| app.entries.push(system("note", 1))),
    ("the last turn's role", |app| {
        last_turn(app).role = Role::User
    }),
    ("the last turn streaming", |app| {
        last_turn(app).state = TurnState::Streaming
    }),
    ("the last turn's metadata", |app| {
        last_turn(app).metadata = Some(metadata())
    }),
    ("an image on the last turn", |app| {
        last_turn(app).images.push(image("a.png"))
    }),
    ("another block", |app| {
        last_turn(app).blocks.push(Block::Thinking("x".to_owned()))
    }),
    ("the last block growing", |app| {
        if let Some(Block::Text(text)) = last_turn(app).blocks.last_mut() {
            text.push('!');
        }
    }),
    ("a tool call's name", |app| {
        last_turn(app).blocks.push(Block::ToolUse {
            tool_id: "t".to_owned(),
            tool_name: "read".to_owned(),
            input: serde_json::Value::Null,
        });
    }),
    ("a tool result's output", |app| {
        last_turn(app).blocks.push(Block::ToolResult {
            tool_name: "read".to_owned(),
            output: "contents".to_owned(),
            images: Vec::new(),
            is_error: false,
        });
    }),
    ("a sub-agent starting", |app| {
        last_turn(app)
            .blocks
            .push(Block::SubagentBegin("memory".to_owned()));
    }),
    ("the turn before the last", |app| {
        let _first = app.entries.remove(0);
        app.entries
            .insert(0, ConversationEntry::Turn(reply("earlier")));
    }),
    ("the history version", |app| app.history_version = 1),
    ("a stream starting", |app| app.stream.active = true),
    ("a regeneration", |app| app.stream.regen = true),
    ("the stream's phase", |app| {
        app.stream.phase = "thinking".to_owned()
    }),
    ("a tool running", |app| {
        app.stream.tool_name = Some("x".to_owned())
    }),
    ("thinking shown", |app| {
        app.show_thinking = !app.show_thinking
    }),
    ("tools shown", |app| app.show_tools = !app.show_tools),
    ("sub-agents shown", |app| {
        app.show_subagent = !app.show_subagent
    }),
    ("compaction shown", |app| {
        app.show_compaction = !app.show_compaction
    }),
    ("images shown", |app| app.show_images = !app.show_images),
    ("timestamps shown", |app| {
        app.show_timestamps = !app.show_timestamps
    }),
    ("metadata shown", |app| {
        app.show_metadata = !app.show_metadata
    }),
    ("the spinner turning", |app| app.spinner_frame = 1),
    ("the character's name", |app| {
        app.character_name = "adele".to_owned()
    }),
    ("a compaction starting", |app| {
        app.compaction = Some(compacting())
    }),
];

const COMPACTION: &[Change] = &[
    ("its round", |app| {
        if let Some(run) = app.compaction.as_mut() {
            run.round = 2;
        }
    }),
    ("its blocks", |app| {
        if let Some(run) = app.compaction.as_mut() {
            run.blocks.push(Block::Text("more".to_owned()));
        }
    }),
    ("its last block", |app| {
        if let Some(Block::Text(text)) = app
            .compaction
            .as_mut()
            .and_then(|run| run.blocks.last_mut())
        {
            text.push('!');
        }
    }),
    ("its tool", |app| {
        if let Some(run) = app.compaction.as_mut() {
            run.tool_name = Some("x".to_owned());
        }
    }),
    ("its text", |app| {
        if let Some(run) = app.compaction.as_mut() {
            run.text.push('g');
        }
    }),
    ("its thinking", |app| {
        if let Some(run) = app.compaction.as_mut() {
            run.thinking.push('g');
        }
    }),
    ("its clock", |app| {
        if let Some(run) = app.compaction.as_mut() {
            run.started_at = Instant::now().checked_sub(Duration::from_secs(5));
        }
    }),
];

#[test]
fn anything_the_conversation_shows_changes_its_render_key() {
    let unchanged = conversation().conversation_fingerprint(WIDTH);
    assert_eq!(conversation().conversation_fingerprint(WIDTH), unchanged);
    assert_ne!(
        conversation().conversation_fingerprint(WIDTH + 1),
        unchanged
    );
    for (what, change) in SHOWN {
        let mut app = conversation();
        change(&mut app);
        assert_ne!(app.conversation_fingerprint(WIDTH), unchanged, "{what}");
    }
}

#[test]
fn anything_a_compaction_shows_changes_the_render_key() {
    let mut running = conversation();
    running.compaction = Some(compacting());
    let unchanged = running.conversation_fingerprint(WIDTH);
    for (what, change) in COMPACTION {
        let mut app = conversation();
        app.compaction = Some(compacting());
        change(&mut app);
        assert_ne!(app.conversation_fingerprint(WIDTH), unchanged, "{what}");
    }
}

#[test]
fn notes_in_the_conversation_change_the_key_by_their_text_and_their_count() {
    let with_note = |content: &str, count: u32| {
        let mut app = conversation();
        app.entries.push(system(content, count));
        app.conversation_fingerprint(WIDTH)
    };
    let unchanged = with_note("note", 1);
    assert_ne!(with_note("notes", 1), unchanged);
    assert_ne!(with_note("note", 2), unchanged);
    assert_eq!(
        with_note("wxyz", 1),
        unchanged,
        "only a note's length is kept"
    );
}

#[test]
fn the_settled_render_key_ignores_only_what_the_live_tail_shows() {
    let unchanged = conversation().conversation_fingerprint(WIDTH).settled();
    let live: &[&str] = &[
        "another entry",
        "the last turn streaming",
        "the last block growing",
        "the turn before the last",
        "a stream starting",
        "a regeneration",
        "the stream's phase",
        "a tool running",
        "the spinner turning",
        "a compaction starting",
    ];
    for (what, change) in SHOWN {
        let mut app = conversation();
        change(&mut app);
        let settled = app.conversation_fingerprint(WIDTH).settled();
        let redraws_history = what.ends_with("shown")
            || *what == "the history version"
            || *what == "the character's name";
        if live.contains(what) {
            assert_eq!(settled, unchanged, "{what} is only in the live tail");
        } else {
            assert_eq!(
                settled != unchanged,
                redraws_history,
                "{what} redraws settled history: {redraws_history}"
            );
        }
    }
    assert_ne!(
        conversation().conversation_fingerprint(WIDTH + 1).settled(),
        unchanged
    );
}
