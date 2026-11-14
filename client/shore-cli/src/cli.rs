use crate::completion::{Completes, provider_names, values};
use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum};
use clap_complete::Shell;
use shore_common::protocol::operations::{
    ActivateSession, BackgroundModelTarget, CallLogArgs, CancelCompaction, CheckConfiguration,
    ClearArgs, ClearConversation, CompactArgs, CompactConversation, ConfigArgs, Configuration,
    ConfigurationSchema, ConversationLog, ConversationLogArgs, DeleteMessages, DeleteMessagesArgs,
    DiagnosticCountArgs, DiaryArgs, Dream, DreamArgs, EditMessage, EditMessageArgs,
    EmptyOperationArgs, ExecuteTool, FavoriteModel, FavoriteModelArgs, GetMessage, GetMessageArgs,
    InjectSystem, InjectSystemArgs, InspectCalls, InspectModel, InspectSegments, ListMarks,
    ListMarksArgs, ListModels, ListModelsArgs, ListProviderModels, ListProviders, MarkArgs,
    MarkKind, MarkReply, MessageReferences, ModelInfoArgs, ModelPreferenceScope, ModelSettings,
    ModelSettingsArgs, Operation, PingKeepalive, Presence, PresenceArgs, ProviderArgs,
    ProviderModelsArgs, ReadDiary, ReadErrorLog, ReadHeartbeatLog, ReadStatus, ReadSubagentTraces,
    ReadTranscript, RefreshAllProviderModels, RefreshProviderModels, ResetModel, ResetModelArgs,
    RunToolArgs, ScheduleHeartbeat, SegmentAction, SegmentsArgs, SetHeartbeatActive,
    SetHeartbeatDormant, SetModelSetting, SetModelSettingArgs, SubagentTraceArgs, SwitchModel,
    SwitchModelArgs, ToolAccessListing, TranscriptArgs, TranscriptSource, UnmarkArgs, UnmarkReply,
    WatchCompaction,
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
        help_heading = LEADING_HEADING,
        add = values(Completes::Characters)
    )]
    pub character: Option<String>,

    /// Conversation thread to talk in (overrides SHORE_THREAD env var)
    #[arg(
        long,
        short = 't',
        env = "SHORE_THREAD",
        help_heading = LEADING_HEADING,
        add = values(Completes::Threads)
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
    ("--background", &["all", "wake", "compaction", "dreaming"]),
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

pub(crate) fn leading_flag_named(spelled: &str) -> Option<&'static str> {
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
        #[arg(allow_hyphen_values = true, value_parser = message_ref, add = values(Completes::MessageRefs))]
        msg_ref: Option<String>,

        /// Number of turns to show
        #[arg(short = 'n', long = "turns", default_value = "64")]
        count: u32,

        /// Read an archived segment instead of the current context
        #[arg(short = 's', long, conflicts_with_all = ["msg_ref", "follow"], add = values(Completes::Segments))]
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
        #[arg(long, value_name = "INDEX", conflicts_with_all = ["keep_turns", "restart", "watch", "cancel"], add = values(Completes::Segments))]
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
    /// wakes, stored sub-agent runs, and errors it hit.
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
        #[arg(required_unless_present = "all", conflicts_with = "all", add = values(Completes::Characters))]
        character: Option<String>,

        /// Back up every character and the global configuration into a folder;
        /// exporting into the same folder again only sends what changed
        #[arg(long)]
        all: bool,

        /// With --all, send everything again instead of only what changed
        #[arg(long, requires = "all")]
        full: bool,

        /// With --all, also back up the provider keys stored on the daemon;
        /// the backup then holds them in plain text
        #[arg(long, requires = "all")]
        include_secrets: bool,

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
        /// Show only one section; every section is shown by default
        #[arg(long, add = values(Completes::Sections))]
        section: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show the status the character sees for you, set it, or clear it
    #[command(display_order = 7)]
    Presence {
        /// The status to set: one of the statuses in your config's presence.statuses
        #[arg(add = values(Completes::Statuses))]
        status: Option<String>,

        /// Clear the status
        #[arg(long, conflicts_with = "status")]
        clear: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show the notes the character has left in its diary for its other turns
    #[command(display_order = 7)]
    Diary {
        /// Number of notes to show, newest last; 0 shows every note the diary keeps
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show the last dream and when the next one is due, or start one now
    #[command(display_order = 7)]
    Dream {
        /// Start a dream at the next autonomy tick instead of waiting for its schedule
        #[arg(long)]
        now: bool,

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

    /// List providers with their keys and logins; add, change or remove one
    #[command(args_conflicts_with_subcommands = true, add = provider_names())]
    #[command(display_order = 5)]
    #[command(
        after_help = "One provider:\n  shore provider <name>                      its transport, keys or logins, and catalog\n  shore provider <name> auth [--add [NAME]]  list its keys or logins, or add one (a key is asked for without echo; a login signs in through a link)\n  shore provider <name> auth <key> --test | --disable | --enable | --rename NEW | --replace | --remove\n  shore provider <name> auth <login> --login  sign a login in again\n  shore provider <name> auth --order a,b     the order keys are tried in\n  shore provider <name> use <key> | --auto   pin a key or login, or go back to choosing\n  shore provider <name> limit <key> --spend 20/month | off\n  shore provider <name> limit <login> --session 80% --weekly 50% | off\n  shore provider <name> set <setting> <value>  base-url, sdk, discover, ignore-models, ...\n  shore provider <name> enable | disable | remove | models | refresh\n\n`shore provider <name> --help` has the details."
    )]
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
        #[arg(long, global = true, add = values(Completes::UsagePeriods))]
        last: Option<String>,

        /// Filter by provider
        #[arg(long, global = true, add = values(Completes::UsageProviders))]
        provider: Option<String>,

        /// Filter by configured API key name ("unknown" matches older rows)
        #[arg(long, global = true, add = values(Completes::UsageApiKeys))]
        api_key: Option<String>,

        /// Filter by model
        #[arg(long, global = true, add = values(Completes::UsageModels))]
        model: Option<String>,

        /// Filter by ledger call type, e.g. message, wake, or subagent
        #[arg(long, global = true, add = values(Completes::CallTypes))]
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

        /// New state. Defaults to `toggle`; `usage` and `budget` take their own values
        #[arg(add = values(Completes::ViewValues))]
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
}

#[derive(Subcommand, Debug)]
pub(crate) enum MsgCommand {
    /// Send a message
    Send {
        /// The message text
        message: Vec<String>,

        /// Attach image file(s) to the message
        #[arg(short = 'i', long = "image", value_hint = clap::ValueHint::FilePath)]
        images: Vec<String>,

        /// Inject as a system instruction instead of a user message
        #[arg(long)]
        system: bool,
    },

    /// Regenerate the last assistant response
    Regen {
        /// Show the new attempt the earlier ones and ask for something
        /// different. This doesn't dislike them
        #[arg(long)]
        another_take: bool,

        /// Why the shown attempt missed. The new attempt sees the earlier ones
        /// and this reason, and the shown attempt is disliked with it
        #[arg(short, long, alias = "guidance", short_alias = 'g')]
        reason: Option<String>,

        /// A reason tag from marks.tags in your config, alone or with
        /// --reason; repeat for more
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },

    /// Like a reply, or words in it
    Like(MarkOptions),

    /// Dislike a reply, or words in it
    Dislike(MarkOptions),

