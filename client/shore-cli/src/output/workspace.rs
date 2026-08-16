use std::io::Write;

use super::autonomy::format_local_timestamp;
use super::vocab::{Tone, empty, note, section, warning, write_row, write_row_colored};

pub(crate) fn write_index_section(out: &mut impl Write, index: &serde_json::Value) {
    section(out, "index", None);

    if let Some(error) = index["error"].as_str() {
        warning(
            out,
            &format!("the workspace index could not be read: {error}"),
        );
        return;
    }

    if let Some(reason) = index["unusable"].as_str() {
        warning(out, &format!("index unavailable — {reason}"));
        if let Some(path) = index["path"].as_str() {
            write_row(out, "path", path);
        }
        note(
            out,
            "search still runs, but nothing it embeds survives a daemon restart",
        );
        return;
    }

    let files = index["files"].as_u64().unwrap_or(0);
    let embedded = index["embedded"].as_u64().unwrap_or(0);
    let pending = index["pending"].as_u64().unwrap_or(0);
    let skipped = index["skipped"].as_u64().unwrap_or(0);

    if files == 0 {
        empty(out, "nothing indexed yet");
    }

    write_row(out, "files seen", &files.to_string());
    write_row_colored(
        out,
        "embedded",
        &format!("{embedded} of {files}"),
        if pending == 0 {
            Tone::Good
        } else {
            Tone::Active
        },
    );
    if pending > 0 {
        write_row_colored(out, "pending", &pending.to_string(), Tone::Active);
    }
    if skipped > 0 {
        write_row(
            out,
            "skipped",
            &format!("{skipped} ({})", skip_reasons(index)),
        );
    }
    write_row(
        out,
        "vectors",
        &index["vectors"].as_u64().unwrap_or(0).to_string(),
    );
    if let Some(models) = index["models"].as_array().filter(|m| !m.is_empty()) {
        let names: Vec<&str> = models
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();
        write_row(out, "model", &names.join(", "));
    }
    write_row(
        out,
        "size",
        &human_bytes(index["bytes"].as_u64().unwrap_or(0)),
    );
    write_row(
        out,
        "last indexed",
        &index["last_indexed_at"]
            .as_str()
            .map_or_else(|| "never".to_owned(), format_local_timestamp),
    );

    write_background_pass(out, &index["background"], pending);
}

