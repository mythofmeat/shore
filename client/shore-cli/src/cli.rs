use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum};
use clap_complete::Shell;
use shore_common::protocol::operations::{
    ActivateSession, BackgroundModelTarget, CallLogArgs, CancelCompaction, CheckConfiguration,
    ClearArgs, ClearConversation, CompactArgs, CompactConversation, ConfigArgs, Configuration,
    ConfigurationSchema, ConversationLog, ConversationLogArgs, DeleteMessages, DeleteMessagesArgs,
    DiagnosticCountArgs, EditMessage, EditMessageArgs, EmptyOperationArgs, ExecuteTool,
    FavoriteModel, FavoriteModelArgs, GetMessage, GetMessageArgs, InjectSystem, InjectSystemArgs,
    InspectCalls, InspectModel, InspectSegments, ListModels, ListModelsArgs, ListProviderModels,
    ListProviders, MessageReferences, ModelInfoArgs, ModelPreferenceScope, ModelSettings,
    ModelSettingsArgs, Operation, PingKeepalive, ProviderArgs, ProviderModelsArgs, ReadErrorLog,
    ReadHeartbeatLog, ReadStatus, ReadSubagentTraces, ReadTranscript, RefreshAllProviderModels,
    RefreshProviderModels, ResetModel, ResetModelArgs, RunToolArgs, ScheduleHeartbeat,
    SegmentAction, SegmentsArgs, SetHeartbeatActive, SetHeartbeatDormant, SetModelSetting,
    SetModelSettingArgs, SubagentTraceArgs, SwitchModel, SwitchModelArgs, ToolAccessListing,
    TranscriptArgs, TranscriptSource, WatchCompaction,
};
use shore_common::protocol::types::Role;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const LEADING_HEADING: &str = "Options — must come before the command";

#[derive(Parser, Debug)]
#[command(
    name = "shore",
    about = "Shore chat client",
    disable_help_subcommand = true,
    disable_version_flag = true
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

    /// Conversation thread to talk in (overrides SHORE_THREAD env var)
    #[arg(
        long,
        short = 't',
        env = "SHORE_THREAD",
        help_heading = LEADING_HEADING
    )]
    pub thread: Option<String>,

    /// TCP address of the daemon (overrides discovery)
    #[arg(long, env = "SHORE_ADDR", help_heading = LEADING_HEADING)]
    pub addr: Option<String>,

    /// Print version, plus the version of the daemon it connects to
    #[arg(short = 'V', long)]
    pub version: bool,

    #[command(subcommand)]
    pub command: Option<CliCommand>,
}

const LEADING_FLAGS: [(&str, &str); 5] = [
    ("--character", "--character"),
    ("-c", "--character"),
    ("--thread", "--thread"),
    ("-t", "--thread"),
    ("--addr", "--addr"),
];

const NAMED_BY_USE: [&str; 3] = ["model", "character", "thread"];

