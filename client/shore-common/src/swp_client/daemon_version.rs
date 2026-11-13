use std::sync::{PoisonError, RwLock};

static DAEMON_VERSION: RwLock<Option<String>> = RwLock::new(None);

pub(crate) fn note_daemon_version(version: Option<&str>) {
    *DAEMON_VERSION
        .write()
        .unwrap_or_else(PoisonError::into_inner) = version.map(str::to_owned);
}

pub fn daemon_version() -> Option<String> {
    DAEMON_VERSION
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}
