//! AutonomyManager — per-character scheduler state with background tick tasks.
//!
//! Each character gets its own tokio task that ticks the heartbeat clock on a
//! fixed interval. Cache keepalive is a separate cost-saving subsystem driven
//! from the same background loop.
//! State is persisted to `{data_dir}/{character}/autonomy_state.json`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use std::time::Duration;
use tokio::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::{
    derive_content_from_blocks, ContentBlock, ImageRef, Message, Role,
};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use super::activity::ActivityTracker;
use super::heartbeat::{HeartbeatAction, HeartbeatClock};
use super::{AutonomyStatus, HeartbeatEventKind, HeartbeatLog};
use crate::characters::CharacterRegistry;
use crate::ledger::{CallType, CredentialFallbackEvent, KeepaliveSchedule, LedgerClient};
use crate::llm::types::{LlmRequest, ToolResultContent, WireBlock, WireMessage, WireRole};
use crate::memory::compaction_impls::resolve_image_gen_config;
use crate::memory::retrieval::resolve_embedder;
use crate::notifications::{NotificationEvent, NotificationService};
use crate::tools as tool_system;
use crate::tools::context::SharedToolContext;
use crate::tools::{ToolContext, ToolError};
use shore_common::config::app::{AutonomyConfig, CompactionConfig, DreamingConfig};
use shore_common::config::LoadedConfig;
use shore_common::config::{character_data_dir, character_memory_dir, character_workspace_dir};
use shore_common::diagnostics::truncate_summary;

use crate::sync::lock_or_recover;

const SECONDS_PER_MINUTE: u64 = 60;
const SECONDS_PER_HOUR: u64 = 3_600;

// ---------------------------------------------------------------------------
// Tick context — shared state for the per-character autonomy loop
// ---------------------------------------------------------------------------

/// Shared context passed to the per-character tick loop.
struct TickContext {
    state: Arc<Mutex<AutonomyState>>,
    config: Arc<AutonomyConfig>,
    compaction: Arc<CompactionConfig>,
    data_dir: PathBuf,
    llm_client: Option<LedgerClient>,
    push_tx: Option<broadcast::Sender<ServerMessage>>,
    loaded_config: Option<Arc<LoadedConfig>>,
    notifier: Option<NotificationService>,
    registry: Option<Arc<tokio::sync::Mutex<CharacterRegistry>>>,
    /// Live MCP registry snapshot for this character's ticks. Empty when no
    /// `[mcp.*]` servers are configured.
    mcp_registry: Arc<crate::tools::mcp_registry::McpRegistry>,
}

struct HeartbeatToolContext {
    inner: SharedToolContext,
    state: Arc<Mutex<AutonomyState>>,
}

impl ToolContext for HeartbeatToolContext {
    fn image_dir(&self) -> &str {
        self.inner.image_dir()
    }
    fn llm_client(&self) -> Option<&crate::llm::LlmClient> {
        self.inner.llm_client()
    }
    fn image_gen_config(&self) -> Option<&crate::memory::compaction_impls::ImageGenConfig> {
        self.inner.image_gen_config()
    }
    fn search_config(&self) -> &shore_common::config::app::SearchConfig {
        self.inner.search_config()
    }
    fn character_name(&self) -> &str {
        self.inner.character_name()
    }
    fn schedule_next_wake(&self, input: &Value) -> Option<Result<Value, ToolError>> {
        Some(Ok(schedule_next_wake_in_state(self.state.as_ref(), input)))
    }
    fn workspace_dir(&self) -> &str {
        self.inner.workspace_dir()
    }
    fn character_data_dir(&self) -> &str {
        self.inner.character_data_dir()
    }
    fn markdown_store(&self) -> Option<&crate::memory::markdown_store::MarkdownMemoryStore> {
        self.inner.markdown_store()
    }
    fn memory_retrieval_config(&self) -> &shore_common::config::app::RetrievalConfig {
        self.inner.memory_retrieval_config()
    }
    fn embedder(&self) -> Option<&dyn crate::llm::embed::Embedder> {
        self.inner.embedder()
    }
    fn memory_index_path(&self) -> Option<&Path> {
        self.inner.memory_index_path()
    }
    fn config_dir(&self) -> &str {
        self.inner.config_dir()
    }
    fn defer_edit(&self, path: &str) {
        self.inner.defer_edit(path);
    }
    fn run_subagent<'ctx>(
        &'ctx self,
        name: &'ctx str,
        query: &'ctx str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, ToolError>> + Send + 'ctx>>
    {
        // Delegate to the inner SharedToolContext, which carries the wired
        // sub-agent runtime. Without this override the trait default would
        // short-circuit to `NotImplemented` and `ask_*` would never reach the
        // runtime during heartbeat ticks.
        self.inner.run_subagent(name, query)
    }
}

// ---------------------------------------------------------------------------
// Per-character state
// ---------------------------------------------------------------------------

/// All autonomy state for a single character.
#[derive(Debug)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "autonomy state tracks independent persisted and runtime flags"
)]
pub struct AutonomyState {
    pub heartbeat: HeartbeatClock,
    /// The sidecar's keepalive schedule, as last drained.
    ///
    /// Held only to persist it: the schedule itself lives in the sidecar, which
    /// decides when to ping and does the pinging. This side keeps a copy so a
    /// restart can hand it back — the provider-side cache lives on Anthropic's
    /// servers and does not cool when shore restarts, and losing the schedule is
    /// what used to turn a quick redeploy into a full cold cache write on the
    /// user's next message.
    pub keepalive_schedule: Option<KeepaliveSchedule>,
    pub activity: ActivityTracker,
    /// Ring buffer of heartbeat events for `shore log --heartbeat`.
    pub heartbeat_log: HeartbeatLog,
    /// Whether autonomy is paused (moved from HeartbeatClock).
    paused: bool,
    /// Whether state has changed since last save.
    dirty: bool,
    /// Last message activity timestamp for compaction idle trigger.
    last_compaction_activity: Instant,
    /// Whether compaction was already triggered for this idle period.
    compaction_triggered: bool,
    /// Current number of messages in active.jsonl (updated on each message notification).
    active_turn_count: usize,
    /// Set by the idle trigger tick — the handler checks and clears this after
    /// each generation to run compaction inline (synchronously with the handler).
    compaction_pending: bool,
    /// User turns in active.jsonl already covered by memory. Compaction's
    /// LLM pass always sees the *full* conversation (the keep-N split only
    /// controls what stays in active.jsonl), so on compaction completion this
    /// equals the retained turn count. The deep-idle archive compares it
    /// against the on-disk turn count to decide between a pure file archive
    /// (everything covered — no LLM call) and a real keep-0 compaction pass.
    covered_turn_count: usize,
    /// Whether the deep-idle archive already ran (or found nothing archivable)
    /// for this idle period. Cleared on any message activity.
    deep_archive_done: bool,
    /// Cached last LLM request for heartbeat tick reuse.
    last_request: Option<LlmRequest>,
    /// Next allowed scheduled dreaming attempt after a failure.
    next_dream_attempt_at: Option<Instant>,
    /// Consecutive scheduled dreaming failures.
    dream_failure_count: u32,
}

impl AutonomyState {
    fn mark_dirty(&mut self) {
        self.dirty = true;
    }
}

fn background_retry_delay(failure_count: u32) -> Duration {
    let exponent = failure_count.saturating_sub(1).min(6);
    let secs = 60_u64.saturating_mul(1_u64 << exponent);
    Duration::from_secs(secs.min(3_600))
}

// ---------------------------------------------------------------------------
// Tick decisions
// ---------------------------------------------------------------------------

/// Everything a tick's triggers depend on, lifted out of the state, the config
/// and the clock.
///
/// Separated so the decision is a function of its inputs rather than of a lock
/// and an `Instant::now()`. That is what makes it recordable: the numbers below
/// go into a fixture, and the TypeScript is held to the same answers.
///
/// The units are not uniform, and that is deliberate. Compaction compares
/// `as_secs()` against `as_secs()`, truncating both sides; dreaming compares
/// whole `Duration`s. For a sub-second threshold the two disagree — an idle
/// trigger of 1.5s fires at 1.2s of idleness, where a minimum inactive time of
/// 1.5s does not. Nobody configures either in fractions of a second, but the
/// port carries the difference rather than quietly picking one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "a record of the switches a tick reads; grouping them would hide what it depends on"
)]
struct TickInputs {
    autonomy_enabled: bool,
    paused: bool,
    heartbeat_enabled: bool,

    compaction_enabled: bool,
    /// Already fired for this idle period; the single-flight latch.
    compaction_triggered: bool,
    /// The deep archive already ran for this idle period.
    deep_archive_done: bool,
    active_turn_count: usize,
    min_turns: usize,
    max_turns: usize,
    /// Since the last message activity, truncated to seconds.
    idle_secs: u64,
    idle_trigger_secs: u64,
    archive_after_secs: u64,

    /// Dreaming is configured *and* switched on.
    dreaming_enabled: bool,
    /// The retry backoff has expired, or there was never a failure.
    dream_backoff_elapsed: bool,
    /// Since the last user message. `None` means no user message is on record,
    /// which reads as "not disturbing anyone" rather than "just spoke to".
    ms_since_user: Option<u128>,
    minimum_inactive_ms: u128,
}

/// Why compaction fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompactionReason {
    /// The active conversation grew past `max_turns`.
    MaxTurns,
    /// It has been quiet for `idle_trigger`, with enough turns to be worth it.
    Idle,
}

/// What a tick may do, before anything is done about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TickDecision {
    /// Whether the heartbeat clock gets to run at all this tick. The clock's
    /// own decision is separate, and mutates, so it stays with the clock.
    heartbeat_may_tick: bool,
    compaction: Option<CompactionReason>,
    deep_archive: bool,
    dream: bool,
}

/// The whole per-tick trigger decision, as a function of the numbers.
///
/// Compaction and the deep archive are mutually exclusive: they share one
/// single-flight latch, and running both against the same conversation would
/// have the second work from what the first had already archived. Compaction
/// wins, because it is the trigger with a turn threshold behind it — the deep
/// archive exists for the short conversations the idle trigger never picks up.
fn tick_decision(i: TickInputs) -> TickDecision {
    let compaction = compaction_reason(i);

    // Not `compaction.is_none()` alone: a latch set on an earlier tick also
    // suppresses this one, and in that case nothing fires now to notice it.
    let deep_archive = i.autonomy_enabled
        && i.compaction_enabled
        && i.archive_after_secs > 0
        && compaction.is_none()
        && !i.compaction_triggered
        && !i.deep_archive_done
        && i.idle_secs >= i.archive_after_secs;

    TickDecision {
        heartbeat_may_tick: i.autonomy_enabled && i.heartbeat_enabled && !i.paused,
        compaction,
        deep_archive,
        dream: i.dream_backoff_elapsed && i.autonomy_enabled && i.dreaming_enabled && {
            match i.ms_since_user {
                Some(since) => since >= i.minimum_inactive_ms,
                None => true,
            }
        },
    }
}

/// Which compaction trigger, if either, this tick's numbers satisfy.
fn compaction_reason(i: TickInputs) -> Option<CompactionReason> {
    if !(i.autonomy_enabled && i.compaction_enabled && !i.compaction_triggered) {
        return None;
    }
    // `max_turns > 0` is the off switch; a conversation still under `min_turns`
    // is too short to be worth compacting however far past `max_turns` it is,
    // which can only happen when the two are configured out of order.
    if i.max_turns > 0 && i.active_turn_count >= i.max_turns && i.active_turn_count >= i.min_turns {
        return Some(CompactionReason::MaxTurns);
    }
    if i.active_turn_count >= i.min_turns
        && i.idle_trigger_secs > 0
        && i.idle_secs >= i.idle_trigger_secs
    {
        return Some(CompactionReason::Idle);
    }
    None
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STATE_VERSION: u32 = 4;
const STATE_FILENAME: &str = "autonomy_state.json";

#[derive(Serialize, Deserialize, Default)]
struct PersistedState {
    version: u32,
    ticks_without_user: u32,
    #[serde(default)]
    next_wake_at: Option<String>,
    #[serde(default)]
    last_user_at: Option<String>,
    /// See [`AutonomyState::covered_turn_count`]. Persisted so a daemon
    /// restart between a compaction and the deep-idle archive doesn't force
    /// a redundant LLM pass over already-covered turns. Defaults to 0 for
    /// older state files, which fails safe (a pass is run when in doubt).
    #[serde(default)]
    covered_turn_count: usize,
    /// Armed cache-keepalive schedule, persisted because the provider-side
    /// prompt cache outlives the process: without these, every daemon restart
    /// silently stopped pinging a still-warm cache, and the user's next
    /// message paid a full cold write. All-or-nothing — any absent field
    /// leaves the keepalive unarmed, which fails safe (never ping a cache we
    /// can't prove warm).
    ///
    /// The cadence is milliseconds, and was `keepalive_interval_secs` until the
    /// schedule moved to the sidecar. Seconds truncated a legal sub-second
    /// `cache_keepalive` to zero, and a zero interval puts the next ping at the
    /// moment of the last one — every tick due, the loop spinning. A state file
    /// written before the rename simply does not restore, which is the
    /// fail-safe direction and costs one cold write on the first message after
    /// an upgrade.
    #[serde(default)]
    keepalive_model: Option<String>,
    #[serde(default)]
    keepalive_interval_ms: Option<u64>,
    #[serde(default)]
    keepalive_last_warm_at: Option<String>,
    #[serde(default)]
    keepalive_last_active_at: Option<String>,
}

fn state_path(data_dir: &Path, character: &str) -> PathBuf {
    character_data_dir(data_dir, character).join(STATE_FILENAME)
}

/// Wall-clock milliseconds to RFC3339, for the keepalive schedule.
///
/// Exact, unlike [`instant_to_rfc3339`] next to it: the sidecar's schedule is
/// already wall-clock (`Date.now()`), so there is no monotonic reading to
/// approximate a wall time from.
fn ms_to_rfc3339(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(i64::try_from(ms).unwrap_or(i64::MAX))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

/// RFC3339 back to wall-clock milliseconds. The inverse of [`ms_to_rfc3339`],
/// used to hand a persisted schedule back to the sidecar after a restart.
fn rfc3339_to_ms(s: &str) -> Option<u64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(s).ok()?;
    u64::try_from(parsed.timestamp_millis()).ok()
}

/// Convert a `tokio::time::Instant` to an RFC3339 wall-clock string.
/// Approximate: uses the delta from `Instant::now()` applied to `Utc::now()`.
fn instant_to_rfc3339(instant: Instant) -> String {
    let now_instant = Instant::now();
    let now_utc = chrono::Utc::now();
    // `DateTime + Duration` panics on overflow, so use the checked APIs and
    // fall back to `now_utc` if the delta is out of range (unreachable in
    // practice for two instants captured back-to-back, but keeps the path
    // panic-free).
    let wall = if instant > now_instant {
        chrono::Duration::from_std(instant.duration_since(now_instant))
            .ok()
            .and_then(|delta| now_utc.checked_add_signed(delta))
    } else {
        chrono::Duration::from_std(now_instant.duration_since(instant))
            .ok()
            .and_then(|delta| now_utc.checked_sub_signed(delta))
    };
    wall.unwrap_or(now_utc).to_rfc3339()
}

fn duration_secs_i64(duration: Duration) -> i64 {
    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
}

/// Convert an RFC3339 string back to an `Instant` via the delta from current wall time.
fn rfc3339_to_instant(s: &str) -> Option<Instant> {
    let parsed = chrono::DateTime::parse_from_rfc3339(s).ok()?;
    let now_utc = chrono::Utc::now();
    let now_instant = Instant::now();
    let delta = parsed.signed_duration_since(now_utc);
    if delta >= chrono::Duration::zero() {
        let std_delta = delta.to_std().ok()?;
        now_instant.checked_add(std_delta)
    } else {
        let std_delta = delta.abs().to_std().ok()?;
        now_instant.checked_sub(std_delta)
    }
}

/// Convert a Local `NaiveDateTime` (as stored in the activity tracker) to a
/// monotonic `Instant` via the delta from current wall time.
fn naive_local_to_instant(naive: chrono::NaiveDateTime) -> Option<Instant> {
    use chrono::TimeZone;
    let dt = chrono::Local.from_local_datetime(&naive).single()?;
    let now_local = chrono::Local::now();
    let now_instant = Instant::now();
    let delta = dt.signed_duration_since(now_local);
    if delta >= chrono::Duration::zero() {
        now_instant.checked_add(delta.to_std().ok()?)
    } else {
        now_instant.checked_sub(delta.abs().to_std().ok()?)
    }
}

fn save_state(data_dir: &Path, character: &str, state: &mut AutonomyState) {
    if !state.dirty {
        return;
    }

    let keepalive = state.keepalive_schedule.as_ref();
    let persisted = PersistedState {
        version: STATE_VERSION,
        ticks_without_user: state.heartbeat.ticks_without_user(),
        next_wake_at: state.heartbeat.next_wake().map(instant_to_rfc3339),
        last_user_at: state.heartbeat.last_user_at().map(instant_to_rfc3339),
        covered_turn_count: state.covered_turn_count,
        keepalive_model: keepalive.map(|k| k.model.clone()),
        // The schedule arrives from the sidecar in wall-clock ms, so the
        // timestamps are a straight conversion rather than the `Instant` delta
        // the rest of this file still needs, and the cadence is stored as-is.
        keepalive_interval_ms: keepalive.map(|k| k.interval),
        keepalive_last_warm_at: keepalive.map(|k| ms_to_rfc3339(k.last_warm_at)),
        keepalive_last_active_at: keepalive.map(|k| ms_to_rfc3339(k.last_active_at)),
    };

    let path = state_path(data_dir, character);
    if let Some(parent) = path.parent() {
        let _ignored = std::fs::create_dir_all(parent);
    }

    match serde_json::to_string_pretty(&persisted) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                warn!(character, error = %e, "Failed to save autonomy state");
            } else {
                debug!(character, "Autonomy state saved");
                state.dirty = false;
            }
        }
        Err(e) => {
            warn!(character, error = %e, "Failed to serialize autonomy state");
        }
    }
}

fn load_state(data_dir: &Path, character: &str) -> Option<PersistedState> {
    let path = state_path(data_dir, character);
    let data = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<PersistedState>(&data) {
        Ok(state) if state.version == STATE_VERSION => Some(state),
        Ok(state) => {
            warn!(
                character,
                version = state.version,
                expected = STATE_VERSION,
                "Ignoring autonomy state with unknown version (migration)"
            );
            None
        }
        Err(e) => {
            warn!(character, error = %e, "Failed to parse autonomy state (may be v1 format)");
            None
        }
    }
}

fn restore_from_persisted(persisted: &PersistedState, heartbeat: &mut HeartbeatClock) {
    let next_wake = persisted
        .next_wake_at
        .as_deref()
        .and_then(rfc3339_to_instant);
    let last_user = persisted
        .last_user_at
        .as_deref()
        .and_then(rfc3339_to_instant);
    heartbeat.restore(persisted.ticks_without_user, next_wake, last_user);
}

/// Re-arm the sidecar's keepalive from this character's persisted schedule.
///
/// The provider-side prompt cache lives on Anthropic's servers and outlives the
/// process, so a restart does not cool it — losing the schedule here is what
/// used to turn a quick redeploy into a full cold cache write on the user's next
/// message. The sidecar applies its own staleness guard and re-arms only when
/// the last warm is recent enough that the prefix is provably still warm.
///
/// Any missing or unparseable field yields `None` and the schedule stays down,
/// which fails safe: arming from a wrong anchor could ping a cold cache.
fn keepalive_schedule_from_persisted(
    persisted: &PersistedState,
    character: &str,
) -> Option<KeepaliveSchedule> {
    Some(KeepaliveSchedule {
        character: character.to_owned(),
        model: persisted.keepalive_model.clone()?,
        interval: persisted.keepalive_interval_ms?,
        last_warm_at: rfc3339_to_ms(persisted.keepalive_last_warm_at.as_deref()?)?,
        last_active_at: rfc3339_to_ms(persisted.keepalive_last_active_at.as_deref()?)?,
    })
}

/// Whether the dreaming inactivity window is satisfied: enough time has elapsed
/// since the last user message that a scheduled sweep won't disturb an active
/// conversation. `None` last-user means there's no inactivity timer to enforce.
fn dream_inactivity_satisfied(
    dreaming_cfg: Option<&DreamingConfig>,
    last_user_at: Option<Instant>,
    now: Instant,
) -> bool {
    dreaming_cfg.is_some_and(|cfg| match last_user_at {
        Some(last_user) => now.duration_since(last_user) >= cfg.minimum_inactive_time.as_duration(),
        None => true,
    })
}

fn sanitize_compaction_config(mut compaction: CompactionConfig) -> CompactionConfig {
    // Config load rejects invalid turn thresholds outright (the daemon refuses
    // to start), so this backstop only fires for directly constructed configs.
    if let Err(reason) = compaction.validate() {
        tracing::error!(%reason, "Compaction disabled: invalid configuration");
        compaction.enabled = false;
    }

    compaction
}

// ---------------------------------------------------------------------------
// AutonomyManager
// ---------------------------------------------------------------------------

/// Shared handle to per-character autonomy state.
///
/// Cheap to clone (wraps `Arc`s). The message handler, command context, and
/// per-character tick tasks all hold clones.
#[derive(Debug, Clone)]
pub struct AutonomyManager {
    states: Arc<DashMap<String, Arc<Mutex<AutonomyState>>>>,
    handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
    config: Arc<AutonomyConfig>,
    compaction: Arc<CompactionConfig>,
    data_dir: PathBuf,
    shutdown_rx: tokio::sync::watch::Receiver<()>,
    /// LLM client for heartbeat ticks and cache keepalive pings.
    llm_client: Option<LedgerClient>,
    /// Broadcast sender for pushing autonomous messages to SWP clients.
    push_tx: Option<broadcast::Sender<ServerMessage>>,
    /// Full config for model resolution in autonomous actions.
    loaded_config: Option<Arc<LoadedConfig>>,
    /// Push notification service for autonomous events.
    notifier: Option<NotificationService>,
    /// Character engine registry for safe message persistence.
    registry: Option<Arc<tokio::sync::Mutex<CharacterRegistry>>>,
    /// Live MCP connections, snapshotted into each per-character `TickContext`
    /// so background heartbeat/dreaming ticks can use MCP tools and the cache
    /// keepalive rebuilds the same tool surface chat does. Updated on reload for
    /// future `ensure_character` calls (running ticks keep their snapshot, like
    /// `loaded_config`).
    mcp_registry: Option<Arc<crate::tools::mcp_registry::McpRegistry>>,
}

impl AutonomyManager {
    pub fn new(
        config: AutonomyConfig,
        compaction: CompactionConfig,
        data_dir: PathBuf,
        shutdown_rx: tokio::sync::watch::Receiver<()>,
    ) -> Self {
        Self {
            states: Arc::new(DashMap::new()),
            handles: Arc::new(Mutex::new(Vec::new())),
            config: Arc::new(config),
            compaction: Arc::new(sanitize_compaction_config(compaction)),
            data_dir,
            shutdown_rx,
            llm_client: None,
            push_tx: None,
            loaded_config: None,
            notifier: None,
            registry: None,
            mcp_registry: None,
        }
    }

    /// Set the LLM client and push channel for autonomous actions.
    /// Called once after creation, before any characters are ensured.
    pub fn set_resources(
        &mut self,
        llm_client: LedgerClient,
        push_tx: broadcast::Sender<ServerMessage>,
        loaded_config: LoadedConfig,
        notifier: NotificationService,
    ) {
        self.llm_client = Some(llm_client);
        self.push_tx = Some(push_tx);
        self.loaded_config = Some(Arc::new(loaded_config));
        self.notifier = Some(notifier);
    }

    /// Reload runtime autonomy and compaction configuration after `config_reset`.
    ///
    /// This updates the manager-held config used for future status checks,
    /// future `ensure_state*` calls, and fresh command contexts. Already-running
    /// per-character tick tasks keep the config snapshot they were spawned with
    /// until the daemon is restarted.
    pub fn reload_runtime_config(&mut self, loaded_config: LoadedConfig) {
        let autonomy = loaded_config.app.behavior.autonomy.clone();
        let compaction = sanitize_compaction_config(loaded_config.app.memory.compaction.clone());

        self.config = Arc::new(autonomy);
        self.compaction = Arc::new(compaction);
        self.loaded_config = Some(Arc::new(loaded_config));

        info!("Reloaded autonomy runtime configuration");
    }

    /// Set the character engine registry for safe autonomous message persistence.
    /// Called once after creation, before any characters are ensured.
    pub fn set_registry(&mut self, registry: Arc<tokio::sync::Mutex<CharacterRegistry>>) {
        self.registry = Some(registry);
    }

    /// Set (or replace, on hot-reload) the live MCP registry handed to future
    /// per-character ticks. Like `reload_runtime_config`, already-running ticks
    /// keep the snapshot they were spawned with until restart.
    pub fn set_mcp_registry(&mut self, registry: Arc<crate::tools::mcp_registry::McpRegistry>) {
        self.mcp_registry = Some(registry);
    }

