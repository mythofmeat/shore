/// Severity of a transient notification toast. Drives the toast's color and
/// whether the message is recorded to the session error log that is flushed
/// to stderr on exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotificationLevel {
    Info,
    Warning,
    Error,
}

/// A transient, auto-dismissing notification rendered as a floating toast over
/// the conversation. Unlike `ConversationEntry::System`, toasts are never part
/// of the conversation log — they don't reflow it, persist, or get saved. They
/// carry ephemeral chatter (command acks, connection state, errors); genuine
/// requested output (model lists, memory dumps) stays a `System` entry.
#[derive(Clone, Debug)]
pub(crate) struct Notification {
    pub content: String,
    pub level: NotificationLevel,
    /// Count of consecutive identical toasts collapsed into this one.
    pub count: u32,
    /// When the toast was (re)raised; drives auto-expiry.
    pub created: std::time::Instant,
}

/// How long a toast stays on screen before auto-dismissing.
pub(crate) const NOTIFICATION_TTL: std::time::Duration = std::time::Duration::from_secs(5);
/// Maximum simultaneously-stacked toasts; older ones are dropped.
pub(crate) const MAX_NOTIFICATIONS: usize = 4;
/// Cap on retained error-log lines flushed to stderr on exit.
pub(crate) const MAX_ERROR_LOG: usize = 200;
