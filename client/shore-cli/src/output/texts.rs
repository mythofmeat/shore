use std::io::Write;

use serde_json::Value;
use shore_common::protocol::operations::{TextEntry, TextListing, TextOwner};

use super::vocab::{Rows, Tone, blank, indent_to, key_line, note, section};

fn owner_word(owner: &TextOwner) -> &'static str {
    match owner {
        TextOwner::Shore => "Shore's",
        TextOwner::Yours => "yours",
        TextOwner::Off => "off",
        TextOwner::Cli => "the CLI's",
    }
}

fn whose(text: &TextEntry) -> String {
    let owner = owner_word(&text.owner);
    match (text.changed, &text.previous) {
        (false, _) => owner.to_owned(),
        (true, Some(_)) => format!("{owner}, changed"),
        (true, None) => format!("{owner}, new"),
    }
}

fn write_block<W: Write>(out: &mut W, title: &str, body: &str) {
    key_line(out, 0, title);
    for line in body.lines() {
        indent_to(out, 1);
        let _ignored = writeln!(out, "{line}");
    }
}

fn write_rows<'listing, W: Write>(
    out: &mut W,
    texts: impl Iterator<Item = &'listing TextEntry>,
    tone: Tone,
) {
    let mut rows = Rows::new();
    for text in texts {
        rows.add_noted(&text.name, &whose(text), &text.place, tone);
    }
    rows.write(out);
}

pub(crate) fn write_list<W: Write>(out: &mut W, listing: &TextListing) {
    if !listing.texts.iter().any(|text| text.changed) {
        write_rows(out, listing.texts.iter(), Tone::Plain);
        return;
    }
    section(out, "changed in an update", None);
    write_rows(
        out,
        listing.texts.iter().filter(|text| text.changed),
        Tone::Warn,
    );
    note(out, "`shore config texts --seen` marks them seen.");
    blank(out);
    section(out, "texts", None);
    write_rows(
        out,
        listing.texts.iter().filter(|text| !text.changed),
        Tone::Plain,
    );
}

pub(crate) fn write_text<W: Write>(out: &mut W, text: &TextEntry) {
    section(out, &text.name, Some(&whose(text)));
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
    if let Some(previous) = &text.previous {
        blank(out);
        write_block(out, "Shore's wording before an update changed it", previous);
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