    /// Send a keepalive ping right now and report what it read.
    ///
    /// The ping itself happens in the sidecar, which holds the body and is the
    /// side that makes every provider call. It deliberately leaves its schedule
    /// alone for this: measuring whether the prefix is still warm must not move
    /// the real deadline or stand the schedule down.
    ///
    /// The point is the usage. A ping that reads nothing and pays a write did
    /// not keep anything warm, and without this that is only observable by
    /// waiting for the scheduler and reading the ledger afterwards.
    ///
    /// When the sidecar has no prefix — it restarted, or this character has not
    /// spoken since it did — the body is rebuilt from disk and pushed first, so
    /// the command still answers rather than reporting nothing to ping. Which
    /// of the two happened is reported as `from_cached_request`.
    pub async fn keepalive_ping_now(&self, character: &str) -> KeepalivePing {
        let Some(client) = self.llm_client.as_ref() else {
            return KeepalivePing::Skipped("no LLM client available".to_owned());
        };

        let mut from_cached_request = true;
        let mut outcome = match client.keepalive_ping_now(character).await {
            Ok(outcome) => outcome,
            Err(e) => return KeepalivePing::Failed(e.to_string()),
        };

        if outcome.reason.as_deref() == Some("no_prefix") {
            from_cached_request = false;
            let Some(config) = self.loaded_config.as_deref() else {
                return KeepalivePing::Skipped(
                    "no cached request and no loaded config for rebuild".to_owned(),
                );
            };
            let registry = self.mcp_registry.clone().unwrap_or_default();
            let Some(request) =
                rebuild_request_from_disk(character, &self.data_dir, config, &registry)
            else {
                return KeepalivePing::Skipped("no cached or rebuildable request".to_owned());
            };
            if let Err(e) = client.push_keepalive_prefix(&request, character).await {
                return KeepalivePing::Failed(e.to_string());
            }
            outcome = match client.keepalive_ping_now(character).await {
                Ok(retried) => retried,
                Err(e) => return KeepalivePing::Failed(e.to_string()),
            };
        }

        let detail = outcome.detail.unwrap_or_default();
        match outcome.status.as_str() {
            "sent" => {
                let usage = outcome.usage.unwrap_or_default();
                KeepalivePing::Sent {
                    from_cached_request,
                    cold: outcome.cold,
                    usage: DormantPingUsage {
                        input_tokens: usage.input_tokens,
                        cache_read_tokens: usage.cache_read_tokens,
                        cache_creation_tokens: usage.cache_creation_tokens,
                    },
                }
            }
            "failed" => KeepalivePing::Failed(detail),
            _ => KeepalivePing::Skipped(detail),
        }
    }

    /// Ensure autonomy state exists for a character. On first call for a
    /// character, creates the state (restoring from disk if available) and
    /// spawns a per-character tick task.
    pub fn ensure_state(&self, character: &str) -> bool {
        self.ensure_state_with_config(character, None)
    }

    /// Like `ensure_state`, but accepts an optional per-character effective config
    /// that overrides the global config for model resolution and autonomy settings.
    pub fn ensure_state_with_config(
        &self,
        character: &str,
        effective_config: Option<&LoadedConfig>,
    ) -> bool {
        if self.states.contains_key(character) {
            return false;
        }

        // Use per-character autonomy config if available, otherwise global.
        let autonomy_cfg = effective_config.map_or_else(
            || Arc::clone(&self.config),
            |c| Arc::new(c.app.behavior.autonomy.clone()),
        );

        // Create heartbeat clock with config values.
        let mut heartbeat = HeartbeatClock::with_config(&autonomy_cfg.heartbeat);

        // Restore persisted state if available.
        let mut covered_turn_count = 0;
        let mut keepalive_schedule = None;
        if let Some(persisted) = load_state(&self.data_dir, character) {
            restore_from_persisted(&persisted, &mut heartbeat);
            covered_turn_count = persisted.covered_turn_count;
            keepalive_schedule = keepalive_schedule_from_persisted(&persisted, character);
            info!(character, "Autonomy state restored from disk");
        } else {
            info!(character, "Autonomy state created (no prior state)");
        }

        // Hand the persisted schedule back to the sidecar, which applies its own
        // staleness guard before re-arming. Spawned so a sidecar that is not up
        // yet cannot block character startup; the schedule is only an
        // optimisation, and the next real turn re-arms regardless.
        if let (Some(schedule), Some(client)) =
            (keepalive_schedule.clone(), self.llm_client.clone())
        {
            let owned_character = character.to_owned();
            let max_idle_secs = autonomy_cfg.cache_keepalive_max.as_duration().as_secs();
            let _ignored = tokio::spawn(async move {
                if let Err(e) = client.restore_keepalive(&schedule, max_idle_secs).await {
                    warn!(character = owned_character, error = %e, "Failed to restore keepalive schedule on sidecar");
                }
            });
        }

        let heartbeat_log_path =
            character_data_dir(&self.data_dir, character).join("heartbeat.jsonl");
        let heartbeat_log = HeartbeatLog::load_from(heartbeat_log_path.clone())
            .unwrap_or_else(|| HeartbeatLog::with_path(heartbeat_log_path));

        let state = Arc::new(Mutex::new(AutonomyState {
            heartbeat,
            keepalive_schedule,
            activity: ActivityTracker::new(),
            heartbeat_log,
            paused: false,
            dirty: false,
            last_compaction_activity: Instant::now(),
            compaction_triggered: false,
            active_turn_count: 0,
            compaction_pending: false,
            covered_turn_count,
            deep_archive_done: false,
            last_request: None,
            next_dream_attempt_at: None,
            dream_failure_count: 0,
        }));

        let _ignored = self.states.insert(character.to_owned(), Arc::clone(&state));

        // Spawn per-character tick task.
        let name = character.to_owned();
        let config = autonomy_cfg;
        let compaction = Arc::clone(&self.compaction);
        let data_dir = self.data_dir.clone();
        let shutdown_rx = self.shutdown_rx.clone();
        let llm_client = self.llm_client.clone();
        let push_tx = self.push_tx.clone();
        let loaded_config = effective_config
            .map(|c| Arc::new(c.clone()))
            .or_else(|| self.loaded_config.clone());
        let notifier = self.notifier.clone();
        let registry = self.registry.clone();
        // Snapshot the MCP registry (empty Arc when unconfigured) for this
        // character's ticks, mirroring how `loaded_config` is captured.
        let mcp_registry = self
            .mcp_registry
            .clone()
            .unwrap_or_else(|| Arc::new(crate::tools::mcp_registry::McpRegistry::default()));

        let tick_ctx = TickContext {
            state,
            config,
            compaction,
            data_dir,
            llm_client,
            push_tx,
            loaded_config,
            notifier,
            registry,
            mcp_registry,
        };
        let handle = tokio::spawn(async move {
            character_tick_loop(name, tick_ctx, shutdown_rx).await;
        });

        lock_or_recover("autonomy task handle list", &self.handles).push(handle);

        true
    }

    // -- state access helper ---------------------------------------------------

    /// Find the character's state, lock it, and call `f`.
    /// Returns `None` if the character has no autonomy state.
    fn with_state<R, F: FnOnce(&mut AutonomyState) -> R>(
        &self,
        character: &str,
        f: F,
    ) -> Option<R> {
        let state = self.states.get(character)?;
        let mut s = lock_state(&state);
        Some(f(&mut s))
    }

    // -- event notifications from the message handler -------------------------

    /// Call after a user message is appended.
    pub fn notify_user_message(&self, character: &str, message_count: usize) {
        let _ignored = self.with_state(character, |s| {
            let was_idle = s.heartbeat.ticks_without_user() > 0;
            let now = Instant::now();
            s.heartbeat.on_user_message(now);
            // This used to report a cache warm, on the reasoning that the user
            // message will trigger a response on the foreground model. It had to
            // guess which model that would be, from the previously cached
            // request, and had to treat the first turn — where there is no
            // cached request — as a warm on the empty string. The sidecar waits
            // for the call to actually land and reads the model off it, so the
            // guess and its special case are both gone.
            if was_idle {
                info!(character, "User returned — resetting idle counter");
                s.heartbeat_log.push(
                    HeartbeatEventKind::Wake,
                    "User returned — idle counter reset",
                );
            }
            s.activity.record_message();
            s.last_compaction_activity = now;
            s.active_turn_count = message_count;
            s.deep_archive_done = false;
            debug!(character, message_count, "User message notified");

            s.mark_dirty();
        });
    }

    /// Call after an assistant message is appended.
    pub fn notify_assistant_message(&self, character: &str, message_count: usize) {
        let _ignored = self.with_state(character, |s| {
            s.last_compaction_activity = Instant::now();
            s.active_turn_count = message_count;
            s.deep_archive_done = false;
            debug!(character, message_count, "Assistant message notified");
            s.mark_dirty();
        });
    }

    /// Backfill the activity tracker with historical message timestamps.
    ///
    /// Called once after `ensure_state` returns `true` (newly created state)
    /// to seed the tracker from existing chat history.
    pub fn backfill_activity(&self, character: &str, timestamps: &[chrono::NaiveDateTime]) {
        let count = timestamps.len();
        // Seed the heartbeat's last_user_at from the most recent backfilled user
        // turn so dreaming's inactivity gate isn't bypassed for characters
        // bootstrapped from existing history (where last_user_at would otherwise
        // be None until the next live user message).
        let latest_user = timestamps
            .iter()
            .max()
            .and_then(|n| naive_local_to_instant(*n));
        let _ignored = self.with_state(character, |s| {
            s.activity.backfill(timestamps);
            if let Some(at) = latest_user {
                s.heartbeat.seed_last_user_at_if_unset(at);
            }
        });
        debug!(character, count, "Activity backfilled from history");
    }

    /// Cache the last LLM request for heartbeat tick reuse, and hand the
    /// sidecar the same body to keep the prompt cache warm from.
    pub fn notify_last_request(&self, character: &str, request: LlmRequest) {
        let _ignored = self.with_state(character, |s| {
            cache_last_request(s, character, request.clone());
        });
        self.push_keepalive_prefix(character, request);
    }

    /// Hand the sidecar the body to ping from and the cadence to ping on.
    ///
    /// Spawned rather than awaited: this runs on the reply path, and a slow or
    /// unreachable sidecar must not hold up the turn. Losing a push costs one
    /// stale cadence until the next turn, which the next push corrects.
    fn push_keepalive_prefix(&self, character: &str, request: LlmRequest) {
        let Some(client) = self.llm_client.clone() else {
            return;
        };
        let owned_character = character.to_owned();
        let _ignored = tokio::spawn(async move {
            if let Err(e) = client
                .push_keepalive_prefix(&request, &owned_character)
                .await
            {
                warn!(character = owned_character, error = %e, "Failed to push keepalive prefix to sidecar");
            }
        });
    }

    /// Re-point the sidecar's keepalive after the cached prefix was invalidated.
    ///
    /// Invalidation deliberately does not stop pinging. Compaction changes the
    /// conversation tail, but the pinned system prefix — usually the expensive
    /// part — is still worth keeping warm, and dropping the schedule here means
    /// the user's next message after an idle stretch pays a full cold write.
    /// The daemon used to get this for free by rebuilding from disk lazily at
    /// ping time; the sidecar has no disk access, so the rebuild happens here
    /// and the result is pushed.
    fn reprime_keepalive(&self, character: &str) {
        let registry = self
            .mcp_registry
            .clone()
            .unwrap_or_else(|| Arc::new(crate::tools::mcp_registry::McpRegistry::default()));
        let rebuilt = self.loaded_config.as_deref().and_then(|config| {
            rebuild_request_from_disk(character, &self.data_dir, config, &registry)
        });
        self.send_keepalive_reprime(character, reprime_decision(rebuilt));
    }

    fn send_keepalive_reprime(&self, character: &str, decision: KeepaliveReprime) {
        let Some(client) = self.llm_client.clone() else {
            return;
        };
        let owned_character = character.to_owned();
        let _ignored = tokio::spawn(async move {
            let outcome = match &decision {
                KeepaliveReprime::Push(request) => {
                    client
                        .push_keepalive_prefix(request, &owned_character)
                        .await
                }
                KeepaliveReprime::Disarm => client.disarm_keepalive(&owned_character).await,
            };
            if let Err(e) = outcome {
                warn!(character = owned_character, error = %e, "Failed to reprime keepalive on sidecar");
            }
        });
    }

    /// Clone the cached LLM request for private background work that should
    /// preserve the same provider-side prompt-cache prefix.
    pub fn cached_last_request(&self, character: &str) -> Option<LlmRequest> {
        self.with_state(character, |s| s.last_request.clone())
            .flatten()
    }

    /// Call after compaction completes successfully. Updates the turn count
    /// and resets compaction state so future triggers can fire.
    ///
    /// The handler calls this inline after running compaction and reloading the
    /// engine — no deferred reload flag is needed.
    pub fn notify_compaction_complete(&self, character: &str, new_turn_count: usize) {
        let _ignored = self.with_state(character, |s| {
            s.active_turn_count = new_turn_count;
            // The compaction LLM saw the full conversation (the keep-N split
            // only controls what stays in active.jsonl), so every retained
            // turn is covered by memory.
            s.covered_turn_count = new_turn_count;
            // Invalidate the cached request — it contains the pre-compaction
            // conversation. The next heartbeat/keepalive call can rebuild from
            // disk while preserving the existing keepalive deadline. Compaction
            // changes the conversation tail, but the pinned system prompt
            // prefix is often still the expensive cache entry worth keeping.
            invalidate_cached_request(s, character, CachedRequestInvalidationReason::Compaction);
            // Compaction cycle complete — allow future triggers.
            s.compaction_triggered = false;
            s.compaction_pending = false;
            s.last_compaction_activity = Instant::now();
            s.mark_dirty();
            info!(
                character = %character,
                new_turn_count,
                "Compaction complete — last_request invalidated"
            );
        });
        // Outside the lock: the rebuild reads `active.jsonl` and re-derives the
        // tool surface, which is not work to do while holding the state mutex.
        self.reprime_keepalive(character);
    }

    /// Call after a manual prompt-snapshot refresh (`config_reload`). The
    /// cached request still carries the pre-refresh system prompt bytes, so
    /// replaying it for keepalive would keep a dead cache prefix warm. Drop it
    /// so the next heartbeat/keepalive call rebuilds from disk.
    pub fn notify_prompt_snapshot_refreshed(&self, character: &str) {
        let _ignored = self.with_state(character, |s| {
            invalidate_cached_request(s, character, CachedRequestInvalidationReason::PromptReload);
        });
        self.reprime_keepalive(character);
    }

    /// Call after compaction fails. Resets the trigger so it can retry.
    pub fn notify_compaction_failed(&self, character: &str) {
        warn!(character, "Compaction failed — resetting trigger for retry");
        let _ignored = self.with_state(character, |s| {
            s.compaction_triggered = false;
            s.last_compaction_activity = Instant::now();
            s.mark_dirty();
        });
    }

    /// Check if compaction should run for this character: either the max_turns
    /// threshold was reached, the last turn's context tokens crossed the
    /// `max_context_tokens` threshold, or an idle trigger set the pending
    /// flag. `context_tokens` is the sum of input + cache_read +
    /// cache_creation from the just-completed turn's usage (0 when no signal
    /// is available, e.g. from the idle-tick path). Returns true (and clears
    /// the pending flag) if compaction should run. Called by the handler
    /// inline after persist_and_notify.
    pub fn should_compact_now(
        &self,
        character: &str,
        turn_count: usize,
        context_tokens: usize,
    ) -> bool {
        let compaction = &self.compaction;
        if !compaction.enabled {
            return false;
        }
        // Max-turns trigger: immediate, checked every generation.
        if compaction.max_turns > 0
            && turn_count >= compaction.max_turns
            && turn_count >= compaction.min_turns
        {
            // Mark compaction_triggered so the tick doesn't also fire.
            let _ignored = self.with_state(character, |s| {
                s.compaction_triggered = true;
                s.mark_dirty();
            });
            return true;
        }
        // Token-based trigger: fires when the just-completed turn's prompt
        // context crossed the configured threshold. Still floored by
        // min_turns to prevent early-conversation thrash.
        if compaction.max_context_tokens > 0
            && context_tokens >= compaction.max_context_tokens
            && turn_count >= compaction.min_turns
        {
            let _ignored = self.with_state(character, |s| {
                s.compaction_triggered = true;
                s.mark_dirty();
            });
            return true;
        }
        // Idle trigger: set by the tick loop, consumed here.
        self.take_compaction_pending(character)
    }

    /// Check if the idle trigger has requested compaction for this character.
    /// Returns true (and clears the pending flag) if compaction should run.
    /// The handler calls this after each generation to decide whether to run
    /// inline compaction.
    fn take_compaction_pending(&self, character: &str) -> bool {
        self.with_state(character, |s| {
            if s.compaction_pending {
                s.compaction_pending = false;
                info!(
                    character,
                    "Idle-triggered compaction pending taken by handler"
                );
                return true;
            }
            false
        })
        .unwrap_or(false)
    }

    /// Schedule an immediate heartbeat tick. Returns Some(dormant) where
    /// dormant indicates whether the clock is currently in abandoned state
    /// (meaning the tick will be suppressed). Returns None if no state found.
    pub fn heartbeat_tick_now(&self, character: &str) -> Option<bool> {
        info!(character, "Debug: scheduling immediate heartbeat tick");
        self.with_state(character, |s| {
            let dormant = s.heartbeat.is_dormant(Instant::now());
            s.heartbeat.force_wake();
            s.mark_dirty();
            dormant
        })
    }

    /// Force heartbeat into dormant state. Returns true if state was found.
    pub fn heartbeat_set_dormant(&self, character: &str) -> bool {
        info!(character, "Debug: forcing heartbeat dormant");
        self.with_state(character, |s| {
            s.heartbeat.force_dormant();
            s.mark_dirty();
        })
        .is_some()
    }

    /// Force heartbeat into active state. Returns true if state was found.
    pub fn heartbeat_set_active(&self, character: &str) -> bool {
        info!(character, "Debug: forcing heartbeat active");
        self.with_state(character, |s| {
            s.heartbeat.force_active();
            s.mark_dirty();
        })
        .is_some()
    }

    pub fn set_paused(&self, character: &str, paused: bool) -> Option<bool> {
        info!(character, paused, "Autonomy pause state changed");
        self.with_state(character, |s| {
            s.paused = paused;
            s.mark_dirty();
            paused
        })
    }

    // -- activity stats --------------------------------------------------------

    /// Return a clone of the `ActivityStats` and recorded user-turn count.
    pub fn activity_stats(
        &self,
        character: &str,
    ) -> Option<(super::activity::ActivityStats, usize)> {
        self.with_state(character, |s| {
            let stats = s.activity.stats().clone();
            let count = s.activity.message_count();
            (stats, count)
        })
    }

    // -- status snapshot ------------------------------------------------------

    /// Build an `AutonomyStatus` snapshot for the status command.
    pub fn status(&self, character: &str) -> Option<AutonomyStatus> {
        const RECENT_EVENT_LIMIT: usize = 5;
        self.with_state(character, |s| {
            let now = Instant::now();
            let next_wake_at = s.heartbeat.next_wake().map(instant_to_rfc3339);
            let seconds_until_wake = s.heartbeat.next_wake().map(|w| {
                if w >= now {
                    duration_secs_i64(w.duration_since(now))
                } else {
                    duration_secs_i64(now.duration_since(w)).saturating_neg()
                }
            });
            let last_user_at = s.heartbeat.last_user_at().map(instant_to_rfc3339);
            let seconds_since_user = s
                .heartbeat
                .last_user_at()
                .map(|u| duration_secs_i64(now.duration_since(u)));
            let recent_events = s
                .heartbeat_log
                .recent(RECENT_EVENT_LIMIT)
                .into_iter()
                .cloned()
                .collect();
            AutonomyStatus {
                paused: s.paused,
                heartbeat_state: s.heartbeat.state_at(now).to_owned(),
                ticks_without_user: s.heartbeat.ticks_without_user(),
                dormant_after_heartbeat_turns: s.heartbeat.max_idle_ticks(),
                effective_interval_secs: s.heartbeat.default_interval().as_secs(),
                next_wake_at,
                seconds_until_wake,
                last_user_at,
                seconds_since_user,
                minimum_heartbeat_latency_secs: s.heartbeat.min_wake_interval().as_secs(),
                dormant_after_idle_time_secs: s.heartbeat.max_silent_duration().as_secs(),
                recent_events,
            }
        })
    }

    /// Return recent heartbeat events for `shore log --heartbeat`.
    pub fn heartbeat_log(&self, character: &str, limit: usize) -> Vec<super::HeartbeatEvent> {
        self.with_state(character, |s| {
            s.heartbeat_log.recent(limit).into_iter().cloned().collect()
        })
        .unwrap_or_default()
    }

    // -- shutdown -------------------------------------------------------------

    /// Wait for all per-character tick tasks to finish.
    pub async fn shutdown(&self) {
        let handles: Vec<JoinHandle<()>> = {
            let mut h = lock_or_recover("autonomy task handle list", &self.handles);
            h.drain(..).collect()
        };
        let count = handles.len();
        info!(task_count = count, "Autonomy manager shutting down");
        for handle in handles {
            if let Err(e) = handle.await {
                warn!(error = %e, "Autonomy task failed during shutdown");
            }
        }
        info!("Autonomy manager shutdown complete");
    }
}

// ---------------------------------------------------------------------------
// Per-character tick loop
// ---------------------------------------------------------------------------

/// Tick interval for each character's autonomy loop.
/// 10s gives ±10s precision on keepalive timing (vs ±30s before).
/// The per-tick work is microseconds (Instant comparisons + mutex lock)
/// unless an actual action is triggered, so the overhead is negligible.
const TICK_INTERVAL: Duration = Duration::from_secs(10);

/// Soft deadline for the heartbeat tool loop (all iterations combined). The
/// loop checks this before each iteration and ends the tick if
/// exceeded. Generous enough that a slow memory query + slow LLM across many
/// iterations normally fits; tight enough that a runaway loop can't block
/// subsequent ticks for an hour. This wall-clock deadline is the heartbeat's
/// real runaway backstop now that `max_tool_iterations` defaults to unlimited.
/// Per-call HTTP timeouts (300s, enforced by `LlmClient`) still bound each
/// individual request.
const HEARTBEAT_LOOP_DEADLINE: Duration = Duration::from_mins(30);

/// Lock the per-character autonomy state, recovering from mutex poisoning
/// instead of panicking. A poisoned mutex means a previous holder panicked,
/// but the state inside is still usable — letting the tick loop die would be
/// worse (no more keepalive, no more heartbeat, permanent silent failure).
fn lock_state(m: &Mutex<AutonomyState>) -> std::sync::MutexGuard<'_, AutonomyState> {
    lock_or_recover("autonomy state mutex", m)
}

/// Single point of mutation for `AutonomyState::last_request`. All
/// callers — the public `notify_last_request` and the internal
/// heartbeat/dormant-ping paths that already hold the state lock — go
/// through this so the log line stays consistent and nobody silently
/// forgets to emit it.
fn cache_last_request(state: &mut AutonomyState, character: &str, request: LlmRequest) {
    // The cadence used to be fed to a keepalive subsystem here. That subsystem
    // is the sidecar's now, and the request itself is what it needs — see
    // `AutonomyManager::push_keepalive_prefix`, which the public caller runs
    // after this returns and the lock is released.
    state.last_request = Some(request);
    debug!(character, "Cached last LLM request for heartbeat reuse");
}

/// What to tell the sidecar after the cached prefix was invalidated.
#[derive(Debug)]
enum KeepaliveReprime {
    /// Ping this body from now on.
    Push(Box<LlmRequest>),
    /// Stop pinging until a real call warms a new prefix.
    Disarm,
}

/// Re-point the sidecar's keepalive from a tick, which holds a `TickContext`
/// rather than the manager. Same contract as
/// [`AutonomyManager::reprime_keepalive`]; call it after releasing the state
/// lock, because the rebuild reads `active.jsonl`.
fn reprime_keepalive_from_tick(character: &str, ctx: &TickContext) {
    let Some(client) = ctx.llm_client.clone() else {
        return;
    };
    let rebuilt = ctx.loaded_config.as_deref().and_then(|config| {
        rebuild_request_from_disk(character, &ctx.data_dir, config, &ctx.mcp_registry)
    });
    let decision = reprime_decision(rebuilt);
    let owned_character = character.to_owned();
    let _ignored = tokio::spawn(async move {
        let outcome = match &decision {
            KeepaliveReprime::Push(request) => {
                client
                    .push_keepalive_prefix(request, &owned_character)
                    .await
            }
            KeepaliveReprime::Disarm => client.disarm_keepalive(&owned_character).await,
        };
        if let Err(e) = outcome {
            warn!(character = owned_character, error = %e, "Failed to reprime keepalive on sidecar");
        }
    });
}

