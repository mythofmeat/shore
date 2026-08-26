fn continues_the_line(first: char, second: Option<char>) -> bool {
    match first {
        ' ' => second.is_some_and(|c| !c.is_whitespace() && !matches!(c, '-' | '*' | '+')),
        ',' | '.' | ';' | ':' | '!' | '?' => second.is_none_or(char::is_whitespace),
        _ => false,
    }
}

pub(crate) fn reflow_reasoning(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut breaks = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            breaks.push(c);
            continue;
        }
        if !breaks.is_empty() {
            if !continues_the_line(c, chars.peek().copied()) {
                out.push_str(&breaks);
            }
            breaks.clear();
        }
        out.push(c);
    }
    out.push_str(&breaks);
    out
}

pub(crate) fn settled_reasoning(text: &str) -> String {
    reflow_reasoning(text).trim_end_matches('\n').to_owned()
}

#[cfg(test)]
mod tests {
    use super::{reflow_reasoning, settled_reasoning};

    const SHREDDED: &str = "He's\n wrapping\n up\n,\n budget\n dying\n.\n Keep\n it\n SHORT\n.\n Don't\n burn\n tokens.";

    #[test]
    fn a_newline_between_every_word_reads_as_prose_again() {
        assert_eq!(
            reflow_reasoning(SHREDDED),
            "He's wrapping up, budget dying. Keep it SHORT. Don't burn tokens."
        );
    }

    #[test]
    fn a_paragraph_break_a_model_wrote_survives() {
        assert_eq!(
            reflow_reasoning("Weighing it up.\n\nSo: keep it short."),
            "Weighing it up.\n\nSo: keep it short."
        );
    }

    #[test]
    fn a_list_survives() {
        assert_eq!(
            reflow_reasoning("Two things:\n- first\n- second"),
            "Two things:\n- first\n- second"
        );
    }

    #[test]
    fn an_indented_block_survives() {
        assert_eq!(
            reflow_reasoning("check:\n  let x = 1;\n  let y = 2;"),
            "check:\n  let x = 1;\n  let y = 2;"
        );
    }

    #[test]
    fn a_line_break_before_a_capital_survives() {
        assert_eq!(
            reflow_reasoning("First point.\nSecond point."),
            "First point.\nSecond point."
        );
    }

    #[test]
    fn a_paragraph_that_opens_with_an_ellipsis_survives() {
        assert_eq!(
            reflow_reasoning("she's...\n\n...maybe losing her grip."),
            "she's...\n\n...maybe losing her grip."
        );
    }

    #[test]
    fn a_paragraph_that_opens_with_an_emoticon_survives() {
        assert_eq!(
            reflow_reasoning("getting in already.\n\n:3\n\nhmm."),
            "getting in already.\n\n:3\n\nhmm."
        );
    }

    #[test]
    fn a_nested_bullet_survives() {
        assert_eq!(
            reflow_reasoning("Stomping:\n - the Vans have the highest count"),
            "Stomping:\n - the Vans have the highest count"
        );
    }

    #[test]
    fn a_break_that_stranded_its_punctuation_is_closed_up() {
        assert_eq!(
            reflow_reasoning("crossing them\n\n, even when it reads as creepy"),
            "crossing them, even when it reads as creepy"
        );
    }

    #[test]
    fn prose_with_no_newlines_is_untouched() {
        assert_eq!(reflow_reasoning("just one line"), "just one line");
    }

    #[test]
    fn settled_drops_the_breaks_still_being_decided() {
        assert_eq!(settled_reasoning("done.\n\n"), "done.");
        assert_eq!(settled_reasoning("He's\n"), "He's");
    }
}
