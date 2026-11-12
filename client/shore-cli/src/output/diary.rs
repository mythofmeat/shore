use std::io::Write;

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::commands::counted;
use super::vocab::Tone;
use super::{
    format_time, parse_timestamp, print_dim_line, term_width, write_fg, write_section_header,
};

const GUTTER: usize = 2;
const BODY_INDENT: usize = 4;
const TIME_COLUMN: usize = 16;
const PIECE_GAP: usize = 2;

pub(crate) fn print_diary(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_diary(&mut out, data, term_width());
}

pub(crate) fn write_diary<W: Write>(out: &mut W, data: &serde_json::Value, width: usize) {
    let character = data["character"].as_str().unwrap_or("?");
    let notes: &[serde_json::Value] = data["notes"].as_array().map_or(&[], Vec::as_slice);
    if notes.is_empty() {
        write_section_header(out, "diary", character, width);
        print_dim_line(out, "(no notes in the diary)");
        return;
    }
    let listed = u64::try_from(notes.len()).unwrap_or(u64::MAX);
    let kept = data["kept"].as_u64().unwrap_or(listed);
    let summary = if listed < kept {
        format!("{character}, newest {listed} of {}", counted(kept, "note"))
    } else {
        format!("{character}, {}", counted(listed, "note"))
    };
    write_section_header(out, "diary", &summary, width);

    let mut previous_date = String::new();
    for note in notes {
        _ = writeln!(out);
        write_note(out, note, character, &mut previous_date, width);
    }
}

fn write_note<W: Write>(
    out: &mut W,
    note: &serde_json::Value,
    character: &str,
    previous_date: &mut String,
    width: usize,
) {
    let at = note["at"].as_str().unwrap_or("?");
    let time = parse_timestamp(at).map_or_else(
        || at.to_owned(),
        |local| {
            let formatted = format_time(&local, Some(previous_date.as_str()));
            *previous_date = local.format("%Y-%m-%d").to_string();
            formatted
        },
    );
    write_fg(
        out,
        Tone::Muted,
        &format!("{:GUTTER$}{time:<TIME_COLUMN$}", ""),
    );
    let mut heading = vec![(Tone::Active, origin(note))];
    if note["shown"].as_bool() == Some(false) {
        heading.push((
            Tone::Muted,
            format!("\u{00b7} no longer shown to {character}"),
        ));
    }
    if note["dreamed"].as_bool() == Some(true) {
        heading.push((Tone::Muted, "\u{00b7} dreamed".to_owned()));
    }
    let hanging = GUTTER.saturating_add(TIME_COLUMN);
    let beside_time = width.saturating_sub(hanging);
    let mut used = 0_usize;
    for (tone, piece) in heading {
        let wide = UnicodeWidthStr::width(piece.as_str());
        if used > 0 && used.saturating_add(PIECE_GAP).saturating_add(wide) <= beside_time {
            write_fg(out, tone, &format!("{:PIECE_GAP$}{piece}", ""));
            used = used.saturating_add(PIECE_GAP).saturating_add(wide);
            continue;
        }
        for row in wrapped(&piece, beside_time) {
            if used > 0 {
                _ = write!(out, "\n{:hanging$}", "");
            }
            used = UnicodeWidthStr::width(row.as_str());
            write_fg(out, tone, &row);
        }
    }
    _ = writeln!(out);

    let room = width.saturating_sub(BODY_INDENT);
    for line in note["text"].as_str().unwrap_or("").lines() {
        for row in wrapped(line, room) {
            let indented = format!("{:BODY_INDENT$}{row}", "");
            _ = writeln!(out, "{}", indented.trim_end());
        }
    }
}

fn origin(note: &serde_json::Value) -> String {
    let thread = note["thread"].as_str().unwrap_or("?");
    match note["source"].as_str().unwrap_or("?") {
        "trigger" => format!("trigger \"{}\"", note["trigger"].as_str().unwrap_or("?")),
        "note" => format!("note in \"{thread}\""),
        "wake" => format!("wake in \"{thread}\""),
        "shore" => "Shore".to_owned(),
        other => other.to_owned(),
    }
}

