use std::io::Write;

use super::vocab::{Tone, empty, section, warning, write_row, write_row_colored};

pub(crate) fn write_history_section(out: &mut impl Write, index: &serde_json::Value) {
    section(out, "chat logs", None);

    if let Some(error) = index["error"].as_str() {
        warning(
            out,
            &format!("the chat log index could not be read: {error}"),
        );
        return;
    }

    let messages = index["messages"].as_u64().unwrap_or(0);
    if messages == 0 {
        empty(out, "no messages indexed yet");
    } else {
        write_row(out, "messages", &messages.to_string());
    }

    let background = &index["background"];
    if let Some(error) = background["last_error"].as_str() {
        write_row_colored(out, "indexing", "failing", Tone::Bad);
        write_row(out, "last error", error);
        write_row(
            out,
            "failures",
            &background["failures"].as_u64().unwrap_or(0).to_string(),
        );
        if let Some(secs) = background["retry_in_secs"].as_u64() {
            write_row(out, "retrying in", &format!("{secs}s"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(value: &serde_json::Value) -> String {
        let mut buf: Vec<u8> = Vec::new();
        write_history_section(&mut buf, value);
        String::from_utf8(buf).expect("utf8")
    }

    #[test]
    fn a_healthy_index_is_its_message_count() {
        let out = render(&serde_json::json!({
            "messages": 36_684,
            "background": { "failures": 0 },
        }));
        assert!(out.contains("36684"), "{out}");
        assert!(
            !out.contains("failing"),
            "healthy indexing is not status: {out}"
        );
    }

    #[test]
    fn empty_index_says_so() {
        let out = render(&serde_json::json!({
            "messages": 0,
            "background": { "failures": 0 },
        }));
        assert!(out.contains("no messages indexed yet"), "{out}");
    }

    #[test]
    fn a_failing_rebuild_keeps_the_actionable_error() {
        let out = render(&serde_json::json!({
            "messages": 12,
            "background": { "failures": 3, "last_error": "database is locked", "retry_in_secs": 8 },
        }));
        assert!(out.contains("failing"), "{out}");
        assert!(out.contains("database is locked"), "{out}");
        assert!(out.contains("8s"), "{out}");
    }

    #[test]
    fn an_unreadable_index_reports_the_problem_without_fake_zeroes() {
        let out = render(&serde_json::json!({"error": "history lock failed"}));
        assert!(out.contains("history lock failed"), "{out}");
        assert!(!out.contains("no messages indexed yet"), "{out}");
    }
}
