pub(crate) use shore_common::active_character::{
    clear_active_character, clear_active_thread, read_active_character, read_active_thread,
    write_active_character, write_active_thread,
};

pub(crate) fn resolve_display_character(
    daemon_selected: Option<&str>,
    requested: Option<&str>,
) -> String {
    daemon_selected
        .filter(|s| !s.is_empty())
        .or(requested.filter(|s| !s.is_empty()))
        .unwrap_or("Assistant")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_display_character_prefers_daemon_answer() {
        assert_eq!(
            resolve_display_character(Some("sable"), None),
            "sable".to_owned(),
        );
        assert_eq!(
            resolve_display_character(Some("sable"), Some("ignored")),
            "sable".to_owned(),
            "daemon answer must override a stale request",
        );
    }

    #[test]
    fn resolve_display_character_falls_back_to_request() {
        assert_eq!(
            resolve_display_character(None, Some("aria")),
            "aria".to_owned(),
        );
    }

    #[test]
    fn resolve_display_character_final_fallback() {
        assert_eq!(
            resolve_display_character(None, None),
            "Assistant".to_owned(),
        );
        assert_eq!(
            resolve_display_character(Some(""), Some("")),
            "Assistant".to_owned(),
            "empty strings should be treated as absent",
        );
    }
}
