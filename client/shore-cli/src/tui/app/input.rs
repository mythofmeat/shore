#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InputMode {
    Normal,
    Insert,
    Command,
}

const UNDO_DEPTH: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EditKind {
    Insert,
    DeleteBack,
    DeleteForward,
}

#[derive(Clone, Debug)]
struct Snapshot {
    text: String,
    cursor: usize,
}

pub(crate) struct InputState {
    pub text: String,
    pub cursor: usize,
    pub mode: InputMode,
    pub cmd_text: String,
    pub cmd_cursor: usize,
    undo_stack: Vec<Snapshot>,
    redo_stack: Vec<Snapshot>,
    open_run: Option<(EditKind, usize)>,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            text: String::new(),
            cursor: 0,
            mode: InputMode::Insert,
            cmd_text: String::new(),
            cmd_cursor: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            open_run: None,
        }
    }
}

impl InputState {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            text: self.text.clone(),
            cursor: self.cursor,
        }
    }

    fn checkpoint(&mut self, kind: Option<EditKind>) {
        let continues_a_run = matches!(
            (kind, self.open_run),
            (Some(now), Some((started, at))) if now == started && at == self.cursor
        );
        if !continues_a_run {
            self.undo_stack.push(self.snapshot());
            if self.undo_stack.len() > UNDO_DEPTH {
                drop(self.undo_stack.remove(0));
            }
        }
        self.redo_stack.clear();
    }

    fn end_run(&mut self, kind: Option<EditKind>) {
        self.open_run = kind.map(|k| (k, self.cursor));
    }

    pub(crate) fn reset_history(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.open_run = None;
    }

    pub(crate) fn undo(&mut self) -> bool {
        let Some(previous) = self.undo_stack.pop() else {
            return false;
        };
        self.redo_stack.push(self.snapshot());
        self.restore(previous);
        true
    }

    pub(crate) fn redo(&mut self) -> bool {
        let Some(next) = self.redo_stack.pop() else {
            return false;
        };
        self.undo_stack.push(self.snapshot());
        self.restore(next);
        true
    }

    fn restore(&mut self, to: Snapshot) {
        self.text = to.text;
        self.cursor = to.cursor.min(self.text.len());
        while !self.text.is_char_boundary(self.cursor) {
            self.cursor = self.cursor.saturating_sub(1);
        }
        self.open_run = None;
    }

    pub(crate) fn insert_char(&mut self, c: char) {
        self.checkpoint(Some(EditKind::Insert));
        self.text.insert(self.cursor, c);
        self.cursor = self.cursor.saturating_add(c.len_utf8());
        self.end_run((!c.is_whitespace()).then_some(EditKind::Insert));
    }

    pub(crate) fn insert_newline(&mut self) {
        self.insert_char('\n');
    }

    pub(crate) fn insert_str(&mut self, s: &str) {
        self.checkpoint(None);
        self.text.insert_str(self.cursor, s);
        self.cursor = self.cursor.saturating_add(s.len());
        self.end_run(None);
    }

    fn char_before(text: &str, at: usize) -> Option<usize> {
        text.get(..at)
            .unwrap_or_default()
            .char_indices()
            .next_back()
            .map(|(i, _)| i)
    }

    fn char_after(text: &str, at: usize) -> Option<usize> {
        text.get(at..)
            .unwrap_or_default()
            .chars()
            .next()
            .map(|c| at.saturating_add(c.len_utf8()))
    }

    pub(crate) fn backspace(&mut self) {
        self.checkpoint(Some(EditKind::DeleteBack));
        if let Some(prev) = Self::char_before(&self.text, self.cursor) {
            drop(self.text.drain(prev..self.cursor));
            self.cursor = prev;
        }
        self.end_run(Some(EditKind::DeleteBack));
    }

    pub(crate) fn delete(&mut self) {
        self.checkpoint(Some(EditKind::DeleteForward));
        if let Some(next) = Self::char_after(&self.text, self.cursor) {
            drop(self.text.drain(self.cursor..next));
        }
        self.end_run(Some(EditKind::DeleteForward));
    }

    pub(crate) fn backspace_word(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.checkpoint(None);
        self.end_run(None);
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
        self.checkpoint(None);
        self.end_run(None);
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
        if let Some(prev) = Self::char_before(&self.text, self.cursor) {
            self.cursor = prev;
        }
    }

    pub(crate) fn move_right(&mut self) {
        if let Some(next) = Self::char_after(&self.text, self.cursor) {
            self.cursor = next;
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
        self.checkpoint(None);
        self.end_run(None);
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        text
    }

    pub(crate) fn set_text(&mut self, text: String) {
        self.checkpoint(None);
        self.end_run(None);
        self.cursor = text.len();
        self.text = text;
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
        if let Some(prev) = Self::char_before(&self.cmd_text, self.cmd_cursor) {
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
    use super::{InputMode, InputState, word_wrap_offsets};

    fn typed(text: &str) -> InputState {
        let mut input = InputState::default();
        for c in text.chars() {
            input.insert_char(c);
        }
        input
    }

    fn state(input: &InputState) -> (&str, usize) {
        (input.text.as_str(), input.cursor)
    }

    #[test]
    fn typing_puts_each_character_at_the_cursor() {
        let mut input = typed("helo");
        assert_eq!(state(&input), ("helo", 4));
        input.move_left();
        input.insert_char('l');
        assert_eq!(state(&input), ("hello", 4));
        input.insert_newline();
        assert_eq!(state(&input), ("hell\no", 5));
    }

    #[test]
    fn undo_takes_back_a_word_at_a_time_and_redo_puts_it_back() {
        let mut input = typed("hello world");
        assert!(input.undo());
        assert_eq!(state(&input), ("hello ", 6));
        assert!(input.undo());
        assert_eq!(state(&input), ("", 0));
        assert!(!input.undo(), "nothing is left to undo");
        assert!(input.redo());
        assert_eq!(state(&input), ("hello ", 6));
        assert!(input.redo());
        assert_eq!(state(&input), ("hello world", 11));
        assert!(!input.redo(), "nothing is left to redo");
    }

    #[test]
    fn moving_the_cursor_or_switching_between_typing_and_deleting_starts_a_new_undo_step() {
        let mut input = typed("ab");
        input.move_left();
        input.insert_char('x');
        assert!(input.undo());
        assert_eq!(input.text, "ab");

        let mut deleting = typed("hello world");
        deleting.backspace();
        deleting.backspace();
        deleting.insert_char('k');
        assert!(deleting.undo());
        assert_eq!(deleting.text, "hello wor");
        assert!(deleting.undo());
        assert_eq!(deleting.text, "hello world");
        deleting.move_home();
        deleting.delete();
        deleting.delete();
        assert_eq!(state(&deleting), ("llo world", 0));
        assert!(deleting.undo());
        assert_eq!(deleting.text, "hello world");
    }

    #[test]
    fn a_new_edit_after_undo_drops_what_could_have_been_redone() {
        let mut input = typed("ab ");
        input.insert_char('c');
        assert!(input.undo());
        input.insert_char('d');
        assert!(!input.redo());
        assert_eq!(input.text, "ab d");
    }

    #[test]
    fn deleting_or_moving_past_either_end_changes_nothing() {
        let mut input = InputState::default();
        input.backspace();
        input.delete();
        input.move_left();
        input.move_right();
        assert_eq!(state(&input), ("", 0));
        input.insert_str("ab");
        input.move_right();
        input.delete();
        assert_eq!(state(&input), ("ab", 2));
        input.move_home();
        input.move_left();
        input.backspace();
        assert_eq!(state(&input), ("ab", 0));
        input.move_right();
        assert_eq!(input.cursor, 1);
        input.move_right();
        assert_eq!(input.cursor, 2);
    }

    #[test]
    fn word_deletes_take_a_word_with_the_spaces_beside_it_and_undo_as_one_step() {
        let mut input = InputState::default();
        input.insert_str("one two  three");
        input.backspace_word();
        assert_eq!(state(&input), ("one two  ", 9));
        input.backspace_word();
        assert_eq!(state(&input), ("one ", 4));
        assert!(input.undo());
        assert_eq!(input.text, "one two  ");
        input.move_home();
        input.delete_word();
        assert_eq!(state(&input), (" two  ", 0));
        input.delete_word();
        assert_eq!(state(&input), ("  ", 0));
        assert!(input.undo());
        assert_eq!(input.text, " two  ");
    }

    #[test]
    fn a_word_delete_with_nothing_to_delete_leaves_no_undo_step() {
        let mut at_start = typed("ab");
        at_start.move_home();
        at_start.backspace_word();
        assert!(at_start.undo());
        assert_eq!(at_start.text, "", "the typing is what gets undone");

        let mut at_end = typed("ab");
        at_end.delete_word();
        assert!(at_end.undo());
        assert_eq!(at_end.text, "", "the typing is what gets undone");
    }

    #[test]
    fn home_and_end_stay_on_the_current_line() {
        let mut input = InputState::default();
        input.insert_str("first\nsecond");
        input.move_home();
        assert_eq!(input.cursor, 6);
        input.move_end();
        assert_eq!(input.cursor, 12);
        input.cursor = 2;
        input.move_end();
        assert_eq!(input.cursor, 5);
        input.move_home();
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn taking_the_text_empties_the_box_and_can_be_undone() {
        let mut input = typed("draft");
        assert_eq!(input.take_text(), "draft");
        assert_eq!(state(&input), ("", 0));
        assert!(input.undo());
        assert_eq!(state(&input), ("draft", 5));
    }

    #[test]
    fn setting_the_text_puts_the_cursor_at_its_end_and_forgetting_history_stops_undo() {
        let mut input = typed("old");
        input.set_text("new text".to_owned());
        assert_eq!(state(&input), ("new text", 8));
        assert!(input.undo());
        assert_eq!(input.text, "old");
        input.reset_history();
        assert!(!input.undo());
        assert!(!input.redo());
    }

    #[test]
    fn the_command_line_edits_on_its_own_and_hands_back_what_was_typed() {
        let mut input = typed("draft");
        input.cmd_text = "left over".to_owned();
        input.cmd_cursor = 9;
        input.enter_command_mode();
        assert_eq!(input.mode, InputMode::Command);
        assert_eq!((input.cmd_text.as_str(), input.cmd_cursor), ("", 0));
        for c in "qu!t".chars() {
            input.cmd_insert_char(c);
        }
        input.cmd_backspace();
        input.cmd_backspace();
        input.cmd_insert_char('i');
        input.cmd_insert_char('t');
        assert_eq!((input.cmd_text.as_str(), input.cmd_cursor), ("quit", 4));
        assert_eq!(input.take_cmd_text(), "quit");
        assert_eq!(input.mode, InputMode::Normal);
        assert_eq!((input.cmd_text.as_str(), input.cmd_cursor), ("", 0));
        assert_eq!(input.text, "draft");

        input.enter_command_mode();
        input.cmd_insert_char('界');
        assert_eq!(input.cmd_cursor, 3);
        input.cmd_backspace();
        input.cmd_backspace();
        assert_eq!((input.cmd_text.as_str(), input.cmd_cursor), ("", 0));
        input.cmd_insert_char('x');
        input.exit_command_mode();
        assert_eq!(input.mode, InputMode::Normal);
        assert_eq!((input.cmd_text.as_str(), input.cmd_cursor), ("", 0));
    }

    #[test]
    fn the_box_grows_a_line_when_its_last_line_is_full() {
        let mut input = InputState::default();
        assert_eq!(input.visual_line_count(10), 1);
        input.insert_str("abcd");
        assert_eq!(input.visual_line_count(10), 1);
        assert_eq!(
            input.visual_line_count(4),
            2,
            "a full line leaves room for the cursor"
        );
        assert_eq!(input.visual_line_count(3), 2);
        assert_eq!(input.visual_line_count(0), 1);
        input.insert_str("\nxy");
        assert_eq!(input.visual_line_count(0), 2);
        assert_eq!(input.visual_line_count(10), 2);
    }

    #[test]
    fn wrapping_breaks_after_the_last_space_that_fits() {
        assert_eq!(word_wrap_offsets("hello world", 8), vec![0, 6]);
        assert_eq!(
            word_wrap_offsets("abcd", 4),
            vec![0],
            "a word that just fits stays on its line"
        );
        assert_eq!(
            word_wrap_offsets("abcdefghij", 4),
            vec![0, 4, 8],
            "a word longer than the line is cut"
        );
        assert_eq!(word_wrap_offsets("ab cdefghijk", 4), vec![0, 3, 7, 11]);
        assert_eq!(word_wrap_offsets("abcd efgh", 4), vec![0, 5]);
        assert_eq!(word_wrap_offsets("ab\ncd ef", 0), vec![0, 3]);
        assert_eq!(word_wrap_offsets("ab\ncd ef", 4), vec![0, 3, 6]);
    }

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
    fn the_undo_history_is_bounded() {
        let mut input = InputState::default();
        for n in 0_usize..super::UNDO_DEPTH.saturating_add(50) {
            input.insert_str(&n.to_string());
        }
        assert_eq!(input.undo_stack.len(), super::UNDO_DEPTH);
        while input.undo() {}
        assert!(!input.text.is_empty(), "the oldest states have aged out");
    }

    #[test]
    fn undo_lands_the_cursor_on_a_character_boundary() {
        let mut input = InputState::default();
        input.insert_str("a界🙂b");
        input.set_text("x".to_owned());

        assert!(input.undo());
        assert_eq!(input.text, "a界🙂b");
        assert!(input.text.is_char_boundary(input.cursor));
    }

    #[test]
    fn unicode_wrap_offsets_are_character_boundaries() {
        let text = "a界🙂b";
        let offsets = word_wrap_offsets(text, 2);

        assert_eq!(offsets, vec![0, 1, 4, 8]);
        assert!(offsets.iter().all(|offset| text.is_char_boundary(*offset)));
    }
}
