use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

pub(crate) const RESERVED_KEYS: [&str; 3] = ["esc", ":", "ctrl+c"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    Global,
    Normal,
}

impl Scope {
    fn section(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Normal => "normal",
        }
    }
}

pub(crate) const DEFAULT_GLOBAL_KEYS: [(&str, &str); 3] = [
    ("alt+c", "ui cancel"),
    ("ctrl+q", "ui quit"),
    ("ctrl+v", "ui image paste"),
];

pub(crate) const DEFAULT_NORMAL_KEYS: [(&str, &str); 24] = [
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
    ("[", "ui segment older"),
    ("]", "ui segment newer"),
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
    ("O", "ui output"),
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
# [global] fires in every mode, including while you are typing, so keep it to
# keys with a modifier. [normal] fires only in normal mode.
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
    global: Vec<(String, Binding)>,
    normal: Vec<(String, Binding)>,
    shortcuts: Vec<(String, Binding)>,
    pub(crate) warnings: Vec<String>,
}

impl Default for Keymap {
    fn default() -> Self {
        let mut keymap = Self::empty();
        for (key, command) in DEFAULT_GLOBAL_KEYS {
            if let Err(problem) = keymap.bind(Scope::Global, key, command) {
                keymap.warnings.push(problem);
            }
        }
        for (key, command) in DEFAULT_NORMAL_KEYS {
            if let Err(problem) = keymap.bind(Scope::Normal, key, command) {
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

    fn empty() -> Self {
        Self {
            global: Vec::new(),
            normal: Vec::new(),
            shortcuts: Vec::new(),
            warnings: Vec::new(),
        }
    }

    pub(crate) fn parse(text: &str) -> Self {
        let mut keymap = Self::empty();

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

        for scope in [Scope::Global, Scope::Normal] {
            let Some(section) = table.get(scope.section()).and_then(toml::Value::as_table) else {
                if scope == Scope::Normal {
                    keymap
                        .warnings
                        .push("tui.toml has no [normal] section, so no key is bound".to_owned());
                }
                continue;
            };
            for (key, value) in section {
                let Some(command) = value.as_str() else {
                    keymap
                        .warnings
                        .push(format!("{key} is not bound to a command string"));
                    continue;
                };
                if let Err(problem) = keymap.bind(scope, key, command) {
                    keymap.warnings.push(problem);
                }
            }
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
        self.global
            .iter()
            .chain(self.normal.iter())
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

    pub(crate) fn bind(&mut self, scope: Scope, key: &str, command: &str) -> Result<(), String> {
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
        let list = self.list_mut(scope);
        match list.iter_mut().find(|(bound, _)| bound == &token) {
            Some((_, existing)) => *existing = binding,
            None => list.push((token, binding)),
        }
        Ok(())
    }

    pub(crate) fn unbind(&mut self, scope: Scope, key: &str) -> Result<Option<String>, String> {
        let token = canonical_key(key)?;
        let list = self.list_mut(scope);
        let Some(index) = list.iter().position(|(bound, _)| bound == &token) else {
            return Ok(None);
        };
        let (_, binding) = list.remove(index);
        Ok(Some(binding.written))
    }

    pub(crate) fn lookup(&self, scope: Scope, token: &str) -> Option<&Binding> {
        self.bindings(scope)
            .iter()
            .find(|(bound, _)| bound == token)
            .map(|(_, binding)| binding)
    }

    pub(crate) fn bindings(&self, scope: Scope) -> &[(String, Binding)] {
        match scope {
            Scope::Global => &self.global,
            Scope::Normal => &self.normal,
        }
    }

    fn list_mut(&mut self, scope: Scope) -> &mut Vec<(String, Binding)> {
        match scope {
            Scope::Global => &mut self.global,
            Scope::Normal => &mut self.normal,
        }
    }

    pub(crate) fn save_to(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = String::from(SEED_HEADER);
        for scope in [Scope::Global, Scope::Normal] {
            out.push_str(&format!("[{}]\n", scope.section()));
            for (key, binding) in self.bindings(scope) {
                out.push_str(&format!(
                    "{} = {}\n",
                    toml::Value::String(key.clone()),
                    toml::Value::String(binding.written.clone())
                ));
            }
            out.push('\n');
        }
        out.push_str("[shortcuts]\n");
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

    #[test]
    fn every_default_binding_parses() {
        let keymap = Keymap::default();
        assert!(
            keymap.warnings.is_empty(),
            "seeded defaults should all be valid: {:?}",
            keymap.warnings
        );
        assert_eq!(
            keymap.bindings(Scope::Normal).len(),
            DEFAULT_NORMAL_KEYS.len()
        );
    }

    #[test]
    fn reserved_keys_cannot_be_taken() {
        let mut keymap = Keymap::default();
        for key in ["esc", "escape", ":", "ctrl+c"] {
            let problem = keymap.bind(Scope::Normal, key, "msg regen").unwrap_err();
            assert!(
                problem.contains("cannot be bound"),
                "{key} should be reserved, got {problem}"
            );
        }
    }

    #[test]
    fn a_bad_line_is_reported_and_the_rest_still_load() {
        let keymap =
            Keymap::parse("[normal]\n\"j\" = \"ui scroll down 1\"\n\"q\" = \"nonsense\"\n");
        assert!(keymap.lookup(Scope::Normal, "j").is_some());
        assert!(keymap.lookup(Scope::Normal, "q").is_none());
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
        assert!(
            keymap.lookup(Scope::Normal, "j").is_some(),
            "defaults should still work"
        );
        assert!(
            keymap.warnings.iter().any(|w| w.contains("using defaults")),
            "{:?}",
            keymap.warnings
        );
    }
}
