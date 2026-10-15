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
