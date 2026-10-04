use std::io::Write;

use serde_json::Value;

use super::autonomy::{format_duration_compact, format_local_timestamp};
use super::vocab::{Rows, Tone, empty, section};

fn text<'value>(data: &'value Value, key: &str) -> &'value str {
    data.get(key).and_then(Value::as_str).unwrap_or("")
}

fn work(running: &Value) -> &[Value] {
    running
        .get("work")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn shutdown(running: &Value) -> Option<&Value> {
    running.get("shutdown").filter(|value| !value.is_null())
}

fn elapsed(item: &Value) -> String {
    let secs = item
        .get("running_secs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    format_duration_compact(secs)
}

fn item_line(item: &Value) -> String {
    format!(
        "{} for {} \u{00b7} {}",
        text(item, "kind"),
        text(item, "character"),
        elapsed(item)
    )
}

fn stopping_line(window: &Value) -> String {
    format!(
        "stopping once this finishes, by {} at the latest",
        format_local_timestamp(text(window, "deadline"))
    )
}

pub(crate) fn status_row(running: &Value) -> (String, Tone) {
    let items = work(running);
    let busy = items.iter().map(item_line).collect::<Vec<_>>().join(", ");
    match (shutdown(running), items.is_empty()) {
        (Some(_), true) => ("nothing \u{00b7} stopping".to_owned(), Tone::Warn),
        (Some(window), false) => (
            format!("{busy} \u{00b7} {}", stopping_line(window)),
            Tone::Warn,
        ),
        (None, true) => ("nothing \u{00b7} safe to restart".to_owned(), Tone::Good),
        (None, false) => (busy, Tone::Active),
    }
}

pub(crate) fn write_status_section<W: Write>(out: &mut W, running: &Value) {
    section(out, "running", None);
    let items = work(running);
    let stopping = shutdown(running);
    if items.is_empty() && stopping.is_none() {
        empty(out, "nothing running; safe to restart");
        return;
    }
    let mut rows = Rows::new();
    for item in items {
        let mut line = format!("{} \u{00b7} {}", text(item, "character"), elapsed(item));
        let thread = text(item, "thread");
        if !thread.is_empty() {
            line.push_str(&format!(" \u{00b7} thread {thread}"));
        }
        line.push_str(&format!(
            " \u{00b7} since {}",
            format_local_timestamp(text(item, "started_at"))
        ));
        rows.add_toned(text(item, "kind"), &line, Tone::Active);
    }
    if let Some(window) = stopping {
        rows.add_toned("shutdown", &stopping_line(window), Tone::Warn);
    }
    rows.write(out);
}
