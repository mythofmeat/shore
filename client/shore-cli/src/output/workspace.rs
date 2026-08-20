use std::io::Write;

use super::autonomy::format_local_timestamp;
use super::vocab::{Tone, empty, section, warning, write_row, write_row_colored};

pub(crate) fn write_compact_index_section(
    out: &mut impl Write,
    workspace_value: Option<&serde_json::Value>,
    history_value: Option<&serde_json::Value>,
) {
    section(out, "index", None);

    let workspace = workspace_value.filter(|value| !value.is_null());
    let history = history_value.filter(|value| !value.is_null());
    if workspace.is_none() && history.is_none() {
        empty(out, "no indexes configured for this character");
        return;
    }

    if let Some(error) = workspace.and_then(|value| value["error"].as_str()) {
        warning(
            out,
            &format!("the workspace index could not be read: {error}"),
        );
    }
    if let Some(error) = history.and_then(|value| value["error"].as_str()) {
        warning(
            out,
            &format!("the history index could not be read: {error}"),
        );
    }
    if let Some(reason) = workspace.and_then(|value| value["unusable"].as_str()) {
        warning(out, &format!("index unavailable — {reason}"));
    }

    let usable_workspace =
        workspace.filter(|value| value["error"].is_null() && value["unusable"].is_null());
    let usable_history = history.filter(|value| value["error"].is_null());
    if usable_workspace.is_none() && usable_history.is_none() {
        return;
    }

    let files = usable_workspace.map_or(0, |value| value["embedded"].as_u64().unwrap_or(0));
    let messages = usable_history.map_or(0, |value| value["messages"].as_u64().unwrap_or(0));
    if files == 0 && messages == 0 {
        empty(out, "nothing indexed yet");
    } else {
        let mut parts = Vec::new();
        if usable_workspace.is_some() {
            parts.push(format!("{files} files"));
        }
        if usable_history.is_some() {
            parts.push(format!("{messages} messages"));
        }
        write_row(out, "embedded", &parts.join(" \u{00b7} "));
    }

    let file_pending = usable_workspace.map_or(0, |value| value["pending"].as_u64().unwrap_or(0));
    let history_pending = usable_history.map_or(0, |value| value["pending"].as_u64().unwrap_or(0));
    let pending = file_pending.saturating_add(history_pending);
    let problem = index_problem(usable_workspace, usable_history);

    if let Some(index) = usable_workspace {
        write_row(
            out,
            "size",
            &human_bytes(index["bytes"].as_u64().unwrap_or(0)),
        );
        let stamp = index["last_indexed_at"]
            .as_str()
            .map_or_else(|| "never".to_owned(), format_local_timestamp);
        let state = if pending == 0 && problem.is_none() {
            "up to date"
        } else if problem.is_some() {
            "attention needed"
        } else {
            "indexing"
        };
        write_row(out, "last indexed", &format!("{stamp} ({state})"));
    }

    if pending > 0 {
        let mut parts = Vec::new();
        if file_pending > 0 {
            parts.push(format!("{file_pending} files"));
        }
        if history_pending > 0 {
            parts.push(format!("{history_pending} history chunks"));
        }
        write_row_colored(out, "pending", &parts.join(" \u{00b7} "), Tone::Active);
    }
    if let Some((label, detail)) = problem {
        write_row_colored(out, "background", label, Tone::Bad);
        write_row(out, "last error", detail);
    }
}

fn index_problem<'value>(
    workspace: Option<&'value serde_json::Value>,
    history: Option<&'value serde_json::Value>,
) -> Option<(&'static str, &'value str)> {
    for value in [workspace, history].into_iter().flatten() {
        let background = &value["background"];
        if let Some(reason) = background["embedder_error"].as_str() {
            return Some(("cannot run", reason));
        }
        if let Some(error) = background["last_error"].as_str() {
            return Some(("failing", error));
        }
    }
    None
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [(u64, &str); 3] = [(1_073_741_824, "GB"), (1_048_576, "MB"), (1_024, "KB")];
    for (scale, name) in UNITS {
        if bytes < scale {
            continue;
        }
        let whole = bytes.checked_div(scale).unwrap_or(0);
        let remainder = bytes.checked_rem(scale).unwrap_or(0);
        let tenths = remainder
            .saturating_mul(10)
            .saturating_add(scale.checked_div(2).unwrap_or(0))
            .checked_div(scale)
            .unwrap_or(0);
        return if tenths >= 10 {
            format!("{}.0 {name}", whole.saturating_add(1))
        } else {
            format!("{whole}.{tenths} {name}")
        };
    }
    format!("{bytes} B")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(workspace: &serde_json::Value, history: &serde_json::Value) -> String {
        let mut buf = Vec::new();
        write_compact_index_section(&mut buf, Some(workspace), Some(history));
        String::from_utf8(buf).expect("utf8")
    }

    #[test]
    fn workspace_and_history_are_one_summary() {
        let out = render(
            &serde_json::json!({
                "embedded": 1702, "pending": 0, "bytes": 29_779_558,
                "last_indexed_at": "2026-08-20T07:11:00+00:00",
                "background": {"registered": true, "failures": 0}
            }),
            &serde_json::json!({
                "messages": 36_684, "pending": 0,
                "background": {"registered": true, "failures": 0}
            }),
        );
        assert!(out.contains("1702 files \u{00b7} 36684 messages"), "{out}");
        assert!(out.contains("28.4 MB"), "{out}");
        assert!(out.contains("up to date"), "{out}");
        for redundant in ["files seen", "vectors", "skipped", "chunks"] {
            assert!(!out.contains(redundant), "unexpected {redundant:?}: {out}");
        }
    }

    #[test]
    fn pending_work_is_visible_without_configuration_noise() {
        let out = render(
            &serde_json::json!({
                "embedded": 4, "pending": 6, "bytes": 1024, "last_indexed_at": null,
                "background": {"registered": true, "failures": 0}
            }),
            &serde_json::json!({
                "messages": 12, "pending": 3,
                "background": {"registered": true, "failures": 0}
            }),
        );
        assert!(out.contains("6 files \u{00b7} 3 history chunks"), "{out}");
        assert!(out.contains("indexing"), "{out}");
        assert!(
            !out.contains("background"),
            "healthy configuration is not status: {out}"
        );
    }

    #[test]
    fn a_stalled_backlog_keeps_the_actionable_error() {
        let out = render(
            &serde_json::json!({
                "embedded": 4, "pending": 6, "bytes": 1024, "last_indexed_at": null,
                "background": {"registered": true, "last_error": "429 rate limited"}
            }),
            &serde_json::json!({"messages": 12, "pending": 0, "background": {}}),
        );
        assert!(out.contains("attention needed"), "{out}");
        assert!(out.contains("failing"), "{out}");
        assert!(out.contains("429 rate limited"), "{out}");
        assert!(!out.contains("up to date"), "{out}");
    }

    #[test]
    fn unreadable_indexes_report_the_problem_without_fake_zeroes() {
        let out = render(
            &serde_json::json!({"error": "database disk image is malformed"}),
            &serde_json::json!({"error": "history lock failed"}),
        );
        assert!(out.contains("database disk image is malformed"), "{out}");
        assert!(out.contains("history lock failed"), "{out}");
        assert!(!out.contains("nothing indexed yet"), "{out}");
        assert!(!out.contains("up to date"), "{out}");
    }

    #[test]
    fn bytes_read_as_units_a_person_can_scan() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(40960), "40.0 KB");
        assert_eq!(human_bytes(29_102_080), "27.8 MB");
        assert_eq!(human_bytes(208_936_506), "199.3 MB");
    }
}
