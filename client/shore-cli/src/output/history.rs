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
