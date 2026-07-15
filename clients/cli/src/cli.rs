use clap::{Parser, Subcommand, ValueEnum};
use clap_complete::Shell;

#[derive(Parser, Debug)]
#[command(
    name = "shore",
    version,
    about = "Shore chat client",
    disable_help_subcommand = true
)]
pub(crate) struct Cli {
    /// TCP address of the daemon (overrides discovery)
    #[arg(long, global = true, env = "SHORE_ADDR")]
    pub addr: Option<String>,

    /// Path to config file (selects daemon instance)
    #[arg(long, global = true)]
    pub config: Option<String>,

    /// Character to talk to (overrides SHORE_CHARACTER env var)
    #[arg(long, short = 'c', global = true, env = "SHORE_CHARACTER")]
    pub character: Option<String>,

    /// Disable colored output (also respects NO_COLOR env var)
    #[arg(long, global = true)]
    pub no_color: bool,

    #[command(subcommand)]
    pub command: CliCommand,
}

#[derive(Subcommand, Debug)]
pub(crate) enum CliCommand {
    /// Send a message
    Send {
        /// The message text
        message: Vec<String>,

        /// Attach image file(s) to the message
        #[arg(short = 'i', long = "image")]
        images: Vec<String>,

        /// Override sampling temperature for this message
        #[arg(long)]
        temperature: Option<f64>,

        /// Override nucleus sampling top-p for this message
        #[arg(long)]
        top_p: Option<f64>,

        /// Enable extended thinking with optional budget (tokens)
        #[arg(long, num_args = 0..=1, default_missing_value = "10240")]
        thinking: Option<u32>,

        /// Inject as a system instruction instead of a user message
        #[arg(long)]
        system: bool,
    },

    /// Regenerate the last assistant response
    Regen {
        /// Optional guidance for the regeneration
        #[arg(short, long)]
        guidance: Option<String>,
    },

    /// List or select alternate responses for the latest assistant message
    Alt {
        /// Selector: list, prev, next, last, first, or 1-based alternate position
        #[arg(allow_hyphen_values = true)]
        selector: Option<String>,

        /// Assistant message reference (defaults to latest assistant)
        #[arg(long = "ref", allow_hyphen_values = true)]
        msg_ref: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Listen for daemon events and send desktop notifications
    Notify {
        /// Notify only for autonomous character messages (default)
        #[arg(long, conflicts_with = "all_messages")]
        autonomous_only: bool,

        /// Notify for all assistant messages, including normal replies
        #[arg(long, conflicts_with = "autonomous_only")]
        all_messages: bool,
    },

    /// Show conversation log, get/edit/delete messages
    #[command(args_conflicts_with_subcommands = true)]
    Log {
        #[command(subcommand)]
        subcommand: Option<LogCommand>,

        /// Message reference — show a single message (last, -1, 3, etc.)
        #[arg(allow_hyphen_values = true)]
        msg_ref: Option<String>,

        /// Number of turns to show
        #[arg(short = 'n', long = "turns", alias = "count", default_value = "64")]
        count: u32,

        /// Show only messages from one role (`character` aliases `assistant`)
        #[arg(long, value_enum, conflicts_with_all = ["heartbeat", "dreaming", "events", "api"])]
        role: Option<LogRole>,

        /// Follow mode: keep listening for new messages
        #[arg(short = 'f', long)]
        follow: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,

        /// Output only message content (no metadata)
        #[arg(long)]
        content: bool,

        /// Plain text output (no colors or decoration), pipe-friendly
        #[arg(long)]
        plain: bool,

        /// Also show reasoning/thinking blocks (hidden by default)
        #[arg(long)]
        reasoning: bool,

        /// Also show tool calls and their results (hidden by default)
        #[arg(long)]
        tools: bool,

        /// Also show sub-agent nested tool activity, in --follow (hidden by default)
        #[arg(long = "subagent-tools")]
        subagent_tools: bool,

        /// Show the heartbeat transcript: what each tick thought, the tools it
        /// called and their results, and the model/provider that served it
        #[arg(long, conflicts_with_all = ["dreaming", "events", "api", "msg_ref"])]
        heartbeat: bool,

        /// Show the dreaming/librarian transcript (full reasoning + tool I/O)
        #[arg(long, conflicts_with_all = ["heartbeat", "events", "api", "msg_ref"])]
        dreaming: bool,

        /// Show the heartbeat operational event timeline (tick fired, dormant,
        /// woke, timeout) instead of the transcript
        #[arg(long, conflicts_with_all = ["heartbeat", "dreaming", "api", "msg_ref"])]
        events: bool,

        /// Inspect raw LLM call payloads. Bare lists recent calls; pass an id
        /// (`--api 42`) to dump that call's full request/response
        #[expect(
            clippy::option_option,
            reason = "clap needs absent, present-without-value, and present-with-value states"
        )]
        #[arg(long, num_args = 0..=1, value_name = "ID", conflicts_with = "msg_ref")]
        api: Option<Option<i64>>,

        /// Filter `--api` by ledger call type (e.g. message, heartbeat, dreaming)
        #[arg(long, requires = "api")]
        call_type: Option<String>,
    },

    /// List or switch characters (no args = list, with name = switch)
    Character {
        /// Character name to switch to
        name: Option<String>,

        /// Show detailed character info
        #[arg(long)]
        info: bool,

        /// Create a new character scaffold directory
        #[arg(long)]
        new: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show daemon and session status
    Status {
        /// Show only a specific section (e.g. autonomy, tokens)
        #[arg(long)]
        section: Option<String>,

        /// Show recent API calls, tool invocations, and errors
        #[arg(long)]
        diagnostics: bool,

        /// Number of diagnostic entries to show (used with --diagnostics)
        #[arg(short = 'n', long, default_value = "10")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Advanced debugging utilities
    Debug {
        #[command(subcommand)]
        subcommand: DebugCommand,
    },

    /// List or switch models, or manage saved sampler settings.
    ///
    /// `shore model`                      list visible models
    /// `shore model <name>`               switch active model
    /// `shore model --info [<name>]`      show detailed model info
    /// `shore model --reset`              clear active model selection
    /// `shore model --all`                include hidden discovered models
    /// `shore model setting [...]`        manage saved sampler settings
    #[command(args_conflicts_with_subcommands = true)]
    Model {
        #[command(subcommand)]
        subcommand: Option<ModelCommand>,

        /// Model name to switch to (or look up with --info)
        name: Option<String>,

        /// Show detailed model info
        #[arg(long)]
        info: bool,

        /// Reset to config default model
        #[arg(long)]
        reset: bool,

        /// Include hidden discovered models in the list
        #[arg(long)]
        all: bool,

        /// Show which model each background task (heartbeat/compaction/
        /// dreaming) resolves to, and where that selection comes from.
        #[arg(long, conflicts_with_all = ["name", "info", "reset", "all"])]
        background: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Inspect or manage configured providers.
    ///
    /// `shore provider`                  list providers + key/cache status
    /// `shore provider models <name>`    list discovered + static models
    /// `shore provider refresh [name]`   re-fetch one provider's catalog,
    ///                                   or every discovery-enabled
    ///                                   provider when no name is given
    #[command(args_conflicts_with_subcommands = true)]
    Provider {
        #[command(subcommand)]
        subcommand: Option<ProviderCommand>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show, query, or manage the memory system
    #[command(args_conflicts_with_subcommands = true)]
    Memory {
        #[command(subcommand)]
        subcommand: Option<MemoryCommand>,

        /// Query to search memory
        query: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show or modify configuration
    #[command(args_conflicts_with_subcommands = true)]
    Config {
        #[command(subcommand)]
        subcommand: Option<ConfigCommand>,

        /// Optional key to get/set
        key: Option<String>,

        /// Value to set (requires key)
        value: Option<String>,

        /// Print the config directory path
        #[arg(long)]
        path: bool,

        /// Validate configuration and show warnings
        #[arg(long)]
        check: bool,

        /// Reset all runtime overrides (reload config from disk)
        #[arg(long)]
        reset: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,

        /// Output as TOML (suitable for pasting into a config file).
        /// Only valid for read-only config queries (no value, --check, or --reset).
        #[arg(long, conflicts_with_all = ["json", "check", "reset", "value"])]
        toml: bool,

        /// Include keys whose value matches the built-in default (shown dimmed)
        #[arg(long, short = 'a')]
        all: bool,
    },

    /// Show the tool surface: which tools are enabled, sub-agent ownership,
    /// the exec allowlist, and any dangling config references
    Tools {
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show token usage statistics and costs
    Usage {
        /// Time period: "today", "4h", "7d", "30d", "all" (default: today)
        #[arg(long, default_value = "today")]
        last: String,

        /// Filter by character name
        #[arg(long)]
        character: Option<String>,

        /// Filter by provider
        #[arg(long)]
        provider: Option<String>,

        /// Filter by configured API key name ("unknown" matches older rows)
        #[arg(long)]
        api_key: Option<String>,

        /// Filter by model
        #[arg(long)]
        model: Option<String>,

        /// Filter by call type. Pass without a value to see a breakdown
        /// grouped by call type (useful for discovering what types exist).
        #[expect(
            clippy::option_option,
            reason = "clap needs absent, present-without-value, and present-with-value states"
        )]
        #[arg(long, num_args = 0..=1)]
        call_type: Option<Option<String>>,

        /// Group by higher-level usage kind, e.g. message_with_tools
        #[arg(long)]
        by_kind: bool,

        /// Group by provider and configured API key name
        #[arg(long)]
        by_api_key: bool,

        /// Show configured budgets, limit state, and spike warnings
        #[arg(long)]
        budget: bool,

        /// Show only cache anomalies
        #[arg(long)]
        anomalies: bool,

        /// Export full ledger as CSV to stdout
        #[arg(long)]
        export_csv: bool,

        /// Export full ledger as TSV to stdout
        #[arg(long)]
        export_tsv: bool,

        /// Clear cached pricing data
        #[arg(long)]
        refresh_pricing: bool,

        /// Recalculate costs using current pricing
        #[arg(long)]
        recalculate: bool,

        /// Force recalculation of ALL rows (use with --recalculate)
        #[arg(long)]
        force: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// External connector (bridge) setup and management
    Connectors {
        #[command(subcommand)]
        subcommand: ConnectorsCommand,
    },

    /// Generate shell completions
    Completions {
        /// Shell to generate completions for
        shell: Shell,
    },

    /// Emit plain names for shell completion helpers (internal).
    ///
    /// Used by the dynamic completions appended to `shore completions fish`.
    /// Any failure (daemon down, parse error) results in empty output and
    /// a zero exit code so completions silently fall back to nothing.
    ///
    /// Name kept short (`complete`) rather than something like `__complete`
    /// because clap_complete 4.6.0 panics with
    /// `find_subcommand_with_path` when generating bash completions for
    /// subcommands renamed via `#[command(name = …)]`.
    #[command(hide = true)]
    Complete {
        /// What to enumerate
        kind: CompleteKind,
    },
}

/// Targets for the hidden `__complete` helper.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompleteKind {
    /// Chat model names from the daemon's catalog
    Models,
    /// Discovered character names
    Characters,
    /// Configured provider keys
    Providers,
}

/// Background task to retarget `shore model setting` at. `all` targets every
/// background task at once and errors if they resolve to different models.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackgroundTarget {
    All,
    Heartbeat,
    Compaction,
    Dreaming,
}

impl BackgroundTarget {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            BackgroundTarget::All => "all",
            BackgroundTarget::Heartbeat => "heartbeat",
            BackgroundTarget::Compaction => "compaction",
            BackgroundTarget::Dreaming => "dreaming",
        }
    }
}

