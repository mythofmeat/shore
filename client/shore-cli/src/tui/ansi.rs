use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

#[derive(Clone, Copy, Default)]
struct Pen {
    foreground: Option<Color>,
    background: Option<Color>,
    modifiers: Modifier,
}

impl Pen {
    fn style(self) -> Style {
        let mut style = Style::default().add_modifier(self.modifiers);
        if let Some(color) = self.foreground {
            style = style.fg(color);
        }
        if let Some(color) = self.background {
            style = style.bg(color);
        }
        style
    }

    fn apply(&mut self, parameters: &[u16]) {
        let mut index = 0;
        while let Some(&parameter) = parameters.get(index) {
            index = index.saturating_add(1);
            match parameter {
                0 => *self = Self::default(),
                1 => self.modifiers.insert(Modifier::BOLD),
                2 => self.modifiers.insert(Modifier::DIM),
                3 => self.modifiers.insert(Modifier::ITALIC),
                4 => self.modifiers.insert(Modifier::UNDERLINED),
                7 => self.modifiers.insert(Modifier::REVERSED),
                9 => self.modifiers.insert(Modifier::CROSSED_OUT),
                22 => self.modifiers.remove(Modifier::BOLD | Modifier::DIM),
                23 => self.modifiers.remove(Modifier::ITALIC),
                24 => self.modifiers.remove(Modifier::UNDERLINED),
                27 => self.modifiers.remove(Modifier::REVERSED),
                29 => self.modifiers.remove(Modifier::CROSSED_OUT),
                30..=37 => self.foreground = basic_color(parameter.saturating_sub(30), false),
                90..=97 => self.foreground = basic_color(parameter.saturating_sub(90), true),
                40..=47 => self.background = basic_color(parameter.saturating_sub(40), false),
                100..=107 => self.background = basic_color(parameter.saturating_sub(100), true),
                39 => self.foreground = None,
                49 => self.background = None,
                38 | 48 => {
                    let (color, consumed) = extended_color(parameters.get(index..).unwrap_or(&[]));
                    if parameter == 38 {
                        self.foreground = color;
                    } else {
                        self.background = color;
                    }
                    index = index.saturating_add(consumed);
                }
                _ => {}
            }
        }
    }
}

fn basic_color(offset: u16, bright: bool) -> Option<Color> {
    Some(match (offset, bright) {
        (0, false) => Color::Black,
        (1, false) => Color::Red,
        (2, false) => Color::Green,
        (3, false) => Color::Yellow,
        (4, false) => Color::Blue,
        (5, false) => Color::Magenta,
        (6, false) => Color::Cyan,
        (7, false) => Color::Gray,
        (0, true) => Color::DarkGray,
        (1, true) => Color::LightRed,
        (2, true) => Color::LightGreen,
        (3, true) => Color::LightYellow,
        (4, true) => Color::LightBlue,
        (5, true) => Color::LightMagenta,
        (6, true) => Color::LightCyan,
        (7, true) => Color::White,
        _ => return None,
    })
}

fn extended_color(rest: &[u16]) -> (Option<Color>, usize) {
    match rest.first() {
        Some(&5) => (rest.get(1).map(|&n| Color::Indexed(to_u8(n))), 2),
        Some(&2) => {
            let channel = |at: usize| rest.get(at).map(|&value| to_u8(value));
            match (channel(1), channel(2), channel(3)) {
                (Some(r), Some(g), Some(b)) => (Some(Color::Rgb(r, g, b)), 4),
                _ => (None, rest.len()),
            }
        }
        _ => (None, 1),
    }
}

fn to_u8(value: u16) -> u8 {
    u8::try_from(value).unwrap_or(u8::MAX)
}

