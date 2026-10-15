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
