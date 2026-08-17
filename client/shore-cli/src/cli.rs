use clap::{Parser, Subcommand, ValueEnum};
use clap_complete::Shell;

const LEADING_HEADING: &str = "Options — must come before the command";

#[derive(Parser, Debug)]
#[command(
    name = "shore",
    version,
    about = "Shore chat client",
    disable_help_subcommand = true
)]
pub(crate) struct Cli {
    /// Character to talk to (overrides SHORE_CHARACTER env var)
    #[arg(
        long,
        short = 'c',
        env = "SHORE_CHARACTER",
        help_heading = LEADING_HEADING
    )]
    pub character: Option<String>,

    /// TCP address of the daemon (overrides discovery)
    #[arg(long, env = "SHORE_ADDR", help_heading = LEADING_HEADING)]
    pub addr: Option<String>,

    #[command(subcommand)]
    pub command: CliCommand,
}

const LEADING_FLAGS: [(&str, &str); 3] = [
    ("--character", "--character"),
    ("-c", "--character"),
    ("--addr", "--addr"),
];

const RETIRED_FLAGS: [(&str, &str); 8] = [
    ("--config", "name the daemon with --addr, or set SHORE_ADDR"),
    ("--no-color", "set NO_COLOR=1 in the environment"),
    (
        "--plain",
        "output is already plain when it is not going to a terminal",
    ),
    (
        "--temperature",
        "set it on the model: shore model setting temperature <value>",
    ),
    (
        "--top-p",
        "set it on the model: shore model setting top_p <value>",
    ),
    (
        "--thinking",
        "set it on the model: shore model setting budget_tokens <tokens>",
    ),
    ("--guidance", GUIDANCE_WAS_NEVER_READ),
    ("-g", GUIDANCE_WAS_NEVER_READ),
];

const GUIDANCE_WAS_NEVER_READ: &str =
    "it never reached the model, so `shore regen` is the same call";

const NAMED_BY_USE: [&str; 2] = ["model", "character"];

const PROMOTED: [(&str, &str); 1] = [("memory compact", "compact")];

const FOLDED_IN: [(&str, &str); 1] = [(
    "model background",
    "every model role is listed by `shore model`; pin one with \
     `shore model use --background <heartbeat|compaction|all> <name>`",
)];

const RETIRED_UNDER: [(&str, &str, &str); 1] = [(
    "config",
    "--reset",
    "there were no runtime overrides to drop; re-read the file with: shore config reload",
)];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FlagProblem {
    Misplaced(&'static str),
    Retired(&'static str, &'static str),
    BareName(&'static str, String),
    Promoted(&'static str, &'static str),
}

fn leading_flag_named(spelled: &str) -> Option<&'static str> {
    LEADING_FLAGS
        .iter()
        .find(|&&(spelling, _)| spelling == spelled)
        .map(|&(_, canonical)| canonical)
}

fn retired_flag_named(spelled: &str) -> Option<FlagProblem> {
    RETIRED_FLAGS
        .iter()
        .find(|&&(spelling, _)| spelling == spelled)
        .map(|&(name, instead)| FlagProblem::Retired(name, instead))
}

pub(crate) fn flag_problem<I, S>(argv: I) -> Option<FlagProblem>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut words: Vec<String> = Vec::new();
    let mut flags: Vec<String> = Vec::new();
    let mut flagged = false;
    let mut expecting_value = false;

    for raw in argv.into_iter().skip(1) {
        let token = raw.as_ref();
        if token == "--" {
            break;
        }
        if expecting_value {
            expecting_value = false;
            continue;
        }
        let spelled = token.split('=').next().unwrap_or(token);
        if let Some(problem) = retired_flag_named(spelled) {
            return Some(problem);
        }
        if let Some(flag) = leading_flag_named(spelled) {
            if words.is_empty() {
                expecting_value = !token.contains('=');
                continue;
            }
            return Some(FlagProblem::Misplaced(flag));
        }
        if token.starts_with('-') {
            flagged = true;
            flags.push(spelled.to_owned());
        } else {
            words.push(token.to_owned());
        }
    }

    promoted(&words)
        .or_else(|| folded_in(&words))
        .or_else(|| retired_under(&words, &flags))
        .or_else(|| bare_name(&words, flagged))
}

fn folded_in(words: &[String]) -> Option<FlagProblem> {
    let command = words.first()?;
    let sub = words.get(1)?;
    let typed = format!("{command} {sub}");
    FOLDED_IN
        .iter()
        .find(|&&(old, _)| old == typed)
        .map(|&(old, instead)| FlagProblem::Retired(old, instead))
}

fn retired_under(words: &[String], flags: &[String]) -> Option<FlagProblem> {
    let command = words.first()?;
    RETIRED_UNDER
        .iter()
        .find(|&&(under, flag, _)| under == command && flags.iter().any(|f| f == flag))
        .map(|&(_, flag, instead)| FlagProblem::Retired(flag, instead))
}

fn promoted(words: &[String]) -> Option<FlagProblem> {
    let command = words.first()?;
    let sub = words.get(1)?;
    let typed = format!("{command} {sub}");
    PROMOTED
        .iter()
        .find(|&&(old, _)| old == typed)
        .map(|&(old, now)| FlagProblem::Promoted(old, now))
}

fn bare_name(words: &[String], flagged: bool) -> Option<FlagProblem> {
    if flagged {
        return None;
    }
    let command = words.first()?;
    let name = words.get(1)?;
    let known = NAMED_BY_USE
        .iter()
        .copied()
        .find(|candidate| *candidate == command.as_str())?;
    if names_a_subcommand(command, name) {
        return None;
    }
    Some(FlagProblem::BareName(known, name.clone()))
}

fn names_a_subcommand(command: &str, word: &str) -> bool {
    use clap::CommandFactory;
    Cli::command()
        .find_subcommand(command)
        .is_some_and(|parent| {
            parent.get_subcommands().any(|sub| {
                sub.get_name() == word || sub.get_all_aliases().any(|alias| alias == word)
            })
        })
}

pub(crate) fn report_flag_problem(problem: &FlagProblem) -> std::process::ExitCode {
    match *problem {
        FlagProblem::Misplaced(flag) => {
            crate::output::print_error(&format!("{flag} has to come before the command"));
            cli_err!();
            cli_err!("  shore {flag} <value> <command>");
        }
        FlagProblem::Retired(flag, instead) => {
            crate::output::print_error(&format!("{flag} was removed — {instead}"));
        }
        FlagProblem::BareName(command, ref name) => {
            crate::output::print_error(&format!("`shore {command}` no longer takes a name"));
            cli_err!();
            cli_err!("  shore {command} use {name}");
        }
        FlagProblem::Promoted(old, now) => {
            crate::output::print_error(&format!("`shore {old}` is now a command of its own"));
            cli_err!();
            cli_err!("  shore {now}");
        }
    }
    std::process::ExitCode::FAILURE
}

fn message_ref(raw: &str) -> Result<String, String> {
    if raw.starts_with("--") {
        Err(format!("'{raw}' is not a message reference"))
    } else {
        Ok(raw.to_owned())
    }
}

#[derive(Subcommand, Debug)]
pub(crate) enum CliCommand {
    /// Send a message
    #[command(display_order = 1)]
    Send {
        /// The message text
        message: Vec<String>,

        /// Attach image file(s) to the message
        #[arg(short = 'i', long = "image")]
        images: Vec<String>,

        /// Inject as a system instruction instead of a user message
        #[arg(long)]
        system: bool,
    },

    /// Regenerate the last assistant response
    #[command(display_order = 2)]
    Regen,

    /// List or select alternate responses for the latest assistant message
    #[command(display_order = 3)]
    Alt {
        /// Selector: list, prev, next, last, first, or 1-based alternate position
        #[arg(allow_hyphen_values = true, value_parser = message_ref)]
        selector: Option<String>,

        /// Assistant message reference (defaults to latest assistant)
        #[arg(long = "ref", allow_hyphen_values = true, value_parser = message_ref)]
        msg_ref: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show the conversation
    #[command(display_order = 4)]
    Log {
        /// Message reference — show a single message (last, -1, 3, etc.)
        #[arg(allow_hyphen_values = true, value_parser = message_ref)]
        msg_ref: Option<String>,

        /// Number of turns to show
        #[arg(short = 'n', long = "turns", alias = "count", default_value = "64")]
        count: u32,

        /// Show only messages from one role
        #[arg(long, value_enum)]
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

        /// Also show reasoning/thinking blocks (hidden by default)
        #[arg(long)]
        reasoning: bool,

        /// Also show tool calls and their results (hidden by default)
        #[arg(long)]
        tools: bool,

        /// Also show sub-agent nested tool activity, in --follow (hidden by default)
        #[arg(long = "subagent-tools")]
        subagent_tools: bool,
    },

    /// Replace the content of a message (last, -1, 3, etc.)
    #[command(display_order = 5)]
    Edit {
        /// Message reference (last, -1, -2, 3, etc.)
        #[arg(allow_hyphen_values = true, value_parser = message_ref)]
        msg_ref: String,

        /// New content
        content: Vec<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Remove one or more messages from the conversation
    #[command(display_order = 6)]
    Delete {
        /// Message references (last, -1, -2, 3, or a raw m_… id). Every reference
        /// resolves against the conversation as it stands before any of them are
        /// removed. A reference that lands inside a tool loop removes the whole
        /// turn, since a tool result cannot outlive the call it answers
        #[arg(required = true, allow_hyphen_values = true, value_parser = message_ref)]
        msg_refs: Vec<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Inspect what the daemon did behind the conversation: raw model calls,
    /// heartbeat activity, stored sub-agent runs, and errors it hit.
    #[command(display_order = 14)]
    Trace {
        #[command(subcommand)]
        subcommand: Option<TraceCommand>,
    },

    /// List characters, or switch to another one
    #[command(display_order = 8)]
    Character {
        #[command(subcommand)]
        subcommand: Option<CharacterCommand>,

        /// Superseded by `shore character info`
        #[arg(long, hide = true)]
        info: bool,

        /// Output raw JSON
        #[arg(long, global = true)]
        json: bool,
    },

    /// Show daemon and session status
    #[command(display_order = 12)]
    Status {
        /// Show only one section; every section is shown by default.
        /// `shore complete sections` lists them
        #[arg(long)]
        section: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Advanced debugging utilities
    #[command(display_order = 15)]
    Debug {
        #[command(subcommand)]
        subcommand: Option<DebugCommand>,
    },

    /// List models, switch the active one, or tune its sampler settings
    #[command(args_conflicts_with_subcommands = true)]
    #[command(display_order = 9)]
    Model {
        #[command(subcommand)]
        subcommand: Option<ModelCommand>,

        /// Include hidden discovered models in the list
        #[arg(long)]
        all: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,

        /// Superseded by `shore model info`
        #[arg(long, hide = true)]
        info: bool,

        /// Superseded by `shore model reset`
        #[arg(long, hide = true)]
        reset: bool,
    },

    /// List configured providers with key and cache status, or refresh a catalog
    #[command(args_conflicts_with_subcommands = true)]
    #[command(display_order = 10)]
    Provider {
        #[command(subcommand)]
        subcommand: Option<ProviderCommand>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Summarize the conversation into memory and shorten the active window
    #[command(display_order = 7)]
    Compact {
        /// How many recent user turns to leave in the conversation. Everything
        /// older is folded into markdown memory. 0 keeps none of it, leaving
        /// only the prompt files and the memory index.
        keep_turns: Option<u32>,

        /// Throw away a paused checkpoint and summarize from scratch. Use this
        /// when a pass stopped partway — out of quota, provider down, memory
        /// files edited since — and `shore compact` keeps reporting paused. The
        /// memory it already wrote stays; those turns get summarized again.
        #[arg(long)]
        restart: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show or modify configuration
    #[command(args_conflicts_with_subcommands = true)]
    #[command(display_order = 11)]
    Config {
        #[command(subcommand)]
        subcommand: Option<ConfigCommand>,

        /// Print the config directory path
        #[arg(long)]
        path: bool,

        /// Validate configuration and show warnings
        #[arg(long)]
        check: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,

        /// Output as TOML (suitable for pasting into a config file)
        #[arg(long, conflicts_with_all = ["json", "check"])]
        toml: bool,

        /// Include keys whose value matches the built-in default (shown dimmed)
        #[arg(long, short = 'a')]
        all: bool,
    },

    /// Show token usage statistics and costs
    #[command(display_order = 13)]
    Usage {
        #[command(subcommand)]
        subcommand: Option<UsageCommand>,

        /// Time period: "today", "4h", "7d", "30d", "all". Defaults to the
        /// current budget window when a budget is configured, else today
        #[arg(long, global = true)]
        last: Option<String>,

        /// Filter by provider
        #[arg(long, global = true)]
        provider: Option<String>,

        /// Filter by configured API key name ("unknown" matches older rows)
        #[arg(long, global = true)]
        api_key: Option<String>,

        /// Filter by model
        #[arg(long, global = true)]
        model: Option<String>,

        /// Filter by ledger call type, e.g. message, heartbeat, or subagent
        #[arg(long, global = true)]
        call_type: Option<String>,

        /// Output raw JSON
        #[arg(long, global = true)]
        json: bool,
    },

    /// Generate shell completions
    #[command(display_order = 16)]
    Completions {
        /// Shell to generate completions for
        shell: Shell,
    },

    /// Emit plain names for shell completion helpers (internal)
    #[command(hide = true)]
    Complete {
        /// What to enumerate
        kind: CompleteKind,

        /// Context for kinds that need it, e.g. the key for `config-values`
        arg: Option<String>,
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
    /// Section names `shore status --section` accepts
    Sections,
    /// Every name `shore debug tool` accepts: built-ins, `ask_<subagent>`,
    /// and connected `mcp__<server>__<tool>`
    Tools,
    /// Configured sub-agent names, without the `ask_` prefix
    Subagents,
    /// Sampler keys `shore model setting` accepts, with how the target model
    /// treats each one
    SettingKeys,
    /// Dotted config keys that `shore config set` accepts, with their types
    ConfigKeys,
    /// Every dotted config key, settable or not, for `shore config get`
    ConfigSections,
    /// Values valid for the config key named in the argument
    ConfigValues,
}

/// Background task to retarget `shore model setting` at. `all` targets every
/// background task at once and errors if they resolve to different models.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackgroundTarget {
    All,
    Heartbeat,
    Compaction,
}

impl BackgroundTarget {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            BackgroundTarget::All => "all",
            BackgroundTarget::Heartbeat => "heartbeat",
            BackgroundTarget::Compaction => "compaction",
        }
    }
}

/// Message roles accepted by `shore log --role`.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LogRole {
    User,
    Assistant,
    /// Alias for `assistant`
    Character,
    System,
}

impl LogRole {
    pub(crate) fn as_protocol_role(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant | Self::Character => "assistant",
            Self::System => "system",
        }
    }
}

/// Dimension `shore usage by` groups spend along
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
#[value(rename_all = "kebab-case")]
pub(crate) enum UsageDimension {
    Model,
    Provider,
    CallType,
    Kind,
    ApiKey,
}

impl UsageDimension {
    fn wire(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Provider => "provider",
            Self::CallType => "call_type",
            Self::Kind => "kind",
            Self::ApiKey => "api_key",
        }
    }
}

#[derive(Subcommand, Debug)]
pub(crate) enum UsageCommand {
    /// Group spend by a dimension: model, provider, call-type, kind, api-key
    By {
        /// What to group by
        #[arg(value_enum)]
        dimension: UsageDimension,
    },