    /// Remove a like or dislike from a reply, or from words in it
    Unmark {
        /// Reply reference (last, -1, 3, or a message id, archived ones
        /// included); defaults to the latest reply
        #[arg(allow_negative_numbers = true, value_parser = message_ref, add = values(Completes::MessageRefs))]
        msg_ref: Option<String>,

        /// One-based attempt of the reply; defaults to the one shown
        #[arg(short, long)]
        attempt: Option<u64>,

        /// The marked words; left off, the mark on the whole reply goes
        #[arg(short, long)]
        phrase: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Show the likes and dislikes on a reply's attempts
    Marks {
        /// Reply references (last, -1, 3, or message ids, archived ones
        /// included); defaults to the latest reply
        #[arg(allow_negative_numbers = true, value_parser = message_ref, add = values(Completes::MessageRefs))]
        msg_refs: Vec<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// List or select alternate responses for the latest assistant message
    Alt {
        /// Selector: list, prev, next, last, first, or 1-based alternate position
        #[arg(allow_hyphen_values = true, value_parser = message_ref, add = values(Completes::AltSelectors))]
        selector: Option<String>,

        /// Assistant message reference (defaults to latest assistant)
        #[arg(long = "ref", allow_hyphen_values = true, value_parser = message_ref, add = values(Completes::MessageRefs))]
        msg_ref: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Replace the content of a message (last, -1, 3, etc.)
    Edit {
        /// Message reference (last, -1, -2, 3, etc.)
        #[arg(allow_hyphen_values = true, value_parser = message_ref, add = values(Completes::MessageRefs))]
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
        #[arg(required = true, allow_negative_numbers = true, value_parser = message_ref, add = values(Completes::MessageRefs))]
        msg_refs: Vec<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args, Debug)]
pub(crate) struct MarkOptions {
    /// Reply reference (last, -1, 3, or a message id, archived ones
    /// included); defaults to the latest reply
    #[arg(allow_negative_numbers = true, value_parser = message_ref, add = values(Completes::MessageRefs))]
    pub(crate) msg_ref: Option<String>,

    /// One-based attempt of the reply; defaults to the one shown
    #[arg(short, long)]
    pub(crate) attempt: Option<u64>,

    /// Words from the reply to mark instead of the whole reply
    #[arg(short, long)]
    pub(crate) phrase: Option<String>,

    /// Why, in your own words
    #[arg(short, long)]
    pub(crate) reason: Option<String>,

    /// A reason tag from marks.tags in your config; repeat for more
    #[arg(long = "tag", value_name = "TAG")]
    pub(crate) tags: Vec<String>,

    /// Output raw JSON
    #[arg(long)]
    pub(crate) json: bool,
}

#[derive(Subcommand, Debug)]
pub(crate) enum SegmentsCommand {
    /// Show the messages stored in a segment
    Show {
        #[arg(add = values(Completes::Segments))]
        index: u32,
    },

    /// Show which thread and segment hold each message, by the ids chat log
    /// results list, so the right segment can be excluded
    Find {
        #[arg(required = true, value_name = "MSG_ID")]
        msg_ids: Vec<String>,
    },

    /// Exclude a segment from history search
    Exclude {
        #[arg(add = values(Completes::Segments))]
        index: u32,
    },

    /// Include a previously excluded segment in history search
    Include {
        #[arg(add = values(Completes::Segments))]
        index: u32,
    },

    /// Set a segment label, omit LABEL to clear it, or have a model write one with --auto
    Label {
        #[arg(add = values(Completes::Segments))]
        index: u32,
        #[arg(conflicts_with = "auto")]
        label: Option<String>,
        /// Ask a model to label the segment; one that already has a label is left alone
        #[arg(long)]
        auto: bool,
        /// With --auto, write a new label over the one the segment has
        #[arg(long, requires = "auto")]
        replace: bool,
        /// With --auto, the model to ask instead of the chat model
        #[arg(long, requires = "auto", add = values(Completes::Models))]
        model: Option<String>,
    },

    /// Set a segment note, or omit NOTE to clear it
    Note {
        #[arg(add = values(Completes::Segments))]
        index: u32,
        note: Option<String>,
    },
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

    /// Completes this key accepts, for completion and for the error text when a
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
        #[arg(value_parser = segment_target, add = values(Completes::SegmentSteps))]
        target: SegmentTarget,
    },

    /// Switch to another thread, in the order the thread menu lists them
    Thread {
        /// `next` or `previous` to step through the threads, or `unread` to
        /// open the next one with messages you haven't seen
        target: ThreadStep,
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
        #[arg(add = values(Completes::ImageTargets))]
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
        #[arg(add = values(Completes::BoundKeys))]
        key: String,

        /// Free it from the every-mode bindings rather than normal mode
        #[arg(long)]
        global: bool,
    },

    /// Leave the TUI
    Quit,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ThreadStep {
    Next,
    Previous,
    Unread,
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

/// Background task to retarget `shore model setting` at. `all` targets wakes
/// and compaction together and errors if they resolve to different models, or,
/// when only showing settings, if their own settings differ. Dreaming is only
/// ever targeted by name.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackgroundTarget {
    All,
    Wake,
    Compaction,
    Dreaming,
}

impl BackgroundTarget {
    pub(crate) fn as_protocol_target(self) -> BackgroundModelTarget {
        match self {
            Self::All => BackgroundModelTarget::All,
            Self::Wake => BackgroundModelTarget::Wake,
            Self::Compaction => BackgroundModelTarget::Compaction,
            Self::Dreaming => BackgroundModelTarget::Dreaming,
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
    Trigger,
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
            Self::Trigger => CanonicalDimension::Trigger,
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
        #[arg(add = values(Completes::Calls))]
        id: Option<i64>,

        /// Number of calls to list
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Filter by ledger call type, or require that type when dumping an id
        #[arg(long, add = values(Completes::CallTypes))]
        call_type: Option<String>,

        /// Also show what changed since the previous call
        #[arg(long, requires = "id")]
        diff: bool,

        /// Compare against this call id instead of the previous one
        #[arg(long, requires = "diff", value_name = "ID", add = values(Completes::Calls))]
        against: Option<i64>,

        /// Show the raw HTTP request and response bodies in full, untruncated
        #[arg(long, requires = "id")]
        wire: bool,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// The wake transcript: what each wake thought, the tools it called
    /// and their results, and the model that served it
    Heartbeat {
        /// Number of entries to show
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// The dream transcript: what each dream read and changed, round by round
    Dreams {
        /// Number of entries to show
        #[arg(short = 'n', long = "count", default_value = "20")]
        count: u32,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// The wake timeline: woken, dormant, user back, timeout
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
        #[arg(add = values(Completes::SubagentRuns))]
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

    /// Background tasks: bare means wakes and compaction; naming one requires =compaction, =wake or =dreaming
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
        conflicts_with_all = ["chat", "background"],
        add = values(Completes::Subagents)
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
    /// Bare, this sets the character's chat model, which every thread without a model of its
    /// own uses. With --thread (or SHORE_THREAD) it gives just that thread its own model.
    /// Every other target writes the config file,
    /// which is global: `--background=compaction` and `=dreaming` write `<task>.model`, `--background=wake` writes `triggers.model`, the model wakes run on,
    /// bare `--background` writes `triggers.model` and `compaction.model` but never `dreaming.model`; `--subagent=<name>` writes `subagents.<name>.model`,
    /// and bare `--subagent` writes `subagents.model`.
    Use {
        /// Model name or provider:model_id
        #[arg(add = values(Completes::Models))]
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
        #[arg(add = values(Completes::Models))]
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
    /// A background task's settings sit on top of its model's: wakes,
    /// compaction and dreaming take whatever their model has, chat's when they
    /// share it, and override only the keys set for them, so tuning a task never
    /// moves chat. Bare --background writes the same value for wakes and
    /// compaction; dreaming takes its own with --background=dreaming.
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
        #[arg(add = values(Completes::SettingKeys))]
        key: Option<String>,

        /// Value to save; true/false for booleans, off/none to stop reasoning
        #[arg(add = values(Completes::SettingValues))]
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
        #[arg(long, conflicts_with_all = ["chat", "background", "subagent"], add = values(Completes::Models))]
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
        #[arg(add = values(Completes::Models))]
        name: String,
    },

    /// Drop a model's favorite mark
    Unfav {
        /// Model name or provider:model_id
        #[arg(add = values(Completes::FavoriteModels))]
        name: String,
    },

    /// Drop a saved selection and fall back to what it would inherit
    ///
    /// Bare, this clears the character's chat model, so it falls back to chat.model or the first
    /// configured model. With --thread (or SHORE_THREAD) it clears just that thread's own
    /// model, so the thread uses the character's again. Other targets clear
    /// the config keys `use` would have written, so the role falls back the
    /// way it did before anything was pinned. Bare --background clears
    /// triggers.model and compaction.model; bare --subagent clears subagents.model
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
        #[arg(add = values(Completes::Characters))]
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
        #[arg(add = values(Completes::Characters))]
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
        #[arg(add = values(Completes::Threads))]
        name: String,
    },

    /// Start a new thread. It begins empty, and when it gets long it trims its oldest turns into the archive, unless --compaction is set
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
        #[arg(long = "file", value_name = "PATH", add = values(Completes::WorkspaceFiles))]
        files: Vec<String>,

        /// Chat model for this thread alone
        #[arg(long, add = values(Completes::Models))]
        model: Option<String>,

        /// When this thread gets long, compact it into memory as the home thread does, instead of trimming its oldest turns into the archive. `shore compact` works either way
        #[arg(long)]
        compaction: bool,
    },

    /// Set or clear a thread's label
    Label {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,

        /// New label; omit to clear it
        label: Option<String>,
    },

    /// Set or clear what a thread is for. The character sees it in that thread's prompt
    Purpose {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,

        /// A line or two; omit to clear it
        purpose: Option<String>,
    },

    /// Set the workspace files kept in a thread's prompt, next to MEMORY.md
    Files {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,

        /// Paths relative to the workspace root or [[links]], like [[notes]] or [[lighthouse/]]; omit all to clear the list
        #[arg(add = values(Completes::WorkspaceFiles))]
        files: Vec<String>,
    },

    /// Lock a thread's label, purpose and files, so only you change them. The character can still edit the files themselves
    Lock {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,
    },

    /// Unlock a thread, so the character can change its label, purpose and files again with edit_thread
    Unlock {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,
    },

    /// Choose what happens when a thread gets long: compact it into memory, or trim its oldest turns into the archive
    Compaction {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,

        /// `on` compacts into memory, as the home thread does; `off` trims into the archive
        #[arg(value_parser = ["on", "off"])]
        mode: String,
    },

    /// Move a thread to another place in the list, or into or out of a folder. The home thread stays at the top
    Move {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,

        /// Folder to put it in
        #[arg(long, conflicts_with = "no_folder", add = values(Completes::Folders))]
        folder: Option<String>,

        /// Take it out of its folder
        #[arg(long)]
        no_folder: bool,

        /// Thread to place it above; omit for the end of the list
        #[arg(long, add = values(Completes::Threads))]
        before: Option<String>,
    },

    /// Choose how threads outside folders are listed: by last activity, or in the order you put them
    Sort {
        #[arg(value_parser = ["activity", "manual"])]
        mode: String,
    },

    /// Named groups of threads
    #[command(subcommand)]
    Folder(ThreadFolderCommand),

    /// Pin a thread to its own chat model, or clear the pin to inherit the character's
    #[command(hide = true)]
    Model {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,

        /// Model to pin, as `provider:model_id`; omit to clear the pin
        #[arg(add = values(Completes::Models))]
        model: Option<String>,
    },

    /// Make a thread home. This is where a wake runs when its trigger names no thread
    Home {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
        name: String,
    },

    /// Retire a thread: its messages go to the archive and stay searchable
    Archive {
        /// Thread id
        #[arg(add = values(Completes::Threads))]
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
        #[arg(long, add = values(Completes::Threads))]
        from: Option<String>,

        /// Copy only the last N of your turns, with their whole tool exchanges.
        /// Omit to copy the complete active context
        #[arg(long)]
        turns: Option<u32>,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ThreadFolderCommand {
    /// Make a folder. It starts empty, at the end of the list
    New {
        /// Folder name
        name: String,
    },

    /// Rename a folder
    Rename {
        /// Folder name
        #[arg(add = values(Completes::Folders))]
        name: String,

        /// New name
        to: String,
    },

    /// Delete a folder. Its threads go back to the list outside folders; none is archived
    Delete {
        /// Folder name
        #[arg(add = values(Completes::Folders))]
        name: String,
    },

    /// Move a folder to another place among the folders
    Move {
        /// Folder name
        #[arg(add = values(Completes::Folders))]
        name: String,

        /// Folder to place it above; omit for the end
        #[arg(long, add = values(Completes::Folders))]
        before: Option<String>,
    },

    /// Choose how a folder lists its threads: by last activity, or in the order you put them
    Sort {
        /// Folder name
        #[arg(add = values(Completes::Folders))]
        name: String,

        #[arg(value_parser = ["activity", "manual"])]
        mode: String,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum ProviderCommand {
    /// List discovered + statically configured models for one provider.
    Models {
        /// Provider key (e.g. `openrouter`, `anthropic`)
        #[arg(add = values(Completes::Providers))]
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
        #[arg(add = values(Completes::Providers))]
        name: Option<String>,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// Add a provider; bare, lists the providers shore knows
    ///
    /// A known provider needs only its name, then asks for its key. A
    /// provider of your own needs --sdk and --base-url.
    Add(ProviderAddArgs),

    #[command(external_subcommand)]
    Named(Vec<String>),
}

#[derive(clap::Args, Debug, Clone, Default)]
pub(crate) struct KeySourceArgs {
    /// Read the key from standard input, e.g. piped from a password manager
    #[arg(long, conflicts_with = "env")]
    pub(crate) stdin: bool,

    /// Use the key in this environment variable on the daemon's host instead
    #[arg(long, value_name = "VAR")]
    pub(crate) env: Option<String>,

    /// Save the key without asking the provider whether it works
    #[arg(long)]
    pub(crate) no_check: bool,

    /// Send the key even though the connection to the daemon is neither local
    /// nor encrypted; only on a private network such as a VPN
    #[arg(long)]
    pub(crate) allow_unencrypted: bool,
}

#[derive(clap::Args, Debug, Clone)]
pub(crate) struct ProviderAddArgs {
    /// A known provider such as openrouter, or a name of your own
    #[arg(add = values(Completes::ProviderPresets))]
    pub(crate) name: Option<String>,

    /// SDK for a provider of your own: openai suits most OpenAI-compatible servers
    #[arg(long, add = values(Completes::Sdks))]
    pub(crate) sdk: Option<String>,

    /// Endpoint for a provider of your own, e.g. http://localhost:11434/v1
    #[arg(long)]
    pub(crate) base_url: Option<String>,

    /// The endpoint takes no API key
    #[arg(long, conflicts_with_all = ["env", "stdin", "no_key"])]
    pub(crate) no_auth: bool,

    /// Don't discover the provider's models
    #[arg(long)]
    pub(crate) no_discover: bool,

    /// Add the provider without asking for a key
    #[arg(long, conflicts_with_all = ["env", "stdin"])]
    pub(crate) no_key: bool,

    #[command(flatten)]
    pub(crate) key: KeySourceArgs,

    /// Output raw JSON
    #[arg(long)]
    pub(crate) json: bool,
}

#[derive(Parser, Debug)]
#[command(
    name = "shore provider <name>",
    about = "Show or change one provider",
    disable_help_subcommand = true
)]
pub(crate) struct ProviderTarget {
    #[command(subcommand)]
    pub(crate) action: Option<ProviderAction>,

    /// Output raw JSON
    #[arg(long, global = true)]
    pub(crate) json: bool,
}

#[derive(Subcommand, Debug)]
pub(crate) enum ProviderAction {
    /// Change a setting: base-url, sdk, discover, ignore-models, subscription,
    /// no-auth, or a default for its models such as max-output-tokens
    Set {
        #[arg(add = values(Completes::ProviderSettings))]
        setting: String,
        #[arg(required = true, num_args = 1.., add = values(Completes::ProviderSettingValues))]
        value: Vec<String>,
    },
    /// Return a setting to its default
    Unset {
        #[arg(add = values(Completes::ProviderSettings))]
        setting: String,
    },
    /// Turn the provider on
    Enable,
    /// Turn the provider off without removing it
    Disable,
    /// Remove the provider with its keys and their limits
    Remove {
        /// Don't ask first
        #[arg(long, short)]
        yes: bool,
    },
    /// List its keys or logins, or add, test, rename, reorder, disable or remove one
    Auth(AuthArgs),
    /// Use only one key or login, or --auto to go back to choosing
    Use {
        #[arg(add = values(Completes::Credentials))]
        credential: Option<String>,
        #[arg(long, conflicts_with = "credential")]
        auto: bool,
    },
    /// Cap what one key may spend, or how much of its windows one login may use
    Limit {
        #[arg(add = values(Completes::Credentials))]
        credential: String,
        /// A key's spending: 20/month, 5/day, or off
        #[arg(long, value_name = "USD[/PERIOD]", conflicts_with_all = ["session", "weekly"], add = values(Completes::LimitOff))]
        spend: Option<String>,
        /// A login's share of its 5-hour window: 80%, or off for the default
        #[arg(long, value_name = "PERCENT", add = values(Completes::LimitOff))]
        session: Option<String>,
        /// A login's share of its weekly window: 50%, or off for the default
        #[arg(long, value_name = "PERCENT", add = values(Completes::LimitOff))]
        weekly: Option<String>,
    },
    /// List the provider's models
    Models {
        /// Include hidden models
        #[arg(long)]
        all: bool,
    },
    /// Re-fetch its model catalog
    Refresh,
}

#[derive(clap::Args, Debug)]
pub(crate) struct AuthArgs {
    /// The key or login to act on, by name; a login also goes by its email
    #[arg(add = values(Completes::Credentials))]
    pub(crate) credential: Option<String>,

    /// Add a key named NAME (default, then key2, ...), asked for without echoing,
    /// or a login named NAME, signed in through a link. A login left unnamed goes
    /// by its email
    #[arg(long, num_args = 0..=1, default_missing_value = "", value_name = "NAME", conflicts_with = "credential")]
    pub(crate) add: Option<String>,

    /// Sign the login in again, through a link you open wherever you are
    #[arg(long, requires = "credential")]
    pub(crate) login: bool,

    #[command(flatten)]
    pub(crate) key: KeySourceArgs,

    /// Ask the provider whether the key or login works
    #[arg(long, requires = "credential")]
    pub(crate) test: bool,

    /// Replace the stored key with a new one; asks for it without echoing
    #[arg(long, requires = "credential")]
    pub(crate) replace: bool,

    /// Stop using the key or login without removing it
    #[arg(long, requires = "credential", conflicts_with = "enable")]
    pub(crate) disable: bool,

    /// Use the key or login again
    #[arg(long, requires = "credential")]
    pub(crate) enable: bool,

    /// Give the key or login a new name
    #[arg(long, requires = "credential", value_name = "NEW")]
    pub(crate) rename: Option<String>,

    /// Remove the key and its stored value, or the login and its saved sign-in
    #[arg(long, requires = "credential")]
    pub(crate) remove: bool,

    /// Try keys in this order, e.g. --order work,personal
    #[arg(long, value_delimiter = ',', value_name = "NAMES", conflicts_with_all = ["credential", "add"], add = values(Completes::Credentials))]
    pub(crate) order: Vec<String>,

    /// Don't ask before removing
    #[arg(long, short)]
    pub(crate) yes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeyInput {
    Prompt,
    Stdin,
    Env(String),
}

#[derive(Debug, Clone)]
pub(crate) struct KeyRequest {
    pub(crate) provider: String,
    pub(crate) name: Option<String>,
    pub(crate) replace: Option<String>,
    pub(crate) input: KeyInput,
    pub(crate) no_check: bool,
    pub(crate) allow_unencrypted: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SignInRequest {
    pub(crate) provider: String,
    pub(crate) credential: Option<String>,
    pub(crate) add: bool,
}

impl SignInRequest {
    pub(crate) fn args(&self) -> serde_json::Value {
        let mut args = serde_json::Map::new();
        _ = args.insert("provider".to_owned(), self.provider.clone().into());
        if let Some(credential) = self.credential.as_deref().filter(|name| !name.is_empty()) {
            _ = args.insert("credential".to_owned(), credential.into());
        }
        if self.add {
            _ = args.insert("add".to_owned(), true.into());
        }
        serde_json::Value::Object(args)
    }
}

impl KeyRequest {
    pub(crate) fn asks_for_a_key(&self) -> bool {
        self.replace.is_none() && self.input == KeyInput::Prompt
    }

    pub(crate) fn sign_in(&self) -> SignInRequest {
        SignInRequest {
            provider: self.provider.clone(),
            credential: self.name.clone(),
            add: true,
        }
    }

    pub(crate) fn operation(&self, secret: Option<&str>) -> (&'static str, serde_json::Value) {
        let mut args = serde_json::Map::new();
        _ = args.insert("provider".to_owned(), self.provider.clone().into());
        if self.no_check {
            _ = args.insert("no_check".to_owned(), true.into());
        }
        if self.allow_unencrypted {
            _ = args.insert("allow_unencrypted".to_owned(), true.into());
        }
        if let Some(value) = secret {
            _ = args.insert("secret".to_owned(), value.into());
        }
        if let Some(credential) = &self.replace {
            _ = args.insert("credential".to_owned(), credential.clone().into());
            return ("update_credential", serde_json::Value::Object(args));
        }
        if let Some(name) = self.name.as_deref().filter(|name| !name.is_empty()) {
            _ = args.insert("name".to_owned(), name.into());
        }
        if let KeyInput::Env(var) = &self.input {
            _ = args.insert("env".to_owned(), var.clone().into());
        }
        ("add_credential", serde_json::Value::Object(args))
    }
}

#[derive(Debug, Clone)]
pub(crate) enum ProviderPlan {
    Op {
        name: &'static str,
        args: serde_json::Value,
    },
    Confirm {
        prompt: String,
        yes: bool,
        name: &'static str,
        args: serde_json::Value,
    },
    Key(KeyRequest),
    SignIn(SignInRequest),
    Add {
        args: serde_json::Value,
        key: Option<KeyRequest>,
    },
}

fn key_input(key: &KeySourceArgs) -> KeyInput {
    match (&key.env, key.stdin) {
        (Some(var), _) => KeyInput::Env(var.clone()),
        (None, true) => KeyInput::Stdin,
        (None, false) => KeyInput::Prompt,
    }
}

fn spend_limit(raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim().trim_start_matches('$');
    if matches!(trimmed, "off" | "none" | "0") {
        return Ok(serde_json::json!({ "cost_usd": null }));
    }
    let (amount, every) = trimmed.split_once('/').unwrap_or((trimmed, ""));
    let cost: f64 = amount.trim().parse().map_err(|_| {
        format!(
            "--spend takes an amount in dollars and a period, like 20/month, or off; got {raw:?}"
        )
    })?;
    let period = match every.trim() {
        "" => None,
        "h" | "hour" | "hourly" => Some("hour"),
        "d" | "day" | "daily" => Some("day"),
        "w" | "wk" | "week" | "weekly" => Some("week"),
        "m" | "mo" | "month" | "monthly" => Some("month"),
        other => {
            return Err(format!(
                "--spend periods are hour, day, week or month; got {other:?}"
            ));
        }
    };
    Ok(period.map_or_else(
        || serde_json::json!({ "cost_usd": cost }),
        |window| serde_json::json!({ "cost_usd": cost, "period": window }),
    ))
}

#[expect(
    clippy::float_arithmetic,
    reason = "a window limit is typed as a percentage and sent as a fraction"
)]
fn window_limit(flag: &str, raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim();
    if matches!(trimmed, "off" | "none" | "default") {
        return Ok(serde_json::Value::Null);
    }
    let percent: f64 = trimmed
        .trim_end_matches('%')
        .trim()
        .parse()
        .map_err(|_| format!("--{flag} takes a percentage like 80%, or off; got {raw:?}"))?;
    if !(percent > 0.0 && percent <= 100.0) {
        return Err(format!(
            "--{flag} takes a percentage above 0 and at most 100, or off; got {raw:?}"
        ));
    }
    Ok((percent / 100.0).into())
}

fn window_limits(session: Option<&str>, weekly: Option<&str>) -> Result<serde_json::Value, String> {
    let mut windows = Vec::new();
    if let Some(raw) = session {
        windows.push(
            serde_json::json!({ "window": "session", "limit": window_limit("session", raw)? }),
        );
    }
    if let Some(raw) = weekly {
        windows
            .push(serde_json::json!({ "window": "weekly", "limit": window_limit("weekly", raw)? }));
    }
    Ok(serde_json::json!({ "windows": windows }))
}

fn provider_setting(
    provider: &str,
    setting: &str,
    given: Option<String>,
) -> Result<serde_json::Value, String> {
    let key = setting.trim().replace('-', "_");
    let Some(value) = given else {
        return Ok(serde_json::json!({ "provider": provider, "setting": key, "value": null }));
    };
    Ok(match key.as_str() {
        "base_url" | "sdk" => serde_json::json!({ "provider": provider, key: value }),
        "discover" | "subscription" | "no_auth" | "enabled" => {
            let on = match value.trim().to_ascii_lowercase().as_str() {
                "true" | "on" | "yes" | "1" => true,
                "false" | "off" | "no" | "0" => false,
                other => return Err(format!("{setting} is on or off; got {other:?}")),
            };
            serde_json::json!({ "provider": provider, key: on })
        }
        "ignore_models" => serde_json::json!({
            "provider": provider,
            "ignore_models": value.split(',').map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect::<Vec<_>>(),
        }),
        _ => serde_json::json!({ "provider": provider, "setting": key, "value": value }),
    })
}

pub(crate) fn provider_target(rest: &[String]) -> Result<(String, ProviderTarget), clap::Error> {
    let name = rest.first().cloned().unwrap_or_default();
    let target = ProviderTarget::try_parse_from(
        std::iter::once(format!("shore provider {name}")).chain(rest.iter().skip(1).cloned()),
    )?;
    Ok((name, target))
}

pub(crate) fn provider_plan(command: &ProviderCommand) -> Result<ProviderPlan, String> {
    let op = |name: &'static str, args: serde_json::Value| Ok(ProviderPlan::Op { name, args });
    match command {
        ProviderCommand::Models { name, all, .. } => op(
            "list_provider_models",
            serde_json::json!({ "provider": name, "include_hidden": all }),
        ),
        ProviderCommand::Refresh {
            name: Some(name), ..
        } => op(
            "refresh_provider_models",
            serde_json::json!({ "provider": name }),
        ),
        ProviderCommand::Refresh { name: None, .. } => {
            op("refresh_all_provider_models", serde_json::json!({}))
        }
        ProviderCommand::Add(ProviderAddArgs { name: None, .. }) => {
            op("provider_presets", serde_json::json!({}))
        }
        ProviderCommand::Add(
            add @ ProviderAddArgs {
                name: Some(name), ..
            },
        ) => {
            let mut args = serde_json::Map::new();
            _ = args.insert("name".to_owned(), name.clone().into());
            if let Some(sdk) = &add.sdk {
                _ = args.insert("sdk".to_owned(), sdk.clone().into());
            }
            if let Some(base_url) = &add.base_url {
                _ = args.insert("base_url".to_owned(), base_url.clone().into());
            }
            if add.no_auth {
                _ = args.insert("no_auth".to_owned(), true.into());
            }
            if add.no_discover {
                _ = args.insert("discover".to_owned(), false.into());
            }
            let key = (!add.no_auth
                && !add.no_key
                && add.sdk.as_deref() != Some("claude_agent")
                && name != "claude_agent")
                .then(|| KeyRequest {
                    provider: name.clone(),
                    name: None,
                    replace: None,
                    input: key_input(&add.key),
                    no_check: add.key.no_check,
                    allow_unencrypted: add.key.allow_unencrypted,
                });
            Ok(ProviderPlan::Add {
                args: serde_json::Value::Object(args),
                key,
            })
        }
        ProviderCommand::Named(rest) => {
            let (provider, target) = provider_target(rest).map_err(|error| error.to_string())?;
            named_plan(&provider, target.action)
        }
    }
}

fn named_plan(provider: &str, action: Option<ProviderAction>) -> Result<ProviderPlan, String> {
    let op = |name: &'static str, args: serde_json::Value| Ok(ProviderPlan::Op { name, args });
    let one = serde_json::json!({ "provider": provider });
    match action {
        None => op("provider_detail", one),
        Some(ProviderAction::Models { all }) => op(
            "list_provider_models",
            serde_json::json!({ "provider": provider, "include_hidden": all }),
        ),
        Some(ProviderAction::Refresh) => op("refresh_provider_models", one),
        Some(ProviderAction::Enable) => op(
            "update_provider",
            serde_json::json!({ "provider": provider, "enabled": true }),
        ),
        Some(ProviderAction::Disable) => op(
            "update_provider",
            serde_json::json!({ "provider": provider, "enabled": false }),
        ),
        Some(ProviderAction::Set { setting, value }) => op(
            "update_provider",
            provider_setting(provider, &setting, Some(value.join(" ")))?,
        ),
        Some(ProviderAction::Unset { setting }) => op(
            "update_provider",
            provider_setting(provider, &setting, None)?,
        ),
        Some(ProviderAction::Remove { yes }) => Ok(ProviderPlan::Confirm {
            prompt: format!("Remove provider {provider}, its stored keys and their limits?"),
            yes,
            name: "remove_provider",
            args: one,
        }),
        Some(ProviderAction::Use { credential, auto }) => match (credential, auto) {
            (Some(key), false) => op(
                "select_credential",
                serde_json::json!({ "provider": provider, "credential": key }),
            ),
            (None, true) => op(
                "select_credential",
                serde_json::json!({ "provider": provider, "credential": null }),
            ),
            _ => Err(format!(
                "name the key or login to use, or --auto: `shore provider {provider} use <name>`"
            )),
        },
        Some(ProviderAction::Limit {
            credential,
            spend,
            session,
            weekly,
        }) => {
            let mut args = match (&spend, &session, &weekly) {
                (Some(amount), _, _) => spend_limit(amount)?,
                (None, None, None) => {
                    return Err(
                        "say what to limit: --spend for a key, --session or --weekly for a login"
                            .to_owned(),
                    );
                }
                (None, _, _) => window_limits(session.as_deref(), weekly.as_deref())?,
            };
            if let Some(fields) = args.as_object_mut() {
                _ = fields.insert("provider".to_owned(), provider.into());
                _ = fields.insert("credential".to_owned(), credential.into());
            }
            op("set_credential_limit", args)
        }
        Some(ProviderAction::Auth(auth)) => auth_plan(provider, auth),
    }
}

fn auth_plan(provider: &str, auth: AuthArgs) -> Result<ProviderPlan, String> {
    let op = |name: &'static str, args: serde_json::Value| Ok(ProviderPlan::Op { name, args });
    if !auth.order.is_empty() {
        return op(
            "order_credentials",
            serde_json::json!({ "provider": provider, "order": auth.order }),
        );
    }
    let request = |name: Option<String>, replace: Option<String>| KeyRequest {
        provider: provider.to_owned(),
        name,
        replace,
        input: key_input(&auth.key),
        no_check: auth.key.no_check,
        allow_unencrypted: auth.key.allow_unencrypted,
    };
    if let Some(name) = auth.add {
        return Ok(ProviderPlan::Key(request(Some(name), None)));
    }
    let Some(credential) = auth.credential else {
        if auth.key.env.is_some() || auth.key.stdin {
            return Ok(ProviderPlan::Key(request(None, None)));
        }
        return op(
            "provider_detail",
            serde_json::json!({ "provider": provider }),
        );
    };
    let chosen = [
        auth.test,
        auth.replace,
        auth.disable,
        auth.enable,
        auth.rename.is_some(),
        auth.remove,
        auth.login,
    ]
    .iter()
    .filter(|on| **on)
    .count();
    if chosen > 1 {
        return Err(
            "pick one of --test, --replace, --disable, --enable, --rename, --login and --remove"
                .to_owned(),
        );
    }
    if auth.login {
        return Ok(ProviderPlan::SignIn(SignInRequest {
            provider: provider.to_owned(),
            credential: Some(credential),
            add: false,
        }));
    }
    if auth.replace {
        if auth.key.env.is_some() {
            return Err("--replace takes the new key itself; to read one from the environment, remove this key and add it with --env".to_owned());
        }
        return Ok(ProviderPlan::Key(request(None, Some(credential))));
    }
    let both = serde_json::json!({ "provider": provider, "credential": credential });
    if auth.remove {
        return Ok(ProviderPlan::Confirm {
            prompt: format!("Remove {credential} from {provider}?"),
            yes: auth.yes,
            name: "remove_credential",
            args: both,
        });
    }
    if auth.disable || auth.enable {
        return op(
            "update_credential",
            serde_json::json!({ "provider": provider, "credential": credential, "enabled": auth.enable }),
        );
    }
    if let Some(rename) = auth.rename {
        return op(
            "update_credential",
            serde_json::json!({ "provider": provider, "credential": credential, "rename": rename }),
        );
    }
    op("test_credential", both)
}

#[derive(Subcommand, Debug)]
pub(crate) enum ConfigCommand {
    /// Read one setting, or a whole section, by dotted key.
    ///
    /// `shore config get chat.model`
    /// `shore config get compaction`
    #[command(verbatim_doc_comment)]
    Get {
        /// Dotted key, e.g. triggers.enabled, daemon.listen_addr, mcp.beets.command
        #[arg(add = values(Completes::ConfigSections))]
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
        /// Dotted key, e.g. triggers.enabled, compaction.idle_after
        #[arg(add = values(Completes::ConfigKeys))]
        key: String,

        /// New value. Lists take a comma-separated string
        #[arg(add = values(Completes::ConfigValues))]
        value: String,

        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },

    /// List every settable key and the type it takes. `shore config` shows
    /// the current values; this shows what `set` will accept.
    Keys {
        /// Only keys whose name contains this substring
        #[arg(add = values(Completes::ConfigSections))]
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
    /// Start a wake in the character's home thread now
    #[command(name = "heartbeat_tick_now")]
    TickNow,
    /// Make the character dormant, so that nothing wakes it until your next message
    #[command(name = "heartbeat_status_dormant")]
    StatusDormant,
    /// Make the character active again, so that its triggers wake it
    #[command(name = "heartbeat_status_active")]
    StatusActive,
    /// Send a cache-keepalive ping now and report whether it read the cache
    #[command(name = "keepalive_ping_now")]
    KeepalivePingNow,
    /// Start this character's own time and keepalive without sending a
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
        #[arg(add = values(Completes::Tools))]
        name: String,

        /// Arguments as `key=value`, coerced to the tool's declared types
        #[arg(value_parser = parse_key_value, add = values(Completes::ToolArguments))]
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
        #[arg(add = values(Completes::Subagents))]
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
            ThreadCommand::Lock { name } => {
                Some(("thread_lock", json!({ "name": name, "locked": true })))
            }
            ThreadCommand::Unlock { name } => {
                Some(("thread_lock", json!({ "name": name, "locked": false })))
            }
            ThreadCommand::Compaction { name, mode } => Some((
                "thread_compaction",
                json!({ "name": name, "compaction": mode == "on" }),
            )),
            ThreadCommand::Move {
                name,
                folder,
                no_folder,
                before,
            } => {
                let target = if *no_folder {
                    Some("")
                } else {
                    folder.as_deref()
                };
                Some((
                    "thread_move",
                    json!({ "name": name, "folder": target, "before": before }),
                ))
            }
            ThreadCommand::Sort { mode } => {
                Some(("thread_sort", json!({ "by_activity": mode == "activity" })))
            }
            ThreadCommand::Folder(folder) => Some(match folder {
                ThreadFolderCommand::New { name } => {
                    ("thread_folder_create", json!({ "name": name }))
                }
                ThreadFolderCommand::Rename { name, to } => {
                    ("thread_folder_rename", json!({ "name": name, "to": to }))
                }
                ThreadFolderCommand::Delete { name } => {
                    ("thread_folder_delete", json!({ "name": name }))
                }
                ThreadFolderCommand::Move { name, before } => (
                    "thread_folder_move",
                    json!({ "name": name, "before": before }),
                ),
                ThreadFolderCommand::Sort { name, mode } => (
                    "thread_folder_sort",
                    json!({ "name": name, "by_activity": mode == "activity" }),
                ),
            }),
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
        CliCommand::Dream { now, .. } => operation_to_swp::<Dream>(DreamArgs {
            now: now.then_some(true),
        }),
        CliCommand::Diary { count, .. } => operation_to_swp::<ReadDiary>(DiaryArgs {
            count: Some(*count),
        }),
        CliCommand::Presence { status, clear, .. } => operation_to_swp::<Presence>(PresenceArgs {
            status: if *clear {
                Some(String::new())
            } else {
                status.clone()
            },
        }),

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
            let at = |action, index: &u32, value: Option<&Option<String>>| SegmentsArgs {
                action: Some(action),
                index: Some(u64::from(*index)),
                value: value.cloned(),
                ..SegmentsArgs::default()
            };
            operation_to_swp::<InspectSegments>(match subcommand {
                None => SegmentsArgs {
                    action: Some(SegmentAction::List),
                    ..SegmentsArgs::default()
                },
                Some(SegmentsCommand::Find { msg_ids }) => SegmentsArgs {
                    action: Some(SegmentAction::Find),
                    msg_ids: Some(msg_ids.clone()),
                    ..SegmentsArgs::default()
                },
                Some(SegmentsCommand::Show { index }) => at(SegmentAction::Show, index, None),
                Some(SegmentsCommand::Exclude { index }) => at(SegmentAction::Exclude, index, None),
                Some(SegmentsCommand::Include { index }) => at(SegmentAction::Include, index, None),
                Some(SegmentsCommand::Label {
                    index,
                    auto: true,
                    replace,
                    model,
                    ..
                }) => SegmentsArgs {
                    auto: Some(true),
                    replace: replace.then_some(true),
                    model: model.clone(),
                    ..at(SegmentAction::Label, index, None)
                },
                Some(SegmentsCommand::Label { index, label, .. }) => {
                    at(SegmentAction::Label, index, Some(label))
                }
                Some(SegmentsCommand::Note { index, note }) => {
                    at(SegmentAction::Note, index, Some(note))
                }
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
        MsgCommand::Like(options) => mark_to_swp(options, MarkKind::Like),
        MsgCommand::Dislike(options) => mark_to_swp(options, MarkKind::Dislike),
        MsgCommand::Unmark {
            msg_ref,
            attempt,
            phrase,
            ..
        } => operation_to_swp::<UnmarkReply>(UnmarkArgs {
            reference: msg_ref.clone(),
            position: *attempt,
            phrase: phrase.clone(),
        }),
        MsgCommand::Marks { msg_refs, .. } => operation_to_swp::<ListMarks>(ListMarksArgs {
            refs: (!msg_refs.is_empty()).then(|| MessageReferences::Many(msg_refs.clone())),
        }),
    }
}

fn mark_to_swp(options: &MarkOptions, kind: MarkKind) -> Option<(&'static str, serde_json::Value)> {
    operation_to_swp::<MarkReply>(MarkArgs {
        reference: options.msg_ref.clone(),
        position: options.attempt,
        kind,
        phrase: options.phrase.clone(),
        reason: options.reason.clone(),
        tags: (!options.tags.is_empty()).then(|| options.tags.clone()),
    })
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
        TraceCommand::Dreams { count, .. } => operation_to_swp::<ReadTranscript>(TranscriptArgs {
            source: Some(TranscriptSource::Dreaming),
            count: Some(*count),
        }),
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
            diff: diff.then_some(true),
            against: *against,
            wire: wire.then_some(true),
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
    if let CliCommand::Provider {
        subcommand: Some(subcommand),
        ..
    } = cmd
        && matches!(
            subcommand,
            ProviderCommand::Add(_) | ProviderCommand::Named(_)
        )
    {
        return match provider_plan(subcommand).ok()? {
            ProviderPlan::Op { name, args } | ProviderPlan::Confirm { name, args, .. } => {
                Some((name, args))
            }
            ProviderPlan::Add { args, .. } => Some(("add_provider", args)),
            ProviderPlan::SignIn(request) => Some(("start_sign_in", request.args())),
            ProviderPlan::Key(_) => None,
        };
    }
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
        Some(ProviderCommand::Add(_) | ProviderCommand::Named(_)) => None,
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
mod provider_key_tests {
    use super::{Cli, CliCommand, KeyInput, ProviderPlan, provider_plan};
    use clap::Parser;
    use serde_json::json;

    fn plan(argv: &[&str]) -> ProviderPlan {
        let cli = Cli::try_parse_from(std::iter::once("shore").chain(argv.iter().copied()))
            .unwrap_or_else(|error| panic!("{argv:?}: {error}"));
        let Some(CliCommand::Provider {
            subcommand: Some(subcommand),
            ..
        }) = cli.command
        else {
            panic!("{argv:?} is not a provider command");
        };
        provider_plan(&subcommand).unwrap_or_else(|error| panic!("{argv:?}: {error}"))
    }

    #[test]
    fn keys_are_asked_for_rather_than_taken_from_the_command_line() {
        let ProviderPlan::Key(request) = plan(&["provider", "openrouter", "auth", "--add", "work"])
        else {
            panic!("auth --add should ask for the key");
        };
        assert_eq!(
            request.input,
            KeyInput::Prompt,
            "the key is prompted for by default"
        );
        assert_eq!(
            request.operation(Some("sk-typed")),
            (
                "add_credential",
                json!({"provider": "openrouter", "name": "work", "secret": "sk-typed"})
            ),
            "the typed key travels only in the request",
        );
        let ProviderPlan::Key(piped) = plan(&[
            "provider",
            "openrouter",
            "auth",
            "--add",
            "--stdin",
            "--no-check",
        ]) else {
            panic!("--stdin should read the key");
        };
        assert_eq!(piped.input, KeyInput::Stdin, "--stdin reads standard input");
        let ProviderPlan::Key(env) = plan(&[
            "provider",
            "openrouter",
            "auth",
            "--add",
            "ci",
            "--env",
            "OPENROUTER_CI_KEY",
        ]) else {
            panic!("--env should point at a variable");
        };
        assert_eq!(
            env.operation(None),
            (
                "add_credential",
                json!({"provider": "openrouter", "name": "ci", "env": "OPENROUTER_CI_KEY"})
            ),
            "--env sends only the variable's name",
        );
        let ProviderPlan::Key(replace) =
            plan(&["provider", "openrouter", "auth", "work", "--replace"])
        else {
            panic!("--replace should ask for the new key");
        };
        assert_eq!(
            replace.operation(Some("sk-new")),
            (
                "update_credential",
                json!({"provider": "openrouter", "credential": "work", "secret": "sk-new"})
            ),
            "--replace changes the stored value",
        );
    }

    #[test]
    fn adding_a_known_provider_goes_on_to_its_key() {
        let ProviderPlan::Add {
            args,
            key: Some(key),
        } = plan(&["provider", "add", "openrouter"])
        else {
            panic!("adding openrouter should go on to its key");
        };
        assert_eq!(
            args,
            json!({"name": "openrouter"}),
            "a known provider needs only its name"
        );
        assert_eq!(key.input, KeyInput::Prompt, "then its key is asked for");
        let ProviderPlan::Add { key: None, .. } = plan(&[
            "provider",
            "add",
            "local",
            "--sdk",
            "openai",
            "--base-url",
            "http://x/v1",
            "--no-auth",
        ]) else {
            panic!("a provider without auth should not ask for a key");
        };
        let ProviderPlan::Add { key: None, .. } = plan(&["provider", "add", "claude_agent"]) else {
            panic!("claude_agent signs in with logins, not keys");
        };
    }

    #[test]
    fn removals_ask_first_unless_told_not_to() {
        let ProviderPlan::Confirm { yes: false, .. } = plan(&["provider", "openrouter", "remove"])
        else {
            panic!("removing a provider should ask first");
        };
        let ProviderPlan::Confirm { yes: true, .. } = plan(&[
            "provider",
            "openrouter",
            "auth",
            "work",
            "--remove",
            "--yes",
        ]) else {
            panic!("--yes should skip the question");
        };
    }
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
    fn a_regenerate_takes_another_take_or_a_reason_with_tags_and_old_guidance_is_a_reason() {
        type Case<'case> = (
            &'case [&'case str],
            bool,
            Option<&'case str>,
            &'case [&'case str],
        );
        let cases: [Case<'_>; 4] = [
            (&["msg", "regen"], false, None, &[]),
            (&["msg", "regen", "--another-take"], true, None, &[]),
            (
                &[
                    "msg",
                    "regen",
                    "-r",
                    "flat",
                    "--tag",
                    "too long",
                    "--tag",
                    "repetitive",
                ],
                false,
                Some("flat"),
                &["too long", "repetitive"],
            ),
            (
                &["msg", "regen", "-g", "warmer"],
                false,
                Some("warmer"),
                &[],
            ),
        ];
        for (args, take, why, tagged) in cases {
            let cli = parse(args);
            let CliCommand::Msg {
                command:
                    MsgCommand::Regen {
                        another_take,
                        reason,
                        tags,
                    },
            } = parsed_command(&cli)
            else {
                panic!("{args:?} should parse as a regenerate");
            };
            assert_eq!(*another_take, take, "{args:?}");
            assert_eq!(reason.as_deref(), why, "{args:?}");
            assert_eq!(tags, tagged, "{args:?}");
        }
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
            (&["msg", "regen", "--another-take"], None),
            (&["msg", "like"], Some(("mark", json!({"kind": "like"})))),
            (
                &[
                    "msg",
                    "dislike",
                    "-2",
                    "--attempt",
                    "1",
                    "--phrase",
                    "the sea",
                    "--reason",
                    "flat",
                    "--tag",
                    "too long",
                    "--tag",
                    "repetitive",
                ],
                Some((
                    "mark",
                    json!({"ref": "-2", "position": 1, "kind": "dislike", "phrase": "the sea", "reason": "flat", "tags": ["too long", "repetitive"]}),
                )),
            ),
            (&["msg", "unmark"], Some(("unmark", json!({})))),
            (
                &["msg", "unmark", "m_1", "-a", "2", "-p", "the sea", "--json"],
                Some((
                    "unmark",
                    json!({"ref": "m_1", "position": 2, "phrase": "the sea"}),
                )),
            ),
            (&["msg", "marks"], Some(("marks", json!({})))),
            (
                &["msg", "marks", "last", "-1"],
                Some(("marks", json!({"refs": ["last", "-1"]}))),
            ),
            (&["msg", "alt"], Some(("list_alternatives", json!({})))),
            (
                &["msg", "alt", "2", "--ref", "-1", "--json"],
                Some(("alt", json!({"ref": "-1", "position": 2}))),
            ),
            (&["log"], Some(("log", json!({"turns": 64})))),
            (
                &["log", "--turns", "50"],
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
                &["thread", "lock", "lighthouse"],
                Some(("thread_lock", json!({"name": "lighthouse", "locked": true}))),
            ),
            (
                &["thread", "unlock", "lighthouse"],
                Some((
                    "thread_lock",
                    json!({"name": "lighthouse", "locked": false}),
                )),
            ),
            (
                &["thread", "compaction", "lighthouse", "on"],
                Some((
                    "thread_compaction",
                    json!({"name": "lighthouse", "compaction": true}),
                )),
            ),
            (
                &[
                    "thread",
                    "move",
                    "lighthouse",
                    "--folder",
                    "Stories",
                    "--before",
                    "tide",
                ],
                Some((
                    "thread_move",
                    json!({"name": "lighthouse", "folder": "Stories", "before": "tide"}),
                )),
            ),
            (
                &["thread", "move", "lighthouse", "--no-folder"],
                Some((
                    "thread_move",
                    json!({"name": "lighthouse", "folder": "", "before": null}),
                )),
            ),
            (
                &["thread", "sort", "activity"],
                Some(("thread_sort", json!({"by_activity": true}))),
            ),
            (
                &["thread", "folder", "new", "Stories"],
                Some(("thread_folder_create", json!({"name": "Stories"}))),
            ),
            (
                &["thread", "folder", "sort", "Stories", "manual"],
                Some((
                    "thread_folder_sort",
                    json!({"name": "Stories", "by_activity": false}),
                )),
            ),
            (
                &["character", "info"],
                Some(("character_info", json!({"name": ""}))),
            ),
            (&["status"], Some(("status", json!({})))),
            (&["dream"], Some(("dream", json!({})))),
            (&["dream", "--now"], Some(("dream", json!({"now": true})))),
            (&["diary"], Some(("diary", json!({"count": 20})))),
            (&["diary", "-n", "0"], Some(("diary", json!({"count": 0})))),
            (&["presence"], Some(("presence", json!({})))),
            (
                &["presence", "at work"],
                Some(("presence", json!({"status": "at work"}))),
            ),
            (
                &["presence", "--clear"],
                Some(("presence", json!({"status": ""}))),
            ),
            (
                &["trace", "dreams", "-n", "3"],
                Some(("transcript", json!({"source": "dreaming", "count": 3}))),
            ),
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
            (&["provider", "add"], Some(("provider_presets", json!({})))),
            (
                &["provider", "add", "openrouter"],
                Some(("add_provider", json!({"name": "openrouter"}))),
            ),
            (
                &[
                    "provider",
                    "add",
                    "local",
                    "--sdk",
                    "openai",
                    "--base-url",
                    "http://localhost:11434/v1",
                    "--no-auth",
                ],
                Some((
                    "add_provider",
                    json!({"name": "local", "sdk": "openai", "base_url": "http://localhost:11434/v1", "no_auth": true}),
                )),
            ),
            (
                &["provider", "claude-agent"],
                Some(("provider_detail", json!({"provider": "claude-agent"}))),
            ),
            (
                &[
                    "provider",
                    "openrouter",
                    "set",
                    "base-url",
                    "https://example.com/v1",
                ],
                Some((
                    "update_provider",
                    json!({"provider": "openrouter", "base_url": "https://example.com/v1"}),
                )),
            ),
            (
                &["provider", "openrouter", "set", "discover", "off"],
                Some((
                    "update_provider",
                    json!({"provider": "openrouter", "discover": false}),
                )),
            ),
            (
                &["provider", "openrouter", "set", "max-output-tokens", "8192"],
                Some((
                    "update_provider",
                    json!({"provider": "openrouter", "setting": "max_output_tokens", "value": "8192"}),
                )),
            ),
            (
                &["provider", "openrouter", "disable"],
                Some((
                    "update_provider",
                    json!({"provider": "openrouter", "enabled": false}),
                )),
            ),
            (
                &["provider", "openrouter", "remove", "--yes"],
                Some(("remove_provider", json!({"provider": "openrouter"}))),
            ),
            (&["provider", "openrouter", "auth", "--add", "work"], None),
            (
                &[
                    "provider",
                    "openrouter",
                    "auth",
                    "--add",
                    "ci",
                    "--env",
                    "OPENROUTER_CI_KEY",
                ],
                None,
            ),
            (
                &["provider", "openrouter", "auth", "work", "--test"],
                Some((
                    "test_credential",
                    json!({"provider": "openrouter", "credential": "work"}),
                )),
            ),
            (
                &[
                    "provider",
                    "openrouter",
                    "auth",
                    "work",
                    "--rename",
                    "office",
                ],
                Some((
                    "update_credential",
                    json!({"provider": "openrouter", "credential": "work", "rename": "office"}),
                )),
            ),
            (
                &["provider", "openrouter", "auth", "--order", "work,personal"],
                Some((
                    "order_credentials",
                    json!({"provider": "openrouter", "order": ["work", "personal"]}),
                )),
            ),
            (
                &["provider", "openrouter", "use", "work"],
                Some((
                    "select_credential",
                    json!({"provider": "openrouter", "credential": "work"}),
                )),
            ),
            (
                &["provider", "openrouter", "use", "--auto"],
                Some((
                    "select_credential",
                    json!({"provider": "openrouter", "credential": null}),
                )),
            ),
            (
                &[
                    "provider",
                    "openrouter",
                    "limit",
                    "work",
                    "--spend",
                    "20/month",
                ],
                Some((
                    "set_credential_limit",
                    json!({"provider": "openrouter", "credential": "work", "cost_usd": 20.0, "period": "month"}),
                )),
            ),
            (
                &["provider", "openrouter", "limit", "work", "--spend", "off"],
                Some((
                    "set_credential_limit",
                    json!({"provider": "openrouter", "credential": "work", "cost_usd": null}),
                )),
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
            (
                &["msg", "delete", "-1", "-2", "--json"],
                Some(("delete", json!({"refs": ["-1", "-2"]}))),
            ),
            (
                &["msg", "delete", "last", "m_7"],
                Some(("delete", json!({"refs": ["last", "m_7"]}))),
            ),
            (&["segments"], Some(("segments", json!({"action": "list"})))),
            (
                &["segments", "find", "m_1", "m_2"],
                Some((
                    "segments",
                    json!({"action": "find", "msg_ids": ["m_1", "m_2"]}),
                )),
            ),
            (
                &["segments", "label", "3", "the trip"],
                Some((
                    "segments",
                    json!({"action": "label", "index": 3, "value": "the trip"}),
                )),
            ),
            (
                &["segments", "show", "4"],
                Some(("segments", json!({"action": "show", "index": 4}))),
            ),
            (
                &["trace", "calls"],
                Some(("call_log", json!({"count": 20}))),
            ),
            (
                &["trace", "calls", "5"],
                Some(("call_log", json!({"id": 5}))),
            ),
            (
                &["trace", "calls", "5", "--diff", "--against", "3"],
                Some(("call_log", json!({"id": 5, "diff": true, "against": 3}))),
            ),
            (
                &["trace", "calls", "5", "--wire"],
                Some(("call_log", json!({"id": 5, "wire": true}))),
            ),
            (&["model"], Some(("list_models", json!({})))),
            (&["model", "--reset"], Some(("reset_model", json!({})))),
            (&["model", "--info"], Some(("model_info", json!({})))),
            (
                &["model", "setting"],
                Some(("model_settings", json!({"overview": true}))),
            ),
            (
                &["model", "setting", "temperature"],
                Some(("model_settings", json!({"key": "temperature"}))),
            ),
            (
                &["model", "setting", "--model", "opus"],
                Some(("model_settings", json!({"name": "opus"}))),
            ),
            (
                &["usage", "export"],
                Some((
                    "usage",
                    json!({"last": null, "character": null, "provider": null, "api_key": null, "model": null, "call_type": null, "group_by": null, "budget": false, "anomalies": false, "export_csv": true, "export_tsv": false}),
                )),
            ),
            (
                &["usage", "export", "--tsv"],
                Some((
                    "usage",
                    json!({"last": null, "character": null, "provider": null, "api_key": null, "model": null, "call_type": null, "group_by": null, "budget": false, "anomalies": false, "export_csv": false, "export_tsv": true}),
                )),
            ),
            (
                &["usage", "by", "model"],
                Some((
                    "usage",
                    json!({"last": null, "character": null, "provider": null, "api_key": null, "model": null, "call_type": null, "group_by": "model", "budget": false, "anomalies": false, "export_csv": false, "export_tsv": false}),
                )),
            ),
            (
                &["usage", "by", "trigger"],
                Some((
                    "usage",
                    json!({"last": null, "character": null, "provider": null, "api_key": null, "model": null, "call_type": null, "group_by": "trigger", "budget": false, "anomalies": false, "export_csv": false, "export_tsv": false}),
                )),
            ),
            (
                &["usage", "by", "cost-source"],
                Some((
                    "usage",
                    json!({"last": null, "character": null, "provider": null, "api_key": null, "model": null, "call_type": null, "group_by": "cost_source", "budget": false, "anomalies": false, "export_csv": false, "export_tsv": false}),
                )),
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
    fn a_call_comparison_or_wire_dump_needs_a_call_id() {
        for argv in [
            &["trace", "calls", "--diff"][..],
            &["trace", "calls", "--wire"],
            &["trace", "calls", "5", "--against", "3"],
        ] {
            assert!(
                try_parse(argv).is_err(),
                "`shore {}` should be refused",
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
}
