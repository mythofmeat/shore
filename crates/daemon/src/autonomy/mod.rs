pub mod activity;
pub mod heartbeat;
pub mod manager;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::warn;

/// Snapshot of autonomy subsystem state for the `status` command.
#[derive(Debug, Clone, Serialize)]
pub struct AutonomyStatus {
    /// Whether autonomy is paused.
    pub paused: bool,
    /// Current heartbeat state label.
    pub heartbeat_state: String,
    /// Consecutive heartbeat ticks without a user message.
    pub ticks_without_user: u32,
    /// Max idle ticks before going dormant.
    pub dormant_after_heartbeat_turns: u32,
    /// Effective heartbeat tick interval in seconds.
    pub effective_interval_secs: u64,
    /// Wall-clock time of the next scheduled wake (RFC3339), if scheduled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_wake_at: Option<String>,
    /// Seconds from now until the next wake (negative if overdue), if scheduled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds_until_wake: Option<i64>,
    /// Wall-clock time of the last user message (RFC3339), if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_user_at: Option<String>,
    /// Seconds since the last user message, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds_since_user: Option<i64>,
    /// Minimum gap between a user message and the next tick (seconds).
    pub minimum_heartbeat_latency_secs: u64,
    /// Wall-clock idle limit before the abandonment guard trips (seconds).
    pub dormant_after_idle_time_secs: u64,
    /// Most recent heartbeat events (oldest first), capped to a small count.
    #[serde(default)]
    pub recent_events: Vec<HeartbeatEvent>,
}

// ---------------------------------------------------------------------------
// Heartbeat event log
// ---------------------------------------------------------------------------

/// Maximum number of heartbeat events to keep in the ring buffer.
const HEARTBEAT_LOG_CAPACITY: usize = 100;

/// A single heartbeat event recorded by the autonomy manager.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatEvent {
    /// ISO 8601 timestamp.
    pub timestamp: String,
    /// Event kind label.
    pub kind: HeartbeatEventKind,
    /// Human-readable description.
    pub detail: String,
}

/// Categorised heartbeat event types.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeartbeatEventKind {
    /// A heartbeat tick fired.
    TickFired,
    /// Autonomous message was generated and sent.
    MessageSent,
    /// Character chose not to message the user.
    MessageSkipped,
    /// Tool use during heartbeat tick.
    ToolUse,
    /// Entered dormant state (max idle ticks reached).
    Dormant,
    /// Woke from dormant (user returned).
    Wake,
    /// Heartbeat tick was killed by the timeout guard.
    Timeout,
    /// Dormant bare ping sent to keep cache warm.
    DormantPing,
    /// Legacy heartbeat recap event retained for older logs.
    RecapWritten,
    /// Legacy heartbeat recap-missing event retained for older logs.
    RecapMissing,
}

impl std::fmt::Display for HeartbeatEventKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TickFired => write!(f, "tick_fired"),
            Self::MessageSent => write!(f, "message_sent"),
            Self::MessageSkipped => write!(f, "message_skipped"),
            Self::ToolUse => write!(f, "tool_use"),
            Self::Dormant => write!(f, "dormant"),
            Self::Wake => write!(f, "wake"),
            Self::Timeout => write!(f, "timeout"),
            Self::DormantPing => write!(f, "dormant_ping"),
            Self::RecapWritten => write!(f, "recap_written"),
            Self::RecapMissing => write!(f, "recap_missing"),
        }
    }
}

/// Ring buffer of heartbeat events with optional disk persistence.
///
/// `push` only mutates memory and flips a dirty bit. `flush_if_dirty` writes
/// the entire ring atomically via tmp+rename. Persistence is opt-in: a log
/// constructed with `new()` is purely in-memory (used by unit tests); a log
/// constructed with `with_path()` or `load_from()` writes to disk on flush.
#[derive(Debug, Clone)]
pub struct HeartbeatLog {
    events: VecDeque<HeartbeatEvent>,
    path: Option<PathBuf>,
    dirty: bool,
}

impl Default for HeartbeatLog {
    fn default() -> Self {
        Self::new()
    }
}

impl HeartbeatLog {
    /// In-memory-only log. Used by tests and as a fallback when a path is not
    /// available.
    pub fn new() -> Self {
        Self {
            events: VecDeque::with_capacity(HEARTBEAT_LOG_CAPACITY),
            path: None,
            dirty: false,
        }
    }

    /// Empty log bound to a disk path. Use this when the file does not yet
    /// exist; subsequent `flush_if_dirty` calls will create it.
    pub fn with_path(path: PathBuf) -> Self {
        Self {
            events: VecDeque::with_capacity(HEARTBEAT_LOG_CAPACITY),
            path: Some(path),
            dirty: false,
        }
    }

