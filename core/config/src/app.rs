use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::duration::ConfigDuration;

/// Generate a zero-argument function returning a constant, for `#[serde(default = "...")]`.
macro_rules! serde_default {
    ($name:ident -> $ty:ty { $val:expr }) => {
        fn $name() -> $ty {
            $val
        }
    };
}

/// Top-level daemon configuration loaded from config.toml.
///
/// Covers all sections from §8: [defaults], [models], [behavior.autonomy],
/// [behavior.tools], [memory], [connections], [advanced].
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    #[serde(default)]
    pub daemon: DaemonConfig,

    #[serde(default)]
    pub defaults: DefaultsConfig,

    #[serde(default)]
    pub behavior: BehaviorConfig,

    /// Tool surface (`[tools]`).
    #[serde(default)]
    pub tools: ToolsConfig,

    #[serde(default)]
    pub memory: MemoryConfig,

    #[serde(default)]
    pub connections: ConnectionsConfig,

    #[serde(default)]
    pub notifications: NotificationsConfig,

    #[serde(default)]
    pub usage: UsageConfig,

    #[serde(default)]
    pub advanced: AdvancedConfig,

    /// Sub-agent delegation definitions, keyed by sub-agent name. Each entry
    /// surfaces to the primary model as a single `ask_<name>` tool that runs a
    /// full tool loop on a (typically cheaper) model over a subset of the
    /// in-process tools and returns only its final summary. See `[subagents]`
    /// in CONFIGURATION.md.
    #[serde(default)]
    pub subagents: BTreeMap<String, SubagentConfig>,

    /// MCP server definitions, keyed by server name. Each connects as a client
    /// and surfaces its tools as `mcp__<name>__<tool>`. See `[mcp]` in
    /// CONFIGURATION.md.
    #[serde(default)]
    pub mcp: BTreeMap<String, McpServerConfig>,
}

// ── [subagents.<name>] ───────────────────────────────────────────────────

/// One delegated sub-agent. Surfaces as an `ask_<name>(query)` tool on the
/// primary character; running it spins up a nested tool loop on `model` over
/// the listed `tools` and returns the agent's final text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SubagentConfig {
    /// One-line description shown to the primary model as the `ask_<name>`
    /// tool description. Supports `{{char}}` / `{{user}}` templating.
    pub description: String,

    /// System prompt for the sub-agent. Supports `{{char}}` / `{{user}}`
    /// templating. This is the agent's whole instruction set — give it the
    /// domain knowledge the primary model would never get prompt budget for.
    pub prompt: String,

    /// Names of in-process tools this sub-agent may call. Each must be a
    /// registered tool; `ask_*` sub-agent tools are never offered to a
    /// sub-agent, so nesting is hard-capped at one level.
    #[serde(default)]
    pub tools: Vec<String>,

    /// Model the sub-agent runs on. Falls back to `defaults.subagent_model`,
    /// then `defaults.model`. Keep this cheap — cost reduction is the point.
    pub model: Option<String>,

    /// Max tool-loop iterations for this sub-agent. `None` uses the resolved
    /// model's own cap.
    pub max_iterations: Option<u32>,
}

// ── [mcp.<name>] ─────────────────────────────────────────────────────────

/// One MCP (Model Context Protocol) server the daemon connects to as a client.
///
/// The server is an external process (stdio) or remote endpoint (HTTP) — never
/// daemon code. On connect the daemon calls `tools/list` and registers each
/// discovered tool as `mcp__<name>__<tool>`, which can then be granted to the
/// character or a sub-agent via the `enabled_tools` / `[subagents.*].tools`
/// allowlists (exact names or `mcp__<name>__*` globs).
///
/// Exactly one transport must be set: `command` (stdio) **or** `url` (HTTP).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct McpServerConfig {
    /// Executable to launch for a stdio server (e.g. `"node"`, `"npx"`).
    /// Mutually exclusive with `url`.
    pub command: Option<String>,

    /// Arguments passed to `command`.
    #[serde(default)]
    pub args: Vec<String>,

    /// Environment variables for the spawned stdio server. The natural home for
    /// per-server secrets (API keys, endpoints) since the server reads them
    /// from its environment.
    #[serde(default)]
    pub env: BTreeMap<String, String>,

    /// Working directory for the spawned stdio server. When unset the server
    /// inherits the daemon's cwd; set it to the server's own directory so it
    /// resolves relative paths and loads its own `.env` from there. Ignored by
    /// HTTP servers.
    pub cwd: Option<String>,

    /// URL of a remote HTTP/SSE server. Mutually exclusive with `command`.
    pub url: Option<String>,
}

// ── [daemon] ────────────────────────────────────────────────────────────

serde_default!(default_daemon_addr -> String { "127.0.0.1:7320".to_owned() });

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DaemonConfig {
    /// TCP address to listen on (default: "127.0.0.1:7320").
    #[serde(default = "default_daemon_addr")]
    pub addr: String,

    /// Explicit opt-in for unauthenticated remote TCP exposure.
    #[serde(default)]
    pub unsafe_allow_remote_access: bool,

    /// Allowed client hosts. Empty list means allow all.
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            addr: default_daemon_addr(),
            unsafe_allow_remote_access: false,
            allowed_hosts: vec![],
        }
    }
}

// ── [defaults] ──────────────────────────────────────────────────────────

/// Background-task model selectors. Resolution chains
/// `<task> → background.model → active chat model → defaults.model →
/// first chat`. The active-chat rung means an unset background section
/// simply tracks whatever model the character is currently using; set
/// `background.model` (or a per-task override) to pin background work
/// to a different model regardless of chat selection.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BackgroundDefaultsConfig {
    /// Blanket model used by every background task unless a per-task
    /// override below is set.
    pub model: Option<String>,

    /// Per-task override for autonomous heartbeat ticks.
    pub heartbeat: Option<String>,

    /// Per-task override for memory compaction passes.
    pub compaction: Option<String>,

    /// Per-task override for the AI librarian dreaming pass.
    pub dreaming: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DefaultsConfig {
    /// Default chat model name (must match a model in config). Used as
    /// the initial chat model when a character hasn't selected one yet,
    /// and as a late-stage fallback for background tasks (after the
    /// character's active chat model). Optional — if unset, chat starts
    /// on the first chat model declared in the catalog.
    pub model: Option<String>,

    /// Background-task model selectors (heartbeat, compaction, dreaming).
    #[serde(default)]
    pub background: BackgroundDefaultsConfig,

    /// **Deprecated.** Old top-level shorthand for
    /// `defaults.background.heartbeat`. Parse-only — the loader logs a
    /// warning and forwards into `background.heartbeat` (only when the
    /// new key is unset).
    #[serde(default)]
    pub heartbeat: Option<String>,

    /// **Deprecated.** Old top-level shorthand for
    /// `defaults.background.dreaming`. Parse-only — the loader logs a
    /// warning and forwards into `background.dreaming` (only when the
    /// new key is unset).
    #[serde(default)]
    pub dreaming: Option<String>,

    /// Default embedding profile name.
    pub embedding: Option<String>,

    /// Default image generation profile name.
    pub image_generation: Option<String>,

    /// Default model for `[subagents]` that don't pin their own `model`.
    /// Keep this a cheap model — sub-agent delegation exists to push
    /// tool-loop busywork off the expensive chat model.
    pub subagent_model: Option<String>,

    /// User's display name for {{user}} template substitution.
    /// Falls back to $USER env var, then "User".
    pub display_name: Option<String>,

    /// Whether to stream responses by default.
    #[serde(default = "default_true")]
    pub stream: bool,
}

/// Symbolic background-task identifier for [`DefaultsConfig::resolve_background_model_name`].
#[derive(Debug, Clone, Copy)]
pub enum BackgroundTask {
    Heartbeat,
    Compaction,
    Dreaming,
}