pub(crate) fn to_lines(text: &str) -> Vec<Line<'static>> {
    let mut pen = Pen::default();
    text.lines()
        .map(|line| {
            let mut spans: Vec<Span<'static>> = Vec::new();
            let mut pending = String::new();
            let mut chars = line.chars().peekable();

            while let Some(character) = chars.next() {
                if character != '\u{1b}' {
                    pending.push(character);
                    continue;
                }
                if chars.next_if_eq(&'[').is_none() {
                    continue;
                }

                let mut body = String::new();
                let mut final_byte = None;
                for candidate in chars.by_ref() {
                    if candidate.is_ascii_alphabetic() {
                        final_byte = Some(candidate);
                        break;
                    }
                    body.push(candidate);
                }

                if final_byte != Some('m') {
                    continue;
                }
                if !pending.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut pending), pen.style()));
                }
                let parameters: Vec<u16> = if body.is_empty() {
                    vec![0]
                } else {
                    body.split(';')
                        .map(|part| part.parse::<u16>().unwrap_or_default())
                        .collect()
                };
                pen.apply(&parameters);
            }

            if !pending.is_empty() {
                spans.push(Span::styled(pending, pen.style()));
            }
            Line::from(spans)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect()
    }

    fn styles_of(lines: &[Line<'static>]) -> Vec<Vec<(String, Style)>> {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| (span.content.to_string(), span.style))
                    .collect()
            })
            .collect()
    }

    fn style_after(sequence: &str) -> Style {
        to_lines(&format!("{sequence}x"))
            .first()
            .and_then(|line| line.spans.first())
            .map(|span| span.style)
            .unwrap()
    }

    #[test]
    fn cursor_moves_and_other_sequences_are_dropped_without_eating_text() {
        let lines = to_lines("before\u{1b}[2K\u{1b}[1;3Hafter");
        assert_eq!(text_of(&lines), vec!["beforeafter"]);
        assert_eq!(
            styles_of(&lines),
            vec![vec![("beforeafter".to_owned(), Style::default())]]
        );
        assert_eq!(text_of(&to_lines("a\u{1b}xb")), vec!["axb"]);
    }

    #[test]
    fn each_run_of_text_keeps_the_style_it_was_written_in_across_lines() {
        let red = Style::default().fg(Color::Red);
        assert_eq!(
            styles_of(&to_lines("a\u{1b}[31mb\nc\u{1b}[0md")),
            vec![
                vec![("a".to_owned(), Style::default()), ("b".to_owned(), red)],
                vec![("c".to_owned(), red), ("d".to_owned(), Style::default())],
            ]
        );
    }

    #[test]
    fn select_graphic_rendition_codes_become_terminal_styles() {
        let plain = Style::default();
        let with = |modifier: Modifier| plain.add_modifier(modifier);
        let mut cases: Vec<(String, Style)> = vec![
            ("1".into(), with(Modifier::BOLD)),
            ("2".into(), with(Modifier::DIM)),
            ("3".into(), with(Modifier::ITALIC)),
            ("4".into(), with(Modifier::UNDERLINED)),
            ("7".into(), with(Modifier::REVERSED)),
            ("9".into(), with(Modifier::CROSSED_OUT)),
            ("1;2;22".into(), plain),
            ("3;23".into(), plain),
            ("4;24".into(), plain),
            ("7;27".into(), plain),
            ("9;29".into(), plain),
            ("1;3;0".into(), plain),
            (";1".into(), with(Modifier::BOLD)),
            ("31;39".into(), plain),
            ("41;49".into(), plain),
            ("99".into(), plain),
            ("38;5;208".into(), plain.fg(Color::Indexed(208))),
            ("48;5;17".into(), plain.bg(Color::Indexed(17))),
            ("38;5;999".into(), plain.fg(Color::Indexed(255))),
            ("38;2;10;20;30".into(), plain.fg(Color::Rgb(10, 20, 30))),
            ("48;2;1;2;3".into(), plain.bg(Color::Rgb(1, 2, 3))),
            ("38;2;300;20;30".into(), plain.fg(Color::Rgb(255, 20, 30))),
            (
                "38;5;208;1".into(),
                with(Modifier::BOLD).fg(Color::Indexed(208)),
            ),
            (
                "38;2;1;2;3;4".into(),
                with(Modifier::UNDERLINED).fg(Color::Rgb(1, 2, 3)),
            ),
            ("31;38;2;1;2".into(), plain),
            ("38;9;1".into(), with(Modifier::BOLD)),
            ("31;1".into(), with(Modifier::BOLD).fg(Color::Red)),
        ];
        let colors = [
            (Color::Black, Color::DarkGray),
            (Color::Red, Color::LightRed),
            (Color::Green, Color::LightGreen),
            (Color::Yellow, Color::LightYellow),
            (Color::Blue, Color::LightBlue),
            (Color::Magenta, Color::LightMagenta),
            (Color::Cyan, Color::LightCyan),
            (Color::Gray, Color::White),
        ];
        for (offset, (basic, bright)) in (0_u16..).zip(colors) {
            cases.push((format!("{}", offset.saturating_add(30)), plain.fg(basic)));
            cases.push((format!("{}", offset.saturating_add(40)), plain.bg(basic)));
            cases.push((format!("{}", offset.saturating_add(90)), plain.fg(bright)));
            cases.push((format!("{}", offset.saturating_add(100)), plain.bg(bright)));
        }
        for (parameters, expected) in cases {
            assert_eq!(
                style_after(&format!("\u{1b}[{parameters}m")),
                expected,
                "ESC[{parameters}m"
            );
        }
        assert_eq!(style_after("\u{1b}[1m\u{1b}[m"), plain, "ESC[m resets");
    }
}
