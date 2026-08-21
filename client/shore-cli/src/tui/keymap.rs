use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

pub(crate) const RESERVED_KEYS: [&str; 3] = ["esc", ":", "ctrl+c"];

pub(crate) const DEFAULT_NORMAL_KEYS: [(&str, &str); 21] = [
    ("i", "ui insert"),
    ("a", "ui insert --end"),
    ("A", "ui insert --end"),
    ("I", "ui insert --home"),
    ("j", "ui scroll down 1"),
    ("down", "ui scroll down 1"),
    ("k", "ui scroll up 1"),
    ("up", "ui scroll up 1"),
    ("d", "ui scroll down 10"),
    ("u", "ui scroll up 10"),
    ("G", "ui scroll bottom"),
    ("t", "view thinking"),
    ("T", "view tools"),
    ("s", "view subagent"),
    ("p", "view images"),
    ("S", "ui subagents"),
    ("o", "ui images"),
    ("r", "msg regen"),
    ("ctrl+g", "ui editor"),
    ("/", "ui palette shortcuts"),
    ("ctrl+p", "ui palette config"),
];

pub(crate) const DEFAULT_SHORTCUTS: [(&str, &str); 8] = [
    ("regen", "msg regen"),
    ("edit", "msg edit"),
    ("alt", "msg alt"),
    ("delete", "msg delete"),
    ("compact", "compact"),
    ("usage", "usage"),
    ("status", "status"),
    ("clear", "clear"),
];

const NAMED_KEYS: [&str; 15] = [
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
    "tab",
    "backtab",
    "enter",
    "backspace",
    "delete",
    "insert",
    "esc",
];

const KEY_ALIASES: [(&str, &str); 8] = [
    ("escape", "esc"),
    ("return", "enter"),
    ("cr", "enter"),
    ("space", " "),
    ("bs", "backspace"),
    ("del", "delete"),
    ("pgup", "pageup"),
    ("pgdn", "pagedown"),
];

const SEED_HEADER: &str = "\
# Key bindings for `shore tui`.
#
# Every value is a shore command — the same text the `:` prompt takes, so
# anything you can type there you can bind. Delete a line to unbind that key.
#
# Modifiers are ctrl+, alt+ and shift+. A shifted letter is just its capital:
# write `T`, not `shift+t`, because that is how a terminal reports it.
#
# esc, : and ctrl+c belong to the TUI and cannot be bound.
#
# [shortcuts] is the `/` menu: a name and the command it runs. A shortcut whose
# command is also on a key shows that key beside it.

";

#[derive(Clone, Debug)]
pub(crate) struct Binding {
    pub(crate) written: String,
    pub(crate) command: String,
    pub(crate) needs_more_input: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Keymap {
    normal: Vec<(String, Binding)>,
    shortcuts: Vec<(String, Binding)>,
    pub(crate) warnings: Vec<String>,
}

impl Default for Keymap {
    fn default() -> Self {
        let mut keymap = Self {
            normal: Vec::new(),
            shortcuts: Vec::new(),
            warnings: Vec::new(),
        };
        for (key, command) in DEFAULT_NORMAL_KEYS {
            if let Err(problem) = keymap.bind(key, command) {
                keymap.warnings.push(problem);
            }
        }
        for (name, command) in DEFAULT_SHORTCUTS {
            if let Err(problem) = keymap.add_shortcut(name, command) {
                keymap.warnings.push(problem);
            }
        }
        keymap
    }
}

impl Keymap {
    pub(crate) fn load() -> Self {
        Self::load_from(&keymap_path())
    }

    pub(crate) fn load_from(path: &std::path::Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            let seeded = Self::default();
            if let Err(error) = seeded.save_to(path) {
                tracing::warn!(path = %path.display(), %error, "could not seed the keymap");
            }
            return seeded;
        };
        Self::parse(&text)
    }

