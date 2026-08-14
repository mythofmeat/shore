#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotificationLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug)]
pub(crate) struct Notification {
    pub content: String,
    pub level: NotificationLevel,
    pub count: u32,
    pub created: std::time::Instant,
}

pub(crate) const NOTIFICATION_TTL: std::time::Duration = std::time::Duration::from_secs(5);
pub(crate) const MAX_NOTIFICATIONS: usize = 4;
pub(crate) const MAX_ERROR_LOG: usize = 200;
