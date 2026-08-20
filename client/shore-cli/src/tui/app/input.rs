#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InputMode {
    Normal,
    Insert,
    Command,
}

pub(crate) struct InputState {
    pub text: String,
    pub cursor: usize,
    pub mode: InputMode,
    pub cmd_text: String,
    pub cmd_cursor: usize,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            text: String::new(),
            cursor: 0,
            mode: InputMode::Insert,
            cmd_text: String::new(),
            cmd_cursor: 0,
        }
    }
}

impl InputState {
    pub(crate) fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor, c);
        self.cursor = self.cursor.saturating_add(c.len_utf8());
    }

    pub(crate) fn insert_newline(&mut self) {
        self.insert_char('\n');
    }

    pub(crate) fn insert_str(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor = self.cursor.saturating_add(s.len());
    }

    pub(crate) fn backspace(&mut self) {
        if self.cursor > 0 {
            let prev = self
                .text
                .get(..self.cursor)
                .unwrap_or_default()
                .char_indices()
                .next_back()
                .map_or(0, |(i, _)| i);
            drop(self.text.drain(prev..self.cursor));
            self.cursor = prev;
        }
    }

    pub(crate) fn delete(&mut self) {
        if self.cursor < self.text.len() {
            let next = self
                .text
                .get(self.cursor..)
                .unwrap_or_default()
                .char_indices()
                .nth(1)
                .map_or(self.text.len(), |(i, _)| self.cursor.saturating_add(i));
            drop(self.text.drain(self.cursor..next));
        }
    }

    pub(crate) fn backspace_word(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let before = self.text.get(..self.cursor).unwrap_or_default();
        let after_ws = before.trim_end_matches(|c: char| c.is_whitespace());
        let after_word = after_ws.trim_end_matches(|c: char| !c.is_whitespace());
        let new_cursor = after_word.len();
        drop(self.text.drain(new_cursor..self.cursor));
        self.cursor = new_cursor;
    }

    pub(crate) fn delete_word(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        let after = self.text.get(self.cursor..).unwrap_or_default();
        let after_ws = after.trim_start_matches(|c: char| c.is_whitespace());
        let after_word = after_ws.trim_start_matches(|c: char| !c.is_whitespace());
        let delete_len = after.len().saturating_sub(after_word.len());
        drop(
            self.text
                .drain(self.cursor..self.cursor.saturating_add(delete_len)),
        );
    }

    pub(crate) fn move_left(&mut self) {
        if self.cursor > 0 {
            self.cursor = self
                .text
                .get(..self.cursor)
                .unwrap_or_default()
                .char_indices()
                .next_back()
                .map_or(0, |(i, _)| i);
        }
    }

    pub(crate) fn move_right(&mut self) {
        if self.cursor < self.text.len() {
            self.cursor = self
                .text
                .get(self.cursor..)
                .unwrap_or_default()
                .char_indices()
                .nth(1)
                .map_or(self.text.len(), |(i, _)| self.cursor.saturating_add(i));
        }
    }

    pub(crate) fn move_home(&mut self) {
        let before = self.text.get(..self.cursor).unwrap_or_default();
        self.cursor = before.rfind('\n').map_or(0, |i| i.saturating_add(1));
    }

    pub(crate) fn move_end(&mut self) {
        let after = self.text.get(self.cursor..).unwrap_or_default();
        self.cursor = after
            .find('\n')
            .map_or(self.text.len(), |i| self.cursor.saturating_add(i));
    }

    pub(crate) fn take_text(&mut self) -> String {
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        text
    }

    pub(crate) fn set_text(&mut self, text: String) {
        self.cursor = text.len();
        self.text = text;
    }

    #[cfg(test)]
    pub(crate) fn line_count(&self) -> usize {
        self.text.lines().count().max(1)
    }

    pub(crate) fn visual_line_count(&self, content_width: usize) -> usize {
        let starts = word_wrap_offsets(&self.text, content_width);
        let count = starts.len();

        if content_width > 0 && count > 0 {
            let last_start = starts.last().copied().unwrap_or_default();
            let last_width: usize = self
                .text
                .get(last_start..)
                .unwrap_or_default()
                .chars()
                .take_while(|&c| c != '\n')
                .map(|c| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0))
                .sum();
            if last_width >= content_width {
                return count.saturating_add(1);
            }
        }

        count.max(1)
    }

    pub(crate) fn enter_command_mode(&mut self) {
        self.mode = InputMode::Command;
        self.cmd_text.clear();
        self.cmd_cursor = 0;
    }

    pub(crate) fn exit_command_mode(&mut self) {
        self.mode = InputMode::Normal;
        self.cmd_text.clear();
        self.cmd_cursor = 0;
    }

    pub(crate) fn cmd_insert_char(&mut self, c: char) {
        self.cmd_text.insert(self.cmd_cursor, c);
        self.cmd_cursor = self.cmd_cursor.saturating_add(c.len_utf8());
    }

    pub(crate) fn cmd_backspace(&mut self) {
        if self.cmd_cursor > 0 {
            let prev = self
                .cmd_text
                .get(..self.cmd_cursor)
                .unwrap_or_default()
                .char_indices()
                .next_back()
                .map_or(0, |(i, _)| i);
            drop(self.cmd_text.drain(prev..self.cmd_cursor));
            self.cmd_cursor = prev;
        }
    }

    pub(crate) fn take_cmd_text(&mut self) -> String {
        let text = std::mem::take(&mut self.cmd_text);
        self.cmd_cursor = 0;
        self.mode = InputMode::Normal;
        text
    }
}

