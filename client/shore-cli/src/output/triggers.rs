use std::io::Write;

use chrono::{DateTime, Local};
use serde_json::Value;

use super::autonomy::format_duration_compact;
use super::vocab::{Rows, Tone, empty, section, warning};

fn text<'value>(data: &'value Value, key: &str) -> &'value str {
    data.get(key).and_then(Value::as_str).unwrap_or("")
}

fn listed<'value>(triggers: &'value Value, key: &str) -> &'value [Value] {
    triggers
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn switched_off(triggers: &Value) -> bool {
    triggers.get("enabled").and_then(Value::as_bool) == Some(false)
}

fn next_line(next: &Value, now: DateTime<Local>) -> String {
    let name = match next.get("thread").and_then(Value::as_str) {
        Some(thread) => format!("wake asked for in \"{thread}\""),
        None => text(next, "trigger").to_owned(),
    };
    match super::parse_timestamp(text(next, "at")) {
        Some(at) if at > now => format!(
            "next {name} in {}",
            format_duration_compact(at.signed_duration_since(now).num_seconds())
        ),
        _ => format!("next {name} due now"),
    }
}

pub(crate) fn status_row(
    triggers: &Value,
    character: &str,
    now: DateTime<Local>,
) -> (String, Tone) {
    let count = listed(triggers, "triggers").len();
    let not_running = listed(triggers, "not_running").len();
    if switched_off(triggers) {
        return ("switched off \u{00b7} nothing fires".to_owned(), Tone::Warn);
    }
    if count == 0 && not_running == 0 && listed(triggers, "asked").is_empty() {
        return (
            format!("none \u{00b7} nothing wakes {character}"),
            Tone::Warn,
        );
    }
    let next = triggers
        .get("next_wake")
        .map_or_else(|| "none due".to_owned(), |next| next_line(next, now));
    if not_running == 0 {
        (format!("{count} \u{00b7} {next}"), Tone::Plain)
    } else {
        (
            format!("{count} \u{00b7} {next} \u{00b7} {not_running} not running"),
            Tone::Warn,
        )
    }
}

