use std::io::Write;

use super::vocab::{Tone, empty, note, section, warning, write_row, write_row_colored};

pub(crate) fn write_history_section(out: &mut impl Write, index: &serde_json::Value) {
    section(out, "history", None);

    if let Some(error) = index["error"].as_str() {
        warning(
            out,
            &format!("the history index could not be read: {error}"),
        );
        return;
    }

    let chunks = index["chunks"].as_u64().unwrap_or(0);
    let embedded = index["embedded"].as_u64().unwrap_or(0);
    let pending = index["pending"].as_u64().unwrap_or(0);

    if chunks == 0 {
        empty(out, "no conversation history indexed yet");
        return;
    }

    write_row(
        out,
        "messages",
        &index["messages"].as_u64().unwrap_or(0).to_string(),
    );
    write_row(out, "chunks", &chunks.to_string());
    write_row_colored(
        out,
        "embedded",
        &format!("{embedded} of {chunks}"),
        if pending == 0 {
            Tone::Good
        } else {
            Tone::Active
        },
    );
    if pending > 0 {
        write_row_colored(out, "pending", &pending.to_string(), Tone::Active);
    }
    if let Some(model) = index["model"].as_str() {
        write_row(out, "model", model);
    }
    if embedded == 0 {
        warning(
            out,
            "nothing is embedded — history search is running on keywords alone",
        );
    }

    write_background(out, &index["background"], pending);
}

fn write_background(out: &mut impl Write, background: &serde_json::Value, pending: u64) {
    if background["registered"].as_bool() != Some(true) {
        note(
            out,
            "no embedding model configured — nothing will ever be embedded",
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

    write_row_colored(out, "background", "up to date", Tone::Good);
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
    fn reports_a_stalled_index_rather_than_looking_healthy() {
        let out = render(&serde_json::json!({
            "messages": 33476,
            "chunks": 47525,
            "embedded": 0,
            "pending": 47525,
            "model": "qwen/qwen3-embedding-8b",
            "background": { "registered": true, "failures": 0 },
        }));
        assert!(out.contains("0 of 47525"));
        assert!(out.contains("keywords alone"));
    }

    #[test]
    fn reports_a_complete_index() {
        let out = render(&serde_json::json!({
            "messages": 12,
            "chunks": 20,
            "embedded": 20,
            "pending": 0,
            "model": "qwen/qwen3-embedding-8b",
            "background": { "registered": true, "failures": 0 },
        }));
        assert!(out.contains("20 of 20"));
        assert!(out.contains("up to date"));
        assert!(!out.contains("keywords alone"));
    }

    #[test]
    fn calls_out_a_missing_embedder() {
        let out = render(&serde_json::json!({
            "messages": 5,
            "chunks": 9,
            "embedded": 0,
            "pending": 9,
            "model": serde_json::Value::Null,
            "background": { "registered": false, "failures": 0 },
        }));
        assert!(out.contains("nothing will ever be embedded"));
    }

    #[test]
    fn empty_index_says_so() {
        let out = render(&serde_json::json!({
            "messages": 0,
            "chunks": 0,
            "embedded": 0,
            "pending": 0,
            "background": { "registered": true, "failures": 0 },
        }));
        assert!(out.contains("no conversation history indexed yet"));
    }
}
