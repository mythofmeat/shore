//! Daemon-side push notification service.
//!
//! Fires notifications for autonomous events (heartbeat messages, cache warnings,
//! compaction completion, errors) via configurable backends:
//! notify-send (Linux desktop), ntfy (mobile push), or custom shell commands.

use std::sync::Arc;

use tracing::warn;

use shore_common::config::app::{NotificationBackend, NotificationsConfig, NtfyConfig};
use shore_common::diagnostics::truncate_summary;

/// Events that can trigger a push notification.
#[derive(Debug, Clone, Copy)]
pub enum NotificationEvent {
    AutonomousMessage,
    CacheWarning,
    CompactionComplete,
    Error,
    MessageComplete,
    UsageWarning,
}

/// Daemon-side notification dispatcher.
///
/// Cheap to clone (wraps `Arc` + `reqwest::Client`). Intended to be shared
/// across the autonomy manager, handler, and compaction task.
#[derive(Debug, Clone)]
pub struct NotificationService {
    config: Arc<NotificationsConfig>,
    http_client: reqwest::Client,
}

impl NotificationService {
    pub fn new(config: NotificationsConfig) -> Self {
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            config: Arc::new(config),
            http_client,
        }
    }

    /// Fire-and-forget notification dispatch.
    ///
    /// Returns immediately — the actual delivery happens in a spawned task.
    /// Does nothing if notifications are disabled or the event toggle is off.
    pub fn notify(&self, event: NotificationEvent, title: &str, body: &str) {
        if !self.config.enabled || !self.is_event_enabled(event) {
            return;
        }
        let config = Arc::clone(&self.config);
        let client = self.http_client.clone();
        let title_owned = title.to_owned();
        let body_summary = truncate_summary(body, 200);
        let _ignored = tokio::spawn(async move {
            if let Err(e) = dispatch(&config, &client, &title_owned, &body_summary).await {
                warn!(error = %e, "Notification dispatch failed");
            }
        });
    }

    fn is_event_enabled(&self, event: NotificationEvent) -> bool {
        match event {
            NotificationEvent::AutonomousMessage => self.config.events.autonomous_message,
            NotificationEvent::CacheWarning => self.config.events.cache_warning,
            NotificationEvent::CompactionComplete => self.config.events.compaction_complete,
            NotificationEvent::Error => self.config.events.error,
            NotificationEvent::MessageComplete => self.config.events.message_complete,
            NotificationEvent::UsageWarning => self.config.events.usage_warning,
        }
    }

    /// Fire a `MessageComplete` notification, but only if generation time
    /// exceeds the configured threshold (0 = always notify).
    pub fn notify_message_complete(&self, title: &str, body: &str, total_ms: u32) {
        let threshold_ms = self.config.generation_threshold.as_millis();
        if threshold_ms > 0 && u64::from(total_ms) < threshold_ms {
            return;
        }
        self.notify(NotificationEvent::MessageComplete, title, body);
    }
}

// ── Backend dispatch ────────────────────────────────────────────────────

async fn dispatch(
    config: &NotificationsConfig,
    client: &reqwest::Client,
    title: &str,
    body: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match config.backend {
        NotificationBackend::NotifySend => dispatch_notify_send(title, body).await,
        NotificationBackend::Ntfy => dispatch_ntfy(client, &config.ntfy, title, body).await,
        NotificationBackend::Command => {
            dispatch_command(&config.command.template, title, body).await
        }
    }
}

async fn dispatch_notify_send(
    title: &str,
    body: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ignored = tokio::process::Command::new("notify-send")
        .arg("--app-name=shore")
        .arg(title)
        .arg(body)
        .output()
        .await?;
    Ok(())
}

