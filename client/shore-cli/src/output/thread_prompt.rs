use std::io::Write;

use serde_json::Value;
use shore_common::protocol::operations::{PinShown, ThreadPinStatus, ThreadPromptView};

use super::vocab::{Rows, Tone, blank, empty, indent_to, section};

fn size(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let tenths = bytes.saturating_mul(10).checked_div(1024).unwrap_or(0);
    let whole = tenths.checked_div(10).unwrap_or(0);
    match tenths.checked_rem(10).unwrap_or(0) {
        0 => format!("{whole} KB"),
        part => format!("{whole}.{part} KB"),
    }
}

fn pin_state(pin: &ThreadPinStatus) -> (String, Tone) {
    match pin.shown {
        PinShown::Whole => (size(pin.bytes), Tone::Plain),
        PinShown::Cut => (
            format!(
                "{}, cut: past what a thread's pins can take together",
                size(pin.bytes)
            ),
            Tone::Warn,
        ),
        PinShown::LeftOut => (
            format!(
                "{}, left out: past what a thread's pins can take together",
                size(pin.bytes)
            ),
            Tone::Bad,
        ),
        PinShown::Nothing if pin.pin.starts_with('!') => (
            "hasn't run yet; it runs with the next message".to_owned(),
            Tone::Muted,
        ),
        PinShown::Nothing => ("empty, or not in the workspace".to_owned(), Tone::Bad),
    }
}

const CHANGED: &str = "changed in the workspace since; --refresh shows the new version";

pub(crate) fn write<W: Write>(out: &mut W, view: &ThreadPromptView) {
    if view.parts.is_empty() {
        empty(out, "no system prompt");
    }
    for (at, part) in view.parts.iter().enumerate() {
        if at > 0 {
            blank(out);
        }
        section(out, &part.label, part.changed.then_some(CHANGED));
        for line in part.text.lines() {
            if !line.is_empty() {
                indent_to(out, 0);
            }
            let _ignored = writeln!(out, "{line}");
        }
    }
    if view.pins.is_empty() {
        return;
    }
    blank(out);
    section(out, "pins", None);
    let mut rows = Rows::new();
    for pin in &view.pins {
        let (state, tone) = pin_state(pin);
        if pin.changed {
            rows.add_noted(&pin.pin, &state, CHANGED, tone);
        } else {
            rows.add_toned(&pin.pin, &state, tone);
        }
    }
    rows.write(out);
}

pub(crate) fn print(data: &Value) -> Result<(), String> {
    let view: ThreadPromptView = serde_json::from_value(data.clone())
        .map_err(|error| format!("the daemon's thread prompt didn't read: {error}"))?;
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write(&mut out, &view);
    Ok(())
}