impl DefaultsConfig {
    /// Resolve the user's display name: config → $USER → "User".
    pub fn resolve_display_name(&self) -> String {
        self.display_name
            .clone()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "User".to_owned())
    }

    /// Resolve the *explicitly configured* background-task model name,
    /// walking `background.<task> → background.model`. Returns `None`
    /// when no background-specific model is set — in that case callers
    /// should fall through to the character's active chat model (then
    /// `defaults.model`, then the first chat model). The active-chat
    /// fallback lives in the per-task resolvers because it requires
    /// per-character runtime state this config struct doesn't see.
    pub fn resolve_background_model_name(&self, task: BackgroundTask) -> Option<&str> {
        let per_task = match task {
            BackgroundTask::Heartbeat => self.background.heartbeat.as_deref(),
            BackgroundTask::Compaction => self.background.compaction.as_deref(),
            BackgroundTask::Dreaming => self.background.dreaming.as_deref(),
        };
        per_task.or(self.background.model.as_deref())
    }

    /// Migrate the legacy top-level `defaults.heartbeat` /
    /// `defaults.dreaming` keys into `defaults.background.*`. The new
    /// keys win on conflict; old keys whose new counterpart is unset are
    /// forwarded with a deprecation warning. Idempotent — calling it on
    /// already-normalized values is a no-op.
    pub fn normalize_deprecated_aliases(&mut self) {
        if let Some(value) = self.heartbeat.take() {
            if self.background.heartbeat.is_none() {
                tracing::warn!(
                    "`defaults.heartbeat = {value:?}` is deprecated; \
                     move it under `[defaults.background]` as `heartbeat`."
                );
                self.background.heartbeat = Some(value);
            } else {
                tracing::warn!(
                    "`defaults.heartbeat` is deprecated and was ignored \
                     because `defaults.background.heartbeat` is already set."
                );
            }
        }
        if let Some(value) = self.dreaming.take() {
            if self.background.dreaming.is_none() {
                tracing::warn!(
                    "`defaults.dreaming = {value:?}` is deprecated; \
                     move it under `[defaults.background]` as `dreaming`."
                );
                self.background.dreaming = Some(value);
            } else {
                tracing::warn!(
                    "`defaults.dreaming` is deprecated and was ignored \
                     because `defaults.background.dreaming` is already set."
                );
            }
        }
    }
}

impl Default for DefaultsConfig {
    fn default() -> Self {
        Self {
            model: None,
            background: BackgroundDefaultsConfig::default(),
            heartbeat: None,
            dreaming: None,
            embedding: None,
            image_generation: None,
            subagent_model: None,
            display_name: None,
            stream: true,
        }
    }
}

// ── [behavior] ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BehaviorConfig {
    #[serde(default)]
    pub autonomy: AutonomyConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AutonomyConfig {
    /// Master switch for autonomous behavior.
    #[serde(default)]
    pub enabled: bool,

    #[serde(default)]
    pub heartbeat: HeartbeatConfig,

    /// Upper bound on how long the cache-keepalive subsystem keeps pinging a
    /// model's prompt cache after the last *real* activity (user message or
    /// heartbeat). Independent of the per-model `cache_keepalive` cadence and
    /// of the heartbeat dormancy guard: it answers "what's the longest gap
    /// between messages I'd want a warm cache for?". Once this elapses with no
    /// real activity, pings stop until the user returns. Default: 12h.
    #[serde(default = "default_cache_keepalive_max")]
    pub cache_keepalive_max: ConfigDuration,
}

serde_default!(default_cache_keepalive_max -> ConfigDuration { ConfigDuration::from_secs(43_200) }); // 12 hours

impl Default for AutonomyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            heartbeat: HeartbeatConfig::default(),
            cache_keepalive_max: default_cache_keepalive_max(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HeartbeatConfig {
    /// Whether heartbeat ticks are enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Base interval between heartbeat ticks.
    #[serde(default = "default_fallback_heartbeat_interval")]
    pub fallback_heartbeat_interval: ConfigDuration,

    /// Consecutive ticks without a user message before the abandonment guard
    /// stops scheduling further ticks (character sleeps until user returns).
    #[serde(default = "default_dormant_after_heartbeat_turns")]
    pub dormant_after_heartbeat_turns: u32,

    /// Time without a user message before the abandonment guard
    /// stops scheduling further ticks. Default: 48 hours.
    #[serde(default = "default_dormant_after_idle_time")]
    pub dormant_after_idle_time: ConfigDuration,

    /// Minimum time between a user message and the next heartbeat tick.
    /// Prevents ticks from firing during active conversation. Default: 1h.
    #[serde(default = "default_minimum_heartbeat_latency")]
    pub minimum_heartbeat_latency: ConfigDuration,

    /// Extra tool-use rounds granted after the wrap-up nudge fires, so the
    /// model can summarize unfinished work into MEMORY.md and respond. Only
    /// takes effect when the per-model `max_tool_iterations` cap is set to a
    /// finite value; with the default (unlimited) there is no count-based
    /// wrap-up nudge.
    #[serde(default = "default_wrap_up_grace_rounds")]
    pub wrap_up_grace_rounds: u32,
}

serde_default!(default_fallback_heartbeat_interval -> ConfigDuration { ConfigDuration::from_secs(3600) });
serde_default!(default_dormant_after_heartbeat_turns -> u32 { 3 });
serde_default!(default_dormant_after_idle_time -> ConfigDuration { ConfigDuration::from_secs(172_800) }); // 48 hours
serde_default!(default_minimum_heartbeat_latency -> ConfigDuration { ConfigDuration::from_secs(3600) }); // 1 hour
serde_default!(default_wrap_up_grace_rounds -> u32 { 3 });

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            fallback_heartbeat_interval: default_fallback_heartbeat_interval(),
            dormant_after_heartbeat_turns: default_dormant_after_heartbeat_turns(),
            dormant_after_idle_time: default_dormant_after_idle_time(),
            minimum_heartbeat_latency: default_minimum_heartbeat_latency(),
            wrap_up_grace_rounds: default_wrap_up_grace_rounds(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CompactionConfig {
    /// Whether compaction triggers are enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Idle time before compaction triggers.
    #[serde(default = "default_idle_trigger")]
    pub idle_trigger: ConfigDuration,
    /// Extended idle time after which the remaining active conversation is
    /// archived outright (equivalent to a keep-0 compaction), so the next
    /// exchange starts from a clean slate. Not gated by `min_turns`. Trailing
    /// autonomous messages the user has not yet responded to are retained in
    /// the active conversation so they stay visible. 0 disables (the default).
    #[serde(default = "default_archive_after")]
    pub archive_after: ConfigDuration,
    /// Minimum user turns before any compaction trigger fires.
    #[serde(default = "default_min_turns")]
    pub min_turns: usize,
    /// Force compaction when this user turn count is reached.
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    /// Force compaction when the last turn's prompt context
    /// (input + cache_read + cache_creation) reaches this token count.
    /// Still floored by `min_turns`. 0 disables the token-based trigger.
    #[serde(default = "default_max_context_tokens")]
    pub max_context_tokens: usize,
    /// User turns retained in active.jsonl after compaction.
    #[serde(default = "default_keep_recent_turns")]
    pub keep_recent_turns: usize,
}

serde_default!(default_idle_trigger -> ConfigDuration { ConfigDuration::from_secs(1800) });
serde_default!(default_archive_after -> ConfigDuration { ConfigDuration::from_secs(0) });
serde_default!(default_min_turns -> usize { 8 });
serde_default!(default_max_turns -> usize { 16 });
serde_default!(default_max_context_tokens -> usize { 200_000 });
serde_default!(default_keep_recent_turns -> usize { 2 });

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            idle_trigger: default_idle_trigger(),
            archive_after: default_archive_after(),
            min_turns: default_min_turns(),
            max_turns: default_max_turns(),
            max_context_tokens: default_max_context_tokens(),
            keep_recent_turns: default_keep_recent_turns(),
        }
    }
}

impl CompactionConfig {
    /// Check the turn-count invariants that make compaction meaningful: both
    /// turn thresholds must exceed `keep_recent_turns` (otherwise a pass would
    /// have nothing to compact) and `max_turns` must not undercut `min_turns`.
    ///
    /// Config load treats a violation as a hard error so the daemon refuses to
    /// start (and a runtime reload keeps the previous config) instead of
    /// silently disabling compaction — and with it the deep-idle archive.
    /// A disabled config is always valid.
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let k = self.keep_recent_turns;
        if self.min_turns <= k || self.max_turns <= k {
            return Err(format!(
                "memory.compaction.min_turns ({}) and max_turns ({}) must both be \
                 greater than keep_recent_turns ({}); raise the turn thresholds or \
                 lower keep_recent_turns",
                self.min_turns, self.max_turns, k
            ));
        }
        if self.max_turns < self.min_turns {
            return Err(format!(
                "memory.compaction.max_turns ({}) must be >= min_turns ({})",
                self.max_turns, self.min_turns
            ));
        }
        Ok(())
    }
}

// ── [tools] ─────────────────────────────────────────────────────────────

