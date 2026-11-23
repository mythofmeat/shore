use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    Kitty,
    Iterm2,
}

impl fmt::Display for ImageProtocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImageProtocol::Kitty => write!(f, "kitty"),
            ImageProtocol::Iterm2 => write!(f, "iterm2"),
        }
    }
}

fn has_env_prefix(prefix: &str) -> bool {
    std::env::vars().any(|(k, _)| k.starts_with(prefix))
}

pub fn detect_protocol() -> Option<ImageProtocol> {
    detect_protocol_from_env(
        std::env::var("SHORE_IMAGES").ok().as_deref(),
        std::env::var("TERM_PROGRAM").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
        has_env_prefix("GHOSTTY_"),
        std::env::var("KITTY_WINDOW_ID").ok().is_some(),
    )
}

pub fn detect_protocol_from_env(
    shore_images: Option<&str>,
    term_program: Option<&str>,
    term: Option<&str>,
    has_ghostty_env: bool,
    has_kitty_env: bool,
) -> Option<ImageProtocol> {
    if let Some(val) = shore_images {
        return match val.to_lowercase().as_str() {
            "kitty" => Some(ImageProtocol::Kitty),
            "iterm2" | "iterm" => Some(ImageProtocol::Iterm2),
            _ => None,
        };
    }

    if let Some(prog) = term_program {
        let lower = prog.to_lowercase();
        if lower.contains("iterm") {
            return Some(ImageProtocol::Iterm2);
        }
        if lower.contains("kitty") || lower.contains("ghostty") {
            return Some(ImageProtocol::Kitty);
        }
    }

    if has_ghostty_env || has_kitty_env {
        return Some(ImageProtocol::Kitty);
    }

    if let Some(t) = term {
        let lower = t.to_lowercase();
        if lower.contains("kitty") || lower.contains("ghostty") {
            return Some(ImageProtocol::Kitty);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shore_images_decides_and_otherwise_the_terminal_says_which_protocol_it_speaks() {
        let cases = [
            (
                (Some("KITTY"), None, None, false, false),
                Some(ImageProtocol::Kitty),
            ),
            (
                (Some("iterm"), None, None, false, false),
                Some(ImageProtocol::Iterm2),
            ),
            (
                (Some("iTerm2"), None, None, false, false),
                Some(ImageProtocol::Iterm2),
            ),
            ((Some("none"), Some("kitty"), None, true, true), None),
            (
                (None, Some("iTerm.app"), None, false, false),
                Some(ImageProtocol::Iterm2),
            ),
            (
                (None, Some("ghostty"), None, false, false),
                Some(ImageProtocol::Kitty),
            ),
            (
                (None, Some("Kitty"), None, false, false),
                Some(ImageProtocol::Kitty),
            ),
            (
                (None, Some("vscode"), None, true, false),
                Some(ImageProtocol::Kitty),
            ),
            ((None, None, None, false, true), Some(ImageProtocol::Kitty)),
            (
                (None, Some("vscode"), Some("xterm-Kitty"), false, false),
                Some(ImageProtocol::Kitty),
            ),
            (
                (None, None, Some("xterm-ghostty"), false, false),
                Some(ImageProtocol::Kitty),
            ),
            (
                (None, Some("vscode"), Some("xterm-256color"), false, false),
                None,
            ),
        ];
        for ((shore_images, program, term, ghostty, kitty), expected) in cases {
            assert_eq!(
                detect_protocol_from_env(shore_images, program, term, ghostty, kitty),
                expected,
                "SHORE_IMAGES={shore_images:?} TERM_PROGRAM={program:?} TERM={term:?} ghostty={ghostty} kitty={kitty}"
            );
        }
    }

    #[test]
    fn the_protocols_are_named_as_shore_images_spells_them() {
        assert_eq!(ImageProtocol::Kitty.to_string(), "kitty");
        assert_eq!(ImageProtocol::Iterm2.to_string(), "iterm2");
    }
}