fn skip_reasons(data: &serde_json::Value) -> String {
    let Some(reasons) = data["skip_reasons"].as_object() else {
        return String::new();
    };
    let mut parts: Vec<String> = reasons
        .iter()
        .map(|(reason, n)| format!("{} {reason}", n.as_u64().unwrap_or(0)))
        .collect();
    parts.sort();
    parts.join(", ")
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

fn write_background_pass(out: &mut impl Write, background: &serde_json::Value, pending: u64) {
    if background["registered"].as_bool() != Some(true) {
        note(
            out,
            "no background indexer registered — nothing will be embedded until one runs",
        );
        return;
    }

    if let Some(error) = background["last_error"].as_str() {
        write_row_colored(out, "background", "failing", Tone::Bad);
        write_row(out, "last error", error);
        write_row(
            out,
            "failures",
            &background["failures"].as_u64().unwrap_or(0).to_string(),
        );
        if let Some(secs) = background["retry_in_secs"].as_u64() {
            write_row(out, "retrying in", &format!("{secs}s"));
        }
        return;
    }

    if pending > 0 {
        write_row_colored(out, "background", "working", Tone::Active);
        note(
            out,
            "(it embeds a batch at a time once the daemon has been idle)",
        );
        return;
    }

    if background["swept"].as_bool() == Some(true) {
        write_row_colored(out, "background", "up to date", Tone::Good);
    } else {
        write_row_colored(out, "background", "not yet run", Tone::Thinking);
        note(out, "(it starts once the daemon has been idle for a while)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(data: &serde_json::Value) -> String {
        let mut buf = Vec::new();
        write_index_section(&mut buf, data);
        String::from_utf8(buf).expect("utf8")
    }

    #[test]
    #[ignore]
    fn render_preview_index_unusable() {
        crate::output::set_color_enabled(true);
        let mut buf = Vec::new();
        write_index_section(
            &mut buf,
            &serde_json::json!({
                "path": "/home/eshen/.cache/shore/characters/poppy/workspace_index.db",
                "unusable": "it already holds something that is not a SQLite database, and shore will not overwrite it",
                "files": 0, "embedded": 0, "pending": 0, "skipped": 0, "skip_reasons": {},
                "vectors": 0, "models": [], "bytes": 0, "last_indexed_at": null,
                "background": {"registered": true, "swept": true, "failures": 0},
            }),
        );
        write_index_section(
            &mut buf,
            &serde_json::json!({
                "files": 0, "embedded": 0, "pending": 0, "skipped": 0, "skip_reasons": {},
                "vectors": 0, "models": [], "bytes": 0, "last_indexed_at": null,
                "background": {"registered": true, "swept": true, "failures": 0},
            }),
        );
        crate::output::set_color_enabled(false);
        use std::io::Write as _;
        std::io::stdout().write_all(&buf).unwrap();
    }

    #[test]
    fn an_unusable_index_says_so_instead_of_reporting_zeroes() {
        let out = render(&serde_json::json!({
            "path": "/cache/idx.db",
            "unusable": "it already holds something that is not a SQLite database, and shore will not overwrite it",
            "files": 0, "embedded": 0, "pending": 0, "skipped": 0, "skip_reasons": {},
            "vectors": 0, "models": [], "bytes": 0, "last_indexed_at": null,
            "background": {"registered": true, "swept": true, "failures": 0},
        }));
        assert!(out.contains("index unavailable"));
        assert!(out.contains("not a SQLite database"));
        assert!(!out.contains("nothing indexed yet"));
        assert!(!out.contains("files seen"));
    }

    #[test]
    fn a_healthy_empty_index_still_says_nothing_indexed_yet() {
        let out = render(&serde_json::json!({
            "files": 0, "embedded": 0, "pending": 0, "skipped": 0, "skip_reasons": {},
            "vectors": 0, "models": [], "bytes": 0, "last_indexed_at": null,
            "background": {"registered": true, "swept": true, "failures": 0},
        }));
        assert!(out.contains("nothing indexed yet"));
        assert!(!out.contains("index unavailable"));
    }

    #[test]
    fn an_unregistered_indexer_says_nothing_will_be_embedded() {
        let out = render(&serde_json::json!({
            "files": 10, "embedded": 0, "pending": 10, "skip_reasons": {},
            "background": {"registered": false},
        }));
        assert!(out.contains("no background indexer registered"));
    }

    #[test]
    fn a_failing_indexer_shows_the_error_and_the_retry() {
        let out = render(&serde_json::json!({
            "files": 10, "embedded": 0, "pending": 10, "skip_reasons": {},
            "background": {"registered": true, "swept": true, "failures": 4,
                           "last_error": "429 rate limited", "retry_in_secs": 8},
        }));
        assert!(out.contains("failing"));
        assert!(out.contains("429 rate limited"));
        assert!(out.contains("8s"));
        assert!(!out.contains("up to date"));
    }

    #[test]
    fn outstanding_work_reads_as_working_not_up_to_date() {
        let out = render(&serde_json::json!({
            "files": 10, "embedded": 4, "pending": 6, "skip_reasons": {},
            "background": {"registered": true, "swept": true, "failures": 0},
        }));
        assert!(out.contains("pending"));
        assert!(out.contains("working"));
        assert!(!out.contains("up to date"));
    }

    #[test]
    fn a_drained_index_reads_as_up_to_date_with_no_pending_row() {
        let out = render(&serde_json::json!({
            "files": 10, "embedded": 10, "pending": 0, "skip_reasons": {},
            "background": {"registered": true, "swept": true, "failures": 0},
        }));
        assert!(out.contains("up to date"));
        assert!(!out.contains("pending"));
    }

    #[test]
    fn an_index_that_would_not_open_says_so_instead_of_printing_zeroes() {
        let out = render(&serde_json::json!({"error": "database disk image is malformed"}));
        assert!(out.contains("could not be read"));
        assert!(out.contains("database disk image is malformed"));
        assert!(!out.contains("files seen"));
    }

    #[test]
    fn skip_reasons_are_counted_and_ordered() {
        let out = skip_reasons(&serde_json::json!({
            "skip_reasons": {"oversize": 2, "non-utf8": 11},
        }));
        assert_eq!(out, "11 non-utf8, 2 oversize");
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