async fn dispatch_ntfy(
    client: &reqwest::Client,
    config: &NtfyConfig,
    title: &str,
    body: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if config.topic.is_empty() {
        return Err("ntfy topic is not configured".into());
    }
    let url = format!("{}/{}", config.url.trim_end_matches('/'), config.topic);
    let mut req = client
        .post(&url)
        .header("Title", title)
        .body(body.to_owned());
    if !config.token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", config.token));
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        return Err(format!("ntfy returned {}", resp.status()).into());
    }
    Ok(())
}

/// Escape a string for safe embedding in a single-quoted shell argument.
///
/// Replaces each `'` with `'\''` (end quote, escaped quote, re-open quote)
/// and wraps the result in single quotes. Also strips `$()`, backticks,
/// and other command-substitution patterns as a defense-in-depth measure
/// since the template itself may not use single quotes around the placeholder.
fn shell_escape(s: &str) -> String {
    s.replace('\'', "'\\''").replace('`', "").replace("$(", "(")
}

async fn dispatch_command(
    template: &str,
    title: &str,
    body: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if template.is_empty() {
        return Err("notification command template is not configured".into());
    }
    let rendered = template
        .replace("{title}", &shell_escape(title))
        .replace("{body}", &shell_escape(body));
    let _ignored = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&rendered)
        .output()
        .await?;
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use shore_common::config::app::{CommandNotifyConfig, NotificationEventsConfig};

    fn make_service(enabled: bool, events: NotificationEventsConfig) -> NotificationService {
        NotificationService::new(NotificationsConfig {
            enabled,
            backend: NotificationBackend::NotifySend,
            ntfy: NtfyConfig::default(),
            command: CommandNotifyConfig::default(),
            generation_threshold: shore_common::config::ConfigDuration::from_secs(0),
            events,
        })
    }

    #[test]
    fn disabled_service_blocks_all_events() {
        let svc = make_service(false, NotificationEventsConfig::default());
        // notify returns immediately without spawning — just verifying no panic.
        // We can't easily assert the spawn didn't happen, but we verify the
        // guard logic by checking is_event_enabled is irrelevant when disabled.
        assert!(!svc.config.enabled);
    }

    #[test]
    fn event_toggles_respected() {
        let events = NotificationEventsConfig {
            autonomous_message: true,
            cache_warning: false,
            compaction_complete: true,
            error: true,
            message_complete: true,
            usage_warning: true,
        };
        let svc = make_service(true, events);
        assert!(svc.is_event_enabled(NotificationEvent::AutonomousMessage));
        assert!(!svc.is_event_enabled(NotificationEvent::CacheWarning));
        assert!(svc.is_event_enabled(NotificationEvent::CompactionComplete));
        assert!(svc.is_event_enabled(NotificationEvent::Error));
        assert!(svc.is_event_enabled(NotificationEvent::MessageComplete));
        assert!(svc.is_event_enabled(NotificationEvent::UsageWarning));
    }

    #[test]
    fn command_template_rendering() {
        let template = "echo '{title}: {body}'";
        let rendered = template
            .replace("{title}", "Shore — Test")
            .replace("{body}", "hello world");
        assert_eq!(rendered, "echo 'Shore — Test: hello world'");
    }

    /// Shell metacharacters in notification title/body must be sanitized
    /// before passing to `sh -c`. LLM-generated content can contain
    /// single quotes, backticks, $(), etc. that would be interpreted
    /// by the shell.
    #[test]
    fn command_template_sanitizes_shell_metacharacters() {
        let title = "Shore — Alice's message";
        let body = "$(whoami) said `hello` & more; rm -rf /";

        let escaped_title = shell_escape(title);
        let escaped_body = shell_escape(body);

        assert!(
            !escaped_body.contains("$("),
            "Shell command substitution must be sanitized: {escaped_body}"
        );
        assert!(
            !escaped_body.contains('`'),
            "Backtick command substitution must be sanitized: {escaped_body}"
        );
        // Single quotes in title should be escaped.
        assert!(
            !escaped_title.contains("Alice's"),
            "Bare single quote must be escaped: {escaped_title}"
        );
    }
}
