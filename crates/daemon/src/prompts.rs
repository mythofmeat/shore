//! Compile-time prompt loading.
//!
//! All hand-authored prompts (system templates, compaction, dreaming librarian,
//! tool descriptions) live as plain `.md` files under `crates/daemon/prompts/`
//! and are pulled in at compile time via the `include_prompt!` macro.
//!
//! ## Why a wrapper around `include_str!`
//!
//! The Anthropic prompt cache hashes the exact bytes of each system block. The
//! original inline `r#"..."#` literals did not end in `\n`, but most editors
//! append a trailing newline when saving a file. `include_prompt!` strips a
//! single trailing `\n` at compile time so prompt bytes stay byte-identical
//! whether the source is an inline literal or an included file.
//!
//! Line endings are pinned to LF via `.gitattributes` so a Windows checkout or
//! `core.autocrlf=true` cannot silently change cache keys.

/// Strip a single trailing `\n` from a string at compile time.
///
/// `include_str!` returns the file's bytes verbatim; this normalizes the common
/// "editor added a final newline" case so our cache-key bytes match the
/// pre-extraction inline literals.
pub const fn trim_trailing_newline(s: &'static str) -> &'static str {
    match s.as_bytes() {
        [prefix @ .., b'\n'] => s.split_at(prefix.len()).0,
        _ => s,
    }
}

/// Include a prompt file at compile time, stripping any trailing newline.
///
/// Use this instead of `include_str!` for any markdown prompt file under
/// `crates/daemon/prompts/`. The path is relative to the calling `.rs` file,
/// matching `include_str!` semantics.
#[macro_export]
macro_rules! include_prompt {
    ($path:literal) => {{
        const RAW: &str = include_str!($path);
        const STRIPPED: &str = $crate::prompts::trim_trailing_newline(RAW);
        STRIPPED
    }};
}

#[cfg(test)]
mod tests {
    use super::trim_trailing_newline;

    #[test]
    fn strips_single_trailing_newline() {
        assert_eq!(trim_trailing_newline("hello\n"), "hello");
    }

    #[test]
    fn leaves_string_without_trailing_newline_alone() {
        assert_eq!(trim_trailing_newline("hello"), "hello");
    }

    #[test]
    fn strips_only_one_newline() {
        assert_eq!(trim_trailing_newline("hello\n\n"), "hello\n");
    }

    #[test]
    fn handles_empty_string() {
        assert_eq!(trim_trailing_newline(""), "");
    }

    #[test]
    fn preserves_interior_newlines() {
        assert_eq!(trim_trailing_newline("a\nb\nc\n"), "a\nb\nc");
    }
}