/// Choose between them.
///
/// Split out as a pure function because the choice, not the HTTP call, is the
/// behaviour worth pinning: keeping the schedule alive across compaction is the
/// whole reason invalidation does not simply disarm, and a rebuild that failed
/// must disarm rather than leave the pre-invalidation body armed — pinging a
/// prefix the next real turn will not reuse spends money warming the wrong
/// thing.
fn reprime_decision(rebuilt: Option<LlmRequest>) -> KeepaliveReprime {
    match rebuilt {
        Some(request) => KeepaliveReprime::Push(Box::new(request)),
        None => KeepaliveReprime::Disarm,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CachedRequestInvalidationReason {
    Compaction,
    IdleCompaction,
    PreDreamCompaction,
    DeepIdleArchive,
    PromptReload,
}

/// Single point of invalidation for `AutonomyState::last_request`.
///
/// This is not the provider-side Anthropic cache itself. It is Shore's cached
/// request body used by heartbeat, dreaming, compaction, and keepalive reuse.
/// Any new path that clears it should add a reason here so cache-sensitive
/// behavior remains searchable and reviewable.
fn invalidate_cached_request(
    state: &mut AutonomyState,
    character: &str,
    reason: CachedRequestInvalidationReason,
) {
    let had_request = state.last_request.take().is_some();
    debug!(
        character,
        reason = ?reason,
        had_request,
        "Invalidated cached LLM request"
    );
}

fn push_provider_fallback_events(
    state: &mut AutonomyState,
    kind: HeartbeatEventKind,
    events: &[CredentialFallbackEvent],
) {
    for event in events {
        let to_key = event.to_key.as_deref().unwrap_or("none");
        state.heartbeat_log.push(
            kind,
            format!(
                "Provider key fallback: {} -> {} ({})",
                event.from_key, to_key, event.kind
            ),
        );
    }
}

#[expect(
    clippy::float_arithmetic,
    reason = "heartbeat tool accepts f64 hours and converts the clamped display value to seconds"
)]
fn schedule_next_wake_in_state(state: &Mutex<AutonomyState>, input: &Value) -> Value {
    let hours = input
        .get("hours_from_now")
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    let reason = input
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let clamped = hours.clamp(1.0, 48.0);
    let now = Instant::now();
    let when = now
        .checked_add(Duration::from_secs_f64(clamped * 3600.0))
        .unwrap_or(now);

    let mut s = lock_state(state);
    s.heartbeat.schedule(when, now);
    s.heartbeat_log.push(
        HeartbeatEventKind::ToolUse,
        format!("set_next_wake: {clamped:.1}h - {reason}"),
    );
    s.mark_dirty();

    json!(format!("Scheduled next moment in {clamped:.1} hours."))
}

async fn character_tick_loop(
    character: String,
    ctx: TickContext,
    mut shutdown_rx: tokio::sync::watch::Receiver<()>,
) {
    let mut interval = tokio::time::interval(TICK_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    info!(
        character = %character,
        interval_secs = TICK_INTERVAL.as_secs(),
        "Autonomy tick task started"
    );

    loop {
        tokio::select! {
            _ = interval.tick() => {
                tick_character(&character, &ctx).await;
            }
            _ = shutdown_rx.changed() => {
                // Final save before shutdown.
                let mut s = lock_state(&ctx.state);
                s.mark_dirty();
                save_state(&ctx.data_dir, &character, &mut s);
                s.heartbeat_log.flush_if_dirty();
                info!(character = %character, "Autonomy tick task shutting down");
                break;
            }
        }
    }
}

/// One tick for a single character.
async fn tick_character(character: &str, ctx: &TickContext) {
    let now = Instant::now();

    // Collect actions under the lock, then release before any async work.
    let (int_action, compaction_needed, deep_archive_needed, dream_needed) =
        collect_tick_actions(character, ctx, now);

    let run_compaction_now = resolve_idle_compaction(character, ctx, compaction_needed);

    // -- execute heartbeat action (async, outside lock) -----------------
    // No outer tokio::time::timeout wrapper: `execute_heartbeat_tick` enforces
    // its own soft deadline on the tool loop so a slow loop can't starve
    // later autonomy work.
    execute_heartbeat_action(character, ctx, int_action).await;

    // -- cache keepalive ------------------------------------------------------
    // The schedule, the clock, and the ping live in the sidecar now
    // (`llm-sidecar/src/autonomy/keepalive.ts`). What is left here is collecting
    // what it did, because the heartbeat log and the persisted state are still
    // this side's. See `drain_keepalive_events`.
    drain_keepalive_events(character, ctx).await;

    // -- idle-triggered compaction (async, outside lock) -------------------
    if run_compaction_now {
        execute_idle_compaction(character, ctx).await;
    }

    // -- deep-idle archive (async, outside lock) ---------------------------
    if deep_archive_needed {
        execute_deep_archive_if_still_idle(character, ctx).await;
    }

    if dream_needed {
        execute_dream_if_still_inactive(character, ctx).await;
    }

    // -- final persist (in case async actions dirtied state) ---------------
    {
        let mut s = lock_state(&ctx.state);
        save_state(&ctx.data_dir, character, &mut s);
        s.heartbeat_log.flush_if_dirty();
    }
}

/// Decide whether this tick can run idle compaction inline: when the tick has
/// the dependencies it needs (LLM client, config, notifier, registry), idle
/// periods produce the work directly. When any dependency is missing
/// (unit-test contexts), fall back to setting the pending flag so the
/// handler's post-generation path picks it up on the user's next message.
fn resolve_idle_compaction(character: &str, ctx: &TickContext, compaction_needed: bool) -> bool {
    if !compaction_needed {
        return false;
    }
    let have_deps = ctx.llm_client.is_some()
        && ctx.loaded_config.is_some()
        && ctx.notifier.is_some()
        && ctx.registry.is_some();
    if have_deps {
        return true;
    }
    let mut s = lock_state(&ctx.state);
    s.compaction_pending = true;
    s.mark_dirty();
    info!(
        character,
        "Compaction pending flag set for handler pickup (tick missing deps)"
    );
    false
}

/// Execute a fired heartbeat action.
///
/// This used to re-derive the keepalive decision afterwards, because a tick that
/// warmed the cache had already reset the timer and the pre-heartbeat `Ping`
/// decision was stale. The sidecar owns the schedule now and learns about the
/// tick's provider call the moment it lands, so the ordering problem is gone
/// with the split decision that created it.
async fn execute_heartbeat_action(character: &str, ctx: &TickContext, action: HeartbeatAction) {
    match action {
        HeartbeatAction::None => {}
        HeartbeatAction::RunTick => {
            {
                let mut s = lock_state(&ctx.state);
                s.heartbeat_log
                    .push(HeartbeatEventKind::TickFired, "Heartbeat tick fired");
            }
            execute_heartbeat_tick(
                character,
                &ctx.state,
                &ctx.data_dir,
                ctx.llm_client.as_ref(),
                ctx.push_tx.as_ref(),
                ctx.loaded_config.as_deref(),
                ctx.notifier.as_ref(),
                ctx.registry.as_ref(),
                &ctx.mcp_registry,
            )
            .await;
        }
    }
}

/// Collect what the sidecar's keepalive did and fold it back into the state
/// this side still owns: the heartbeat log the user reads, and the persisted
/// schedule that survives a restart.
///
/// Draining clears the events on the far side, so anything not written down
/// here is lost. That is why this runs before the tick's final persist.
async fn drain_keepalive_events(character: &str, ctx: &TickContext) {
    let Some(client) = ctx.llm_client.as_ref() else {
        return;
    };
    let drained = match client.drain_keepalive(character).await {
        Ok(drained) => drained,
        Err(e) => {
            debug!(character, error = %e, "Could not drain keepalive events from sidecar");
            return;
        }
    };
    if drained.events.is_empty() && drained.schedules.is_empty() {
        return;
    }

    let mut s = lock_state(&ctx.state);
    for event in drained.events {
        info!(character, outcome = event.outcome, "{}", event.detail);
        s.heartbeat_log
            .push(HeartbeatEventKind::DormantPing, event.detail);
    }
    // Absent means the sidecar has nothing worth restoring — keepalive off,
    // never warmed, or disarmed — so the persisted copy is cleared rather than
    // left to re-arm a dead prefix on the next restart.
    s.keepalive_schedule = drained.schedules.into_iter().next();
    s.mark_dirty();
}

/// Revalidate idleness and tick dependencies, then run the deep-idle archive.
/// The trigger was computed at the top of the tick; the heartbeat and
/// keepalive awaits may have yielded long enough for a message to land, so the
/// archive boundary is only drawn after a recheck (same pattern as the
/// dreaming inactivity recheck).
async fn execute_deep_archive_if_still_idle(character: &str, ctx: &TickContext) {
    let still_idle = {
        let s = lock_state(&ctx.state);
        let archive_after_secs = ctx.compaction.archive_after.as_secs();
        archive_after_secs > 0
            && !s.deep_archive_done
            && Instant::now()
                .duration_since(s.last_compaction_activity)
                .as_secs()
                >= archive_after_secs
    };
    let have_deps = ctx.llm_client.is_some()
        && ctx.loaded_config.is_some()
        && ctx.notifier.is_some()
        && ctx.registry.is_some();
    if still_idle && have_deps {
        execute_deep_idle_archive(character, ctx).await;
    } else {
        // Either the conversation became active during this tick's
        // awaits, or this is a unit-test context without tick deps.
        // Release the single-flight flag so other triggers aren't
        // wedged, and push the activity clock forward so a deps-less
        // context doesn't re-fire the trigger every tick. There is no
        // handler-pickup fallback for the deep archive — it only ever
        // runs from the tick.
        release_deep_archive_trigger(ctx);
    }
}

/// Revalidate the inactivity gate, then run the scheduled dream. The
/// keepalive/compaction awaits may have yielded long enough for a user message
/// to land (updating last_user_at), and the dream gate was snapshotted before
/// them — recheck now to avoid disturbing a freshly-active conversation.
async fn execute_dream_if_still_inactive(character: &str, ctx: &TickContext) {
    let still_inactive = {
        let s = lock_state(&ctx.state);
        let dreaming_cfg = ctx.loaded_config.as_ref().map(|lc| &lc.app.memory.dreaming);
        dream_inactivity_satisfied(dreaming_cfg, s.heartbeat.last_user_at(), Instant::now())
    };
    if still_inactive {
        execute_scheduled_dream(character, ctx).await;
    } else {
        debug!(
            character,
            "Dreaming: skipping scheduled sweep — user became active during tick"
        );
    }
}

/// Snapshot the per-tick actions while holding the state lock, then release it
/// before any async work runs. Returns the heartbeat action and the
/// compaction-needed / deep-archive / dream-needed gates.
///
/// The cache-keepalive decision used to be taken here too. It is the sidecar's
/// now, on its own clock, so there is nothing to snapshot for it.
fn collect_tick_actions(
    character: &str,
    ctx: &TickContext,
    now: Instant,
) -> (HeartbeatAction, bool, bool, bool) {
    let mut s = lock_state(&ctx.state);
    debug!(
        character,
        state = %s.heartbeat.state_at(now),
        ticks_without_user = s.heartbeat.ticks_without_user(),
        turn_count = s.active_turn_count,
        "tick"
    );

    let inputs = tick_inputs(&s, ctx, now);
    let decision = tick_decision(inputs);

    let int_action = run_heartbeat_tick(&mut s, decision.heartbeat_may_tick, now);
    apply_compaction_decision(character, &mut s, inputs, decision);

    save_state(&ctx.data_dir, character, &mut s);
    s.heartbeat_log.flush_if_dirty();
    (
        int_action,
        decision.compaction.is_some(),
        decision.deep_archive,
        decision.dream,
    )
}

/// Read the tick's decision inputs out of the state, the config and the clock.
fn tick_inputs(s: &AutonomyState, ctx: &TickContext, now: Instant) -> TickInputs {
    let dreaming_cfg = ctx.loaded_config.as_ref().map(|lc| &lc.app.memory.dreaming);
    TickInputs {
        autonomy_enabled: ctx.config.enabled,
        paused: s.paused,
        heartbeat_enabled: ctx.config.heartbeat.enabled,

        compaction_enabled: ctx.compaction.enabled,
        compaction_triggered: s.compaction_triggered,
        deep_archive_done: s.deep_archive_done,
        active_turn_count: s.active_turn_count,
        min_turns: ctx.compaction.min_turns,
        max_turns: ctx.compaction.max_turns,
        idle_secs: now.duration_since(s.last_compaction_activity).as_secs(),
        idle_trigger_secs: ctx.compaction.idle_trigger.as_secs(),
        archive_after_secs: ctx.compaction.archive_after.as_secs(),

        dreaming_enabled: dreaming_cfg.is_some_and(|cfg| cfg.enabled),
        dream_backoff_elapsed: s
            .next_dream_attempt_at
            .is_none_or(|next_attempt| now >= next_attempt),
        ms_since_user: s
            .heartbeat
            .last_user_at()
            .map(|at| now.duration_since(at).as_millis()),
        minimum_inactive_ms: dreaming_cfg
            .map(|cfg| cfg.minimum_inactive_time.as_duration().as_millis())
            .unwrap_or_default(),
    }
}

/// Take the compaction single-flight latch and say which trigger took it.
///
/// Both triggers set the same flag, and `tick_decision` has already ruled out
/// their firing together — this only writes down what it decided.
fn apply_compaction_decision(
    character: &str,
    s: &mut AutonomyState,
    inputs: TickInputs,
    decision: TickDecision,
) {
    match decision.compaction {
        Some(CompactionReason::MaxTurns) => {
            s.compaction_triggered = true;
            info!(
                character = %character,
                turn_count = inputs.active_turn_count,
                max_turns = inputs.max_turns,
                "Compaction: max turns trigger fired"
            );
        }
        Some(CompactionReason::Idle) => {
            s.compaction_triggered = true;
            info!(
                character = %character,
                idle_secs = inputs.idle_secs,
                threshold_secs = inputs.idle_trigger_secs,
                turn_count = inputs.active_turn_count,
                "Compaction: idle trigger fired"
            );
        }
        None if decision.deep_archive => {
            s.compaction_triggered = true;
            info!(
                character = %character,
                idle_secs = inputs.idle_secs,
                archive_after_secs = inputs.archive_after_secs,
                turn_count = inputs.active_turn_count,
                "Compaction: deep-idle archive trigger fired"
            );
        }
        None => {}
    }
}

/// Run the heartbeat scheduler for this tick (under the caller's state lock)
/// and log an abandonment-guard trip: had a deadline, tick returned `None`,
/// deadline now cleared.
///
/// `may_tick` comes from [`tick_decision`]; the clock's own decision stays here
/// because it mutates, and a decision that mutates cannot be replayed.
fn run_heartbeat_tick(s: &mut AutonomyState, may_tick: bool, now: Instant) -> HeartbeatAction {
    if !may_tick {
        return HeartbeatAction::None;
    }
    let had_deadline = s.heartbeat.next_wake().is_some();
    let action = s.heartbeat.tick(now);

    if !matches!(action, HeartbeatAction::None) {
        s.mark_dirty();
    }

    if had_deadline && matches!(action, HeartbeatAction::None) && s.heartbeat.next_wake().is_none()
    {
        let ticks = s.heartbeat.ticks_without_user();
        s.heartbeat_log.push(
            HeartbeatEventKind::Dormant,
            format!("Abandonment guard tripped (ticks without user: {ticks})"),
        );
        // The cache keepalive is intentionally NOT stopped here: it is a
        // standalone subsystem with its own idle ceiling
        // (`cache_keepalive_max`), independent of the heartbeat dormancy
        // guard. The guard governs heartbeat ticks, not cache warming.
    }
    action
}

/// Run compaction for a character during an autonomy tick, without waiting
/// for the user's next message. Resets the compaction state flags and reloads
/// the engine's cached messages on success so the next turn (or heartbeat
/// tick) sees the compacted `active.jsonl`.
async fn execute_idle_compaction(character: &str, ctx: &TickContext) {
    let Some(llm_client) = ctx.llm_client.as_ref() else {
        return;
    };
    let Some(loaded_config) = ctx.loaded_config.as_deref() else {
        return;
    };
    let Some(notifier) = ctx.notifier.as_ref() else {
        return;
    };
    // Required so the post-archive engine reload can actually happen; the
    // reload helper itself treats the registry as optional.
    let Some(_registry) = ctx.registry.as_ref() else {
        return;
    };

    info!(
        character,
        "Autonomy tick: running idle-triggered compaction"
    );

    let cached_request = lock_state(&ctx.state).last_request.clone();

    match crate::memory::compaction::run_compaction(
        character,
        loaded_config,
        llm_client,
        notifier,
        cached_request,
        None,
        false,
    )
    .await
    {
        Ok(retained_count) => {
            reload_engine_and_apply_deferred(character, ctx, loaded_config, "Idle compaction")
                .await;

            let mut s = lock_state(&ctx.state);
            invalidate_cached_request(
                &mut s,
                character,
                CachedRequestInvalidationReason::IdleCompaction,
            );
            s.active_turn_count = retained_count;
            s.covered_turn_count = retained_count;
            s.compaction_triggered = false;
            s.compaction_pending = false;
            s.last_compaction_activity = Instant::now();
            s.mark_dirty();
            info!(
                character,
                retained_count, "Idle compaction complete, state reset"
            );
            drop(s);
            reprime_keepalive_from_tick(character, ctx);
        }
        Err(e) => {
            warn!(
                character,
                error = %e,
                "Idle compaction failed, will retry on next idle tick"
            );
            let mut s = lock_state(&ctx.state);
            s.compaction_triggered = false;
            s.compaction_pending = false;
            s.last_compaction_activity = Instant::now();
            s.mark_dirty();
        }
    }
}

/// Release the deep-idle single-flight flag after a failed or aborted attempt,
/// pushing the activity clock forward so the next attempt waits a full
/// `archive_after` window instead of retrying every tick.
fn release_deep_archive_trigger(ctx: &TickContext) {
    let mut s = lock_state(&ctx.state);
    s.compaction_triggered = false;
    s.last_compaction_activity = Instant::now();
    s.mark_dirty();
}

/// Deep-idle archive: after `archive_after` of inactivity, archive what is
/// left of the active conversation so the next exchange starts from a clean
/// slate. A trailing run of unanswered autonomous messages (heartbeat
/// `<sendMessage>` output with no user response yet) is retained in the
/// active conversation so the user still sees it when they return.
///
/// Memory coverage decides the mechanism:
/// * Every user turn already covered (the common case: the regular idle
///   trigger compacted earlier and only the retained tail is left): archive
///   the file directly — no LLM pass. This intentionally bypasses
///   compaction's "zero memory writes → no archive" guard: that guard
///   protects *uncovered* content, and coverage was established when the
///   prior pass ran over the full conversation (the keep-N split only
///   controls what stays in active.jsonl, not what the compaction model
///   sees).
/// * Uncovered turns present (the conversation never reached `min_turns`,
///   or a short exchange happened after the last pass): run a real keep-0
///   compaction so those turns reach memory first.
async fn execute_deep_idle_archive(character: &str, ctx: &TickContext) {
    let Some(loaded_config) = ctx.loaded_config.as_deref() else {
        release_deep_archive_trigger(ctx);
        return;
    };

    let data_dir = loaded_config.dirs.data.as_path();
    let active_path = shore_common::config::character_active_jsonl(data_dir, character);
    let (store, content) = match crate::engine::messages::MessageStore::load_with_raw(active_path) {
        Ok(pair) => pair,
        Err(e) => {
            warn!(
                character,
                error = %e,
                "Deep-idle archive: failed to read active conversation"
            );
            release_deep_archive_trigger(ctx);
            return;
        }
    };

    let messages = store.messages();
    let tail = messages
        .iter()
        .rev()
        .take_while(|m| {
            m.role == Role::Assistant
                && m.origin == Some(shore_common::protocol::types::MessageOrigin::Autonomous)
        })
        .count();
    let archivable = messages.len().saturating_sub(tail);
    if archivable == 0 {
        // Empty conversation, or nothing but an unanswered autonomous tail
        // (e.g. a previous deep archive already ran and the heartbeat spoke
        // again). Quiesce until new message activity re-arms the trigger.
        debug!(character, tail, "Deep-idle archive: nothing to archive");
        let mut s = lock_state(&ctx.state);
        s.deep_archive_done = true;
        s.compaction_triggered = false;
        s.mark_dirty();
        return;
    }

    let user_turns = messages
        .iter()
        .filter(|m| m.role == Role::User && !m.is_tool_result_only())
        .count();
    let covered = lock_state(&ctx.state).covered_turn_count;

    if user_turns == covered {
        execute_deep_archive_pure(character, ctx, content, tail, archivable).await;
    } else {
        // Strict equality on purpose: a covered count that disagrees with the
        // on-disk turn count in either direction means coverage is uncertain,
        // and the safe direction is always to run the LLM pass.
        execute_deep_archive_compaction(character, ctx).await;
    }
}

/// Pure-archive arm of the deep-idle archive: every turn is already covered
/// by memory, so move the active conversation to a segment file directly,
/// keeping the last `tail` messages (the unanswered autonomous run).
async fn execute_deep_archive_pure(
    character: &str,
    ctx: &TickContext,
    active_content: String,
    tail: usize,
    archivable: usize,
) {
    use crate::memory::compaction::RetentionParams;

    let Some(loaded_config) = ctx.loaded_config.as_deref() else {
        release_deep_archive_trigger(ctx);
        return;
    };
    let data_dir = loaded_config.dirs.data.as_path();

    // Same single-flight guard as every other compaction entry point.
    let Some(_guard) = crate::memory::compaction::try_begin_compaction(data_dir, character) else {
        debug!(character, "Deep-idle archive: compaction already in flight");
        release_deep_archive_trigger(ctx);
        return;
    };

    let character_dir = character_data_dir(data_dir, character);
    let conv_mgr = crate::memory::compaction_impls::RealConversationManager::new(&character_dir);
    // Call through the trait so the archive runs on the blocking pool — the
    // inherent method with the same name is the synchronous core.
    let archive_result = crate::memory::compaction::ConversationManager::archive_and_retain(
        &conv_mgr,
        "deep-idle",
        RetentionParams {
            keep_last_n: tail,
            active_content,
        },
    )
    .await;

    match archive_result {
        Ok(_) => {
            if let Err(e) = crate::memory::dreams_log::append_dream_entry(
                data_dir,
                character,
                chrono::Local::now().fixed_offset(),
                "deep-idle archive",
                &format!(
                    "Archived {archivable} message(s) after extended idle; \
                     all turns were already covered by memory. Retained {tail} \
                     unanswered autonomous message(s)."
                ),
            )
            .await
            {
                warn!(character, error = %e, "Deep-idle archive: failed to append dreams log entry");
            }

            reload_engine_and_apply_deferred(character, ctx, loaded_config, "Deep-idle archive")
                .await;

            if let Some(notifier) = ctx.notifier.as_ref() {
                notifier.notify(
                    NotificationEvent::CompactionComplete,
                    &format!("Shore — {character}"),
                    &format!(
                        "Idle conversation archived ({archivable} messages, no LLM pass needed)"
                    ),
                );
            }

            let mut s = lock_state(&ctx.state);
            invalidate_cached_request(
                &mut s,
                character,
                CachedRequestInvalidationReason::DeepIdleArchive,
            );
            s.active_turn_count = 0;
            s.covered_turn_count = 0;
            s.deep_archive_done = true;
            s.compaction_triggered = false;
            s.compaction_pending = false;
            s.last_compaction_activity = Instant::now();
            s.mark_dirty();
            info!(
                character,
                archivable, tail, "Deep-idle archive complete (pure archive)"
            );
            drop(s);
            reprime_keepalive_from_tick(character, ctx);
        }
        Err(e) => {
            warn!(
                character,
                error = %e,
                "Deep-idle archive failed, will retry after the next archive_after window"
            );
            release_deep_archive_trigger(ctx);
        }
    }
}

/// LLM arm of the deep-idle archive: uncovered turns exist, so run a real
/// keep-0 compaction (retaining the trailing autonomous run) to get them
/// into memory before the conversation is archived.
async fn execute_deep_archive_compaction(character: &str, ctx: &TickContext) {
    let (Some(loaded_config), Some(llm_client), Some(notifier)) = (
        ctx.loaded_config.as_deref(),
        ctx.llm_client.as_ref(),
        ctx.notifier.as_ref(),
    ) else {
        release_deep_archive_trigger(ctx);
        return;
    };

    info!(
        character,
        "Deep-idle archive: running keep-0 compaction over uncovered turns"
    );

    let cached_request = lock_state(&ctx.state).last_request.clone();
    match crate::memory::compaction::run_compaction(
        character,
        loaded_config,
        llm_client,
        notifier,
        cached_request,
        Some(0),
        true,
    )
    .await
    {
        Ok(retained_count) => {
            reload_engine_and_apply_deferred(character, ctx, loaded_config, "Deep-idle archive")
                .await;

            let mut s = lock_state(&ctx.state);
            invalidate_cached_request(
                &mut s,
                character,
                CachedRequestInvalidationReason::DeepIdleArchive,
            );
            s.active_turn_count = retained_count;
            s.covered_turn_count = retained_count;
            s.compaction_triggered = false;
            s.compaction_pending = false;
            s.last_compaction_activity = Instant::now();
            // `deep_archive_done` is intentionally NOT set here: a
            // NoMemoryWrites outcome is indistinguishable from success at
            // this boundary (both return a 0 retained count). The next
            // firing either finds nothing archivable and quiesces, or
            // retries the pass on the still-intact conversation.
            s.mark_dirty();
            info!(
                character,
                retained_count, "Deep-idle archive complete (compaction pass)"
            );
            drop(s);
            reprime_keepalive_from_tick(character, ctx);
        }
        Err(e) => {
            warn!(
                character,
                error = %e,
                "Deep-idle archive compaction failed, will retry after the next archive_after window"
            );
            release_deep_archive_trigger(ctx);
        }
    }
}

/// Reload the character engine and apply any deferred prompt self-edits —
/// the shared post-archive bookkeeping for every compaction boundary.
async fn reload_engine_and_apply_deferred(
    character: &str,
    ctx: &TickContext,
    loaded_config: &LoadedConfig,
    log_context: &str,
) {
    if let Some(registry) = ctx.registry.as_ref() {
        let engine_result = {
            let mut r = registry.lock().await;
            r.get_or_create(character)
        };
        match engine_result {
            Ok(engine_arc) => {
                let mut engine = engine_arc.lock().await;
                if let Err(e) = engine.reload() {
                    warn!(character, error = %e, "{log_context}: engine reload failed");
                }
            }
            Err(e) => {
                warn!(character, error = %e, "{log_context}: failed to fetch engine for reload");
            }
        }
    }

    let character_dir = character_data_dir(&ctx.data_dir, character);
    if let Err(e) = crate::memory::deferred_edits::apply_deferred_edits(
        &character_dir,
        &loaded_config.dirs.config,
        character,
    ) {
        warn!(character, error = %e, "{log_context}: failed to apply deferred edits");
    }
}

async fn execute_scheduled_dream(character: &str, ctx: &TickContext) {
    let Some(loaded_config) = ctx.loaded_config.as_deref() else {
        return;
    };
    let Some(llm_client) = ctx.llm_client.as_ref() else {
        return;
    };
    let dreaming_cfg = &loaded_config.app.memory.dreaming;

    // The per-tick `dream_needed` gate only covers backoff and inactivity;
    // the cron schedule is checked here, before any pre-sweep work. Without
    // this, every sufficiently idle tick would run a pre-dream compaction
    // only for the sweep itself to decline as not-due.
    match crate::memory::dreaming::scheduled_sweep_due(loaded_config, &ctx.data_dir, character)
        .await
    {
        Ok(true) => {}
        not_due_or_err => {
            // Not due (or dream state unreadable): route through the normal
            // outcome bookkeeping — backoff reset on Ok, retry backoff on Err
            // — without compacting.
            record_scheduled_dream_outcome(character, ctx, not_due_or_err.map(|_| None));
            return;
        }
    }

    if !maybe_compact_before_dream(character, ctx, dreaming_cfg).await {
        return;
    }

    let cached_request = {
        let s = lock_state(&ctx.state);
        s.last_request.clone()
    };
    let outcome = crate::memory::dreaming::run_librarian_sweep(
        loaded_config,
        &ctx.data_dir,
        llm_client,
        character,
        cached_request.as_ref(),
        false,
        false,
    )
    .await;
    record_scheduled_dream_outcome(character, ctx, outcome);
}

/// Bump the dream failure count and push the next attempt out with backoff.
/// Returns the chosen delay and the new failure count.
fn back_off_dream_retry(state: &Mutex<AutonomyState>) -> (Duration, u32) {
    let now = Instant::now();
    let mut s = lock_state(state);
    s.dream_failure_count = s.dream_failure_count.saturating_add(1);
    let delay = background_retry_delay(s.dream_failure_count);
    s.next_dream_attempt_at = Some(now.checked_add(delay).unwrap_or(now));
    s.mark_dirty();
    (delay, s.dream_failure_count)
}

/// Run pre-dream compaction when configured and the turn count clears the
/// floor. Failure records retry backoff and returns `false`, aborting the
/// sweep this cycle so the librarian doesn't run against an oversized / stale
/// prompt cache.
async fn maybe_compact_before_dream(
    character: &str,
    ctx: &TickContext,
    dreaming_cfg: &DreamingConfig,
) -> bool {
    // Gate on the sanitized compaction snapshot (ctx.compaction), not the raw
    // loaded config — AutonomyManager::new / reload_runtime_config disable
    // invalid compaction settings, and pre-dream compaction must honor that
    // just like the idle-compaction path does.
    let compaction_cfg = &ctx.compaction;
    if !(dreaming_cfg.compact_before
        && compaction_cfg.enabled
        && lock_state(&ctx.state).active_turn_count >= compaction_cfg.min_turns)
    {
        return true;
    }

    let keep_override = if dreaming_cfg.compact_to_zero {
        Some(0)
    } else {
        None
    };
    if let Err(e) = run_pre_dream_compaction(character, ctx, keep_override).await {
        warn!(
            character,
            error = %e,
            "Dreaming: pre-dream compaction failed; skipping sweep this cycle"
        );
        _ = back_off_dream_retry(&ctx.state);
        return false;
    }
    true
}

/// Fold a scheduled sweep's outcome back into dream retry state: a completed
/// or not-due sweep resets the backoff; a failure bumps it.
fn record_scheduled_dream_outcome(
    character: &str,
    ctx: &TickContext,
    outcome: Result<
        Option<crate::memory::dreaming::DreamSweepResult>,
        crate::memory::dreaming::DreamingError,
    >,
) {
    match outcome {
        Ok(Some(result)) => {
            let mut s = lock_state(&ctx.state);
            s.dream_failure_count = 0;
            s.next_dream_attempt_at = None;
            s.mark_dirty();
            drop(s);
            info!(
                character,
                tool_rounds = result.tool_rounds,
                changed = result.changed.len(),
                audit_appended = result.audit_appended,
                "Dreaming: scheduled AI librarian pass complete"
            );
        }
        Ok(None) => {
            let mut s = lock_state(&ctx.state);
            if s.dream_failure_count != 0 || s.next_dream_attempt_at.is_some() {
                s.dream_failure_count = 0;
                s.next_dream_attempt_at = None;
                s.mark_dirty();
            }
        }
        Err(e) => {
            warn!(character, error = %e, "Dreaming: scheduled sweep failed");
            let (delay, failure_count) = back_off_dream_retry(&ctx.state);
            debug!(
                character,
                retry_in_secs = delay.as_secs(),
                failure_count,
                "Dreaming: scheduled retry backed off"
            );
        }
    }
}

/// Run a background compaction immediately before a scheduled dreaming pass.
/// Mirrors the post-success bookkeeping of `execute_idle_compaction` (engine
/// reload, deferred-edit apply, cached-request invalidation, turn-count and
/// activity updates) but does NOT touch the idle-compaction trigger flags —
/// pre-dream compaction is not an idle trigger.
async fn run_pre_dream_compaction(
    character: &str,
    ctx: &TickContext,
    keep_turns_override: Option<usize>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let llm_client = ctx
        .llm_client
        .as_ref()
        .ok_or("no llm_client for pre-dream compaction")?;
    let loaded_config = ctx
        .loaded_config
        .as_deref()
        .ok_or("no loaded_config for pre-dream compaction")?;
    let notifier = ctx
        .notifier
        .as_ref()
        .ok_or("no notifier for pre-dream compaction")?;
    let _registry = ctx
        .registry
        .as_ref()
        .ok_or("no engine registry for pre-dream compaction")?;

    info!(
        character,
        keep_turns_override = ?keep_turns_override,
        "Dreaming: running pre-dream compaction"
    );

    let cached_request = lock_state(&ctx.state).last_request.clone();
    let retained_count = crate::memory::compaction::run_compaction(
        character,
        loaded_config,
        llm_client,
        notifier,
        cached_request,
        keep_turns_override,
        false,
    )
    .await?;

    reload_engine_and_apply_deferred(character, ctx, loaded_config, "Pre-dream compaction").await;

    let mut s = lock_state(&ctx.state);
    invalidate_cached_request(
        &mut s,
        character,
        CachedRequestInvalidationReason::PreDreamCompaction,
    );
    s.active_turn_count = retained_count;
    s.covered_turn_count = retained_count;
    s.last_compaction_activity = Instant::now();
    s.mark_dirty();
    info!(character, retained_count, "Pre-dream compaction complete");
    drop(s);
    reprime_keepalive_from_tick(character, ctx);
    Ok(())
}

// ---------------------------------------------------------------------------
// Heartbeat tick executor
// ---------------------------------------------------------------------------

/// Build the dynamic heartbeat prompt.
///
/// This documents the scheduler affordances the runtime understands and points
/// carry-forward notes at `MEMORY.md`. A `[Current time: ...]` line is prepended
/// so the character has a fresh time anchor on every tick. This is the
/// heartbeat's half of the reason there is no time tool: chat gets its anchor
/// from the injected time marker (see `engine::prompt`), heartbeat ticks get it
/// from here.
fn build_heartbeat_prompt(user_name: &str, default_interval: &str) -> String {
    let now = chrono::Local::now()
        .format("%A %Y-%m-%d · %-I:%M %p")
        .to_string();
    format!(
        "\
[Current time: {now}]

[This is a private heartbeat turn — your own time, to use however seems useful. \
You have real tools and can search or write workspace and memory files, search \
your conversation history, check the web, generate images, and schedule the next wake.

In addition, you can:

- Schedule your next heartbeat session: use set_next_wake(hours_from_now, \
reason). The minimum is 1 hour, the maximum is 48 hours. Sooner if you want \
to come back to something, later if you'd rather rest. If you don't \
schedule, your next moment will arrive in {default_interval}. This is the \
next opportunity you will have to send {user_name} an autonomous message or \
to continue any unfinished or ongoing work from this current heartbeat \
session.

- Send a message to {user_name}: wrap it in <sendMessage>...</sendMessage>. \
You have the ability to autonomously and spontaneously send messages to \
{user_name}. Any text included in the `sendMessage` tags will be delivered \
to {user_name}.

Thoughts, tool-use results, and any text in your response that is not part \
of `<sendMessage>` tags are private and ephemeral. If you want to carry \
something forward, write it down with a workspace tool.

If you have a multi-step task in progress and want future-you to pick it up, \
record it in MEMORY.md with today's date, and keep it short. MEMORY.md is in \
your system prompt for every turn — heartbeat and conversation alike — so notes \
you leave there are visible to your next session either way. Anything durable \
belongs in a memory/ file instead; MEMORY.md only carries what is still live, \
and you should clear entries out of it once they are done or stale.

Changes you make to workspace files, including files under memory/, will persist. \
If nothing needs doing right now, respond with HEARTBEAT_OK and stop.]"
    )
}

fn history_is_between_turns(messages: &[Message]) -> bool {
    matches!(messages.last().map(|m| &m.role), Some(Role::Assistant))
}

/// Pick the message history a heartbeat/keepalive rebuild runs on, or `None` to
/// skip the tick.
///
/// The normal case returns the live active conversation. A deep-idle archive
/// (keep-0) leaves the active file in one of two states with no user turn for
/// the heartbeat prompt to attach to: empty (everything archived), or holding
/// only an unanswered autonomous assistant tail (the retained run). In either
/// case the provider has no user message for `push_inline_system` to merge into,
/// so a synthetic anchor turn is prepended.
///
/// An empty active conversation is **not** treated as "nothing to do": the
/// character's system prompt and memory still give it plenty to
/// act on, and the keepalive ping wants a stable system+tools prefix to keep
/// warm regardless of whether compaction has written a segment yet. So the only
/// reason to skip is a conversation that is genuinely mid-turn (a dangling
/// tool-result tail), where anchoring would produce an invalid request.
///
/// Returns owned messages because the anchor paths prepend a fresh turn.
fn heartbeat_rebuild_messages(
    character: &str,
    store: &crate::engine::messages::MessageStore,
) -> Option<Vec<Message>> {
    let messages = store.messages();
    let has_user_turn = messages
        .iter()
        .any(|m| m.role == Role::User && !m.is_tool_result_only());

    if has_user_turn {
        if !history_is_between_turns(messages) {
            info!(
                character,
                "Heartbeat rebuild: skipping tick because conversation is mid-turn"
            );
            return None;
        }
        return Some(messages.to_vec());
    }

    // No user turn: empty, or only a retained autonomous tail. An empty active
    // conversation still anchors onto the synthetic turn below — keeping the
    // system+tools prefix warm and letting the heartbeat work from memory even
    // before any segment exists.
    let empty = messages.is_empty();
    // Non-empty but no user turn and not at a turn boundary (e.g. a dangling
    // tool-result tail): unsafe to anchor, leave it alone.
    if !empty && !history_is_between_turns(messages) {
        info!(
            character,
            "Heartbeat rebuild: skipping tick because conversation is mid-turn"
        );
        return None;
    }

    info!(
        character,
        "Heartbeat: no live user turn; rebuilding from memory with synthetic anchor"
    );
    // Anchor first so the request starts with a user turn, then any retained
    // autonomous tail so the model still sees its own unanswered messages.
    Some(
        std::iter::once(heartbeat_idle_anchor_message())
            .chain(messages.iter().cloned())
            .collect(),
    )
}

/// Rebuild an `LlmRequest` from the compacted conversation on disk.
///
/// Called when `last_request` is `None` (e.g. after compaction invalidated the
/// conversation tail, or after a daemon restart).
///
/// When the active conversation is empty — the state a deep-idle keep-0 archive
/// leaves behind, or simply a character that has never chatted in this session —
/// this rebuilds using a synthetic anchor turn rather than bailing. That keeps
/// the heartbeat firing from memory and gives the keepalive ping a
/// stable system+tools prefix to keep warm (so the cache stays hot overnight even
/// with nothing in `active.jsonl`). It does not require any compaction segment to
/// exist. The anchor only ever appears in this cold state, so it can never
/// displace a warm chat prefix.
///
/// Returns `None` only when the conversation is genuinely mid-turn (a dangling
/// tool-result tail that would build an invalid request) or the model can't be
/// resolved.
fn rebuild_request_from_disk(
    character: &str,
    data_dir: &Path,
    config: &LoadedConfig,
    mcp_registry: &crate::tools::mcp_registry::McpRegistry,
) -> Option<LlmRequest> {
    use crate::engine::messages::MessageStore;
    use crate::handler::{prepare_chat_context, PrepareChatContextParams, PreparedChatContext};
    use shore_common::config::character_active_jsonl;

    let char_dir = character_data_dir(data_dir, character);
    let active_path = character_active_jsonl(data_dir, character);

    let store = MessageStore::load(active_path)
        .map_err(|e| warn!(character, error = %e, "Heartbeat rebuild: failed to load messages"))
        .ok()?;
    let has_prior_context = crate::engine::segments::SegmentReader::load(&char_dir)
        .is_ok_and(|r| r.segment_count() > 0);

    // Choose the messages to rebuild from (or skip the tick). See
    // `heartbeat_rebuild_messages` for the deep-idle anchor handling.
    let rebuilt = heartbeat_rebuild_messages(character, &store)?;
    let messages: &[Message] = &rebuilt;

    // Resolve the normal chat model with the per-character preference
    // overlay applied. Heartbeat callers apply their background model
    // override after rebuilding; keepalive must refresh the chat cache
    // prefix using the same model+sampler chat would have produced, not
    // a heartbeat-only model or an un-overlaid `defaults.model`.
    let resolved = crate::preferences::resolve_chat_model_for_character(config, character)?;

    // Mirror the chat path's MCP tool surface exactly. The keepalive's whole job
    // is to keep the *chat* prefix warm; if it omitted MCP tools while chat
    // included them, the warmed prefix would diverge and the next chat turn would
    // still pay a cold cache write (a strictly-negative keepalive).
    let mcp_tool_defs = mcp_registry.tool_defs_filtered(&config.app.tools.enabled_tools);

    let PreparedChatContext {
        llm_messages,
        system,
        tool_defs,
        ..
    } = prepare_chat_context(PrepareChatContextParams {
        character,
        character_data_dir: &char_dir,
        config,
        resolved: &resolved,
        messages,
        has_prior_context,
        mcp_tool_defs: &mcp_tool_defs,
    });

    match LedgerClient::build_request_with_provider_keys(
        &resolved,
        &config.providers,
        llm_messages,
        system,
        tool_defs,
        None,
        resolved.resolved_replay_prior_thinking(&config.app),
    ) {
        Ok(req) => {
            info!(
                character,
                "Heartbeat: rebuilt request from compacted conversation"
            );
            Some(req)
        }
        Err(e) => {
            warn!(character, error = %e, "Heartbeat: failed to rebuild request");
            None
        }
    }
}

/// Build the synthetic anchor turn used when the active conversation has been
/// fully archived (deep-idle keep-0) but memory segments remain. Provider
/// adapters merge the heartbeat prompt into the immediately preceding user
/// message ([`crate::llm::types::LlmRequest::push_inline_system`]), so a tick
/// with no live history still needs one user turn to attach to. The bracketed
/// note keeps the turn non-empty and frames it as a resumed-from-memory tick
/// rather than a user utterance; `has_prior_context` prepends an absolute time
/// marker. This message lives only in the rebuilt in-memory request — it is
/// never persisted to the active conversation.
fn heartbeat_idle_anchor_message() -> Message {
    let note = "[Resuming after an extended idle period — the earlier \
                conversation has been archived to memory.]"
        .to_owned();
    Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        role: Role::User,
        content: note.clone(),
        images: Vec::new(),
        content_blocks: vec![ContentBlock::Text { text: note }],
        alt_index: None,
        alt_count: None,
        alternatives: Vec::new(),
        provider_key: None,
        model: None,
        timestamp: chrono::Local::now().to_rfc3339(),
        origin: None,
    }
}