/// Tool surface configuration.
///
/// **Opt-in.** A tool is offered to the character only if its name appears in
/// `enabled_tools`, and a sub-agent's `ask_<name>` tool only if the sub-agent
/// appears in `enabled_subagents`. Empty allowlists mean nothing is offered —
/// there is no implicit "all tools on" default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolsConfig {
    /// Names of tools offered to the character (opt-in allowlist).
    #[serde(default)]
    pub enabled_tools: Vec<String>,

    /// Names of sub-agents (`[subagents.<name>]`) whose `ask_<name>` tool is
    /// offered to the character (opt-in allowlist).
    #[serde(default)]
    pub enabled_subagents: Vec<String>,

    /// Global cap on characters a single tool result may contribute before
    /// truncation. `0` disables truncation. Per-tool `[tools.config.<name>]`
    /// tables may override this via [`ToolOverride::max_result_chars`].
    #[serde(default = "default_max_result_chars")]
    pub max_result_chars: usize,

    /// Web search (Tavily) settings — `[tools.web_search]`.
    #[serde(default)]
    pub web_search: SearchConfig,

    /// Exec-tool subprocess sandbox settings — `[tools.exec]`.
    #[serde(default)]
    pub exec: ExecConfig,

    /// Per-tool config tables `[tools.config.<name>]`, keyed by tool name;
    /// currently carries per-tool `max_result_chars`. (A flattened
    /// `[tools.<name>]` form would be nicer but serde's `flatten` drops fields
    /// on the `toml::Value` load path this crate uses.) Unknown keys are tool
    /// names the daemon validates against its registry at request-build time.
    #[serde(default)]
    pub config: BTreeMap<String, ToolOverride>,
}

serde_default!(default_max_result_chars -> usize { 20_000 });

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            enabled_tools: Vec::new(),
            enabled_subagents: Vec::new(),
            max_result_chars: default_max_result_chars(),
            web_search: SearchConfig::default(),
            exec: ExecConfig::default(),
            config: BTreeMap::new(),
        }
    }
}

// ── [tools.exec] ─────────────────────────────────────────────────────────

/// Exec-tool subprocess sandbox configuration (`[tools.exec]`).
///
/// The sandbox confines programs run through the `exec` tool with Landlock
/// (filesystem) and seccomp (syscalls) so an escaped command cannot reach
/// outside the character workspace, regain privileges, or open the network.
/// Linux-only; other platforms always behave as if disabled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct ExecConfig {
    /// Sandbox mode. `auto` (default) enforces the sandbox when the kernel
    /// supports Landlock and silently falls back to the command denylist
    /// otherwise; `on` requires it (exec fails when it cannot be enforced);
    /// `off` disables it.
    #[serde(default)]
    pub sandbox: SandboxMode,

    /// Permit outbound network from sandboxed subprocesses. Default `false`:
    /// the seccomp layer blocks IPv4/IPv6 socket creation, which is invisible
    /// to the git/read workloads exec is used for. Set `true` to let package
    /// managers (cargo/npm) fetch over the network.
    #[serde(default)]
    pub allow_network: bool,
}

/// Exec sandbox enforcement mode (`[tools.exec].sandbox`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SandboxMode {
    /// Enforce when the kernel supports Landlock; fall back to denylist-only
    /// (with a logged warning) when it does not.
    #[default]
    Auto,
    /// Require the sandbox: exec fails when it cannot be enforced.
    On,
    /// Disable the sandbox; rely on the command denylist alone.
    Off,
}

/// Whether allowlist `pattern` matches tool `name`.
///
/// A trailing `*` is a prefix glob (`mcp__hue__*` matches `mcp__hue__set`); any
/// other pattern is an exact match. This is a deliberate fail-closed whitelist —
/// a new tool a server adds later is not granted until a pattern covers it.
#[must_use]
pub fn tool_pattern_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => pattern == name,
    }
}

impl ToolsConfig {
    /// Whether `name` is allowed by the enabled-tools allowlist. Entries may be
    /// exact names or trailing-`*` globs (e.g. `mcp__hue__*`).
    pub fn tool_enabled(&self, name: &str) -> bool {
        self.enabled_tools
            .iter()
            .any(|t| tool_pattern_matches(t, name))
    }

    /// Whether sub-agent `name`'s `ask_<name>` tool is exposed.
    pub fn subagent_enabled(&self, name: &str) -> bool {
        self.enabled_subagents.iter().any(|s| s == name)
    }

    /// Whether any tool or sub-agent is offered (i.e. tool use is active).
    pub fn any_enabled(&self) -> bool {
        !self.enabled_tools.is_empty() || !self.enabled_subagents.is_empty()
    }

    /// Effective per-tool result cap: the tool's override, else the global.
    pub fn result_chars_for(&self, name: &str) -> usize {
        self.config
            .get(name)
            .and_then(|o| o.max_result_chars)
            .unwrap_or(self.max_result_chars)
    }
}

/// Per-tool override table `[tools.config.<name>]`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct ToolOverride {
    /// Override `[tools].max_result_chars` for this tool. `None` inherits the
    /// global value.
    #[serde(default)]
    pub max_result_chars: Option<usize>,
}

// ── [tools.web_search] ───────────────────────────────────────────────────

/// Configuration for the web search tool (Tavily API).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SearchConfig {
    /// Environment variable holding the Tavily API key.
    #[serde(default = "default_search_api_key_env")]
    pub api_key_env: String,

    /// Default max results per search.
    #[serde(default = "default_search_result_limit")]
    pub result_limit: u32,

    /// Search depth: "basic" or "advanced".
    #[serde(default = "default_search_depth")]
    pub search_depth: String,

    /// Whether to include Tavily's synthesized answer.
    #[serde(default = "default_true")]
    pub include_answer: bool,
}

serde_default!(default_search_api_key_env -> String { "TAVILY_API_KEY".into() });
serde_default!(default_search_result_limit -> u32 { 5 });
serde_default!(default_search_depth -> String { "basic".into() });

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            api_key_env: default_search_api_key_env(),
            result_limit: default_search_result_limit(),
            search_depth: default_search_depth(),
            include_answer: true,
        }
    }
}

// ── [memory] ────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MemoryConfig {
    #[serde(default)]
    pub compaction: CompactionConfig,

    #[serde(default)]
    pub dreaming: DreamingConfig,

    #[serde(default)]
    pub thinking: ThinkingConfig,

    #[serde(default)]
    pub retrieval: RetrievalConfig,

    /// After a successful compaction or dreaming pass, push the character's
    /// workspace git repository to its configured remote (a plain `git push`
    /// honoring the repo's own upstream). Off by default: the daemon never
    /// invents a remote, and pushing is opt-in to one the operator set up. A
    /// repo with no remote is skipped silently; a failed push is logged but
    /// never fails the pass.
    #[serde(default)]
    pub git_push: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DreamingConfig {
    /// Whether scheduled memory dreaming sweeps are enabled.
    #[serde(default)]
    pub enabled: bool,

    /// Five-field cron schedule: minute hour day-of-month month day-of-week.
    #[serde(default = "default_dreaming_frequency")]
    pub frequency: String,

    /// Minimum time since the last user message before a scheduled dreaming
    /// sweep is allowed to fire. Heartbeat / autonomy turns do not reset this.
    #[serde(default = "default_dreaming_minimum_inactive_time")]
    pub minimum_inactive_time: ConfigDuration,

    /// How long a scheduled cron occurrence stays eligible to fire after its
    /// scheduled time. If the daemon misses the occurrence by more than this,
    /// it is skipped and the next cron tick takes over (no late catch-up).
    #[serde(default = "default_dreaming_max_lateness")]
    pub max_lateness: ConfigDuration,

    /// When true, run idle-style compaction (if eligible) before the
    /// dreaming sweep. Aborts the sweep on compaction failure.
    #[serde(default = "default_true")]
    pub compact_before: bool,

    /// When true (and `compact_before` is true), the pre-dream compaction
    /// archives every chat turn instead of retaining the configured
    /// `keep_recent_turns` tail.
    #[serde(default)]
    pub compact_to_zero: bool,
}

serde_default!(default_dreaming_frequency -> String { "0 3 * * *".to_owned() });
serde_default!(default_dreaming_minimum_inactive_time -> ConfigDuration { ConfigDuration::from_secs(45 * 60) });
serde_default!(default_dreaming_max_lateness -> ConfigDuration { ConfigDuration::from_secs(2 * 60 * 60) });

impl Default for DreamingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            frequency: default_dreaming_frequency(),
            minimum_inactive_time: default_dreaming_minimum_inactive_time(),
            max_lateness: default_dreaming_max_lateness(),
            compact_before: true,
            compact_to_zero: false,
        }
    }
}

serde_default!(default_replay_prior_thinking -> ThinkingReplay { ThinkingReplay::All });

/// Tri-state control for replaying prior-turn extended-thinking blocks in
/// outgoing requests (#191).
///
/// Back-compat: prior releases stored a bool, so deserialization accepts one —
/// `true` → [`ThinkingReplay::All`], `false` → [`ThinkingReplay::None`] — and
/// existing `replay_prior_thinking = true/false` configs keep working
/// unchanged. New configs use the string form.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingReplay {
    /// Replay every prior turn's thinking (legacy `true`).
    All,
    /// Keep only the most-recent assistant turn's thinking; strip older turns.
    /// A middle ground: keeps the in-context cue that stops Claude from
    /// imitating a no-thinking last turn, while shedding the bulk of the
    /// token cost that `All` carries forever.
    LastTurn,
    /// Strip all prior-turn thinking (legacy `false`).
    None,
}

