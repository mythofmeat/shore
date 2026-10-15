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
        "segment" => format!(
            "wrote memory from segment {}",
            report["segment"].as_u64().unwrap_or(0)
        ),
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
                Some("compacted" | "rotated" | "dry_run" | "segment") => Tone::Plain,
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
    if text(paused, "reason") == Some("refusal") {
        parts.push("on hold until `shore compact`".to_owned());
    }
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
        if text(paused, "reason") == Some("refusal") {
            rows.add_toned(
                "hold",
                "automatic compaction waits for `shore compact`",
                Tone::Warn,
            );
        }
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
