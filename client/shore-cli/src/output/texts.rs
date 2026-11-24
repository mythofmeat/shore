use std::io::Write;

use serde_json::Value;
use shore_common::protocol::operations::{TextEntry, TextListing, TextOwner};

use super::vocab::{Rows, Tone, blank, indent_to, key_line, section};

fn owner_word(owner: &TextOwner) -> &'static str {
    match owner {
        TextOwner::Shore => "Shore's",
        TextOwner::Yours => "yours",
        TextOwner::Off => "off",
        TextOwner::Fixed => "Shore's, fixed",
        TextOwner::Cli => "the CLI's",
    }
}

fn write_block<W: Write>(out: &mut W, title: &str, body: &str) {
    key_line(out, 0, title);
    for line in body.lines() {
        indent_to(out, 1);
        let _ignored = writeln!(out, "{line}");
    }
}

pub(crate) fn write_list<W: Write>(out: &mut W, listing: &TextListing) {
    let mut rows = Rows::new();
    for text in &listing.texts {
        rows.add_noted(
            &text.name,
            owner_word(&text.owner),
            &text.place,
            Tone::Plain,
        );
    }
    rows.write(out);
}

pub(crate) fn write_text<W: Write>(out: &mut W, text: &TextEntry) {
    section(out, &text.name, Some(owner_word(&text.owner)));
    let mut rows = Rows::new();
    rows.add("where", &text.place);
    if let Some(file) = &text.file {
        rows.add("file", file);
    }
    if let Some(error) = &text.error {
        rows.add("error", error);
    }
    if text.required {
        rows.add("needed", "yes, it can't be switched off");
    }
    for value in &text.values {
        rows.add(&format!("{{{{{}}}}}", value.name), &value.about);
    }
    rows.write(out);
    blank(out);
    match &text.wording {
        Some(wording) => write_block(out, "wording in use", wording),
        None => write_block(out, "wording in use", "(none)"),
    }
    if text.wording.as_deref() != Some(text.shipped.as_str()) {
        blank(out);
        write_block(out, "Shore's wording", &text.shipped);
    }
}

pub(crate) fn write<W: Write>(
    out: &mut W,
    data: &Value,
    asked: Option<&str>,
) -> Result<(), String> {
    let listing: TextListing = serde_json::from_value(data.clone())
        .map_err(|error| format!("the daemon's list of texts didn't read: {error}"))?;
    let Some(name) = asked else {
        write_list(out, &listing);
        return Ok(());
    };
    let text = listing
        .texts
        .iter()
        .find(|text| text.name == name)
        .ok_or_else(|| {
            format!("there is no text named {name:?}; `shore config texts` lists them")
        })?;
    write_text(out, text);
    Ok(())
}

pub(crate) fn print(data: &Value, name: Option<&str>) -> Result<(), String> {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write(&mut out, data, name)
}