impl ThinkingReplay {
    /// Parse a wire string (`all` | `last_turn` | `none`), tolerating the
    /// legacy stringy bools `true`/`false`. Returns `None` for anything else.
    pub fn parse_wire(s: &str) -> Option<Self> {
        match s {
            "all" | "true" => Some(Self::All),
            "last_turn" => Some(Self::LastTurn),
            "none" | "false" => Some(Self::None),
            _ => None,
        }
    }

    /// Canonical wire string (`all` | `last_turn` | `none`).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::LastTurn => "last_turn",
            Self::None => "none",
        }
    }
}

impl<'de> Deserialize<'de> for ThinkingReplay {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Accept either the legacy bool or the new string form.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum BoolOrStr {
            Bool(bool),
            Str(String),
        }
        match BoolOrStr::deserialize(deserializer)? {
            BoolOrStr::Bool(true) => Ok(Self::All),
            BoolOrStr::Bool(false) => Ok(Self::None),
            BoolOrStr::Str(s) => Self::parse_wire(&s).ok_or_else(|| {
                serde::de::Error::custom(format!(
                    "invalid replay_prior_thinking {s:?}; expected \"all\", \"last_turn\", \"none\" (or legacy true/false)"
                ))
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ThinkingConfig {
    /// Replay extended-thinking blocks from prior turns in outgoing requests.
    /// Tri-state (#191):
    ///
    /// - `all` (default; legacy `true`): keep every prior turn's thinking.
    /// - `last_turn`: keep only the most-recent assistant turn's thinking and
    ///   strip older turns — recovers most of the token savings of `none`
    ///   while keeping the model reasoning.
    /// - `none` (legacy `false`): strip all prior-turn thinking. Only safe with
    ///   providers that don't depend on prior-turn thinking (e.g. Anthropic
    ///   Claude 4.x).
    ///
    /// DeepSeek V3.1+ and Moonshot Kimi-thinking reject requests that omit
    /// prior `reasoning_content` while in thinking mode, so the
    /// `requires_reasoning_replay` provider floor forces full replay for them
    /// regardless of this setting.
    ///
    /// This is the **global fallback**. The quality effect is
    /// model-dependent (issue #129), so it can be overridden per model via
    /// the runtime preference overlay (`SamplerSettings::replay_prior_thinking`
    /// → `ResolvedModel::replay_prior_thinking`); an unset per-model value
    /// inherits this default.
    #[serde(default = "default_replay_prior_thinking")]
    pub replay_prior_thinking: ThinkingReplay,
}

impl Default for ThinkingConfig {
    fn default() -> Self {
        Self {
            replay_prior_thinking: default_replay_prior_thinking(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalMode {
    #[default]
    Auto,
    Lexical,
    Hybrid,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalBinaryMode {
    #[default]
    Skip,
    Metadata,
    TryEmbed,
}

serde_default!(default_retrieval_max_file_bytes -> u64 { 2 * 1024 * 1024 });
serde_default!(default_retrieval_max_indexed_files -> usize { 50_000 });
serde_default!(default_retrieval_max_total_indexed_bytes -> u64 { 1024 * 1024 * 1024 });
serde_default!(default_retrieval_max_embed_chars_per_file -> usize { 4_000 });

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RetrievalConfig {
    /// Workspace search mode. `auto` uses hybrid semantic+lexical retrieval when
    /// an embedding profile is configured and usable, then falls back to
    /// lexical search. `lexical` never calls embeddings. `hybrid` requests
    /// hybrid retrieval but still falls back to lexical on transient failures.
    #[serde(default)]
    pub mode: RetrievalMode,

    /// Maximum file size (bytes) eligible for lexical/hybrid search.
    #[serde(default = "default_retrieval_max_file_bytes")]
    pub max_file_bytes: u64,

    /// Hard cap on total files walked for workspace indexing.
    #[serde(default = "default_retrieval_max_indexed_files")]
    pub max_indexed_files: usize,

    /// Hard cap on cumulative bytes walked for workspace indexing.
    #[serde(default = "default_retrieval_max_total_indexed_bytes")]
    pub max_total_indexed_bytes: u64,

    /// Maximum chars from each file fed to the embedder.
    #[serde(default = "default_retrieval_max_embed_chars_per_file")]
    pub max_embed_chars_per_file: usize,

    /// Binary-file handling policy for workspace indexing.
    #[serde(default)]
    pub binary: RetrievalBinaryMode,
}

impl Default for RetrievalConfig {
    fn default() -> Self {
        Self {
            mode: RetrievalMode::Auto,
            max_file_bytes: default_retrieval_max_file_bytes(),
            max_indexed_files: default_retrieval_max_indexed_files(),
            max_total_indexed_bytes: default_retrieval_max_total_indexed_bytes(),
            max_embed_chars_per_file: default_retrieval_max_embed_chars_per_file(),
            binary: RetrievalBinaryMode::Skip,
        }
    }
}
// ── [connections] ───────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ConnectionsConfig {
    #[serde(default)]
    pub matrix: Option<MatrixConfig>,

    #[serde(default)]
    pub telegram: Option<TelegramConfig>,

    #[serde(default)]
    pub discord: Option<DiscordConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MatrixConfig {
    /// Whether the Matrix connection is enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Mirror the full conversation for each character into its bound Matrix
    /// room — user prompts from any client, assistant replies, and autonomous
    /// messages — routed by character. When false, only the room you are
    /// actively chatting in sees responses (legacy behavior). Consumed by the
    /// `shore-matrix` bridge; the daemon only stores it.
    #[serde(default = "default_true")]
    pub mirror_all: bool,

    /// Homeserver URL. Required for external mode.
    /// In embedded mode, auto-derived as http://localhost:{port}.
    pub homeserver: Option<String>,

    /// Matrix user ID (e.g. @shore:example.com). External mode only.
    pub user_id: Option<String>,

    /// Room ID to join. External mode only.
    pub room_id: Option<String>,

    /// Matrix user to trust for SAS auto-verification.
    pub trusted_user: Option<String>,

    /// Embedded homeserver configuration. Presence of this section
    /// activates embedded mode (mutually exclusive with homeserver).
    pub embedded: Option<EmbeddedConfig>,
}

/// Configuration for an embedded (shore-matrix-managed) Matrix homeserver.
///
/// Uses a conduwuit-compatible server (continuwuity, conduwuit, or tuwunel).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EmbeddedConfig {
    /// Matrix server_name (e.g. "shore.local"). Cannot be changed after first run.
    #[serde(default = "default_server_name")]
    pub server_name: String,

    /// HTTP bind address. Default "127.0.0.1" (loopback only). Set to "0.0.0.0"
    /// or "::" to expose the embedded homeserver to LAN/Tailscale clients.
    #[serde(default = "default_bind_address")]
    pub bind_address: String,

    /// HTTP listener port.
    #[serde(default = "default_homeserver_port")]
    pub port: u16,

    /// Admin username (without @ or :server).
    #[serde(default = "default_admin_user")]
    pub admin_user: String,

    /// Admin account password.
    pub admin_password: String,

    /// Override data directory. Default: $XDG_DATA_HOME/shore/matrix-server/
    pub data_dir: Option<String>,

    /// Override the homeserver binary name.
    /// Default: auto-detect (tries continuwuity, conduwuit, tuwunel).
    pub binary: Option<String>,
}

serde_default!(default_server_name -> String { "localhost".into() });
serde_default!(default_bind_address -> String { "127.0.0.1".into() });
serde_default!(default_homeserver_port -> u16 { 6167 });
serde_default!(default_admin_user -> String { "shore-admin".into() });

impl Default for EmbeddedConfig {
    fn default() -> Self {
        Self {
            server_name: default_server_name(),
            bind_address: default_bind_address(),
            port: default_homeserver_port(),
            admin_user: default_admin_user(),
            admin_password: String::new(),
            data_dir: None,
            binary: None,
        }
    }
}

/// Reserved for future use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TelegramConfig {
    #[serde(flatten)]
    pub extra: BTreeMap<String, toml::Value>,
}

/// Reserved for future use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DiscordConfig {
    #[serde(flatten)]
    pub extra: BTreeMap<String, toml::Value>,
}

// ── [notifications] ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NotificationsConfig {
    /// Master switch for push notifications.
    #[serde(default)]
    pub enabled: bool,

    /// Notification backend: notify_send, ntfy, or command.
    #[serde(default)]
    pub backend: NotificationBackend,

    /// ntfy backend configuration.
    #[serde(default)]
    pub ntfy: NtfyConfig,

    /// Custom command backend configuration.
    #[serde(default)]
    pub command: CommandNotifyConfig,

    /// Only fire `message_complete` notifications when generation takes longer
    /// than this duration. 0 means always notify.
    #[serde(default = "default_generation_threshold")]
    pub generation_threshold: ConfigDuration,

    /// Per-event toggles.
    #[serde(default)]
    pub events: NotificationEventsConfig,
}

serde_default!(default_generation_threshold -> ConfigDuration { ConfigDuration::from_secs(0) });

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            enabled: bool::default(),
            backend: NotificationBackend::default(),
            ntfy: NtfyConfig::default(),
            command: CommandNotifyConfig::default(),
            generation_threshold: default_generation_threshold(),
            events: NotificationEventsConfig::default(),
        }
    }
}

/// Notification delivery backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum NotificationBackend {
    /// Linux desktop notifications via notify-send.
    #[default]
    NotifySend,
    /// Push notifications via ntfy server.
    Ntfy,
    /// User-defined shell command.
    Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NtfyConfig {
    /// ntfy server URL.
    #[serde(default = "default_ntfy_url")]
    pub url: String,

    /// ntfy topic name.
    #[serde(default)]
    pub topic: String,

    /// Optional auth token for self-hosted instances.
    #[serde(default)]
    pub token: String,
}

serde_default!(default_ntfy_url -> String { "https://ntfy.sh".into() });

impl Default for NtfyConfig {
    fn default() -> Self {
        Self {
            url: default_ntfy_url(),
            topic: String::new(),
            token: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[derive(Default)]
pub struct CommandNotifyConfig {
    /// Shell command template. Use {title} and {body} as placeholders.
    #[serde(default)]
    pub template: String,
}

/// Per-event notification toggles. All default to true (fire when enabled).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each bool maps 1:1 to an independent TOML notification toggle"
)]
pub struct NotificationEventsConfig {
    #[serde(default = "default_true")]
    pub autonomous_message: bool,
    #[serde(default = "default_true")]
    pub cache_warning: bool,
    #[serde(default = "default_true")]
    pub compaction_complete: bool,
    #[serde(default = "default_true")]
    pub error: bool,
    #[serde(default)]
    pub message_complete: bool,
    #[serde(default = "default_true")]
    pub usage_warning: bool,
}

impl Default for NotificationEventsConfig {
    fn default() -> Self {
        Self {
            autonomous_message: true,
            cache_warning: true,
            compaction_complete: true,
            error: true,
            message_complete: false,
            usage_warning: true,
        }
    }
}

// ── [usage] ────────────────────────────────────────────────────────────

serde_default!(default_usage_timezone -> String { "local".into() });
serde_default!(default_usage_budget_warn_at -> Vec<f64> { vec![0.8, 1.0] });
serde_default!(default_spike_multiplier -> f64 { 3.0 });
serde_default!(default_spike_min_cost_usd -> f64 { 1.0 });

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageConfig {
    /// Calendar timezone for named windows such as "today", budget days,
    /// weeks, and months. Supported values are "local" and "utc".
    #[serde(default = "default_usage_timezone")]
    pub timezone: String,

    /// Let compaction run even when a blocking budget is already over limit.
    /// Compaction can reduce future prompt size, so this defaults to true.
    #[serde(default = "default_true")]
    pub allow_compaction_over_budget: bool,

    /// User-defined cost budgets.
    #[serde(default)]
    pub budgets: Vec<UsageBudgetConfig>,

    /// Cost spike warning configuration.
    #[serde(default)]
    pub spike_warnings: UsageSpikeWarningsConfig,
}

impl Default for UsageConfig {
    fn default() -> Self {
        Self {
            timezone: default_usage_timezone(),
            allow_compaction_over_budget: true,
            budgets: Vec::new(),
            spike_warnings: UsageSpikeWarningsConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum UsageBudgetPeriod {
    Hour,
    #[default]
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum UsageBudgetAction {
    /// Report status and warnings, but never prevent calls.
    #[default]
    Warn,
    /// Prevent all matching LLM calls after the budget is over limit.
    Block,
    /// Prevent matching background calls after the budget is over limit.
    PauseBackground,
}

/// Weekday name for `[[usage.budgets]].reset_day_of_week`. Lowercase in TOML.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BudgetWeekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

impl BudgetWeekday {
    /// 0 = Monday .. 6 = Sunday, matching chrono's `num_days_from_monday`.
    pub fn num_days_from_monday(self) -> u32 {
        match self {
            BudgetWeekday::Monday => 0,
            BudgetWeekday::Tuesday => 1,
            BudgetWeekday::Wednesday => 2,
            BudgetWeekday::Thursday => 3,
            BudgetWeekday::Friday => 4,
            BudgetWeekday::Saturday => 5,
            BudgetWeekday::Sunday => 6,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageBudgetConfig {
    /// Display name for status, warnings, and errors. If empty, Shore uses a
    /// stable fallback such as "budget 1".
    #[serde(default)]
    pub name: String,

    /// Calendar window for the budget.
    #[serde(default)]
    pub period: UsageBudgetPeriod,

    /// USD cost limit for the period.
    pub cost_usd: f64,

    /// Fractions of `cost_usd` considered warning thresholds.
    #[serde(default = "default_usage_budget_warn_at")]
    pub warn_at: Vec<f64>,

    /// Enforcement action once `cost_usd` is reached.
    #[serde(default)]
    pub limit: UsageBudgetAction,

    /// Optional scope filters. All configured filters must match.
    #[serde(default)]
    pub character: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub call_type: Option<String>,
    #[serde(default)]
    pub usage_kind: Vec<String>,

    /// Per-budget override for `[usage].allow_compaction_over_budget`.
    #[serde(default)]
    pub allow_compaction_over_budget: Option<bool>,

    /// Hour-of-day at which the budget window resets (0-23). Applies to
    /// `period = day`, `week`, or `month`. Defaults to 0 (midnight).
    #[serde(default)]
    pub reset_hour: Option<u32>,

    /// Weekday on which a `period = "week"` budget resets. Defaults to Monday.
    #[serde(default)]
    pub reset_day_of_week: Option<BudgetWeekday>,

    /// Day-of-month on which a `period = "month"` budget resets (1-31).
    /// Values past the end of a short month clamp to the last day of that
    /// month. Defaults to 1.
    #[serde(default)]
    pub reset_day_of_month: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageSpikeWarningsConfig {
    /// Whether `shore usage --budget` should report cost spikes.
    #[serde(default)]
    pub enabled: bool,

    /// Window to compare against the immediately previous window.
    #[serde(default = "default_spike_period")]
    pub period: UsageBudgetPeriod,

    /// Current-period cost must be at least this multiple of the previous
    /// period cost to warn.
    #[serde(default = "default_spike_multiplier")]
    pub multiplier: f64,

    /// Current-period cost floor before a spike can warn.
    #[serde(default = "default_spike_min_cost_usd")]
    pub min_cost_usd: f64,
}

serde_default!(default_spike_period -> UsageBudgetPeriod { UsageBudgetPeriod::Hour });

impl Default for UsageSpikeWarningsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            period: UsageBudgetPeriod::Hour,
            multiplier: default_spike_multiplier(),
            min_cost_usd: default_spike_min_cost_usd(),
        }
    }
}

// ── [advanced] ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AdvancedConfig {
    /// Deprecated and ignored. Per-call payload capture is now always on: every
    /// LLM request/response is recorded to the compressed, self-rotating
    /// observability store at `{cache_dir}/calls.db` (see `shore log --api`).
    /// This key is still accepted so older `config.toml`s keep loading, but it
    /// no longer gates anything.
    #[serde(default)]
    pub api_payload_logging: bool,

    /// Log prompt-cache forensic data to `{cache_dir}/cache_forensics.jsonl`.
    ///
    /// Disabled by default so operators opt in deliberately when diagnosing
    /// cache behavior or prompt-cost anomalies.
    #[serde(default)]
    pub cache_forensics: bool,

    /// Editor command override. Checked before $VISUAL / $EDITOR env vars.
    pub editor: Option<String>,

    /// Maximum LLM retry attempts before giving up. Overrides the default (2).
    pub max_retries: Option<u32>,

    /// Base delay between retry attempts; doubled on each subsequent attempt.
    /// Overrides the default (500ms).
    pub retry_backoff: Option<ConfigDuration>,

    /// Maximum image file size (bytes) before resizing for LLM upload.
    /// Images larger than this are scaled down and re-encoded as JPEG.
    /// Set to 0 to disable resizing. Default: 2,000,000 (2 MB).
    #[serde(default = "default_max_image_size")]
    pub max_image_size: u64,

    /// LLM sidecar transport. Enabled by default; shore-llm POSTs provider
    /// requests to a Bun sidecar over a Unix socket instead of carrying
    /// provider-specific chat/image wire code in Rust.
    #[serde(default)]
    pub llm_sidecar: LlmSidecarConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LlmSidecarConfig {
    /// Route LLM stream/generate/image calls through the sidecar.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Optional Unix socket path. If unset, the daemon uses
    /// `<runtime_dir>/llm.sock`.
    pub socket_path: Option<PathBuf>,
}

impl Default for LlmSidecarConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            socket_path: None,
        }
    }
}

impl Default for AdvancedConfig {
    fn default() -> Self {
        Self {
            api_payload_logging: false,
            cache_forensics: false,
            editor: None,
            max_retries: None,
            retry_backoff: None,
            max_image_size: default_max_image_size(),
            llm_sidecar: LlmSidecarConfig::default(),
        }
    }
}

// ── Shared defaults ─────────────────────────────────────────────────────

serde_default!(default_true -> bool { true });
serde_default!(default_max_image_size -> u64 { 2_000_000 });

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_validate_enforces_turn_invariants() {
        assert!(CompactionConfig::default().validate().is_ok());

        let equal_keep = CompactionConfig {
            min_turns: 4,
            keep_recent_turns: 4,
            ..CompactionConfig::default()
        };
        assert!(equal_keep.validate().is_err());

        let max_below_min = CompactionConfig {
            min_turns: 10,
            max_turns: 5,
            ..CompactionConfig::default()
        };
        assert!(max_below_min.validate().is_err());

        let disabled = CompactionConfig {
            enabled: false,
            min_turns: 4,
            keep_recent_turns: 4,
            ..CompactionConfig::default()
        };
        assert!(disabled.validate().is_ok());
    }

    #[test]
    fn defaults_are_sensible() {
        let config = AppConfig::default();
        assert!(config.defaults.stream);
        assert!(!config.behavior.autonomy.enabled);
        assert!(config.behavior.autonomy.heartbeat.enabled);
        assert_eq!(
            config
                .behavior
                .autonomy
                .heartbeat
                .fallback_heartbeat_interval,
            ConfigDuration::from_secs(3600)
        );
        assert_eq!(
            config
                .behavior
                .autonomy
                .heartbeat
                .dormant_after_heartbeat_turns,
            3
        );
        assert_eq!(
            config.behavior.autonomy.heartbeat.dormant_after_idle_time,
            ConfigDuration::from_secs(172_800)
        );
        assert_eq!(
            config.behavior.autonomy.heartbeat.minimum_heartbeat_latency,
            ConfigDuration::from_secs(3600)
        );
        assert!(!config.tools.any_enabled());
        assert!(config.memory.compaction.enabled);
        assert_eq!(config.memory.retrieval.mode, RetrievalMode::Auto);
        assert_eq!(config.memory.retrieval.max_file_bytes, 2 * 1024 * 1024);
        assert_eq!(config.memory.retrieval.max_indexed_files, 50_000);
        assert_eq!(
            config.memory.retrieval.max_total_indexed_bytes,
            1024 * 1024 * 1024
        );
        assert_eq!(config.memory.retrieval.max_embed_chars_per_file, 4_000);
        assert_eq!(config.memory.retrieval.binary, RetrievalBinaryMode::Skip);
        // Tools are opt-in: nothing is enabled by default.
        assert!(!config.tools.tool_enabled("roll_dice"));
        // Advanced retry fields default to None.
        assert!(config.advanced.editor.is_none());
        assert!(config.advanced.max_retries.is_none());
        assert!(config.advanced.retry_backoff.is_none());
        assert!(config.advanced.llm_sidecar.enabled);
        assert!(config.advanced.llm_sidecar.socket_path.is_none());
        assert_eq!(config.usage.timezone, "local");
        assert!(config.usage.allow_compaction_over_budget);
        assert!(config.usage.budgets.is_empty());
    }

    #[test]
    fn subagents_table_parses() {
        let toml_str = r#"
[defaults]
subagent_model = "anthropic:claude-haiku-4-5"

[subagents.music]
description = "Ask about the music library."
prompt = "You are a music assistant for {{char}}."
tools = ["search", "read"]
max_iterations = 6
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(
            config.defaults.subagent_model.as_deref(),
            Some("anthropic:claude-haiku-4-5")
        );
        let music = config.subagents.get("music").expect("music subagent");
        assert_eq!(music.tools, vec!["search".to_owned(), "read".to_owned()]);
        assert_eq!(music.max_iterations, Some(6));
        // Unset optional model falls back at resolution time, not parse time.
        assert!(music.model.is_none());
    }

    #[test]
    fn memory_retrieval_mode_parses() {
        let toml_str = r#"
[memory.retrieval]
mode = "hybrid"
max_file_bytes = 12345
max_indexed_files = 999
max_total_indexed_bytes = 777777
max_embed_chars_per_file = 222
binary = "metadata"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.memory.retrieval.mode, RetrievalMode::Hybrid);
        assert_eq!(config.memory.retrieval.max_file_bytes, 12345);
        assert_eq!(config.memory.retrieval.max_indexed_files, 999);
        assert_eq!(config.memory.retrieval.max_total_indexed_bytes, 777_777);
        assert_eq!(config.memory.retrieval.max_embed_chars_per_file, 222);
        assert_eq!(
            config.memory.retrieval.binary,
            RetrievalBinaryMode::Metadata
        );
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "exact round-trip assertion on float literals parsed from TOML"
    )]
    fn usage_config_parses() {
        let toml_str = r#"
[usage]
timezone = "utc"
allow_compaction_over_budget = false

[[usage.budgets]]
name = "daily"
period = "day"
cost_usd = 10.0
warn_at = [0.5, 0.8]
limit = "block"
provider = "openrouter"
api_key = "overflow"
usage_kind = ["message_with_tools"]

[usage.spike_warnings]
enabled = true
period = "hour"
multiplier = 4.0
min_cost_usd = 2.5
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.usage.timezone, "utc");
        assert!(!config.usage.allow_compaction_over_budget);
        assert_eq!(config.usage.budgets.len(), 1);
        let budget = config
            .usage
            .budgets
            .first()
            .expect("usage budget should be present");
        assert_eq!(budget.period, UsageBudgetPeriod::Day);
        assert_eq!(budget.limit, UsageBudgetAction::Block);
        assert_eq!(budget.provider.as_deref(), Some("openrouter"));
        assert_eq!(budget.api_key.as_deref(), Some("overflow"));
        assert_eq!(budget.usage_kind, vec!["message_with_tools"]);
        assert!(config.usage.spike_warnings.enabled);
        assert_eq!(config.usage.spike_warnings.period, UsageBudgetPeriod::Hour);
        assert_eq!(config.usage.spike_warnings.multiplier, 4.0);
        assert_eq!(config.usage.spike_warnings.min_cost_usd, 2.5);
    }

    #[test]
    fn enabled_tools_is_an_allowlist() {
        let toml_str = r#"
[tools]
enabled_tools = ["read", "search_chat_logs"]
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert!(config.tools.tool_enabled("read"));
        assert!(config.tools.tool_enabled("search_chat_logs"));
        // Anything not listed is off — opt-in.
        assert!(!config.tools.tool_enabled("roll_dice"));
        assert!(!config.tools.tool_enabled("web_search"));
        assert!(config.tools.any_enabled());
    }

    #[test]
    fn tool_pattern_matches_exact_and_glob() {
        // Exact patterns require full equality.
        assert!(tool_pattern_matches("read", "read"));
        assert!(!tool_pattern_matches("read", "ready"));
        // Trailing `*` is a prefix glob.
        assert!(tool_pattern_matches("mcp__hue__*", "mcp__hue__set_light"));
        assert!(tool_pattern_matches("mcp__hue__*", "mcp__hue__"));
        assert!(!tool_pattern_matches("mcp__hue__*", "mcp__nanoleaf__on"));
        // Bare `*` matches anything.
        assert!(tool_pattern_matches("mcp__*", "mcp__hue__set_light"));
        assert!(tool_pattern_matches("*", "anything"));
    }

    #[test]
    fn enabled_tools_supports_mcp_globs() {
        let toml_str = r#"
[tools]
enabled_tools = ["read", "mcp__hue__*"]
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert!(config.tools.tool_enabled("read"));
        assert!(config.tools.tool_enabled("mcp__hue__set_light"));
        assert!(config.tools.tool_enabled("mcp__hue__list_lights"));
        // A different server is not covered by the hue glob.
        assert!(!config.tools.tool_enabled("mcp__nanoleaf__on"));
    }

    #[test]
    fn mcp_server_config_parses() {
        let toml_str = r#"
[mcp.hue]
command = "node"
args = ["index.js"]
env = { HUE_API_KEY = "abc" }
cwd = "/srv/hue-mcp"

[mcp.remote]
url = "http://localhost:9123/sse"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        let hue = config.mcp.get("hue").expect("hue server present");
        assert_eq!(hue.command.as_deref(), Some("node"));
        assert_eq!(hue.args, vec!["index.js".to_owned()]);
        assert_eq!(hue.env.get("HUE_API_KEY").map(String::as_str), Some("abc"));
        assert_eq!(hue.cwd.as_deref(), Some("/srv/hue-mcp"));
        assert!(hue.url.is_none());
        let remote = config.mcp.get("remote").expect("remote server present");
        assert_eq!(remote.url.as_deref(), Some("http://localhost:9123/sse"));
        assert!(remote.command.is_none());
        assert!(remote.cwd.is_none());
    }

    #[test]
    fn per_tool_max_result_chars_override() {
        let toml_str = r#"
[tools]
enabled_tools = ["search", "read"]
max_result_chars = 20000

[tools.config.search]
max_result_chars = 10000
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.tools.result_chars_for("search"), 10000);
        // A tool with no override inherits the global cap.
        assert_eq!(config.tools.result_chars_for("read"), 20000);
    }