/// Words people reach for when the bare command is already the listing.
const LISTING_VERBS: [&str; 4] = ["list", "ls", "all", "show"];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FlagProblem {
    Misplaced(&'static str),
    BareName(&'static str, String),
    AlreadyLists(&'static str, String),
    NeedsEquals(&'static str, String),
}

const TARGET_TAKES_EQUALS: [(&str, &[&str]); 2] = [
    ("--background", &["all", "heartbeat", "compaction"]),
    ("--subagent", &["all"]),
];

fn target_taking_equals(spelled: &str) -> Option<&'static str> {
    TARGET_TAKES_EQUALS
        .iter()
        .find(|&&(flag, _)| flag == spelled)
        .map(|&(flag, _)| flag)
}

fn separated_target_value(flag: &str, token: &str) -> bool {
    TARGET_TAKES_EQUALS
        .iter()
        .any(|&(named, values)| named == flag && values.contains(&token))
}

fn separated_model_target(argv: &[String]) -> Option<FlagProblem> {
    let verb_index = argv.windows(2).position(|pair| {
        matches!(
            pair,
            [command, verb]
                if command == "model"
                    && matches!(verb.as_str(), "use" | "info" | "setting" | "reset")
        )
    })?;
    let verb = argv.get(verb_index.checked_add(1)?)?.as_str();
    let args = argv.get(verb_index.checked_add(2)?..)?;
    let mut separated = Vec::new();

    for pair in args.windows(2) {
        let [flag_token, value] = pair else {
            continue;
        };
        let Some(flag) = target_taking_equals(flag_token) else {
            continue;
        };
        if value.starts_with('-') {
            continue;
        }
        if separated_target_value(flag, value) {
            return Some(FlagProblem::NeedsEquals(flag, value.clone()));
        }
        separated.push((flag, value));
    }

    let mut skip_value = false;
    let mut positional_count: usize = 0;
    for token in args {
        if skip_value {
            skip_value = false;
            continue;
        }
        if token == "--model" {
            skip_value = true;
            continue;
        }
        if !token.starts_with('-') {
            positional_count = positional_count.checked_add(1)?;
        }
    }
    let max_positionals = match verb {
        "use" | "info" => 1,
        "setting" if args.iter().any(|arg| arg == "--reset") => 1,
        "setting" => 2,
        "reset" => 0,
        _ => return None,
    };
    if positional_count <= max_positionals {
        return None;
    }
    separated
        .into_iter()
        .next()
        .map(|(flag, value)| FlagProblem::NeedsEquals(flag, value.clone()))
}

fn leading_flag_named(spelled: &str) -> Option<&'static str> {
    LEADING_FLAGS
        .iter()
        .find(|&&(spelling, _)| spelling == spelled)
        .map(|&(_, canonical)| canonical)
}

pub(crate) fn flag_problem<I, S>(argv: I) -> Option<FlagProblem>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let collected_argv = argv
        .into_iter()
        .map(|arg| arg.as_ref().to_owned())
        .collect::<Vec<_>>();
    if let Some(problem) = separated_model_target(&collected_argv) {
        return Some(problem);
    }
    let mut words: Vec<String> = Vec::new();
    let mut flagged = false;
    let mut expecting_value = false;

    for token in collected_argv.iter().skip(1).map(String::as_str) {
        if token == "--" {
            break;
        }
        if expecting_value {
            expecting_value = false;
            continue;
        }
        let spelled = token.split('=').next().unwrap_or(token);
        if let Some(flag) = leading_flag_named(spelled) {
            if words.is_empty() {
                expecting_value = !token.contains('=');
                continue;
            }
            return Some(FlagProblem::Misplaced(flag));
        }
        if token.starts_with('-') {
            flagged = true;
        } else {
            words.push(token.to_owned());
        }
    }

    bare_name(&words, flagged)
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
    if LISTING_VERBS.contains(&name.as_str()) {
        return Some(FlagProblem::AlreadyLists(known, name.clone()));
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
        FlagProblem::BareName(command, ref name) => {
            crate::output::print_error(&format!("select a name with `shore {command} use`"));
            cli_err!();
            cli_err!("  shore {command} use {name}");
        }
        FlagProblem::AlreadyLists(command, ref name) => {
            crate::output::print_error(&format!(
                "`shore {command}` has no `{name}` — it is already the listing"
            ));
            cli_err!();
            cli_err!("  shore {command}");
        }
        FlagProblem::NeedsEquals(flag, ref value) => {
            crate::output::print_error(&format!("{flag} takes its value with an ="));
            cli_err!();
            cli_err!("  {flag}={value}");
            cli_err!();
            cli_err!("  bare {flag} means all of them");
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
    /// Send or change messages
    #[command(display_order = 1)]
    Msg {
        #[command(subcommand)]
        command: MsgCommand,
    },

    /// Show the conversation
    #[command(display_order = 9)]
    Log {
        /// Message reference — show a single message (last, -1, 3, etc.)
        #[arg(allow_hyphen_values = true, value_parser = message_ref)]
        msg_ref: Option<String>,

        /// Number of turns to show
        #[arg(short = 'n', long = "turns", alias = "count", default_value = "64")]
        count: u32,

        /// Read an archived segment instead of the current context
        #[arg(short = 's', long, conflicts_with_all = ["msg_ref", "follow"])]
        segment: Option<u32>,

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

    /// Summarize the conversation into memory and shorten the active window.
    /// The pass runs on the daemon and is shown live: its reasoning, tool
    /// calls and results. Ctrl-C only stops watching; the pass carries on.
    #[command(display_order = 2)]
    Compact {
        /// How many recent user turns to leave in the conversation. Everything
        /// older is folded into markdown memory. 0 keeps none of it, leaving
        /// only the prompt files and the memory index.
        #[arg(conflicts_with_all = ["watch", "cancel"])]
        keep_turns: Option<u32>,

        /// Throw away a paused checkpoint and summarize from scratch. Use this
        /// when a pass stopped partway — out of quota, provider down, memory
        /// files edited since — and `shore compact` keeps reporting paused. The
        /// memory it already wrote stays; those turns get summarized again.
        #[arg(long, conflicts_with_all = ["watch", "cancel"])]
        restart: bool,

        /// Write memory from an archived segment (see `shore segments`) as if it
        /// were being compacted now. The archive and the conversation are left
        /// as they are. Use it to redo a segment whose pass wrote nothing.
        #[arg(long, value_name = "INDEX", conflicts_with_all = ["keep_turns", "restart", "watch", "cancel"])]
        segment: Option<u64>,

        /// Follow the compaction already running, whoever started it, from what
        /// it has done so far to how it ends. With none running, show how the
        /// last pass ended.
        #[arg(long, conflicts_with = "cancel")]
        watch: bool,

        /// Stop the running compaction. It pauses with its checkpoint kept, so
        /// `shore compact` resumes it later.
        #[arg(long)]
        cancel: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Inspect or change archived conversation segments
    #[command(display_order = 3)]
    Segments {
        #[command(subcommand)]
        subcommand: Option<SegmentsCommand>,

        /// Output raw JSON
        #[arg(long, global = true)]
        json: bool,
    },

    /// Archive the active conversation without summarizing it into memory
    #[command(display_order = 3)]
    Clear {
        /// Exclude the new segment from history search immediately
        #[arg(long)]
        exclude: bool,

        /// Attach a note to the new segment
        #[arg(long)]
        note: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Inspect what the daemon did behind the conversation: raw model calls,
    /// heartbeat activity, stored sub-agent runs, and errors it hit.
    #[command(display_order = 10)]
    Trace {
        #[command(subcommand)]
        subcommand: Option<TraceCommand>,
    },

    /// List characters, or switch to another one
    #[command(display_order = 3)]
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

    /// List conversation threads, or switch to another one
    #[command(display_order = 4)]
    Thread {
        #[command(subcommand)]
        subcommand: Option<ThreadCommand>,

        /// Output raw JSON
        #[arg(long, global = true)]
        json: bool,
    },

    /// Download one character as an archive, or with --all keep a folder holding
    /// everything up to date, while Shore keeps running
    #[command(display_order = 9)]
    Export {
        /// Character to back up
        #[arg(required_unless_present = "all", conflicts_with = "all")]
        character: Option<String>,

        /// Back up every character and the global configuration into a folder;
        /// exporting into the same folder again only sends what changed
        #[arg(long)]
        all: bool,

        /// With --all, send everything again instead of only what changed
        #[arg(long, requires = "all")]
        full: bool,

        /// Where to save it on this machine (defaults to `<character>.shore.tar`,
        /// or the folder `shore-backup` with --all)
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Restore a character archive or a backup; existing characters and files are
    /// never overwritten
    #[command(display_order = 9)]
    Import {
        /// Archive or backup folder created by `shore export`, on this machine
        archive: PathBuf,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show daemon and session status
    #[command(display_order = 7)]
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
    #[command(display_order = 11)]
    Debug {
        #[command(subcommand)]
        subcommand: Option<DebugCommand>,
    },

    /// List models, switch the active one, or tune its sampler settings
    #[command(args_conflicts_with_subcommands = true)]
    #[command(display_order = 4)]
    Model {
        #[command(subcommand)]
        subcommand: Option<ModelCommand>,

        /// Include hidden discovered models in the list
        #[arg(long)]
        all: bool,

        /// List only favorited models
        #[arg(long, short = 'f', conflicts_with = "all")]
        favorites: bool,

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
    #[command(display_order = 5)]
    Provider {
        #[command(subcommand)]
        subcommand: Option<ProviderCommand>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show or modify configuration
    #[command(args_conflicts_with_subcommands = true)]
    #[command(display_order = 6)]
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
    #[command(display_order = 8)]
    Usage {
        #[command(subcommand)]
        subcommand: Option<UsageCommand>,

        /// Time period: "today", "week", "month", "all", or a count back like
        /// "4h", "7d", "2w", "1M". Defaults to the current budget window when
        /// a budget is configured, else today
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

    /// Turn a TUI display element on or off. Only meaningful inside `shore tui`
    ///
    /// Hidden from the terminal's help and shell completions because this
    /// process has no screen to change; `palette_command` un-hides it.
    #[command(hide = true)]
    View {
        /// Which display element to change
        key: ViewKey,

        /// New state. Defaults to `toggle`; `usage` and `budget` take their own
        /// values, which `shore complete view-values` lists
        value: Option<String>,
    },

    /// Drive the running TUI: scroll, panels, pickers, palettes. Only
    /// meaningful inside `shore tui`
    ///
    /// Hidden alongside `view`, and un-hidden the same way.
    #[command(hide = true)]
    Ui {
        #[command(subcommand)]
        command: UiCommand,
    },

    /// Generate shell completions
    #[command(display_order = 12)]
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

#[derive(Subcommand, Debug)]
pub(crate) enum MsgCommand {
    /// Send a message
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
    Regen {
        /// Ephemeral system guidance for this regeneration
        #[arg(short, long)]
        guidance: Option<String>,
    },

    /// List or select alternate responses for the latest assistant message
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

    /// Replace the content of a message (last, -1, 3, etc.)
    Edit {
        /// Message reference (last, -1, -2, 3, etc.)
        #[arg(allow_hyphen_values = true, value_parser = message_ref)]
        msg_ref: String,

        /// New content. Left off, the message opens in $EDITOR for you to
        /// rewrite; saving it unchanged or empty leaves the message alone
        content: Vec<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Remove one or more messages from the conversation
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
}

#[derive(Subcommand, Debug)]
pub(crate) enum SegmentsCommand {
    /// Show the messages stored in a segment
    Show { index: u32 },

    /// Exclude a segment from history search
    Exclude { index: u32 },

    /// Include a previously excluded segment in history search
    Include { index: u32 },

    /// Set a segment label, or omit LABEL to clear it
    Label { index: u32, label: Option<String> },

    /// Set a segment note, or omit NOTE to clear it
    Note { index: u32, note: Option<String> },
}

/// Display elements `shore view` can change. Every one of these persists into
/// the TUI's preferences file.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ViewKey {
    /// Message timestamps
    Timestamps,
    /// Reasoning and thinking blocks
    Thinking,
    /// Tool calls and their results
    Tools,
    /// Nested sub-agent tool activity
    Subagent,
    /// The compaction pass's own reasoning and tool calls
    Compaction,
    /// Inline images
    Images,
    /// Per-message metadata line
    Metadata,
    /// Token usage readout: off, always, warn, or toggle
    Usage,
    /// Budget readout: auto, cap, pace, a budget name, or toggle
    Budget,
}

impl ViewKey {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ViewKey::Timestamps => "timestamps",
            ViewKey::Thinking => "thinking",
            ViewKey::Tools => "tools",
            ViewKey::Subagent => "subagent",
            ViewKey::Compaction => "compaction",
            ViewKey::Images => "images",
            ViewKey::Metadata => "metadata",
            ViewKey::Usage => "usage",
            ViewKey::Budget => "budget",
        }
    }

    /// Values this key accepts, for completion and for the error text when a
    /// value does not parse. `budget` also takes any configured budget name,
    /// which only the running daemon knows.
    pub(crate) fn values(self) -> &'static [&'static str] {
        match self {
            ViewKey::Usage => &["off", "always", "warn", "toggle"],
            ViewKey::Budget => &["auto", "cap", "pace", "toggle"],
            ViewKey::Timestamps
            | ViewKey::Thinking
            | ViewKey::Tools
            | ViewKey::Subagent
            | ViewKey::Compaction
            | ViewKey::Images
            | ViewKey::Metadata => &["on", "off", "toggle"],
        }
    }
}

/// Actions that only exist while a TUI is on screen. These never reach the
/// daemon; `to_swp_command` returns `None` for all of them.
#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub(crate) enum UiCommand {
    /// Leave normal mode and start typing
    Insert {
        /// Put the cursor at the start of the input
        #[arg(long, conflicts_with = "end")]
        home: bool,

        /// Put the cursor at the end of the input
        #[arg(long)]
        end: bool,
    },

    /// Leave insert mode
    Normal,

    /// Move the transcript viewport
    Scroll {
        /// Which way to move
        direction: ScrollDirection,

        /// How many lines, for `up` and `down`. Defaults to 1
        amount: Option<u16>,
    },

    /// Show an archived conversation segment, or go back to the current context
    Segment {
        /// `older` or `newer` to step from what is shown, `current` to go
        /// back, or a segment number to jump to
        #[arg(value_parser = segment_target)]
        target: SegmentTarget,
    },

    /// Open the fullscreen image viewer on the nearest image
    Images,

    /// Open the sub-agent panel
    Subagents,

    /// Open the current input in $EDITOR
    Editor,

    /// Attach, paste, or drop images queued for the next message
    Image {
        /// `paste` to take one from the clipboard, `clear` to drop the queue, a
        /// file path to attach it, or nothing to open the picker. A file
        /// actually named `paste` or `clear` has to go through the picker
        target: Option<String>,
    },

    /// Stop the in-flight response, if there is one
    Cancel,

    /// Abandon a `msg edit` that is loaded in the input box, including one
    /// whose fetch is still in flight
    EditCancel,

    /// Show the key and command reference
    Help,

    /// Open a command palette
    Palette {
        /// Which palette to open
        scope: PaletteScope,
    },

    /// Reopen the output of the last command you ran
    Output,

    /// Bind a key to a command and save it to `tui.toml`
    ///
    /// The command is anything the `:` prompt takes, so `ui bind q "ui quit"`
    /// and typing `ui quit` do the same thing. Write modifiers as `ctrl+`,
    /// `alt+` and `shift+`; a shifted letter is just its capital.
    Bind {
        /// Key to bind, such as `q`, `ctrl+g` or `shift+f`
        key: String,

        /// Command to run, quoted if it has spaces
        #[arg(required = true, allow_hyphen_values = true)]
        command: Vec<String>,

        /// Bind in every mode, including while typing, rather than normal mode
        #[arg(long)]
        global: bool,
    },

    /// Remove a key binding and save `tui.toml`
    Unbind {
        /// Key to free up
        key: String,

        /// Free it from the every-mode bindings rather than normal mode
        #[arg(long)]
        global: bool,
    },

    /// Leave the TUI
    Quit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SegmentTarget {
    Older,
    Newer,
    Current,
    Index(u32),
}

fn segment_target(raw: &str) -> Result<SegmentTarget, String> {
    match raw {
        "older" => Ok(SegmentTarget::Older),
        "newer" => Ok(SegmentTarget::Newer),
        "current" => Ok(SegmentTarget::Current),
        number => number.parse().map(SegmentTarget::Index).map_err(|_| {
            format!("expected older, newer, current or a segment number, not {raw:?}")
        }),
    }
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScrollDirection {
    Up,
    Down,
    Top,
    Bottom,
}

#[derive(ValueEnum, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum PaletteScope {
    /// Every command, typed
    #[default]
    Full,
    /// The curated conversation shortcuts
    Shortcuts,
    /// The settings browser
    Config,
}

/// Targets for the hidden `__complete` helper.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompleteKind {
    /// Chat model names from the daemon's catalog
    Models,
    /// Discovered character names
    Characters,
    /// Threads belonging to the selected character
    Threads,
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
    /// Preset values advertised for the named model setting
    SettingValues,
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
    pub(crate) fn as_protocol_target(self) -> BackgroundModelTarget {
        match self {
            Self::All => BackgroundModelTarget::All,
            Self::Heartbeat => BackgroundModelTarget::Heartbeat,
            Self::Compaction => BackgroundModelTarget::Compaction,
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
    pub(crate) fn as_protocol_role(self) -> Role {
        match self {
            Self::User => Role::User,
            Self::Assistant | Self::Character => Role::Assistant,
            Self::System => Role::System,
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
    CostSource,
}

impl UsageDimension {
    fn wire(self) -> shore_common::protocol::operations::UsageDimension {
        use shore_common::protocol::operations::UsageDimension as CanonicalDimension;
        match self {
            Self::Model => CanonicalDimension::Model,
            Self::Provider => CanonicalDimension::Provider,
            Self::CallType => CanonicalDimension::CallType,
            Self::Kind => CanonicalDimension::Kind,
            Self::ApiKey => CanonicalDimension::ApiKey,
            Self::CostSource => CanonicalDimension::CostSource,
        }
    }
}

#[derive(Subcommand, Debug)]
pub(crate) enum UsageCommand {
    /// Group spend by a dimension: model, provider, call-type, kind, api-key, cost-source
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

        /// Filter by ledger call type, or require that type when dumping an id
        #[arg(long)]
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

#[derive(Args, Debug, Clone, Default)]
pub(crate) struct ModelTarget {
    /// The chat model. This is the default, so the flag is only ever needed to
    /// say "chat and nothing else"
    #[arg(long)]
    pub(crate) chat: bool,

    /// Background tasks: bare means all; naming one requires =compaction or =heartbeat
    #[arg(
        long,
        value_enum,
        num_args = 0..=1,
        require_equals = true,
        default_missing_value = "all",
        conflicts_with = "chat"
    )]
    pub(crate) background: Option<BackgroundTarget>,

    /// Sub-agents: bare means all; naming one requires `--subagent=<name>`
    #[arg(
        long,
        num_args = 0..=1,
        require_equals = true,
        default_missing_value = "all",
        conflicts_with_all = ["chat", "background"]
    )]
    pub(crate) subagent: Option<String>,
}

impl ModelTarget {
    pub(crate) fn is_bare(&self) -> bool {
        !self.chat && self.background.is_none() && self.subagent.is_none()
    }

    pub(crate) fn operation_args(&self) -> ModelInfoArgs {
        ModelInfoArgs {
            name: None,
            background_task: self.background.map(BackgroundTarget::as_protocol_target),
            subagent: self.subagent.clone(),
        }
    }
}

#[derive(Subcommand, Debug)]
pub(crate) enum ModelCommand {
    /// Switch the model something runs on
    ///
    /// Spell out `use` when a model's name would otherwise read as one of
    /// these subcommands. An unknown name is an error, never a fallback.
    ///
    /// Bare, this pins the chat model for the current thread until changed or reset.
    /// Every other target writes the config file,
    /// which is global: `--background=<task>` writes `<task>.model`,
    /// bare `--background` writes both `heartbeat.model` and `compaction.model`; `--subagent=<name>` writes `subagents.<name>.model`,
    /// and bare `--subagent` writes `subagents.model`.
    Use {
        /// Model name or provider:model_id
        name: String,

        #[command(flatten)]
        target: ModelTarget,
    },

    /// Describe a model: provider, sdk, limits, and where it resolves from
    ///
    /// Bare, describes the active chat model. A target flag describes whatever
    /// that role currently resolves to, which is the quick way to answer "what
    /// is compaction actually running on".
    Info {
        /// Model to describe. Omit for the active one, or for the targeted role
        name: Option<String>,

        #[command(flatten)]
        target: ModelTarget,
    },

    /// Show, set, or clear saved sampler settings
    ///
    /// Bare and with no key, this is the overview: every role whose model or
    /// settings are its own rather than inherited, in one place. Add a target
    /// flag to see just that one. With a key and a value it saves; with
    /// --reset and a key it clears. Clearing everything at once is not
    /// supported — name the key.
    ///
    /// A sub-agent's settings are its own: they start from its model's catalog
    /// entry and take nothing from the chat model's settings, so tuning chat
    /// never moves a sub-agent.
    ///
    /// Bare --subagent writes once against the model your sub-agents share,
    /// covering all of them; it errors if they are not all on one model. A
    /// named sub-agent overrides that shared value. Because the shared value
    /// belongs to the model, changing subagents.model picks up that model's
    /// settings rather than carrying the old ones over.
    ///
    /// The keys are temperature, top_p, reasoning_effort, reasoning_budget_tokens,
    /// max_output_tokens, cache_ttl, cache_keepalive, cache_keepalive_pings, sdk,
    /// reasoning_replay and max_tool_rounds.
    ///
    /// cache_keepalive is the interval between cache keepalive pings, or off.
    /// Any model can have one. After each reply, the model gets
    /// cache_keepalive_pings pings (default 1) spaced by that interval; the
    /// next message starts the count over. Only the model you are chatting
    /// with is pinged.
    ///
    /// sdk takes anthropic, openai, openrouter, gemini, zai, deepseek or
    /// moonshot, which forces a wire shape on a discovered model whose
    /// provider catalog labelled it wrong.
    ///
    /// The vendor knobs openrouter_routing, gemini_thinking_mode and
    /// zai_clear_reasoning are settable per model too. A
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

        #[command(flatten)]
        target: ModelTarget,

        /// Tune a named model without switching to it
        #[arg(long, conflicts_with_all = ["chat", "background", "subagent"])]
        model: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Mark a model as a favorite so it sorts to the top of every list
    ///
    /// Favorites are global, not per-character, and are stored in the
    /// preferences file rather than the config file, so marking one never
    /// rewrites hand-maintained config. A favorited model stays listed even
    /// when a `discovery.ignore` glob would otherwise hide it.
    Fav {
        /// Model name or provider:model_id
        name: String,
    },

    /// Drop a model's favorite mark
    Unfav {
        /// Model name or provider:model_id
        name: String,
    },

    /// Drop a saved selection and fall back to what it would inherit
    ///
    /// Bare, this clears the thread's pin to inherit the character default. Other targets clear
    /// the config keys `use` would have written, so the role falls back the
    /// way it did before anything was pinned. Bare --background clears both
    /// task model keys; bare --subagent clears subagents.model
    /// and every per-sub-agent override.
    Reset {
        #[command(flatten)]
        target: ModelTarget,
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

    /// Delete a character for good: its workspace (SOUL.md and memory), its
    /// config, its threads and data, its search indexes, and its rows in the
    /// history and usage databases. Nothing is recoverable afterwards unless
    /// you pass --archive.
    #[command(verbatim_doc_comment)]
    Delete {
        /// Character name
        name: String,

        /// Download a backup to this path before deleting
        #[arg(long, value_name = "PATH")]
        archive: Option<PathBuf>,

        /// Delete without the confirmation prompt
        #[arg(short = 'y', long)]
        yes: bool,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ThreadCommand {
    /// Talk in another thread. Unknown names are an error, never a fallback
    Use {
        /// Thread id
        name: String,
    },

    /// Start a new thread. It begins empty and does not compact on a schedule
    New {
        /// Thread id: letters, digits, dot, dash or underscore
        name: String,

        /// Human-readable label
        #[arg(long)]
        label: Option<String>,

        /// What the thread is for, in a line or two; the character sees it in this thread's prompt
        #[arg(long)]
        purpose: Option<String>,

        /// Workspace file to keep in this thread's prompt, like a story's notes, as a path or a [[link]]; repeat for more
        #[arg(long = "file", value_name = "PATH")]
        files: Vec<String>,

        /// Chat model for this thread alone
        #[arg(long)]
        model: Option<String>,

        /// Let the idle timer compact this thread, as it does the home thread
        #[arg(long)]
        compaction: bool,
    },

    /// Set or clear a thread's label
    Label {
        /// Thread id
        name: String,

        /// New label; omit to clear it
        label: Option<String>,
    },

    /// Set or clear what a thread is for. The character sees it in that thread's prompt
    Purpose {
        /// Thread id
        name: String,

        /// A line or two; omit to clear it
        purpose: Option<String>,
    },

    /// Set the workspace files kept in a thread's prompt, next to MEMORY.md
    Files {
        /// Thread id
        name: String,

        /// Paths relative to the workspace root or [[links]], like [[notes]] or [[lighthouse/]]; omit all to clear the list
        files: Vec<String>,
    },

    /// Pin a thread to its own chat model, or clear the pin to inherit the character's
    #[command(hide = true)]
    Model {
        /// Thread id
        name: String,

        /// Model to pin, as `provider:model_id`; omit to clear the pin
        model: Option<String>,
    },

    /// Point the heartbeat at a thread. This is where unprompted messages arrive
    Home {
        /// Thread id
        name: String,
    },

    /// Retire a thread: its messages go to the archive and stay searchable
    Archive {
        /// Thread id
        name: String,
    },

    /// Branch a thread: the new one starts with a snapshot of the source's context
    ///
    /// The copy is independent from the moment it is made: later edits,
    /// regeneration, compaction or retirement on either side leave the other
    /// alone. Both threads keep the whole transcript, and a message copied by a
    /// fork is one conversation event in two places, so recall shows it once and
    /// memory processing runs over it once.
    Fork {
        /// Thread id for the new thread: letters, digits, dot, dash or underscore
        name: String,

        /// Thread to copy from; defaults to the one you are talking in
        #[arg(long)]
        from: Option<String>,

        /// Copy only the last N of your turns, with their whole tool exchanges.
        /// Omit to copy the complete active context
        #[arg(long)]
        turns: Option<u32>,
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
    /// `shore config get chat.model`
    /// `shore config get compaction`
    #[command(verbatim_doc_comment)]
    Get {
        /// Dotted key, e.g. heartbeat.enabled, daemon.listen_addr, mcp.beets.command
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
    /// under `[daemon]`, `[notifications]` and `[matrix]` need a daemon
    /// restart to take effect; `set` says so when you touch one.
    ///
    /// `shore config set chat.model anthropic:claude-opus-4-5`
    /// `shore config set compaction.idle_after 2h`
    /// `shore config set tools.enabled bash,search`
    #[command(verbatim_doc_comment)]
    Set {
        /// Dotted key, e.g. heartbeat.enabled, compaction.idle_after
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
    /// with `config get tools.enabled`.
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
    /// truncated to the configured window. Side effects are real — `bash`
    /// runs commands on the daemon host, `ask_<agent>` spends tokens.
    ///
    /// `shore debug tool bash "command=cat notes.md"`
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
        input: Option<BTreeMap<String, serde_json::Value>>,

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

fn parse_json_object(raw: &str) -> Result<BTreeMap<String, serde_json::Value>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("not valid JSON: {e}"))?;
    if value.is_object() {
        serde_json::from_value(value).map_err(|error| error.to_string())
    } else {
        Err("must be a JSON object, e.g. '{\"path\":\"notes.md\"}'".to_owned())
    }
}

const COMMAND_GROUPS: [(&str, &[&str]); 6] = [
    ("Conversation", &["msg", "log"]),
    (
        "Maintenance",
        &["compact", "clear", "segments", "export", "import"],
    ),
    (
        "Configuration",
        &["character", "thread", "model", "provider", "config"],
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PaletteValue {
    pub value: String,
    pub help: Option<String>,
}

impl PaletteValue {
    pub(crate) fn plain(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            help: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PaletteCatalog {
    pub models: Vec<PaletteValue>,
    pub characters: Vec<PaletteValue>,
    pub threads: Vec<PaletteValue>,
    pub providers: Vec<PaletteValue>,
    pub status_sections: Vec<PaletteValue>,
    pub tools: Vec<PaletteValue>,
    pub subagents: Vec<PaletteValue>,
    pub setting_keys: Vec<PaletteValue>,
    pub setting_values: BTreeMap<String, Vec<PaletteValue>>,
    pub message_refs: Vec<PaletteValue>,
    pub config_keys: Vec<PaletteValue>,
    pub config_sections: Vec<PaletteValue>,
    pub config_schema: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PaletteCandidate {
    pub replacement: String,
    pub help: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PaletteCompletions {
    pub candidates: Vec<PaletteCandidate>,
    pub header: Option<String>,
}

fn completion_values(values: &[PaletteValue]) -> clap_complete::engine::ArgValueCandidates {
    use clap_complete::engine::{ArgValueCandidates, CompletionCandidate};

    let owned_values = values.to_vec();
    ArgValueCandidates::new(move || {
        owned_values
            .iter()
            .map(|candidate| {
                CompletionCandidate::new(&candidate.value).help(
                    candidate
                        .help
                        .as_ref()
                        .map(|help| clap::builder::StyledStr::from(help.clone())),
                )
            })
            .collect()
    })
}

fn with_palette_values(
    command: clap::Command,
    arg: &str,
    values: &[PaletteValue],
) -> clap::Command {
    let candidates = completion_values(values);
    let index = command
        .get_arguments()
        .find(|argument| argument.get_id() == arg)
        .and_then(clap::Arg::get_index);
    command.mut_arg(arg, move |argument| {
        let updated_argument = argument.add(candidates.clone());
        match index {
            Some(position) => updated_argument.index(position),
            None => updated_argument,
        }
    })
}

fn palette_command(catalog: &PaletteCatalog, input: &str) -> clap::Command {
    use clap::CommandFactory;

    let config_value_key = shlex::split(input).and_then(|words| {
        (words.first().map(String::as_str) == Some("config")
            && words.get(1).map(String::as_str) == Some("set"))
        .then(|| words.get(2).cloned())
        .flatten()
    });
    let config_values = config_value_key
        .as_deref()
        .zip(catalog.config_schema.as_ref())
        .map_or_else(Vec::new, |(key, data)| {
            crate::run::config_value_candidates_for_key(key, data)
                .into_iter()
                .map(PaletteValue::plain)
                .collect()
        });
    let setting_values = shlex::split(input)
        .and_then(|words| {
            (words.first().map(String::as_str) == Some("model")
                && words.get(1).map(String::as_str) == Some("setting"))
            .then(|| words.get(2).cloned())
            .flatten()
        })
        .and_then(|key| catalog.setting_values.get(&key).cloned())
        .unwrap_or_default();

    let model_values = catalog.models.clone();
    let subagent_values = catalog.subagents.clone();
    let message_refs = catalog.message_refs.clone();
    let mut command = Cli::command();
    command.build();
    command = command
        .mut_arg("character", |argument| argument.hide(true))
        .mut_arg("addr", |argument| argument.hide(true))
        .mut_arg("help", |argument| argument.hide(true))
        .mut_arg("version", |argument| argument.hide(true))
        .mut_subcommand("completions", |subcommand| subcommand.hide(true))
        .mut_subcommand("view", |subcommand| subcommand.hide(false))
        .mut_subcommand("ui", |subcommand| subcommand.hide(false))
        .mut_subcommand("model", |subcommand| {
            subcommand
                .mut_subcommand("use", |leaf| {
                    with_palette_values(
                        with_palette_values(leaf, "subagent", &subagent_values),
                        "name",
                        &model_values,
                    )
                })
                .mut_subcommand("info", |leaf| {
                    with_palette_values(
                        with_palette_values(leaf, "subagent", &subagent_values),
                        "name",
                        &model_values,
                    )
                })
                .mut_subcommand("setting", |leaf| {
                    with_palette_values(
                        with_palette_values(
                            with_palette_values(
                                with_palette_values(leaf, "subagent", &subagent_values),
                                "model",
                                &model_values,
                            ),
                            "key",
                            &catalog.setting_keys,
                        ),
                        "value",
                        &setting_values,
                    )
                })
                .mut_subcommand("reset", |leaf| {
                    with_palette_values(leaf, "subagent", &subagent_values)
                })
                .mut_subcommand("fav", |leaf| {
                    with_palette_values(leaf, "name", &model_values)
                })
                .mut_subcommand("unfav", |leaf| {
                    with_palette_values(leaf, "name", &model_values)
                })
        })
        .mut_subcommand("thread", |mut subcommand| {
            for name in [
                "use", "label", "purpose", "files", "home", "archive", "model",
            ] {
                subcommand = subcommand.mut_subcommand(name, |leaf| {
                    with_palette_values(leaf, "name", &catalog.threads)
                });
            }
            subcommand
                .mut_subcommand("fork", |leaf| {
                    with_palette_values(leaf, "from", &catalog.threads)
                })
                .mut_subcommand("new", |leaf| {
                    with_palette_values(leaf, "model", &model_values)
                })
                .mut_subcommand("model", |leaf| {
                    with_palette_values(leaf, "model", &model_values)
                })
        })
        .mut_subcommand("character", |mut subcommand| {
            for name in ["use", "delete"] {
                subcommand = subcommand.mut_subcommand(name, |leaf| {
                    with_palette_values(leaf, "name", &catalog.characters)
                });
            }
            subcommand
        })
        .mut_subcommand("msg", |subcommand| {
            subcommand
                .mut_subcommand("alt", |leaf| {
                    let selectors = ["list", "prev", "next", "first", "last", "1", "2", "3"]
                        .into_iter()
                        .map(PaletteValue::plain)
                        .collect::<Vec<_>>();
                    with_palette_values(
                        with_palette_values(leaf, "selector", &selectors),
                        "msg_ref",
                        &message_refs,
                    )
                })
                .mut_subcommand("edit", |leaf| {
                    with_palette_values(leaf, "msg_ref", &message_refs)
                })
                .mut_subcommand("delete", |leaf| {
                    with_palette_values(leaf, "msg_refs", &message_refs)
                })
        })
        .mut_subcommand("log", |leaf| {
            with_palette_values(leaf, "msg_ref", &message_refs)
        })
        .mut_subcommand("provider", |subcommand| {
            subcommand
                .mut_subcommand("models", |leaf| {
                    with_palette_values(leaf, "name", &catalog.providers)
                })
                .mut_subcommand("refresh", |leaf| {
                    with_palette_values(leaf, "name", &catalog.providers)
                })
        })
        .mut_subcommand("status", |leaf| {
            with_palette_values(leaf, "section", &catalog.status_sections)
        })
        .mut_subcommand("debug", |subcommand| {
            subcommand
                .mut_subcommand("tool", |leaf| {
                    with_palette_values(leaf, "name", &catalog.tools)
                })
                .mut_subcommand("subagent", |leaf| {
                    with_palette_values(leaf, "name", &catalog.subagents)
                })
        })
        .mut_subcommand("config", |subcommand| {
            subcommand
                .mut_subcommand("get", |leaf| {
                    with_palette_values(leaf, "key", &catalog.config_sections)
                })
                .mut_subcommand("set", |leaf| {
                    with_palette_values(
                        with_palette_values(leaf, "key", &catalog.config_keys),
                        "value",
                        &config_values,
                    )
                })
        });

    for local in [
        clap::Command::new("cancel").about("Stop the current generation"),
        clap::Command::new("help").about("Show TUI keyboard shortcuts"),
        clap::Command::new("image")
            .about("Manage images attached to the next message")
            .subcommand(clap::Command::new("clear").about("Remove pending image attachments")),
        clap::Command::new("view")
            .about("Configure TUI display options")
            .arg(
                clap::Arg::new("option")
                    .value_parser([
                        "timestamps",
                        "thinking",
                        "tools",
                        "subagent",
                        "images",
                        "metadata",
                        "usage",
                        "budget",
                    ])
                    .help("Display option to change"),
            )
            .arg(
                clap::Arg::new("value")
                    .value_parser([
                        "on", "off", "toggle", "always", "warn", "auto", "cap", "pace",
                    ])
                    .help("New display value"),
            ),
    ] {
        command = command.subcommand(local);
    }
    command
}

fn completion_argv(input: &str) -> (Vec<std::ffi::OsString>, usize) {
    let trailing_space = input.chars().last().is_some_and(char::is_whitespace);
    let mut words = shlex::split(input).unwrap_or_else(|| {
        input
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    if trailing_space || words.is_empty() {
        words.push(String::new());
    }
    let mut argv = vec![std::ffi::OsString::from("shore")];
    argv.extend(words.into_iter().map(std::ffi::OsString::from));
    let target = argv.len().saturating_sub(1);
    (argv, target)
}

fn completion_prefix(input: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    let mut start = 0;
    for (index, ch) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if quote != Some('\'') => escaped = true,
            '\'' | '"' if quote == Some(ch) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            _ if ch.is_whitespace() && quote.is_none() => {
                start = index.saturating_add(ch.len_utf8());
            }
            _ => {}
        }
    }
    input.get(..start).unwrap_or_default()
}

/// Complete the TUI command line with clap's shell-independent engine.
///
/// Clap remains the grammar authority while the live catalog supplies values
/// that only the connected daemon knows about.
pub(crate) fn palette_completions(input: &str, catalog: &PaletteCatalog) -> PaletteCompletions {
    let (argv, target) = completion_argv(input);
    let prefix = completion_prefix(input);
    let mut command = palette_command(catalog, input);
    let Ok(raw) = clap_complete::engine::complete(&mut command, argv, target, None) else {
        return PaletteCompletions::default();
    };

    let mut candidates = raw
        .into_iter()
        .filter_map(|candidate| {
            let value = candidate.get_value().to_str()?;
            if matches!(value, "-h" | "--help" | "-V" | "--version") {
                return None;
            }
            let quoted = shlex::try_quote(value).ok()?;
            Some(PaletteCandidate {
                replacement: format!("{prefix}{quoted}"),
                help: candidate.get_help().map(ToString::to_string),
            })
        })
        .collect::<Vec<_>>();
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.replacement.clone()));

    PaletteCompletions {
        header: (!candidates.is_empty()).then(|| "command, option, or value".to_owned()),
        candidates,
    }
}

/// Whether `input` is a whole command or only the start of one.
///
/// A `/` shortcut is allowed to name a command that still needs an argument,
/// like `msg edit`: choosing it should load the line for the user to finish.
/// A command that is simply wrong is still an error.
pub(crate) fn palette_command_needs_more_input(input: &str) -> Result<bool, String> {
    let Some(words) = shlex::split(input) else {
        return Err("unclosed quote in command".to_owned());
    };
    let argv = std::iter::once("shore".to_owned())
        .chain(words)
        .collect::<Vec<_>>();
    if let Some(problem) = flag_problem(&argv)
        && let Some(message) = target_problem_message(&problem)
    {
        return Err(message);
    }
    match Cli::try_parse_from(argv) {
        Ok(parsed) => {
            if parsed.command.is_some() {
                Ok(false)
            } else {
                Err("missing command".to_owned())
            }
        }
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::MissingRequiredArgument
                    | clap::error::ErrorKind::MissingSubcommand
            ) =>
        {
            Ok(true)
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn parse_palette_command(input: &str) -> Result<CliCommand, String> {
    let Some(words) = shlex::split(input) else {
        return Err("unclosed quote in command".to_owned());
    };
    let argv = std::iter::once("shore".to_owned())
        .chain(words)
        .collect::<Vec<_>>();
    if let Some(problem) = flag_problem(&argv)
        && let Some(message) = target_problem_message(&problem)
    {
        return Err(message);
    }
    let matches = Cli::command()
        .try_get_matches_from(argv)
        .map_err(|error| error.to_string())?;
    if ["addr", "character", "thread"]
        .iter()
        .any(|name| matches.value_source(name) == Some(clap::parser::ValueSource::CommandLine))
    {
        return Err("the TUI is already attached to a daemon and conversation; use `character use` or `thread use` to switch".to_owned());
    }
    let parsed = Cli::from_arg_matches(&matches).map_err(|error| error.to_string())?;
    parsed.command.ok_or_else(|| "missing command".to_owned())
}

fn target_problem_message(problem: &FlagProblem) -> Option<String> {
    let FlagProblem::NeedsEquals(flag, value) = problem else {
        return None;
    };
    Some(format!(
        "{flag} takes its value with an =; write {flag}={value}. Bare {flag} means all of them"
    ))
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
    cmd.override_usage("shore [OPTIONS] [COMMAND]")
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

/// Marks `view` and `ui` in generated help text. Both parse everywhere so the
/// TUI can bind keys to them, but neither does anything in a terminal.
const TUI_ONLY_HELP: &str = "Only meaningful inside";

/// Commands a shell must never offer: clap's own completion helper, plus the
/// two that need a running TUI.
const NOISE_COMMANDS: [&str; 3] = ["complete", "view", "ui"];

pub(crate) fn suppress_noise_completions(shell: Shell, script: &str) -> String {
    let mut out = String::with_capacity(script.len());
    let mut skipping_fish_target = false;
    for line in script.lines() {
        if skipping_fish_target {
            if line.matches('"').count() % 2 == 1 {
                skipping_fish_target = false;
            }
            continue;
        }
        let fish_optional_target = shell == Shell::Fish
            && line.contains("__fish_shore_using_subcommand model")
            && (line.contains(" -l background ") || line.contains(" -l subagent "));
        if fish_optional_target {
            skipping_fish_target = line.matches('"').count() % 2 == 1;
            continue;
        }
        if line.contains(INTERNAL_HELPER_HELP)
            || line.contains(SUPERSEDED_HELP)
            || line.contains(TUI_ONLY_HELP)
        {
            continue;
        }
        if shell == Shell::Bash && line.trim_start().starts_with("opts=") {
            out.push_str(&strip_noise_words(line));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

/// Drop the noise commands from one bash `opts="…"` word list.
///
/// Fish and zsh put each command on its own line next to its help text, so the
/// filter above can recognise them. Bash emits a flat list of bare words with no
/// help and no fixed order, so the only handle left is the name itself.
fn strip_noise_words(line: &str) -> String {
    let Some((head, rest)) = line.split_once('"') else {
        return line.to_owned();
    };
    let Some((words, tail)) = rest.rsplit_once('"') else {
        return line.to_owned();
    };
    let kept = words
        .split_whitespace()
        .filter(|word| !NOISE_COMMANDS.contains(word))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{head}\"{kept}\"{tail}")
}

pub(crate) fn fish_dynamic_completions_footer() -> &'static str {
    "\n\
# ── Dynamic completions (populated by the daemon) ────────────────────\n\
complete -c shore -l thread -r -f -a \"(shore complete threads 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand thread; and __fish_seen_subcommand_from use label home archive\" -f -a \"(shore complete threads 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand thread; and __fish_seen_subcommand_from fork\" -l from -r -f -a \"(shore complete threads 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand thread; and __fish_seen_subcommand_from new\" -l model -r -f -a \"(shore complete models 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from use info\" -f -a \"(shore complete models 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand character; and __fish_seen_subcommand_from use delete\" -f -a \"(shore complete characters 2>/dev/null)\"\n\
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
        if contains -- $token --model\n\
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
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from setting; and __shore_setting_key\" -f -a \"(shore complete setting-values (__shore_setting_key) 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from use setting reset info; and string match -q -- '--b*' (commandline -ct)\" -f -a \"--background --background=all --background=heartbeat --background=compaction\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from use setting reset info; and string match -q -- '--s*' (commandline -ct)\" -f -a \"--subagent\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from use setting reset info; and string match -q -- '--s*' (commandline -ct)\" -f -a \"(shore complete subagents 2>/dev/null | string replace -r -- '^' '--subagent=')\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from setting\" -l model -r -f -a \"(shore complete models 2>/dev/null)\"\n\
complete -c shore -n \"__fish_shore_using_subcommand model; and __fish_seen_subcommand_from fav unfav\" -f -a \"(shore complete models 2>/dev/null)\"\n\
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

fn parse_setting_value(_key: &str, raw: &str) -> serde_json::Value {
    serde_json::Value::String(raw.trim().to_owned())
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
        CliCommand::Completions { .. }
        | CliCommand::Complete { .. }
        | CliCommand::View { .. }
        | CliCommand::Ui { .. }
        | CliCommand::Config {
            path: true,
            check: false,
            ..
        }
        | CliCommand::Config {
            subcommand: Some(ConfigCommand::Reload { .. }),
            ..
        } => None,

        CliCommand::Msg { command } => msg_to_swp(command),

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

        CliCommand::Thread {
            subcommand: None, ..
        } => Some(("list_threads", json!({}))),
        CliCommand::Thread {
            subcommand: Some(subcommand),
            ..
        } => match subcommand {
            ThreadCommand::Use { name } => Some(("switch_thread", json!({ "name": name }))),
            ThreadCommand::New {
                name,
                label,
                purpose,
                files,
                model,
                compaction,
            } => {
                let mut args = json!({
                    "name": name,
                    "label": label,
                    "model": model,
                    "compaction": compaction,
                });
                if let Some(map) = args.as_object_mut() {
                    if let Some(text) = purpose {
                        let _previous = map.insert("purpose".into(), json!(text));
                    }
                    if !files.is_empty() {
                        let _previous = map.insert("files".into(), json!(files));
                    }
                }
                Some(("create_thread", args))
            }
            ThreadCommand::Label { name, label } => {
                Some(("thread_label", json!({ "name": name, "label": label })))
            }
            ThreadCommand::Purpose { name, purpose } => Some((
                "thread_purpose",
                json!({ "name": name, "purpose": purpose }),
            )),
            ThreadCommand::Files { name, files } => {
                Some(("thread_files", json!({ "name": name, "files": files })))
            }
            ThreadCommand::Model { name, model } => {
                Some(("thread_model", json!({ "name": name, "model": model })))
            }
            ThreadCommand::Home { name } => Some(("thread_home", json!({ "name": name }))),
            ThreadCommand::Archive { name } => Some(("archive_thread", json!({ "name": name }))),
            ThreadCommand::Fork { name, from, turns } => Some((
                "fork_thread",
                json!({ "name": name, "from": from, "turns": turns }),
            )),
        },

        CliCommand::Export { .. } | CliCommand::Import { .. } => None,

        CliCommand::Log { .. } => log_to_swp(cmd),
        CliCommand::Trace { subcommand: None } => None,
        CliCommand::Trace { .. } => trace_to_swp(cmd),

        CliCommand::Status { .. } => operation_to_swp::<ReadStatus>(EmptyOperationArgs {}),

        CliCommand::Debug { subcommand: None } => None,
        CliCommand::Debug {
            subcommand: Some(subcommand),
        } => match subcommand {
            DebugCommand::TickNow => operation_to_swp::<ScheduleHeartbeat>(EmptyOperationArgs {}),
            DebugCommand::StatusDormant => {
                operation_to_swp::<SetHeartbeatDormant>(EmptyOperationArgs {})
            }
            DebugCommand::StatusActive => {
                operation_to_swp::<SetHeartbeatActive>(EmptyOperationArgs {})
            }
            DebugCommand::KeepalivePingNow => {
                operation_to_swp::<PingKeepalive>(EmptyOperationArgs {})
            }
            DebugCommand::SessionActivate => {
                operation_to_swp::<ActivateSession>(EmptyOperationArgs {})
            }
            DebugCommand::Tool {
                name,
                args,
                input,
                raw,
                describe,
                ..
            } => operation_to_swp::<ExecuteTool>(RunToolArgs {
                tool: name.clone(),
                input: Some(input.clone().unwrap_or_default()),
                pairs: Some(args.iter().cloned().collect()),
                raw: Some(*raw),
                describe: Some(*describe),
            }),
            DebugCommand::Subagent {
                name, query, raw, ..
            } => operation_to_swp::<ExecuteTool>(RunToolArgs {
                tool: format!("ask_{name}"),
                input: Some(BTreeMap::from([(
                    "query".to_owned(),
                    json!(query.join(" ")),
                )])),
                pairs: Some(BTreeMap::new()),
                raw: Some(*raw),
                describe: None,
            }),
        },

        CliCommand::Model { .. } => model_to_swp(cmd),

        CliCommand::Provider { .. } => provider_to_swp(cmd),

        CliCommand::Compact { .. } => compact_to_swp(cmd),

        CliCommand::Segments { subcommand, .. } => {
            let (action, segment_index, field_value) = match subcommand {
                None => (SegmentAction::List, None, None),
                Some(SegmentsCommand::Show { index }) => (SegmentAction::Show, Some(index), None),
                Some(SegmentsCommand::Exclude { index }) => {
                    (SegmentAction::Exclude, Some(index), None)
                }
                Some(SegmentsCommand::Include { index }) => {
                    (SegmentAction::Include, Some(index), None)
                }
                Some(SegmentsCommand::Label { index, label }) => {
                    (SegmentAction::Label, Some(index), Some(label))
                }
                Some(SegmentsCommand::Note { index, note }) => {
                    (SegmentAction::Note, Some(index), Some(note))
                }
            };
            operation_to_swp::<InspectSegments>(SegmentsArgs {
                action: Some(action),
                index: segment_index.map(|index| u64::from(*index)),
                value: field_value.cloned(),
            })
        }

        CliCommand::Clear { exclude, note, .. } => {
            operation_to_swp::<ClearConversation>(ClearArgs {
                exclude: Some(*exclude),
                note: Some(note.clone()),
            })
        }

        CliCommand::Config {
            subcommand: Some(ConfigCommand::Tools { .. }),
            ..
        } => operation_to_swp::<ToolAccessListing>(EmptyOperationArgs {}),
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Keys { .. }),
            ..
        } => operation_to_swp::<ConfigurationSchema>(EmptyOperationArgs {}),
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Get { key, .. }),
            ..
        } => operation_to_swp::<Configuration>(ConfigArgs {
            key: Some(key.clone()),
            value: None,
        }),
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Set { key, value, .. }),
            ..
        } => operation_to_swp::<Configuration>(ConfigArgs {
            key: Some(key.clone()),
            value: Some(value.clone()),
        }),
        CliCommand::Config { check: true, .. } => {
            operation_to_swp::<CheckConfiguration>(EmptyOperationArgs {})
        }
        CliCommand::Config { .. } => operation_to_swp::<Configuration>(ConfigArgs {
            key: None,
            value: None,
        }),

        CliCommand::Usage { .. } => usage_to_swp(cmd, character),
    }
}

pub(crate) fn absolute_path(path: &Path) -> String {
    if path.is_absolute() {
        return path.display().to_string();
    }
    std::env::current_dir()
        .map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
        .display()
        .to_string()
}

fn msg_to_swp(cmd: &MsgCommand) -> Option<(&'static str, serde_json::Value)> {
    match cmd {
        MsgCommand::Send { system: false, .. } | MsgCommand::Regen { .. } => None,
        MsgCommand::Send {
            system: true,
            message,
            ..
        } => operation_to_swp::<InjectSystem>(InjectSystemArgs {
            text: message.join(" "),
        }),
        MsgCommand::Alt {
            selector, msg_ref, ..
        } => Some(alt_command_to_swp(selector.as_deref(), msg_ref.as_deref())),
        MsgCommand::Edit {
            msg_ref, content, ..
        } => operation_to_swp::<EditMessage>(EditMessageArgs {
            reference: msg_ref.clone(),
            content: content.join(" "),
        }),
        MsgCommand::Delete { msg_refs, .. } => {
            operation_to_swp::<DeleteMessages>(DeleteMessagesArgs {
                refs: MessageReferences::Many(msg_refs.clone()),
            })
        }
    }
}

fn log_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    let CliCommand::Log {
        msg_ref,
        role,
        count,
        segment,
        ..
    } = cmd
    else {
        return None;
    };
    if let Some(r) = msg_ref {
        return operation_to_swp::<GetMessage>(GetMessageArgs {
            reference: r.clone(),
            role: role.map(LogRole::as_protocol_role),
        });
    }
    operation_to_swp::<ConversationLog>(ConversationLogArgs {
        turns: Some(u64::from(*count)),
        count: None,
        role: role.map(LogRole::as_protocol_role),
        segment: segment.map(u64::from),
    })
}

fn operation_to_swp<O: Operation>(input: O::Input) -> Option<(&'static str, serde_json::Value)> {
    serde_json::to_value(input).ok().map(|args| (O::NAME, args))
}

fn trace_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    let CliCommand::Trace {
        subcommand: Some(subcommand),
    } = cmd
    else {
        return None;
    };
    match subcommand {
        TraceCommand::Heartbeat { count, .. } => {
            operation_to_swp::<ReadTranscript>(TranscriptArgs {
                source: Some(TranscriptSource::Heartbeat),
                count: Some(*count),
            })
        }
        TraceCommand::Errors { count, .. } => {
            operation_to_swp::<ReadErrorLog>(DiagnosticCountArgs {
                count: Some(*count),
            })
        }
        TraceCommand::Events { count, .. } => {
            operation_to_swp::<ReadHeartbeatLog>(DiagnosticCountArgs {
                count: Some(*count),
            })
        }
        TraceCommand::Subagent { id, count, .. } => {
            operation_to_swp::<ReadSubagentTraces>(SubagentTraceArgs {
                ids: id.as_ref().map(|one| vec![one.clone()]),
                count: id.is_none().then_some(*count),
            })
        }
        TraceCommand::Calls {
            id,
            count,
            call_type,
            diff,
            against,
            wire,
            ..
        } => operation_to_swp::<InspectCalls>(CallLogArgs {
            id: *id,
            count: id.is_none().then_some(*count),
            call_type: call_type.clone(),
            character: None,
            diff: (id.is_some() && *diff).then_some(true),
            against: if id.is_some() && *diff {
                *against
            } else {
                None
            },
            wire: (id.is_some() && *wire).then_some(true),
        }),
    }
}

fn model_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    let CliCommand::Model {
        subcommand,
        info,
        reset,
        all,
        favorites,
        ..
    } = cmd
    else {
        return None;
    };
    match subcommand {
        Some(ModelCommand::Info { name, target }) => {
            operation_to_swp::<InspectModel>(ModelInfoArgs {
                name: Some(name.clone().unwrap_or_default()),
                ..target.operation_args()
            })
        }
        Some(ModelCommand::Use { name, target }) => {
            let selected = target.operation_args();
            operation_to_swp::<SwitchModel>(SwitchModelArgs {
                name: Some(name.clone()),
                include_hidden: all.then_some(true),
                background_task: selected.background_task,
                subagent: selected.subagent,
            })
        }
        Some(ModelCommand::Fav { name }) => operation_to_swp::<FavoriteModel>(FavoriteModelArgs {
            name: name.clone(),
            favorite: Some(true),
        }),
        Some(ModelCommand::Unfav { name }) => {
            operation_to_swp::<FavoriteModel>(FavoriteModelArgs {
                name: name.clone(),
                favorite: Some(false),
            })
        }
        Some(ModelCommand::Reset { target }) => {
            let selected = target.operation_args();
            operation_to_swp::<ResetModel>(ResetModelArgs {
                background_task: selected.background_task,
                subagent: selected.subagent,
            })
        }
        Some(ModelCommand::Setting {
            key,
            value,
            global,
            reset: setting_reset,
            target,
            model,
            ..
        }) => {
            let selected = target.operation_args();
            if let Some(setting_key) = key
                && (*setting_reset || value.is_some())
            {
                return operation_to_swp::<SetModelSetting>(SetModelSettingArgs {
                    key: setting_key.clone(),
                    name: model.clone(),
                    value: if *setting_reset {
                        Some(serde_json::Value::Null)
                    } else {
                        value
                            .as_ref()
                            .map(|raw_value| parse_setting_value(setting_key, raw_value))
                    },
                    scope: Some(if *global {
                        ModelPreferenceScope::Global
                    } else {
                        ModelPreferenceScope::Character
                    }),
                    background_task: selected.background_task,
                    subagent: selected.subagent,
                });
            }
            operation_to_swp::<ModelSettings>(ModelSettingsArgs {
                name: model.clone(),
                key: key.clone(),
                overview: (key.is_none() && target.is_bare() && model.is_none()).then_some(true),
                background_task: selected.background_task,
                subagent: selected.subagent,
            })
        }
        None if *reset => operation_to_swp::<ResetModel>(ResetModelArgs::default()),
        None if *info => operation_to_swp::<InspectModel>(ModelInfoArgs::default()),
        None => operation_to_swp::<ListModels>(ListModelsArgs {
            include_hidden: all.then_some(true),
            favorites_only: favorites.then_some(true),
        }),
    }
}

fn provider_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    let CliCommand::Provider { subcommand, .. } = cmd else {
        return None;
    };
    match subcommand {
        Some(ProviderCommand::Models { name, all, .. }) => {
            operation_to_swp::<ListProviderModels>(ProviderModelsArgs {
                provider: name.clone(),
                include_hidden: Some(*all),
            })
        }
        Some(ProviderCommand::Refresh {
            name: Some(name), ..
        }) => operation_to_swp::<RefreshProviderModels>(ProviderArgs {
            provider: name.clone(),
        }),
        Some(ProviderCommand::Refresh { name: None, .. }) => {
            operation_to_swp::<RefreshAllProviderModels>(EmptyOperationArgs {})
        }
        None => operation_to_swp::<ListProviders>(EmptyOperationArgs {}),
    }
}

fn compact_to_swp(cmd: &CliCommand) -> Option<(&'static str, serde_json::Value)> {
    let CliCommand::Compact {
        keep_turns,
        restart,
        segment,
        watch,
        cancel,
        ..
    } = cmd
    else {
        return None;
    };
    if *watch {
        return operation_to_swp::<WatchCompaction>(EmptyOperationArgs {});
    }
    if *cancel {
        return operation_to_swp::<CancelCompaction>(EmptyOperationArgs {});
    }
    operation_to_swp::<CompactConversation>(CompactArgs {
        dry_run: None,
        keep_turns: keep_turns.map(u64::from),
        restart: restart.then_some(true),
        segment: *segment,
    })
}

fn usage_to_swp(
    cmd: &CliCommand,
    selected: Option<&str>,
) -> Option<(&'static str, serde_json::Value)> {
    use shore_common::protocol::operations::{UsageArgs, UsageReport};
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
    let tab_separated = match subcommand {
        Some(UsageCommand::Export { tsv }) => Some(*tsv),
        _ => None,
    };
    let group_by = match subcommand {
        Some(UsageCommand::By { dimension }) => Some(dimension.wire()),
        _ => None,
    };
    operation_to_swp::<UsageReport>(UsageArgs {
        last: Some(last.clone()),
        character: Some(selected.map(str::to_owned)),
        provider: Some(provider.clone()),
        api_key: Some(api_key.clone()),
        model: Some(model.clone()),
        call_type: Some(call_type.clone()),
        group_by: Some(group_by),
        budget: Some(budget),
        anomalies: Some(anomalies),
        export_csv: Some(tab_separated == Some(false)),
        export_tsv: Some(tab_separated == Some(true)),
    })
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    fn parse(args: &[&str]) -> Cli {
        try_parse(args).unwrap_or_else(|error| panic!("{error}"))
    }

    fn try_parse(args: &[&str]) -> Result<Cli, clap::Error> {
        let mut full = vec!["shore"];
        full.extend_from_slice(args);
        let matches = Cli::command()
            .mut_arg("character", |arg| arg.env(None))
            .mut_arg("thread", |arg| arg.env(None))
            .mut_arg("addr", |arg| arg.env(None))
            .try_get_matches_from(full)?;
        Cli::from_arg_matches(&matches)
    }

    fn parsed_command(cli: &Cli) -> &CliCommand {
        let Some(command) = cli.command.as_ref() else {
            panic!("expected a command");
        };
        command
    }

    #[test]
    fn each_command_line_sends_the_daemon_exactly_this_command() {
        use serde_json::json;
        type Sent<'name> = Option<(&'name str, serde_json::Value)>;
        let cases: Vec<(&[&str], Sent<'_>)> = vec![
            (&["msg", "send", "hello", "world"], None),
            (
                &["msg", "send", "-i", "photo.jpg", "describe", "this"],
                None,
            ),
            (
                &["msg", "send", "-i", "a.jpg", "-i", "b.png", "compare"],
                None,
            ),
            (&["msg", "regen"], None),
            (&["msg", "regen", "--guidance", "be more concise"], None),
            (&["msg", "alt"], Some(("list_alternatives", json!({})))),
            (
                &["msg", "alt", "2", "--ref", "-1", "--json"],
                Some(("alt", json!({"ref": "-1", "position": 2}))),
            ),
            (&["log"], Some(("log", json!({"turns": 64})))),
            (
                &["log", "--count", "50"],
                Some(("log", json!({"turns": 50}))),
            ),
            (&["log", "last"], Some(("get", json!({"ref": "last"})))),
            (
                &["log", "last", "--role", "user"],
                Some(("get", json!({"ref": "last", "role": "user"}))),
            ),
            (
                &["log", "--role", "character"],
                Some(("log", json!({"turns": 64, "role": "assistant"}))),
            ),
            (&["log", "3"], Some(("get", json!({"ref": "3"})))),
            (
                &["msg", "edit", "msg_123", "new", "text"],
                Some(("edit", json!({"ref": "msg_123", "content": "new text"}))),
            ),
            (
                &["msg", "edit", "last", "updated"],
                Some(("edit", json!({"ref": "last", "content": "updated"}))),
            ),
            (
                &["msg", "edit", "-1", "new", "text"],
                Some(("edit", json!({"ref": "-1", "content": "new text"}))),
            ),
            (
                &["msg", "delete", "msg_456"],
                Some(("delete", json!({"refs": ["msg_456"]}))),
            ),
            (
                &["msg", "delete", "-1"],
                Some(("delete", json!({"refs": ["-1"]}))),
            ),
            (
                &["msg", "delete", "-1", "-2", "msg_456"],
                Some(("delete", json!({"refs": ["-1", "-2", "msg_456"]}))),
            ),
            (&["character"], None),
            (&["character", "use", "alice"], None),
            (&["character", "new", "alice"], None),
            (
                &[
                    "character",
                    "delete",
                    "alice",
                    "--archive",
                    "/tmp/alice.tar.gz",
                ],
                None,
            ),
            (&["thread"], Some(("list_threads", json!({})))),
            (
                &["thread", "use", "scratch"],
                Some(("switch_thread", json!({"name": "scratch"}))),
            ),
            (
                &[
                    "thread",
                    "new",
                    "eval",
                    "--label",
                    "Agent SDK eval",
                    "--model",
                    "claude-agent:opus5",
                    "--compaction",
                ],
                Some((
                    "create_thread",
                    json!({"name": "eval", "label": "Agent SDK eval", "model": "claude-agent:opus5", "compaction": true}),
                )),
            ),
            (
                &[
                    "thread",
                    "new",
                    "lighthouse",
                    "--purpose",
                    "The lighthouse story",
                    "--file",
                    "stories/lighthouse.md",
                    "--file",
                    "stories/cast.md",
                ],
                Some((
                    "create_thread",
                    json!({"name": "lighthouse", "label": null, "model": null, "compaction": false, "purpose": "The lighthouse story", "files": ["stories/lighthouse.md", "stories/cast.md"]}),
                )),
            ),
            (
                &["thread", "purpose", "lighthouse"],
                Some((
                    "thread_purpose",
                    json!({"name": "lighthouse", "purpose": null}),
                )),
            ),
            (
                &["thread", "files", "lighthouse", "stories/lighthouse.md"],
                Some((
                    "thread_files",
                    json!({"name": "lighthouse", "files": ["stories/lighthouse.md"]}),
                )),
            ),
            (
                &["character", "info"],
                Some(("character_info", json!({"name": ""}))),
            ),
            (&["status"], Some(("status", json!({})))),
            (
                &["trace", "errors", "-n", "5"],
                Some(("error_log", json!({"count": 5}))),
            ),
            (
                &["debug", "heartbeat_tick_now"],
                Some(("heartbeat_tick_now", json!({}))),
            ),
            (
                &["debug", "heartbeat_status_dormant"],
                Some(("heartbeat_set_dormant", json!({}))),
            ),
            (
                &["debug", "heartbeat_status_active"],
                Some(("heartbeat_set_active", json!({}))),
            ),
            (&["model"], Some(("list_models", json!({})))),
            (
                &["model", "use", "claude-haiku-4-5-20251001"],
                Some(("switch_model", json!({"name": "claude-haiku-4-5-20251001"}))),
            ),
            (
                &["model", "info", "opus"],
                Some(("model_info", json!({"name": "opus"}))),
            ),
            (
                &["model", "--all"],
                Some(("list_models", json!({"include_hidden": true}))),
            ),
            (
                &["model", "setting"],
                Some(("model_settings", json!({"overview": true}))),
            ),
            (
                &["model", "setting", "temperature", "0.8"],
                Some((
                    "set_model_setting",
                    json!({"key": "temperature", "value": "0.8", "scope": "character"}),
                )),
            ),
            (
                &["model", "setting", "--reset", "temperature"],
                Some((
                    "set_model_setting",
                    json!({"key": "temperature", "value": null, "scope": "character"}),
                )),
            ),
            (
                &["model", "setting", "--global", "top_p", "0.9"],
                Some((
                    "set_model_setting",
                    json!({"key": "top_p", "value": "0.9", "scope": "global"}),
                )),
            ),
            (&["provider"], Some(("list_providers", json!({})))),
            (
                &["provider", "models", "openrouter"],
                Some((
                    "list_provider_models",
                    json!({"provider": "openrouter", "include_hidden": false}),
                )),
            ),
            (
                &["provider", "models", "openrouter", "--all"],
                Some((
                    "list_provider_models",
                    json!({"provider": "openrouter", "include_hidden": true}),
                )),
            ),
            (
                &["provider", "refresh", "openrouter"],
                Some(("refresh_provider_models", json!({"provider": "openrouter"}))),
            ),
            (
                &["provider", "refresh"],
                Some(("refresh_all_provider_models", json!({}))),
            ),
            (
                &["segments", "show", "4"],
                Some(("segments", json!({"action": "show", "index": 4}))),
            ),
            (
                &["clear", "--exclude", "--note", "bad branch"],
                Some(("clear", json!({"exclude": true, "note": "bad branch"}))),
            ),
            (&["config"], Some(("config", json!({})))),
            (
                &["config", "get", "chat.model"],
                Some(("config", json!({"key": "chat.model"}))),
            ),
            (
                &["config", "set", "chat.model", "claude-haiku-4-5-20251001"],
                Some((
                    "config",
                    json!({"key": "chat.model", "value": "claude-haiku-4-5-20251001"}),
                )),
            ),
            (&["config", "reload"], None),
            (&["config", "reload", "-y"], None),
            (&["config", "--path"], None),
            (
                &["debug", "keepalive_ping_now"],
                Some(("keepalive_ping_now", json!({}))),
            ),
            (
                &["debug", "session_activate"],
                Some(("session_activate", json!({}))),
            ),
            (&["completions", "fish"], None),
            (&["completions", "bash"], None),
            (&["completions", "zsh"], None),
            (
                &["usage"],
                Some((
                    "usage",
                    json!({"last": null, "character": null, "provider": null, "api_key": null, "model": null, "call_type": null, "group_by": null, "budget": false, "anomalies": false, "export_csv": false, "export_tsv": false}),
                )),
            ),
            (
                &["usage", "--call-type", "message"],
                Some((
                    "usage",
                    json!({"last": null, "character": null, "provider": null, "api_key": null, "model": null, "call_type": "message", "group_by": null, "budget": false, "anomalies": false, "export_csv": false, "export_tsv": false}),
                )),
            ),
            (&["complete", "models"], None),
            (&["complete", "characters"], None),
            (
                &["model", "--favorites"],
                Some(("list_models", json!({"favorites_only": true}))),
            ),
            (
                &["model", "-f"],
                Some(("list_models", json!({"favorites_only": true}))),
            ),
            (&["compact"], Some(("compact", json!({})))),
            (
                &["compact", "0"],
                Some(("compact", json!({"keep_turns": 0}))),
            ),
            (
                &["compact", "8"],
                Some(("compact", json!({"keep_turns": 8}))),
            ),
            (
                &["compact", "--restart"],
                Some(("compact", json!({"restart": true}))),
            ),
            (
                &["compact", "0", "--restart"],
                Some(("compact", json!({"keep_turns": 0, "restart": true}))),
            ),
            (
                &["compact", "--segment", "860"],
                Some(("compact", json!({"segment": 860}))),
            ),
            (
                &["-c", "ada", "usage"],
                Some((
                    "usage",
                    json!({"last": null, "character": "ada", "provider": null, "api_key": null, "model": null, "call_type": null, "group_by": null, "budget": false, "anomalies": false, "export_csv": false, "export_tsv": false}),
                )),
            ),
            (
                &["msg", "edit", "last", "two", "words"],
                Some(("edit", json!({"ref": "last", "content": "two words"}))),
            ),
        ];
        for (argv, expected) in cases {
            let cli = parse(argv);
            let sent = to_swp_command(parsed_command(&cli), cli.character.as_deref());
            assert_eq!(
                sent,
                expected,
                "`shore {}` sends the wrong command (None means it is handled locally)",
                argv.join(" ")
            );
        }
    }

    #[test]
    fn character_delete_requires_a_name() {
        let err = Cli::try_parse_from(["shore", "character", "delete"])
            .expect_err("a name is not optional");
        assert_eq!(err.kind(), clap::error::ErrorKind::MissingRequiredArgument);
    }

    #[test]
    fn character_delete_is_not_sent_by_the_generic_mapper() {
        let cli = parse(&["character", "delete", "alice", "--yes"]);
        assert!(
            to_swp_command(parsed_command(&cli), None).is_none(),
            "deletion goes through the confirming handler, never the bare mapper",
        );
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
}