    /// Load events from a JSONL file at `path`, returning a log bound to that
    /// path. Malformed lines are skipped with a warning. The loaded log is
    /// not dirty (matches disk).
    ///
    /// Returns `None` if the file cannot be read (e.g. does not exist) — the
    /// caller should fall back to `with_path`.
    pub fn load_from(path: PathBuf) -> Option<Self> {
        let data = std::fs::read_to_string(&path).ok()?;
        let mut events: VecDeque<HeartbeatEvent> = VecDeque::with_capacity(HEARTBEAT_LOG_CAPACITY);
        for (idx, raw_line) in data.lines().enumerate() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<HeartbeatEvent>(line) {
                Ok(event) => {
                    if events.len() >= HEARTBEAT_LOG_CAPACITY {
                        let _ignored = events.pop_front();
                    }
                    events.push_back(event);
                }
                Err(e) => {
                    warn!(
                        path = %path.display(),
                        line = idx.saturating_add(1),
                        error = %e,
                        "Skipping malformed heartbeat log line"
                    );
                }
            }
        }
        Some(Self {
            events,
            path: Some(path),
            dirty: false,
        })
    }

    pub fn push<D: Into<String>>(&mut self, kind: HeartbeatEventKind, detail: D) {
        if self.events.len() >= HEARTBEAT_LOG_CAPACITY {
            let _ignored = self.events.pop_front();
        }
        self.events.push_back(HeartbeatEvent {
            timestamp: chrono::Local::now().to_rfc3339(),
            kind,
            detail: detail.into(),
        });
        self.dirty = true;
    }

    /// Return recent events, most recent last. `limit` caps the count.
    pub fn recent(&self, limit: usize) -> Vec<&HeartbeatEvent> {
        let start = self.events.len().saturating_sub(limit);
        self.events.range(start..).collect()
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Atomically rewrite the on-disk JSONL file from the in-memory ring.
    /// No-op if no path is set or the log is not dirty. Logs a warning on
    /// I/O failure but never panics.
    pub fn flush_if_dirty(&mut self) {
        if !self.dirty {
            return;
        }
        let Some(path) = self.path.clone() else {
            self.dirty = false;
            return;
        };
        if let Err(e) = self.write_atomic(&path) {
            warn!(
                path = %path.display(),
                error = %e,
                "Failed to flush heartbeat log"
            );
            return;
        }
        self.dirty = false;
    }

    fn write_atomic(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buf = String::with_capacity(self.events.len().saturating_mul(96));
        for event in &self.events {
            let line = serde_json::to_string(event)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            buf.push_str(&line);
            buf.push('\n');
        }
        let tmp = path.with_extension("jsonl.tmp");
        std::fs::write(&tmp, buf)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod heartbeat_log_tests {
    use super::*;

    fn item<T>(values: &[T], index: usize) -> &T {
        values.get(index).expect("value item")
    }

    #[test]
    fn push_marks_dirty_but_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat.jsonl");
        let mut log = HeartbeatLog::with_path(path.clone());
        log.push(HeartbeatEventKind::TickFired, "test");
        assert!(log.is_dirty(), "push should set dirty bit");
        assert!(!path.exists(), "push must not touch disk");
    }

    #[test]
    fn flush_writes_jsonl_and_clears_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat.jsonl");
        let mut log = HeartbeatLog::with_path(path.clone());
        log.push(HeartbeatEventKind::TickFired, "first");
        log.push(HeartbeatEventKind::MessageSent, "second");
        log.flush_if_dirty();
        assert!(!log.is_dirty());

        let contents = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(item(&lines, 0).contains("tick_fired"));
        assert!(item(&lines, 1).contains("message_sent"));
    }

    #[test]
    fn flush_is_noop_when_not_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat.jsonl");
        let mut log = HeartbeatLog::with_path(path.clone());
        log.flush_if_dirty();
        assert!(!path.exists());
    }

    #[test]
    fn load_from_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat.jsonl");
        let mut log = HeartbeatLog::with_path(path.clone());
        log.push(HeartbeatEventKind::TickFired, "a");
        log.push(HeartbeatEventKind::MessageSkipped, "b");
        log.flush_if_dirty();

        let loaded = HeartbeatLog::load_from(path).expect("load");
        assert!(!loaded.is_dirty());
        let events: Vec<_> = loaded.recent(10).into_iter().cloned().collect();
        assert_eq!(events.len(), 2);
        assert_eq!(item(&events, 0).detail, "a");
        assert_eq!(item(&events, 1).detail, "b");
    }

    #[test]
    fn load_from_skips_malformed_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat.jsonl");
        let good = serde_json::to_string(&HeartbeatEvent {
            timestamp: "2026-04-30T00:00:00+00:00".to_owned(),
            kind: HeartbeatEventKind::TickFired,
            detail: "ok".to_owned(),
        })
        .unwrap();
        let contents = format!("{good}\nnot json\n{good}\n");
        std::fs::write(&path, contents).unwrap();

        let loaded = HeartbeatLog::load_from(path).expect("load");
        assert_eq!(loaded.recent(10).len(), 2);
    }

    #[test]
    fn load_from_caps_at_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat.jsonl");
        let event = HeartbeatEvent {
            timestamp: "2026-04-30T00:00:00+00:00".to_owned(),
            kind: HeartbeatEventKind::TickFired,
            detail: "x".to_owned(),
        };
        let line = serde_json::to_string(&event).unwrap();
        let contents = (0..HEARTBEAT_LOG_CAPACITY.saturating_add(50))
            .map(|_| line.clone())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, contents).unwrap();

        let loaded = HeartbeatLog::load_from(path).expect("load");
        assert_eq!(loaded.recent(usize::MAX).len(), HEARTBEAT_LOG_CAPACITY);
    }

    #[test]
    fn flush_truncates_when_ring_smaller_than_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat.jsonl");
        // Write 5 events to disk, then load (so log is bound + matches disk)
        // and flush a fresh log of 1 event over the top. Disk should reflect
        // only the 1 event.
        let mut log = HeartbeatLog::with_path(path.clone());
        for i in 0..5 {
            log.push(HeartbeatEventKind::TickFired, format!("e{i}"));
        }
        log.flush_if_dirty();
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 5);

        let mut log2 = HeartbeatLog::with_path(path.clone());
        log2.push(HeartbeatEventKind::Wake, "fresh");
        log2.flush_if_dirty();
        let lines: Vec<_> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(String::from)
            .collect();
        assert_eq!(lines.len(), 1);
        assert!(item(&lines, 0).contains("wake"));
    }
}