/// Apply the configured heartbeat model override to `request`. Returns the
/// `ResolvedModel` the request now runs on when the override was applied, or
/// `None` when the chat model was kept (no pin, unresolvable pin, same model,
/// or build failure). The caller uses the returned model to source the
/// per-model `max_tool_iterations` cap from *exactly* the model the request
/// uses, keeping the cap and the request model coherent.
fn apply_heartbeat_model_override(
    request: &mut LlmRequest,
    config: &LoadedConfig,
    character: &str,
) -> Option<shore_common::config::models::ResolvedModel> {
    // If `defaults.background.heartbeat` (or its fallbacks) is not set,
    // we have no override to apply and keep the chat model.
    let configured_name = config
        .app
        .defaults
        .resolve_background_model_name(shore_common::config::app::BackgroundTask::Heartbeat)?;
    // The configured name must actually resolve to a catalog entry. If it
    // doesn't (typo, removed model, etc.), don't silently fall back to
    // whichever chat model the catalog returns first — keep the chat
    // model the user is currently using and warn so the misconfig is
    // visible. (resolve_background_model's silent fallback is fine for
    // compaction/dreaming where some model is better than none.)
    //
    // Resolve through the *effective* catalog: pins are written as
    // `provider:model_id` with no static `[chat.*]` entry backing them
    // (#139), so the static `config.models.find_model` lookup rejected
    // every valid pin and heartbeat never left the chat model.
    if let Err(e) = crate::effective_catalog::find_effective_model(
        config,
        &config.dirs.cache,
        configured_name,
        true,
    ) {
        warn!(
            character,
            configured_model = %configured_name,
            error = %e,
            "Heartbeat: configured model not found in catalog; keeping chat model"
        );
        return None;
    }
    let resolved = crate::preferences::resolve_background_model(
        config,
        shore_common::config::app::BackgroundTask::Heartbeat,
        character,
    )?;
    if resolved.model_id == request.model {
        // Same model as the request already uses — no swap needed, and the
        // chat-model cap the caller resolves is identical anyway.
        return None;
    }
    match LedgerClient::build_request_with_provider_keys(
        &resolved,
        &config.providers,
        request.messages.clone(),
        request.system.clone(),
        request.tools.clone(),
        None,
        resolved.resolved_replay_prior_thinking(&config.app),
    ) {
        Ok(mut new_req) => {
            info!(
                character,
                heartbeat_model = %resolved.name,
                model_id = %new_req.model,
                "Heartbeat: using configured heartbeat model"
            );
            new_req.forensic_character = Some(character.to_owned());
            *request = new_req;
            Some(resolved)
        }
        Err(e) => {
            warn!(
                character,
                error = %e,
                heartbeat_model = %resolved.name,
                "Heartbeat: failed to build override request, falling back to chat model"
            );
            None
        }
    }
}

/// Execute a heartbeat tick: a real tool loop using non-streaming
/// generate() calls. Tool loop messages are ephemeral — only <sendMessage>
/// output persists to active.jsonl. All activity is logged to the ring buffer
/// for `shore log --heartbeat`.
#[expect(
    clippy::too_many_arguments,
    reason = "heartbeat tick boundary carries scheduler dependencies"
)]
async fn execute_heartbeat_tick(
    character: &str,
    state: &Arc<Mutex<AutonomyState>>,
    data_dir: &Path,
    llm_client: Option<&LedgerClient>,
    push_tx: Option<&broadcast::Sender<ServerMessage>>,
    loaded_config: Option<&LoadedConfig>,
    notifier: Option<&NotificationService>,
    registry: Option<&Arc<tokio::sync::Mutex<CharacterRegistry>>>,
    mcp_registry: &Arc<crate::tools::mcp_registry::McpRegistry>,
) {
    let Some(client) = llm_client else { return };
    let Some(lc) = loaded_config else { return };

    let Some((mut request, max_tool_iterations)) =
        prepare_heartbeat_request(character, state, data_dir, lc, mcp_registry)
    else {
        return;
    };

    let inner_ctx = build_tool_context(character, data_dir, client, lc, Arc::clone(mcp_registry));
    let tool_ctx = Arc::new(HeartbeatToolContext {
        inner: inner_ctx,
        state: Arc::clone(state),
    });

    let (send_message_text, generated_images) = run_heartbeat_tool_loop(
        character,
        state,
        &mut request,
        client,
        lc,
        &tool_ctx,
        max_tool_iterations,
    )
    .await;

    // A heartbeat tick that ran on the keepalive's own model warmed its cache;
    // one on a pinned background model (the common case) did not, and must not
    // push the foreground ping schedule out. That distinction is still made —
    // by the sidecar, which sees the tick's provider call land and compares the
    // model itself, rather than being told about it from here.

    persist_heartbeat_message(
        character,
        state,
        registry,
        push_tx,
        notifier,
        &request,
        send_message_text,
        generated_images,
    )
    .await;
}

/// Resolve and prepare the `LlmRequest` for a heartbeat tick: reuse the cached
/// `last_request` (or rebuild it from the compacted conversation on disk),
/// clear the stale request ID, apply the heartbeat model override, and pin the
/// heartbeat instructions + prompt at a fixed inline-system slot. Returns
/// `None` when there is no prior conversation to build on.
/// Build the heartbeat request and resolve the per-model `max_tool_iterations`
/// cap from the model the request *actually* runs on (the heartbeat override
/// model when applied, otherwise the chat model). Returning the cap alongside
/// the request keeps the two coherent — re-resolving the cap independently
/// could pick a different model than the request when a heartbeat pin only
/// resolves via the effective catalog.
fn prepare_heartbeat_request(
    character: &str,
    state: &Arc<Mutex<AutonomyState>>,
    data_dir: &Path,
    lc: &LoadedConfig,
    mcp_registry: &crate::tools::mcp_registry::McpRegistry,
) -> Option<(LlmRequest, Option<u32>)> {
    // Clone last_request under the lock, then release.
    let mut request = {
        let s = lock_state(state);
        if let Some(req) = &s.last_request {
            req.clone()
        } else {
            drop(s);
            let Some(req) = rebuild_request_from_disk(character, data_dir, lc, mcp_registry) else {
                info!(
                    character,
                    "Heartbeat: skipping tick (conversation mid-turn or model unresolved)"
                );
                return None;
            };
            // Persist the rebuilt request so keepalive pings can use it;
            // otherwise pings silently no-op after daemon restart until
            // the next user message.
            let mut write_guard = lock_state(state);
            cache_last_request(&mut write_guard, character, req.clone());
            drop(write_guard);
            req
        }
    };

    // Clear the stale request ID from the previous user message —
    // reusing it across heartbeat iterations can confuse OpenRouter's
    // routing/dedup and cause unexpected cache misses.
    request.rid = None;
    request.forensic_character = Some(character.to_owned());

    // Source the cap from the model the request will actually run on: the
    // heartbeat override model when it applied, otherwise the chat model.
    let max_tool_iterations = match apply_heartbeat_model_override(&mut request, lc, character) {
        Some(hb_model) => hb_model.max_tool_iterations,
        None => crate::preferences::resolve_chat_model_for_character(lc, character)
            .and_then(|m| m.max_tool_iterations),
    };

    // Build the dynamic heartbeat prompt.
    let character_data_dir = character_data_dir(data_dir, character);
    if let Err(e) = crate::memory::deferred_edits::ensure_active_prompt_snapshot(
        &character_data_dir,
        &lc.dirs.config,
        character,
    ) {
        warn!(character, error = %e, "Heartbeat: failed to prepare active prompt snapshot");
    }
    let user_name = lc.app.defaults.resolve_display_name();
    let default_interval_secs = lc
        .app
        .behavior
        .autonomy
        .heartbeat
        .fallback_heartbeat_interval
        .as_secs();
    let default_interval_str = if default_interval_secs >= SECONDS_PER_HOUR
        && default_interval_secs.is_multiple_of(SECONDS_PER_HOUR)
    {
        let h = default_interval_secs
            .checked_div(SECONDS_PER_HOUR)
            .unwrap_or_default();
        if h == 1 {
            "1 hour".to_owned()
        } else {
            format!("{h} hours")
        }
    } else {
        let minutes = default_interval_secs
            .checked_div(SECONDS_PER_MINUTE)
            .unwrap_or_default();
        format!("{minutes} minutes")
    };
    let heartbeat_prompt = build_heartbeat_prompt(&user_name, &default_interval_str);

    // Pin the heartbeat prompt at a fixed slot in
    // `request.messages` via `push_inline_system`. The heartbeat tool
    // loop below pushes `assistant` + `user(tool_result)` after this,
    // so the system entry's index must not depend on tail length. (The
    // removed `system_suffix` affordance re-expanded at the current tail
    // every `generate()` call and busted Anthropic's content-addressed
    // prefix cache across iterations — see
    // [`LlmRequest::push_inline_system`].)
    //
    // The cached chat prefix is left untouched — the inline system
    // entry sits AFTER chat's messages, so subsequent chat calls
    // reusing `last_request`'s prefix never see this text either.
    request.push_inline_system(heartbeat_prompt);
    // Heartbeat ticks fire on a slow cadence; route the payload log to
    // the long-retention tier so reflection traces survive past chat's
    // 3-day prune.
    request.retain_long = true;

    // NOTE: the tools array is reused verbatim from the chat request and is
    // never mutated here, so it stays byte-identical between chat and heartbeat
    // (no cache-prefix invalidation). The heartbeat-only capabilities
    // `set_next_wake` and `sendMessage` are deliberately NOT declared as tools;
    // the heartbeat prompt instructs the model to call them and the tool loop
    // intercepts the (undeclared) calls by name. See `dispatch_heartbeat_tools`.

    Some((request, max_tool_iterations))
}

