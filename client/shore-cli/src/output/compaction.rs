use std::io::Write;

use chrono::{DateTime, Local};
use serde_json::Value;

use super::autonomy::{format_duration_compact, format_local_timestamp};
use super::commands::{pause_reason_text, write_compact_result};
use super::parse_timestamp;
use super::vocab::{Rows, Tone, empty, section, write_row, write_section_header};

fn text<'value>(data: &'value Value, key: &str) -> Option<&'value str> {
    data.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn present<'value>(data: &'value Value, key: &str) -> Option<&'value Value> {
    data.get(key).filter(|value| !value.is_null())
}

fn trigger_label(trigger: &str) -> &str {
    match trigger {
        "manual" => "started by hand",
        "idle" => "idle timer",
        "turn" => "chat turn",
        "deep_archive" => "deep archive",
        other => other,
    }
}

fn since(at: &str, now: DateTime<Local>) -> String {
    parse_timestamp(at).map_or_else(
        || at.to_owned(),
        |then| format_duration_compact(now.signed_duration_since(then).num_seconds().max(0)),
    )
}

fn report_summary(report: &Value) -> String {
    let turns = report["compacted_turns"].as_u64().unwrap_or(0);
    match report["status"].as_str().unwrap_or("?") {
        "compacted" => format!("compacted {turns} turns"),
        "rotated" => format!("archived {turns} turns without writing memory"),
        "truncated" => "cut off at the token ceiling".to_owned(),
        "paused" => format!("paused: {}", pause_reason_text(report)),
        "dry_run" => "dry run".to_owned(),
        other => other.to_owned(),
    }
}

fn pass_summary(pass: &Value) -> (String, Tone) {
    if let Some(error) = text(pass, "error") {
        return (format!("failed: {error}"), Tone::Bad);
    }
    match present(pass, "report") {
        Some(report) => (
            report_summary(report),
            match report["status"].as_str() {
                Some("compacted" | "rotated" | "dry_run") => Tone::Plain,
                _ => Tone::Warn,
            },
        ),
        None => ("nothing to compact".to_owned(), Tone::Plain),
    }
}

fn running_line(running: &Value, now: DateTime<Local>) -> String {
    let mut parts = vec![
        format!(
            "running {}",
            since(text(running, "started_at").unwrap_or(""), now)
        ),
        trigger_label(text(running, "trigger").unwrap_or("?")).to_owned(),
    ];
    if let Some(phase) = text(running, "phase") {
        parts.push(phase.to_owned());
    }
    if let Some(tool) = text(running, "last_tool") {
        parts.push(format!("last tool {tool}"));
    }
    parts.join(" \u{00b7} ")
}

fn paused_line(paused: &Value) -> String {
    let mut parts = vec![format!("paused: {}", pause_reason_text(paused))];
    if let Some(resume) = text(paused, "resume_at") {
        parts.push(format!("retry after {}", format_local_timestamp(resume)));
    }
    let rounds = paused["tool_rounds"].as_u64().unwrap_or(0);
    parts.push(format!(
        "{rounds} round{} kept",
        if rounds == 1 { "" } else { "s" }
    ));
    parts.join(" \u{00b7} ")
}

pub(crate) fn status_row(compaction: &Value, now: DateTime<Local>) -> Option<(String, Tone)> {
    if let Some(running) = present(compaction, "running") {
        return Some((running_line(running, now), Tone::Active));
    }
    if let Some(paused) = present(compaction, "paused") {
        return Some((paused_line(paused), Tone::Warn));
    }
    let last = present(compaction, "last")?;
    let (summary, tone) = pass_summary(last);
    let ended = text(last, "ended_at").unwrap_or("");
    Some((
        format!("last pass {summary} \u{00b7} {} ago", since(ended, now)),
        tone,
    ))
}

pub(crate) fn write_status_section<W: Write>(
    out: &mut W,
    compaction: &Value,
    now: DateTime<Local>,
) {
    section(out, "compaction", None);
    let live = present(compaction, "running");
    let held = present(compaction, "paused");
    let ended = present(compaction, "last");
    if live.is_none() && held.is_none() && ended.is_none() {
        empty(out, "no compaction since the daemon started");
        return;
    }
    let mut rows = Rows::new();
    if let Some(running) = live {
        rows.add_toned("running", &running_line(running, now), Tone::Active);
        rows.add("thread", text(running, "thread").unwrap_or("?"));
    }
    if let Some(paused) = held {
        rows.add_toned("paused", &pause_reason_text(paused), Tone::Warn);
        if let Some(resume) = text(paused, "resume_at") {
            rows.add("retry after", &format_local_timestamp(resume));
        }
        rows.add(
            "rounds kept",
            &paused["tool_rounds"].as_u64().unwrap_or(0).to_string(),
        );
        rows.add(
            "turns planned",
            &paused["compacted_turns"].as_u64().unwrap_or(0).to_string(),
        );
        rows.add("checkpoint", text(paused, "checkpoint_id").unwrap_or("?"));
    }
    if let Some(last) = ended {
        let (summary, tone) = pass_summary(last);
        rows.add_toned("last pass", &summary, tone);
        rows.add(
            "ended",
            &format!(
                "{} ({})",
                format_local_timestamp(text(last, "ended_at").unwrap_or("")),
                trigger_label(text(last, "trigger").unwrap_or("?")),
            ),
        );
    }
    rows.write(out);
}

