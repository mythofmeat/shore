use clap::{Args, Parser, Subcommand, ValueEnum};
use clap_complete::Shell;
use std::path::{Path, PathBuf};

const LEADING_HEADING: &str = "Options — must come before the command";

#[derive(Parser, Debug)]
#[command(
    name = "shore",
    version = env!("SHORE_VERSION"),
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

const RETIRED_FLAGS: [(&str, &str); 6] = [
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
];

const NAMED_BY_USE: [&str; 3] = ["model", "character", "thread"];

/// Words people reach for when the bare command is already the listing.
const LISTING_VERBS: [&str; 4] = ["list", "ls", "all", "show"];

const PROMOTED: [(&str, &str); 1] = [("memory compact", "compact")];

const FOLDED_IN: [(&str, &str); 1] = [(
    "model background",
    "every model role is listed by `shore model`; pin one with \
     `shore model use --background=<heartbeat|compaction> <name>`, or \
     bare `--background` for all of them",
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
    AlreadyLists(&'static str, String),
    Promoted(&'static str, &'static str),
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
    let collected_argv = argv
        .into_iter()
        .map(|arg| arg.as_ref().to_owned())
        .collect::<Vec<_>>();
    if let Some(problem) = separated_model_target(&collected_argv) {
        return Some(problem);
    }
    let mut words: Vec<String> = Vec::new();
    let mut flags: Vec<String> = Vec::new();
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
        FlagProblem::Retired(flag, instead) => {
            crate::output::print_error(&format!("{flag} was removed — {instead}"));
        }
        FlagProblem::BareName(command, ref name) => {
            crate::output::print_error(&format!("`shore {command}` no longer takes a name"));
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
        FlagProblem::Promoted(old, now) => {
            crate::output::print_error(&format!("`shore {old}` is now a command of its own"));
            cli_err!();
            cli_err!("  shore {now}");
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

    /// Summarize the conversation into memory and shorten the active window
    #[command(display_order = 2)]
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

    /// Back up one character to a compressed archive while Shore keeps running
    #[command(display_order = 9)]
    Export {
        /// Character to back up
        character: String,

        /// Archive path on the daemon host (defaults to <character>.shore.tar.gz)
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Restore a character archive; existing characters are never overwritten
    #[command(display_order = 9)]
    Import {
        /// Archive created by `shore export`, on the daemon host
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

    /// Retry a Hindsight retain or delete that exhausted its attempts
    Retry { index: u32 },
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
    CostSource,
}

impl UsageDimension {
    fn wire(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Provider => "provider",
            Self::CallType => "call_type",
            Self::Kind => "kind",
            Self::ApiKey => "api_key",
            Self::CostSource => "cost_source",
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

    /// What memory recall pulled in before each turn: the query, scored
    /// candidates, injected memories, and latency
    Recall {
        /// Number of turns to show
        #[arg(short = 'n', long = "count", default_value = "10")]
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

    /// Sub-agents: bare means all; naming one requires --subagent=<name>
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

    pub(crate) fn write_into(&self, obj: &mut serde_json::Map<String, serde_json::Value>) {
        use serde_json::json;
        if let Some(task) = self.background {
            let _ignored = obj.insert("background_task".into(), json!(task.as_str()));
        }
        if let Some(name) = &self.subagent {
            let _ignored = obj.insert("subagent".into(), json!(name));
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
    /// Bare, this picks the chat model, saved against the attached character,
    /// so characters can differ. Every other target writes the config file,
    /// which is global: --background=<task> writes defaults.background.<task>,
    /// bare --background writes defaults.background.model (the value both
    /// tasks fall back to), --subagent=<name> writes subagents.<name>.model,
    /// and bare --subagent writes defaults.subagent_model.
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
    /// The vendor knobs openrouter_provider, gemini_generation and
    /// zai_clear_thinking are settable per model too. A
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
    /// Bare, this clears the character's chat model. Every other target clears
    /// the config keys `use` would have written, so the role falls back the
    /// way it did before anything was pinned. Bare --background clears all
    /// three background keys; bare --subagent clears defaults.subagent_model
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

    /// Pin a thread to its own chat model, or clear the pin to inherit the character's
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
    pub providers: Vec<PaletteValue>,
    pub status_sections: Vec<PaletteValue>,
    pub tools: Vec<PaletteValue>,
    pub subagents: Vec<PaletteValue>,
    pub setting_keys: Vec<PaletteValue>,
    pub setting_values: std::collections::BTreeMap<String, Vec<PaletteValue>>,
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
        .mut_subcommand("character", |subcommand| {
            subcommand.mut_subcommand("use", |leaf| {
                with_palette_values(leaf, "name", &catalog.characters)
            })
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
    let parsed = Cli::try_parse_from(argv).map_err(|error| error.to_string())?;
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

#[expect(
    clippy::format_push_string,
    reason = "writeln! here would trip only_the_vocabulary_is_allowed_to_hardcode_indentation, and this builds clap help text rather than terminal output"
)]
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
                model,
                compaction,
            } => Some((
                "create_thread",
                json!({
                    "name": name,
                    "label": label,
                    "model": model,
                    "compaction": compaction,
                }),
            )),
            ThreadCommand::Label { name, label } => {
                Some(("thread_label", json!({ "name": name, "label": label })))
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

        CliCommand::Export {
            character: export_character,
            output,
            ..
        } => {
            let fallback = PathBuf::from(format!("{export_character}.shore.tar.gz"));
            Some((
                "export_character",
                json!({
                    "character": export_character,
                    "output": absolute_path(output.as_deref().unwrap_or(&fallback)),
                }),
            ))
        }
        CliCommand::Import { archive, .. } => Some((
            "import_character",
            json!({ "archive": absolute_path(archive) }),
        )),

        CliCommand::Log { .. } => log_to_swp(cmd),
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

        CliCommand::Segments { subcommand, .. } => {
            let (action, segment_index, field_value) = match subcommand {
                None => ("list", None, None),
                Some(SegmentsCommand::Show { index }) => ("show", Some(index), None),
                Some(SegmentsCommand::Exclude { index }) => ("exclude", Some(index), None),
                Some(SegmentsCommand::Include { index }) => ("include", Some(index), None),
                Some(SegmentsCommand::Label { index, label }) => {
                    ("label", Some(index), Some(label))
                }
                Some(SegmentsCommand::Note { index, note }) => ("note", Some(index), Some(note)),
                Some(SegmentsCommand::Retry { index }) => ("retry", Some(index), None),
            };
            let mut args = serde_json::Map::new();
            _ = args.insert("action".into(), json!(action));
            if let Some(selected_index) = segment_index {
                _ = args.insert("index".into(), json!(selected_index));
            }
            if let Some(selected_value) = field_value {
                _ = args.insert("value".into(), json!(selected_value));
            }
            Some(("segments", serde_json::Value::Object(args)))
        }

        CliCommand::Clear { exclude, note, .. } => {
            Some(("clear", json!({ "exclude": exclude, "note": note })))
        }

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

fn absolute_path(path: &Path) -> String {
    if path.is_absolute() {
        return path.display().to_string();
    }
    std::env::current_dir()
        .map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
        .display()
        .to_string()
}

fn msg_to_swp(cmd: &MsgCommand) -> Option<(&'static str, serde_json::Value)> {
    use serde_json::json;
    match cmd {
        MsgCommand::Send { system: false, .. } | MsgCommand::Regen { .. } => None,
        MsgCommand::Send {
            system: true,
            message,
            ..
        } => Some(("inject_system", json!({ "text": message.join(" ") }))),
        MsgCommand::Alt {
            selector, msg_ref, ..
        } => Some(alt_command_to_swp(selector.as_deref(), msg_ref.as_deref())),
        MsgCommand::Edit {
            msg_ref, content, ..
        } => Some((
            "edit",
            json!({ "ref": msg_ref, "content": content.join(" ") }),
        )),
        MsgCommand::Delete { msg_refs, .. } => Some(("delete", json!({ "refs": msg_refs }))),
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
        TraceCommand::Recall { count, .. } => Some((
            "transcript",
            json!({ "source": "memory_recall", "count": count }),
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
            if let Some(one) = id {
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
            } else {
                _ = args.insert("count".into(), json!(count));
                if let Some(ct) = call_type {
                    _ = args.insert("call_type".into(), json!(ct));
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
        favorites,
        ..
    } = cmd
    else {
        return None;
    };
    if let Some(ModelCommand::Info {
        name: info_name,
        target,
    }) = subcommand
    {
        let mut obj = Map::new();
        let _ignored = obj.insert("name".into(), json!(info_name.clone().unwrap_or_default()));
        target.write_into(&mut obj);
        return Some(("model_info", Value::Object(obj)));
    }
    if let Some(ModelCommand::Use { name, target }) = subcommand {
        let mut obj = Map::new();
        let _ignored = obj.insert("name".into(), json!(name));
        target.write_into(&mut obj);
        return Some(("switch_model", Value::Object(obj)));
    }
    if let Some(ModelCommand::Fav { name }) = subcommand {
        return Some(("favorite_model", json!({ "name": name, "favorite": true })));
    }
    if let Some(ModelCommand::Unfav { name }) = subcommand {
        return Some(("favorite_model", json!({ "name": name, "favorite": false })));
    }
    if let Some(ModelCommand::Reset { target }) = subcommand {
        let mut obj = Map::new();
        target.write_into(&mut obj);
        return Some(("reset_model", Value::Object(obj)));
    }
    if let Some(ModelCommand::Setting {
        key,
        value,
        global,
        reset: setting_reset,
        target,
        model: setting_model,
        ..
    }) = subcommand
    {
        let scope = if *global { "global" } else { "character" };
        let with_target = |mut obj: Map<String, Value>| -> Value {
            target.write_into(&mut obj);
            if let Some(name) = setting_model {
                let _ignored = obj.insert("name".into(), json!(name));
            }
            Value::Object(obj)
        };
        let untargeted = target.is_bare() && setting_model.is_none();
        return match (key.as_deref(), value.as_deref(), *setting_reset) {
            (Some(k), _, true) => {
                let mut obj = Map::new();
                let _ignored = obj.insert("key".into(), json!(k));
                _ = obj.insert("value".into(), Value::Null);
                _ = obj.insert("scope".into(), json!(scope));
                Some(("set_model_setting", with_target(obj)))
            }
            (None, _, _) if untargeted => Some(("model_settings", json!({ "overview": true }))),
            (None, _, _) => Some(("model_settings", with_target(Map::new()))),
            (Some(k), None, false) => {
                let mut obj = Map::new();
                let _ignored = obj.insert("key".into(), json!(k));
                Some(("model_settings", with_target(obj)))
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
    if *favorites {
        let _ignored = args.insert("favorites_only".into(), json!(true));
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
    let tab_separated = match subcommand {
        Some(UsageCommand::Export { tsv }) => Some(*tsv),
        _ => None,
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
            "export_csv": tab_separated == Some(false),
            "export_tsv": tab_separated == Some(true),
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

    fn parsed_command(cli: &Cli) -> &CliCommand {
        let Some(command) = cli.command.as_ref() else {
            panic!("expected a command");
        };
        command
    }

    fn parsed_msg(cli: &Cli) -> &MsgCommand {
        let CliCommand::Msg { command } = parsed_command(cli) else {
            panic!("expected a msg command");
        };
        command
    }

    fn msg(command: MsgCommand) -> CliCommand {
        CliCommand::Msg { command }
    }

    fn arg<'val>(args: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        args.get(key).expect("expected command argument")
    }

    fn palette_replacements(input: &str, catalog: &PaletteCatalog) -> Vec<String> {
        palette_completions(input, catalog)
            .candidates
            .into_iter()
            .map(|candidate| candidate.replacement)
            .collect()
    }

    fn assert_palette_covers_subcommands(
        command: &clap::Command,
        parent: &str,
        catalog: &PaletteCatalog,
    ) {
        let input = if parent.is_empty() {
            String::new()
        } else {
            format!("{parent} ")
        };
        let offered = palette_replacements(&input, catalog);
        for child in command.get_subcommands().filter(|child| {
            !child.is_hide_set() && !matches!(child.get_name(), "completions" | "complete")
        }) {
            let path = if parent.is_empty() {
                child.get_name().to_owned()
            } else {
                format!("{parent} {}", child.get_name())
            };
            assert!(
                offered.iter().any(|candidate| candidate == &path),
                "palette omitted clap command {path:?}; offered {offered:?}"
            );
            assert_palette_covers_subcommands(child, &path, catalog);
        }
    }

    #[test]
    fn palette_recursively_covers_every_visible_cli_command() {
        use clap::CommandFactory;

        let mut command = Cli::command();
        command.build();
        assert_palette_covers_subcommands(&command, "", &PaletteCatalog::default());
    }

    #[test]
    fn palette_offers_the_tui_only_commands() {
        let offered = palette_replacements("", &PaletteCatalog::default());
        for name in ["view", "ui"] {
            assert!(
                offered.iter().any(|candidate| candidate == name),
                "palette stopped offering `{name}`: {offered:?}"
            );
        }

        let ui = palette_replacements("ui ", &PaletteCatalog::default());
        for leaf in [
            "ui scroll",
            "ui insert",
            "ui palette",
            "ui bind",
            "ui unbind",
        ] {
            assert!(
                ui.iter().any(|candidate| candidate == leaf),
                "palette stopped offering `{leaf}`: {ui:?}"
            );
        }

        let view = palette_replacements("view ", &PaletteCatalog::default());
        assert!(
            view.iter().any(|candidate| candidate == "view thinking"),
            "palette stopped offering view keys: {view:?}"
        );
    }

    #[test]
    fn palette_uses_one_canonical_spelling_for_cli_actions() {
        let offered = palette_replacements("", &PaletteCatalog::default());
        for duplicate in ["regen", "alt", "edit", "delete", "sys", "setting"] {
            assert!(!offered.iter().any(|candidate| candidate == duplicate));
        }
        for canonical in ["msg", "model", "character"] {
            assert!(offered.iter().any(|candidate| candidate == canonical));
        }
    }

    #[test]
    fn palette_rejects_a_spaced_model_target_before_it_can_reach_the_daemon() {
        let error = parse_palette_command("model setting --subagent all zai_subscription true")
            .expect_err("the palette must apply the same target grammar as the CLI");
        assert!(error.contains("--subagent=all"), "{error}");

        let incomplete = palette_command_needs_more_input("model reset --subagent memory")
            .expect_err("a spaced target is an error, not an incomplete command");
        assert!(incomplete.contains("--subagent=memory"), "{incomplete}");
    }

    #[test]
    fn palette_completes_flags_enums_and_live_values() {
        let catalog = PaletteCatalog {
            models: vec![PaletteValue::plain("anthropic:opus")],
            characters: vec![PaletteValue::plain("ada")],
            providers: vec![PaletteValue::plain("anthropic")],
            status_sections: vec![PaletteValue::plain("daemon")],
            tools: vec![PaletteValue::plain("read")],
            subagents: vec![PaletteValue::plain("librarian")],
            setting_keys: vec![PaletteValue::plain("temperature")],
            setting_values: std::collections::BTreeMap::from([(
                "temperature".into(),
                vec![PaletteValue::plain("0.125")],
            )]),
            config_keys: vec![PaletteValue::plain("defaults.stream")],
            config_sections: vec![PaletteValue::plain("defaults")],
            config_schema: Some(serde_json::json!({
                "schema": [{
                    "key": "defaults.stream",
                    "settable": true,
                    "values": ["true", "false"]
                }]
            })),
            ..PaletteCatalog::default()
        };

        assert!(palette_replacements("log --", &catalog).contains(&"log --reasoning".into()));
        assert!(palette_replacements("log --role ", &catalog).contains(&"log --role user".into()));
        assert!(
            palette_replacements("model use ", &catalog)
                .contains(&"model use anthropic:opus".into())
        );
        assert!(
            palette_replacements("status --section ", &catalog)
                .contains(&"status --section daemon".into())
        );
        assert!(
            palette_replacements("config set defaults.stream ", &catalog)
                .contains(&"config set defaults.stream true".into())
        );
        assert!(
            palette_replacements("model setting temperature ", &catalog)
                .contains(&"model setting temperature 0.125".into())
        );
        assert!(!palette_replacements("model --", &catalog).contains(&"model --help".into()));
    }

    #[test]
    fn bare_shore_selects_no_cli_command() {
        assert!(parse(&[]).command.is_none());
    }

    #[test]
    fn chat_commands_are_a_hard_break_at_the_top_level() {
        for old in ["send", "regen", "alt", "edit", "delete"] {
            assert!(
                try_parse(&[old]).is_err(),
                "{old} still parsed at top level"
            );
        }
    }

    #[test]
    fn an_unknown_command_does_not_become_the_tui() {
        assert!(try_parse(&["stauts"]).is_err());
    }

    #[test]
    fn export_and_import_map_to_absolute_daemon_paths() {
        let export = parse(&["export", "ada", "--output", "backup.tar.gz"]);
        let (name, args) = to_swp_command(parsed_command(&export), None).unwrap();
        assert_eq!(name, "export_character");
        assert_eq!(arg(&args, "character"), "ada");
        let output = Path::new(arg(&args, "output").as_str().unwrap());
        assert!(output.is_absolute());
        assert!(output.ends_with("backup.tar.gz"));

        let import = parse(&["import", "backup.tar.gz"]);
        let (import_name, import_args) = to_swp_command(parsed_command(&import), None).unwrap();
        assert_eq!(import_name, "import_character");
        let archive = Path::new(arg(&import_args, "archive").as_str().unwrap());
        assert!(archive.is_absolute());
        assert!(archive.ends_with("backup.tar.gz"));
    }

    #[test]
    fn parse_send() {
        let cli = parse(&["msg", "send", "hello", "world"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Send {
                message, images, ..
            } => {
                assert_eq!(message, &["hello", "world"]);
                assert!(images.is_empty());
            }
        );
    }

    #[test]
    fn parse_send_with_image() {
        let cli = parse(&["msg", "send", "-i", "photo.jpg", "describe", "this"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Send {
                message, images, ..
            } => {
                assert_eq!(message, &["describe", "this"]);
                assert_eq!(images, &["photo.jpg"]);
            }
        );
    }

    #[test]
    fn parse_send_with_multiple_images() {
        let cli = parse(&["msg", "send", "-i", "a.jpg", "-i", "b.png", "compare"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Send {
                message, images, ..
            } => {
                assert_eq!(message, &["compare"]);
                assert_eq!(images, &["a.jpg", "b.png"]);
            }
        );
    }

    #[test]
    fn parse_regen() {
        let cli = parse(&["msg", "regen"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Regen { guidance } => assert!(guidance.is_none())
        );
    }

    #[test]
    fn parse_regen_with_guidance() {
        let cli = parse(&["msg", "regen", "--guidance", "be more concise"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Regen { guidance } => {
                assert_eq!(guidance.as_deref(), Some("be more concise"));
            }
        );
    }

    #[test]
    fn parse_alt_defaults_to_list() {
        let cli = parse(&["msg", "alt"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Alt {
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
        let cli = parse(&["msg", "alt", "2", "--ref", "-1", "--json"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Alt {
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
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Log { count, .. } => {
                assert_eq!(*count, 50);
            }
        );
    }

    #[test]
    fn parse_log_get_by_ref() {
        let cli = parse(&["log", "last"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Log { msg_ref, .. } => {
                assert_eq!(msg_ref.as_deref(), Some("last"));
            }
        );
    }

    #[test]
    fn parse_log_get_by_role() {
        let cli = parse(&["log", "last", "--role", "user"]);
        assert_variant!(
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Log { msg_ref, .. } => {
                assert_eq!(msg_ref.as_deref(), Some("3"));
            }
        );
    }

    #[test]
    fn parse_edit() {
        let cli = parse(&["msg", "edit", "msg_123", "new", "text"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Edit { msg_ref, content, .. } => {
                assert_eq!(msg_ref, "msg_123");
                assert_eq!(content, &["new", "text"]);
            }
        );
    }

    #[test]
    fn parse_edit_last() {
        let cli = parse(&["msg", "edit", "last", "updated"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Edit { msg_ref, content, .. } => {
                assert_eq!(msg_ref, "last");
                assert_eq!(content, &["updated"]);
            }
        );
    }

    #[test]
    fn parse_edit_negative_index() {
        let cli = parse(&["msg", "edit", "-1", "new", "text"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Edit { msg_ref, content, .. } => {
                assert_eq!(msg_ref, "-1");
                assert_eq!(content, &["new", "text"]);
            }
        );
    }

    #[test]
    fn parse_delete() {
        let cli = parse(&["msg", "delete", "msg_456"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Delete { msg_refs, .. } => {
                assert_eq!(msg_refs, &["msg_456"]);
            }
        );
    }

    #[test]
    fn parse_delete_negative_index() {
        let cli = parse(&["msg", "delete", "-1"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Delete { msg_refs, .. } => {
                assert_eq!(msg_refs, &["-1"]);
            }
        );
    }

    #[test]
    fn parse_delete_takes_several_refs() {
        let cli = parse(&["msg", "delete", "-1", "-2", "msg_456"]);
        assert_variant!(
            parsed_msg(&cli),
            MsgCommand::Delete { msg_refs, .. } => {
                assert_eq!(msg_refs, &["-1", "-2", "msg_456"]);
            }
        );
    }

    #[test]
    fn delete_needs_at_least_one_ref() {
        assert!(Cli::try_parse_from(["shore", "msg", "delete"]).is_err());
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Character { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(CharacterCommand::New { name }) if name == "alice"
                ));
            }
        );
    }

    #[test]
    fn parse_thread_list() {
        let cli = parse(&["thread"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Thread { subcommand, json } => {
                assert!(subcommand.is_none());
                assert!(!json);
            }
        );
    }

    #[test]
    fn parse_thread_use() {
        let cli = parse(&["thread", "use", "scratch"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Thread { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(ThreadCommand::Use { name }) if name == "scratch"
                ));
            }
        );
    }

    #[test]
    fn parse_thread_new_carries_its_options() {
        let cli = parse(&[
            "thread",
            "new",
            "eval",
            "--label",
            "Agent SDK eval",
            "--model",
            "claude-agent:opus5",
            "--compaction",
        ]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Thread { subcommand, .. } => {
                assert_variant!(
                    subcommand.as_ref().expect("a subcommand"),
                    ThreadCommand::New { name, label, model, compaction } => {
                        assert_eq!(name, "eval");
                        assert_eq!(label.as_deref(), Some("Agent SDK eval"));
                        assert_eq!(model.as_deref(), Some("claude-agent:opus5"));
                        assert!(compaction);
                    }
                );
            }
        );
    }

    #[test]
    fn a_new_thread_does_not_compact_unless_asked() {
        let cli = parse(&["thread", "new", "eval"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Thread { subcommand, .. } => {
                assert_variant!(
                    subcommand.as_ref().expect("a subcommand"),
                    ThreadCommand::New { compaction, label, model, .. } => {
                        assert!(!compaction);
                        assert!(label.is_none());
                        assert!(model.is_none());
                    }
                );
            }
        );
    }

    #[test]
    fn a_thread_label_with_no_value_clears_it() {
        let cli = parse(&["thread", "label", "scratch"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Thread { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(ThreadCommand::Label { name, label: None }) if name == "scratch"
                ));
            }
        );
    }

    #[test]
    fn a_thread_model_with_no_value_lifts_the_pin() {
        let cli = parse(&["thread", "model", "eval"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).expect("a command");
        assert_eq!(name, "thread_model");
        assert_eq!(
            args.get("name").and_then(serde_json::Value::as_str),
            Some("eval")
        );
        assert_eq!(args.get("model"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn a_thread_model_carries_the_model_it_names() {
        let cli = parse(&["thread", "model", "eval", "claude-agent:opus5"]);
        let (_name, args) = to_swp_command(parsed_command(&cli), None).expect("a command");
        assert_eq!(
            args.get("model").and_then(serde_json::Value::as_str),
            Some("claude-agent:opus5")
        );
    }

    #[test]
    fn thread_subcommands_that_need_a_name_say_so() {
        for args in [
            &["thread", "use"][..],
            &["thread", "new"][..],
            &["thread", "home"][..],
            &["thread", "archive"][..],
            &["thread", "label"][..],
            &["thread", "model"][..],
        ] {
            assert!(
                Cli::try_parse_from(std::iter::once("shore").chain(args.iter().copied())).is_err(),
                "{args:?} must not parse without a name"
            );
        }
    }

    #[test]
    fn the_thread_flag_leads_the_command() {
        let cli = parse(&["--thread", "scratch", "log"]);
        assert_eq!(cli.thread.as_deref(), Some("scratch"));

        let short = parse(&["-t", "scratch", "log"]);
        assert_eq!(short.thread.as_deref(), Some("scratch"));
    }

    #[test]
    fn a_trailing_thread_flag_is_caught_as_misplaced() {
        assert_eq!(
            misplaced(&["log", "--thread", "scratch"]),
            Some(FlagProblem::Misplaced("--thread"))
        );
    }

    #[test]
    fn a_bare_thread_name_is_pointed_at_use() {
        assert_eq!(
            misplaced(&["thread", "scratch"]),
            Some(FlagProblem::BareName("thread", "scratch".to_owned()))
        );
    }

    #[test]
    fn a_guessed_listing_verb_is_not_read_as_a_name() {
        for (command, verb) in [
            ("thread", "list"),
            ("thread", "ls"),
            ("model", "all"),
            ("character", "show"),
        ] {
            assert_eq!(
                misplaced(&[command, verb]),
                Some(FlagProblem::AlreadyLists(command, verb.to_owned())),
                "`shore {command} {verb}` must not be answered with `use {verb}`",
            );
        }
    }

    #[test]
    fn thread_commands_reach_the_wire_under_their_own_names() {
        let cases: [(&[&str], &str); 8] = [
            (&["thread"], "list_threads"),
            (&["thread", "use", "scratch"], "switch_thread"),
            (&["thread", "new", "scratch"], "create_thread"),
            (&["thread", "label", "scratch"], "thread_label"),
            (&["thread", "model", "scratch"], "thread_model"),
            (&["thread", "home", "scratch"], "thread_home"),
            (&["thread", "archive", "scratch"], "archive_thread"),
            (&["thread", "fork", "scratch"], "fork_thread"),
        ];
        for (args, expected) in cases {
            let cli = parse(args);
            let (name, _args) = to_swp_command(parsed_command(&cli), None)
                .unwrap_or_else(|| panic!("{args:?} produced no command"));
            assert_eq!(name, expected, "{args:?}");
        }
    }

    #[test]
    fn a_new_thread_sends_every_option_it_was_given() {
        let cli = parse(&[
            "thread",
            "new",
            "eval",
            "--label",
            "Eval",
            "--model",
            "x:y",
            "--compaction",
        ]);
        let (_name, args) = to_swp_command(parsed_command(&cli), None).expect("a command");
        assert_eq!(
            args.get("name").and_then(serde_json::Value::as_str),
            Some("eval")
        );
        assert_eq!(
            args.get("label").and_then(serde_json::Value::as_str),
            Some("Eval")
        );
        assert_eq!(
            args.get("model").and_then(serde_json::Value::as_str),
            Some("x:y")
        );
        assert_eq!(
            args.get("compaction").and_then(serde_json::Value::as_bool),
            Some(true)
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
            parsed_command(&cli),
            CliCommand::Character { subcommand, .. } => {
                assert!(matches!(subcommand, Some(CharacterCommand::Info)));
            }
        );
    }

    #[test]
    fn parse_status() {
        let cli = parse(&["status"]);
        assert_variant!(
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Debug {
                subcommand: Some(DebugCommand::TickNow),
            } => {}
        );
    }

    #[test]
    fn parse_debug_status_dormant() {
        let cli = parse(&["debug", "heartbeat_status_dormant"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Debug {
                subcommand: Some(DebugCommand::StatusDormant),
            } => {}
        );
    }

    #[test]
    fn parse_debug_status_active() {
        let cli = parse(&["debug", "heartbeat_status_active"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Debug {
                subcommand: Some(DebugCommand::StatusActive),
            } => {}
        );
    }

    #[test]
    fn parse_model_list() {
        let cli = parse(&["model"]);
        assert_variant!(
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Model { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(ModelCommand::Use { name, target })
                        if target.is_bare() && name == "claude-haiku-4-5-20251001"
                ));
            }
        );
    }

    #[test]
    fn parse_model_info() {
        let cli = parse(&["model", "info", "opus"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Model { subcommand, .. } => {
                assert!(matches!(
                    subcommand,
                    Some(ModelCommand::Info { name: Some(n), .. }) if n == "opus"
                ));
            }
        );
    }

    #[test]
    fn parse_model_all_flag() {
        let cli = parse(&["model", "--all"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Model { all, .. } => assert!(all),
        );
    }

    #[test]
    fn parse_model_favorites_flag() {
        for argv in [&["model", "--favorites"][..], &["model", "-f"][..]] {
            let cli = parse(argv);
            assert_variant!(
                parsed_command(&cli),
                CliCommand::Model { favorites, all, .. } => {
                    assert!(favorites, "{argv:?}");
                    assert!(!all, "{argv:?}");
                },
            );
        }
    }

    #[test]
    fn favorites_and_all_are_opposite_views_not_a_combination() {
        assert!(Cli::try_parse_from(["shore", "model", "--favorites", "--all"]).is_err());
    }

    #[test]
    fn the_favorites_flag_narrows_the_listing_rather_than_changing_command() {
        let cli = parse(&["model", "--favorites"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).expect("a command");
        assert_eq!(name, "list_models");
        assert_eq!(args.get("favorites_only"), Some(&serde_json::json!(true)));
        assert!(args.get("include_hidden").is_none());
    }

    #[test]
    fn fav_and_unfav_carry_the_direction_rather_than_toggling_blind() {
        for (verb, want) in [("fav", true), ("unfav", false)] {
            let cli = parse(&["model", verb, "kimi-k3"]);
            let (name, args) = to_swp_command(parsed_command(&cli), None).expect("a command");
            assert_eq!(name, "favorite_model", "{verb}");
            assert_eq!(
                args.get("name"),
                Some(&serde_json::json!("kimi-k3")),
                "{verb}"
            );
            assert_eq!(
                args.get("favorite"),
                Some(&serde_json::json!(want)),
                "{verb}"
            );
        }
    }

    #[test]
    fn parse_model_setting_show() {
        let cli = parse(&["model", "setting"]);
        assert_variant!(
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Provider { subcommand, .. } => assert!(subcommand.is_none()),
        );
    }

    #[test]
    fn parse_provider_models() {
        let cli = parse(&["provider", "models", "openrouter"]);
        assert_variant!(
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
                parsed_command(&cli),
                CliCommand::Compact { keep_turns, restart, .. } => {
                    assert_eq!(*keep_turns, expected, "{args:?}");
                    assert_eq!(*restart, expected_restart, "{args:?}");
                }
            );
        }
    }

    #[test]
    fn parse_segments_and_clear() {
        let segments = parse(&["segments", "show", "4"]);
        assert_variant!(
            parsed_command(&segments),
            CliCommand::Segments {
                subcommand: Some(SegmentsCommand::Show { index }),
                ..
            } => assert_eq!(*index, 4),
        );
        let retry = parse(&["segments", "retry", "4"]);
        assert_variant!(
            parsed_command(&retry),
            CliCommand::Segments {
                subcommand: Some(SegmentsCommand::Retry { index }),
                ..
            } => assert_eq!(*index, 4),
        );
        let clear = parse(&["clear", "--exclude", "--note", "bad branch"]);
        assert_variant!(
            parsed_command(&clear),
            CliCommand::Clear { exclude, note, .. } => {
                assert!(*exclude);
                assert_eq!(note.as_deref(), Some("bad branch"));
            }
        );
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Config {
                subcommand: Some(ConfigCommand::Tools { json }),
                ..
            } => assert!(!json)
        );
        let (name, _args) =
            to_swp_command(parsed_command(&cli), None).expect("must map to a command");
        assert_eq!(name, "tools");
    }

    #[test]
    fn a_dotted_key_under_tools_is_still_a_key_read() {
        let cli = parse(&["config", "get", "tools.enabled_tools"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Config { subcommand, .. } => {
                assert_variant!(
                    subcommand,
                    Some(ConfigCommand::Get { key, .. }) => {
                        assert_eq!(key, "tools.enabled_tools");
                    }
                );
            }
        );
        let (name, args) =
            to_swp_command(parsed_command(&cli), None).expect("must map to a command");
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
            parsed_command(&cli),
            CliCommand::Config { path, .. } => {
                assert!(path);
            }
        );
    }

    #[test]
    fn parse_leading_addr_flag() {
        let cli = parse(&["--addr", "127.0.0.1:7320", "status"]);
        assert_eq!(cli.addr.as_deref(), Some("127.0.0.1:7320"));
        assert!(matches!(cli.command, Some(CliCommand::Status { .. })));
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
                misplaced(&["msg", "send", flag, "0.8", "hello"]),
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
            &["msg", "send", "--", "-c", "is a flag"][..],
        ] {
            assert_eq!(misplaced(args), None, "{args:?}");
        }
    }

    #[test]
    fn a_mistyped_flag_is_not_read_as_a_message_reference() {
        for args in [
            &["log", "--conten"][..],
            &["msg", "edit", "--conten"][..],
            &["msg", "delete", "--conten"][..],
            &["msg", "delete", "-1", "--conten"][..],
            &["msg", "alt", "--conten"][..],
        ] {
            let err = parse_error(args);
            assert!(
                err.to_string().contains("is not a message reference"),
                "{args:?} gave: {err}"
            );
        }
        let log = parse(&["log", "-1"]);
        assert_variant!(
            parsed_command(&log),
            CliCommand::Log { msg_ref, .. } => {
                assert_eq!(msg_ref.as_deref(), Some("-1"));
            }
        );
        let delete = parse(&["msg", "delete", "-1", "-2"]);
        assert_variant!(
            parsed_msg(&delete),
            MsgCommand::Delete { msg_refs, .. } => {
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
                parse_error(&["msg", "send", flag, "0.8", "hi"]).kind(),
                clap::error::ErrorKind::UnknownArgument,
                "{flag}"
            );
        }
    }

    #[test]
    fn send_maps_to_none() {
        let cmd = msg(MsgCommand::Send {
            message: vec!["hi".into()],
            images: vec![],
            system: false,
        });
        assert!(to_swp_command(&cmd, None).is_none());
    }

    #[test]
    fn regen_maps_to_none() {
        let cmd = msg(MsgCommand::Regen { guidance: None });
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
            Some(CliCommand::Debug {
                subcommand: Some(DebugCommand::KeepalivePingNow)
            })
        ));
    }

    #[test]
    fn debug_tool_sends_pairs_as_strings_for_the_daemon_to_coerce() {
        let cli = parse(&["debug", "tool", "read", "path=notes.md", "offset=3"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
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
        let (_name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
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
        let (_name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
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
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
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
            Some(CliCommand::Debug {
                subcommand: Some(DebugCommand::SessionActivate)
            })
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
                target: ModelTarget::default(),
            }),
            info: false,
            reset: false,
            all: false,
            favorites: false,
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
            favorites: false,
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
                target: ModelTarget::default(),
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            favorites: false,
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
                target: ModelTarget::default(),
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            favorites: false,
            json: false,
        };
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "key"), "temperature");
        assert_eq!(arg(&args, "value"), "0.8");
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
                target: ModelTarget::default(),
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            favorites: false,
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
                target: ModelTarget::default(),
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            favorites: false,
            json: false,
        };
        let (_, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(arg(&args, "scope"), "global");
    }

    #[test]
    fn the_background_model_is_reported_by_the_list_not_a_subcommand() {
        assert!(Cli::try_parse_from(["shore", "model", "--background"]).is_err());
        let (name, _) = to_swp_command(parsed_command(&parse(&["model"])), None).unwrap();
        assert_eq!(name, "list_models");
    }

    #[test]
    fn the_retired_background_subcommand_says_where_it_went() {
        assert_eq!(
            misplaced(&["model", "background"]),
            Some(FlagProblem::Retired(
                "model background",
                "every model role is listed by `shore model`; pin one with \
                 `shore model use --background=<heartbeat|compaction> <name>`, or \
                 bare `--background` for all of them",
            )),
        );
    }

    #[test]
    fn model_use_background_threads_the_task() {
        let cli = parse(&["model", "use", "--background=heartbeat", "kimi-k3"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "switch_model");
        assert_eq!(arg(&args, "name"), "kimi-k3");
        assert_eq!(arg(&args, "background_task"), "heartbeat");
    }

    #[test]
    fn model_use_without_background_omits_the_task() {
        let cli = parse(&["model", "use", "kimi-k3"]);
        let (_, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert!(args.get("background_task").is_none());
    }

    #[test]
    fn model_targets_cover_bare_named_and_explicit_all_for_every_verb() {
        for args in [
            &["model", "use", "--subagent", "opus"][..],
            &["model", "info", "--subagent"][..],
            &["model", "setting", "--subagent", "temperature", "0.3"][..],
            &["model", "reset", "--subagent"][..],
            &["model", "use", "--background", "opus"][..],
            &["model", "info", "--background"][..],
            &["model", "setting", "--background", "temperature", "0.3"][..],
            &["model", "reset", "--background"][..],
            &["model", "use", "--subagent=memory", "opus"][..],
            &["model", "info", "--subagent=memory"][..],
            &["model", "setting", "--subagent=memory", "temperature"][..],
            &["model", "reset", "--subagent=memory"][..],
            &["model", "use", "--background=heartbeat", "opus"][..],
            &["model", "info", "--background=heartbeat"][..],
            &["model", "setting", "--background=heartbeat", "temperature"][..],
            &["model", "reset", "--background=heartbeat"][..],
            &["model", "use", "--subagent=all", "opus"][..],
            &["model", "info", "--subagent=all"][..],
            &["model", "setting", "--subagent=all", "temperature"][..],
            &["model", "reset", "--subagent=all"][..],
            &["model", "use", "--background=all", "opus"][..],
            &["model", "info", "--background=all"][..],
            &["model", "setting", "--background=all", "temperature"][..],
            &["model", "reset", "--background=all"][..],
        ] {
            assert_eq!(misplaced(args), None, "{args:?}");
            assert!(
                Cli::try_parse_from(with_program_name(args)).is_ok(),
                "{args:?} should parse"
            );
        }
    }

    #[test]
    fn spaced_model_targets_are_rejected_for_every_verb() {
        for (flag, value) in [("--subagent", "all"), ("--background", "heartbeat")] {
            for args in [
                vec!["model", "use", flag, value, "opus"],
                vec!["model", "info", flag, value],
                vec!["model", "setting", flag, value, "temperature", "0.3"],
                vec!["model", "reset", flag, value],
            ] {
                assert_eq!(
                    misplaced(&args),
                    Some(FlagProblem::NeedsEquals(flag, value.to_owned())),
                    "{args:?}"
                );
            }
        }
    }

    #[test]
    fn an_unknown_spaced_subagent_is_caught_when_it_overflows_the_verb() {
        for args in [
            &["model", "use", "--subagent", "memory", "opus"][..],
            &["model", "info", "--subagent", "memory", "opus"][..],
            &[
                "model",
                "setting",
                "--subagent",
                "memory",
                "temperature",
                "0.3",
            ][..],
            &["model", "reset", "--subagent", "memory"][..],
        ] {
            assert_eq!(
                misplaced(args),
                Some(FlagProblem::NeedsEquals("--subagent", "memory".to_owned())),
                "{args:?}"
            );
        }
    }

    #[test]
    fn model_reset_background_threads_the_task() {
        let cli = parse(&["model", "reset", "--background=all"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "reset_model");
        assert_eq!(arg(&args, "background_task"), "all");
    }

    #[test]
    fn a_background_pin_needs_a_model_name() {
        assert!(Cli::try_parse_from(["shore", "model", "use", "--background=heartbeat"]).is_err());
    }

    #[test]
    fn model_setting_background_show_threads_task() {
        let cli = parse(&["model", "setting", "--background=compaction"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "model_settings");
        assert_eq!(arg(&args, "background_task"), "compaction");
    }

    #[test]
    fn model_setting_background_set_threads_task() {
        let cli = parse(&["model", "setting", "--background=all", "temperature", "0.5"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "key"), "temperature");
        assert_eq!(arg(&args, "value"), "0.5");
        assert_eq!(arg(&args, "background_task"), "all");
        assert_eq!(arg(&args, "scope"), "character");
    }

    #[test]
    fn model_setting_background_reset_threads_task() {
        let cli = parse(&[
            "model",
            "setting",
            "--background=heartbeat",
            "--reset",
            "reasoning_effort",
        ]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert!(arg(&args, "value").is_null());
        assert_eq!(arg(&args, "background_task"), "heartbeat");
    }

    #[test]
    fn model_setting_subagent_show_threads_the_name() {
        let cli = parse(&["model", "setting", "--subagent=librarian"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
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
            "--subagent=librarian",
            "temperature",
            "0.25",
        ]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "subagent"), "librarian");
        assert_eq!(arg(&args, "key"), "temperature");
        assert_eq!(arg(&args, "value"), "0.25");
    }

    #[test]
    fn model_setting_subagent_reset_threads_the_name() {
        let cli = parse(&[
            "model",
            "setting",
            "--subagent=librarian",
            "--reset",
            "temperature",
        ]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "subagent"), "librarian");
        assert!(arg(&args, "value").is_null());
    }

    #[test]
    fn model_setting_model_targets_a_catalog_name_without_switching() {
        let cli = parse(&["model", "setting", "--model", "opus", "top_p", "0.9"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "name"), "opus");
        assert!(args.get("subagent").is_none());
    }

    #[test]
    fn model_setting_targets_are_mutually_exclusive() {
        let combinations: [&[&str]; 6] = [
            &["--subagent=librarian", "--background=compaction"],
            &["--model", "opus", "--background=compaction"],
            &["--subagent=librarian", "--model", "opus"],
            &["--chat", "--background=compaction"],
            &["--chat", "--subagent=librarian"],
            &["--chat", "--model", "opus"],
        ];
        for pair in combinations {
            let mut argv = vec!["shore", "model", "setting"];
            argv.extend_from_slice(pair);
            assert!(
                Cli::try_parse_from(&argv).is_err(),
                "{pair:?} must not combine"
            );
        }
    }

    #[test]
    fn model_setting_without_background_omits_task() {
        let cli = parse(&["model", "setting", "temperature", "0.7"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
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
                target: ModelTarget::default(),
                model: None,
                json: false,
            }),
            info: false,
            reset: false,
            all: false,
            favorites: false,
            json: false,
        };
        let (_, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(arg(&args, "value"), "off");
    }

    #[test]
    fn model_setting_reasoning_aliases_are_sent_raw_for_the_daemon_to_normalize() {
        for synonym in ["none", "DISABLE", "Disabled", "unset", ""] {
            let cmd = CliCommand::Model {
                subcommand: Some(ModelCommand::Setting {
                    key: Some("reasoning_effort".into()),
                    value: Some(synonym.into()),
                    global: false,
                    reset: false,
                    target: ModelTarget::default(),
                    model: None,
                    json: false,
                }),
                info: false,
                reset: false,
                all: false,
                favorites: false,
                json: false,
            };
            let (_, args) = to_swp_command(&cmd, None).unwrap();
            assert_eq!(arg(&args, "value"), synonym, "alias {synonym:?}");
        }
    }

    #[test]
    fn parse_setting_value_leaves_all_coercion_to_the_daemon() {
        use serde_json::json;
        assert_eq!(
            parse_setting_value("zai_clear_thinking", "false"),
            json!("false")
        );
        assert_eq!(parse_setting_value("gemini_generation", "3"), json!("3"));
        assert_eq!(
            parse_setting_value("openrouter_provider", r#"{"order":["Anthropic"]}"#),
            json!(r#"{"order":["Anthropic"]}"#)
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
            to_swp_command(parsed_command(&parse(&["debug", "tool", "read"])), None).unwrap();
        assert_eq!(cmd, "run_tool");
        assert_eq!(
            arg(&plain, "describe"),
            false,
            "a bare `debug tool` still runs the tool",
        );

        let (_, described) = to_swp_command(
            parsed_command(&parse(&["debug", "tool", "read", "--describe"])),
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
        let values = footer
            .lines()
            .find(|candidate| candidate.contains("shore complete setting-values"))
            .expect("footer must shell out to `shore complete setting-values`");
        assert!(values.contains("(__shore_setting_key)"));
        assert!(!values.contains("not __shore_setting_key"));
    }

    #[test]
    fn fish_footer_completes_the_setting_target_flags() {
        let footer = fish_dynamic_completions_footer();
        let subagents = footer
            .lines()
            .find(|line| line.contains("string replace") && line.contains("--subagent="))
            .expect("footer must complete named sub-agents as --subagent=<name>");
        assert!(subagents.contains("shore complete subagents"));
        let models = footer
            .lines()
            .find(|line| line.contains(" -l model "))
            .expect("footer must complete --model values");
        assert!(models.contains("shore complete models"));
    }

    #[test]
    fn the_subagent_flag_completes_under_every_verb_that_takes_a_target() {
        let line = fish_dynamic_completions_footer()
            .lines()
            .find(|line| line.contains("string replace") && line.contains("--subagent="))
            .expect("footer must complete `--subagent=<name>` under `model`");
        for verb in ["use", "setting", "reset", "info"] {
            assert!(
                line.contains(&format!(" {verb}")),
                "`--subagent` must complete under `{verb}`: {line}"
            );
        }
        assert!(
            !line.contains("--subagent=all"),
            "bare `--subagent` already means all, so `all` is not a name to offer: {line}"
        );
    }

    #[test]
    fn fish_offers_model_targets_only_in_the_equals_spelling() {
        let footer = fish_dynamic_completions_footer();
        let (_, generated) = generated_for(Shell::Fish);
        for flag in ["background", "subagent"] {
            assert!(
                !generated.lines().any(|line| {
                    line.contains("__fish_shore_using_subcommand model")
                        && line.contains(&format!(" -l {flag} "))
                }),
                "fish must not describe --{flag} as taking a spaced argument"
            );
        }
        for spelling in [
            "--background",
            "--background=all",
            "--background=heartbeat",
            "--background=compaction",
            "--subagent",
            "--subagent=",
        ] {
            assert!(footer.contains(spelling), "missing {spelling}: {footer}");
        }
    }

    #[test]
    fn a_bare_subagent_flag_means_every_sub_agent() {
        let cli = parse(&["model", "setting", "--subagent", "temperature", "0.3"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "set_model_setting");
        assert_eq!(arg(&args, "subagent"), "all");
        assert_eq!(arg(&args, "value"), "0.3");
    }

    #[test]
    fn the_setting_key_guard_skips_target_flag_values() {
        let footer = fish_dynamic_completions_footer();
        let body = footer
            .split("function __shore_setting_key")
            .nth(1)
            .expect("footer must define __shore_setting_key");
        assert!(
            body.contains("contains -- $token --model"),
            "the guard must not mistake --model's value for the key: {body}"
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
            parsed_command(&cli),
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
        let cmd = msg(MsgCommand::Edit {
            msg_ref: "m1".into(),
            content: vec!["new".into(), "text".into()],
            json: false,
        });
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "edit");
        assert_eq!(arg(&args, "ref"), "m1");
        assert_eq!(arg(&args, "content"), "new text");
    }

    #[test]
    fn delete_maps_to_delete_command() {
        let cmd = msg(MsgCommand::Delete {
            msg_refs: vec!["m1".into()],
            json: false,
        });
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "delete");
        assert_eq!(arg(&args, "refs"), &serde_json::json!(["m1"]));
    }

    #[test]
    fn delete_sends_every_ref_as_one_list() {
        let cmd = msg(MsgCommand::Delete {
            msg_refs: vec!["-1".into(), "-2".into()],
            json: false,
        });
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "delete");
        assert_eq!(arg(&args, "refs"), &serde_json::json!(["-1", "-2"]));
    }

    #[test]
    fn alt_position_maps_to_alt_command() {
        let cmd = msg(MsgCommand::Alt {
            selector: Some("2".into()),
            msg_ref: Some("last".into()),
            json: false,
        });
        let (name, args) = to_swp_command(&cmd, None).unwrap();
        assert_eq!(name, "alt");
        assert_eq!(arg(&args, "position"), 2);
        assert_eq!(arg(&args, "ref"), "last");
    }

    #[test]
    fn alt_list_maps_to_list_alternatives_command() {
        let cmd = msg(MsgCommand::Alt {
            selector: Some("list".into()),
            msg_ref: None,
            json: false,
        });
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
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "subagent_trace");
        assert_eq!(arg(&args, "count"), 5);
        assert!(args.get("ids").is_none());
    }

    #[test]
    fn trace_subagent_with_id_asks_for_one_run() {
        let cli = parse(&["trace", "subagent", "toolu_01A"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "subagent_trace");
        assert_eq!(arg(&args, "ids"), &serde_json::json!(["toolu_01A"]));
        assert!(args.get("count").is_none());
    }

    #[test]
    fn log_subagent_tools_stays_on_the_conversation() {
        let cli = parse(&["log", "--subagent-tools"]);
        let (name, _) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "log");
    }

    #[test]
    fn trace_calls_diff_asks_for_a_comparison() {
        let cli = parse(&["trace", "calls", "42", "--diff"]);
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "call_log");
        assert_eq!(arg(&args, "id"), 42);
        assert_eq!(arg(&args, "diff"), true);
        assert!(args.get("against").is_none());
    }

    #[test]
    fn trace_calls_diff_against_pins_the_other_side() {
        let cli = parse(&["trace", "calls", "42", "--diff", "--against", "40"]);
        let (_, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(arg(&args, "against"), 40);
    }

    #[test]
    fn trace_calls_without_diff_asks_for_no_comparison() {
        let cli = parse(&["trace", "calls", "42"]);
        let (_, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert!(args.get("diff").is_none());
    }

    #[test]
    fn trace_calls_asks_for_the_wire_only_when_told_to() {
        let bare = parse(&["trace", "calls", "42"]);
        let (_, bare_args) = to_swp_command(parsed_command(&bare), None).unwrap();
        assert!(bare_args.get("wire").is_none());

        let asked = parse(&["trace", "calls", "42", "--wire"]);
        let (name, args) = to_swp_command(parsed_command(&asked), None).unwrap();
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
        let (name, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(name, "call_log");
        assert_eq!(arg(&args, "count"), 5);
        assert_eq!(arg(&args, "call_type"), "heartbeat");
    }

    #[test]
    fn trace_recall_reads_the_memory_recall_transcript() {
        let (command, args) = to_swp_command(
            parsed_command(&parse(&["trace", "recall", "-n", "4"])),
            None,
        )
        .unwrap();
        assert_eq!(command, "transcript");
        assert_eq!(arg(&args, "source"), "memory_recall");
        assert_eq!(
            args.get("count").and_then(serde_json::Value::as_u64),
            Some(4)
        );
    }

    #[test]
    fn trace_heartbeat_and_events_are_separate_views() {
        let (heartbeat, hb_args) =
            to_swp_command(parsed_command(&parse(&["trace", "heartbeat"])), None).unwrap();
        assert_eq!(heartbeat, "transcript");
        assert_eq!(arg(&hb_args, "source"), "heartbeat");

        let (events, _) =
            to_swp_command(parsed_command(&parse(&["trace", "events"])), None).unwrap();
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
    fn segment_changes_and_clear_map_to_daemon_commands() {
        let (show_name, show_args) =
            to_swp_command(parsed_command(&parse(&["segments", "show", "3"])), None).unwrap();
        assert_eq!(show_name, "segments");
        assert_eq!(arg(&show_args, "action"), "show");
        assert_eq!(arg(&show_args, "index"), 3);

        let (note_name, note_args) = to_swp_command(
            parsed_command(&parse(&["segments", "note", "2", "review later"])),
            None,
        )
        .unwrap();
        assert_eq!(note_name, "segments");
        assert_eq!(arg(&note_args, "action"), "note");
        assert_eq!(arg(&note_args, "index"), 2);
        assert_eq!(arg(&note_args, "value"), "review later");

        let (retry_name, retry_args) =
            to_swp_command(parsed_command(&parse(&["segments", "retry", "2"])), None).unwrap();
        assert_eq!(retry_name, "segments");
        assert_eq!(arg(&retry_args, "action"), "retry");
        assert_eq!(arg(&retry_args, "index"), 2);

        let (clear_name, clear_args) =
            to_swp_command(parsed_command(&parse(&["clear", "--exclude"])), None).unwrap();
        assert_eq!(clear_name, "clear");
        assert_eq!(arg(&clear_args, "exclude"), true);
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
            msg(MsgCommand::Edit {
                msg_ref: "m1".into(),
                content: vec!["text".into()],
                json: false,
            }),
            msg(MsgCommand::Delete {
                msg_refs: vec!["m1".into()],
                json: false,
            }),
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
                favorites: false,
            },
            CliCommand::Model {
                subcommand: Some(ModelCommand::Use {
                    name: "m".into(),
                    target: ModelTarget::default(),
                }),
                info: false,
                reset: false,
                all: false,
                json: false,
                favorites: false,
            },
            CliCommand::Model {
                subcommand: Some(ModelCommand::Info {
                    name: Some("m".into()),
                    target: ModelTarget::default(),
                }),
                info: false,
                reset: false,
                all: false,
                json: false,
                favorites: false,
            },
            CliCommand::Model {
                subcommand: None,
                info: false,
                reset: true,
                all: false,
                json: false,
                favorites: false,
            },
            CliCommand::Model {
                subcommand: Some(ModelCommand::Setting {
                    key: None,
                    value: None,
                    global: false,
                    reset: false,
                    target: ModelTarget::default(),
                    model: None,
                    json: false,
                }),
                info: false,
                reset: false,
                all: false,
                json: false,
                favorites: false,
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
            parsed_command(&cli),
            CliCommand::Completions { shell } => {
                assert_eq!(*shell, Shell::Fish);
            }
        );
    }

    #[test]
    fn parse_completions_bash() {
        let cli = parse(&["completions", "bash"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Completions { shell } => {
                assert_eq!(*shell, Shell::Bash);
            }
        );
    }

    #[test]
    fn parse_completions_zsh() {
        let cli = parse(&["completions", "zsh"]);
        assert_variant!(
            parsed_command(&cli),
            CliCommand::Completions { shell } => {
                assert_eq!(*shell, Shell::Zsh);
            }
        );
    }

    #[test]
    fn usage_export_defaults_to_csv_and_switches_on_tsv() {
        let (_, csv) = to_swp_command(parsed_command(&parse(&["usage", "export"])), None).unwrap();
        assert_eq!(arg(&csv, "export_csv"), true);
        assert_eq!(arg(&csv, "export_tsv"), false);

        let (_, tsv) =
            to_swp_command(parsed_command(&parse(&["usage", "export", "--tsv"])), None).unwrap();
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
        let (_, args) = to_swp_command(parsed_command(&parse(&["usage"])), None).unwrap();
        for action in ["export_csv", "export_tsv"] {
            assert_eq!(arg(&args, action), false, "{action} should be off");
        }
        assert!(arg(&args, "group_by").is_null());
    }

    #[test]
    fn the_character_filter_is_the_one_the_user_selected() {
        let (_, none) = to_swp_command(parsed_command(&parse(&["usage"])), None).unwrap();
        assert!(
            none.get("character")
                .is_some_and(serde_json::Value::is_null)
        );

        let (_, ada) = to_swp_command(parsed_command(&parse(&["usage"])), Some("ada")).unwrap();
        assert_eq!(arg(&ada, "character"), "ada");
    }

    #[test]
    fn parse_usage_no_call_type_flag() {
        let cli = parse(&["usage"]);
        assert_variant!(
            parsed_command(&cli),
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
            parsed_command(&cli),
            CliCommand::Usage { call_type, .. } => {
                assert_eq!(*call_type, Some("message".into()));
            }
        );
    }

    #[test]
    fn usage_last_hours_forwarded() {
        let cli = parse(&["usage", "--last", "4h"]);
        let (cmd, args) = to_swp_command(parsed_command(&cli), None).unwrap();
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
            ("cost-source", "cost_source"),
        ] {
            let (cmd, args) =
                to_swp_command(parsed_command(&parse(&["usage", "by", typed])), None).unwrap();
            assert_eq!(cmd, "usage");
            assert_eq!(arg(&args, "group_by"), wire, "`usage by {typed}`");
        }
    }

    #[test]
    fn grouping_by_a_dimension_does_not_filter_by_it() {
        let (_, args) =
            to_swp_command(parsed_command(&parse(&["usage", "by", "call-type"])), None).unwrap();
        assert!(
            arg(&args, "call_type").is_null(),
            "`usage by call-type` groups, it does not filter",
        );

        let (_, filtered) = to_swp_command(
            parsed_command(&parse(&[
                "usage",
                "by",
                "call-type",
                "--call-type",
                "message",
            ])),
            None,
        )
        .unwrap();
        assert_eq!(arg(&filtered, "group_by"), "call_type");
        assert_eq!(arg(&filtered, "call_type"), "message");
    }

    #[test]
    fn usage_call_type_value_sets_filter_not_grouping() {
        let cli = parse(&["usage", "--call-type", "message"]);
        let (_cmd, args) = to_swp_command(parsed_command(&cli), None).unwrap();
        assert_eq!(arg(&args, "call_type"), "message");
        assert!(arg(&args, "group_by").is_null());
    }

    #[test]
    fn usage_views_are_subcommands() {
        let (_, budgets) =
            to_swp_command(parsed_command(&parse(&["usage", "budgets"])), None).unwrap();
        assert_eq!(arg(&budgets, "budget").as_bool(), Some(true));

        let (_, anomalies) =
            to_swp_command(parsed_command(&parse(&["usage", "anomalies"])), None).unwrap();
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
    fn tui_only_commands_are_never_offered_by_the_shell() {
        let offers = |shell: Shell, script: &str, name: &str| {
            if shell == Shell::Fish {
                script.contains(&format!("-a \"{name}\""))
            } else if shell == Shell::Zsh {
                script.contains(&format!("'{name}:"))
            } else {
                script
                    .lines()
                    .filter(|line| line.trim_start().starts_with("opts="))
                    .any(|line| {
                        line.split_whitespace()
                            .any(|word| word.trim_matches('"') == name)
                    })
            }
        };

        for shell in [Shell::Fish, Shell::Zsh, Shell::Bash] {
            let (raw, filtered) = generated_for(shell);
            for name in ["view", "ui"] {
                assert!(
                    offers(shell, &raw, name),
                    "{shell:?} generator stopped listing `{name}`; the filter may be stale"
                );
                assert!(
                    !offers(shell, &filtered, name),
                    "{shell:?} still offers `{name}`:\n{filtered}"
                );
            }
            assert!(
                offers(shell, &filtered, "usage"),
                "{shell:?} lost its real subcommands: {filtered}"
            );
        }
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
            parsed_command(&cli),
            CliCommand::Complete { kind, .. } => {
                assert_eq!(*kind, CompleteKind::Models);
            }
        );
    }

    #[test]
    fn parse_complete_characters() {
        let cli = parse(&["complete", "characters"]);
        assert_variant!(
            parsed_command(&cli),
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