pub(crate) fn write_status_section<W: Write>(
    out: &mut W,
    triggers: &Value,
    character: &str,
    dormant: bool,
) {
    section(
        out,
        "triggers",
        Some(&format!("TRIGGERS.toml in {character}'s workspace")),
    );
    match (switched_off(triggers), dormant) {
        (true, _) => warning(out, "switched off, so nothing fires"),
        (false, true) => warning(
            out,
            &format!("{character} is dormant, so nothing fires until you write"),
        ),
        (false, false) => {}
    }
    let each = listed(triggers, "triggers");
    let not_running = listed(triggers, "not_running");
    let asked = listed(triggers, "asked");
    if each.is_empty() && not_running.is_empty() && asked.is_empty() {
        empty(
            out,
            &format!("none, so nothing wakes {character} on its own"),
        );
        return;
    }
    let mut rows = Rows::new();
    for trigger in each {
        rows.add(text(trigger, "name"), text(trigger, "does"));
        rows.add_toned("", text(trigger, "status"), Tone::Muted);
    }
    for wake in asked {
        rows.add(&format!("\"{}\"", text(wake, "thread")), text(wake, "does"));
        rows.add_toned("", text(wake, "status"), Tone::Muted);
    }
    rows.write(out);
    for problem in not_running {
        warning(out, problem.as_str().unwrap_or_default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn now() -> DateTime<Local> {
        Local
            .timestamp_opt(1_795_521_600, 0)
            .single()
            .unwrap_or_default()
    }

    fn at(secs_from_now: i64) -> String {
        now()
            .checked_add_signed(chrono::Duration::seconds(secs_from_now))
            .map(|at| at.to_rfc3339())
            .unwrap_or_default()
    }

    fn row(triggers: &Value) -> (String, Tone) {
        status_row(triggers, "ada", now())
    }

    #[test]
    fn the_row_counts_the_triggers_and_says_which_is_due_next_and_when() {
        let listed = json!([{ "name": "lamp" }, { "name": "tide" }]);
        let next = json!({ "enabled": true, "next_wake": { "trigger": "lamp", "at": at(7_800) }, "triggers": listed, "not_running": [] });
        assert_eq!(
            row(&next),
            ("2 \u{00b7} next lamp in 2h 10m".to_owned(), Tone::Plain)
        );
        let late = json!({ "enabled": true, "next_wake": { "trigger": "lamp", "at": at(0) }, "triggers": listed, "not_running": [] });
        assert_eq!(row(&late).0, "2 \u{00b7} next lamp due now");
        let quiet = json!({ "enabled": true, "triggers": listed, "not_running": [] });
        assert_eq!(row(&quiet), ("2 \u{00b7} none due".to_owned(), Tone::Plain));
    }

    #[test]
    fn the_row_warns_when_nothing_can_wake_the_character_or_some_triggers_are_not_running() {
        let off = json!({ "enabled": false, "triggers": [{ "name": "lamp" }], "not_running": [] });
        assert_eq!(
            row(&off),
            ("switched off \u{00b7} nothing fires".to_owned(), Tone::Warn)
        );
        let none = json!({ "enabled": true, "triggers": [], "not_running": [] });
        assert_eq!(
            row(&none),
            ("none \u{00b7} nothing wakes ada".to_owned(), Tone::Warn)
        );
        let broken =
            json!({ "enabled": true, "triggers": [], "not_running": ["`lamp` isn't running"] });
        assert_eq!(
            row(&broken),
            (
                "0 \u{00b7} none due \u{00b7} 1 not running".to_owned(),
                Tone::Warn
            )
        );
    }

    #[test]
    fn the_row_names_a_wake_the_character_asked_for_when_it_starts_first() {
        let listed = json!([{ "name": "lamp" }]);
        let next = json!({ "enabled": true, "next_wake": { "trigger": "", "thread": "ring", "at": at(2_400) }, "triggers": listed, "not_running": [] });
        assert_eq!(
            row(&next),
            (
                "1 \u{00b7} next wake asked for in \"ring\" in 40m".to_owned(),
                Tone::Plain
            )
        );
        let only = json!({ "enabled": true, "next_wake": { "trigger": "", "thread": "ring", "at": at(0) }, "triggers": [], "not_running": [], "asked": [{ "thread": "ring" }] });
        assert_eq!(
            row(&only),
            (
                "0 \u{00b7} next wake asked for in \"ring\" due now".to_owned(),
                Tone::Plain
            )
        );
    }

    fn shown(triggers: &Value, dormant: bool) -> (String, Vec<String>) {
        crate::output::set_color_enabled(false);
        let mut out = Vec::new();
        write_status_section(&mut out, triggers, "ada", dormant);
        let written = String::from_utf8(out).unwrap_or_default();
        let mut lines = written.lines().map(str::trim_end).map(str::to_owned);
        let header = lines.next().unwrap_or_default();
        (header, lines.collect())
    }

    fn first(triggers: &Value, dormant: bool) -> String {
        shown(triggers, dormant)
            .1
            .into_iter()
            .next()
            .unwrap_or_default()
    }

    #[test]
    fn the_section_lists_each_trigger_with_what_it_does_and_its_status_then_the_ones_not_running() {
        let triggers = json!({
            "enabled": true,
            "triggers": [
                { "name": "lamp", "does": "every 1h, wakes ada", "status": "never fired" },
                { "name": "ferry", "does": "when you have been quiet for 2h, wakes ada", "status": "next soon" },
            ],
            "not_running": ["`tide` isn't running: no reason"],
        });
        let (header, body) = shown(&triggers, false);
        assert!(
            header.starts_with(
                "\u{2500}\u{2500} triggers \u{00b7} TRIGGERS.toml in ada's workspace "
            ),
            "{header}"
        );
        assert_eq!(
            body,
            [
                "  lamp   every 1h, wakes ada",
                "         never fired",
                "  ferry  when you have been quiet for 2h, wakes ada",
                "         next soon",
                "  ! `tide` isn't running: no reason",
            ]
        );
    }

    #[test]
    fn the_section_lists_the_wakes_the_character_asked_for_after_its_triggers() {
        let asked = json!([{ "thread": "ring", "does": "asked for from \"main\": Tell part two.", "status": "starts at five" }]);
        let both = json!({ "enabled": true, "triggers": [{ "name": "lamp", "does": "every 1h", "status": "never fired" }], "not_running": [], "asked": asked });
        assert_eq!(
            shown(&both, false).1,
            [
                "  lamp    every 1h",
                "          never fired",
                "  \"ring\"  asked for from \"main\": Tell part two.",
                "          starts at five",
            ]
        );
        let alone = json!({ "enabled": true, "triggers": [], "not_running": [], "asked": asked });
        assert_eq!(
            first(&alone, false),
            "  \"ring\"  asked for from \"main\": Tell part two."
        );
    }

    #[test]
    fn the_section_says_when_nothing_fires_and_when_there_are_none() {
        let lamp = json!([{ "name": "lamp", "does": "every 1h", "status": "never fired" }]);
        let off = json!({ "enabled": false, "triggers": lamp, "not_running": [] });
        assert_eq!(first(&off, true), "  ! switched off, so nothing fires");
        let on = json!({ "enabled": true, "triggers": lamp, "not_running": [] });
        assert_eq!(
            first(&on, true),
            "  ! ada is dormant, so nothing fires until you write"
        );
        assert_eq!(first(&on, false), "  lamp  every 1h");
        let none = json!({ "enabled": true, "triggers": [], "not_running": [] });
        assert_eq!(
            shown(&none, false).1,
            ["  (none, so nothing wakes ada on its own)"]
        );
    }
}