pub(crate) fn word_wrap_offsets(text: &str, max_width: usize) -> Vec<usize> {
    let mut starts = vec![0_usize];

    if max_width == 0 {
        for (i, ch) in text.char_indices() {
            if ch == '\n' {
                starts.push(i.saturating_add(ch.len_utf8()));
            }
        }
        return starts;
    }

    let mut col: usize = 0;
    let mut last_space_after: Option<usize> = None;
    let mut col_at_space_after: usize = 0;

    for (i, ch) in text.char_indices() {
        if ch == '\n' {
            starts.push(i.saturating_add(ch.len_utf8()));
            col = 0;
            last_space_after = None;
            continue;
        }

        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);

        if col.saturating_add(w) > max_width {
            if ch == ' ' {
                starts.push(i.saturating_add(ch.len_utf8()));
                col = 0;
                last_space_after = None;
            } else if let Some(brk) = last_space_after {
                starts.push(brk);
                col = col.saturating_sub(col_at_space_after).saturating_add(w);
                last_space_after = None;
                for (j, c) in text.get(brk..i).unwrap_or_default().char_indices() {
                    if c == ' ' {
                        let after = brk.saturating_add(j).saturating_add(c.len_utf8());
                        last_space_after = Some(after);
                        col_at_space_after = text
                            .get(brk..after)
                            .unwrap_or_default()
                            .chars()
                            .map(|wrapped_char| {
                                unicode_width::UnicodeWidthChar::width(wrapped_char).unwrap_or(0)
                            })
                            .sum();
                    }
                }
            } else {
                starts.push(i);
                col = w;
                last_space_after = None;
            }
        } else {
            if ch == ' ' {
                last_space_after = Some(i.saturating_add(ch.len_utf8()));
                col_at_space_after = col.saturating_add(w);
            }
            col = col.saturating_add(w);
        }
    }

    starts
}

#[cfg(test)]
mod tests {
    use super::{InputState, word_wrap_offsets};

    #[test]
    fn unicode_editing_keeps_cursor_on_character_boundaries() {
        let mut input = InputState::default();
        input.insert_str("a界🙂b");

        assert_eq!(input.cursor, input.text.len());
        assert!(input.text.is_char_boundary(input.cursor));

        input.move_left();
        assert_eq!(input.text.get(input.cursor..), Some("b"));
        input.backspace();
        assert_eq!(input.text, "a界b");
        assert_eq!(input.text.get(input.cursor..), Some("b"));

        input.delete();
        assert_eq!(input.text, "a界");
        input.move_left();
        assert_eq!(input.text.get(input.cursor..), Some("界"));

        input.backspace();
        assert_eq!(input.text, "界");
        assert_eq!(input.cursor, 0);
        input.delete();
        assert!(input.text.is_empty());
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn unicode_wrap_offsets_are_character_boundaries() {
        let text = "a界🙂b";
        let offsets = word_wrap_offsets(text, 2);

        assert_eq!(offsets, vec![0, 1, 4, 8]);
        assert!(offsets.iter().all(|offset| text.is_char_boundary(*offset)));
    }
}