    #[test]
    fn enabled_subagents_is_an_allowlist() {
        let toml_str = r#"
[tools]
enabled_subagents = ["memory"]
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert!(config.tools.subagent_enabled("memory"));
        assert!(!config.tools.subagent_enabled("research"));
        assert!(config.tools.any_enabled());
    }

    #[test]
    fn search_config_defaults() {
        let config = AppConfig::default();
        assert_eq!(config.tools.web_search.api_key_env, "TAVILY_API_KEY");
        assert_eq!(config.tools.web_search.result_limit, 5);
        assert_eq!(config.tools.web_search.search_depth, "basic");
        assert!(config.tools.web_search.include_answer);
    }

    #[test]
    fn search_config_parses_from_toml() {
        let toml_str = r#"
[tools.web_search]
api_key_env = "MY_TAVILY_KEY"
result_limit = 10
search_depth = "advanced"
include_answer = false
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.tools.web_search.api_key_env, "MY_TAVILY_KEY");
        assert_eq!(config.tools.web_search.result_limit, 10);
        assert_eq!(config.tools.web_search.search_depth, "advanced");
        assert!(!config.tools.web_search.include_answer);
    }

    #[test]
    fn daemon_config_parses() {
        let toml_str = r#"
[daemon]
addr = "0.0.0.0:9999"
unsafe_allow_remote_access = true
allowed_hosts = ["127.0.0.1", "192.168.1.100"]
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.daemon.addr, "0.0.0.0:9999");
        assert!(config.daemon.unsafe_allow_remote_access);
        assert_eq!(config.daemon.allowed_hosts.len(), 2);
    }

    #[test]
    fn daemon_config_defaults_to_local_only() {
        let config = AppConfig::default();
        assert_eq!(config.daemon.addr, "127.0.0.1:7320");
        assert!(!config.daemon.unsafe_allow_remote_access);
        assert!(config.daemon.allowed_hosts.is_empty());
    }

    #[test]
    fn minimal_toml_parses_to_defaults() {
        let toml_str = "";
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config, AppConfig::default());
    }

    #[test]
    fn rejects_unknown_top_level_section() {
        let toml_str = r#"
[bogus_section]
key = "value"
"#;
        let result: Result<AppConfig, _> = toml::from_str(toml_str);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("unknown field"),
            "Error should mention unknown field: {err}"
        );
    }

    #[test]
    fn notifications_config_defaults() {
        let config = AppConfig::default();
        assert!(!config.notifications.enabled);
        assert_eq!(
            config.notifications.backend,
            NotificationBackend::NotifySend
        );
        assert_eq!(config.notifications.ntfy.url, "https://ntfy.sh");
        assert!(config.notifications.ntfy.topic.is_empty());
        assert!(config.notifications.events.autonomous_message);
        assert!(config.notifications.events.cache_warning);
        assert!(config.notifications.events.compaction_complete);
        assert!(config.notifications.events.error);
        assert!(!config.notifications.events.message_complete);
        assert!(config.notifications.events.usage_warning);
    }

    #[test]
    fn notifications_config_parses_from_toml() {
        let toml_str = r#"
[notifications]
enabled = true
backend = "ntfy"

[notifications.ntfy]
url = "https://ntfy.example.com"
topic = "shore-test"
token = "tk_secret"

[notifications.events]
cache_warning = false
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert!(config.notifications.enabled);
        assert_eq!(config.notifications.backend, NotificationBackend::Ntfy);
        assert_eq!(config.notifications.ntfy.url, "https://ntfy.example.com");
        assert_eq!(config.notifications.ntfy.topic, "shore-test");
        assert_eq!(config.notifications.ntfy.token, "tk_secret");
        assert!(config.notifications.events.autonomous_message);
        assert!(!config.notifications.events.cache_warning);
        assert!(config.notifications.events.usage_warning);
    }

    #[test]
    fn notifications_command_backend_parses() {
        let toml_str = r#"
[notifications]
enabled = true
backend = "command"

[notifications.command]
template = "echo '{title}: {body}'"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.notifications.backend, NotificationBackend::Command);
        assert_eq!(
            config.notifications.command.template,
            "echo '{title}: {body}'"
        );
    }

    #[test]
    fn rejects_unknown_notifications_key() {
        let toml_str = r#"
[notifications]
enabled = true
bogus_key = "value"
"#;
        let result: Result<AppConfig, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_unknown_nested_key() {
        let toml_str = r"
[behavior.autonomy]
enabled = true
bogus_key = 42
";
        let result: Result<AppConfig, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn matrix_external_mode_parses() {
        let toml_str = r#"
[connections.matrix]
homeserver = "https://matrix.example.com"
user_id = "@shore:example.com"
room_id = "!abc:example.com"
trusted_user = "@user:example.com"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        let mx = config.connections.matrix.unwrap();
        assert!(mx.enabled);
        assert_eq!(mx.homeserver.as_deref(), Some("https://matrix.example.com"));
        assert_eq!(mx.user_id.as_deref(), Some("@shore:example.com"));
        assert_eq!(mx.room_id.as_deref(), Some("!abc:example.com"));
        assert_eq!(mx.trusted_user.as_deref(), Some("@user:example.com"));
        assert!(mx.embedded.is_none());
    }

    #[test]
    fn matrix_embedded_mode_parses() {
        let toml_str = r#"
[connections.matrix]
trusted_user = "@user:shore.local"

[connections.matrix.embedded]
server_name = "shore.local"
port = 9008
admin_password = "secret"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        let mx = config.connections.matrix.unwrap();
        assert!(mx.enabled);
        assert!(mx.homeserver.is_none());
        assert_eq!(mx.trusted_user.as_deref(), Some("@user:shore.local"));
        let emb = mx.embedded.unwrap();
        assert_eq!(emb.server_name, "shore.local");
        assert_eq!(emb.port, 9008);
        assert_eq!(emb.admin_password, "secret");
        assert_eq!(emb.admin_user, "shore-admin");
        assert!(emb.data_dir.is_none());
        assert!(emb.binary.is_none());
    }

    #[test]
    fn matrix_embedded_defaults() {
        let toml_str = r#"
[connections.matrix.embedded]
admin_password = "required"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        let emb = config.connections.matrix.unwrap().embedded.unwrap();
        assert_eq!(emb.server_name, "localhost");
        assert_eq!(emb.bind_address, "127.0.0.1");
        assert_eq!(emb.port, 6167);
        assert_eq!(emb.admin_user, "shore-admin");
    }

    #[test]
    fn matrix_embedded_with_all_fields() {
        let toml_str = r#"
[connections.matrix.embedded]
server_name = "test.local"
bind_address = "0.0.0.0"
port = 9999
admin_user = "admin"
admin_password = "secret123"
data_dir = "/tmp/test-matrix"
binary = "tuwunel"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        let emb = config.connections.matrix.unwrap().embedded.unwrap();
        assert_eq!(emb.server_name, "test.local");
        assert_eq!(emb.bind_address, "0.0.0.0");
        assert_eq!(emb.port, 9999);
        assert_eq!(emb.admin_user, "admin");
        assert_eq!(emb.admin_password, "secret123");
        assert_eq!(emb.data_dir.as_deref(), Some("/tmp/test-matrix"));
        assert_eq!(emb.binary.as_deref(), Some("tuwunel"));
    }

    #[test]
    fn matrix_rejects_unknown_embedded_field() {
        let toml_str = r#"
[connections.matrix.embedded]
server_name = "localhost"
bogus = true
"#;
        let result: Result<AppConfig, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn matrix_disabled() {
        let toml_str = r#"
[connections.matrix]
enabled = false
homeserver = "https://matrix.example.com"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        let mx = config.connections.matrix.unwrap();
        assert!(!mx.enabled);
    }

    // ── resolve_display_name ────────────────────────────────────────

    #[test]
    fn resolve_display_name_from_config() {
        let defaults = DefaultsConfig {
            display_name: Some("Alice".into()),
            ..Default::default()
        };
        assert_eq!(defaults.resolve_display_name(), "Alice");
    }

    #[test]
    fn resolve_display_name_falls_back_to_user_env() {
        let defaults = DefaultsConfig::default();
        // $USER is almost always set on unix; verify we get *something* non-empty.
        let name = defaults.resolve_display_name();
        assert!(!name.is_empty());
        // If $USER is set, we should get its value.
        if let Ok(user) = std::env::var("USER") {
            assert_eq!(name, user);
        }
    }

    #[test]
    fn resolve_display_name_ultimate_fallback() {
        // When display_name is None and USER is unset, should return "User".
        // We can't safely unset USER in a parallel test, so just test the
        // branch structure via the method's known behavior.
        let defaults = DefaultsConfig {
            display_name: None,
            ..Default::default()
        };
        // At minimum, resolve_display_name always returns a non-empty string.
        let name = defaults.resolve_display_name();
        assert!(!name.is_empty());
    }

    // ── ToolsConfig allowlist ───────────────────────────────────────

    #[test]
    fn tools_default_is_empty_opt_in() {
        let tools = ToolsConfig::default();
        // Nothing is enabled until explicitly listed.
        assert!(!tools.any_enabled());
        assert!(!tools.tool_enabled("search_chat_logs"));
        assert!(!tools.subagent_enabled("memory"));
        // Global cap still has its default.
        assert_eq!(tools.max_result_chars, 20_000);
    }

    #[test]
    fn tools_result_chars_falls_back_to_global() {
        let tools = ToolsConfig::default();
        // No per-tool override → global default.
        assert_eq!(tools.result_chars_for("anything"), 20_000);
    }

    #[test]
    fn max_image_size_defaults_and_overrides() {
        // Default: 2 MB.
        let default_config = AppConfig::default();
        assert_eq!(default_config.advanced.max_image_size, 2_000_000);

        // Override via TOML.
        let override_toml = r"
[advanced]
max_image_size = 5000000
";
        let override_config: AppConfig = toml::from_str(override_toml).unwrap();
        assert_eq!(override_config.advanced.max_image_size, 5_000_000);

        // Disable via 0.
        let disabled_toml = r"
[advanced]
max_image_size = 0
";
        let disabled_config: AppConfig = toml::from_str(disabled_toml).unwrap();
        assert_eq!(disabled_config.advanced.max_image_size, 0);
    }

    #[test]
    fn cache_forensics_defaults_and_overrides() {
        let default_config = AppConfig::default();
        assert!(!default_config.advanced.cache_forensics);

        let toml_str = r"
[advanced]
cache_forensics = true
";
        let enabled_config: AppConfig = toml::from_str(toml_str).unwrap();
        assert!(enabled_config.advanced.cache_forensics);
    }

    #[test]
    fn exec_sandbox_defaults_to_auto_no_network() {
        let tools = ToolsConfig::default();
        assert_eq!(tools.exec.sandbox, SandboxMode::Auto);
        assert!(!tools.exec.allow_network);
    }

    #[test]
    fn exec_sandbox_parses_mode_and_network() {
        let toml_str = r#"
[tools.exec]
sandbox = "on"
allow_network = true
"#;
        let cfg: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(cfg.tools.exec.sandbox, SandboxMode::On);
        assert!(cfg.tools.exec.allow_network);

        let off: AppConfig = toml::from_str("[tools.exec]\nsandbox = \"off\"\n").unwrap();
        assert_eq!(off.tools.exec.sandbox, SandboxMode::Off);
        assert!(!off.tools.exec.allow_network);
    }

    #[test]
    fn llm_sidecar_defaults_on_and_accepts_socket_path() {
        let default_config = AppConfig::default();
        assert!(default_config.advanced.llm_sidecar.enabled);
        assert!(default_config.advanced.llm_sidecar.socket_path.is_none());

        let toml_str = r#"
[advanced.llm_sidecar]
enabled = false
socket_path = "/tmp/shore-llm.sock"
"#;
        let override_config: AppConfig = toml::from_str(toml_str).unwrap();
        assert!(!override_config.advanced.llm_sidecar.enabled);
        assert_eq!(
            override_config.advanced.llm_sidecar.socket_path.as_deref(),
            Some(std::path::Path::new("/tmp/shore-llm.sock"))
        );
    }

    // ── BackgroundDefaultsConfig + resolver ──────────────────────────

    #[test]
    fn background_resolver_uses_per_task_when_set() {
        let d = DefaultsConfig {
            model: Some("chat".into()),
            background: BackgroundDefaultsConfig {
                model: Some("bg".into()),
                heartbeat: Some("hb".into()),
                ..BackgroundDefaultsConfig::default()
            },
            ..Default::default()
        };
        assert_eq!(
            d.resolve_background_model_name(BackgroundTask::Heartbeat),
            Some("hb")
        );
        // Compaction has no per-task override → falls back to background.model.
        assert_eq!(
            d.resolve_background_model_name(BackgroundTask::Compaction),
            Some("bg")
        );
    }

    #[test]
    fn background_resolver_ignores_defaults_model() {
        // `defaults.model` is *not* a background fallback — it's only
        // for chat. Background tasks fall through to the per-character
        // active chat model (handled by the per-task resolvers), so
        // this struct-level helper returns None when no background-
        // specific model is configured.
        let d_only_chat = DefaultsConfig {
            model: Some("chat".into()),
            ..Default::default()
        };
        for task in [
            BackgroundTask::Heartbeat,
            BackgroundTask::Compaction,
            BackgroundTask::Dreaming,
        ] {
            assert_eq!(d_only_chat.resolve_background_model_name(task), None);
        }

        // `background.model` is honored for every task without a
        // per-task override.
        let d_split = DefaultsConfig {
            model: Some("chat".into()),
            background: BackgroundDefaultsConfig {
                model: Some("bg".into()),
                ..BackgroundDefaultsConfig::default()
            },
            ..Default::default()
        };
        for task in [
            BackgroundTask::Heartbeat,
            BackgroundTask::Compaction,
            BackgroundTask::Dreaming,
        ] {
            assert_eq!(d_split.resolve_background_model_name(task), Some("bg"));
        }
    }

    #[test]
    fn background_resolver_returns_none_when_nothing_set() {
        let d = DefaultsConfig::default();
        assert_eq!(
            d.resolve_background_model_name(BackgroundTask::Heartbeat),
            None
        );
    }

    #[test]
    fn deprecated_top_level_keys_forward_into_background() {
        let toml_str = r#"
[defaults]
model = "primary"
heartbeat = "hb-old"
dreaming = "dream-old"
"#;
        let mut config: AppConfig = toml::from_str(toml_str).unwrap();
        // Pre-normalize: old keys still populated, background empty.
        assert_eq!(config.defaults.heartbeat.as_deref(), Some("hb-old"));
        assert_eq!(config.defaults.dreaming.as_deref(), Some("dream-old"));
        assert!(config.defaults.background.heartbeat.is_none());

        config.defaults.normalize_deprecated_aliases();

        // Old keys cleared, background filled.
        assert!(config.defaults.heartbeat.is_none());
        assert!(config.defaults.dreaming.is_none());
        assert_eq!(
            config.defaults.background.heartbeat.as_deref(),
            Some("hb-old")
        );
        assert_eq!(
            config.defaults.background.dreaming.as_deref(),
            Some("dream-old")
        );
    }

    #[test]
    fn new_background_keys_win_over_deprecated_aliases() {
        let toml_str = r#"
[defaults]
heartbeat = "hb-old"

[defaults.background]
heartbeat = "hb-new"
"#;
        let mut config: AppConfig = toml::from_str(toml_str).unwrap();
        config.defaults.normalize_deprecated_aliases();
        // The explicit new key is preserved; the legacy alias is dropped.
        assert_eq!(
            config.defaults.background.heartbeat.as_deref(),
            Some("hb-new")
        );
        assert!(config.defaults.heartbeat.is_none());
    }

    #[test]
    fn normalize_is_idempotent() {
        let mut d = DefaultsConfig {
            background: BackgroundDefaultsConfig {
                heartbeat: Some("hb".into()),
                ..BackgroundDefaultsConfig::default()
            },
            ..Default::default()
        };
        d.normalize_deprecated_aliases();
        d.normalize_deprecated_aliases();
        assert_eq!(d.background.heartbeat.as_deref(), Some("hb"));
        assert!(d.heartbeat.is_none());
    }

    #[test]
    fn background_section_parses_with_deny_unknown_fields() {
        let toml_str = r#"
[defaults.background]
model = "bg"
compaction = "bg-c"
"#;
        let config: AppConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.defaults.background.model.as_deref(), Some("bg"));
        assert_eq!(
            config.defaults.background.compaction.as_deref(),
            Some("bg-c")
        );

        // Unknown field is rejected.
        let bad = r#"
[defaults.background]
typo_field = "x"
"#;
        let err = toml::from_str::<AppConfig>(bad).unwrap_err();
        assert!(err.to_string().contains("unknown field"));
    }
}
