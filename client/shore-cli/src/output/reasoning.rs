fn continues_the_line(first: char, second: Option<char>) -> bool {
    match first {
        ' ' => second.is_some_and(|c| !c.is_whitespace() && !matches!(c, '-' | '*' | '+')),
        ',' | '.' | ';' | ':' | '!' | '?' => second.is_none_or(char::is_whitespace),
        _ => false,
    }
}

fn looks_like_fragment_separator_stream(text: &str) -> bool {
    let mut long_breaks = 0_usize;
    let mut break_len = 0_usize;

    for c in text.chars() {
        if c == '\n' {
            break_len = break_len.saturating_add(1);
        } else {
            if break_len >= 3 {
                long_breaks = long_breaks.saturating_add(1);
            }
            break_len = 0;
        }
    }
    if break_len >= 3 {
        long_breaks = long_breaks.saturating_add(1);
    }

    let fragments = text.split('\n').filter(|line| !line.is_empty()).count();
    let short_fragments = text
        .split('\n')
        .filter(|line| !line.is_empty() && line.trim().chars().count() <= 24)
        .count();

    fragments >= 8
        && long_breaks >= 6
        && short_fragments.saturating_mul(4) >= fragments.saturating_mul(3)
        && long_breaks.saturating_mul(4) >= fragments
}

fn last_word_is_uppercase(text: &str) -> bool {
    let word: Vec<char> = text
        .trim_end_matches('.')
        .chars()
        .rev()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    word.iter().any(|c| c.is_alphabetic())
        && word
            .iter()
            .filter(|c| c.is_alphabetic())
            .all(|c| c.is_uppercase())
}

fn rejoin_fragment_separator_stream(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for fragment in text.split('\n').filter(|line| !line.is_empty()) {
        let first = fragment.chars().next();
        let prior = out.chars().next_back();
        let sentence_break = prior.is_some_and(|c| matches!(c, '.' | '!' | '?' | ';' | ':'));
        let filename_extension = prior == Some('.') && last_word_is_uppercase(&out);
        if !out.is_empty()
            && first.is_some_and(char::is_alphanumeric)
            && !prior.is_some_and(char::is_whitespace)
            && sentence_break
            && !filename_extension
        {
            out.push(' ');
        }
        out.push_str(fragment);
    }
    out
}

pub(crate) fn reflow_reasoning(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if looks_like_fragment_separator_stream(&normalized) {
        return rejoin_fragment_separator_stream(&normalized);
    }

    let mut out = String::with_capacity(text.len());
    let mut breaks = String::new();
    let mut chars = normalized.chars().peekable();
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
    fn dense_multi_newline_fragments_from_the_captured_failure_read_as_prose() {
        let captured = concat!(
            "the\n\n\n rules\n\n\n he\n\n\n cut\n\n\n were\n\n\n duplicates\n\n\n or\n\n\n now\n\n\n-unneeded\n\n\n.\n\n\n fine\n\n\n.\n\n\n",
            "one\n\n\n more\n\n\n observation\n\n\n: the\n\n\n doc\n\n\n comment\n\n\n at\n\n\n the\n\n\n top\n\n\n of\n\n\n MEMORY.\n\nmd",
            " says\n\n\n details\n\n\n live\n\n\n in\n\n\n memory\n\n\n/ files\n\n\n and\n\n\n the\n\n\n scratch\n\n\npad",
            " is\n\n\n thin\n\n\n pointers\n\n\n —\n\n\n and\n\n\n my\n\n\n old\n\n\n version\n\n\n had\n\n\n become"
        );

        assert_eq!(
            reflow_reasoning(captured),
            "the rules he cut were duplicates or now-unneeded. fine. one more observation: the doc comment at the top of MEMORY.md says details live in memory/ files and the scratchpad is thin pointers — and my old version had become"
        );
    }

    #[test]
    fn ordinary_short_paragraphs_are_not_mistaken_for_fragment_separators() {
        let prose = "one\n\ntwo\n\nthree\n\nfour\n\nfive\n\nsix\n\nseven";
        assert_eq!(reflow_reasoning(prose), prose);
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