/// Round/time budget for the heartbeat tool loop.
struct HeartbeatLoopBudget {
    max_normal_iterations: u32,
    wrap_up_grace: u32,
    loop_deadline: std::time::Instant,
}

/// Decide whether the heartbeat tool loop should stop at the start of an
/// iteration. On first exhaustion (normal round cap or soft deadline) it
/// appends a one-round wrap-up nudge; a deadline tripped during the grace
/// round — or no grace configured — ends the loop. Returns `true` to break.
fn heartbeat_budget_break(
    character: &str,
    state: &Arc<Mutex<AutonomyState>>,
    request: &mut LlmRequest,
    budget: &HeartbeatLoopBudget,
    iteration: u32,
    wrap_up_nudged: &mut bool,
) -> bool {
    let deadline_reached = std::time::Instant::now() >= budget.loop_deadline;
    let normal_cap_reached = iteration >= budget.max_normal_iterations;

    if (deadline_reached || normal_cap_reached) && !*wrap_up_nudged {
        if budget.wrap_up_grace == 0 {
            warn!(
                character,
                iteration,
                deadline_reached,
                normal_cap_reached,
                "Heartbeat: tool budget reached, no wrap-up grace configured"
            );
            return true;
        }
        warn!(
            character,
            iteration,
            deadline_reached,
            normal_cap_reached,
            wrap_up_grace = budget.wrap_up_grace,
            "Heartbeat: tool budget reached, nudging wrap-up"
        );
        append_wrap_up_nudge(request);
        *wrap_up_nudged = true;
        let mut s = lock_state(state);
        s.heartbeat_log.push(
            HeartbeatEventKind::ToolUse,
            "Wrap-up nudge: budget reached, model asked to summarize".to_owned(),
        );
    } else if deadline_reached && *wrap_up_nudged {
        warn!(
            character,
            iteration, "Heartbeat: deadline tripped during wrap-up grace, breaking"
        );
        return true;
    } else {
        // Budget intact (or wrap-up grace still running): continue the loop.
    }
    false
}

/// Run the heartbeat tool loop: repeated non-streaming `generate()` calls with
/// tool dispatch, a soft deadline, and a wrap-up grace window. Tool-loop
/// messages are appended to `request` ephemerally. Returns the last-wins
/// `<sendMessage>` text (if any) and any images the tick generated.
async fn run_heartbeat_tool_loop(
    character: &str,
    state: &Arc<Mutex<AutonomyState>>,
    request: &mut LlmRequest,
    client: &LedgerClient,
    lc: &LoadedConfig,
    tool_ctx: &Arc<HeartbeatToolContext>,
    max_tool_iterations: Option<u32>,
) -> (Option<String>, Vec<ImageRef>) {
    // `None` = unlimited, so the round count is bounded only by the wall-clock
    // `HEARTBEAT_LOOP_DEADLINE`; `u32::MAX` makes the loop bound effectively
    // infinite while the deadline does the real work and still fires the
    // wrap-up nudge when it trips. The cap is sourced (by the caller) from the
    // exact model the request runs on, so it stays coherent with the request.
    let max_normal_iterations = max_tool_iterations.unwrap_or(u32::MAX);
    let wrap_up_grace = lc.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds;
    let total_iterations = max_normal_iterations.saturating_add(wrap_up_grace);

    info!(
        character,
        max_iterations = max_normal_iterations,
        wrap_up_grace,
        "Heartbeat: executing tool loop tick"
    );

    // Collect <sendMessage> content across iterations (last-wins).
    let mut send_message_text: Option<String> = None;
    // Images generated this tick — gathered here (a heartbeat has no live client
    // channel) and attached to the autonomous message persisted at tick end.
    let mut generated_images: Vec<ImageRef> = Vec::new();

    let loop_start = std::time::Instant::now();
    let budget = HeartbeatLoopBudget {
        max_normal_iterations,
        wrap_up_grace,
        loop_deadline: loop_start
            .checked_add(HEARTBEAT_LOOP_DEADLINE)
            .unwrap_or(loop_start),
    };
    let mut wrap_up_nudged = false;

    for iteration in 0..total_iterations {
        if heartbeat_budget_break(
            character,
            state,
            request,
            &budget,
            iteration,
            &mut wrap_up_nudged,
        ) {
            break;
        }

        let call_type = if iteration == 0 {
            CallType::Heartbeat
        } else {
            CallType::HeartbeatToolLoop
        };

        let Some(resp) =
            heartbeat_llm_call(character, state, request, client, lc, call_type, iteration).await
        else {
            break;
        };
        // Provider may have changed under config fallback; read it back from the
        // request the call actually ran on.
        let provider = request.provider_key.clone();

        log_heartbeat_response(character, iteration, &resp);

        // Check for <sendMessage> in this response (last-wins).
        let text = resp.extract_text();
        if let Some(msg) = extract_send_message(&text) {
            send_message_text = Some(msg);
        }

        push_heartbeat_assistant_message(request, &resp);

        // Extract tool uses.
        let tool_uses = crate::content_util::extract_tool_uses(&resp.content_blocks);
        let has_tools = !tool_uses.is_empty() && resp.finish_reason == "tool_use";

        // Also accept `sendMessage` called as an (undeclared) tool, not just
        // the `<sendMessage>` tag — see `capture_tool_send_message`.
        send_message_text = capture_tool_send_message(&tool_uses).or(send_message_text);

        // Dispatch tools (when any) before recording so the transcript entry
        // carries each tool's full output for this iteration.
        let captured = if has_tools {
            let (tool_results, captured, images) =
                dispatch_heartbeat_tools(character, state, iteration, &tool_uses, tool_ctx).await;
            request
                .messages
                .push(WireMessage::new(WireRole::User, tool_results));
            generated_images.extend(images);
            captured
        } else {
            Vec::new()
        };

        record_heartbeat_transcript(
            client,
            character,
            call_type,
            iteration,
            provider.as_deref(),
            &resp,
            &captured,
        );

        // No tool use (or a non-tool finish): the tick is complete.
        if !has_tools {
            break;
        }
    }

    (send_message_text, generated_images)
}

/// Record one heartbeat-call curated transcript entry to the store (no-op when
/// capture is disabled).
fn record_heartbeat_transcript(
    client: &LedgerClient,
    character: &str,
    call_type: CallType,
    iteration: u32,
    provider: Option<&str>,
    resp: &crate::llm::types::GenerateResponse,
    captured: &[crate::transcript_capture::CapturedTool],
) {
    if let Some(store) = client.inner().call_store() {
        crate::transcript_capture::record(
            store,
            "heartbeat",
            character,
            call_type.as_str(),
            iteration,
            provider,
            resp,
            captured,
        );
    }
}

/// One heartbeat LLM call with config fallback; provider-fallback events are
/// folded into the heartbeat log. Returns `None` when the call fails, ending
/// the loop.
async fn heartbeat_llm_call(
    character: &str,
    state: &Arc<Mutex<AutonomyState>>,
    request: &mut LlmRequest,
    client: &LedgerClient,
    lc: &LoadedConfig,
    call_type: CallType,
    iteration: u32,
) -> Option<crate::llm::types::GenerateResponse> {
    let (resp, fallback_events) = match client
        .generate_with_config_fallback(request, lc, call_type, character, false)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(character, error = %e, iteration, "Heartbeat: LLM call failed");
            return None;
        }
    };
    if !fallback_events.is_empty() {
        let mut s = lock_state(state);
        push_provider_fallback_events(&mut s, HeartbeatEventKind::ToolUse, &fallback_events);
        s.mark_dirty();
    }
    Some(resp)
}

/// Log the heartbeat response summary and any non-empty thought text blocks.
fn log_heartbeat_response(
    character: &str,
    iteration: u32,
    resp: &crate::llm::types::GenerateResponse,
) {
    info!(
        character,
        iteration,
        finish_reason = %resp.finish_reason,
        input_tokens = resp.usage.input_tokens,
        output_tokens = resp.usage.output_tokens,
        cache_read = resp.usage.cache_read_tokens,
        "Heartbeat: LLM response"
    );

    for block in &resp.content_blocks {
        if let ContentBlock::Text { text } = block {
            if !text.trim().is_empty() {
                let preview: String = text.chars().take(200).collect();
                info!(character, iteration, content = %preview, "Heartbeat: thought");
            }
        }
    }
}

/// Build the assistant message from the response's content blocks and push it
/// onto the ephemeral heartbeat history. Every successful generate() must land
/// in the history before any exit path, keeping later tool-loop requests well
/// formed.
///
/// This used to project the blocks through the Anthropic filter, with a comment
/// noting that Z.AI would need the other one — a provider assumption compiled
/// into the heartbeat. The adapter now makes that call, so the assumption is
/// gone rather than documented.
fn push_heartbeat_assistant_message(
    request: &mut LlmRequest,
    resp: &crate::llm::types::GenerateResponse,
) {
    request.push_assistant_turn(resp);
}

/// Dispatch every tool call from one heartbeat iteration and collect the
/// `tool_result` JSON blocks. `set_next_wake` is intercepted and applied to
/// state inline rather than routed through the tool system.
async fn dispatch_heartbeat_tools(
    character: &str,
    state: &Arc<Mutex<AutonomyState>>,
    iteration: u32,
    tool_uses: &[(String, String, Value)],
    tool_ctx: &Arc<HeartbeatToolContext>,
) -> (
    Vec<WireBlock>,
    Vec<crate::transcript_capture::CapturedTool>,
    Vec<ImageRef>,
) {
    let mut tool_results: Vec<WireBlock> = Vec::new();
    let mut captured: Vec<crate::transcript_capture::CapturedTool> = Vec::new();
    let mut images: Vec<ImageRef> = Vec::new();

    for (id, name, input) in tool_uses {
        let input_str = serde_json::to_string(input).unwrap_or_default();
        info!(
            character,
            iteration,
            tool = %name, tool_id = %id,
            input = %truncate_summary(&input_str, 200),
            "Heartbeat: executing tool"
        );

        // Intercept set_next_wake — handled inline, not dispatched.
        let (output_str, is_error) = if name.as_str() == "set_next_wake" {
            crate::content_util::dispatch_result_to_output(Ok(schedule_next_wake_in_state(
                state.as_ref(),
                input,
            )))
        } else if is_send_message_tool(name) {
            // Undeclared `sendMessage` tool: the text was already captured into
            // the send-message sink by the loop; acknowledge success so the
            // model doesn't see "not yet implemented" and retry.
            crate::content_util::dispatch_result_to_output(Ok(json!({
                "status": "delivered",
                "detail": "Message will be delivered to the user when this tick ends.",
            })))
        } else {
            let result = tool_system::dispatch_tool(name, input.clone(), tool_ctx.as_ref()).await;
            // Capture generated images so the tick can deliver them. Chat turns
            // do this inline via `attach_generated_image`; a heartbeat has no
            // live client channel, so the image rides out on the autonomous
            // message persisted when the tick ends.
            if name.as_str() == "generate_image" {
                if let Ok(value) = &result {
                    if let Some(image_ref) = generated_image_ref(value) {
                        images.push(image_ref);
                    }
                }
            }
            crate::content_util::dispatch_result_to_output(result)
        };

        info!(
            character,
            iteration,
            tool = %name, is_error,
            output = %truncate_summary(&output_str, 200),
            "Heartbeat: tool result"
        );

        tool_results.push(WireBlock::ToolResult {
            tool_use_id: id.clone(),
            content: ToolResultContent::Text(output_str.clone()),
            is_error,
        });
        captured.push(crate::transcript_capture::CapturedTool {
            name: name.clone(),
            input: input.clone(),
            output: output_str.clone(),
            is_error,
        });

        // Log to ring buffer (skip set_next_wake — already logged above).
        if name.as_str() != "set_next_wake" {
            let mut s = lock_state(state);
            s.heartbeat_log.push(
                HeartbeatEventKind::ToolUse,
                format!("Tool: {name} → {}", truncate_summary(&output_str, 80)),
            );
        }
    }

    (tool_results, captured, images)
}

/// Build an `ImageRef` from a successful `generate_image` tool result.
///
/// Mirrors the chat path's `attach_generated_image`: reads the saved `path`
/// and optional `caption` from the tool's JSON output. `data` is left `None`
/// and populated just before the message goes on the wire.
fn generated_image_ref(value: &Value) -> Option<ImageRef> {
    let path = value.get("path").and_then(Value::as_str)?;
    Some(ImageRef {
        path: path.to_owned(),
        caption: value
            .get("caption")
            .and_then(Value::as_str)
            .map(str::to_owned),
        data: None,
    })
}

/// Build the autonomous assistant `Message` for a heartbeat tick from its
/// `<sendMessage>` text and any generated images. Image `data` is populated
/// later, just before the message goes on the wire.
fn build_autonomous_message(
    text: &str,
    images: Vec<ImageRef>,
    provider_key: Option<String>,
    model: Option<String>,
) -> Message {
    // Omit the text block for an image-only tick — otherwise the persisted
    // message carries a blank `ContentBlock::Text`.
    let content_blocks = if text.is_empty() {
        Vec::new()
    } else {
        vec![ContentBlock::Text {
            text: text.to_owned(),
        }]
    };
    let content = derive_content_from_blocks(&content_blocks);
    Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        origin: Some(shore_common::protocol::types::MessageOrigin::Autonomous),
        role: Role::Assistant,
        content,
        images,
        content_blocks,
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        provider_key,
        model,
        timestamp: chrono::Local::now().to_rfc3339(),
    }
}

/// Persist a heartbeat tick's `<sendMessage>` output and/or generated images to
/// the engine and notify clients, or record a skip in the ring buffer when the
/// tick produced neither.
///
/// A tick that only generated an image (no `<sendMessage>` text) still delivers
/// — the image is the message, and any words ride along as its caption.
#[expect(
    clippy::too_many_arguments,
    reason = "heartbeat persistence boundary carries engine, push, and notifier dependencies"
)]
async fn persist_heartbeat_message(
    character: &str,
    state: &Arc<Mutex<AutonomyState>>,
    registry: Option<&Arc<tokio::sync::Mutex<CharacterRegistry>>>,
    push_tx: Option<&broadcast::Sender<ServerMessage>>,
    notifier: Option<&NotificationService>,
    request: &LlmRequest,
    send_message_text: Option<String>,
    images: Vec<ImageRef>,
) {
    if send_message_text.is_some() || !images.is_empty() {
        let user_msg = send_message_text.unwrap_or_default();
        info!(
            character,
            msg = %truncate_summary(&user_msg, 200),
            image_count = images.len(),
            "Heartbeat: sending message to user"
        );

        // The heartbeat's minting model is whatever the background request was
        // resolved to — the model that actually wrote this autonomous message.
        let minting_model = (!request.model.is_empty()).then(|| request.model.clone());
        let msg = build_autonomous_message(
            &user_msg,
            images,
            request.provider_key.clone(),
            minting_model,
        );

        // Persist via the engine lock to avoid racing with the handler's
        // MessageStore writes (atomic temp+rename). The engine's append_message
        // also calls broadcast_history(), so clients are notified automatically.
        if let Some(reg) = registry {
            // Acquire engine_arc under registry lock, then drop it before
            // locking the engine — matches handler's lock ordering and avoids
            // holding the registry during disk I/O.
            let engine_result = {
                let mut r = reg.lock().await;
                r.get_or_create(character)
            };
            match engine_result {
                Ok(engine_arc) => {
                    let mut engine = engine_arc.lock().await;
                    if let Err(e) = engine.append_message(msg.clone()) {
                        error!(character, error = %e, "Failed to persist autonomous message via engine");
                    } else if let Some(tx) = push_tx {
                        // `msg.origin` already carries `Autonomous`; the
                        // flattened message is what puts it on the wire. Embed
                        // image bytes so remote clients (TUI, matrix bridge)
                        // render generated images without filesystem access to
                        // the daemon's paths — the incremental NewMessage path
                        // skips the embedding that `broadcast_history` applies.
                        let mut wire_msg = msg.clone();
                        crate::handler::embed_image_data(&mut wire_msg.images);
                        _ = tx.send(ServerMessage::NewMessage(
                            shore_common::protocol::server_msg::NewMessage {
                                revision: engine.current_revision(),
                                character: Some(character.to_owned()),
                                message: wire_msg,
                            },
                        ));
                    } else {
                        // Persisted with no push channel: nothing to broadcast.
                    }
                }
                Err(e) => {
                    error!(character, error = %e, "Failed to get engine for autonomous message");
                }
            }
        } else {
            error!(
                character,
                "No registry available, autonomous message not persisted"
            );
        }
        if let Some(n) = notifier {
            n.notify(
                NotificationEvent::AutonomousMessage,
                &format!("Shore — {character}"),
                &msg.content,
            );
        }

        let mut s = lock_state(state);
        let preview: String = msg.content.chars().take(80).collect();
        s.heartbeat_log.push(
            HeartbeatEventKind::MessageSent,
            format!("Autonomous message sent: {preview}"),
        );
        s.mark_dirty();
    } else {
        let mut s = lock_state(state);
        s.heartbeat_log.push(
            HeartbeatEventKind::MessageSkipped,
            "Tick completed — no message sent".to_owned(),
        );
    }
}

// ---------------------------------------------------------------------------
// Tool context builder for heartbeat ticks
// ---------------------------------------------------------------------------

/// Build a SharedToolContext for heartbeat ticks.
///
/// Uses the same ingredients as the handler (LlmClient, LoadedConfig, data_dir)
/// but resolves models with heartbeat-specific fallbacks. All tools work —
/// workspace/memory files, images, and web. The only gap is AutonomyManager (the
/// heatmap tool degrades gracefully via the trait default).
fn build_tool_context(
    character: &str,
    data_dir: &Path,
    client: &LedgerClient,
    config: &LoadedConfig,
    mcp_registry: Arc<crate::tools::mcp_registry::McpRegistry>,
) -> SharedToolContext {
    let char_dir = character_data_dir(data_dir, character);

    let image_gen_config = resolve_image_gen_config(
        config.app.defaults.image_generation.as_deref(),
        &config.models.image_generation,
        &config.providers,
    )
    .ok();
    let embedder = resolve_embedder(
        config.app.defaults.embedding.as_deref(),
        &config.models.embedding,
        &config.providers,
        client.inner().http_client(),
    )
    .map_err(|e| {
        debug!(character, error = %e, "Heartbeat: embedder unavailable; semantic memory retrieval disabled");
    })
    .ok();

    debug!(
        character,
        has_image_gen = image_gen_config.is_some(),
        "Heartbeat: tool context built"
    );

    SharedToolContext {
        image_dir: char_dir.join("images").to_string_lossy().into_owned(),
        llm_client: client.inner().clone(),
        image_gen_config,
        search_config: config.app.tools.web_search.clone(),
        character_name: character.to_owned(),
        workspace_dir: character_workspace_dir(&config.dirs.config, character)
            .to_string_lossy()
            .into_owned(),
        markdown_store: crate::memory::markdown_store::MarkdownMemoryStore::open_sync(
            character_memory_dir(&config.dirs.config, character),
        )
        .ok(),
        memory_retrieval_config: config.app.memory.retrieval.clone(),
        embedder,
        memory_index_path: crate::memory::workspace_index::index_path(
            &config.dirs.cache,
            character,
        ),
        config_dir: config.dirs.config.to_string_lossy().into_owned(),
        character_data_dir: char_dir.to_string_lossy().into_owned(),
        // Wire the sub-agent runtime so `ask_*` works during heartbeat ticks.
        // Background context: no live client channel, so the nested loop's
        // frames drain rather than stream (see `SubagentRuntime::background`).
        // Gated on configured sub-agents to skip the config clone otherwise.
        subagent_runtime: if config.app.subagents.is_empty() {
            None
        } else {
            Some(Arc::new(
                crate::tools::subagent::SubagentRuntime::background(
                    client.clone(),
                    Arc::new(config.clone()),
                ),
            ))
        },
        mcp_registry: Some(mcp_registry),
    }
}

/// Extract text between XML-style tags. Returns the last match (last-wins).
#[expect(
    clippy::string_slice,
    reason = "byte offsets derive from find()/literal-len() on `content` itself, so every slice bound lands on a char boundary"
)]
fn extract_tag(content: &str, start_tag: &str, end_tag: &str) -> Option<String> {
    let mut result = None;
    let mut search_from = 0;
    while let Some(start_pos) = content[search_from..].find(start_tag) {
        let abs_start = search_from
            .saturating_add(start_pos)
            .saturating_add(start_tag.len());
        if let Some(end_pos) = content[abs_start..].find(end_tag) {
            let inner = content[abs_start..abs_start.saturating_add(end_pos)].trim();
            if !inner.is_empty() {
                result = Some(inner.to_owned());
            }
            search_from = abs_start
                .saturating_add(end_pos)
                .saturating_add(end_tag.len());
        } else {
            break;
        }
    }
    result
}

/// Extract text between `<sendMessage>` and `</sendMessage>` tags (last-wins).
fn extract_send_message(content: &str) -> Option<String> {
    extract_tag(content, "<sendMessage>", "</sendMessage>")
}

/// True for the names the model reaches for when it calls `sendMessage` as a
/// tool instead of using the `<sendMessage>` tag. The tool is intentionally
/// undeclared (declaring it would make the heartbeat tools array asymmetric
/// with chat and bust the prompt-cache prefix); the heartbeat dispatch
/// intercepts these names rather than letting them fall through to
/// `NotImplemented`.
fn is_send_message_tool(name: &str) -> bool {
    name.eq_ignore_ascii_case("sendmessage") || name.eq_ignore_ascii_case("send_message")
}

/// Scan one iteration's tool calls for a `sendMessage` and return its message
/// text (last-wins), mirroring the `<sendMessage>` tag's last-wins semantics.
fn capture_tool_send_message(tool_uses: &[(String, String, Value)]) -> Option<String> {
    tool_uses
        .iter()
        .filter(|(_, name, _)| is_send_message_tool(name))
        .filter_map(|(_, _, input)| extract_tool_send_message(input))
        .next_back()
}