    /// Budget meters, what they cover, and when they reset
    Budgets,

    /// Cache health and coverage for the selected period
    Cache,

    /// Every cache anomaly in the period, with when and which model
    Anomalies,

    /// Provider rate limits as of each provider's last response
    Limits,

    /// Write the full ledger to stdout as CSV (or TSV with --tsv)
    Export {
        /// Use tab separators instead of commas
        #[arg(long)]
        tsv: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum TraceCommand {
    /// Raw model call payloads. Bare lists recent calls; pass an id to dump
    /// that call's full request and response
    Calls {
        /// Call id to dump (from the bare listing)
        id: Option<i64>,

        /// Number of calls to list
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Filter the listing by ledger call type (message, heartbeat, ...)
        #[arg(long, conflicts_with = "id")]
        call_type: Option<String>,

        /// Also show what changed since the previous call
        #[arg(long, requires = "id")]
        diff: bool,

        /// Compare against this call id instead of the previous one
        #[arg(long, requires = "diff", value_name = "ID")]
        against: Option<i64>,

        /// Show the raw HTTP request and response bodies in full, untruncated
        #[arg(long, requires = "id")]
        wire: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// The heartbeat transcript: what each tick thought, the tools it called
    /// and their results, and the model that served it
    Heartbeat {
        /// Number of entries to show
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// The heartbeat operational timeline: tick fired, dormant, woke, timeout
    Events {
        /// Number of events to show
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Errors the daemon has hit since it started, and every time a provider
    /// key was abandoned for another. Held in memory, so a restart clears them
    Errors {
        /// Number of entries to show
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Stored sub-agent runs: the tools each `ask_<name>` call made and what
    /// came back. Bare lists recent runs; pass a parent tool_use id for one
    Subagent {
        /// Parent tool_use id of a single run to dump
        id: Option<String>,

        /// Number of runs to list
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ModelCommand {
    /// Switch the active model
    ///
    /// The same thing as `shore model <name>`, spelled out. Use it when a
    /// model's name would otherwise read as one of these subcommands. An
    /// unknown name is an error, never a fallback.
    ///
    /// Without --background this picks the chat model, saved against the
    /// attached character, so characters can differ. With --background it
    /// pins a background task instead, by writing defaults.background in the
    /// config file, which is global. `--background all` writes
    /// defaults.background.model, the value both tasks fall back to.
    Use {
        /// Model name or provider:model_id
        name: String,

        /// Pin a background task's model instead of the chat model
        #[arg(long, value_enum)]
        background: Option<BackgroundTarget>,
    },

    /// Describe a model: provider, sdk, limits, and where it resolves from
    Info {
        /// Model to describe. Omit for the active one
        name: Option<String>,
    },

    /// Show, set, or clear this model's saved sampler settings
    ///
    /// With no key, shows every setting in effect. With a key, shows that one;
    /// with a key and a value, saves it; with --reset and a key, clears it.
    /// Clearing everything at once is not supported — name the key.
    ///
    /// Targets the active chat model unless you pass --background, --subagent
    /// or --model. A sub-agent's settings are its own: they start from its
    /// model's catalog entry and take nothing from the chat model's settings,
    /// so tuning chat never moves a sub-agent.
    ///
    /// `--subagent all` writes once against the model your sub-agents share,
    /// covering all of them; it errors if they are not all on one model. A
    /// named sub-agent overrides that shared value. Because the shared value
    /// belongs to the model, changing subagent_model picks up that model's
    /// settings rather than carrying the old ones over.
    ///
    /// The keys are temperature, top_p, reasoning_effort, budget_tokens,
    /// max_output_tokens, cache_ttl, cache_keepalive, sdk,
    /// replay_prior_thinking and max_tool_iterations.
    ///
    /// sdk takes anthropic, openai, openrouter, gemini, zai, deepseek or
    /// moonshot, which forces a wire shape on a discovered model whose
    /// provider catalog labelled it wrong.
    ///
    /// The vendor knobs openrouter_provider, gemini_generation,
    /// zai_clear_thinking and zai_subscription are settable per model too. A
    /// model only lists the knobs its own sdk honors.
    Setting {
        /// Setting key (temperature, top_p, reasoning_effort, sdk, ...)
        key: Option<String>,

        /// Value to save; true/false for booleans, off/none to stop reasoning
        value: Option<String>,

        /// Save to the global preferences file instead of this character's
        #[arg(long)]
        global: bool,

        /// Clear the saved value for the named key
        #[arg(long)]
        reset: bool,

        /// Tune a background task's model instead of the chat model
        #[arg(long, value_enum, conflicts_with_all = ["subagent", "model"])]
        background: Option<BackgroundTarget>,

        /// Tune one sub-agent by name, or `all` for the model they share
        #[arg(long, conflicts_with = "model")]
        subagent: Option<String>,

        /// Tune a named model without switching to it
        #[arg(long)]
        model: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Drop the saved selection and fall back to the configured default
    ///
    /// Bare, this clears the character's chat model. With --background it
    /// clears that task's pin from the config file, so the task goes back to
    /// defaults.background.model, or to the chat model if that is unset too.
    /// `--background all` clears all three keys.
    Reset {
        /// Unpin a background task instead of the chat model
        #[arg(long, value_enum)]
        background: Option<BackgroundTarget>,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum CharacterCommand {
    /// Switch the active character. Unknown names are an error, never a fallback
    Use {
        /// Character name
        name: String,
    },

    /// Describe the active character
    Info,

    /// Create a new character
    New {
        /// Character name
        name: String,
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

    /// Re-fetch a provider's model catalog and update the cache
    ///
    /// Reads the provider's /v1/models endpoint. Omit the name to refresh
    /// every discovery-enabled provider in one batch.
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
pub(crate) enum ConfigCommand {
    /// Read one setting, or a whole section, by dotted key.
    ///
    /// `shore config get defaults.model`
    /// `shore config get memory.compaction`
    #[command(verbatim_doc_comment)]
    Get {
        /// Dotted key, e.g. defaults.stream, daemon.addr, mcp.beets.command
        key: String,

        /// Output raw JSON
        #[arg(long)]
        json: bool,

        /// Output as TOML (suitable for pasting into a config file)
        #[arg(long, conflicts_with = "json")]
        toml: bool,

        /// Include keys whose value matches the built-in default (shown dimmed)
        #[arg(long, short = 'a')]
        all: bool,
    },

    /// Write one setting to the config file and apply it live.
    ///
    /// The value is checked against the setting's type before anything is
    /// written, and the file is restored if the result would not load. Keys
    /// under [daemon], [notifications] and [connections] need a daemon
    /// restart to take effect; `set` says so when you touch one.
    ///
    /// `shore config set defaults.model anthropic:claude-opus-4-5`
    /// `shore config set memory.compaction.idle_trigger 2h`
    /// `shore config set tools.enabled_tools read,edit,search`
    #[command(verbatim_doc_comment)]
    Set {
        /// Dotted key, e.g. defaults.stream, cache.keepalive_max
        key: String,

        /// New value. Lists take a comma-separated string
        value: String,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// List every settable key and the type it takes. `shore config` shows
    /// the current values; this shows what `set` will accept.
    Keys {
        /// Only keys whose name contains this substring
        filter: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

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

    /// Show the resolved tool surface: which tools are enabled, sub-agent
    /// ownership, and any dangling config references. Read the raw values
    /// with `config get tools.enabled_tools`.
    Tools {
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
    /// Send a cache-keepalive ping now and report whether it read the cache
    #[command(name = "keepalive_ping_now")]
    KeepalivePingNow,
    /// Start this character's heartbeat and keepalive without sending a
    /// message. If the prefix is cold this pays one cache write to recreate
    /// it, which is what starts the keepalive cadence.
    #[command(name = "session_activate")]
    SessionActivate,

    /// Invoke one tool directly and print what the model would have received.
    ///
    /// The call runs through the same path a real turn uses: arguments are
    /// schema-checked, the per-tool timeout applies, and the result is
    /// truncated to the configured window. Side effects are real — `edit`
    /// writes to the workspace, `ask_<agent>` spends tokens.
    ///
    /// `shore debug tool read path=notes.md`
    /// `shore debug tool search query=cache mode=hybrid`
    /// `shore debug tool ask_librarian query="what did we decide about TTLs"`
    #[command(name = "tool", verbatim_doc_comment)]
    Tool {
        /// A built-in tool, `ask_<subagent>`, or `mcp__<server>__<tool>`
        name: String,

        /// Arguments as `key=value`, coerced to the tool's declared types
        #[arg(value_parser = parse_key_value)]
        args: Vec<(String, String)>,

        /// Whole argument object as JSON, for nested or array values.
        /// `key=value` pairs win where both set the same key.
        #[arg(long, value_parser = parse_json_object)]
        input: Option<serde_json::Value>,

        /// Print the tool's definition as the character receives it, instead
        /// of running it. Any arguments given are ignored
        #[arg(long)]
        describe: bool,

        /// Also print the untruncated result and full nested tool output
        #[arg(long)]
        raw: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Invoke a sub-agent directly with a natural-language query.
    /// Shorthand for `debug tool ask_<name> query=<query>`.
    #[command(name = "subagent")]
    Subagent {
        /// Sub-agent name, without the `ask_` prefix
        name: String,

        /// The query to send
        #[arg(required = true)]
        query: Vec<String>,

        /// Also print the untruncated result and full nested tool output
        #[arg(long)]
        raw: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

fn parse_key_value(raw: &str) -> Result<(String, String), String> {
    match raw.split_once('=') {
        Some(("", _)) => Err(format!("'{raw}' has no argument name before the '='")),
        Some((key, value)) => Ok((key.to_owned(), value.to_owned())),
        None => Err(format!(
            "expected key=value, got '{raw}' — pass nested payloads with --input '{{...}}'"
        )),
    }
}

fn parse_json_object(raw: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("not valid JSON: {e}"))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err("must be a JSON object, e.g. '{\"path\":\"notes.md\"}'".to_owned())
    }
}

fn pairs_object(pairs: &[(String, String)]) -> serde_json::Value {
    serde_json::Value::Object(
        pairs
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect(),
    )
}

const COMMAND_GROUPS: [(&str, &[&str]); 5] = [
    (
        "Conversation",
        &["send", "log", "regen", "alt", "edit", "delete", "compact"],
    ),
    (
        "Configuration",
        &["character", "model", "provider", "config"],
    ),
    ("Inspection", &["status", "usage", "trace"]),
    ("Shell", &["completions"]),
    ("Advanced", &["debug"]),
];

fn first_line(about: &str) -> String {
    about.lines().next().unwrap_or("").trim().to_owned()
}

fn grouped_names() -> impl Iterator<Item = &'static str> {
    COMMAND_GROUPS
        .iter()
        .flat_map(|(_, names)| names.iter().copied())
}

fn render_command_groups(base: &clap::Command) -> String {
    let width = COMMAND_GROUPS
        .iter()
        .flat_map(|(_, names)| names.iter())
        .map(|name| name.chars().count())
        .max()
        .unwrap_or(0);

    let mut out = String::new();
    for (heading, names) in COMMAND_GROUPS {
        out.push_str(heading);
        out.push_str(":\n");
        for name in names {
            let about = base
                .find_subcommand(name)
                .and_then(clap::Command::get_about)
                .map(ToString::to_string)
                .unwrap_or_default();
            out.push_str(&format!("  {name:width$}  {}\n", first_line(&about)));
        }
        out.push('\n');
    }
    out
}

pub(crate) fn grouped_command() -> clap::Command {
    use clap::CommandFactory;
    let base = Cli::command();
    let listing = render_command_groups(&base);

    let ungrouped: Vec<String> = base
        .get_subcommands()
        .map(|sub| sub.get_name().to_owned())
        .filter(|name| !grouped_names().any(|grouped| grouped == name))
        .collect();

    let mut cmd = base;
    for (_, names) in COMMAND_GROUPS {
        for name in names {
            cmd = cmd.mut_subcommand(name, |sub| sub.hide(true));
        }
    }
    for name in &ungrouped {
        cmd = cmd.mut_subcommand(name.as_str(), |sub| sub.hide(true));
    }
    cmd.override_usage("shore [OPTIONS] <COMMAND>")
        .help_template(format!(
            "{{about-with-newline}}\n{{usage-heading}} {{usage}}\n\n{listing}{{all-args}}"
        ))
}

pub(crate) fn print_completions(shell: Shell) {
    use clap::CommandFactory;
    let mut generated: Vec<u8> = Vec::new();
    clap_complete::generate(shell, &mut Cli::command(), "shore", &mut generated);
    let script = String::from_utf8_lossy(&generated).into_owned();
    cli_write!("{}", suppress_noise_completions(shell, &script));
    if shell == Shell::Fish {
        cli_out!("{}", fish_dynamic_completions_footer());
    }
}

const INTERNAL_HELPER_HELP: &str = "Emit plain names for shell completion helpers (internal)";

const SUPERSEDED_HELP: &str = "Superseded by";

pub(crate) fn suppress_noise_completions(shell: Shell, script: &str) -> String {
    let mut out = String::with_capacity(script.len());
    for line in script.lines() {
        if line.contains(INTERNAL_HELPER_HELP) || line.contains(SUPERSEDED_HELP) {
            continue;
        }
        if shell == Shell::Bash && line.trim_start().starts_with("opts=") {
            out.push_str(&line.replacen(" complete\"", "\"", 1));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

pub(crate) fn fish_dynamic_completions_footer() -> &'static str {
    "\n\
# ── Dynamic completions (populated by the daemon) ────────────────────\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from use info\" -f -a \"(shore complete models 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand character; and __fish_seen_subcommand_from use\" -f -a \"(shore complete characters 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand provider; and __fish_seen_subcommand_from models refresh\" -f -a \"(shore complete providers 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand status\" -l section -r -f -a \"(shore complete sections 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand debug; and __fish_seen_subcommand_from tool\" -f -a \"(shore complete tools 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand debug; and __fish_seen_subcommand_from subagent\" -f -a \"(shore complete subagents 2>/dev/null)\"\n\
\n\
function __shore_setting_key\n\
    set -l seen 0\n\
    set -l skip 0\n\
    for token in (commandline -opc)\n\
        if test $skip -eq 1\n\
            set skip 0\n\
            continue\n\
        end\n\
        if contains -- $token --subagent --model --background\n\
            set skip 1\n\
            continue\n\
        end\n\
        if test $seen -eq 1; and not string match -q -- '-*' $token\n\
            echo $token\n\
            return 0\n\
        end\n\
        if test $token = setting\n\
            set seen 1\n\
        end\n\
    end\n\
    return 1\n\
end\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from setting; and not __shore_setting_key\" -f -a \"(shore complete setting-keys 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from setting\" -l subagent -r -f -a \"all (shore complete subagents 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from setting\" -l model -r -f -a \"(shore complete models 2>/dev/null)\"\n\
\n\
function __shore_config_key\n\
    set -l seen 0\n\
    for token in (commandline -opc)\n\
        if test $seen -eq 1; and not string match -q -- '-*' $token\n\
            echo $token\n\
            return 0\n\
        end\n\
        if contains -- $token get set\n\
            set seen 1\n\
        end\n\
    end\n\
    return 1\n\
end\n\
complete -c shore -n \"__fish_shore_using_subcommand config; and __fish_seen_subcommand_from set; and not __shore_config_key\" -f -a \"(shore complete config-keys 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand config; and __fish_seen_subcommand_from get; and not __shore_config_key\" -f -a \"(shore complete config-sections 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand config; and __fish_seen_subcommand_from set; and __shore_config_key\" -f -a \"(shore complete config-values (__shore_config_key) 2>/dev/null)\"\n"
}

fn parse_setting_value(key: &str, raw: &str) -> serde_json::Value {
    use serde_json::Value;
    let trimmed = raw.trim();
    match key {
        "replay_prior_thinking" | "zai_clear_thinking" | "zai_subscription" => {
            match trimmed.to_ascii_lowercase().as_str() {
                "true" | "yes" | "on" => Value::Bool(true),
                "false" | "no" | "off" => Value::Bool(false),
                _ => Value::String(trimmed.to_owned()),
            }
        }
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
        "openrouter_provider" => serde_json::from_str::<Value>(trimmed)
            .unwrap_or_else(|_| Value::String(trimmed.to_owned())),
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

pub(crate) fn to_swp_command(
    cmd: &CliCommand,
    character: Option<&str>,
) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::json;
    match cmd {
        CliCommand::Send { system: false, .. }
        | CliCommand::Regen
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }
        | CliCommand::Config {
            path: true,
            check: false,
            ..
        }
        | CliCommand::Config {
            subcommand: Some(ConfigCommand::Reload { .. }),
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

        CliCommand::Character {
            subcommand: Some(CharacterCommand::Info),
            ..
        } => Some(("character_info", json!({ "name": "" }))),
        CliCommand::Character { info, .. } => {
            if *info {
                Some(("character_info", json!({ "name": "" })))
            } else {
                None
            }
        }

        CliCommand::Log { .. } => log_to_swp(cmd),
        CliCommand::Edit {
            msg_ref, content, ..
        } => Some((
            "edit",
            json!({ "ref": msg_ref, "content": content.join(" ") }),
        )),
        CliCommand::Delete { msg_refs, .. } => Some(("delete", json!({ "refs": msg_refs }))),
        CliCommand::Trace { subcommand: None } => None,
        CliCommand::Trace { .. } => trace_to_swp(cmd),

        CliCommand::Status { .. } => Some(("status", json!({}))),

        CliCommand::Debug { subcommand: None } => None,
        CliCommand::Debug {
            subcommand: Some(subcommand),
        } => match subcommand {
            DebugCommand::TickNow => Some(("heartbeat_tick_now", json!({}))),
            DebugCommand::StatusDormant => Some(("heartbeat_set_dormant", json!({}))),
            DebugCommand::StatusActive => Some(("heartbeat_set_active", json!({}))),
            DebugCommand::KeepalivePingNow => Some(("keepalive_ping_now", json!({}))),
            DebugCommand::SessionActivate => Some(("session_activate", json!({}))),
            DebugCommand::Tool {
                name,
                args,
                input,
                raw,
                describe,
                ..
            } => Some((
                "run_tool",
                json!({
                    "tool": name,
                    "input": input.clone().unwrap_or_else(|| json!({})),
                    "pairs": pairs_object(args),
                    "raw": raw,
                    "describe": describe,
                }),
            )),
            DebugCommand::Subagent {
                name, query, raw, ..
            } => Some((
                "run_tool",
                json!({
                    "tool": format!("ask_{name}"),
                    "input": { "query": query.join(" ") },
                    "pairs": {},
                    "raw": raw,
                }),
            )),
        },

        CliCommand::Model { .. } => model_to_swp(cmd),

        CliCommand::Provider { .. } => provider_to_swp(cmd),

        CliCommand::Compact { .. } => compact_to_swp(cmd),

        CliCommand::Config {
            subcommand: Some(ConfigCommand::Tools { .. }),
            ..
        } => Some(("tools", json!({}))),
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Keys { .. }),
            ..
        } => Some(("config_schema", json!({}))),
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Get { key, .. }),
            ..
        } => Some(("config", json!({ "key": key }))),
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Set { key, value, .. }),
            ..
        } => Some(("config", json!({ "key": key, "value": value }))),
        CliCommand::Config { check: true, .. } => Some(("config_check", json!({}))),
        CliCommand::Config { .. } => Some(("config", json!({ "key": null, "value": null }))),

        CliCommand::Usage { .. } => usage_to_swp(cmd, character),
    }
}

fn log_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::{Map, Value, json};
    let CliCommand::Log {
        msg_ref,
        role,
        count,
        ..
    } = cmd
    else {
        return None;
    };
    if let Some(r) = msg_ref {
        let mut args = Map::new();
        let _ignored = args.insert("ref".into(), json!(r));
        if let Some(role_filter) = role {
            _ = args.insert("role".into(), json!(role_filter.as_protocol_role()));
        }
        return Some(("get", Value::Object(args)));
    }
    let mut args = Map::new();
    let _ignored = args.insert("turns".into(), json!(count));
    if let Some(role_filter) = role {
        _ = args.insert("role".into(), json!(role_filter.as_protocol_role()));
    }
    Some(("log", Value::Object(args)))
}

fn trace_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::{Map, Value, json};
    let CliCommand::Trace {
        subcommand: Some(subcommand),
    } = cmd
    else {
        return None;
    };
    match subcommand {
        TraceCommand::Heartbeat { count, .. } => Some((
            "transcript",
            json!({ "source": "heartbeat", "count": count }),
        )),
        TraceCommand::Errors { count, .. } => Some(("error_log", json!({ "count": count }))),
        TraceCommand::Events { count, .. } => Some(("heartbeat_log", json!({ "count": count }))),
        TraceCommand::Subagent { id, count, .. } => {
            let mut args = Map::new();
            match id {
                Some(one) => _ = args.insert("ids".into(), json!([one])),
                None => _ = args.insert("count".into(), json!(count)),
            }
            Some(("subagent_trace", Value::Object(args)))
        }
        TraceCommand::Calls {
            id,
            count,
            call_type,
            diff,
            against,
            wire,
            ..
        } => {
            let mut args = Map::new();
            match id {
                Some(one) => {
                    _ = args.insert("id".into(), json!(one));
                    if *wire {
                        _ = args.insert("wire".into(), json!(true));
                    }
                    if *diff {
                        _ = args.insert("diff".into(), json!(true));
                        if let Some(other) = against {
                            _ = args.insert("against".into(), json!(other));
                        }
                    }
                }
                None => {
                    _ = args.insert("count".into(), json!(count));
                    if let Some(ct) = call_type {
                        _ = args.insert("call_type".into(), json!(ct));
                    }
                }
            }
            Some(("call_log", Value::Object(args)))
        }
    }
}

fn model_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::{Map, Value, json};
    let CliCommand::Model {
        subcommand,
        info,
        reset,
        all,
        ..
    } = cmd
    else {
        return None;
    };
    if let Some(ModelCommand::Info { name: info_name }) = subcommand {
        let target = info_name.clone().unwrap_or_default();
        return Some(("model_info", json!({ "name": target })));
    }
    if let Some(ModelCommand::Use {
        name: target,
        background: use_background,
    }) = subcommand
    {
        let mut obj = Map::new();
        let _ignored = obj.insert("name".into(), json!(target));
        if let Some(task) = use_background {
            _ = obj.insert("background_task".into(), json!(task.as_str()));
        }
        return Some(("switch_model", Value::Object(obj)));
    }
    if let Some(ModelCommand::Reset {
        background: reset_background,
    }) = subcommand
    {
        let mut obj = Map::new();
        if let Some(task) = reset_background {
            _ = obj.insert("background_task".into(), json!(task.as_str()));
        }
        return Some(("reset_model", Value::Object(obj)));
    }
    if let Some(ModelCommand::Setting {
        key,
        value,
        global,
        reset: setting_reset,
        background: setting_background,
        subagent: setting_subagent,
        model: setting_model,
        ..
    }) = subcommand
    {
        let scope = if *global { "global" } else { "character" };
        let bg = setting_background.map(BackgroundTarget::as_str);
        let with_target = |mut obj: Map<String, Value>| -> Value {
            if let Some(task) = bg {
                let _ignored = obj.insert("background_task".into(), json!(task));
            }
            if let Some(name) = setting_subagent {
                let _ignored = obj.insert("subagent".into(), json!(name));
            }
            if let Some(name) = setting_model {
                let _ignored = obj.insert("name".into(), json!(name));
            }
            Value::Object(obj)
        };
        return match (key.as_deref(), value.as_deref(), *setting_reset) {
            (Some(k), _, true) => {
                let mut obj = Map::new();
                let _ignored = obj.insert("key".into(), json!(k));
                _ = obj.insert("value".into(), Value::Null);
                _ = obj.insert("scope".into(), json!(scope));
                Some(("set_model_setting", with_target(obj)))
            }
            (None, _, _) | (Some(_), None, false) => {
                Some(("model_settings", with_target(Map::new())))
            }
            (Some(k), Some(v), false) => {
                let mut obj = Map::new();
                let _ignored = obj.insert("key".into(), json!(k));
                _ = obj.insert("value".into(), parse_setting_value(k, v));
                _ = obj.insert("scope".into(), json!(scope));
                Some(("set_model_setting", with_target(obj)))
            }
        };
    }

    if *reset {
        return Some(("reset_model", json!({})));
    }
    if *info {
        return Some(("model_info", json!({})));
    }
    let mut args = Map::new();
    if *all {
        let _ignored = args.insert("include_hidden".into(), json!(true));
    }
    Some(("list_models", Value::Object(args)))
}

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

fn compact_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::{Map, Value, json};
    let CliCommand::Compact {
        keep_turns,
        restart,
        ..
    } = cmd
    else {
        return None;
    };
    let mut args = Map::new();
    if let Some(n) = keep_turns {
        let _ignored = args.insert("keep_turns".into(), json!(n));
    }
    if *restart {
        let _ignored = args.insert("restart".into(), json!(true));
    }
    Some(("compact", Value::Object(args)))
}

fn usage_to_swp(
    cmd: &CliCommand,
    selected: Option<&str>,
) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::json;
    let CliCommand::Usage {
        subcommand,
        last,
        provider,
        api_key,
        model,
        call_type,
        json: _,
    } = cmd
    else {
        return None;
    };
    let (budget, anomalies) = match subcommand {
        Some(UsageCommand::Budgets) => (true, false),
        Some(UsageCommand::Anomalies) => (false, true),
        Some(
            UsageCommand::By { .. }
            | UsageCommand::Cache
            | UsageCommand::Limits
            | UsageCommand::Export { .. },
        )
        | None => (false, false),
    };
    let (export_csv, export_tsv) = match subcommand {
        Some(UsageCommand::Export { tsv }) => (!tsv, *tsv),
        _ => (false, false),
    };
    let group_by = match subcommand {
        Some(UsageCommand::By { dimension }) => Some(dimension.wire()),
        _ => None,
    };
    Some((
        "usage",
        json!({
            "last": last,
            "character": selected,
            "provider": provider,
            "api_key": api_key,
            "model": model,
            "call_type": call_type,
            "group_by": group_by,
            "budget": budget,
            "anomalies": anomalies,
            "export_csv": export_csv,
            "export_tsv": export_tsv,
        }),
    ))
}

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

    fn parse(args: &[&str]) -> Cli {
        let mut full = vec!["shore"];
        full.extend_from_slice(args);
        Cli::parse_from(full)
    }

    fn try_parse(args: &[&str]) -> Result<Cli, clap::Error> {
        let mut full = vec!["shore"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full)
    }

    fn arg<'val>(args: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        args.get(key).expect("expected command argument")
    }

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

    #[test]
    fn parse_regen() {
        assert_variant!(&parse(&["regen"]).command, CliCommand::Regen => {});
    }

    #[test]
    fn regen_guidance_no_longer_parses() {
        for flag in ["--guidance", "-g"] {
            assert_eq!(
                misplaced(&["regen", flag, "be more concise"]),
                Some(FlagProblem::Retired(flag, GUIDANCE_WAS_NEVER_READ)),
                "{flag}"
            );
        }
        assert_eq!(
            parse_error(&["regen", "--guidance", "be more concise"]).kind(),
            clap::error::ErrorKind::UnknownArgument
        );
    }

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

    #[test]
    fn parse_log_default() {
        let cli = parse(&["log"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log {
                msg_ref,
                count,
                role,
                follow,
                json,
                content,
                reasoning,
                tools,
                subagent_tools,
            } => {
                assert!(msg_ref.is_none());
                assert_eq!(*count, 64);
                assert!(role.is_none());
                assert!(!follow);
                assert!(!json);
                assert!(!content);
                assert!(!reasoning);
                assert!(!tools);
                assert!(!subagent_tools);
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
            CliCommand::Log { msg_ref, .. } => {
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
                assert_eq!(*role, Some(LogRole::Character));
                assert_eq!(
                    role.map(LogRole::as_protocol_role),
                    Some("assistant"),
                    "character must reach the daemon as assistant"
                );
            }
        );
    }

    #[test]
    fn character_is_offered_in_the_role_list_not_hidden_as_an_alias() {
        use clap::CommandFactory as _;
        let help = Cli::command()
            .find_subcommand("log")
            .map(|c| c.clone().render_long_help().to_string())
            .unwrap_or_default();
        assert!(
            help.contains("character"),
            "a role you can pass must appear in --help: {help}"
        );
    }

    fn visible_subcommand_names() -> Vec<String> {
        use clap::CommandFactory as _;
        Cli::command()
            .get_subcommands()
            .filter(|sub| !sub.is_hide_set())
            .map(|sub| sub.get_name().to_owned())
            .collect()
    }

    #[test]
    fn every_command_belongs_to_exactly_one_help_group() {
        for name in visible_subcommand_names() {
            let groups: Vec<&str> = COMMAND_GROUPS
                .iter()
                .filter(|(_, names)| names.contains(&name.as_str()))
                .map(|(heading, _)| *heading)
                .collect();
            assert_eq!(
                groups.len(),
                1,
                "`shore {name}` is in {groups:?}; every command needs exactly one group"
            );
        }
    }

    #[test]
    fn every_grouped_name_is_a_command_that_exists() {
        use clap::CommandFactory as _;
        let command = Cli::command();
        for name in grouped_names() {
            assert!(
                command.find_subcommand(name).is_some(),
                "`{name}` is listed in a help group but is not a command"
            );
        }
    }

    #[test]
    fn the_top_level_help_shows_the_groups_and_every_command_under_them() {
        let help = grouped_command().render_help().to_string();
        for (heading, names) in COMMAND_GROUPS {
            assert!(
                help.contains(&format!("{heading}:")),
                "group `{heading}` is missing from --help: {help}"
            );
            for name in names {
                assert!(
                    help.contains(name),
                    "`shore {name}` is missing from --help: {help}"
                );
            }
        }
    }

    #[test]
    fn the_help_only_hiding_does_not_reach_the_completions() {
        let mut buf = Vec::new();
        clap_complete::generate(
            Shell::Fish,
            &mut {
                use clap::CommandFactory as _;
                Cli::command()
            },
            "shore",
            &mut buf,
        );
        let script = String::from_utf8(buf).expect("utf8");
        for name in visible_subcommand_names() {
            assert!(
                script.contains(&format!("-a \"{name}\"")),
                "`shore {name}` must still be completable: {script}"
            );
        }
    }

    #[test]
    fn parse_log_get_positive_index() {
        let cli = parse(&["log", "3"]);
        assert_variant!(
            &cli.command,
            CliCommand::Log { msg_ref, .. } => {
                assert_eq!(msg_ref.as_deref(), Some("3"));
            }
        );
    }

    #[test]
    fn parse_edit() {
        let cli = parse(&["edit", "msg_123", "new", "text"]);
        assert_variant!(
            &cli.command,
            CliCommand::Edit { msg_ref, content, .. } => {
                assert_eq!(msg_ref, "msg_123");
                assert_eq!(content, &["new", "text"]);
            }
        );
    }

    #[test]
    fn parse_edit_last() {
        let cli = parse(&["edit", "last", "updated"]);
        assert_variant!(
            &cli.command,
            CliCommand::Edit { msg_ref, content, .. } => {
                assert_eq!(msg_ref, "last");
                assert_eq!(content, &["updated"]);
            }
        );
    }

    #[test]
    fn parse_edit_negative_index() {
        let cli = parse(&["edit", "-1", "new", "text"]);
        assert_variant!(
            &cli.command,
            CliCommand::Edit { msg_ref, content, .. } => {
                assert_eq!(msg_ref, "-1");
                assert_eq!(content, &["new", "text"]);
            }
        );
    }

    #[test]
    fn parse_delete() {
        let cli = parse(&["delete", "msg_456"]);
        assert_variant!(
            &cli.command,
            CliCommand::Delete { msg_refs, .. } => {
                assert_eq!(msg_refs, &["msg_456"]);
            }
        );
    }

    #[test]
    fn parse_delete_negative_index() {
        let cli = parse(&["delete", "-1"]);
        assert_variant!(
            &cli.command,
            CliCommand::Delete { msg_refs, .. } => {
                assert_eq!(msg_refs, &["-1"]);
            }
        );
    }

    #[test]
    fn parse_delete_takes_several_refs() {
        let cli = parse(&["delete", "-1", "-2", "msg_456"]);
        assert_variant!(
            &cli.command,
            CliCommand::Delete { msg_refs, .. } => {
                assert_eq!(msg_refs, &["-1", "-2", "msg_456"]);
            }
        );
    }

    #[test]
    fn delete_needs_at_least_one_ref() {
        assert!(Cli::try_parse_from(["shore", "delete"]).is_err());
    }

    #[test]
    fn log_no_longer_carries_edit_or_delete() {
        for args in [
            &["log", "edit", "last", "text"][..],
            &["log", "delete", "last"][..],
        ] {
            assert!(
                Cli::try_parse_from(std::iter::once("shore").chain(args.iter().copied())).is_err(),
                "{args:?} must not parse"
            );
        }
    }

    #[test]
    fn log_swipe_is_not_a_subcommand() {
        let result = Cli::try_parse_from(["shore", "log", "swipe", "prev"]);
        assert!(result.is_err());
    }

    #[test]
    fn parse_character_list() {
        let cli = parse(&["character"]);
        assert_variant!(
            &cli.command,
            CliCommand::Character { subcommand, info, .. } => {
                assert!(subcommand.is_none());
                assert!(!info);
            }
        );
    }

    #[test]
    fn parse_character_switch() {
        let cli = parse(&["character", "use", "alice"]);
        assert_variant!(
            &cli.command,
            CliCommand::Character { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(CharacterCommand::Use { name }) if name == "alice"
                ));
            }
        );
    }

    #[test]
    fn parse_character_new() {
        let cli = parse(&["character", "new", "alice"]);
        assert_variant!(
            &cli.command,
            CliCommand::Character { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(CharacterCommand::New { name }) if name == "alice"
                ));
            }
        );
    }

    #[test]
    fn character_new_requires_a_name() {
        let err = Cli::try_parse_from(["shore", "character", "new"])
            .expect_err("new with no NAME must not parse");
        assert_eq!(err.kind(), clap::error::ErrorKind::MissingRequiredArgument);
        assert!(err.to_string().contains("NAME"), "{err}");
    }

    #[test]
    fn parse_character_info() {
        let cli = parse(&["character", "info"]);
        assert_variant!(
            &cli.command,
            CliCommand::Character { subcommand, .. } => {
                assert!(matches!(subcommand, Some(CharacterCommand::Info)));
            }
        );
    }

    #[test]
    fn parse_status() {
        let cli = parse(&["status"]);
        assert_variant!(
            &cli.command,
            CliCommand::Status { section, .. } => {
                assert!(section.is_none());
            }
        );
    }

    #[test]
    fn status_no_longer_carries_diagnostics() {
        for args in [
            &["status", "--diagnostics"][..],
            &["status", "-n", "25"][..],
        ] {
            assert!(
                Cli::try_parse_from(std::iter::once("shore").chain(args.iter().copied())).is_err(),
                "{args:?} must not parse"
            );
        }
    }

    #[test]
    fn parse_trace_errors() {
        let cli = parse(&["trace", "errors", "-n", "5"]);
        assert_variant!(
            &cli.command,
            CliCommand::Trace {
                subcommand: Some(TraceCommand::Errors { count, json }),
            } => {
                assert_eq!(*count, 5);
                assert!(!json);
            }
        );
    }

    #[test]
    fn parse_debug_tick_now() {
        let cli = parse(&["debug", "heartbeat_tick_now"]);
        assert_variant!(
            &cli.command,
            CliCommand::Debug {
                subcommand: Some(DebugCommand::TickNow),
            } => {}
        );
    }

    #[test]
    fn parse_debug_status_dormant() {
        let cli = parse(&["debug", "heartbeat_status_dormant"]);
        assert_variant!(
            &cli.command,
            CliCommand::Debug {
                subcommand: Some(DebugCommand::StatusDormant),
            } => {}
        );
    }

    #[test]
    fn parse_debug_status_active() {
        let cli = parse(&["debug", "heartbeat_status_active"]);
        assert_variant!(
            &cli.command,
            CliCommand::Debug {
                subcommand: Some(DebugCommand::StatusActive),
            } => {}
        );
    }

    #[test]
    fn parse_model_list() {
        let cli = parse(&["model"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model {
                info,
                subcommand,
                all,
                ..
            } => {
                assert!(!info);
                assert!(subcommand.is_none());
                assert!(!all);
            }
        );
    }

    #[test]
    fn parse_model_switch() {
        let cli = parse(&["model", "use", "claude-haiku-4-5-20251001"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(ModelCommand::Use { name, background: None })
                        if name == "claude-haiku-4-5-20251001"
                ));
            }
        );
    }

    #[test]
    fn parse_model_info() {
        let cli = parse(&["model", "info", "opus"]);
        assert_variant!(
            &cli.command,
            CliCommand::Model { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(ModelCommand::Info { name: Some(n) }) if n == "opus"
                ));
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

    #[test]
    fn parse_compact() {
        for (args, expected, expected_restart) in [
            (&["compact"][..], None, false),
            (&["compact", "0"][..], Some(0), false),
            (&["compact", "8"][..], Some(8), false),
            (&["compact", "--restart"][..], None, true),
            (&["compact", "0", "--restart"][..], Some(0), true),
        ] {
            let cli = parse(args);
            assert_variant!(
                &cli.command,
                CliCommand::Compact { keep_turns, restart, .. } => {
                    assert_eq!(*keep_turns, expected, "{args:?}");
                    assert_eq!(*restart, expected_restart, "{args:?}");
                }
            );
        }
    }

    #[test]
    fn compact_is_no_longer_under_memory() {
        for args in [&["memory", "compact"][..], &["memory", "compact", "8"][..]] {
            assert_eq!(
                misplaced(args),
                Some(FlagProblem::Promoted("memory compact", "compact")),
                "{args:?}"
            );
        }
    }

    #[test]
    fn parse_config_no_args() {
        let cli = parse(&["config"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config {
                subcommand,
                path,
                check,
                ..
            } => {
                assert!(subcommand.is_none());
                assert!(!path);
                assert!(!check);
            }
        );
    }

    #[test]
    fn parse_config_get() {
        let cli = parse(&["config", "get", "defaults.model"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config {
                subcommand: Some(ConfigCommand::Get { key, toml, all, .. }),
                ..
            } => {
                assert_eq!(key, "defaults.model");
                assert!(!toml);
                assert!(!all);
            }
        );
    }

    #[test]
    fn parse_config_set() {
        let cli = parse(&[
            "config",
            "set",
            "defaults.model",
            "claude-haiku-4-5-20251001",
        ]);
        assert_variant!(
            &cli.command,
            CliCommand::Config {
                subcommand: Some(ConfigCommand::Set { key, value, .. }),
                ..
            } => {
                assert_eq!(key, "defaults.model");
                assert_eq!(value, "claude-haiku-4-5-20251001");
            }
        );
    }

    #[test]
    fn a_bare_key_is_no_longer_a_read_or_a_write() {
        for args in [
            &["config", "model"][..],
            &["config", "model", "claude-haiku-4-5-20251001"][..],
        ] {
            assert!(
                Cli::try_parse_from(std::iter::once("shore").chain(args.iter().copied())).is_err(),
                "`shore {}` must route through get/set: {args:?}",
                args.join(" ")
            );
        }
    }

    #[test]
    fn config_set_needs_both_a_key_and_a_value() {
        assert!(Cli::try_parse_from(["shore", "config", "set", "defaults.model"]).is_err());
        assert!(Cli::try_parse_from(["shore", "config", "get"]).is_err());
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
        let cmd = CliCommand::Config {
            subcommand: Some(ConfigCommand::Reload {
                yes: false,
                json: false,
            }),
            path: false,
            check: false,
            json: false,
            toml: false,
            all: false,
        };
        assert!(to_swp_command(&cmd, None).is_none());
    }

    #[test]
    fn config_tools_asks_the_daemon_for_the_tool_surface() {
        let cli = parse(&["config", "tools"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config {
                subcommand: Some(ConfigCommand::Tools { json }),
                ..
            } => assert!(!json)
        );
        let (name, _args) = to_swp_command(&cli.command, None).expect("must map to a command");
        assert_eq!(name, "tools");
    }

    #[test]
    fn a_dotted_key_under_tools_is_still_a_key_read() {
        let cli = parse(&["config", "get", "tools.enabled_tools"]);
        assert_variant!(
            &cli.command,
            CliCommand::Config { subcommand, .. } => {
                assert_variant!(
                    subcommand,
                    Some(ConfigCommand::Get { key, .. }) => {
                        assert_eq!(key, "tools.enabled_tools");
                    }
                );
            }
        );
        let (name, args) = to_swp_command(&cli.command, None).expect("must map to a command");
        assert_eq!(name, "config");
        assert_eq!(
            args.get("key").and_then(|v| v.as_str()),
            Some("tools.enabled_tools")
        );
    }

    #[test]
    fn the_tool_surface_is_no_longer_a_top_level_command() {
        assert!(
            Cli::try_parse_from(["shore", "tools"]).is_err(),
            "`shore tools` moved under `shore config`"
        );
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

    #[test]
    fn parse_leading_addr_flag() {
        let cli = parse(&["--addr", "127.0.0.1:7320", "status"]);
        assert_eq!(cli.addr.as_deref(), Some("127.0.0.1:7320"));
        assert!(matches!(cli.command, CliCommand::Status { .. }));
    }

    #[test]
    fn parse_leading_character_flag() {
        let cli = parse(&["--character", "ada", "status"]);
        assert_eq!(cli.character.as_deref(), Some("ada"));
        let short = parse(&["-c", "ada", "status"]);
        assert_eq!(short.character.as_deref(), Some("ada"));
    }

    fn with_program_name<'arg>(rest: &[&'arg str]) -> Vec<&'arg str> {
        std::iter::once("shore")
            .chain(rest.iter().copied())
            .collect()
    }

    fn parse_error(rest: &[&str]) -> clap::Error {
        <Cli as clap::Parser>::try_parse_from(with_program_name(rest))
            .expect_err("should not parse")
    }

    fn misplaced(rest: &[&str]) -> Option<FlagProblem> {
        flag_problem(with_program_name(rest))
    }

    #[test]
    fn a_trailing_leading_flag_says_where_it_belongs() {
        for args in [
            &["log", "--character", "ada"][..],
            &["log", "-c", "ada"][..],
            &["status", "--character=ada"][..],
            &["log", "edit", "last", "-c", "ada"][..],
        ] {
            assert_eq!(
                misplaced(args),
                Some(FlagProblem::Misplaced("--character")),
                "{args:?}"
            );
        }
        assert_eq!(
            misplaced(&["status", "--addr", "127.0.0.1:7320"]),
            Some(FlagProblem::Misplaced("--addr"))
        );
    }

    #[test]
    fn a_retired_flag_names_what_replaced_it() {
        for args in [
            &["--config", "/etc/shore.toml", "status"][..],
            &["status", "--config=/etc/shore.toml"][..],
        ] {
            assert_eq!(
                misplaced(args),
                Some(FlagProblem::Retired(
                    "--config",
                    "name the daemon with --addr, or set SHORE_ADDR"
                )),
                "{args:?}"
            );
        }
        assert_eq!(
            misplaced(&["--no-color", "status"]),
            Some(FlagProblem::Retired(
                "--no-color",
                "set NO_COLOR=1 in the environment"
            ))
        );
        assert_eq!(
            misplaced(&["log", "--plain"]),
            Some(FlagProblem::Retired(
                "--plain",
                "output is already plain when it is not going to a terminal"
            )),
            "otherwise the message-reference parser answers first, and says \
             '--plain' is not a message reference"
        );
    }

    #[test]
    fn a_retired_sampling_flag_points_at_the_model_settings() {
        for (flag, instead) in [
            (
                "--temperature",
                "set it on the model: shore model setting temperature <value>",
            ),
            (
                "--top-p",
                "set it on the model: shore model setting top_p <value>",
            ),
            (
                "--thinking",
                "set it on the model: shore model setting budget_tokens <tokens>",
            ),
        ] {
            assert_eq!(
                misplaced(&["send", flag, "0.8", "hello"]),
                Some(FlagProblem::Retired(flag, instead)),
                "{flag}"
            );
        }
    }

    #[test]
    fn a_leading_flag_in_its_own_place_is_fine() {
        for args in [
            &["--character", "ada", "log"][..],
            &["-c", "ada", "--addr", "127.0.0.1:7320", "status"][..],
            &["--character=ada", "status"][..],
            &["--character", "status", "status"][..],
            &["log", "-n", "5"][..],
            &["send", "--", "-c", "is a flag"][..],
        ] {
            assert_eq!(misplaced(args), None, "{args:?}");
        }
    }

    #[test]
    fn a_mistyped_flag_is_not_read_as_a_message_reference() {
        for args in [
            &["log", "--conten"][..],
            &["edit", "--conten"][..],
            &["delete", "--conten"][..],
            &["delete", "-1", "--conten"][..],
            &["alt", "--conten"][..],
        ] {
            let err = parse_error(args);
            assert!(
                err.to_string().contains("is not a message reference"),
                "{args:?} gave: {err}"
            );
        }
        assert_variant!(
            &parse(&["log", "-1"]).command,
            CliCommand::Log { msg_ref, .. } => {
                assert_eq!(msg_ref.as_deref(), Some("-1"));
            }
        );
        assert_variant!(
            &parse(&["delete", "-1", "-2"]).command,
            CliCommand::Delete { msg_refs, .. } => {
                assert_eq!(msg_refs, &["-1", "-2"]);
            }
        );
    }

    #[test]
    fn a_bare_name_points_at_use() {
        assert_eq!(
            misplaced(&["model", "opus"]),
            Some(FlagProblem::BareName("model", "opus".to_owned()))
        );
        assert_eq!(
            misplaced(&["character", "qifei"]),
            Some(FlagProblem::BareName("character", "qifei".to_owned()))
        );
    }

    #[test]
    fn a_real_subcommand_is_not_mistaken_for_a_name() {
        for args in [
            &["model"][..],
            &["model", "use", "opus"][..],
            &["model", "info", "opus"][..],
            &["model", "setting", "temperature", "0.7"][..],
            &["character", "use", "qifei"][..],
            &["character", "new", "ada"][..],
            &["provider", "models", "openrouter"][..],
            &["log", "last"][..],
            &["model", "--info", "opus"][..],
        ] {
            assert_eq!(misplaced(args), None, "{args:?}");
        }
    }

    #[test]
    fn reset_is_retired_under_config_and_nowhere_else() {
        assert_eq!(
            misplaced(&["config", "--reset"]),
            Some(FlagProblem::Retired(
                "--reset",
                "there were no runtime overrides to drop; re-read the file with: shore config reload",
            )),
        );

        for args in [
            &["model", "setting", "--reset", "temperature"][..],
            &["model", "--reset"][..],
        ] {
            assert_eq!(misplaced(args), None, "{args:?}");
        }
    }

    #[test]
    fn retired_flags_no_longer_parse() {
        for flag in ["--config", "--no-color"] {
            assert_eq!(
                parse_error(&[flag, "status"]).kind(),
                clap::error::ErrorKind::UnknownArgument,
                "{flag}"
            );
        }
        for flag in ["--temperature", "--top-p", "--thinking"] {
            assert_eq!(
                parse_error(&["send", flag, "0.8", "hi"]).kind(),
                clap::error::ErrorKind::UnknownArgument,
                "{flag}"
            );
        }
    }

    #[test]
    fn send_maps_to_none() {
        let cmd = CliCommand::Send {
            message: vec!["hi".into()],
            images: vec![],
            system: false,
        };
        assert!(to_swp_command(&cmd, None).is_none());
    }

    #[test]
    fn regen_maps_to_none() {
        let cmd = CliCommand::Regen;
        assert!(to_swp_command(&cmd, None).is_none());
    }

    #[test]
    fn completions_maps_to_none() {
        let cmd = CliCommand::Completions { shell: Shell::Fish };
        assert!(to_swp_command(&cmd, None).is_none());
    }

    #[test]
    fn status_maps_to_command() {
        let cmd = CliCommand::Status {
            section: None,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "status");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn trace_errors_maps_to_error_log_command() {
        let cmd = CliCommand::Trace {
            subcommand: Some(TraceCommand::Errors {
                count: 15,
                json: false,
            }),
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "error_log");
        assert_eq!(arg(&args, "count"), 15);
    }

    #[test]
    fn debug_keepalive_ping_now_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: Some(DebugCommand::KeepalivePingNow),
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "keepalive_ping_now");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn parse_debug_keepalive_ping_now() {
        let cli = parse(&["debug", "keepalive_ping_now"]);
        assert!(matches!(
            cli.command,
            CliCommand::Debug {
                subcommand: Some(DebugCommand::KeepalivePingNow)
            }
        ));
    }

    #[test]
    fn debug_tool_sends_pairs_as_strings_for_the_daemon_to_coerce() {
        let cli = parse(&["debug", "tool", "read", "path=notes.md", "offset=3"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "run_tool");
        assert_eq!(arg(&args, "tool"), "read");
        assert_eq!(
            arg(&args, "pairs"),
            &serde_json::json!({ "path": "notes.md", "offset": "3" })
        );
        assert_eq!(arg(&args, "input"), &serde_json::json!({}));
        assert_eq!(arg(&args, "raw"), false);
    }

    #[test]
    fn debug_tool_value_may_contain_equals_signs() {
        let cli = parse(&["debug", "tool", "search", "query=a=b"]);
        let (_name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(arg(&args, "pairs"), &serde_json::json!({ "query": "a=b" }));
    }

    #[test]
    fn debug_tool_input_carries_nested_json_alongside_pairs() {
        let cli = parse(&[
            "debug",
            "tool",
            "read",
            "path=notes.md",
            "--input",
            r#"{"globs":["*.md"]}"#,
            "--raw",
        ]);
        let (_name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(
            arg(&args, "input"),
            &serde_json::json!({ "globs": ["*.md"] })
        );
        assert_eq!(
            arg(&args, "pairs"),
            &serde_json::json!({ "path": "notes.md" })
        );
        assert_eq!(arg(&args, "raw"), true);
    }

    #[test]
    fn debug_tool_rejects_an_argument_with_no_equals() {
        let err = Cli::try_parse_from(["shore", "debug", "tool", "read", "notes.md"]).unwrap_err();
        assert!(err.to_string().contains("expected key=value"));
    }

    #[test]
    fn debug_tool_rejects_input_that_is_not_a_json_object() {
        let err = Cli::try_parse_from(["shore", "debug", "tool", "read", "--input", "[1,2]"])
            .unwrap_err();
        assert!(err.to_string().contains("must be a JSON object"));
    }

    #[test]
    fn debug_subagent_is_shorthand_for_ask_with_a_joined_query() {
        let cli = parse(&[
            "debug",
            "subagent",
            "librarian",
            "what",
            "did",
            "we",
            "decide",
        ]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "run_tool");
        assert_eq!(arg(&args, "tool"), "ask_librarian");
        assert_eq!(
            arg(&args, "input"),
            &serde_json::json!({ "query": "what did we decide" })
        );
    }

    #[test]
    fn debug_session_activate_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: Some(DebugCommand::SessionActivate),
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "session_activate");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn parse_debug_session_activate() {
        let cli = parse(&["debug", "session_activate"]);
        assert!(matches!(
            cli.command,
            CliCommand::Debug {
                subcommand: Some(DebugCommand::SessionActivate)
            }
        ));
    }

    #[test]
    fn debug_tick_now_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: Some(DebugCommand::TickNow),
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "heartbeat_tick_now");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn debug_status_dormant_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: Some(DebugCommand::StatusDormant),
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "heartbeat_set_dormant");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn debug_status_active_maps_to_command() {
        let cmd = CliCommand::Debug {
            subcommand: Some(DebugCommand::StatusActive),
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "heartbeat_set_active");
        assert_eq!(args, serde_json::json!({}));
    }

    #[test]
    fn character_listing_maps_to_none() {
        let listing = CliCommand::Character {
            subcommand: None,
            info: false,
            json: false,
        };
        assert!(to_swp_command(&listing, None).is_none());
        let switching = CliCommand::Character {
            subcommand: Some(CharacterCommand::Use {
                name: "alice".into(),
            }),
            info: false,
            json: false,
        };
        assert!(to_swp_command(&switching, None).is_none());
    }

    #[test]
    fn character_info_maps_to_command() {
        let cmd = CliCommand::Character {
            subcommand: Some(CharacterCommand::Info),
            info: false,
            json: false,
        };
        let (name, _) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "character_info");
    }

    #[test]
    fn model_info_maps_to_command() {
        let cmd = CliCommand::Model {
            subcommand: Some(ModelCommand::Info {
                name: Some("opus".into()),
            }),
            info: false,
            reset: false,
            all: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "model_info");
        assert_eq!(arg(&args, "name"), "opus");
    }

    #[test]
    fn model_list_with_all_includes_hidden_arg() {
        let cmd = CliCommand::Model {
            subcommand: None,
            info: false,
            reset: false,
            all: true,
            json: false,
        };
        let (cmd_name, args) = to_swp_command(&cmd, None).unwrap();
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
                subagent: None,
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            json: false,
        };
        let (name, _) = to_swp_command(&cmd, None).unwrap();
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
                subagent: None,
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
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
                subagent: None,
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
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
                subagent: None,
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            json: false,
        };
        let (_, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(arg(&args, "scope"), "global");
    }

    #[test]
    fn the_background_model_is_reported_by_the_list_not_a_subcommand() {
        assert!(Cli::try_parse_from(["shore", "model", "--background"]).is_err());
        let (name, _) = to_swp_command(&parse(&["model"]).command, None).unwrap();
        assert_eq!(name, "list_models");
    }

    #[test]
    fn the_retired_background_subcommand_says_where_it_went() {
        assert_eq!(
            misplaced(&["model", "background"]),
            Some(FlagProblem::Retired(
                "model background",
                "every model role is listed by `shore model`; pin one with \
                 `shore model use --background <heartbeat|compaction|all> <name>`",
            )),
        );
    }

    #[test]
    fn model_use_background_threads_the_task() {
        let cli = parse(&["model", "use", "--background", "heartbeat", "kimi-k3"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "switch_model");
        assert_eq!(arg(&args, "name"), "kimi-k3");
        assert_eq!(arg(&args, "background_task"), "heartbeat");
    }

    #[test]
    fn model_use_without_background_omits_the_task() {
        let cli = parse(&["model", "use", "kimi-k3"]);
        let (_, args) = to_swp_command(&cli.command, None).unwrap();
        assert!(args.get("background_task").is_none());
    }

    #[test]
    fn model_reset_background_threads_the_task() {
        let cli = parse(&["model", "reset", "--background", "all"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "reset_model");
        assert_eq!(arg(&args, "background_task"), "all");
    }

    #[test]
    fn a_background_pin_needs_a_model_name() {
        assert!(
            Cli::try_parse_from(["shore", "model", "use", "--background", "heartbeat"]).is_err()
        );
    }

    #[test]
    fn model_setting_background_show_threads_task() {
        let cli = parse(&["model", "setting", "--background", "compaction"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
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
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
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
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert!(arg(&args, "value").is_null());
        assert_eq!(arg(&args, "background_task"), "heartbeat");
    }

    #[test]
    fn model_setting_subagent_show_threads_the_name() {
        let cli = parse(&["model", "setting", "--subagent", "librarian"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "model_settings");
        assert_eq!(arg(&args, "subagent"), "librarian");
        assert!(args.get("background_task").is_none());
        assert!(args.get("name").is_none());
    }

    #[test]
    fn model_setting_subagent_set_threads_the_name() {
        let cli = parse(&[
            "model",
            "setting",
            "--subagent",
            "librarian",
            "temperature",
            "0.25",
        ]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "subagent"), "librarian");
        assert_eq!(arg(&args, "key"), "temperature");
        assert_eq!(arg(&args, "value"), 0.25);
    }

    #[test]
    fn model_setting_subagent_reset_threads_the_name() {
        let cli = parse(&[
            "model",
            "setting",
            "--subagent",
            "librarian",
            "--reset",
            "temperature",
        ]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "subagent"), "librarian");
        assert!(arg(&args, "value").is_null());
    }

    #[test]
    fn model_setting_model_targets_a_catalog_name_without_switching() {
        let cli = parse(&["model", "setting", "--model", "opus", "top_p", "0.9"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "name"), "opus");
        assert!(args.get("subagent").is_none());
    }

    #[test]
    fn model_setting_targets_are_mutually_exclusive() {
        for pair in [
            ["--subagent", "librarian", "--background", "compaction"],
            ["--model", "opus", "--background", "compaction"],
            ["--subagent", "librarian", "--model", "opus"],
        ] {
            let mut argv = vec!["shore", "model", "setting"];
            argv.extend_from_slice(&pair);
            assert!(
                Cli::try_parse_from(&argv).is_err(),
                "{pair:?} must not combine"
            );
        }
    }

    #[test]
    fn model_setting_without_background_omits_task() {
        let cli = parse(&["model", "setting", "temperature", "0.7"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert!(args.get("background_task").is_none());
    }

    #[test]
    fn model_setting_reasoning_off_sends_off_sentinel() {
        let cmd = CliCommand::Model {
            subcommand: Some(ModelCommand::Setting {
                key: Some("reasoning_effort".into()),
                value: Some("off".into()),
                global: false,
                reset: false,
                background: None,
                subagent: None,
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            json: false,
        };
        let (_, args) = to_swp_command(&cmd, None).unwrap();
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
                    subagent: None,
                    model: None,
                    json: false,
                }),
                info: false,
                reset: false,
                all: false,
                json: false,
            };
            let (_, args) = to_swp_command(&cmd, None).unwrap();
            assert_eq!(arg(&args, "value"), "off", "synonym {synonym:?}");
        }
    }

    #[test]
    fn parse_setting_value_coerces_vendor_knobs() {
        use serde_json::json;
        assert_eq!(
            parse_setting_value("zai_clear_thinking", "false"),
            json!(false)
        );
        assert_eq!(parse_setting_value("zai_subscription", "yes"), json!(true));
        assert_eq!(parse_setting_value("gemini_generation", "3"), json!(3));
        assert_eq!(
            parse_setting_value("openrouter_provider", r#"{"order":["Anthropic"]}"#),
            json!({"order": ["Anthropic"]})
        );
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
        let (name, _) = to_swp_command(&cmd, None).unwrap();
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
        let (name, args) = to_swp_command(&cmd, None).unwrap();
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
        let (name, args) = to_swp_command(&cmd, None).unwrap();
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
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "refresh_all_provider_models");
        assert!(args.as_object().unwrap().is_empty());
    }

    #[test]
    fn a_footer_line_completing_an_option_requires_its_parameter() {
        for line in fish_dynamic_completions_footer()
            .lines()
            .filter(|l| l.starts_with("complete ") && l.contains(" -l "))
        {
            assert!(
                line.contains(" -r "),
                "without -r fish reads the option as taking no argument, so \
                 `--opt <TAB>` falls through to file completion: {line}"
            );
        }
    }

    #[test]
    fn fish_footer_completes_the_status_sections() {
        let footer = fish_dynamic_completions_footer();
        assert!(
            footer.contains("shore complete sections"),
            "footer must shell out to `shore complete sections`: {footer}"
        );
        assert!(
            footer.contains("-l section -r -f -a"),
            "the section line needs -r (space form) and -f (no file fallback): {footer}"
        );
    }

    #[test]
    fn debug_tool_describes_instead_of_running_only_when_asked() {
        let (cmd, plain) =
            to_swp_command(&parse(&["debug", "tool", "read"]).command, None).unwrap();
        assert_eq!(cmd, "run_tool");
        assert_eq!(
            arg(&plain, "describe"),
            false,
            "a bare `debug tool` still runs the tool",
        );

        let (_, described) = to_swp_command(
            &parse(&["debug", "tool", "read", "--describe"]).command,
            None,
        )
        .unwrap();
        assert_eq!(arg(&described, "describe"), true);
        assert_eq!(arg(&described, "tool"), "read");
    }

    #[test]
    fn fish_footer_completes_sampler_keys_under_model_setting() {
        let footer = fish_dynamic_completions_footer();
        let line = footer
            .lines()
            .find(|l| l.contains("shore complete setting-keys"))
            .expect("footer must shell out to `shore complete setting-keys`");
        assert!(line.contains("__fish_shore_using_subcommand model"));
        assert!(line.contains("__fish_seen_subcommand_from setting"));
        assert!(
            line.contains("not __shore_setting_key"),
            "keys must stop completing once one is typed: {line}"
        );
        assert!(
            line.contains(" -f "),
            "keys must not fall back to files: {line}"
        );
    }

    #[test]
    fn fish_footer_completes_the_setting_target_flags() {
        let footer = fish_dynamic_completions_footer();
        for (flag, kind) in [("subagent", "subagents"), ("model", "models")] {
            let line = footer
                .lines()
                .find(|l| {
                    l.contains("__fish_seen_subcommand_from setting")
                        && l.contains(&format!(" -l {flag} "))
                })
                .unwrap_or_else(|| panic!("footer must complete `--{flag}` under `model setting`"));
            assert!(
                line.contains(&format!("shore complete {kind}")),
                "`--{flag}` must complete from `{kind}`: {line}"
            );
        }
    }

    #[test]
    fn the_subagent_flag_offers_all_alongside_the_names() {
        let line = fish_dynamic_completions_footer()
            .lines()
            .find(|l| {
                l.contains("__fish_seen_subcommand_from setting") && l.contains(" -l subagent ")
            })
            .expect("footer must complete `--subagent` under `model setting`");
        assert!(
            line.contains("-a \"all ("),
            "`all` must be offered before the configured names: {line}"
        );
    }

    #[test]
    fn model_setting_subagent_all_threads_through_like_any_name() {
        let cli = parse(&[
            "model",
            "setting",
            "--subagent",
            "all",
            "temperature",
            "0.3",
        ]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "subagent"), "all");
        assert_eq!(arg(&args, "value"), 0.3);
    }

    #[test]
    fn the_setting_key_guard_skips_target_flag_values() {
        let footer = fish_dynamic_completions_footer();
        let body = footer
            .split("function __shore_setting_key")
            .nth(1)
            .expect("footer must define __shore_setting_key");
        assert!(
            body.contains("contains -- $token --subagent --model --background"),
            "the guard must not mistake a target flag's value for the key: {body}"
        );
    }

    #[test]
    fn fish_footer_completes_the_debug_tool_and_subagent_names() {
        let footer = fish_dynamic_completions_footer();
        for (kind, sub) in [("tools", "tool"), ("subagents", "subagent")] {
            let line = footer
                .lines()
                .find(|l| l.contains(&format!("shore complete {kind}")))
                .unwrap_or_else(|| {
                    panic!("footer must shell out to `shore complete {kind}`: {footer}")
                });
            assert!(
                line.contains("__fish_shore_using_subcommand debug"),
                "`{kind}` must only complete under `shore debug`: {line}"
            );
            assert!(
                line.contains(&format!("__fish_seen_subcommand_from {sub}")),
                "`{kind}` must complete after `debug {sub}`: {line}"
            );
            assert!(
                line.contains(" -f "),
                "`{kind}` must not fall back to files: {line}"
            );
        }
    }

    #[test]
    fn every_completion_kind_is_offered_by_the_fish_footer() {
        use clap::ValueEnum as _;
        let footer = fish_dynamic_completions_footer();
        for kind in CompleteKind::value_variants() {
            let name = kind
                .to_possible_value()
                .expect("every kind is selectable")
                .get_name()
                .to_owned();
            assert!(
                footer.contains(&format!("shore complete {name}")),
                "`shore complete {name}` exists but nothing in the footer calls it: {footer}"
            );
        }
    }

    #[test]
    fn fish_footer_completes_config_keys_and_then_their_values() {
        let footer = fish_dynamic_completions_footer();
        assert!(
            footer.contains("function __shore_config_key"),
            "value completion needs the key already on the line: {footer}"
        );

        let line_for = |call: &str| {
            footer
                .lines()
                .find(|l| l.contains(call))
                .unwrap_or_else(|| panic!("footer must call `{call}`: {footer}"))
                .to_owned()
        };

        let keys = line_for("shore complete config-keys");
        assert!(
            keys.contains("__fish_seen_subcommand_from set")
                && keys.contains("not __shore_config_key"),
            "settable keys belong in `config set`'s first slot only: {keys}"
        );

        let sections = line_for("shore complete config-sections");
        assert!(
            sections.contains("__fish_seen_subcommand_from get"),
            "`get` reads tables too, so it gets the wider list: {sections}"
        );

        let values = line_for("shore complete config-values");
        assert!(
            values.contains("(__shore_config_key)"),
            "values must be requested for the key on the line: {values}"
        );
        assert!(
            values.contains("and __shore_config_key\""),
            "values only make sense once a key is typed: {values}"
        );
    }

    #[test]
    fn config_value_completion_takes_the_key_as_an_argument() {
        let cli = parse(&["complete", "config-values", "defaults.stream"]);
        assert_variant!(
            &cli.command,
            CliCommand::Complete { kind, arg } => {
                assert_eq!(*kind, CompleteKind::ConfigValues);
                assert_eq!(arg.as_deref(), Some("defaults.stream"));
            }
        );
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
            path: true,
            check: false,
            json: false,
            toml: false,
            all: false,
        };
        assert!(to_swp_command(&cmd, None).is_none());
    }

    #[test]
    fn edit_maps_to_edit_command() {
        let cmd = CliCommand::Edit {
            msg_ref: "m1".into(),
            content: vec!["new".into(), "text".into()],
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "edit");
        assert_eq!(arg(&args, "ref"), "m1");
        assert_eq!(arg(&args, "content"), "new text");
    }

    #[test]
    fn delete_maps_to_delete_command() {
        let cmd = CliCommand::Delete {
            msg_refs: vec!["m1".into()],
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "delete");
        assert_eq!(arg(&args, "refs"), &serde_json::json!(["m1"]));
    }

    #[test]
    fn delete_sends_every_ref_as_one_list() {
        let cmd = CliCommand::Delete {
            msg_refs: vec!["-1".into(), "-2".into()],
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "delete");
        assert_eq!(arg(&args, "refs"), &serde_json::json!(["-1", "-2"]));
    }

    #[test]
    fn alt_position_maps_to_alt_command() {
        let cmd = CliCommand::Alt {
            selector: Some("2".into()),
            msg_ref: Some("last".into()),
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
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
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "list_alternatives");
        assert!(args.as_object().unwrap().is_empty());
    }

    #[test]
    fn log_ref_maps_to_get_command() {
        let cmd = CliCommand::Log {
            msg_ref: Some("last".into()),
            count: 20,
            role: Some(LogRole::User),
            follow: false,
            json: false,
            content: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "get");
        assert_eq!(arg(&args, "ref"), "last");
        assert_eq!(arg(&args, "role"), "user");
    }

    #[test]
    fn log_default_maps_to_log_command() {
        let cmd = CliCommand::Log {
            msg_ref: None,
            count: 20,
            role: Some(LogRole::Assistant),
            follow: false,
            json: false,
            content: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "log");
        assert_eq!(arg(&args, "turns"), 20);
        assert_eq!(arg(&args, "role"), "assistant");
    }

    #[test]
    fn trace_subagent_bare_lists_recent_runs() {
        let cli = parse(&["trace", "subagent", "-n", "5"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "subagent_trace");
        assert_eq!(arg(&args, "count"), 5);
        assert!(args.get("ids").is_none());
    }

    #[test]
    fn trace_subagent_with_id_asks_for_one_run() {
        let cli = parse(&["trace", "subagent", "toolu_01A"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "subagent_trace");
        assert_eq!(arg(&args, "ids"), &serde_json::json!(["toolu_01A"]));
        assert!(args.get("count").is_none());
    }

    #[test]
    fn log_subagent_tools_stays_on_the_conversation() {
        let cli = parse(&["log", "--subagent-tools"]);
        let (name, _) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "log");
    }

    #[test]
    fn trace_calls_diff_asks_for_a_comparison() {
        let cli = parse(&["trace", "calls", "42", "--diff"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "call_log");
        assert_eq!(arg(&args, "id"), 42);
        assert_eq!(arg(&args, "diff"), true);
        assert!(args.get("against").is_none());
    }

    #[test]
    fn trace_calls_diff_against_pins_the_other_side() {
        let cli = parse(&["trace", "calls", "42", "--diff", "--against", "40"]);
        let (_, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(arg(&args, "against"), 40);
    }

    #[test]
    fn trace_calls_without_diff_asks_for_no_comparison() {
        let cli = parse(&["trace", "calls", "42"]);
        let (_, args) = to_swp_command(&cli.command, None).unwrap();
        assert!(args.get("diff").is_none());
    }

    #[test]
    fn trace_calls_asks_for_the_wire_only_when_told_to() {
        let bare = parse(&["trace", "calls", "42"]);
        let (_, bare_args) = to_swp_command(&bare.command, None).unwrap();
        assert!(bare_args.get("wire").is_none());

        let asked = parse(&["trace", "calls", "42", "--wire"]);
        let (name, args) = to_swp_command(&asked.command, None).unwrap();
        assert_eq!(name, "call_log");
        assert_eq!(arg(&args, "id"), 42);
        assert_eq!(arg(&args, "wire"), true);
    }

    #[test]
    fn trace_calls_wire_needs_a_call_to_read() {
        assert!(try_parse(&["trace", "calls", "--wire"]).is_err());
    }

    #[test]
    fn trace_calls_bare_lists_and_can_filter_by_type() {
        let cli = parse(&["trace", "calls", "-n", "5", "--call-type", "heartbeat"]);
        let (name, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(name, "call_log");
        assert_eq!(arg(&args, "count"), 5);
        assert_eq!(arg(&args, "call_type"), "heartbeat");
    }

    #[test]
    fn trace_heartbeat_and_events_are_separate_views() {
        let (heartbeat, hb_args) =
            to_swp_command(&parse(&["trace", "heartbeat"]).command, None).unwrap();
        assert_eq!(heartbeat, "transcript");
        assert_eq!(arg(&hb_args, "source"), "heartbeat");

        let (events, _) = to_swp_command(&parse(&["trace", "events"]).command, None).unwrap();
        assert_eq!(events, "heartbeat_log");
    }

    #[test]
    fn compact_maps_to_compact_command() {
        let cmd = CliCommand::Compact {
            keep_turns: None,
            restart: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "compact");
        assert!(args.get("keep_turns").is_none());
        assert!(args.get("restart").is_none());
    }

    #[test]
    fn compact_with_keep_turns_includes_field() {
        let cmd = CliCommand::Compact {
            keep_turns: Some(0),
            restart: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "compact");
        assert_eq!(arg(&args, "keep_turns"), 0);
    }

    #[test]
    fn compact_restart_asks_the_daemon_to_start_over() {
        let cmd = CliCommand::Compact {
            keep_turns: Some(0),
            restart: true,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "compact");
        assert_eq!(arg(&args, "keep_turns"), 0);
        assert_eq!(arg(&args, "restart"), true);
    }

    #[test]
    fn all_non_message_commands_map() {
        let mut commands = log_status_debug_samples();
        commands.extend(model_samples());
        commands.extend(provider_memory_config_samples());
        for cmd in &commands {
            assert!(
                to_swp_command(cmd, None).is_some(),
                "expected Some for {cmd:?}"
            );
        }
    }

    fn log_status_debug_samples() -> Vec<CliCommand> {
        vec![
            CliCommand::Log {
                msg_ref: None,
                count: 20,
                role: None,
                follow: false,
                json: false,
                content: false,
                reasoning: false,
                tools: false,
                subagent_tools: false,
            },
            CliCommand::Edit {
                msg_ref: "m1".into(),
                content: vec!["text".into()],
                json: false,
            },
            CliCommand::Delete {
                msg_refs: vec!["m1".into()],
                json: false,
            },
            CliCommand::Log {
                msg_ref: Some("last".into()),
                count: 20,
                role: None,
                follow: false,
                json: false,
                content: false,
                reasoning: false,
                tools: false,
                subagent_tools: false,
            },
            CliCommand::Status {
                section: None,
                json: false,
            },
            CliCommand::Trace {
                subcommand: Some(TraceCommand::Errors {
                    count: 10,
                    json: false,
                }),
            },
            CliCommand::Debug {
                subcommand: Some(DebugCommand::TickNow),
            },
            CliCommand::Debug {
                subcommand: Some(DebugCommand::StatusDormant),
            },
            CliCommand::Debug {
                subcommand: Some(DebugCommand::StatusActive),
            },
        ]
    }

    fn model_samples() -> Vec<CliCommand> {
        vec![
            CliCommand::Model {
                subcommand: None,
                info: false,
                reset: false,
                all: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: Some(ModelCommand::Use {
                    name: "m".into(),
                    background: None,
                }),
                info: false,
                reset: false,
                all: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: Some(ModelCommand::Info {
                    name: Some("m".into()),
                }),
                info: false,
                reset: false,
                all: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: None,
                info: false,
                reset: true,
                all: false,
                json: false,
            },
            CliCommand::Model {
                subcommand: Some(ModelCommand::Setting {
                    key: None,
                    value: None,
                    global: false,
                    reset: false,
                    background: None,
                    subagent: None,
                    model: None,
                    json: false,
                }),
                info: false,
                reset: false,
                all: false,
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
                subcommand: Some(CharacterCommand::Info),
                info: false,
                json: false,
            },
            CliCommand::Compact {
                keep_turns: None,
                restart: false,
                json: false,
            },
            CliCommand::Config {
                subcommand: None,
                path: false,
                check: false,
                json: false,
                toml: false,
                all: false,
            },
        ]
    }

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

    #[test]
    fn usage_export_defaults_to_csv_and_switches_on_tsv() {
        let (_, csv) = to_swp_command(&parse(&["usage", "export"]).command, None).unwrap();
        assert_eq!(arg(&csv, "export_csv"), true);
        assert_eq!(arg(&csv, "export_tsv"), false);

        let (_, tsv) = to_swp_command(&parse(&["usage", "export", "--tsv"]).command, None).unwrap();
        assert_eq!(arg(&tsv, "export_csv"), false);
        assert_eq!(arg(&tsv, "export_tsv"), true);
    }

    #[test]
    fn usage_no_longer_offers_pricing_actions_the_daemon_handles() {
        for action in [
            vec!["usage", "recalculate"],
            vec!["usage", "refresh-pricing"],
        ] {
            assert!(
                Cli::try_parse_from(std::iter::once("shore").chain(action.iter().copied()))
                    .is_err(),
                "{action:?} must not be a command"
            );
        }
    }

    #[test]
    fn a_bare_usage_view_asks_for_no_action() {
        let (_, args) = to_swp_command(&parse(&["usage"]).command, None).unwrap();
        for action in ["export_csv", "export_tsv"] {
            assert_eq!(arg(&args, action), false, "{action} should be off");
        }
        assert!(arg(&args, "group_by").is_null());
    }

    #[test]
    fn the_character_filter_is_the_one_the_user_selected() {
        let (_, none) = to_swp_command(&parse(&["usage"]).command, None).unwrap();
        assert!(
            none.get("character")
                .is_some_and(serde_json::Value::is_null)
        );

        let (_, ada) = to_swp_command(&parse(&["usage"]).command, Some("ada")).unwrap();
        assert_eq!(arg(&ada, "character"), "ada");
    }

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
    fn usage_call_type_filter_requires_a_value() {
        assert!(Cli::try_parse_from(["shore", "usage", "--call-type"]).is_err());
    }

    #[test]
    fn parse_usage_call_type_with_value() {
        let cli = parse(&["usage", "--call-type", "message"]);
        assert_variant!(
            &cli.command,
            CliCommand::Usage { call_type, .. } => {
                assert_eq!(*call_type, Some("message".into()));
            }
        );
    }

    #[test]
    fn usage_last_hours_forwarded() {
        let cli = parse(&["usage", "--last", "4h"]);
        let (cmd, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(cmd, "usage");
        assert_eq!(arg(&args, "last"), "4h");
    }

    #[test]
    fn every_dimension_reaches_the_daemon_under_one_argument() {
        for (typed, wire) in [
            ("model", "model"),
            ("provider", "provider"),
            ("call-type", "call_type"),
            ("kind", "kind"),
            ("api-key", "api_key"),
        ] {
            let (cmd, args) =
                to_swp_command(&parse(&["usage", "by", typed]).command, None).unwrap();
            assert_eq!(cmd, "usage");
            assert_eq!(arg(&args, "group_by"), wire, "`usage by {typed}`");
        }
    }

    #[test]
    fn grouping_by_a_dimension_does_not_filter_by_it() {
        let (_, args) =
            to_swp_command(&parse(&["usage", "by", "call-type"]).command, None).unwrap();
        assert!(
            arg(&args, "call_type").is_null(),
            "`usage by call-type` groups, it does not filter",
        );

        let (_, filtered) = to_swp_command(
            &parse(&["usage", "by", "call-type", "--call-type", "message"]).command,
            None,
        )
        .unwrap();
        assert_eq!(arg(&filtered, "group_by"), "call_type");
        assert_eq!(arg(&filtered, "call_type"), "message");
    }

    #[test]
    fn usage_call_type_value_sets_filter_not_grouping() {
        let cli = parse(&["usage", "--call-type", "message"]);
        let (_cmd, args) = to_swp_command(&cli.command, None).unwrap();
        assert_eq!(arg(&args, "call_type"), "message");
        assert!(arg(&args, "group_by").is_null());
    }

    #[test]
    fn usage_views_are_subcommands() {
        let (_, budgets) = to_swp_command(&parse(&["usage", "budgets"]).command, None).unwrap();
        assert_eq!(arg(&budgets, "budget").as_bool(), Some(true));

        let (_, anomalies) = to_swp_command(&parse(&["usage", "anomalies"]).command, None).unwrap();
        assert_eq!(arg(&anomalies, "anomalies").as_bool(), Some(true));
    }

    #[test]
    fn completions_generates_output() {
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

    fn generated_for(shell: Shell) -> (String, String) {
        use clap::CommandFactory;
        let mut buf = Vec::new();
        clap_complete::generate(shell, &mut Cli::command(), "shore", &mut buf);
        let raw = String::from_utf8(buf).expect("utf8");
        let filtered = suppress_noise_completions(shell, &raw);
        (raw, filtered)
    }

    #[test]
    fn internal_helper_is_never_offered_as_a_command() {
        for shell in [Shell::Fish, Shell::Zsh] {
            let (raw, filtered) = generated_for(shell);
            assert!(
                raw.contains(INTERNAL_HELPER_HELP),
                "{shell:?} generator stopped emitting the helper; the filter may be stale"
            );
            assert!(
                !filtered.contains(INTERNAL_HELPER_HELP),
                "{shell:?} still offers the internal helper:\n{filtered}"
            );
            assert!(
                filtered.contains("usage"),
                "{shell:?} lost its real subcommands: {filtered}"
            );
        }

        let (raw, filtered) = generated_for(Shell::Bash);
        assert!(
            raw.contains("completions complete\""),
            "bash generator stopped listing the helper; the filter may be stale"
        );
        assert!(
            !filtered.contains("completions complete\""),
            "bash word list still ends in the internal helper: {filtered}"
        );
        assert!(
            filtered.contains("usage completions\""),
            "bash lost its real subcommands: {filtered}"
        );
    }

    #[test]
    fn superseded_flags_are_not_offered_by_the_shell() {
        for shell in [Shell::Fish, Shell::Zsh] {
            let (raw, filtered) = generated_for(shell);
            assert!(
                raw.contains(SUPERSEDED_HELP),
                "{shell:?} stopped emitting hidden flags; the filter may be stale"
            );
            assert!(
                !filtered.contains(SUPERSEDED_HELP),
                "{shell:?} still offers a superseded flag:\n{filtered}"
            );
            assert!(
                filtered.contains("model"),
                "{shell:?} lost its real commands"
            );
        }
    }

    #[test]
    fn leading_flags_are_offered_once_not_per_subcommand() {
        let (_, filtered) = generated_for(Shell::Fish);
        for flag in ["-l addr", "-l character"] {
            assert_eq!(
                filtered.matches(flag).count(),
                1,
                "{flag} should be offered before the command only:\n{filtered}"
            );
        }
    }

    #[test]
    fn fish_footer_has_dynamic_lines_for_model_and_character() {
        let footer = fish_dynamic_completions_footer();
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
        assert!(
            footer.contains("2>/dev/null"),
            "footer must swallow stderr from the helper",
        );
    }

    #[test]
    fn parse_complete_models() {
        let cli = parse(&["complete", "models"]);
        assert_variant!(
            &cli.command,
            CliCommand::Complete { kind, .. } => {
                assert_eq!(*kind, CompleteKind::Models);
            }
        );
    }

    #[test]
    fn parse_complete_characters() {
        let cli = parse(&["complete", "characters"]);
        assert_variant!(
            &cli.command,
            CliCommand::Complete { kind, .. } => {
                assert_eq!(*kind, CompleteKind::Characters);
            }
        );
    }

    #[test]
    fn complete_maps_to_none_swp() {
        let cmd = CliCommand::Complete {
            kind: CompleteKind::Models,
            arg: None,
        };
        assert!(
            to_swp_command(&cmd, None).is_none(),
            "complete is a client-side helper, not an SWP command",
        );
    }
}
