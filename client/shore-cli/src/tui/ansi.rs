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

    #[test]
    fn cursor_moves_and_other_sequences_are_dropped_without_eating_text() {
        let lines = to_lines("before\u{1b}[2K\u{1b}[1;3Hafter");
        assert_eq!(text_of(&lines), vec!["beforeafter"]);
    }
}