    pub(crate) fn parse(text: &str) -> Self {
        let mut keymap = Self {
            normal: Vec::new(),
            shortcuts: Vec::new(),
            warnings: Vec::new(),
        };

        let table = match text.parse::<toml::Table>() {
            Ok(table) => table,
            Err(error) => {
                keymap.warnings.push(format!(
                    "tui.toml could not be read ({error}); using defaults"
                ));
                let mut fallback = Self::default();
                fallback.warnings.append(&mut keymap.warnings);
                return fallback;
            }
        };

        if let Some(normal) = table.get("normal").and_then(toml::Value::as_table) {
            for (key, value) in normal {
                let Some(command) = value.as_str() else {
                    keymap
                        .warnings
                        .push(format!("{key} is not bound to a command string"));
                    continue;
                };
                if let Err(problem) = keymap.bind(key, command) {
                    keymap.warnings.push(problem);
                }
            }
        } else {
            keymap
                .warnings
                .push("tui.toml has no [normal] section, so no key is bound".to_owned());
        }

        if let Some(shortcuts) = table.get("shortcuts").and_then(toml::Value::as_table) {
            for (name, value) in shortcuts {
                let Some(command) = value.as_str() else {
                    keymap
                        .warnings
                        .push(format!("/{name} is not set to a command string"));
                    continue;
                };
                if let Err(problem) = keymap.add_shortcut(name, command) {
                    keymap.warnings.push(problem);
                }
            }
        }
        keymap
    }

    pub(crate) fn add_shortcut(&mut self, name: &str, command: &str) -> Result<(), String> {
        let label = name.trim().to_owned();
        if label.is_empty() || label.split_whitespace().count() != 1 {
            return Err(format!("{name:?} is not a usable shortcut name"));
        }
        let binding = Self::checked_binding(&format!("/{label}"), command)?;
        match self.shortcuts.iter_mut().find(|(bound, _)| bound == &label) {
            Some((_, existing)) => *existing = binding,
            None => self.shortcuts.push((label, binding)),
        }
        Ok(())
    }

    pub(crate) fn shortcuts(&self) -> &[(String, Binding)] {
        &self.shortcuts
    }

    pub(crate) fn key_for_command(&self, command: &str) -> Option<&str> {
        self.normal
            .iter()
            .find(|(_, binding)| binding.command == command)
            .map(|(key, _)| key.as_str())
    }

    fn checked_binding(label: &str, command: &str) -> Result<Binding, String> {
        let expanded = crate::tui::input::expand_aliases(command);
        match crate::cli::palette_command_needs_more_input(&expanded) {
            Ok(needs_more_input) => Ok(Binding {
                written: command.to_owned(),
                command: expanded,
                needs_more_input,
            }),
            Err(problem) => {
                let first = problem
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("is not a command")
                    .trim();
                Err(format!("{label} is set to {command:?}, which {first}"))
            }
        }
    }

    pub(crate) fn bind(&mut self, key: &str, command: &str) -> Result<(), String> {
        let token = canonical_key(key)?;
        if RESERVED_KEYS.contains(&token.as_str()) {
            return Err(format!("{token} belongs to the TUI and cannot be bound"));
        }
        let binding = Self::checked_binding(&token, command)?;
        if binding.needs_more_input {
            return Err(format!(
                "{token} is bound to {command:?}, which still needs an argument; a key runs its command as written"
            ));
        }
        match self.normal.iter_mut().find(|(bound, _)| bound == &token) {
            Some((_, existing)) => *existing = binding,
            None => self.normal.push((token, binding)),
        }
        Ok(())
    }

    pub(crate) fn unbind(&mut self, key: &str) -> Result<Option<String>, String> {
        let token = canonical_key(key)?;
        let Some(index) = self.normal.iter().position(|(bound, _)| bound == &token) else {
            return Ok(None);
        };
        let (_, binding) = self.normal.remove(index);
        Ok(Some(binding.written))
    }

    pub(crate) fn lookup(&self, token: &str) -> Option<&Binding> {
        self.normal
            .iter()
            .find(|(bound, _)| bound == token)
            .map(|(_, binding)| binding)
    }

    pub(crate) fn bindings(&self) -> &[(String, Binding)] {
        &self.normal
    }

    pub(crate) fn save(&self) -> std::io::Result<()> {
        self.save_to(&keymap_path())
    }