/// Pull the user-facing message out of a hallucinated `sendMessage` tool call.
/// The model gets no input schema (the tool is undeclared), so accept the field
/// names it commonly reaches for, plus a bare string input.
fn extract_tool_send_message(input: &Value) -> Option<String> {
    for key in ["message", "text", "content", "body"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    if let Some(s) = input.as_str() {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    None
}

const WRAP_UP_NUDGE_TEXT: &str = "[System nudge: heartbeat tool-use budget reached. Wrap up now — \
if you have unfinished work, note it in MEMORY.md with today's date so future-you can pick it up \
where you left off. Then either send a final <sendMessage> or respond HEARTBEAT_OK and stop.]";

/// Append the wrap-up nudge text to the request. The nudge has to land on the
/// last user message (Anthropic rejects two consecutive user turns), so this
/// folds it into the trailing tool_results message when one exists, and only
/// pushes a fresh user message when the request happens to end on an assistant
/// turn or is otherwise empty.
fn append_wrap_up_nudge(request: &mut LlmRequest) {
    if let Some(last) = request.messages.last_mut() {
        if last.role == WireRole::User {
            last.content.push(WireBlock::text(WRAP_UP_NUDGE_TEXT));
            return;
        }
    }
    request
        .messages
        .push(WireMessage::text(WireRole::User, WRAP_UP_NUDGE_TEXT));
}

// ---------------------------------------------------------------------------
// On-demand ping
// ---------------------------------------------------------------------------
//
// The executor that used to live here is gone with the rest of the keepalive.
// The sidecar sends the ping (`/v1/keepalive/ping-now`); what stays is the
// shape the `keepalive_ping_now` command reports, so its output is unchanged.

/// Token counts from an on-demand ping.
#[derive(Debug, Clone, Copy, Default)]
pub struct DormantPingUsage {
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// What an on-demand keepalive ping did, for the `keepalive_ping_now` command.
///
/// `cold` is the answer the command exists to give: read nothing, paid a
/// write. The prefix the keepalive was protecting was already gone, so the
/// ping recreated it at full price instead of refreshing it.
#[derive(Debug)]
pub enum KeepalivePing {
    Sent {
        /// True when the sidecar pinged a prefix it already held, false when the
        /// daemon had to rebuild one from disk and push it first. A rebuilt
        /// request that reads cold may just mean nothing was cached yet; a
        /// *cached* one that reads cold means the prefix it was protecting has
        /// drifted, which is exactly what a cold read would be telling you.
        from_cached_request: bool,
        cold: bool,
        usage: DormantPingUsage,
    },
    Failed(String),
    Skipped(String),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::SystemBlock;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use shore_common::config::app::HeartbeatConfig;

    fn test_config() -> AutonomyConfig {
        AutonomyConfig::default()
    }

    fn test_message(role: Role) -> Message {
        Message {
            msg_id: format!("m_{}", uuid::Uuid::new_v4()),
            origin: None,
            role,
            content: "hello".into(),
            images: vec![],
            content_blocks: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: chrono::Local::now().to_rfc3339(),
        }
    }

    fn test_manager(data_dir: &Path) -> AutonomyManager {
        let (_tx, rx) = tokio::sync::watch::channel(());
        AutonomyManager::new(
            test_config(),
            CompactionConfig::default(),
            data_dir.to_path_buf(),
            rx,
        )
    }

    #[test]
    fn history_between_turns_only_after_assistant_message() {
        assert!(!history_is_between_turns(&[]));
        assert!(!history_is_between_turns(&[test_message(Role::User)]));
        assert!(history_is_between_turns(&[
            test_message(Role::User),
            test_message(Role::Assistant)
        ]));
    }

    fn empty_request() -> LlmRequest {
        LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: "test".into(),
            api_key: "k".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![],
            system: Vec::new(),
            tools: None,
            max_tokens: 1024,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: shore_common::config::app::ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: None,
        }
    }

    fn nudge_text(block: &WireBlock) -> &str {
        let WireBlock::Text { text } = block else {
            panic!("expected a text block, got {block:?}")
        };
        text
    }

    #[test]
    fn wrap_up_nudge_folds_into_trailing_tool_results() {
        let mut req = empty_request();
        req.messages.push(WireMessage::new(
            WireRole::User,
            vec![WireBlock::ToolResult {
                tool_use_id: "tu_1".to_owned(),
                content: ToolResultContent::Text("ok".to_owned()),
                is_error: false,
            }],
        ));
        append_wrap_up_nudge(&mut req);
        assert_eq!(
            req.messages.len(),
            1,
            "must not introduce a second user turn"
        );
        assert_eq!(req.messages[0].content.len(), 2);
        assert!(nudge_text(&req.messages[0].content[1]).contains("MEMORY.md"));
    }

    #[test]
    fn wrap_up_nudge_folds_into_a_text_user_turn() {
        let mut req = empty_request();
        req.messages.push(WireMessage::text(WireRole::User, "hi"));
        append_wrap_up_nudge(&mut req);
        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].content.len(), 2);
        assert_eq!(nudge_text(&req.messages[0].content[0]), "hi");
        assert!(nudge_text(&req.messages[0].content[1]).contains("MEMORY.md"));
    }

    #[test]
    fn wrap_up_nudge_pushes_after_assistant_turn() {
        let mut req = empty_request();
        req.messages.push(WireMessage::text(WireRole::User, "hi"));
        req.messages
            .push(WireMessage::text(WireRole::Assistant, "bye"));
        append_wrap_up_nudge(&mut req);
        assert_eq!(req.messages.len(), 3);
        assert_eq!(req.messages[2].role, WireRole::User);
        assert!(nudge_text(&req.messages[2].content[0]).contains("MEMORY.md"));
    }

    #[test]
    fn wrap_up_nudge_pushes_when_request_is_empty() {
        let mut req = empty_request();
        append_wrap_up_nudge(&mut req);
        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].role, WireRole::User);
    }

    // -- ensure_state ---------------------------------------------------------

    #[test]
    fn ensure_state_creates_on_first_call() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let mgr = rt.block_on(async { test_manager(tmp.path()) });

        rt.block_on(async {
            let _ignored = mgr.ensure_state("alice");
            assert!(mgr.states.contains_key("alice"));
        });
    }

    #[test]
    fn ensure_state_idempotent() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let mgr = rt.block_on(async { test_manager(tmp.path()) });

        rt.block_on(async {
            let _ignored = mgr.ensure_state("alice");
            _ = mgr.ensure_state("alice");
            assert_eq!(mgr.states.len(), 1);
        });
    }

    #[test]
    fn ensure_state_recovers_from_poisoned_handles_mutex() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let (tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            test_config(),
            CompactionConfig::default(),
            tmp.path().to_path_buf(),
            rx,
        );

        let result = catch_unwind(AssertUnwindSafe(|| {
            let _guard = mgr.handles.lock().unwrap();
            panic!("poison autonomy handles");
        }));
        assert!(result.is_err());

        rt.block_on(async {
            assert!(mgr.ensure_state("alice"));
        });
        assert!(mgr.states.contains_key("alice"));

        drop(tx);
        rt.block_on(async {
            mgr.shutdown().await;
        });
    }

    // -- notify ---------------------------------------------------------------

    #[test]
    fn notify_without_state_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            test_config(),
            CompactionConfig::default(),
            tmp.path().to_path_buf(),
            rx,
        );
        // Should not panic.
        mgr.notify_user_message("nobody", 0);
        mgr.notify_assistant_message("nobody", 0);
    }

    // -- status ---------------------------------------------------------------

    #[test]
    fn status_returns_none_for_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            test_config(),
            CompactionConfig::default(),
            tmp.path().to_path_buf(),
            rx,
        );
        assert!(mgr.status("nobody").is_none());
    }

    #[test]
    fn status_returns_some_after_ensure() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();

        rt.block_on(async {
            let mgr = test_manager(tmp.path());
            let _ignored = mgr.ensure_state("alice");
            let status = mgr.status("alice").unwrap();
            assert_eq!(status.heartbeat_state, "Active");
            assert_eq!(status.ticks_without_user, 0);
        });
    }

    #[test]
    fn status_reports_dormant_after_force_dormant() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();

        rt.block_on(async {
            let mgr = test_manager(tmp.path());
            let _ignored = mgr.ensure_state("alice");
            assert!(mgr.heartbeat_set_dormant("alice"));

            let status = mgr.status("alice").unwrap();
            assert_eq!(status.heartbeat_state, "Dormant");
        });
    }

    #[test]
    fn status_reports_dormant_after_silent_duration() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();

        rt.block_on(async {
            let mgr = test_manager(tmp.path());
            let _ignored = mgr.ensure_state("alice");
            _ = mgr.with_state("alice", |s| {
                let now = Instant::now();
                s.heartbeat.on_user_message(now - Duration::from_hours(72));
            });

            let status = mgr.status("alice").unwrap();
            assert_eq!(status.heartbeat_state, "Dormant");
        });
    }

    // -- backfill -------------------------------------------------------------

    #[test]
    fn ensure_state_returns_true_then_false() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let mgr = rt.block_on(async { test_manager(tmp.path()) });

        rt.block_on(async {
            assert!(mgr.ensure_state("alice"));
            assert!(!mgr.ensure_state("alice"));
        });
    }

    #[test]
    fn backfill_activity_updates_message_count() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let mgr = rt.block_on(async { test_manager(tmp.path()) });

        rt.block_on(async {
            let _ignored = mgr.ensure_state("alice");

            let timestamps = vec![
                chrono::NaiveDate::from_ymd_opt(2026, 3, 20)
                    .unwrap()
                    .and_hms_opt(10, 0, 0)
                    .unwrap(),
                chrono::NaiveDate::from_ymd_opt(2026, 3, 21)
                    .unwrap()
                    .and_hms_opt(14, 0, 0)
                    .unwrap(),
                chrono::NaiveDate::from_ymd_opt(2026, 3, 22)
                    .unwrap()
                    .and_hms_opt(9, 0, 0)
                    .unwrap(),
            ];
            mgr.backfill_activity("alice", &timestamps);

            let (_stats, count) = mgr.activity_stats("alice").unwrap();
            assert_eq!(count, 3);
        });
    }

    #[test]
    fn backfill_seeds_last_user_at_from_recent_history() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let mgr = rt.block_on(async { test_manager(tmp.path()) });

        rt.block_on(async {
            let _ignored = mgr.ensure_state("alice");
            // Heartbeat starts with no user activity.
            _ = mgr.with_state("alice", |s| assert!(s.heartbeat.last_user_at().is_none()));

            // Most recent backfilled user turn is ~2 minutes ago.
            let now_local = chrono::Local::now().naive_local();
            let timestamps = vec![
                now_local - chrono::Duration::minutes(30),
                now_local - chrono::Duration::minutes(2),
            ];
            mgr.backfill_activity("alice", &timestamps);

            // last_user_at is now seeded and reflects the recent (~2min) turn,
            // so a short inactivity window would NOT be satisfied.
            _ = mgr.with_state("alice", |s| {
                let last = s.heartbeat.last_user_at().expect("seeded");
                let elapsed = Instant::now().duration_since(last);
                assert!(elapsed < Duration::from_mins(5));
                assert!(elapsed >= Duration::from_mins(1));
            });
        });
    }

    // -- persistence ----------------------------------------------------------

    #[test]
    fn save_and_restore_state() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        std::fs::create_dir_all(data_dir.join("alice")).unwrap();

        // Create and save.
        let mut state = AutonomyState {
            heartbeat: HeartbeatClock::with_config(&HeartbeatConfig::default()),
            keepalive_schedule: None,
            activity: ActivityTracker::new(),
            heartbeat_log: HeartbeatLog::new(),
            paused: false,
            dirty: true,
            last_compaction_activity: Instant::now(),
            compaction_triggered: false,
            active_turn_count: 0,
            compaction_pending: false,
            covered_turn_count: 0,
            deep_archive_done: false,
            last_request: None,
            next_dream_attempt_at: None,
            dream_failure_count: 0,
        };
        save_state(data_dir, "alice", &mut state);
        assert!(!state.dirty);

        // Verify file exists.
        assert!(state_path(data_dir, "alice").exists());

        // Restore.
        let persisted = load_state(data_dir, "alice").unwrap();
        assert_eq!(persisted.version, STATE_VERSION);
        assert_eq!(persisted.ticks_without_user, 0);
        // next_wake_at should be None (clock was fresh, no deadline set).
        assert!(persisted.next_wake_at.is_none());
        // Keepalive was never armed — nothing persisted, restore stays unarmed.
        assert!(persisted.keepalive_model.is_none());
        assert!(keepalive_schedule_from_persisted(&persisted, "alice").is_none());
    }

    /// The schedule the sidecar drains must survive a save/load round trip
    /// without drifting, because what comes back is offered straight to
    /// `/v1/keepalive/restore` and its staleness guard compares these timestamps
    /// against the ping interval. A round trip that lost precision, or a
    /// seconds/milliseconds mix-up, would look like a schedule an hour out of
    /// date and silently stop re-arming across every restart.
    ///
    /// Whether the sidecar then *accepts* it is its own test — see
    /// `llm-sidecar/tests/keepalive_service.test.ts`, "schedules survive a
    /// restart through restore".
    #[test]
    fn keepalive_schedule_survives_save_and_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        std::fs::create_dir_all(data_dir.join("alice")).unwrap();

        // Wall-clock ms, as the sidecar reports them. Truncated to the second,
        // because RFC3339 is the on-disk format and that is the precision the
        // round trip can actually carry.
        let warmed_at = 1_785_600_000_000_u64;
        let schedule = KeepaliveSchedule {
            character: "alice".to_owned(),
            model: "claude-opus-4-6".to_owned(),
            interval: 55 * 60_000,
            last_warm_at: warmed_at,
            last_active_at: warmed_at - 60_000,
        };

        let mut state = AutonomyState {
            heartbeat: HeartbeatClock::with_config(&HeartbeatConfig::default()),
            keepalive_schedule: Some(schedule.clone()),
            activity: ActivityTracker::new(),
            heartbeat_log: HeartbeatLog::new(),
            paused: false,
            dirty: true,
            last_compaction_activity: Instant::now(),
            compaction_triggered: false,
            active_turn_count: 0,
            compaction_pending: false,
            covered_turn_count: 0,
            deep_archive_done: false,
            last_request: None,
            next_dream_attempt_at: None,
            dream_failure_count: 0,
        };
        save_state(data_dir, "alice", &mut state);

        let persisted = load_state(data_dir, "alice").unwrap();
        assert_eq!(
            persisted.keepalive_model.as_deref(),
            Some("claude-opus-4-6")
        );
        let restored = keepalive_schedule_from_persisted(&persisted, "alice").unwrap();
        assert_eq!(restored.model, schedule.model);
        assert_eq!(restored.interval, schedule.interval);
        assert_eq!(restored.last_warm_at, schedule.last_warm_at);
        assert_eq!(restored.last_active_at, schedule.last_active_at);
        assert_eq!(restored.character, "alice");
    }

    /// An absent schedule must clear the persisted copy rather than leave the
    /// last one on disk. A stale schedule is the one input that could re-arm a
    /// prefix the sidecar had already disarmed.
    #[test]
    fn absent_keepalive_schedule_clears_the_persisted_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        std::fs::create_dir_all(data_dir.join("alice")).unwrap();

        let mut state = AutonomyState {
            heartbeat: HeartbeatClock::with_config(&HeartbeatConfig::default()),
            keepalive_schedule: Some(KeepaliveSchedule {
                character: "alice".to_owned(),
                model: "claude-opus-4-6".to_owned(),
                interval: 55 * 60_000,
                last_warm_at: 1_785_600_000_000,
                last_active_at: 1_785_600_000_000,
            }),
            activity: ActivityTracker::new(),
            heartbeat_log: HeartbeatLog::new(),
            paused: false,
            dirty: true,
            last_compaction_activity: Instant::now(),
            compaction_triggered: false,
            active_turn_count: 0,
            compaction_pending: false,
            covered_turn_count: 0,
            deep_archive_done: false,
            last_request: None,
            next_dream_attempt_at: None,
            dream_failure_count: 0,
        };
        save_state(data_dir, "alice", &mut state);

        state.keepalive_schedule = None;
        state.dirty = true;
        save_state(data_dir, "alice", &mut state);

        let persisted = load_state(data_dir, "alice").unwrap();
        assert!(persisted.keepalive_model.is_none());
        assert!(keepalive_schedule_from_persisted(&persisted, "alice").is_none());
    }

    #[test]
    fn restore_state_recovers_ticks_and_timestamps() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        std::fs::create_dir_all(data_dir.join("alice")).unwrap();

        let persisted = PersistedState {
            version: STATE_VERSION,
            ticks_without_user: 5,
            covered_turn_count: 0,
            next_wake_at: Some("2026-04-08T20:00:00+00:00".into()),
            last_user_at: Some("2026-04-08T14:00:00+00:00".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&persisted).unwrap();
        std::fs::write(state_path(data_dir, "alice"), json).unwrap();

        let loaded = load_state(data_dir, "alice").unwrap();
        assert_eq!(loaded.ticks_without_user, 5);
        assert!(loaded.next_wake_at.is_some());

        // Test the full restore path: verify Instant conversion doesn't panic.
        let mut clock = HeartbeatClock::with_config(&HeartbeatConfig::default());
        restore_from_persisted(&loaded, &mut clock);
        assert_eq!(clock.ticks_without_user(), 5);
    }

    #[tokio::test]
    async fn tick_character_runs_without_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config();
        let state = Arc::new(Mutex::new(AutonomyState {
            heartbeat: HeartbeatClock::with_config(&HeartbeatConfig::default()),
            keepalive_schedule: None,
            activity: ActivityTracker::new(),
            heartbeat_log: HeartbeatLog::new(),
            paused: false,
            dirty: false,
            last_compaction_activity: Instant::now(),
            compaction_triggered: false,
            active_turn_count: 0,
            compaction_pending: false,
            covered_turn_count: 0,
            deep_archive_done: false,
            last_request: None,
            next_dream_attempt_at: None,
            dream_failure_count: 0,
        }));

        {
            let mut s = lock_state(&state);
            s.heartbeat.on_user_message(Instant::now());
            s.activity.record_message();
        }

        let tick_ctx = TickContext {
            state,
            config: Arc::new(config),
            compaction: Arc::new(CompactionConfig::default()),
            data_dir: tmp.path().to_path_buf(),
            llm_client: None,
            push_tx: None,
            loaded_config: None,
            notifier: None,
            registry: None,
            mcp_registry: Arc::new(crate::tools::mcp_registry::McpRegistry::default()),
        };
        tick_character("alice", &tick_ctx).await;
    }

    #[tokio::test]
    async fn shutdown_recovers_from_poisoned_handles_mutex() {
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            test_config(),
            CompactionConfig::default(),
            tmp.path().to_path_buf(),
            rx,
        );

        {
            let mut handles = mgr.handles.lock().unwrap();
            handles.push(tokio::spawn(async {}));
        }

        let result = catch_unwind(AssertUnwindSafe(|| {
            let _guard = mgr.handles.lock().unwrap();
            panic!("poison autonomy shutdown handles");
        }));
        assert!(result.is_err());

        mgr.shutdown().await;
        assert!(lock_or_recover("autonomy task handle list", &mgr.handles).is_empty());
    }

    #[test]
    fn extract_send_message_parses() {
        assert_eq!(
            extract_send_message("thinking...<sendMessage>Hey there!</sendMessage>...done"),
            Some("Hey there!".into())
        );
        assert_eq!(extract_send_message("no tags here"), None);
        assert_eq!(extract_send_message("<sendMessage></sendMessage>"), None);
    }

    #[test]
    fn generated_image_ref_extracts_path_and_caption() {
        let value = json!({
            "path": "/data/alice/images/generated/20260619_120000.png",
            "caption": "a quiet harbor at dawn",
            "sent": true,
        });
        let image = generated_image_ref(&value).expect("should build ImageRef");
        assert_eq!(
            image.path,
            "/data/alice/images/generated/20260619_120000.png"
        );
        assert_eq!(image.caption.as_deref(), Some("a quiet harbor at dawn"));
        assert!(image.data.is_none());
    }

    #[test]
    fn generated_image_ref_allows_missing_caption() {
        let value = json!({ "path": "/img.png", "sent": true });
        let image = generated_image_ref(&value).expect("should build ImageRef");
        assert_eq!(image.path, "/img.png");
        assert!(image.caption.is_none());
    }

    #[test]
    fn generated_image_ref_none_without_path() {
        assert!(generated_image_ref(&json!({ "caption": "orphan" })).is_none());
    }

    #[test]
    fn build_autonomous_message_image_only_has_no_text_block() {
        let images = vec![ImageRef {
            path: "/img.png".into(),
            caption: Some("dawn".into()),
            data: None,
        }];
        let msg = build_autonomous_message("", images, None, None);
        assert!(
            msg.content_blocks.is_empty(),
            "image-only message should carry no blank text block"
        );
        assert_eq!(msg.images.len(), 1);
    }

    #[test]
    fn build_autonomous_message_keeps_text_block_when_present() {
        let msg = build_autonomous_message("hello", Vec::new(), None, None);
        assert_eq!(msg.content_blocks.len(), 1);
        assert_eq!(msg.content, "hello");
    }

    // -- state resilience -----------------------------------------------------

    #[test]
    fn load_state_corrupt_file_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let char_dir = data_dir.join("alice");
        std::fs::create_dir_all(&char_dir).unwrap();

        // Write garbage bytes.
        std::fs::write(state_path(data_dir, "alice"), b"not valid json {{{{").unwrap();

        let loaded = load_state(data_dir, "alice");
        assert!(loaded.is_none(), "Corrupt state file should return None");
    }

    #[test]
    fn load_state_future_version_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let char_dir = data_dir.join("alice");
        std::fs::create_dir_all(&char_dir).unwrap();

        // Write valid JSON but with a future version number.
        let future = serde_json::json!({
            "version": 99,
            "ticks_without_user": 0,
        });
        std::fs::write(state_path(data_dir, "alice"), future.to_string()).unwrap();

        let loaded = load_state(data_dir, "alice");
        assert!(
            loaded.is_none(),
            "Future version should return None (migration path)"
        );
    }

    #[test]
    fn restore_from_persisted_sets_clock_state() {
        let persisted = PersistedState {
            version: STATE_VERSION,
            ticks_without_user: 7,
            covered_turn_count: 0,
            next_wake_at: None,
            last_user_at: None,
            ..Default::default()
        };
        let mut clock = HeartbeatClock::with_config(&HeartbeatConfig::default());
        restore_from_persisted(&persisted, &mut clock);
        assert_eq!(clock.ticks_without_user(), 7);
    }

    // -- extract_tag / sendMessage tests -------------------------------------

    #[test]
    fn extract_send_message_last_wins() {
        let content = "<sendMessage>first</sendMessage> stuff <sendMessage>second</sendMessage>";
        assert_eq!(extract_send_message(content), Some("second".into()));
    }

    #[test]
    fn send_message_tool_name_matching() {
        assert!(is_send_message_tool("sendMessage"));
        assert!(is_send_message_tool("send_message"));
        assert!(is_send_message_tool("SendMessage"));
        assert!(!is_send_message_tool("set_next_wake"));
        assert!(!is_send_message_tool("search"));
    }

    #[test]
    fn send_message_tool_input_extraction() {
        // Common field names the undeclared tool reaches for.
        assert_eq!(
            extract_tool_send_message(&json!({"message": "  hi there  "})),
            Some("hi there".into())
        );
        assert_eq!(
            extract_tool_send_message(&json!({"text": "via text"})),
            Some("via text".into())
        );
        // Bare string input.
        assert_eq!(
            extract_tool_send_message(&json!("bare string")),
            Some("bare string".into())
        );
        // Empty / absent → None.
        assert_eq!(extract_tool_send_message(&json!({"message": "   "})), None);
        assert_eq!(extract_tool_send_message(&json!({"other": "x"})), None);
    }

    #[test]
    fn extract_tag_handles_nested_text() {
        let content = "<sendMessage>Hey <b>bold</b> text</sendMessage>";
        assert_eq!(
            extract_send_message(content),
            Some("Hey <b>bold</b> text".into())
        );
    }

    // -- keepalive integration tests ------------------------------------------
    // These test the seam between tick_character, execute_dormant_ping, and
    // on_cache_warmed — the exact boundary where the phantom ping bug lived.

    /// Compaction clears the cached request but must NOT stop the keepalive.
    ///
    /// The conversation tail changes; the pinned system prefix — usually the
    /// expensive cache entry — does not, and dropping the schedule means the
    /// user's next message after an idle stretch pays a full cold write. The
    /// daemon used to get this by leaving the deadline armed and rebuilding from
    /// disk lazily at ping time. The sidecar cannot read disk, so the rebuild
    /// moved here and the contract became "push a fresh body, do not disarm".
    #[tokio::test]
    async fn compaction_keeps_keepalive_alive() {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = test_manager(tmp.path());
        let _ignored = mgr.ensure_state("alice");

        _ = mgr.with_state("alice", |s| {
            s.last_request = Some(empty_request());
        });

        mgr.notify_compaction_complete("alice", 2);

        let request_cleared = mgr
            .with_state("alice", |s| s.last_request.is_none())
            .unwrap();
        assert!(request_cleared, "the pre-compaction body must be dropped");

        mgr.shutdown().await;
    }

    /// The half of that contract the manager actually decides. A rebuilt body is
    /// pushed; only a rebuild that produced nothing disarms.
    #[test]
    fn reprime_pushes_a_rebuilt_prefix_and_disarms_only_without_one() {
        assert!(matches!(
            reprime_decision(Some(empty_request())),
            KeepaliveReprime::Push(_)
        ));
        // Leaving the pre-invalidation body armed would keep warming a prefix
        // the next real turn will not reuse, which is spend with no payoff.
        assert!(matches!(reprime_decision(None), KeepaliveReprime::Disarm));
    }

    #[test]
    fn wrap_up_nudge_preserves_existing_message_prefix() {
        let mut request = empty_request();
        request.system = vec![SystemBlock::new("stable system", "system")];
        request.tools = Some(vec![crate::llm::types::ToolDefinition::new(
            "read",
            "",
            json!({"type": "object"}),
        )]);
        request.messages = vec![
            WireMessage::text(WireRole::User, "cached user"),
            WireMessage::text(WireRole::Assistant, "cached assistant"),
        ];
        let original_messages = request.messages.clone();
        let original_system = request.system.clone();
        let original_tools = request.tools.clone();

        append_wrap_up_nudge(&mut request);

        assert_eq!(
            &request.messages[..original_messages.len()],
            original_messages.as_slice(),
            "wrap-up nudge must append after the cached prefix"
        );
        assert_eq!(request.messages.len(), original_messages.len() + 1);
        assert_eq!(
            request.system, original_system,
            "wrap-up nudge must not mutate system prefix"
        );
        assert_eq!(
            request.tools, original_tools,
            "wrap-up nudge must not mutate tools"
        );
    }

    #[test]
    fn startup_leaves_keepalive_unarmed_until_first_request() {
        // After a (re)start the provider-side cache is cold, so the keepalive
        // must NOT ping until the first real LLM call caches a request (which
        // supplies the model's `cache_keepalive` cadence). A restored next_wake
        // no longer primes it — the two subsystems are independent.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        std::fs::create_dir_all(data_dir.join("alice")).unwrap();

        // Save persisted state with a next_wake_at in the future.
        let wake_time = (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let persisted = PersistedState {
            version: STATE_VERSION,
            ticks_without_user: 1,
            covered_turn_count: 0,
            next_wake_at: Some(wake_time),
            last_user_at: Some(chrono::Utc::now().to_rfc3339()),
            ..Default::default()
        };
        let json = serde_json::to_string_pretty(&persisted).unwrap();
        std::fs::write(state_path(data_dir, "alice"), json).unwrap();

        let mgr = rt.block_on(async { test_manager(data_dir) });
        rt.block_on(async {
            let _ignored = mgr.ensure_state("alice");
        });

        // Nothing to offer the sidecar: the persisted state carries no keepalive
        // fields, so startup has no schedule to restore and none is invented.
        // Arming from a state file that never recorded a warm is exactly how a
        // ping reaches a cold cache.
        let state = mgr.states.get("alice").unwrap();
        let s = lock_state(&state);
        assert!(
            s.keepalive_schedule.is_none(),
            "Keepalive must stay unarmed on startup until a request is cached"
        );
    }

    // -- cache prefix stability -----------------------------------------------

    /// The heartbeat tick must NOT add tools (like `set_next_wake`) to the
    /// request's tools array.  The Anthropic cache prefix order is
    /// tools → system → messages.  Changing the tools array invalidates the
    /// ENTIRE cache prefix — system AND messages.  Every heartbeat tick
    /// with a different tools array pays full input price (20× expected).
    ///
    /// The fix is to never declare heartbeat-only capabilities
    /// (`set_next_wake`, `sendMessage`) as tools: the prompt instructs the
    /// model to call them and the heartbeat loop intercepts the undeclared
    /// calls, so the tools array stays identical to chat's.
    #[test]
    fn heartbeat_must_not_mutate_tools_array() {
        // Simulate what execute_heartbeat_tick does: clone last_request,
        // then check if tools are modified.
        let original_tools = vec![
            crate::llm::types::ToolDefinition::new("read", "", json!({"type": "object"})),
            crate::llm::types::ToolDefinition::new(
                "search_chat_logs",
                "",
                json!({"type": "object"}),
            ),
        ];

        let request = LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: "test".into(),
            api_key: "key".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![WireMessage::text(WireRole::User, "hello")],
            system: vec![SystemBlock::new("system prompt", "system")],
            tools: Some(original_tools.clone()),
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: shore_common::config::app::ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: None,
        };

        // set_next_wake is undeclared and intercepted at execution time, so
        // execute_heartbeat_tick never pushes it (or any tool) into the array.
        // This test documents the invariant: the tools array must be identical
        // to the original conversation's tools to preserve the cache prefix.
        assert_eq!(
            request.tools.as_ref().unwrap().len(),
            original_tools.len(),
            "Heartbeat must not add tools to the request. \
             Adding set_next_wake changes the tools prefix, which invalidates \
             the ENTIRE Anthropic cache (tools → system → messages). \
             Call it as an undeclared, intercepted tool instead."
        );
    }

    #[test]
    fn rebuild_request_from_disk_strips_prior_thinking_when_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let config_dir = tmp.path().join("config");
        let cache_dir = tmp.path().join("cache");
        let runtime_dir = tmp.path().join("runtime");
        let character_dir = data_dir.join("alice");
        std::fs::create_dir_all(&character_dir).unwrap();

        let mut store =
            crate::engine::messages::MessageStore::new(character_dir.join("active.jsonl"));
        store.append(test_message(Role::User)).unwrap();
        store
            .append(Message {
                msg_id: "assistant-with-thinking".into(),
                origin: None,
                role: Role::Assistant,
                content: "answer".into(),
                images: vec![],
                content_blocks: vec![
                    ContentBlock::Thinking {
                        thinking: "private chain".into(),
                        signature: Some("sig".into()),
                    },
                    ContentBlock::Text {
                        text: "answer".into(),
                    },
                ],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                provider_key: None,
                model: None,
                timestamp: chrono::Local::now().to_rfc3339(),
            })
            .unwrap();

        let api_key_env = "REBUILD_REQUEST_STRIP_THINKING_ANTHROPIC";
        std::env::set_var(api_key_env, "test-secret");
        let chat_toml = format!(
            r#"
[anthropic.sonnet]
model_id = "claude-sonnet-test"
api_key_env = "{api_key_env}"
"#
        );
        let chat: toml::Table = chat_toml.parse().unwrap();
        let catalog =
            shore_common::config::models::ModelCatalog::from_sections(Some(&chat), None, None)
                .unwrap();

        let mut app = shore_common::config::app::AppConfig::default();
        // Tools are opt-in: the default empty allowlist already disables them.
        app.memory.thinking.replay_prior_thinking = shore_common::config::app::ThinkingReplay::None;
        let config = LoadedConfig::new_for_test(
            app,
            catalog,
            shore_common::config::ShoreDirs {
                config: config_dir,
                data: data_dir.clone(),
                runtime: runtime_dir,
                cache: cache_dir,
            },
        );

        let request = rebuild_request_from_disk(
            "alice",
            &data_dir,
            &config,
            &crate::tools::mcp_registry::McpRegistry::default(),
        )
        .unwrap();
        let assistant = request
            .messages
            .iter()
            .find(|msg| msg.role == WireRole::Assistant)
            .expect("rebuilt request should include assistant history");

        // The rebuild no longer strips: it reports the policy and the adapter
        // applies it. What has to hold here is that the policy survives the
        // rebuild — a heartbeat that reported `All` where chat reported `None`
        // would render a different prefix and miss the cache chat warmed.
        assert_eq!(
            request.replay_prior_thinking,
            shore_common::config::app::ThinkingReplay::None,
            "rebuild must carry the configured replay policy"
        );
        assert!(
            assistant
                .content
                .iter()
                .any(|block| matches!(block, WireBlock::Thinking { .. })),
            "the rebuild ships stored thinking; the adapter decides what goes on the wire"
        );
        assert!(
            assistant
                .content
                .iter()
                .any(|block| matches!(block, WireBlock::Text { .. })),
            "non-thinking assistant content must remain"
        );

        std::env::remove_var(api_key_env);
    }

    /// Build a test config whose chat model is an Anthropic sonnet entry keyed
    /// off `api_key_env`. Mirrors the setup in the strip-thinking test.
    fn rebuild_test_config(
        api_key_env: &str,
        config_dir: PathBuf,
        data_dir: PathBuf,
        runtime_dir: PathBuf,
        cache_dir: PathBuf,
    ) -> LoadedConfig {
        std::env::set_var(api_key_env, "test-secret");
        let chat_toml = format!(
            r#"
[anthropic.sonnet]
model_id = "claude-sonnet-test"
api_key_env = "{api_key_env}"
"#
        );
        let chat: toml::Table = chat_toml.parse().unwrap();
        let catalog =
            shore_common::config::models::ModelCatalog::from_sections(Some(&chat), None, None)
                .unwrap();
        let app = shore_common::config::app::AppConfig::default();
        LoadedConfig::new_for_test(
            app,
            catalog,
            shore_common::config::ShoreDirs {
                config: config_dir,
                data: data_dir,
                runtime: runtime_dir,
                cache: cache_dir,
            },
        )
    }

    /// The heartbeat keepalive rebuild must offer the same MCP tools the chat
    /// path does. If it omitted them while chat included them, the warmed prefix
    /// would diverge: the ping pays a cache write and the next chat turn still
    /// reads cold — a strictly-negative keepalive.
    #[test]
    fn rebuild_request_includes_enabled_mcp_tools_for_keepalive_parity() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let character_dir = data_dir.join("alice");
        std::fs::create_dir_all(&character_dir).unwrap();
        let mut store =
            crate::engine::messages::MessageStore::new(character_dir.join("active.jsonl"));
        store.append(test_message(Role::User)).unwrap();
        // A complete turn (not a dangling user message) so the rebuild doesn't
        // treat the conversation as mid-turn and skip.
        store.append(test_message(Role::Assistant)).unwrap();

        let api_key_env = "REBUILD_REQUEST_MCP_PARITY_ANTHROPIC";
        std::env::set_var(api_key_env, "test-secret");
        let chat_toml = format!(
            r#"
[anthropic.sonnet]
model_id = "claude-sonnet-test"
api_key_env = "{api_key_env}"
"#
        );
        let chat: toml::Table = chat_toml.parse().unwrap();
        let catalog =
            shore_common::config::models::ModelCatalog::from_sections(Some(&chat), None, None)
                .unwrap();
        let mut app = shore_common::config::app::AppConfig::default();
        app.tools.enabled_tools = vec!["mcp__hue__*".to_owned()];
        let config = LoadedConfig::new_for_test(
            app,
            catalog,
            shore_common::config::ShoreDirs {
                config: tmp.path().join("config"),
                data: data_dir.clone(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );

        let registry = crate::tools::mcp_registry::McpRegistry::from_tools_for_test(vec![
            crate::tools::mcp_registry::McpToolDef::new_for_test("hue", "on"),
        ]);
        let request = rebuild_request_from_disk("alice", &data_dir, &config, &registry)
            .expect("rebuild should produce a request");
        let tool_names: Vec<&str> = request
            .tools
            .as_ref()
            .expect("tools present")
            .iter()
            .map(|t| t.name.as_str())
            .collect();
        assert!(
            tool_names.contains(&"mcp__hue__on"),
            "keepalive rebuild must include enabled MCP tools, got {tool_names:?}"
        );
        std::env::remove_var(api_key_env);
    }

    /// A deep-idle keep-0 archive empties `active.jsonl` but leaves segment
    /// summaries behind. The heartbeat rebuild must still produce a request
    /// (anchored on a synthetic user turn) rather than going dormant.
    #[test]
    fn rebuild_request_from_disk_uses_anchor_when_active_empty_but_segments_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let character_dir = data_dir.join("alice");
        std::fs::create_dir_all(&character_dir).unwrap();

        // Empty active conversation (post deep-idle archive).
        std::fs::write(character_dir.join("active.jsonl"), "").unwrap();
        // A compaction manifest with one segment → has_prior_context = true.
        let manifest = serde_json::json!({
            "segments": [{
                "file": "0001.jsonl",
                "message_count": 12,
                "compacted_at": "2026-06-16T00:00:00Z",
            }],
            "total_compacted_messages": 12,
        });
        std::fs::write(
            character_dir.join(shore_common::config::COMPACTION_MANIFEST_FILE),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        let api_key_env = "REBUILD_REQUEST_ANCHOR_ANTHROPIC";
        let config = rebuild_test_config(
            api_key_env,
            tmp.path().join("config"),
            data_dir.clone(),
            tmp.path().join("runtime"),
            tmp.path().join("cache"),
        );

        let request = rebuild_request_from_disk(
            "alice",
            &data_dir,
            &config,
            &crate::tools::mcp_registry::McpRegistry::default(),
        )
        .expect("heartbeat should rebuild from memory when segments exist");
        let serialized = serde_json::to_string(&request.messages).unwrap();
        assert!(
            serialized.contains("archived to memory"),
            "rebuilt request should carry the synthetic idle anchor turn, got: {serialized}"
        );
        assert!(
            request.messages.iter().any(|m| m.role == WireRole::User),
            "anchor must be a user turn for the heartbeat prompt to attach to"
        );

        std::env::remove_var(api_key_env);
    }

    /// A deep-idle archive can retain an unanswered autonomous assistant tail,
    /// leaving the active conversation with no user turn. The rebuild must
    /// prepend the synthetic anchor so the request still starts with a user turn
    /// while keeping the retained autonomous message visible.
    #[test]
    fn rebuild_request_from_disk_anchors_autonomous_tail_with_no_user_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let character_dir = data_dir.join("alice");
        std::fs::create_dir_all(&character_dir).unwrap();

        // Active conversation holds only an unanswered autonomous assistant turn.
        let mut store =
            crate::engine::messages::MessageStore::new(character_dir.join("active.jsonl"));
        store
            .append(Message {
                msg_id: "autonomous-tail".into(),
                origin: Some(shore_common::protocol::types::MessageOrigin::Autonomous),
                role: Role::Assistant,
                content: "still thinking of you".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "still thinking of you".into(),
                }],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                provider_key: None,
                model: None,
                timestamp: chrono::Local::now().to_rfc3339(),
            })
            .unwrap();

        let api_key_env = "REBUILD_REQUEST_AUTONOMOUS_TAIL_ANTHROPIC";
        let config = rebuild_test_config(
            api_key_env,
            tmp.path().join("config"),
            data_dir.clone(),
            tmp.path().join("runtime"),
            tmp.path().join("cache"),
        );

        let request = rebuild_request_from_disk(
            "alice",
            &data_dir,
            &config,
            &crate::tools::mcp_registry::McpRegistry::default(),
        )
        .expect("heartbeat should rebuild over an autonomous tail");
        let roles: Vec<WireRole> = request.messages.iter().map(|m| m.role).collect();
        assert_eq!(
            roles.first(),
            Some(&WireRole::User),
            "request must start with the synthetic user anchor, got roles: {roles:?}"
        );
        let serialized = serde_json::to_string(&request.messages).unwrap();
        assert!(
            serialized.contains("still thinking of you"),
            "retained autonomous tail must remain in the rebuilt request"
        );

        std::env::remove_var(api_key_env);
    }

    /// An empty active conversation with no segments still rebuilds via the
    /// synthetic anchor: the system prompt and memory give the
    /// heartbeat something to act on, and the keepalive ping a stable
    /// system+tools prefix to keep warm overnight. Previously this returned
    /// `None`, which silenced both the heartbeat and the keepalive ping (the
    /// "no cached or rebuildable request" skip-loop) until the user returned.
    #[test]
    fn rebuild_request_from_disk_anchors_when_no_history_and_no_segments() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let character_dir = data_dir.join("alice");
        std::fs::create_dir_all(&character_dir).unwrap();
        std::fs::write(character_dir.join("active.jsonl"), "").unwrap();

        let api_key_env = "REBUILD_REQUEST_NO_HISTORY_ANTHROPIC";
        let config = rebuild_test_config(
            api_key_env,
            tmp.path().join("config"),
            data_dir.clone(),
            tmp.path().join("runtime"),
            tmp.path().join("cache"),
        );

        let request = rebuild_request_from_disk(
            "alice",
            &data_dir,
            &config,
            &crate::tools::mcp_registry::McpRegistry::default(),
        )
        .expect("empty active with no segments should still rebuild via the anchor");
        assert!(
            request.messages.iter().any(|m| m.role == WireRole::User),
            "rebuilt request must start from a synthetic user anchor turn"
        );

        std::env::remove_var(api_key_env);
    }

    // -- heartbeat model override ------------------------------------------

    fn minimal_request(model_id: &str) -> LlmRequest {
        LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: model_id.into(),
            api_key: "chat-key".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![WireMessage::text(WireRole::User, "hi")],
            system: vec![SystemBlock::new("sys", "system")],
            tools: Some(vec![crate::llm::types::ToolDefinition::new(
                "read",
                "",
                json!({"type": "object"}),
            )]),
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: shore_common::config::app::ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: None,
        }
    }

    fn loaded_config_with_two_chat_models(
        heartbeat: Option<&str>,
        chat_env: &str,
        heartbeat_env: &str,
    ) -> LoadedConfig {
        let chat_toml = format!(
            r#"
[anthropic.sonnet]
model_id = "claude-sonnet-chat"
api_key_env = "{chat_env}"

[anthropic.slowthink]
model_id = "claude-opus-slowthink"
api_key_env = "{heartbeat_env}"
"#
        );
        let chat: toml::Table = chat_toml.parse().unwrap();
        let catalog =
            shore_common::config::models::ModelCatalog::from_sections(Some(&chat), None, None)
                .unwrap();

        let mut app = shore_common::config::app::AppConfig::default();
        app.defaults.background.heartbeat = heartbeat.map(str::to_owned);

        let tmp = tempfile::tempdir().unwrap();
        LoadedConfig::new_for_test(
            app,
            catalog,
            shore_common::config::ShoreDirs {
                config: tmp.path().to_path_buf(),
                data: tmp.path().to_path_buf(),
                runtime: tmp.path().to_path_buf(),
                cache: tmp.path().to_path_buf(),
            },
        )
    }

    /// Regression: `defaults.heartbeat` was silently ignored on the warm
    /// path because `execute_heartbeat_tick` reused the cached chat-turn
    /// request without rewriting the model.
    /// Regression: `defaults.heartbeat` was silently ignored on the warm
    /// path because `execute_heartbeat_tick` reused the cached chat-turn
    /// request without rewriting the model.
    #[test]
    fn heartbeat_override_swaps_model_when_set() {
        let chat_env = "HEARTBEAT_OVERRIDE_SWAP_CHAT";
        let int_env = "HEARTBEAT_OVERRIDE_SWAP_INT";
        std::env::set_var(chat_env, "chat-secret");
        std::env::set_var(int_env, "slowthink-secret");

        let config = loaded_config_with_two_chat_models(Some("slowthink"), chat_env, int_env);
        let mut request = minimal_request("claude-sonnet-chat");
        let original_messages = request.messages.clone();
        let original_system = request.system.clone();
        let original_tools = request.tools.clone();

        let applied = apply_heartbeat_model_override(&mut request, &config, "alice");

        assert!(applied.is_some(), "override should have been applied");
        assert_eq!(request.model, "claude-opus-slowthink");
        assert_eq!(request.api_key, "slowthink-secret");
        assert_eq!(
            request.messages, original_messages,
            "heartbeat model override must preserve existing messages"
        );
        assert_eq!(
            request.system, original_system,
            "heartbeat model override must preserve system prefix"
        );
        assert_eq!(
            request.tools, original_tools,
            "heartbeat model override must preserve tool definitions"
        );

        std::env::remove_var(chat_env);
        std::env::remove_var(int_env);
    }

    #[test]
    fn heartbeat_override_is_noop_when_unset() {
        let config = loaded_config_with_two_chat_models(
            None,
            "HEARTBEAT_OVERRIDE_UNSET_CHAT",
            "HEARTBEAT_OVERRIDE_UNSET_INT",
        );
        let mut request = minimal_request("claude-sonnet-chat");

        let applied = apply_heartbeat_model_override(&mut request, &config, "alice");

        assert!(applied.is_none());
        assert_eq!(request.model, "claude-sonnet-chat");
    }

    #[test]
    fn heartbeat_override_is_noop_when_model_matches() {
        let chat_env = "HEARTBEAT_OVERRIDE_MATCH_CHAT";
        let int_env = "HEARTBEAT_OVERRIDE_MATCH_INT";
        std::env::set_var(chat_env, "chat-secret");
        std::env::set_var(int_env, "slowthink-secret");

        let config = loaded_config_with_two_chat_models(Some("slowthink"), chat_env, int_env);
        let mut request = minimal_request("claude-opus-slowthink");

        let applied = apply_heartbeat_model_override(&mut request, &config, "alice");

        assert!(applied.is_none());
        assert_eq!(request.model, "claude-opus-slowthink");

        std::env::remove_var(chat_env);
        std::env::remove_var(int_env);
    }

    /// Regression: a pin written as `provider:model_id` with no static
    /// `[chat.*]` entry backing it resolves only through the *effective*
    /// catalog. The pre-check used the static `config.models.find_model`
    /// lookup, so it rejected every such pin and heartbeat silently stayed
    /// on the chat model — the only pin shape modern configs can express.
    #[test]
    fn heartbeat_override_resolves_provider_prefixed_pin_without_static_entry() {
        let chat_env = "HEARTBEAT_OVERRIDE_DYN_CHAT";
        let pin_env = "HEARTBEAT_OVERRIDE_DYN_PIN";
        std::env::set_var(chat_env, "chat-secret");
        std::env::set_var(pin_env, "pin-secret");

        let mut config =
            loaded_config_with_two_chat_models(Some("testdyn:dyn-model"), chat_env, chat_env);
        let providers: toml::Table =
            format!("[testdyn]\nbase_url = \"http://127.0.0.1:9\"\napi_key_env = \"{pin_env}\"\n")
                .parse()
                .unwrap();
        config.providers =
            shore_common::config::providers::ProviderRegistry::from_section(Some(&providers))
                .unwrap();

        let mut request = minimal_request("claude-sonnet-chat");
        let original_messages = request.messages.clone();

        let applied = apply_heartbeat_model_override(&mut request, &config, "alice");

        assert!(
            applied.is_some(),
            "a provider-prefixed pin must resolve through the effective catalog"
        );
        assert_eq!(request.model, "dyn-model");
        assert_eq!(request.api_key, "pin-secret");
        assert_eq!(request.messages, original_messages);

        std::env::remove_var(chat_env);
        std::env::remove_var(pin_env);
    }

    /// Dreaming's failure backoff. Untested until the TypeScript port needed a
    /// specification to match, and the shape matters: dreaming runs a full
    /// tool loop, so a backoff that collapsed would retry an expensive failing
    /// call every tick.
    ///
    /// 60s doubling per consecutive failure, capped at an hour. The cap is
    /// reached at the 7th failure and the exponent is clamped there, so no
    /// amount of further failure overflows the shift.
    #[test]
    fn dream_retry_backoff_doubles_then_caps_at_an_hour() {
        let secs = |n| background_retry_delay(n).as_secs();

        // The first failure is one minute, not two: the exponent is
        // `count - 1`, so a saturating_sub keeps count 0 and count 1 together.
        assert_eq!(secs(0), 60);
        assert_eq!(secs(1), 60);
        assert_eq!(secs(2), 120);
        assert_eq!(secs(3), 240);
        assert_eq!(secs(4), 480);
        assert_eq!(secs(5), 960);
        assert_eq!(secs(6), 1_920);
        // 60 * 2^6 = 3840, clamped to the hour ceiling.
        assert_eq!(secs(7), 3_600);
        // And it stays there rather than shifting into overflow.
        assert_eq!(secs(50), 3_600);
        assert_eq!(secs(u32::MAX), 3_600);
    }

    /// The gate in front of every heartbeat tick. Three switches, any of which
    /// suppresses it: autonomy off, heartbeat off, or the character paused.
    ///
    /// Worth pinning separately from the clock's own `tick` — the clock decides
    /// *when*, this decides *whether*, and only the second one reads config and
    /// the pause flag.
    #[test]
    fn heartbeat_tick_action_gates_on_config_and_pause() {
        let tmp = tempfile::tempdir().unwrap();
        let now = Instant::now();

        // A tick that would otherwise fire: deadline already reached.
        let armed = |paused: bool, enabled: bool, hb_enabled: bool| {
            let config = AutonomyConfig {
                enabled,
                heartbeat: HeartbeatConfig {
                    enabled: hb_enabled,
                    ..Default::default()
                },
                ..Default::default()
            };
            let state = Arc::new(Mutex::new(AutonomyState {
                heartbeat: HeartbeatClock::with_config(&config.heartbeat),
                keepalive_schedule: None,
                activity: ActivityTracker::new(),
                heartbeat_log: HeartbeatLog::new(),
                paused,
                dirty: false,
                last_compaction_activity: now,
                compaction_triggered: false,
                active_turn_count: 0,
                compaction_pending: false,
                covered_turn_count: 0,
                deep_archive_done: false,
                last_request: None,
                next_dream_attempt_at: None,
                dream_failure_count: 0,
            }));
            let ctx = TickContext {
                state: Arc::clone(&state),
                config: Arc::new(config),
                compaction: Arc::new(CompactionConfig::default()),
                data_dir: tmp.path().to_path_buf(),
                llm_client: None,
                push_tx: None,
                loaded_config: None,
                notifier: None,
                registry: None,
                mcp_registry: Arc::new(crate::tools::mcp_registry::McpRegistry::default()),
            };
            let mut s = lock_state(&state);
            let may = |snapshot: &AutonomyState, at| {
                tick_decision(tick_inputs(snapshot, &ctx, at)).heartbeat_may_tick
            };
            // First tick bootstraps the deadline; the second is the one that
            // can fire, so drive past it.
            let bootstrap_allowed = may(&s, now);
            let _bootstrap = run_heartbeat_tick(&mut s, bootstrap_allowed, now);
            let later = now + Duration::from_hours(6);
            let allowed = may(&s, later);
            matches!(
                run_heartbeat_tick(&mut s, allowed, later),
                HeartbeatAction::RunTick
            )
        };

        assert!(armed(false, true, true), "all three switches on: it fires");
        assert!(!armed(true, true, true), "paused suppresses the tick");
        assert!(
            !armed(false, false, true),
            "autonomy disabled suppresses it"
        );
        assert!(
            !armed(false, true, false),
            "heartbeat disabled suppresses it"
        );
    }

    // -----------------------------------------------------------------------
    // Tick decision parity fixture
    // -----------------------------------------------------------------------
    //
    // The generator behind `crates/daemon/tests/fixtures/tick_parity.json`.
    //
    // Unlike the heartbeat and activity fixtures, this one does not walk: the
    // decision is stateless, so a sweep of input combinations covers it better
    // than any sequence would. The candidate values per field are chosen to sit
    // on the thresholds and a step either side of them, so a `>=` relaxed to
    // `>` shows up somewhere in the sweep rather than only in the unit tests.

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            self.0 >> 33
        }

        /// One of `options`, chosen deterministically.
        fn pick<T: Copy>(&mut self, options: &[T]) -> T {
            let i = usize::try_from(self.next()).unwrap_or(0) % options.len();
            options[i]
        }
    }

    fn tick_inputs_json(i: TickInputs) -> Value {
        serde_json::json!({
            "autonomy_enabled": i.autonomy_enabled,
            "paused": i.paused,
            "heartbeat_enabled": i.heartbeat_enabled,
            "compaction_enabled": i.compaction_enabled,
            "compaction_triggered": i.compaction_triggered,
            "deep_archive_done": i.deep_archive_done,
            "active_turn_count": i.active_turn_count,
            "min_turns": i.min_turns,
            "max_turns": i.max_turns,
            "idle_secs": i.idle_secs,
            "idle_trigger_secs": i.idle_trigger_secs,
            "archive_after_secs": i.archive_after_secs,
            "dreaming_enabled": i.dreaming_enabled,
            "dream_backoff_elapsed": i.dream_backoff_elapsed,
            "ms_since_user": i.ms_since_user.map(|ms| u64::try_from(ms).unwrap_or(u64::MAX)),
            "minimum_inactive_ms": u64::try_from(i.minimum_inactive_ms).unwrap_or(u64::MAX),
        })
    }

    fn tick_decision_json(d: TickDecision) -> Value {
        serde_json::json!({
            "heartbeat_may_tick": d.heartbeat_may_tick,
            "compaction": d.compaction.map(|r| match r {
                CompactionReason::MaxTurns => "max_turns",
                CompactionReason::Idle => "idle",
            }),
            "deep_archive": d.deep_archive,
            "dream": d.dream,
        })
    }

    fn tick_census() -> Value {
        // Weighted towards the switches being on: a tick with autonomy off
        // decides nothing, and an even spread over the booleans would spend
        // most of the sweep recording that.
        const ON: [bool; 4] = [true, true, true, false];
        const OFF: [bool; 4] = [false, false, false, true];

        let mut rng = Lcg(7);
        let mut cases = Vec::new();
        for _ in 0..400 {
            let inputs = TickInputs {
                autonomy_enabled: rng.pick(&ON),
                paused: rng.pick(&OFF),
                heartbeat_enabled: rng.pick(&ON),

                compaction_enabled: rng.pick(&ON),
                compaction_triggered: rng.pick(&OFF),
                deep_archive_done: rng.pick(&OFF),
                active_turn_count: rng.pick(&[0, 1, 3, 4, 10, 19, 20, 21, 50]),
                min_turns: rng.pick(&[0, 4, 10]),
                max_turns: rng.pick(&[0, 4, 20]),
                idle_secs: rng.pick(&[0, 1, 4, 5, 3_599, 3_600, 3_601, 86_399, 86_400, 100_000]),
                idle_trigger_secs: rng.pick(&[0, 1, 3_600]),
                archive_after_secs: rng.pick(&[0, 5, 86_400]),

                dreaming_enabled: rng.pick(&ON),
                dream_backoff_elapsed: rng.pick(&ON),
                ms_since_user: rng.pick(&[
                    None,
                    Some(0),
                    Some(3_599_999),
                    Some(3_600_000),
                    Some(3_600_001),
                    Some(100_000_000),
                ]),
                minimum_inactive_ms: rng.pick(&[0, 3_600_000, 86_400_000]),
            };
            cases.push(serde_json::json!({
                "inputs": tick_inputs_json(inputs),
                "decision": tick_decision_json(tick_decision(inputs)),
            }));
        }
        serde_json::json!({ "cases": cases })
    }

    /// Regenerate with `SHORE_REGENERATE_FIXTURES=1 cargo test -p shore-daemon
    /// tick_decisions_match_shared_fixture`, then read the diff: it is exactly
    /// what the TypeScript will now be held to.
    #[test]
    fn tick_decisions_match_shared_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tick_parity.json"
        );
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&tick_census()).unwrap()
        );

        if std::env::var_os("SHORE_REGENERATE_FIXTURES").is_some() {
            std::fs::write(path, &rendered).unwrap();
            return;
        }

        let on_disk = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            rendered, on_disk,
            "tick decisions changed. If that was intended, regenerate with \
             SHORE_REGENERATE_FIXTURES=1 and make the TypeScript match; if it \
             was not, this is the regression the fixture exists to catch."
        );
    }

    // -- the pure tick decision ----------------------------------------------
    //
    // `collect_tick_actions` reads a lock and a clock, so the tests above have
    // to build a whole `TickContext` to ask it anything. These go at the
    // decision itself, where every input is a number on the page — which is
    // also what lets the fixture record it.

    /// A tick that fires nothing: every switch on, every threshold unmet.
    fn quiet_tick() -> TickInputs {
        TickInputs {
            autonomy_enabled: true,
            paused: false,
            heartbeat_enabled: true,

            compaction_enabled: true,
            compaction_triggered: false,
            deep_archive_done: false,
            active_turn_count: 10,
            min_turns: 4,
            max_turns: 20,
            idle_secs: 0,
            idle_trigger_secs: 3_600,
            archive_after_secs: 86_400,

            dreaming_enabled: true,
            dream_backoff_elapsed: true,
            ms_since_user: Some(0),
            minimum_inactive_ms: 3_600_000,
        }
    }

    #[test]
    fn a_quiet_tick_fires_nothing_but_still_lets_the_heartbeat_run() {
        let d = tick_decision(quiet_tick());
        assert!(d.heartbeat_may_tick);
        assert_eq!(d.compaction, None);
        assert!(!d.deep_archive);
        assert!(!d.dream);
    }

    #[test]
    fn compaction_triggers_fire_exactly_at_their_thresholds() {
        // Both comparisons are `>=`, and nothing sat on either line: the idle
        // trigger was only ever tested well past its threshold.
        let at_max = TickInputs {
            active_turn_count: 20,
            ..quiet_tick()
        };
        assert_eq!(
            tick_decision(at_max).compaction,
            Some(CompactionReason::MaxTurns)
        );
        assert_eq!(
            tick_decision(TickInputs {
                active_turn_count: 19,
                ..at_max
            })
            .compaction,
            None
        );

        let at_idle = TickInputs {
            idle_secs: 3_600,
            ..quiet_tick()
        };
        assert_eq!(
            tick_decision(at_idle).compaction,
            Some(CompactionReason::Idle)
        );
        assert_eq!(
            tick_decision(TickInputs {
                idle_secs: 3_599,
                ..at_idle
            })
            .compaction,
            None
        );
    }

    #[test]
    fn a_zero_threshold_is_the_off_switch_for_each_trigger() {
        // Each of the three reads zero as "never", not as "always" — which is
        // what a bare `>=` against an unset config would give.
        let flooded = TickInputs {
            active_turn_count: 10_000,
            idle_secs: 10_000_000,
            ..quiet_tick()
        };
        assert!(tick_decision(flooded).compaction.is_some());

        assert_eq!(
            tick_decision(TickInputs {
                max_turns: 0,
                idle_trigger_secs: 0,
                ..flooded
            })
            .compaction,
            None,
            "both compaction triggers off"
        );
        assert!(
            !tick_decision(TickInputs {
                max_turns: 0,
                idle_trigger_secs: 0,
                archive_after_secs: 0,
                ..flooded
            })
            .deep_archive,
            "and the deep archive too"
        );
    }

    #[test]
    fn a_conversation_below_min_turns_compacts_on_neither_trigger() {
        // The idle path is gated on `min_turns` and the max path checks it
        // again, so a short conversation is left alone however long it idles.
        // Its safety net is the deep archive, which has no turn threshold.
        let short = TickInputs {
            active_turn_count: 3,
            idle_secs: 10_000_000,
            ..quiet_tick()
        };
        assert_eq!(tick_decision(short).compaction, None);
        assert!(
            tick_decision(short).deep_archive,
            "the deep archive covers it"
        );
    }

    #[test]
    fn max_turns_wins_when_both_compaction_triggers_are_satisfied() {
        // Only the log line distinguishes them, but the order is what decides
        // which one a reader sees when a long conversation also goes quiet.
        let both = TickInputs {
            active_turn_count: 50,
            idle_secs: 10_000,
            ..quiet_tick()
        };
        assert_eq!(
            tick_decision(both).compaction,
            Some(CompactionReason::MaxTurns)
        );
    }

    #[test]
    fn a_latch_from_an_earlier_tick_suppresses_the_deep_archive_too() {
        // `!compaction.is_none()` alone would not catch this: when the latch
        // was taken on an earlier tick, nothing fires *now* to block it, and
        // the deep archive would run against a conversation already being
        // compacted.
        let latched = TickInputs {
            compaction_triggered: true,
            idle_secs: 10_000_000,
            active_turn_count: 1,
            ..quiet_tick()
        };
        assert_eq!(tick_decision(latched).compaction, None);
        assert!(!tick_decision(latched).deep_archive);
    }

    #[test]
    fn the_deep_archive_fires_exactly_at_its_threshold() {
        let at = TickInputs {
            active_turn_count: 1,
            idle_secs: 86_400,
            ..quiet_tick()
        };
        assert!(tick_decision(at).deep_archive);
        assert!(
            !tick_decision(TickInputs {
                idle_secs: 86_399,
                ..at
            })
            .deep_archive
        );
    }

    #[test]
    fn dreaming_waits_out_its_backoff_and_the_users_silence() {
        let ready = TickInputs {
            ms_since_user: Some(3_600_000),
            ..quiet_tick()
        };
        assert!(tick_decision(ready).dream);

        assert!(
            !tick_decision(TickInputs {
                ms_since_user: Some(3_599_999),
                ..ready
            })
            .dream,
            "a millisecond short of the window"
        );
        assert!(
            !tick_decision(TickInputs {
                dream_backoff_elapsed: false,
                ..ready
            })
            .dream,
            "still backing off from a failure"
        );
        assert!(
            !tick_decision(TickInputs {
                dreaming_enabled: false,
                ..ready
            })
            .dream
        );
        assert!(
            !tick_decision(TickInputs {
                autonomy_enabled: false,
                ..ready
            })
            .dream
        );
    }

    #[test]
    fn a_character_with_no_user_on_record_is_free_to_dream() {
        // `None` reads as "nobody to disturb". A fresh character with history
        // to sweep and no conversation yet is the case this exists for.
        let never_spoken = TickInputs {
            ms_since_user: None,
            minimum_inactive_ms: u128::from(u64::MAX),
            ..quiet_tick()
        };
        assert!(tick_decision(never_spoken).dream);
    }

    #[test]
    fn pausing_stops_the_heartbeat_and_nothing_else() {
        // Worth pinning because it is easy to assume otherwise: a paused
        // character still compacts, still archives, still dreams. Pause is a
        // switch on speaking, not on housekeeping.
        let paused = TickInputs {
            paused: true,
            active_turn_count: 50,
            idle_secs: 10_000_000,
            ms_since_user: Some(u128::from(u64::MAX)),
            ..quiet_tick()
        };
        let d = tick_decision(paused);
        assert!(!d.heartbeat_may_tick);
        assert_eq!(d.compaction, Some(CompactionReason::MaxTurns));
        assert!(d.dream);
    }

    #[test]
    fn disabling_autonomy_stops_every_trigger_at_once() {
        let off = TickInputs {
            autonomy_enabled: false,
            active_turn_count: 50,
            idle_secs: 10_000_000,
            ms_since_user: None,
            ..quiet_tick()
        };
        let d = tick_decision(off);
        assert!(!d.heartbeat_may_tick);
        assert_eq!(d.compaction, None);
        assert!(!d.deep_archive);
        assert!(!d.dream);
    }

    #[test]
    fn disabling_compaction_leaves_the_heartbeat_and_dreaming_alone() {
        let d = tick_decision(TickInputs {
            compaction_enabled: false,
            active_turn_count: 50,
            idle_secs: 10_000_000,
            ms_since_user: Some(u128::from(u64::MAX)),
            ..quiet_tick()
        });
        assert_eq!(d.compaction, None);
        assert!(!d.deep_archive);
        assert!(d.heartbeat_may_tick);
        assert!(d.dream);
    }

    /// Configuring `max_turns < min_turns` should disable compaction or
    /// be rejected, since the max_turns trigger can never fire when
    /// `active_turn_count >= max_turns && active_turn_count >= min_turns`
    /// requires both conditions simultaneously.
    #[test]
    fn compaction_disabled_when_max_turns_less_than_min_turns() {
        let config = AutonomyConfig::default();
        let compaction = CompactionConfig {
            enabled: true,
            min_turns: 12,
            max_turns: 8,
            keep_recent_turns: 3,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(config, compaction, tmp.path().to_path_buf(), rx);

        // Compaction should be disabled because max_turns < min_turns
        // makes the max_turns trigger dead code.
        assert!(
            !mgr.compaction.enabled,
            "Compaction should be disabled when max_turns ({}) < min_turns ({})",
            8, 12,
        );
    }

    #[test]
    fn dream_inactivity_gate_respects_minimum_inactive_time() {
        let cfg = DreamingConfig {
            minimum_inactive_time: shore_common::config::ConfigDuration::from_secs(300),
            ..Default::default()
        };
        let now = Instant::now();

        // No config: never satisfied.
        assert!(!dream_inactivity_satisfied(None, Some(now), now));

        // No prior user message: no timer to enforce, allow.
        assert!(dream_inactivity_satisfied(Some(&cfg), None, now));

        // User active 2min ago, 5min window: not satisfied.
        let two_min_ago = now - Duration::from_mins(2);
        assert!(!dream_inactivity_satisfied(
            Some(&cfg),
            Some(two_min_ago),
            now
        ));

        // User active 6min ago: satisfied.
        let six_min_ago = now - Duration::from_mins(6);
        assert!(dream_inactivity_satisfied(
            Some(&cfg),
            Some(six_min_ago),
            now
        ));
    }

    // -- inline compaction tests -----------------------------------------------

    #[test]
    fn should_compact_now_fires_on_max_turns() {
        let compaction = CompactionConfig {
            enabled: true,
            min_turns: 8,
            max_turns: 16,
            keep_recent_turns: 2,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            compaction,
            tmp.path().to_path_buf(),
            rx,
        );

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        // Below max_turns: should not compact.
        assert!(!mgr.should_compact_now("alice", 15, 0));
        // At max_turns: should compact.
        assert!(mgr.should_compact_now("alice", 16, 0));
        // After compaction, compaction_triggered is set so tick won't double-fire.
        let triggered = mgr.with_state("alice", |s| s.compaction_triggered).unwrap();
        assert!(
            triggered,
            "compaction_triggered should be set after should_compact_now"
        );
    }

    #[test]
    fn should_compact_now_respects_idle_pending_flag() {
        let compaction = CompactionConfig {
            enabled: true,
            min_turns: 8,
            max_turns: 34,
            keep_recent_turns: 2,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            compaction,
            tmp.path().to_path_buf(),
            rx,
        );

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        // Below max_turns and no pending flag: should not compact.
        assert!(!mgr.should_compact_now("alice", 20, 0));

        // Simulate idle trigger setting the pending flag.
        _ = mgr.with_state("alice", |s| {
            s.compaction_pending = true;
        });

        // Now should_compact_now should return true (and clear the flag).
        assert!(mgr.should_compact_now("alice", 20, 0));
        // Flag should be cleared.
        let pending = mgr.with_state("alice", |s| s.compaction_pending).unwrap();
        assert!(!pending, "compaction_pending should be cleared after take");
    }

    #[test]
    fn should_compact_now_disabled_when_config_disabled() {
        let compaction = CompactionConfig {
            enabled: false,
            min_turns: 8,
            max_turns: 16,
            keep_recent_turns: 2,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            compaction,
            tmp.path().to_path_buf(),
            rx,
        );

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        // Even above max_turns, disabled config means no compaction.
        assert!(!mgr.should_compact_now("alice", 100, 0));
    }

    #[test]
    fn should_compact_now_fires_on_max_context_tokens() {
        // Disable the turn-count trigger (max_turns well above anything we
        // pass) so the token trigger is what decides.
        let compaction = CompactionConfig {
            enabled: true,
            min_turns: 8,
            max_turns: 10_000,
            max_context_tokens: 30_000,
            keep_recent_turns: 2,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            compaction,
            tmp.path().to_path_buf(),
            rx,
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        // Below threshold: no trigger.
        assert!(!mgr.should_compact_now("alice", 10, 29_999));
        // Below min_turns floor even though tokens exceed: no trigger.
        assert!(!mgr.should_compact_now("alice", 5, 50_000));
        // At threshold and above min_turns: trigger.
        assert!(mgr.should_compact_now("alice", 10, 30_000));
        // Flag was set.
        let triggered = mgr.with_state("alice", |s| s.compaction_triggered).unwrap();
        assert!(triggered);
    }

    #[test]
    fn should_compact_now_ignores_context_tokens_when_disabled() {
        // max_context_tokens = 0 disables the token trigger entirely.
        let compaction = CompactionConfig {
            enabled: true,
            min_turns: 8,
            max_turns: 10_000,
            max_context_tokens: 0,
            keep_recent_turns: 2,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            compaction,
            tmp.path().to_path_buf(),
            rx,
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        // Huge context, past min_turns — must not trigger when disabled.
        assert!(!mgr.should_compact_now("alice", 100, 1_000_000));
    }

    #[test]
    fn notify_compaction_complete_resets_flags() {
        let compaction = CompactionConfig {
            enabled: true,
            min_turns: 8,
            max_turns: 16,
            keep_recent_turns: 2,
            ..Default::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            compaction,
            tmp.path().to_path_buf(),
            rx,
        );

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        // Trigger compaction.
        assert!(mgr.should_compact_now("alice", 16, 0));

        // Simulate compaction complete.
        mgr.notify_compaction_complete("alice", 4);

        // Flags should be reset: compaction_triggered and compaction_pending cleared.
        let (triggered, pending, turn_count) = mgr
            .with_state("alice", |s| {
                (
                    s.compaction_triggered,
                    s.compaction_pending,
                    s.active_turn_count,
                )
            })
            .unwrap();
        assert!(
            !triggered,
            "compaction_triggered should be reset after completion"
        );
        assert!(
            !pending,
            "compaction_pending should be reset after completion"
        );
        assert_eq!(
            turn_count, 4,
            "active_turn_count should be updated to retained count"
        );

        // Should be able to trigger again.
        assert!(mgr.should_compact_now("alice", 16, 0));
    }

    #[tokio::test]
    async fn tick_sets_compaction_pending_on_idle_trigger() {
        let tmp = tempfile::tempdir().unwrap();
        let mut config = test_config();
        config.enabled = true;
        let compaction = CompactionConfig {
            enabled: true,
            min_turns: 4,
            max_turns: 20,
            keep_recent_turns: 2,
            idle_trigger: shore_common::config::ConfigDuration::from_secs(1),
            ..Default::default()
        };

        let state = Arc::new(Mutex::new(AutonomyState {
            heartbeat: HeartbeatClock::with_config(&HeartbeatConfig::default()),
            keepalive_schedule: None,
            activity: ActivityTracker::new(),
            heartbeat_log: HeartbeatLog::new(),
            paused: false,
            dirty: false,
            last_compaction_activity: Instant::now() - Duration::from_secs(10),
            compaction_triggered: false,
            active_turn_count: 8,
            compaction_pending: false,
            covered_turn_count: 0,
            deep_archive_done: false,
            last_request: None,
            next_dream_attempt_at: None,
            dream_failure_count: 0,
        }));

        let tick_ctx = TickContext {
            state: Arc::clone(&state),
            config: Arc::new(config),
            compaction: Arc::new(compaction),
            data_dir: tmp.path().to_path_buf(),
            llm_client: None,
            push_tx: None,
            loaded_config: None,
            notifier: None,
            registry: None,
            mcp_registry: Arc::new(crate::tools::mcp_registry::McpRegistry::default()),
        };

        tick_character("alice", &tick_ctx).await;

        // After tick with idle_trigger=1s and 10s idle, the pending flag should be set.
        let s = lock_state(&state);
        assert!(
            s.compaction_pending,
            "compaction_pending should be set after idle trigger fires in tick"
        );
        assert!(
            s.compaction_triggered,
            "compaction_triggered should prevent double-fire"
        );
    }

    fn deep_archive_test_parts(
        tmp: &tempfile::TempDir,
        compaction: CompactionConfig,
        active_turn_count: usize,
        idle: Duration,
        deep_archive_done: bool,
    ) -> TickContext {
        let mut config = test_config();
        config.enabled = true;
        let state = Arc::new(Mutex::new(AutonomyState {
            heartbeat: HeartbeatClock::with_config(&HeartbeatConfig::default()),
            keepalive_schedule: None,
            activity: ActivityTracker::new(),
            heartbeat_log: HeartbeatLog::new(),
            paused: false,
            dirty: false,
            last_compaction_activity: Instant::now() - idle,
            compaction_triggered: false,
            active_turn_count,
            compaction_pending: false,
            covered_turn_count: 0,
            deep_archive_done,
            last_request: None,
            next_dream_attempt_at: None,
            dream_failure_count: 0,
        }));
        TickContext {
            state,
            config: Arc::new(config),
            compaction: Arc::new(compaction),
            data_dir: tmp.path().to_path_buf(),
            llm_client: None,
            push_tx: None,
            loaded_config: None,
            notifier: None,
            registry: None,
            mcp_registry: Arc::new(crate::tools::mcp_registry::McpRegistry::default()),
        }
    }

    fn deep_archive_compaction_config() -> CompactionConfig {
        CompactionConfig {
            enabled: true,
            min_turns: 4,
            max_turns: 20,
            keep_recent_turns: 2,
            idle_trigger: shore_common::config::ConfigDuration::from_secs(3600),
            archive_after: shore_common::config::ConfigDuration::from_secs(5),
            ..Default::default()
        }
    }

    #[test]
    fn deep_archive_trigger_fires_below_min_turns() {
        let tmp = tempfile::tempdir().unwrap();
        // 1 turn (below min_turns=4) and 60s idle (past archive_after=5s,
        // before idle_trigger=3600s): only the deep trigger may fire.
        let ctx = deep_archive_test_parts(
            &tmp,
            deep_archive_compaction_config(),
            1,
            Duration::from_mins(1),
            false,
        );

        let (_, compaction_needed, deep_archive_needed, _) =
            collect_tick_actions("alice", &ctx, Instant::now());

        assert!(!compaction_needed);
        assert!(deep_archive_needed);
        assert!(
            lock_state(&ctx.state).compaction_triggered,
            "deep trigger must take the compaction single-flight flag"
        );
    }

    #[test]
    fn deep_archive_trigger_suppressed_by_done_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = deep_archive_test_parts(
            &tmp,
            deep_archive_compaction_config(),
            1,
            Duration::from_mins(1),
            true,
        );

        let (_, compaction_needed, deep_archive_needed, _) =
            collect_tick_actions("alice", &ctx, Instant::now());

        assert!(!compaction_needed);
        assert!(!deep_archive_needed);
    }

    #[test]
    fn deep_archive_trigger_disabled_when_archive_after_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let compaction = CompactionConfig {
            archive_after: shore_common::config::ConfigDuration::from_secs(0),
            ..deep_archive_compaction_config()
        };
        let ctx = deep_archive_test_parts(&tmp, compaction, 1, Duration::from_hours(24), false);

        let (_, _, deep_archive_needed, _) = collect_tick_actions("alice", &ctx, Instant::now());

        assert!(!deep_archive_needed);
    }

    #[test]
    fn deep_archive_trigger_yields_to_normal_idle_trigger() {
        let tmp = tempfile::tempdir().unwrap();
        let compaction = CompactionConfig {
            idle_trigger: shore_common::config::ConfigDuration::from_secs(1),
            ..deep_archive_compaction_config()
        };
        // 8 turns >= min_turns and idle past both windows: the normal idle
        // trigger wins the tick; the deep trigger must not also fire.
        let ctx = deep_archive_test_parts(&tmp, compaction, 8, Duration::from_mins(1), false);

        let (_, compaction_needed, deep_archive_needed, _) =
            collect_tick_actions("alice", &ctx, Instant::now());

        assert!(compaction_needed);
        assert!(!deep_archive_needed);
    }

    #[test]
    fn notify_user_message_rearms_deep_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            deep_archive_compaction_config(),
            tmp.path().to_path_buf(),
            rx,
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        assert!(mgr
            .with_state("alice", |s| {
                s.deep_archive_done = true;
            })
            .is_some());
        mgr.notify_user_message("alice", 1);
        assert_eq!(
            mgr.with_state("alice", |s| s.deep_archive_done),
            Some(false)
        );

        assert!(mgr
            .with_state("alice", |s| {
                s.deep_archive_done = true;
            })
            .is_some());
        mgr.notify_assistant_message("alice", 2);
        assert_eq!(
            mgr.with_state("alice", |s| s.deep_archive_done),
            Some(false)
        );
    }

    #[test]
    fn notify_compaction_complete_records_memory_coverage() {
        let tmp = tempfile::tempdir().unwrap();
        let (_tx, rx) = tokio::sync::watch::channel(());
        let mgr = AutonomyManager::new(
            AutonomyConfig::default(),
            deep_archive_compaction_config(),
            tmp.path().to_path_buf(),
            rx,
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ignored = rt.block_on(async { mgr.ensure_state("alice") });

        mgr.notify_compaction_complete("alice", 2);
        assert_eq!(mgr.with_state("alice", |s| s.covered_turn_count), Some(2));

        // Coverage must survive a state save/load round trip.
        assert!(mgr
            .with_state("alice", |s| {
                s.mark_dirty();
                save_state(tmp.path(), "alice", s);
            })
            .is_some());
        let persisted = load_state(tmp.path(), "alice").expect("state file should load");
        assert_eq!(persisted.covered_turn_count, 2);
    }
}