#[derive(Subcommand, Debug)]
pub(crate) enum ConnectorsCommand {
    /// Matrix bridge setup and management
    Matrix {
        #[command(subcommand)]
        subcommand: MatrixCommand,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum MatrixCommand {
    /// Initialize embedded Synapse and provision all characters
    Setup,

    /// Register a user account on the embedded Synapse
    Register {
        /// Username (without @ or :server)
        #[arg(long)]
        username: String,

        /// Password (prompted or auto-generated if omitted)
        #[arg(long)]
        password: Option<String>,
    },
}

/// Message roles accepted by `shore log --role`.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LogRole {
    User,
    #[value(alias = "character")]
    Assistant,
    System,
}

impl LogRole {
    pub(crate) fn as_protocol_role(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

#[derive(Subcommand, Debug)]
pub(crate) enum LogCommand {
    /// Edit a message by reference (last, -1, 3, etc.)
    Edit {
        /// Message reference (last, -1, -2, 3, etc.)
        #[arg(allow_hyphen_values = true)]
        msg_ref: String,

        /// New content
        content: Vec<String>,
    },

    /// Delete a message by reference (last, -1, 3, etc.)
    Delete {
        /// Message reference (last, -1, -2, 3, etc.)
        #[arg(allow_hyphen_values = true)]
        msg_ref: String,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ModelCommand {
    /// Show, set, or reset saved sampler settings (temperature, top_p,
    /// reasoning_effort, budget_tokens, max_output_tokens, cache_ttl,
    /// cache_keepalive, sdk, replay_prior_thinking, max_tool_iterations) for
    /// the active model.
    ///
    /// `shore model setting`                          show effective sampler
    /// `shore model setting <key>`                    show one key
    /// `shore model setting <key> <value>`            set saved value
    /// `shore model setting --reset <key>`            clear saved value
    /// `shore model setting --reset` (no key)         (unsupported — pass a key)
    ///
    /// `sdk` accepts `anthropic`, `openai`, `gemini`, or `zai` — useful
    /// for forcing a wire shape on a discovered model whose provider
    /// catalog labelled it incorrectly.
    ///
    /// Vendor knobs (`openrouter_provider`, `vertex_project`, `vertex_location`,
    /// `gemini_generation`, `gemini_web_search`, `zai_clear_thinking`,
    /// `zai_subscription`) are also settable per-model; the list shown for a
    /// model includes only the knobs its resolved sdk honors.
    Setting {
        /// Setting key (temperature, top_p, reasoning_effort, sdk, ...)
        key: Option<String>,

        /// Value to assign. For booleans pass true/false.
        /// "off"/"none" map to no-reasoning for `reasoning_effort`.
        value: Option<String>,

        /// Apply to the global preferences file instead of the active
        /// character's. Without this flag, character-scope is used.
        #[arg(long)]
        global: bool,

        /// Clear the saved value for the named key.
        #[arg(long)]
        reset: bool,

        /// Operate on the model backing a background task instead of the
        /// active chat model, so you can tune heartbeat/compaction/dreaming
        /// without switching chat to that model. `all` errors if the tasks
        /// resolve to different models.
        #[arg(long, value_enum)]
        background: Option<BackgroundTarget>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ProviderCommand {
    /// List discovered + statically configured models for one provider.
    Models {
        /// Provider key (e.g. `openrouter`, `anthropic`)
        name: String,

        /// Include hidden discovered models in the main list
        #[arg(long)]
        all: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Re-fetch the provider's `/v1/models` catalog and update the cache.
    /// Omit the name to refresh every discovery-enabled provider.
    Refresh {
        /// Provider key to refresh. Omit to refresh all discovery-enabled
        /// providers in one batch.
        name: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum MemoryCommand {
    /// Compact conversation into markdown memory.
    /// Optional positional: number of recent user turns to retain
    /// (0 = retain none — leaves only the prompt files and memory index).
    Compact { keep_turns: Option<u32> },

    /// Show recent memory changelog entries
    Changelog {
        /// Number of entries to show
        #[arg(short = 'n', long, default_value = "20")]
        limit: u32,
    },

    /// Run or inspect the memory dreaming sweep
    Dream {
        /// Show dreaming scheduler state
        #[arg(long)]
        status: bool,

        /// Preview a sweep without writing dream state, DREAMS.md, or MEMORY.md
        #[arg(long)]
        dry_run: bool,

        /// Run even when the scheduler says the sweep is not due
        #[arg(long)]
        force: bool,
    },

    /// Print recent entries from the dreams audit log
    Dreams {
        /// Maximum number of entries to print (newest first)
        #[arg(short = 'n', long, default_value = "10")]
        limit: u32,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ConfigCommand {
    /// Reload config files from disk and, after confirmation, activate any
    /// pending system-prompt (workspace) edits. Prompt activation invalidates
    /// the provider prompt cache: the next message pays a one-time cache
    /// write.
    Reload {
        /// Refresh changed system prompt files without asking
        #[arg(short = 'y', long)]
        yes: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
#[command(rename_all = "snake_case")]
pub(crate) enum DebugCommand {
    /// Schedule a heartbeat tick to fire immediately
    #[command(name = "heartbeat_tick_now")]
    TickNow,
    /// Force heartbeat into dormant state (reverts on next user message)
    #[command(name = "heartbeat_status_dormant")]
    StatusDormant,
    /// Force heartbeat into active state (reverts naturally via abandonment guard)
    #[command(name = "heartbeat_status_active")]
    StatusActive,
}

/// Generate and print shell completions to stdout.
///
/// For fish we append dynamic completion lines that shell out to the
/// hidden `shore __complete` helper, so `shore model <TAB>` and
/// `shore character <TAB>` expand to the daemon's live lists instead
/// of leaving the positional argument uncompleted.
pub(crate) fn print_completions(shell: Shell) {
    use clap::CommandFactory;
    clap_complete::generate(shell, &mut Cli::command(), "shore", &mut std::io::stdout());
    if shell == Shell::Fish {
        cli_out!("{}", fish_dynamic_completions_footer());
    }
}

/// Fish completions for the positional `name` arguments of `shore model`,
/// `shore character`, and `shore provider {models,refresh}`. Kept as a
/// plain string so unit tests can assert exact content without depending
/// on the clap-generated output above.
pub(crate) fn fish_dynamic_completions_footer() -> &'static str {
    // `shore complete <kind> 2>/dev/null` swallows daemon-down errors so
    // fish silently falls back to no suggestions rather than printing a
    // wall of error messages at every tab press.
    "\n\
# ── Dynamic completions (populated by the daemon) ────────────────────\n\
complete -c shore -n \"__fish_shore_using_subcommand model\" -f -a \"(shore complete models 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand character\" -f -a \"(shore complete characters 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand provider; and __fish_seen_subcommand_from models refresh\" -f -a \"(shore complete providers 2>/dev/null)\"\n"
}

/// Parse a CLI-supplied sampler value into the JSON shape the daemon
/// expects. The daemon validates types per-key, so this only needs to
/// decide between number/bool/string/null without losing information.
///
/// - `reasoning_effort`: pass through as a string. Synonyms for
///   "disable" ("none"/"disable"/"disabled"/"unset"/"") collapse to the
///   sentinel "off"; the daemon's overlay then explicitly suppresses
///   `reasoning_effort` on the resolved model. JSON null is reserved
///   for *clearing* a saved preference (handled by `unset` flows).
/// - `replay_prior_thinking`: tri-state (#191). The strings
///   "all"/"last_turn"/"none" pass through verbatim; the legacy bool words
///   "true"/"yes"/"on" (→ all) and "false"/"no"/"off" (→ none) still coerce to
///   a bool the daemon maps for back-compat.
/// - `temperature`, `top_p`: parse as f64.
/// - `budget_tokens`, `max_output_tokens`, `max_tool_iterations`: parse as
///   integer.
/// - `cache_ttl`, `cache_keepalive`: pass through as a string (the daemon
///   parses `cache_keepalive`'s `off`/duration domain).
fn parse_setting_value(key: &str, raw: &str) -> serde_json::Value {
    use serde_json::Value;
    let trimmed = raw.trim();
    match key {
        "replay_prior_thinking"
        | "gemini_web_search"
        | "zai_clear_thinking"
        | "zai_subscription" => match trimmed.to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" => Value::Bool(true),
            "false" | "no" | "off" => Value::Bool(false),
            _ => Value::String(trimmed.to_owned()),
        },
        "temperature" | "top_p" => trimmed
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map_or_else(|| Value::String(trimmed.to_owned()), Value::Number),
        "budget_tokens" | "max_output_tokens" | "gemini_generation" | "max_tool_iterations" => {
            trimmed.parse::<u64>().map_or_else(
                |_| Value::String(trimmed.to_owned()),
                |n| Value::Number(n.into()),
            )
        }
        "reasoning_effort" => match trimmed.to_ascii_lowercase().as_str() {
            "off" | "none" | "disable" | "disabled" | "unset" | "" => Value::String("off".into()),
            _ => Value::String(trimmed.to_owned()),
        },
        // `openrouter_provider` is a routing object — accept a JSON object string
        // (e.g. `{"order":["Anthropic"]}`); fall through to a string otherwise so
        // the daemon reports a clear type error.
        "openrouter_provider" => serde_json::from_str::<Value>(trimmed)
            .unwrap_or_else(|_| Value::String(trimmed.to_owned())),
        // vertex_project / vertex_location and any unknown key: raw string.
        _ => Value::String(trimmed.to_owned()),
    }
}

pub(crate) fn alt_command_to_swp(
    selector: Option<&str>,
    msg_ref: Option<&str>,
) -> (&'static str, serde_json::Value) {
    use serde_json::json;

    let mut args = serde_json::Map::new();
    if let Some(reference) = msg_ref {
        let _ignored = args.insert("ref".into(), json!(reference));
    }

    match selector.unwrap_or("list") {
        "" | "list" => ("list_alternatives", serde_json::Value::Object(args)),
        chosen => {
            if let Ok(position) = chosen.parse::<u32>() {
                let _ignored = args.insert("position".into(), json!(position));
            } else {
                let _ignored = args.insert("direction".into(), json!(chosen));
            }
            ("alt", serde_json::Value::Object(args))
        }
    }
}

/// Map a CLI command to its SWP command name and JSON args.
///
/// Returns `None` for `Send` and `Regen` which use dedicated SWP message types
/// rather than the generic `command` type.
pub(crate) fn to_swp_command(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::json;
    match cmd {
        // These use dedicated SWP message types or are handled locally.
        CliCommand::Send { system: false, .. }
        | CliCommand::Regen { .. }
        | CliCommand::Notify { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }
        | CliCommand::Connectors { .. }
        | CliCommand::Config {
            path: true,
            check: false,
            reset: false,
            ..
        }
        | CliCommand::Config {
            subcommand: Some(_),
            ..
        } => None,

        CliCommand::Send {
            system: true,
            message,
            ..
        } => Some(("inject_system", json!({ "text": message.join(" ") }))),

        CliCommand::Alt {
            selector, msg_ref, ..
        } => Some(alt_command_to_swp(selector.as_deref(), msg_ref.as_deref())),

        // Character: list/switch/new handled locally, --info goes to daemon.
        CliCommand::Character { name, info, .. } => {
            if *info {
                let n = name.as_deref().unwrap_or("");
                Some(("character_info", json!({ "name": n })))
            } else {
                // list, switch, and new are handled in run.rs
                None
            }
        }

        // Log: subcommands (edit/delete), single message ref, or list.
        CliCommand::Log { .. } => log_to_swp(cmd),

        // Status: diagnostics mode or normal status.
        CliCommand::Status {
            diagnostics: true,
            count,
            ..
        } => Some(("diagnostics", json!({ "count": count }))),
        CliCommand::Status { .. } => Some(("status", json!({}))),

        CliCommand::Debug { subcommand } => match subcommand {
            DebugCommand::TickNow => Some(("heartbeat_tick_now", json!({}))),
            DebugCommand::StatusDormant => Some(("heartbeat_set_dormant", json!({}))),
            DebugCommand::StatusActive => Some(("heartbeat_set_active", json!({}))),
        },

        CliCommand::Model { .. } => model_to_swp(cmd),

        CliCommand::Provider { .. } => provider_to_swp(cmd),

        // Memory: subcommands (compact/changelog) or status/query.
        CliCommand::Memory { .. } => memory_to_swp(cmd),

        CliCommand::Config { reset: true, .. } => Some(("config_reset", json!({}))),
        CliCommand::Config { check: true, .. } => Some(("config_check", json!({}))),
        CliCommand::Config { key, value, .. } => {
            Some(("config", json!({ "key": key, "value": value })))
        }

        CliCommand::Tools { .. } => Some(("tools", json!({}))),

        CliCommand::Usage { .. } => usage_to_swp(cmd),
    }
}

/// `log` subcommands (edit/delete), single message ref, the heartbeat/dreaming
/// transcript, the heartbeat event timeline, raw call payloads, or the message
/// list.
fn log_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::{json, Map, Value};
    let CliCommand::Log {
        subcommand,
        msg_ref,
        role,
        heartbeat,
        dreaming,
        events,
        api,
        call_type,
        count,
        ..
    } = cmd
    else {
        return None;
    };
    if let Some(sub) = subcommand {
        return match sub {
            LogCommand::Edit {
                msg_ref: edit_ref,
                content,
            } => Some((
                "edit",
                json!({ "ref": edit_ref, "content": content.join(" ") }),
            )),
            LogCommand::Delete {
                msg_ref: delete_ref,
            } => Some(("delete", json!({ "refs": delete_ref }))),
        };
    }
    if let Some(r) = msg_ref {
        let mut args = Map::new();
        let _ignored = args.insert("ref".into(), json!(r));
        if let Some(role_filter) = role {
            _ = args.insert("role".into(), json!(role_filter.as_protocol_role()));
        }
        return Some(("get", Value::Object(args)));
    }
    if *heartbeat {
        return Some((
            "transcript",
            json!({ "source": "heartbeat", "count": count }),
        ));
    }
    if *dreaming {
        return Some((
            "transcript",
            json!({ "source": "dreaming", "count": count }),
        ));
    }
    if *events {
        return Some(("heartbeat_log", json!({ "count": count })));
    }
    if let Some(api_arg) = api {
        let mut args = Map::new();
        // `--api <id>` dumps one call; bare `--api` lists recent calls.
        if let Some(id) = api_arg {
            _ = args.insert("id".into(), json!(id));
        } else {
            _ = args.insert("count".into(), json!(count));
            if let Some(ct) = call_type {
                _ = args.insert("call_type".into(), json!(ct));
            }
        }
        return Some(("call_log", Value::Object(args)));
    }
    let mut args = Map::new();
    let _ignored = args.insert("turns".into(), json!(count));
    if let Some(role_filter) = role {
        _ = args.insert("role".into(), json!(role_filter.as_protocol_role()));
    }
    Some(("log", Value::Object(args)))
}

/// `model` setting (show/set/clear) or model list/switch/info/reset.
fn model_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::{json, Map, Value};
    let CliCommand::Model {
        subcommand,
        name,
        info,
        reset,
        all,
        background,
        ..
    } = cmd
    else {
        return None;
    };
    if let Some(ModelCommand::Setting {
        key,
        value,
        global,
        reset: setting_reset,
        background: setting_background,
        ..
    }) = subcommand
    {
        // No key → show current effective sampler. With a key:
        // value=Some → set; --reset → clear; otherwise → show one.
        // The CLI dispatch in run.rs is what actually picks the
        // right daemon command per case; keep this mapping aligned
        // with the "show" path (model_settings). `--background <purpose>`
        // retargets the read/write at that task's model via background_task.
        let scope = if *global { "global" } else { "character" };
        let bg = setting_background.map(BackgroundTarget::as_str);
        let with_bg = |mut obj: Map<String, Value>| -> Value {
            if let Some(task) = bg {
                let _ignored = obj.insert("background_task".into(), json!(task));
            }
            Value::Object(obj)
        };
        return match (key.as_deref(), value.as_deref(), *setting_reset) {
            (Some(k), _, true) => {
                let mut obj = Map::new();
                let _ignored = obj.insert("key".into(), json!(k));
                _ = obj.insert("value".into(), Value::Null);
                _ = obj.insert("scope".into(), json!(scope));
                Some(("set_model_setting", with_bg(obj)))
            }
            (None, _, _) | (Some(_), None, false) => Some(("model_settings", with_bg(Map::new()))),
            (Some(k), Some(v), false) => {
                let mut obj = Map::new();
                let _ignored = obj.insert("key".into(), json!(k));
                _ = obj.insert("value".into(), parse_setting_value(k, v));
                _ = obj.insert("scope".into(), json!(scope));
                Some(("set_model_setting", with_bg(obj)))
            }
        };
    }

    if *background {
        return Some(("background_models", json!({})));
    }

    if *reset {
        return Some(("reset_model", json!({})));
    }
    match (name, info) {
        (Some(model_name), true) => Some(("model_info", json!({ "name": model_name }))),
        (None, true) => Some(("model_info", json!({}))),
        (None, false) => {
            let mut args = Map::new();
            if *all {
                let _ignored = args.insert("include_hidden".into(), json!(true));
            }
            Some(("list_models", Value::Object(args)))
        }
        (Some(model_name), false) => {
            let mut args = Map::new();
            let _ignored = args.insert("name".into(), json!(model_name));
            if *all {
                _ = args.insert("include_hidden".into(), json!(true));
            }
            Some(("switch_model", Value::Object(args)))
        }
    }
}

/// `provider` models listing / refresh, or provider listing.
fn provider_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::json;
    let CliCommand::Provider { subcommand, .. } = cmd else {
        return None;
    };
    match subcommand {
        Some(ProviderCommand::Models { name, all, .. }) => Some((
            "list_provider_models",
            json!({ "provider": name, "include_hidden": *all }),
        )),
        Some(ProviderCommand::Refresh { name: Some(n), .. }) => {
            Some(("refresh_provider_models", json!({ "provider": n })))
        }
        Some(ProviderCommand::Refresh { name: None, .. }) => {
            Some(("refresh_all_provider_models", json!({})))
        }
        None => Some(("list_providers", json!({}))),
    }
}

/// `memory` subcommands (compact/changelog/dream/dreams) or status/query.
fn memory_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::{json, Map, Value};
    let CliCommand::Memory {
        subcommand, query, ..
    } = cmd
    else {
        return None;
    };
    match subcommand {
        Some(MemoryCommand::Compact { keep_turns }) => {
            let mut args = Map::new();
            if let Some(n) = keep_turns {
                let _ignored = args.insert("keep_turns".into(), json!(n));
            }
            Some(("compact", Value::Object(args)))
        }
        Some(MemoryCommand::Changelog { limit }) => {
            Some(("memory_changelog", json!({ "limit": limit })))
        }
        Some(MemoryCommand::Dream {
            status,
            dry_run,
            force,
        }) => Some((
            "memory_dream",
            json!({ "status": status, "dry_run": dry_run, "force": force }),
        )),
        Some(MemoryCommand::Dreams { limit }) => Some(("memory_dreams", json!({ "limit": limit }))),
        None => Some(("memory", json!({ "query": query }))),
    }
}

/// `usage` query with grouping / filter / export flags.
fn usage_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::json;
    let CliCommand::Usage {
        last,
        character,
        provider,
        api_key,
        model,
        call_type,
        by_kind,
        by_api_key,
        budget,
        anomalies,
        export_csv,
        export_tsv,
        refresh_pricing,
        recalculate,
        force,
        json: _,
    } = cmd
    else {
        return None;
    };
    // Three-state flag:
    //   absent         → None,             no grouping, no filter
    //   --call-type    → Some(None),       breakdown mode
    //   --call-type X  → Some(Some("X")),  filter by X
    let (by_call_type, call_type_filter) = match call_type {
        None => (false, None),
        Some(None) => (true, None),
        Some(Some(v)) => (false, Some(v.clone())),
    };
    Some((
        "usage",
        json!({
            "last": last,
            "character": character,
            "provider": provider,
            "api_key": api_key,
            "model": model,
            "call_type": call_type_filter,
            "by_call_type": by_call_type,
            "by_kind": by_kind,
            "by_api_key": by_api_key,
            "budget": budget,
            "anomalies": anomalies,
            "export_csv": export_csv,
            "export_tsv": export_tsv,
            "refresh_pricing": refresh_pricing,
            "recalculate": recalculate,
            "force": force,
        }),
    ))
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    /// Helper: parse a command line into a Cli.
    fn parse(args: &[&str]) -> Cli {
        let mut full = vec!["shore"];
        full.extend_from_slice(args);
        Cli::parse_from(full)
    }

    fn arg<'val>(args: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        args.get(key).expect("expected command argument")
    }

    // ── Send ─────────────────────────────────────────────────────────

    #[test]
    fn parse_send() {
        let cli = parse(&["send", "hello", "world"]);
        assert_variant!(
            &cli.command,
            CliCommand::Send {
                message, images, ..
            } => {
                assert_eq!(message, &["hello", "world"]);
                assert!(images.is_empty());
            }
        );
    }

    #[test]
    fn parse_send_with_image() {
        let cli = parse(&["send", "-i", "photo.jpg", "describe", "this"]);
        assert_variant!(
            &cli.command,
            CliCommand::Send {
                message, images, ..
            } => {
                assert_eq!(message, &["describe", "this"]);
                assert_eq!(images, &["photo.jpg"]);
            }
        );
    }

    #[test]
    fn parse_send_with_multiple_images() {
        let cli = parse(&["send", "-i", "a.jpg", "-i", "b.png", "compare"]);
        assert_variant!(
            &cli.command,
            CliCommand::Send {
                message, images, ..
            } => {
                assert_eq!(message, &["compare"]);
                assert_eq!(images, &["a.jpg", "b.png"]);
            }
        );
    }

    // ── Regen ────────────────────────────────────────────────────────

    #[test]
    fn parse_regen_no_guidance() {
        let cli = parse(&["regen"]);
        assert_variant!(
            &cli.command,
            CliCommand::Regen { guidance } => {
                assert!(guidance.is_none());
            }
        );
    }

    #[test]
    fn parse_regen_with_guidance() {
        let cli = parse(&["regen", "--guidance", "be more concise"]);
        assert_variant!(
            &cli.command,
            CliCommand::Regen { guidance } => {
                assert_eq!(guidance.as_deref(), Some("be more concise"));
            }
        );
    }

    // ── Notify ───────────────────────────────────────────────────────

    #[test]
    fn parse_notify_default() {
        let cli = parse(&["notify"]);
        assert_variant!(
            &cli.command,
            CliCommand::Notify {
                autonomous_only,
                all_messages,
            } => {
                assert!(!autonomous_only);
                assert!(!all_messages);
            }
        );
    }

    #[test]
    fn parse_notify_all_messages() {
        let cli = parse(&["notify", "--all-messages"]);
        assert_variant!(
            &cli.command,
            CliCommand::Notify { all_messages, .. } => {
                assert!(*all_messages);
            }
        );
    }

    #[test]
    fn parse_notify_modes_conflict() {
        let result =
            Cli::try_parse_from(["shore", "notify", "--autonomous-only", "--all-messages"]);
        assert!(result.is_err());
    }

    // ── Alt ──────────────────────────────────────────────────────────

    #[test]
    fn parse_alt_defaults_to_list() {
        let cli = parse(&["alt"]);
        assert_variant!(
            &cli.command,
            CliCommand::Alt {
                selector,
                msg_ref,
                json,
            } => {
                assert!(selector.is_none());
                assert!(msg_ref.is_none());
                assert!(!json);
            }
        );
    }

    #[test]
    fn parse_alt_position_with_ref_and_json() {
        let cli = parse(&["alt", "2", "--ref", "-1", "--json"]);
        assert_variant!(
            &cli.command,
            CliCommand::Alt {
                selector,
                msg_ref,
                json,
            } => {
                assert_eq!(selector.as_deref(), Some("2"));
                assert_eq!(msg_ref.as_deref(), Some("-1"));
                assert!(*json);
            }
        );
    }

    // ── Log ──────────────────────────────────────────────────────────

    #[test]
    fn parse_log_default() {
        let cli = parse(&["log"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                subcommand,
                msg_ref,
                count,
                role,
                follow,
                json,
                content,
                plain,
                reasoning,
                tools,
                subagent_tools,
                heartbeat,
                dreaming,
                events,
                api,
                call_type,
            } => {
                assert!(subcommand.is_none());
                assert!(msg_ref.is_none());
                assert_eq!(*count, 64);
                assert!(role.is_none());
                assert!(!follow);
                assert!(!json);
                assert!(!content);
                assert!(!plain);
                assert!(!reasoning);
                assert!(!tools);
                assert!(!subagent_tools);
                assert!(!heartbeat);
                assert!(!dreaming);
                assert!(!events);
                assert!(api.is_none());
                assert!(call_type.is_none());
            }
        );
    }

    #[test]
    fn parse_log_custom_count() {
        let cli = parse(&["log", "--count", "50"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log { count, .. } => {
                assert_eq!(*count, 50);
            }
        );
    }

    #[test]
    fn parse_log_get_by_ref() {
        let cli = parse(&["log", "last"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                msg_ref,
                subcommand,
                ..
            } => {
                assert!(subcommand.is_none());
                assert_eq!(msg_ref.as_deref(), Some("last"));
            }
        );
    }

    #[test]
    fn parse_log_get_by_role() {
        let cli = parse(&["log", "last", "--role", "user"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log { msg_ref, role, .. } => {
                assert_eq!(msg_ref.as_deref(), Some("last"));
                assert_eq!(*role, Some(LogRole::User));
            }
        );
    }

    #[test]
    fn parse_log_character_role_alias() {
        let cli = parse(&["log", "--role", "character"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log { role, .. } => {
                assert_eq!(*role, Some(LogRole::Assistant));
            }
        );
    }

    #[test]
    fn parse_log_get_positive_index() {
        let cli = parse(&["log", "3"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                msg_ref,
                subcommand,
                ..
            } => {
                assert!(subcommand.is_none());
                assert_eq!(msg_ref.as_deref(), Some("3"));
            }
        );
    }

    #[test]
    fn parse_log_edit() {
        let cli = parse(&["log", "edit", "msg_123", "new", "text"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                subcommand: Some(LogCommand::Edit { msg_ref, content }),
                ..
            } => {
                assert_eq!(msg_ref, "msg_123");
                assert_eq!(content, &["new", "text"]);
            }
        );
    }

    #[test]
    fn parse_log_edit_last() {
        let cli = parse(&["log", "edit", "last", "updated"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                subcommand: Some(LogCommand::Edit { msg_ref, content }),
                ..
            } => {
                assert_eq!(msg_ref, "last");
                assert_eq!(content, &["updated"]);
            }
        );
    }

    #[test]
    fn parse_log_edit_negative_index() {
        let cli = parse(&["log", "edit", "-1", "new", "text"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                subcommand: Some(LogCommand::Edit { msg_ref, content }),
                ..
            } => {
                assert_eq!(msg_ref, "-1");
                assert_eq!(content, &["new", "text"]);
            }
        );
    }

    #[test]
    fn parse_log_delete() {
        let cli = parse(&["log", "delete", "msg_456"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                subcommand: Some(LogCommand::Delete { msg_ref }),
                ..
            } => {
                assert_eq!(msg_ref, "msg_456");
            }
        );
    }

    #[test]
    fn parse_log_delete_negative_index() {
        let cli = parse(&["log", "delete", "-1"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                subcommand: Some(LogCommand::Delete { msg_ref }),
                ..
            } => {
                assert_eq!(msg_ref, "-1");
            }
        );
    }

    #[test]
    fn log_swipe_is_not_a_subcommand() {
        let result = Cli::try_parse_from(["shore", "log", "swipe", "prev"]);
        assert!(result.is_err());
    }

    // ── Character ────────────────────────────────────────────────────

    #[test]
    fn parse_character_list() {
        let cli = parse(&["character"]);
        assert_variant!(
            &cli.command,
            CliCommand::Character { name, info, .. } => {
                assert!(name.is_none());
                assert!(!info);
            }
        );
    }

    #[test]
    fn parse_character_switch() {
        let cli = parse(&["character", "alice"]);
        assert_variant!(
            &cli.command,
            CliCommand::Character { name, info, .. } => {
                assert_eq!(name.as_deref(), Some("alice"));
                assert!(!info);
            }
        );
    }

    #[test]
    fn parse_character_info() {
        let cli = parse(&["character", "alice", "--info"]);
        assert_variant!(
            &cli.command,
            CliCommand::Character { name, info, .. } => {
                assert_eq!(name.as_deref(), Some("alice"));
                assert!(info);
            }
        );
    }

    // ── Status ───────────────────────────────────────────────────────

    #[test]
    fn parse_status() {
        let cli = parse(&["status"]);
        assert_variant!(
            &cli.command,
            CliCommand::Status {
                section,
                diagnostics,
                ..
            } => {
                assert!(section.is_none());
                assert!(!diagnostics);
            }
        );
    }

    #[test]
    fn parse_status_diagnostics() {
        let cli = parse(&["status", "--diagnostics"]);
        assert_variant!(
            &cli.command,
            CliCommand::Status {
                diagnostics, count, ..
            } => {
                assert!(diagnostics);
                assert_eq!(*count, 10);
            }
        );
    }

    #[test]
    fn parse_status_diagnostics_with_count() {
        let cli = parse(&["status", "--diagnostics", "-n", "25"]);
        assert_variant!(
            &cli.command,
            CliCommand::Status {
                diagnostics, count, ..
            } => {
                assert!(diagnostics);
                assert_eq!(*count, 25);
            }
        );
    }

    // ── Debug ────────────────────────────────────────────────────────

    #[test]
    fn parse_debug_tick_now() {
        let cli = parse(&["debug", "heartbeat_tick_now"]);
        assert_variant!(
            &cli.command,
            CliCommand::Debug {
                subcommand: DebugCommand::TickNow,
            } => {}
        );
    }

    #[test]
    fn parse_debug_status_dormant() {
        let cli = parse(&["debug", "heartbeat_status_dormant"]);
        assert_variant!(
            &cli.command,
            CliCommand::Debug {
                subcommand: DebugCommand::StatusDormant,
            } => {}
        );
    }

    #[test]
    fn parse_debug_status_active() {
        let cli = parse(&["debug", "heartbeat_status_active"]);
        assert_variant!(
            &cli.command,
            CliCommand::Debug {
                subcommand: DebugCommand::StatusActive,
            } => {}
        );
    }

    // ── Model ────────────────────────────────────────────────────────

    #[test]
    fn parse_model_list() {
        let cli = parse(&["model"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model {
                name,
                info,
                subcommand,
                all,
                ..
            } => {
                assert!(name.is_none());
                assert!(!info);
                assert!(subcommand.is_none());
                assert!(!all);
            }
        );
    }

    #[test]
    fn parse_model_switch() {
        let cli = parse(&["model", "claude-haiku-4-5-20251001"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model {
                name,
                info,
                subcommand,
                ..
            } => {
                assert_eq!(name.as_deref(), Some("claude-haiku-4-5-20251001"));
                assert!(!info);
                assert!(subcommand.is_none());
            }
        );
    }

    #[test]
    fn parse_model_info() {
        let cli = parse(&["model", "opus", "--info"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model { name, info, .. } => {
                assert_eq!(name.as_deref(), Some("opus"));
                assert!(info);
            }
        );
    }

    #[test]
    fn parse_model_all_flag() {
        let cli = parse(&["model", "--all"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model { all, .. } => assert!(all),
        );
    }

    #[test]
    fn parse_model_setting_show() {
        let cli = parse(&["model", "setting"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model {
                subcommand: Some(ModelCommand::Setting { key, value, .. }),
                ..
            } => {
                assert!(key.is_none());
                assert!(value.is_none());
            }
        );
    }

    #[test]
    fn parse_model_setting_with_value() {
        let cli = parse(&["model", "setting", "temperature", "0.8"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model {
                subcommand:
                    Some(ModelCommand::Setting {
                        key,
                        value,
                        global,
                        reset,
                        ..
                    }),
                ..
            } => {
                assert_eq!(key.as_deref(), Some("temperature"));
                assert_eq!(value.as_deref(), Some("0.8"));
                assert!(!global);
                assert!(!reset);
            }
        );
    }

    #[test]
    fn parse_model_setting_reset() {
        let cli = parse(&["model", "setting", "--reset", "temperature"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model {
                subcommand:
                    Some(ModelCommand::Setting {
                        key, reset, value, ..
                    }),
                ..
            } => {
                assert_eq!(key.as_deref(), Some("temperature"));
                assert!(reset);
                assert!(value.is_none());
            }
        );
    }

    #[test]
    fn parse_model_setting_global_flag() {
        let cli = parse(&["model", "setting", "--global", "top_p", "0.9"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model {
                subcommand: Some(ModelCommand::Setting { global, .. }),
                ..
            } => {
                assert!(global);
            }
        );
    }

    // ── Provider ─────────────────────────────────────────────────────

    #[test]
    fn parse_provider_list() {
        let cli = parse(&["provider"]);
        assert_variant!(
            &cli.command,
            CliCommand::Provider { subcommand, .. } => assert!(subcommand.is_none()),
        );
    }

    #[test]
    fn parse_provider_models() {
        let cli = parse(&["provider", "models", "openrouter"]);
        assert_variant!(
            &cli.command,
            CliCommand::Provider {
                subcommand: Some(ProviderCommand::Models { name, all, .. }),
                ..
            } => {
                assert_eq!(name, "openrouter");
                assert!(!all);
            }
        );
    }

    #[test]
    fn parse_provider_models_all() {
        let cli = parse(&["provider", "models", "openrouter", "--all"]);
        assert_variant!(
            &cli.command,
            CliCommand::Provider {
                subcommand: Some(ProviderCommand::Models { all, .. }),
                ..
            } => assert!(all),
        );
    }

    #[test]
    fn parse_provider_refresh() {
        let cli = parse(&["provider", "refresh", "openrouter"]);
        assert_variant!(
            &cli.command,
            CliCommand::Provider {
                subcommand: Some(ProviderCommand::Refresh { name, .. }),
                ..
            } => assert_eq!(name.as_deref(), Some("openrouter")),
        );
    }

    #[test]
    fn parse_provider_refresh_no_arg() {
        let cli = parse(&["provider", "refresh"]);
        assert_variant!(
            &cli.command,
            CliCommand::Provider {
                subcommand: Some(ProviderCommand::Refresh { name, .. }),
                ..
            } => assert!(name.is_none()),
        );
    }

    // ── Memory ───────────────────────────────────────────────────────

    #[test]
    fn parse_memory_no_query() {
        let cli = parse(&["memory"]);
        assert_variant!(
            &cli.command,
            CliCommand::Memory {
                query, subcommand, ..
            } => {
                assert!(query.is_none());
                assert!(subcommand.is_none());
            }
        );
    }

    #[test]
    fn parse_memory_with_query() {
        let cli = parse(&["memory", "recent topics"]);
        assert_variant!(
            &cli.command,
            CliCommand::Memory {
                query, subcommand, ..
            } => {
                assert_eq!(query.as_deref(), Some("recent topics"));
                assert!(subcommand.is_none());
            }
        );
    }

    #[test]
    fn parse_memory_compact() {
        let cli = parse(&["memory", "compact"]);
        assert_variant!(
            &cli.command,
            CliCommand::Memory {
                subcommand: Some(MemoryCommand::Compact { keep_turns: None }),
                ..
            } => {}
        );
    }

    #[test]
    fn parse_memory_compact_with_keep_turns_zero() {
        let cli = parse(&["memory", "compact", "0"]);
        assert_variant!(
            &cli.command,
            CliCommand::Memory {
                subcommand:
                    Some(MemoryCommand::Compact {
                        keep_turns: Some(0),
                    }),
                ..
            } => {}
        );
    }

    #[test]
    fn parse_memory_compact_with_keep_turns_n() {
        let cli = parse(&["memory", "compact", "8"]);
        assert_variant!(
            &cli.command,
            CliCommand::Memory {
                subcommand:
                    Some(MemoryCommand::Compact {
                        keep_turns: Some(8),
                    }),
                ..
            } => {}
        );
    }

    #[test]
    fn parse_memory_changelog() {
        let cli = parse(&["memory", "changelog"]);
        assert_variant!(
            &cli.command,
            CliCommand::Memory {
                subcommand: Some(MemoryCommand::Changelog { limit }),
                ..
            } => {
                assert_eq!(*limit, 20);
            }
        );
    }

    #[test]
    fn parse_memory_changelog_with_limit() {
        let cli = parse(&["memory", "changelog", "-n", "50"]);
        assert_variant!(
            &cli.command,
            CliCommand::Memory {
                subcommand: Some(MemoryCommand::Changelog { limit }),
                ..
            } => {
                assert_eq!(*limit, 50);
            }
        );
    }

    // ── Config ───────────────────────────────────────────────────────

    #[test]
    fn parse_config_no_args() {
        let cli = parse(&["config"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config {
                key,
                value,
                path,
                check,
                reset,
                ..
            } => {
                assert!(key.is_none());
                assert!(value.is_none());
                assert!(!path);
                assert!(!check);
                assert!(!reset);
            }
        );
    }

    #[test]
    fn parse_config_with_key() {
        let cli = parse(&["config", "model"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config { key, value, .. } => {
                assert_eq!(key.as_deref(), Some("model"));
                assert!(value.is_none());
            }
        );
    }

    #[test]
    fn parse_config_with_key_value() {
        let cli = parse(&["config", "model", "claude-haiku-4-5-20251001"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config { key, value, .. } => {
                assert_eq!(key.as_deref(), Some("model"));
                assert_eq!(value.as_deref(), Some("claude-haiku-4-5-20251001"));
            }
        );
    }

    #[test]
    fn parse_config_reload() {
        let cli = parse(&["config", "reload"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config {
                subcommand: Some(ConfigCommand::Reload { yes, json }),
                ..
            } => {
                assert!(!yes);
                assert!(!json);
            }
        );
    }

    #[test]
    fn parse_config_reload_yes() {
        let cli = parse(&["config", "reload", "-y"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config {
                subcommand: Some(ConfigCommand::Reload { yes, .. }),
                ..
            } => assert!(yes)
        );
    }

    #[test]
    fn config_reload_maps_to_none() {
        // Handled by a dedicated two-phase flow in run.rs, not the generic path.
        let cmd = CliCommand::Config {
            subcommand: Some(ConfigCommand::Reload {
                yes: false,
                json: false,
            }),
            key: None,
            value: None,
            path: false,
            check: false,
            reset: false,
            json: false,
            toml: false,
            all: false,
        };
        assert!(to_swp_command(&cmd).is_none());
    }

    #[test]
    fn parse_config_path() {
        let cli = parse(&["config", "--path"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config { path, .. } => {
                assert!(path);
            }
        );
    }

    // ── Global flags ─────────────────────────────────────────────────

    #[test]
    fn parse_global_addr_flag() {
        let cli = parse(&["--addr", "127.0.0.1:7320", "status"]);
        assert_eq!(cli.addr.as_deref(), Some("127.0.0.1:7320"));
        assert!(matches!(cli.command, CliCommand::Status { .. }));
    }

    #[test]
    fn parse_global_config_flag() {
        let cli = parse(&["--config", "/etc/shore.toml", "status"]);
        assert_eq!(cli.config.as_deref(), Some("/etc/shore.toml"));
        assert!(matches!(cli.command, CliCommand::Status { .. }));
    }

    // ── SWP mapping tests ────────────────────────────────────────────

    #[test]
    fn send_maps_to_none() {
        let cmd = CliCommand::Send {
            message: vec!["hi".into()],
            images: vec![],
            temperature: None,
            top_p: None,
            thinking: None,
            system: false,
        };
        assert!(to_swp_command(&cmd).is_none());
    }

    #[test]
    fn regen_maps_to_none() {
        let cmd = CliCommand::Regen { guidance: None };
        assert!(to_swp_command(&cmd).is_none());
    }

    #[test]
    fn notify_maps_to_none() {
        let cmd = CliCommand::Notify {
            autonomous_only: false,
            all_messages: false,
        };
        assert!(to_swp_command(&cmd).is_none());
    }

    #[test]
    fn completions_maps_to_none() {
        let cmd = CliCommand::Completions { shell: Shell::Fish };
        assert!(to_swp_command(&cmd).is_none());
    }

    #[test]
    fn status_maps_to_command() {
        let cmd = CliCommand::Status {
            section: None,
            diagnostics: false,
            count: 10,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "status");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn status_diagnostics_maps_to_command() {
        let cmd = CliCommand::Status {
            section: None,
            diagnostics: true,
            count: 15,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "diagnostics");
        assert_eq!(arg(&args, "count"), 15);
    }

    #[test]
    fn debug_tick_now_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: DebugCommand::TickNow,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "heartbeat_tick_now");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn debug_status_dormant_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: DebugCommand::StatusDormant,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "heartbeat_set_dormant");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn debug_status_active_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: DebugCommand::StatusActive,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "heartbeat_set_active");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn character_maps_to_none_without_info() {
        let cmd_none = CliCommand::Character {
            name: None,
            info: false,
            new: false,
            json: false,
        };
        assert!(to_swp_command(&cmd_none).is_none());
        let cmd_named = CliCommand::Character {
            name: Some("alice".into()),
            info: false,
            new: false,
            json: false,
        };
        assert!(to_swp_command(&cmd_named).is_none());
    }

    #[test]
    fn character_info_maps_to_command() {
        let cmd = CliCommand::Character {
            name: Some("alice".into()),
            info: true,
            new: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "character_info");
        assert_eq!(arg(&args, "name"), "alice");
    }

    #[test]
    fn model_info_maps_to_command() {
        let cmd = CliCommand::Model {
            subcommand: None,
            name: Some("opus".into()),
            info: true,
            reset: false,
            all: false,
            background: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "model_info");
        assert_eq!(arg(&args, "name"), "opus");
    }

    #[test]
    fn model_list_with_all_includes_hidden_arg() {
        let cmd = CliCommand::Model {
            subcommand: None,
            name: None,
            info: false,
            reset: false,
            all: true,
            background: false,
            json: false,
        };
        let (cmd_name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(cmd_name, "list_models");
        assert_eq!(arg(&args, "include_hidden"), true);
    }

    #[test]
    fn model_setting_no_key_maps_to_show() {
        let cmd = CliCommand::Model {
            subcommand: Some(ModelCommand::Setting {
                key: None,
                value: None,
                global: false,
                reset: false,
                background: None,
                json: false,
            }),
            name: None,
            info: false,
            reset: false,
            all: false,
            background: false,
            json: false,
        };
        let (name, _) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "model_settings");
    }

    #[test]
    fn model_setting_with_value_maps_to_set_model_setting() {
        let cmd = CliCommand::Model {
            subcommand: Some(ModelCommand::Setting {
                key: Some("temperature".into()),
                value: Some("0.8".into()),
                global: false,
                reset: false,
                background: None,
                json: false,
            }),
            name: None,
            info: false,
            reset: false,
            all: false,
            background: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "key"), "temperature");
        assert_eq!(arg(&args, "value"), 0.8);
        assert_eq!(arg(&args, "scope"), "character");
    }

    #[test]
    fn model_setting_reset_clears_with_null_value() {
        let cmd = CliCommand::Model {
            subcommand: Some(ModelCommand::Setting {
                key: Some("budget_tokens".into()),
                value: None,
                global: false,
                reset: true,
                background: None,
                json: false,
            }),
            name: None,
            info: false,
            reset: false,
            all: false,
            background: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "set_model_setting");
        assert!(arg(&args, "value").is_null());
    }

    #[test]
    fn model_setting_global_scope_routes_correctly() {
        let cmd = CliCommand::Model {
            subcommand: Some(ModelCommand::Setting {
                key: Some("top_p".into()),
                value: Some("0.95".into()),
                global: true,
                reset: false,
                background: None,
                json: false,
            }),
            name: None,
            info: false,
            reset: false,
            all: false,
            background: false,
            json: false,
        };
        let (_, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(arg(&args, "scope"), "global");
    }

    #[test]
    fn model_background_flag_maps_to_background_models() {
        let cli = parse(&["model", "--background"]);
        let (name, _) = to_swp_command(&cli.command).unwrap();
        assert_eq!(name, "background_models");
    }

    #[test]
    fn model_background_flag_conflicts_with_selectors() {
        // `--background` shows the resolved table; combining it with a model
        // selector or its flags must be rejected, not silently ignored.
        assert!(Cli::try_parse_from(["shore", "model", "--background", "somemodel"]).is_err());
        assert!(Cli::try_parse_from(["shore", "model", "--background", "--info"]).is_err());
        assert!(Cli::try_parse_from(["shore", "model", "--background", "--reset"]).is_err());
        assert!(Cli::try_parse_from(["shore", "model", "--background", "--all"]).is_err());
        // Bare `--background` still parses.
        assert!(Cli::try_parse_from(["shore", "model", "--background"]).is_ok());
    }

    #[test]
    fn model_setting_background_show_threads_task() {
        let cli = parse(&["model", "setting", "--background", "compaction"]);
        let (name, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(name, "model_settings");
        assert_eq!(arg(&args, "background_task"), "compaction");
    }

    #[test]
    fn model_setting_background_set_threads_task() {
        let cli = parse(&[
            "model",
            "setting",
            "--background",
            "all",
            "temperature",
            "0.5",
        ]);
        let (name, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "key"), "temperature");
        assert_eq!(arg(&args, "value"), 0.5);
        assert_eq!(arg(&args, "background_task"), "all");
        assert_eq!(arg(&args, "scope"), "character");
    }

    #[test]
    fn model_setting_background_reset_threads_task() {
        let cli = parse(&[
            "model",
            "setting",
            "--background",
            "heartbeat",
            "--reset",
            "reasoning_effort",
        ]);
        let (name, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(name, "set_model_setting");
        assert!(arg(&args, "value").is_null());
        assert_eq!(arg(&args, "background_task"), "heartbeat");
    }

    #[test]
    fn model_setting_without_background_omits_task() {
        let cli = parse(&["model", "setting", "temperature", "0.7"]);
        let (name, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(name, "set_model_setting");
        assert!(args.get("background_task").is_none());
    }

    #[test]
    fn model_setting_reasoning_off_sends_off_sentinel() {
        // `shore model setting reasoning_effort off` must send the
        // string "off" (not JSON null). The daemon's overlay maps
        // Some("off") → unset reasoning_effort on the resolved model,
        // while null clears the saved override and lets the model's
        // intrinsic value leak through.
        let cmd = CliCommand::Model {
            subcommand: Some(ModelCommand::Setting {
                key: Some("reasoning_effort".into()),
                value: Some("off".into()),
                global: false,
                reset: false,
                background: None,
                json: false,
            }),
            name: None,
            info: false,
            reset: false,
            all: false,
            background: false,
            json: false,
        };
        let (_, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(arg(&args, "value"), "off");
    }

    #[test]
    fn model_setting_reasoning_disable_synonyms_normalize_to_off() {
        for synonym in ["none", "DISABLE", "Disabled", "unset", ""] {
            let cmd = CliCommand::Model {
                subcommand: Some(ModelCommand::Setting {
                    key: Some("reasoning_effort".into()),
                    value: Some(synonym.into()),
                    global: false,
                    reset: false,
                    background: None,
                    json: false,
                }),
                name: None,
                info: false,
                reset: false,
                all: false,
                background: false,
                json: false,
            };
            let (_, args) = to_swp_command(&cmd).unwrap();
            assert_eq!(arg(&args, "value"), "off", "synonym {synonym:?}");
        }
    }

    #[test]
    fn parse_setting_value_coerces_vendor_knobs() {
        use serde_json::json;
        // bool-typed vendor knobs.
        assert_eq!(
            parse_setting_value("zai_clear_thinking", "false"),
            json!(false)
        );
        assert_eq!(parse_setting_value("gemini_web_search", "on"), json!(true));
        assert_eq!(parse_setting_value("zai_subscription", "yes"), json!(true));
        // u64-typed.
        assert_eq!(parse_setting_value("gemini_generation", "3"), json!(3));
        // string-typed.
        assert_eq!(
            parse_setting_value("vertex_project", "my-proj"),
            json!("my-proj")
        );
        // openrouter_provider parses a JSON object.
        assert_eq!(
            parse_setting_value("openrouter_provider", r#"{"order":["Anthropic"]}"#),
            json!({"order": ["Anthropic"]})
        );
        // non-JSON falls back to a string (daemon then reports a type error).
        assert_eq!(
            parse_setting_value("openrouter_provider", "Anthropic"),
            json!("Anthropic")
        );
    }

    #[test]
    fn provider_no_subcommand_lists_providers() {
        let cmd = CliCommand::Provider {
            subcommand: None,
            json: false,
        };
        let (name, _) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "list_providers");
    }

    #[test]
    fn provider_models_maps_to_command() {
        let cmd = CliCommand::Provider {
            subcommand: Some(ProviderCommand::Models {
                name: "openrouter".into(),
                all: true,
                json: false,
            }),
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "list_provider_models");
        assert_eq!(arg(&args, "provider"), "openrouter");
        assert_eq!(arg(&args, "include_hidden"), true);
    }

    #[test]
    fn provider_refresh_maps_to_command() {
        let cmd = CliCommand::Provider {
            subcommand: Some(ProviderCommand::Refresh {
                name: Some("openrouter".into()),
                json: false,
            }),
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "refresh_provider_models");
        assert_eq!(arg(&args, "provider"), "openrouter");
    }

    #[test]
    fn provider_refresh_no_arg_maps_to_refresh_all() {
        let cmd = CliCommand::Provider {
            subcommand: Some(ProviderCommand::Refresh {
                name: None,
                json: false,
            }),
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "refresh_all_provider_models");
        assert!(args.as_object().unwrap().is_empty());
    }

    #[test]
    fn fish_footer_includes_provider_completion() {
        let footer = fish_dynamic_completions_footer();
        assert!(
            footer.contains("__fish_seen_subcommand_from models refresh"),
            "footer should scope provider completion to `models refresh`: {footer}"
        );
        assert!(
            footer.contains("shore complete providers"),
            "footer should call `shore complete providers`: {footer}"
        );
    }

    #[test]
    fn config_path_maps_to_none() {
        let cmd = CliCommand::Config {
            subcommand: None,
            key: None,
            value: None,
            path: true,
            check: false,
            reset: false,
            json: false,
            toml: false,
            all: false,
        };
        assert!(to_swp_command(&cmd).is_none());
    }

    #[test]
    fn log_edit_maps_to_edit_command() {
        let cmd = CliCommand::Log {
            subcommand: Some(LogCommand::Edit {
                msg_ref: "m1".into(),
                content: vec!["new".into(), "text".into()],
            }),
            msg_ref: None,
            count: 20,
            role: None,
            follow: false,
            json: false,
            content: false,
            plain: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
            heartbeat: false,
            dreaming: false,
            events: false,
            api: None,
            call_type: None,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "edit");
        assert_eq!(arg(&args, "ref"), "m1");
        assert_eq!(arg(&args, "content"), "new text");
    }

    #[test]
    fn log_delete_maps_to_delete_command() {
        let cmd = CliCommand::Log {
            subcommand: Some(LogCommand::Delete {
                msg_ref: "m1".into(),
            }),
            msg_ref: None,
            count: 20,
            role: None,
            follow: false,
            json: false,
            content: false,
            plain: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
            heartbeat: false,
            dreaming: false,
            events: false,
            api: None,
            call_type: None,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "delete");
        assert_eq!(arg(&args, "refs"), "m1");
    }

    #[test]
    fn alt_position_maps_to_alt_command() {
        let cmd = CliCommand::Alt {
            selector: Some("2".into()),
            msg_ref: Some("last".into()),
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "alt");
        assert_eq!(arg(&args, "position"), 2);
        assert_eq!(arg(&args, "ref"), "last");
    }

    #[test]
    fn alt_list_maps_to_list_alternatives_command() {
        let cmd = CliCommand::Alt {
            selector: Some("list".into()),
            msg_ref: None,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "list_alternatives");
        assert!(args.as_object().unwrap().is_empty());
    }

    #[test]
    fn log_ref_maps_to_get_command() {
        let cmd = CliCommand::Log {
            subcommand: None,
            msg_ref: Some("last".into()),
            count: 20,
            role: Some(LogRole::User),
            follow: false,
            json: false,
            content: false,
            plain: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
            heartbeat: false,
            dreaming: false,
            events: false,
            api: None,
            call_type: None,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "get");
        assert_eq!(arg(&args, "ref"), "last");
        assert_eq!(arg(&args, "role"), "user");
    }

    #[test]
    fn log_default_maps_to_log_command() {
        let cmd = CliCommand::Log {
            subcommand: None,
            msg_ref: None,
            count: 20,
            role: Some(LogRole::Assistant),
            follow: false,
            json: false,
            content: false,
            plain: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
            heartbeat: false,
            dreaming: false,
            events: false,
            api: None,
            call_type: None,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "log");
        assert_eq!(arg(&args, "turns"), 20);
        assert_eq!(arg(&args, "role"), "assistant");
    }

    #[test]
    fn memory_compact_maps_to_compact_command() {
        let cmd = CliCommand::Memory {
            subcommand: Some(MemoryCommand::Compact { keep_turns: None }),
            query: None,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "compact");
        assert!(args.get("keep_turns").is_none());
    }

    #[test]
    fn memory_compact_with_keep_turns_includes_field() {
        let cmd = CliCommand::Memory {
            subcommand: Some(MemoryCommand::Compact {
                keep_turns: Some(0),
            }),
            query: None,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "compact");
        assert_eq!(arg(&args, "keep_turns"), 0);
    }

    #[test]
    fn memory_changelog_maps_to_command() {
        let cmd = CliCommand::Memory {
            subcommand: Some(MemoryCommand::Changelog { limit: 20 }),
            query: None,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd).unwrap();
        assert_eq!(name, "memory_changelog");
        assert_eq!(arg(&args, "limit"), 20);
    }

    #[test]
    fn all_non_message_commands_map() {
        // Every variant except Send, Regen, Notify, Character (no --info),
        // Config --path, and Completions should produce Some.
        let mut commands = log_status_debug_samples();
        commands.extend(model_samples());
        commands.extend(provider_memory_config_samples());
        for cmd in &commands {
            assert!(to_swp_command(cmd).is_some(), "expected Some for {cmd:?}");
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "builds every log command variant for snapshot-based debug testing"
    )]
    fn log_status_debug_samples() -> Vec<CliCommand> {
        vec![
            CliCommand::Log {
                subcommand: None,
                msg_ref: None,
                count: 20,
                role: None,
                follow: false,
                json: false,
                content: false,
                plain: false,
                reasoning: false,
                tools: false,
                subagent_tools: false,
                heartbeat: false,
                dreaming: false,
                events: false,
                api: None,
                call_type: None,
            },
            CliCommand::Log {
                subcommand: Some(LogCommand::Edit {
                    msg_ref: "m1".into(),
                    content: vec!["text".into()],
                }),
                msg_ref: None,
                count: 20,
                role: None,
                follow: false,
                json: false,
                content: false,
                plain: false,
                reasoning: false,
                tools: false,
                subagent_tools: false,
                heartbeat: false,
                dreaming: false,
                events: false,
                api: None,
                call_type: None,
            },
            CliCommand::Log {
                subcommand: Some(LogCommand::Delete {
                    msg_ref: "m1".into(),
                }),
                msg_ref: None,
                count: 20,
                role: None,
                follow: false,
                json: false,
                content: false,
                plain: false,
                reasoning: false,
                tools: false,
                subagent_tools: false,
                heartbeat: false,
                dreaming: false,
                events: false,
                api: None,
                call_type: None,
            },
            CliCommand::Log {
                subcommand: None,
                msg_ref: Some("last".into()),
                count: 20,
                role: None,
                follow: false,
                json: false,
                content: false,
                plain: false,
                reasoning: false,
                tools: false,
                subagent_tools: false,
                heartbeat: false,
                dreaming: false,
                events: false,
                api: None,
                call_type: None,
            },
            CliCommand::Status {
                section: None,
                diagnostics: false,
                count: 10,
                json: false,
            },
            CliCommand::Status {
                section: None,
                diagnostics: true,
                count: 10,
                json: false,
            },
            CliCommand::Debug {
                subcommand: DebugCommand::TickNow,
            },
            CliCommand::Debug {
                subcommand: DebugCommand::StatusDormant,
            },
            CliCommand::Debug {
                subcommand: DebugCommand::StatusActive,
            },
        ]
    }

    fn model_samples() -> Vec<CliCommand> {
        vec![
            CliCommand::Model {
                subcommand: None,
                name: None,
                info: false,
                reset: false,
                all: false,
                background: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: None,
                name: Some("m".into()),
                info: false,
                reset: false,
                all: false,
                background: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: None,
                name: Some("m".into()),
                info: true,
                reset: false,
                all: false,
                background: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: None,
                name: None,
                info: false,
                reset: true,
                all: false,
                background: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: Some(ModelCommand::Setting {
                    key: None,
                    value: None,
                    global: false,
                    reset: false,
                    background: None,
                    json: false,
                }),
                name: None,
                info: false,
                reset: false,
                all: false,
                background: false,
                json: false,
            },
        ]
    }

    fn provider_memory_config_samples() -> Vec<CliCommand> {
        vec![
            CliCommand::Provider {
                subcommand: None,
                json: false,
            },
            CliCommand::Provider {
                subcommand: Some(ProviderCommand::Models {
                    name: "openrouter".into(),
                    all: false,
                    json: false,
                }),
                json: false,
            },
            CliCommand::Provider {
                subcommand: Some(ProviderCommand::Refresh {
                    name: Some("openrouter".into()),
                    json: false,
                }),
                json: false,
            },
            CliCommand::Character {
                name: Some("c".into()),
                info: true,
                new: false,
                json: false,
            },
            CliCommand::Memory {
                subcommand: None,
                query: None,
                json: false,
            },
            CliCommand::Memory {
                subcommand: Some(MemoryCommand::Compact { keep_turns: None }),
                query: None,
                json: false,
            },
            CliCommand::Memory {
                subcommand: Some(MemoryCommand::Changelog { limit: 20 }),
                query: None,
                json: false,
            },
            CliCommand::Config {
                subcommand: None,
                key: None,
                value: None,
                path: false,
                check: false,
                reset: false,
                json: false,
                toml: false,
                all: false,
            },
        ]
    }

    // ── Completions tests ────────────────────────────────────────────

    #[test]
    fn parse_completions_fish() {
        let cli = parse(&["completions", "fish"]);
        assert_variant!(
            &cli.command,
            CliCommand::Completions { shell } => {
                assert_eq!(*shell, Shell::Fish);
            }
        );
    }

    #[test]
    fn parse_completions_bash() {
        let cli = parse(&["completions", "bash"]);
        assert_variant!(
            &cli.command,
            CliCommand::Completions { shell } => {
                assert_eq!(*shell, Shell::Bash);
            }
        );
    }

    #[test]
    fn parse_completions_zsh() {
        let cli = parse(&["completions", "zsh"]);
        assert_variant!(
            &cli.command,
            CliCommand::Completions { shell } => {
                assert_eq!(*shell, Shell::Zsh);
            }
        );
    }

    // ── Usage ────────────────────────────────────────────────────────

    #[test]
    fn parse_usage_no_call_type_flag() {
        let cli = parse(&["usage"]);
        assert_variant!(
            &cli.command,
            CliCommand::Usage { call_type, .. } => {
                assert!(call_type.is_none(), "flag absent → None");
            }
        );
    }

    #[test]
    fn parse_usage_bare_call_type_flag() {
        // Regression: `shore usage --call-type` previously errored because
        // clap required a value. The bare flag should mean "break down by
        // call type" (Some(None)).
        let cli = parse(&["usage", "--call-type"]);
        assert_variant!(
            &cli.command,
            CliCommand::Usage { call_type, .. } => {
                assert_eq!(*call_type, Some(None), "bare flag → Some(None)");
            }
        );
    }

    #[test]
    fn parse_usage_call_type_with_value() {
        let cli = parse(&["usage", "--call-type", "message"]);
        assert_variant!(
            &cli.command,
            CliCommand::Usage { call_type, .. } => {
                assert_eq!(*call_type, Some(Some("message".into())));
            }
        );
    }

    #[test]
    fn usage_last_hours_forwarded() {
        let cli = parse(&["usage", "--last", "4h"]);
        let (cmd, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(cmd, "usage");
        assert_eq!(arg(&args, "last"), "4h");
    }

    #[test]
    fn usage_bare_call_type_sets_by_call_type_flag() {
        // Wire-level: daemon should see `by_call_type: true` and no
        // `call_type` filter when the user passed the bare flag.
        let cli = parse(&["usage", "--call-type"]);
        let (cmd, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(cmd, "usage");
        assert_eq!(arg(&args, "by_call_type").as_bool(), Some(true));
        assert!(arg(&args, "call_type").is_null());
    }

    #[test]
    fn usage_call_type_value_sets_filter_not_flag() {
        let cli = parse(&["usage", "--call-type", "message"]);
        let (_cmd, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(arg(&args, "call_type"), "message");
        assert!(
            arg(&args, "by_call_type").is_null()
                || arg(&args, "by_call_type").as_bool() == Some(false),
            "filter value should not imply breakdown flag",
        );
    }

    #[test]
    fn usage_kind_and_api_key_flags_forwarded() {
        let cli = parse(&[
            "usage",
            "--by-kind",
            "--by-api-key",
            "--api-key",
            "overflow",
        ]);
        let (_cmd, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(arg(&args, "by_kind").as_bool(), Some(true));
        assert_eq!(arg(&args, "by_api_key").as_bool(), Some(true));
        assert_eq!(arg(&args, "api_key"), "overflow");
    }

    #[test]
    fn usage_budget_flag_forwarded() {
        let cli = parse(&["usage", "--budget"]);
        let (_cmd, args) = to_swp_command(&cli.command).unwrap();
        assert_eq!(arg(&args, "budget").as_bool(), Some(true));
    }

    #[test]
    fn completions_generates_output() {
        // Verify that completion generation produces non-empty output for each shell.
        use clap::CommandFactory;
        for shell in [Shell::Fish, Shell::Bash, Shell::Zsh] {
            let mut buf = Vec::new();
            clap_complete::generate(shell, &mut Cli::command(), "shore", &mut buf);
            assert!(
                !buf.is_empty(),
                "completions for {shell:?} should produce output"
            );
            let text = String::from_utf8(buf).expect("completions should be valid UTF-8");
            assert!(
                text.contains("shore"),
                "completions for {shell:?} should reference 'shore'"
            );
        }
    }

    // ── Dynamic completions (regression #3 followup) ────────────────

    #[test]
    fn fish_footer_has_dynamic_lines_for_model_and_character() {
        let footer = fish_dynamic_completions_footer();
        // Each line must bind the positional for its subcommand to
        // the `complete` helper — anything else means fish will
        // silently not expand `shore model <TAB>` again.
        assert!(
            footer.contains("__fish_shore_using_subcommand model"),
            "footer must gate the model completion on the model subcommand",
        );
        assert!(
            footer.contains("shore complete models"),
            "footer must shell out to `shore complete models`",
        );
        assert!(
            footer.contains("__fish_shore_using_subcommand character"),
            "footer must gate the character completion on the character subcommand",
        );
        assert!(
            footer.contains("shore complete characters"),
            "footer must shell out to `shore complete characters`",
        );
        // Errors from `complete` (daemon down, stale registry) must
        // not propagate to fish, or the user sees red at every tab.
        assert!(
            footer.contains("2>/dev/null"),
            "footer must swallow stderr from the helper",
        );
    }

    #[test]
    fn parse_complete_models() {
        // The `complete` helper must parse cleanly so fish can call
        // it at completion time without triggering a clap error.
        let cli = parse(&["complete", "models"]);
        assert_variant!(
            &cli.command,
            CliCommand::Complete { kind } => {
                assert_eq!(*kind, CompleteKind::Models);
            }
        );
    }

    #[test]
    fn parse_complete_characters() {
        let cli = parse(&["complete", "characters"]);
        assert_variant!(
            &cli.command,
            CliCommand::Complete { kind } => {
                assert_eq!(*kind, CompleteKind::Characters);
            }
        );
    }

    #[test]
    fn complete_maps_to_none_swp() {
        // `complete` is handled entirely client-side; it must not leak
        // into the generic SWP dispatch path.
        let cmd = CliCommand::Complete {
            kind: CompleteKind::Models,
        };
        assert!(
            to_swp_command(&cmd).is_none(),
            "complete is a client-side helper, not an SWP command",
        );
    }
}