    pub(crate) fn save_to(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = String::from(SEED_HEADER);
        out.push_str("[normal]\n");
        for (key, binding) in &self.normal {
            out.push_str(&format!(
                "{} = {}\n",
                toml::Value::String(key.clone()),
                toml::Value::String(binding.written.clone())
            ));
        }
        out.push_str("\n[shortcuts]\n");
        for (name, binding) in &self.shortcuts {
            out.push_str(&format!(
                "{} = {}\n",
                toml::Value::String(name.clone()),
                toml::Value::String(binding.written.clone())
            ));
        }
        std::fs::write(path, out)
    }
}

pub(crate) fn keymap_path() -> PathBuf {
    shore_common::dirs::config_dir().join("tui.toml")
}

#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "a key with no spelling here simply cannot be bound"
)]
pub(crate) fn key_token(key: KeyEvent) -> Option<String> {
    let mut token = String::new();
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        token.push_str("ctrl+");
    }
    if key.modifiers.contains(KeyModifiers::ALT) {
        token.push_str("alt+");
    }
    let named = match key.code {
        KeyCode::Char(c) => {
            token.push(c);
            return Some(token);
        }
        KeyCode::Up => "up",
        KeyCode::Down => "down",
        KeyCode::Left => "left",
        KeyCode::Right => "right",
        KeyCode::Home => "home",
        KeyCode::End => "end",
        KeyCode::PageUp => "pageup",
        KeyCode::PageDown => "pagedown",
        KeyCode::Tab => "tab",
        KeyCode::BackTab => "backtab",
        KeyCode::Enter => "enter",
        KeyCode::Backspace => "backspace",
        KeyCode::Delete => "delete",
        KeyCode::Insert => "insert",
        KeyCode::Esc => "esc",
        _ => return None,
    };
    if key.modifiers.contains(KeyModifiers::SHIFT) {
        token.push_str("shift+");
    }
    token.push_str(named);
    Some(token)
}