pub(crate) fn write_watch_result<W: Write>(out: &mut W, data: &Value, width: usize) {
    let state = data["state"].as_str().unwrap_or("?");
    let Some(pass) = present(data, "pass") else {
        write_section_header(out, "Compaction", "not running", width);
        write_row(out, "Character", data["character"].as_str().unwrap_or("?"));
        write_row(out, "Last pass", "none since the daemon started");
        return;
    };
    if state == "idle" {
        write_section_header(out, "Compaction", "not running", width);
        write_row(out, "Character", data["character"].as_str().unwrap_or("?"));
        write_row(
            out,
            "Last pass",
            &format!(
                "{}, ended {}",
                trigger_label(text(pass, "trigger").unwrap_or("?")),
                format_local_timestamp(text(pass, "ended_at").unwrap_or("")),
            ),
        );
    }
    if let Some(report) = present(pass, "report") {
        write_compact_result(out, report, width);
        return;
    }
    let (summary, _) = pass_summary(pass);
    if state != "idle" {
        write_section_header(out, "Compaction", "", width);
        write_row(out, "Character", data["character"].as_str().unwrap_or("?"));
    }
    write_row(out, "Outcome", &summary);
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 3, 12, 0, 0).unwrap()
    }

    fn at(minutes_before: i64) -> String {
        now()
            .checked_sub_signed(chrono::Duration::minutes(minutes_before))
            .unwrap()
            .to_rfc3339()
    }

    fn rendered(write: impl FnOnce(&mut Vec<u8>)) -> String {
        crate::output::set_color_enabled(false);
        let mut buf = Vec::new();
        write(&mut buf);
        String::from_utf8(buf).unwrap()
    }

    #[test]
    fn a_running_pass_says_how_long_what_started_it_and_what_it_is_doing() {
        let compaction = serde_json::json!({
            "running": { "thread": "main", "trigger": "idle", "started_at": at(4), "phase": "compacting round 6", "last_tool": "edit" },
            "paused": null, "last": null,
        });
        let (line, tone) = status_row(&compaction, now()).unwrap();
        assert_eq!(
            line,
            "running 4m \u{00b7} idle timer \u{00b7} compacting round 6 \u{00b7} last tool edit"
        );
        assert_eq!(tone, Tone::Active);
    }

    #[test]
    fn a_paused_pass_names_its_limit_its_retry_time_and_the_rounds_it_keeps() {
        let compaction = serde_json::json!({
            "running": null,
            "paused": {
                "thread": "main", "checkpoint_id": "c1", "reason": "budget",
                "detail": "Claude 5-hour limit is at 100%", "resume_at": at(-90),
                "tool_rounds": 8, "compacted_turns": 8, "updated_at": at(5),
            },
            "last": null,
        });
        let (line, tone) = status_row(&compaction, now()).unwrap();
        assert!(line.starts_with("paused: blocked by a usage limit (Claude 5-hour limit is at 100%) \u{00b7} retry after "), "{line}");
        assert!(line.ends_with("8 rounds kept"), "{line}");
        assert_eq!(tone, Tone::Warn);
    }

    #[test]
    fn a_failed_last_pass_is_shown_as_a_failure_with_its_error() {
        let compaction = serde_json::json!({
            "running": null, "paused": null,
            "last": { "thread": "main", "trigger": "manual", "started_at": at(12), "ended_at": at(10), "report": null, "error": "llm: provider down" },
        });
        let (line, tone) = status_row(&compaction, now()).unwrap();
        assert_eq!(
            line,
            "last pass failed: llm: provider down \u{00b7} 10m ago"
        );
        assert_eq!(tone, Tone::Bad);
        assert!(
            status_row(
                &serde_json::json!({ "running": null, "paused": null, "last": null }),
                now()
            )
            .is_none()
        );
    }

    #[test]
    fn watching_with_nothing_running_says_so_and_shows_the_last_pass() {
        let none = rendered(|out| {
            write_watch_result(
                out,
                &serde_json::json!({ "character": "ada", "state": "idle", "pass": null }),
                80,
            )
        });
        assert!(none.contains("not running"), "{none}");
        assert!(none.contains("none since the daemon started"), "{none}");

        let report = serde_json::json!({
            "status": "paused", "character": "ada", "checkpoint_id": "c1", "message_count": 4,
            "compacted_turns": 2, "tool_rounds": 1, "tools_called": ["bash"],
            "reason": "cancelled", "detail": "Compaction cancelled on request", "resume_at": null,
        });
        let pass = serde_json::json!({ "thread": "main", "trigger": "manual", "started_at": at(3), "ended_at": at(2), "report": report, "error": null });
        let idle = rendered(|out| {
            write_watch_result(
                out,
                &serde_json::json!({ "character": "ada", "state": "idle", "pass": pass }),
                80,
            )
        });
        assert!(idle.contains("not running"), "{idle}");
        assert!(idle.contains("started by hand, ended"), "{idle}");
        assert!(idle.contains("Compaction cancelled on request"), "{idle}");

        let cancelled = rendered(|out| {
            write_watch_result(
                out,
                &serde_json::json!({ "character": "ada", "state": "cancelled", "pass": pass }),
                80,
            )
        });
        assert!(!cancelled.contains("not running"), "{cancelled}");
        assert!(
            cancelled.contains("Compaction cancelled on request"),
            "{cancelled}"
        );
    }
}