fn wrapped(line: &str, room: usize) -> Vec<String> {
    let indent: String = line.chars().take_while(|ch| *ch == ' ').collect();
    let inner = room.saturating_sub(indent.len()).max(1);
    let mut rows = Vec::new();
    let mut row = String::new();
    let mut used = 0_usize;
    for word in line.split_whitespace() {
        if !row.is_empty() {
            if used
                .saturating_add(1)
                .saturating_add(UnicodeWidthStr::width(word))
                > inner
            {
                rows.push(std::mem::take(&mut row));
                used = 0;
            } else {
                row.push(' ');
                used = used.saturating_add(1);
            }
        }
        for ch in word.chars() {
            let cell = UnicodeWidthChar::width(ch).unwrap_or(0);
            if !row.is_empty() && used.saturating_add(cell) > inner {
                rows.push(std::mem::take(&mut row));
                used = 0;
            }
            row.push(ch);
            used = used.saturating_add(cell);
        }
    }
    rows.push(row);
    rows.into_iter()
        .map(|each| format!("{indent}{each}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{wrapped, write_diary};
    use crate::output::set_color_enabled;

    fn written(data: &Value, width: usize) -> String {
        set_color_enabled(false);
        let mut out = Vec::new();
        write_diary(&mut out, data, width);
        String::from_utf8(out).unwrap_or_default()
    }

    fn note(at: &str, source: &str, thread: &str, text: &str) -> Value {
        json!({ "at": at, "thread": thread, "source": source, "text": text, "shown": true, "dreamed": false })
    }

    #[test]
    fn an_empty_diary_says_so() {
        assert_eq!(
            written(&json!({ "character": "ada", "notes": [], "kept": 0 }), 20),
            "\u{2500}\u{2500} diary (ada) \u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n  (no notes in the diary)\n"
        );
    }

    #[test]
    fn each_note_says_where_it_came_from_and_keeps_its_own_lines() {
        let trigger = json!({ "at": "dusk", "thread": "heartbeat", "source": "trigger", "trigger": "mail check", "text": "Two letters.", "shown": true, "dreamed": false });
        let data = json!({ "character": "ada", "kept": 6, "notes": [
            note("dawn", "heartbeat", "heartbeat", "The lamp is lit."),
            note("noon", "note", "main", "Ferry times.\n\n- Friday\n  - back by ten"),
            note("three", "wake", "ring", "Told part one."),
            trigger,
            note("night", "shore", "ring", "The seal came off."),
            note("late", "a newer kind", "main", "Something new."),
        ] });
        assert_eq!(
            written(&data, 40),
            [
                "\u{2500}\u{2500} diary (ada, 6 notes) \u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}",
                "",
                "  dawn            heartbeat",
                "    The lamp is lit.",
                "",
                "  noon            note in \"main\"",
                "    Ferry times.",
                "",
                "    - Friday",
                "      - back by ten",
                "",
                "  three           wake in \"ring\"",
                "    Told part one.",
                "",
                "  dusk            trigger \"mail check\"",
                "    Two letters.",
                "",
                "  night           Shore",
                "    The seal came off.",
                "",
                "  late            a newer kind",
                "    Something new.",
                "",
            ]
            .join("\n")
        );
    }

    #[test]
    fn the_heading_counts_the_notes_and_says_when_older_ones_were_left_out() {
        let one = json!({ "character": "ada", "kept": 1, "notes": [note("dawn", "heartbeat", "heartbeat", "a")] });
        assert!(
            written(&one, 40).starts_with("\u{2500}\u{2500} diary (ada, 1 note) \u{2500}"),
            "{}",
            written(&one, 40)
        );
        let two = [
            note("dawn", "heartbeat", "heartbeat", "a"),
            note("noon", "heartbeat", "heartbeat", "b"),
        ];
        let some = json!({ "character": "ada", "kept": 5, "notes": two });
        assert!(
            written(&some, 60)
                .starts_with("\u{2500}\u{2500} diary (ada, newest 2 of 5 notes) \u{2500}"),
            "{}",
            written(&some, 60)
        );
        let fewer_kept = json!({ "character": "ada", "kept": 1, "notes": two });
        assert!(
            written(&fewer_kept, 60).starts_with("\u{2500}\u{2500} diary (ada, 2 notes) \u{2500}"),
            "{}",
            written(&fewer_kept, 60)
        );
    }

    fn aged(shown: bool, dreamed: bool, thread: &str, width: usize) -> String {
        let old = json!({ "at": "dawn", "thread": thread, "source": "wake", "text": "a", "shown": shown, "dreamed": dreamed });
        let all = written(
            &json!({ "character": "ada", "kept": 1, "notes": [old] }),
            width,
        );
        all.lines()
            .skip(2)
            .take_while(|line| *line != "    a")
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_note_the_character_no_longer_sees_or_has_dreamed_about_is_marked() {
        assert_eq!(
            aged(false, true, "ring", 69),
            "  dawn            wake in \"ring\"  \u{00b7} no longer shown to ada  \u{00b7} dreamed"
        );
        assert_eq!(
            aged(false, false, "ring", 69),
            "  dawn            wake in \"ring\"  \u{00b7} no longer shown to ada"
        );
        assert_eq!(
            aged(true, true, "ring", 69),
            "  dawn            wake in \"ring\"  \u{00b7} dreamed"
        );
        assert_eq!(
            aged(true, false, "ring", 69),
            "  dawn            wake in \"ring\""
        );
    }

    #[test]
    fn a_heading_too_long_for_the_line_carries_on_under_itself() {
        assert_eq!(
            aged(false, true, "ring", 68),
            [
                "  dawn            wake in \"ring\"  \u{00b7} no longer shown to ada",
                "                  \u{00b7} dreamed",
            ]
            .join("\n")
        );
        assert_eq!(
            aged(false, true, "a-thread-with-a-long-name", 40),
            [
                "  dawn            wake in",
                "                  \"a-thread-with-a-long-",
                "                  name\"",
                "                  \u{00b7} no longer shown to",
                "                  ada  \u{00b7} dreamed",
            ]
            .join("\n")
        );
    }

    #[test]
    fn a_long_line_wraps_at_the_width_of_what_is_drawn() {
        let wide = "\u{706f}\u{53f0}\u{306e}\u{8a18}\u{9332}\u{3092}\u{4e09}\u{6708}\u{307e}\u{3067}\u{8aad}\u{3093}\u{3060}";
        let text = format!(
            "one two three four five six seven\n{wide}\n{}",
            "x".repeat(20)
        );
        let data = json!({ "character": "ada", "kept": 1, "notes": [note("dawn", "heartbeat", "heartbeat", &text)] });
        let body: Vec<String> = written(&data, 20)
            .lines()
            .skip_while(|line| !line.starts_with("    one"))
            .map(str::to_owned)
            .collect();
        assert_eq!(
            body,
            [
                "    one two three",
                "    four five six",
                "    seven",
                "    \u{706f}\u{53f0}\u{306e}\u{8a18}\u{9332}\u{3092}\u{4e09}\u{6708}",
                "    \u{307e}\u{3067}\u{8aad}\u{3093}\u{3060}",
                "    xxxxxxxxxxxxxxxx",
                "    xxxx",
            ]
        );
    }

    #[test]
    fn wrapping_fills_a_row_exactly_before_starting_the_next() {
        assert_eq!(wrapped("aaaa bbbb", 9), ["aaaa bbbb"]);
        assert_eq!(wrapped("aaaa bbbb", 8), ["aaaa", "bbbb"]);
        assert_eq!(wrapped("aaaa   bbbb", 9), ["aaaa bbbb"]);
        assert_eq!(wrapped("abcdef", 6), ["abcdef"]);
        assert_eq!(wrapped("abcdefg", 6), ["abcdef", "g"]);
        assert_eq!(wrapped("ab abcdefgh", 6), ["ab", "abcdef", "gh"]);
        assert_eq!(wrapped("", 6), [""]);
    }

    #[test]
    fn a_wrapped_line_keeps_the_indent_it_started_with() {
        assert_eq!(wrapped("  - back by ten", 9), ["  - back", "  by ten"]);
        assert_eq!(wrapped("    ab", 2), ["    a", "    b"]);
    }
}