pub(crate) fn canonical_key(written: &str) -> Result<String, String> {
    let trimmed = written.trim();
    if trimmed.is_empty() {
        return Err("a binding needs a key".to_owned());
    }

    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    let mut base = trimmed;
    while let Some((modifier, rest)) = base.split_once('+')
        && !rest.is_empty()
    {
        match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" | "meta" | "opt" | "option" => alt = true,
            "shift" => shift = true,
            other => {
                return Err(format!(
                    "{other:?} is not a modifier; write ctrl, alt or shift"
                ));
            }
        }
        base = rest;
    }

    let mut token = String::new();
    if ctrl {
        token.push_str("ctrl+");
    }
    if alt {
        token.push_str("alt+");
    }

    let mut chars = base.chars();
    if let (Some(only), None) = (chars.next(), chars.next()) {
        token.push(if shift {
            only.to_ascii_uppercase()
        } else {
            only
        });
        return Ok(token);
    }

    let lowered = base.to_ascii_lowercase();
    let named = KEY_ALIASES
        .iter()
        .find(|&&(alias, _)| alias == lowered)
        .map_or(lowered.as_str(), |&(_, real)| real);

    if named == " " {
        token.push(' ');
        return Ok(token);
    }
    if !NAMED_KEYS.contains(&named) {
        return Err(format!("{base:?} is not a key this TUI knows"));
    }
    if shift {
        token.push_str("shift+");
    }
    token.push_str(named);
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEventKind, KeyEventState};

    fn press(modifiers: KeyModifiers, code: KeyCode) -> KeyEvent {
        KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }
    }

    #[test]
    fn a_shifted_letter_and_its_capital_are_the_same_binding() {
        assert_eq!(canonical_key("shift+m").unwrap(), "M");
        assert_eq!(canonical_key("M").unwrap(), "M");
        assert_eq!(
            key_token(press(KeyModifiers::SHIFT, KeyCode::Char('M'))).unwrap(),
            "M"
        );
    }

    #[test]
    fn written_and_pressed_modifiers_agree_on_order() {
        assert_eq!(canonical_key("ctrl+g").unwrap(), "ctrl+g");
        assert_eq!(canonical_key("CTRL+G").unwrap(), "ctrl+G");
        assert_eq!(
            key_token(press(KeyModifiers::CONTROL, KeyCode::Char('g'))).unwrap(),
            "ctrl+g"
        );
        assert_eq!(canonical_key("ctrl+shift+up").unwrap(), "ctrl+shift+up");
        assert_eq!(
            key_token(press(
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
                KeyCode::Up
            ))
            .unwrap(),
            "ctrl+shift+up"
        );
    }

    #[test]
    fn plus_is_a_key_not_only_a_separator() {
        assert_eq!(canonical_key("+").unwrap(), "+");
        assert_eq!(canonical_key("ctrl++").unwrap(), "ctrl++");
    }

    #[test]
    fn friendly_key_names_resolve() {
        assert_eq!(canonical_key("escape").unwrap(), "esc");
        assert_eq!(canonical_key("Return").unwrap(), "enter");
        assert_eq!(canonical_key("space").unwrap(), " ");
        assert_eq!(canonical_key("PgUp").unwrap(), "pageup");
    }

    #[test]
    fn an_unknown_key_or_modifier_is_refused_by_name() {
        assert!(canonical_key("hyper+q").unwrap_err().contains("hyper"));
        assert!(canonical_key("wiggle").unwrap_err().contains("wiggle"));
        assert!(canonical_key("  ").unwrap_err().contains("needs a key"));
    }

    #[test]
    fn every_default_binding_parses() {
        let keymap = Keymap::default();
        assert!(
            keymap.warnings.is_empty(),
            "seeded defaults should all be valid: {:?}",
            keymap.warnings
        );
        assert_eq!(keymap.bindings().len(), DEFAULT_NORMAL_KEYS.len());
    }

    #[test]
    fn reserved_keys_cannot_be_taken() {
        let mut keymap = Keymap::default();
        for key in ["esc", "escape", ":", "ctrl+c"] {
            let problem = keymap.bind(key, "msg regen").unwrap_err();
            assert!(
                problem.contains("cannot be bound"),
                "{key} should be reserved, got {problem}"
            );
        }
    }

    #[test]
    fn a_binding_to_a_command_that_does_not_exist_is_refused() {
        let mut keymap = Keymap::default();
        let problem = keymap.bind("q", "definitely not a command").unwrap_err();
        assert!(problem.contains("definitely not a command"), "{problem}");
        assert!(keymap.lookup("q").is_none());
    }

    #[test]
    fn palette_shorthand_works_in_a_binding() {
        let mut keymap = Keymap::default();
        keymap.bind("R", "regen").unwrap();
        let binding = keymap.lookup("R").unwrap();
        assert_eq!(binding.written, "regen");
        assert_eq!(binding.command, "msg regen");
    }

    #[test]
    fn shortcuts_are_seeded_and_carry_the_key_that_also_runs_them() {
        let keymap = Keymap::default();
        assert!(keymap.warnings.is_empty(), "{:?}", keymap.warnings);
        assert_eq!(keymap.shortcuts().len(), DEFAULT_SHORTCUTS.len());
        assert_eq!(keymap.key_for_command("msg regen"), Some("r"));
        assert_eq!(keymap.key_for_command("usage"), None);
    }

    #[test]
    fn a_shortcut_may_be_a_prefix_but_a_key_may_not() {
        let mut keymap = Keymap::default();

        keymap.add_shortcut("edit", "msg edit").unwrap();
        let (_, edit) = keymap
            .shortcuts()
            .iter()
            .find(|(name, _)| name == "edit")
            .unwrap();
        assert!(
            edit.needs_more_input,
            "`msg edit` still wants a reference, so /edit should load the line"
        );

        let (_, regen) = keymap
            .shortcuts()
            .iter()
            .find(|(name, _)| name == "regen")
            .unwrap();
        assert!(
            !regen.needs_more_input,
            "`msg regen` is complete on its own"
        );

        let problem = keymap.bind("e", "msg edit").unwrap_err();
        assert!(problem.contains("still needs an argument"), "{problem}");
    }

    #[test]
    fn a_shortcut_naming_a_command_that_does_not_exist_is_refused() {
        let mut keymap = Keymap::default();
        let problem = keymap.add_shortcut("boom", "not a command").unwrap_err();
        assert!(problem.contains("/boom"), "{problem}");
        assert!(keymap.shortcuts().iter().all(|(n, _)| n != "boom"));
    }

    #[test]
    fn a_shortcut_name_is_one_word() {
        let mut keymap = Keymap::default();
        assert!(keymap.add_shortcut("two words", "usage").is_err());
        assert!(keymap.add_shortcut("  ", "usage").is_err());
        assert!(keymap.add_shortcut("compact", "compact --restart").is_ok());
    }

    #[test]
    fn both_sections_survive_a_round_trip() {
        let mut keymap = Keymap::default();
        keymap.add_shortcut("wipe", "clear").unwrap();
        let dir = std::env::temp_dir().join(format!("shore-shortcuts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tui.toml");
        keymap.save_to(&path).unwrap();
        let reloaded = Keymap::load_from(&path);
        drop(std::fs::remove_dir_all(&dir));

        assert!(reloaded.warnings.is_empty(), "{:?}", reloaded.warnings);
        assert_eq!(reloaded.bindings().len(), keymap.bindings().len());
        assert_eq!(reloaded.shortcuts().len(), keymap.shortcuts().len());
        assert!(reloaded.shortcuts().iter().any(|(n, _)| n == "wipe"));
    }

    #[test]
    fn a_file_with_no_shortcuts_section_simply_has_none() {
        let keymap = Keymap::parse("[normal]\n\"j\" = \"ui scroll down 1\"\n");
        assert!(keymap.warnings.is_empty(), "{:?}", keymap.warnings);
        assert!(keymap.shortcuts().is_empty());
    }

    #[test]
    fn a_file_replaces_the_defaults_rather_than_adding_to_them() {
        let keymap = Keymap::parse("[normal]\n\"q\" = \"ui quit\"\n");
        assert!(keymap.warnings.is_empty(), "{:?}", keymap.warnings);
        assert_eq!(keymap.bindings().len(), 1);
        assert!(
            keymap.lookup("j").is_none(),
            "a file with one binding should leave `j` unbound"
        );
    }

    #[test]
    fn a_bad_line_is_reported_and_the_rest_still_load() {
        let keymap =
            Keymap::parse("[normal]\n\"j\" = \"ui scroll down 1\"\n\"q\" = \"nonsense\"\n");
        assert!(keymap.lookup("j").is_some());
        assert!(keymap.lookup("q").is_none());
        assert_eq!(keymap.warnings.len(), 1);
        assert!(
            keymap
                .warnings
                .first()
                .is_some_and(|w| w.contains("nonsense")),
            "{:?}",
            keymap.warnings
        );
    }

    #[test]
    fn unparseable_toml_falls_back_to_the_defaults_and_says_so() {
        let keymap = Keymap::parse("[normal\nbroken");
        assert!(keymap.lookup("j").is_some(), "defaults should still work");
        assert!(
            keymap.warnings.iter().any(|w| w.contains("using defaults")),
            "{:?}",
            keymap.warnings
        );
    }

    #[test]
    fn what_is_saved_can_be_read_back() {
        let mut keymap = Keymap::default();
        keymap.bind("ctrl+g", "ui editor").unwrap();
        keymap.bind("+", "ui scroll up 1").unwrap();

        let dir = std::env::temp_dir().join(format!("shore-keymap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tui.toml");
        keymap.save_to(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        drop(std::fs::remove_dir_all(&dir));

        let reloaded = Keymap::parse(&text);
        assert!(reloaded.warnings.is_empty(), "{:?}", reloaded.warnings);
        assert_eq!(reloaded.bindings().len(), keymap.bindings().len());
        assert_eq!(reloaded.lookup("ctrl+g").unwrap().command, "ui editor");
        assert_eq!(reloaded.lookup("+").unwrap().command, "ui scroll up 1");
    }

    #[test]
    fn unbinding_reports_what_was_there() {
        let mut keymap = Keymap::default();
        assert_eq!(
            keymap.unbind("shift+t").unwrap().as_deref(),
            Some("view tools")
        );
        assert!(keymap.lookup("T").is_none());
        assert_eq!(keymap.unbind("q").unwrap(), None);
    }
}
