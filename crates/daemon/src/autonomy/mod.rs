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
        self.push_at(kind, detail, chrono::Local::now().to_rfc3339());
    }

    /// Push with an explicit timestamp, so the ring's behaviour can be recorded
    /// without the clock in it.
    pub fn push_at<D: Into<String>>(
        &mut self,
        kind: HeartbeatEventKind,
        detail: D,
        timestamp: String,
    ) {
        if self.events.len() >= HEARTBEAT_LOG_CAPACITY {
            let _ignored = self.events.pop_front();
        }
        self.events.push_back(HeartbeatEvent {
            timestamp,
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
    fn a_failed_flush_leaves_the_log_dirty_so_the_next_one_retries() {
        // Clearing the bit on failure loses the events silently: nothing
        // errors, the tick loop sees a clean log, and the last hundred things
        // the character did are simply not there afterwards.
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();

        // A path *under* a regular file: every write to it fails with ENOTDIR.
        let mut log = HeartbeatLog::with_path(blocker.join("heartbeat.jsonl"));
        log.push_at(HeartbeatEventKind::Wake, "kept", stamp(0));
        log.flush_if_dirty();

        assert!(log.is_dirty(), "the events must survive to be retried");
        assert_eq!(log.recent(10).len(), 1);
    }

    #[test]
    fn pushing_past_capacity_drops_the_oldest() {
        // `load_from_caps_at_capacity` pins the same ceiling on the way in from
        // disk, but nothing pinned it on `push` — so the ring could grow
        // without bound in a long-running daemon and only be trimmed on the
        // next restart.
        let mut log = HeartbeatLog::new();
        for i in 0..HEARTBEAT_LOG_CAPACITY.saturating_add(5) {
            log.push_at(HeartbeatEventKind::TickFired, format!("e{i}"), stamp(i));
        }

        let events = log.recent(usize::MAX);
        assert_eq!(events.len(), HEARTBEAT_LOG_CAPACITY);
        assert_eq!(item(&events, 0).detail, "e5", "the first five are gone");
        assert_eq!(
            item(&events, HEARTBEAT_LOG_CAPACITY.saturating_sub(1)).detail,
            format!("e{}", HEARTBEAT_LOG_CAPACITY.saturating_add(4)),
            "and the newest is last"
        );
    }

    #[test]
    fn recent_takes_the_newest_and_still_reads_oldest_first() {
        // The window is taken from the end but not reversed: `shore log` prints
        // these in the order they happened, and the limit is about how far back
        // to go, not which end to read from.
        let mut log = HeartbeatLog::new();
        for i in 0..10 {
            log.push_at(HeartbeatEventKind::TickFired, format!("e{i}"), stamp(i));
        }

        let last_three = log.recent(3);
        assert_eq!(last_three.len(), 3);
        assert_eq!(item(&last_three, 0).detail, "e7");
        assert_eq!(item(&last_three, 2).detail, "e9");

        assert_eq!(
            log.recent(100).len(),
            10,
            "a limit past the end is not an error"
        );
    }

    #[test]
    fn an_in_memory_log_clears_its_dirty_bit_without_a_file() {
        // Otherwise every flush on a path-less log stays dirty and rewrites
        // nothing forever — harmless but a lie, and the flag is what the tick
        // loop reads to decide whether to bother.
        let mut log = HeartbeatLog::new();
        log.push_at(HeartbeatEventKind::Wake, "hello", stamp(0));
        assert!(log.is_dirty());
        log.flush_if_dirty();
        assert!(!log.is_dirty());
    }

    /// A deterministic timestamp, so a ring's contents can be asserted on.
    fn stamp(i: usize) -> String {
        format!("2026-04-30T00:00:{:02}+00:00", i % 60)
    }

    /// One line per event kind, exactly as the daemon writes them.
    ///
    /// The kinds are `rename_all = "snake_case"`, so the wire name and the
    /// Rust name differ and can drift apart without any compiler complaining.
    /// `shore log --heartbeat` reads this file, so a TypeScript writer that
    /// spells a kind differently produces a log the CLI silently drops — the
    /// failure is a missing line, not an error.
    #[test]
    fn heartbeat_event_lines_match_shared_fixture() {
        let kinds = [
            HeartbeatEventKind::TickFired,
            HeartbeatEventKind::MessageSent,
            HeartbeatEventKind::MessageSkipped,
            HeartbeatEventKind::ToolUse,
            HeartbeatEventKind::Dormant,
            HeartbeatEventKind::Wake,
            HeartbeatEventKind::Timeout,
            HeartbeatEventKind::DormantPing,
            HeartbeatEventKind::RecapWritten,
            HeartbeatEventKind::RecapMissing,
        ];

        let mut log = HeartbeatLog::new();
        for (i, kind) in kinds.iter().enumerate() {
            log.push_at(*kind, format!("event {i}"), stamp(i));
        }

        let lines: Vec<String> = log
            .recent(usize::MAX)
            .into_iter()
            .map(|e| serde_json::to_string(e).expect("serialize"))
            .collect();

        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&serde_json::json!({
                "capacity": HEARTBEAT_LOG_CAPACITY,
                // Both spellings, so a rename that touches one and not the
                // other is caught rather than merely made inconsistent.
                "display_names": kinds.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "lines": lines,
            }))
            .expect("render")
        );

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/heartbeat_log_parity.json"
        );
        if std::env::var_os("SHORE_REGENERATE_FIXTURES").is_some() {
            std::fs::write(path, &rendered).expect("write fixture");
            return;
        }
        let on_disk = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            rendered, on_disk,
            "the heartbeat log's wire format changed. Anything already on a \
             user's disk was written in the old one."
        );
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
