use std::path::PathBuf;

use clap::{CommandFactory, Parser, ValueEnum};
use serde_json::{Value, json};

use crate::cli::{Cli, ViewKey, to_swp_command};

use super::keymap::{DEFAULT_GLOBAL_KEYS, DEFAULT_NORMAL_KEYS, DEFAULT_SHORTCUTS, RESERVED_KEYS};

const WIRE_EXAMPLES: &[&[&str]] = &[
    &["msg", "send", "hello"],
    &["msg", "send", "instruction", "--system"],
    &["msg", "regen", "--guidance", "consult memory"],
    &["msg", "edit", "last", "replacement"],
    &["msg", "edit", "last"],
    &["msg", "delete", "last", "-2"],
    &["msg", "alt", "list", "--ref", "last"],
    &["msg", "alt", "next", "--ref", "last"],
    &["msg", "alt", "2", "--ref", "last"],
    &["log"],
    &["log", "last"],
    &[
        "log",
        "--turns",
        "12",
        "--role",
        "system",
        "--follow",
        "--reasoning",
        "--tools",
        "--subagent-tools",
    ],
    &["compact", "0", "--restart"],
    &["clear", "--exclude", "--note", "archived"],
    &["segments"],
    &["segments", "show", "1"],
    &["segments", "exclude", "1"],
    &["segments", "include", "1"],
    &["segments", "label", "1", "label"],
    &["segments", "label", "1"],
    &["segments", "note", "1", "note"],
    &["segments", "note", "1"],
    &["character"],
    &["character", "use", "ada"],
    &["character", "info"],
    &["character", "new", "ada"],
    &["character", "delete", "ada", "--yes"],
    &["thread"],
    &["thread", "use", "work"],
    &[
        "thread",
        "new",
        "work",
        "--label",
        "Work",
        "--model",
        "fixture:model",
        "--compaction",
    ],
    &["thread", "label", "work", "Work"],
    &["thread", "label", "work"],
    &["thread", "model", "work", "fixture:model"],
    &["thread", "model", "work"],
    &["thread", "home", "work"],
    &["thread", "archive", "work"],
    &["thread", "fork", "branch", "--from", "work", "--turns", "3"],
    &["status", "--section", "session"],
    &["model"],
    &["model", "--all"],
    &["model", "--favorites"],
    &["model", "use", "fixture:model"],
    &["model", "use", "fixture:model", "--background"],
    &["model", "use", "fixture:model", "--background=heartbeat"],
    &["model", "use", "fixture:model", "--background=compaction"],
    &["model", "use", "fixture:model", "--subagent"],
    &["model", "use", "fixture:model", "--subagent=librarian"],
    &["model", "info"],
    &["model", "info", "fixture:model"],
    &["model", "setting"],
    &["model", "setting", "temperature", "0.5", "--global"],
    &[
        "model",
        "setting",
        "temperature",
        "--reset",
        "--model",
        "fixture:model",
    ],
    &[
        "model",
        "setting",
        "temperature",
        "0.5",
        "--subagent=librarian",
    ],
    &["model", "fav", "fixture:model"],
    &["model", "unfav", "fixture:model"],
    &["model", "reset"],
    &["model", "reset", "--background"],
    &["model", "reset", "--subagent"],
    &["provider"],
    &["provider", "models", "fixture", "--all"],
    &["provider", "refresh", "fixture"],
    &["provider", "refresh"],
    &["config"],
    &["config", "--check"],
    &["config", "--path"],
    &["config", "--toml", "--all"],
    &["config", "get", "defaults.stream"],
    &["config", "set", "defaults.stream", "true"],
    &["config", "keys", "defaults"],
    &["config", "reload", "--yes"],
    &["config", "tools"],
    &["trace"],
    &["trace", "calls", "--count", "3", "--call-type", "message"],
    &["trace", "calls", "3", "--diff", "--against", "1", "--wire"],
    &["trace", "heartbeat", "--count", "3"],
    &["trace", "events", "--count", "3"],
    &["trace", "errors", "--count", "3"],
    &["trace", "subagent", "--count", "3"],
    &["trace", "subagent", "tool_1"],
    &["debug"],
    &["debug", "heartbeat_tick_now"],
    &["debug", "heartbeat_status_dormant"],
    &["debug", "heartbeat_status_active"],
    &["debug", "keepalive_ping_now"],
    &["debug", "session_activate"],
    &["debug", "tool", "read", "path=notes.md", "--raw"],
    &["debug", "tool", "read", "--describe"],
    &[
        "debug",
        "tool",
        "read",
        "--input",
        "{\"path\":\"notes.md\"}",
    ],
    &["debug", "subagent", "librarian", "find a note", "--raw"],
    &[
        "usage",
        "--last",
        "7d",
        "--provider",
        "fixture",
        "--api-key",
        "fixture-key",
        "--model",
        "fixture:model",
        "--call-type",
        "message",
    ],
    &["usage", "by", "model"],
    &["usage", "by", "provider"],
    &["usage", "by", "call-type"],
    &["usage", "by", "kind"],
    &["usage", "by", "api-key"],
    &["usage", "by", "cost-source"],
    &["usage", "budgets"],
    &["usage", "cache"],
    &["usage", "anomalies"],
    &["usage", "limits"],
    &["usage", "export"],
    &["usage", "export", "--tsv"],
];

fn command_inventory(command: &clap::Command, path: &str, entries: &mut Vec<Value>) {
    let arguments = command.get_arguments().map(|arg| {
        let arity = arg.get_num_args().unwrap_or_default();
        json!({
            "id": arg.get_id().as_str(),
            "short": arg.get_short(),
            "long": arg.get_long(),
            "aliases": arg.get_all_aliases().unwrap_or_default(),
            "short_aliases": arg.get_all_short_aliases().unwrap_or_default(),
            "help": arg.get_help().map(ToString::to_string),
            "long_help": arg.get_long_help().map(ToString::to_string),
            "action": format!("{:?}", arg.get_action()),
            "required": arg.is_required_set(),
            "global": arg.is_global_set(),
            "hidden": arg.is_hide_set(),
            "require_equals": arg.is_require_equals_set(),
            "min_values": arity.min_values(),
            "max_values": (arity.max_values() != usize::MAX).then_some(arity.max_values()),
            "defaults": arg.get_default_values().iter().map(|value| value.to_string_lossy()).collect::<Vec<_>>(),
            "choices": arg.get_possible_values().iter().map(|value| value.get_name()).collect::<Vec<_>>(),
            "conflicts": command.get_arg_conflicts_with(arg).iter().map(|other| other.get_id().as_str()).collect::<Vec<_>>(),
            "env": arg.get_env().map(|value| value.to_string_lossy()),
        })
    }).collect::<Vec<_>>();
    entries.push(json!({
        "path": path,
        "about": command.get_about().map(ToString::to_string),
        "long_about": command.get_long_about().map(ToString::to_string),
        "hidden": command.is_hide_set(),
        "aliases": command.get_all_aliases().collect::<Vec<_>>(),
        "subcommand_required": command.is_subcommand_required_set(),
        "arguments": arguments,
    }));
    for child in command.get_subcommands() {
        command_inventory(child, &format!("{path} {}", child.get_name()), entries);
    }
}

fn current_inventory() -> Value {
    let mut command = Cli::command();
    command.build();
    let mut entries = Vec::new();
    command_inventory(&command, "shore", &mut entries);
    let examples = WIRE_EXAMPLES
        .iter()
        .map(|args| {
            let cli = Cli::try_parse_from(std::iter::once("shore").chain(args.iter().copied()))
                .unwrap_or_else(|error| panic!("inventory example {args:?}: {error}"));
            let mapping = cli
                .command
                .as_ref()
                .and_then(|parsed| to_swp_command(parsed, Some("ada")));
            json!({
                "argv": args,
                "mapping": mapping.map(|(name, payload)| json!({ "name": name, "args": payload })),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "format": 1,
        "commands": entries,
        "wire_examples": examples,
        "view_preferences": ViewKey::value_variants().iter().map(|key| json!({
            "key": key.as_str(),
            "values": key.values(),
        })).collect::<Vec<_>>(),
        "keymap": {
            "reserved": RESERVED_KEYS,
            "global": DEFAULT_GLOBAL_KEYS,
            "normal": DEFAULT_NORMAL_KEYS,
            "shortcuts": DEFAULT_SHORTCUTS,
        },
    })
}

fn inventory_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/capabilities/terminal.generated.json")
}

#[test]
fn terminal_capability_inventory_is_current() {
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(inventory_path()).expect("read terminal capability inventory"),
    )
    .expect("parse terminal capability inventory");
    assert_eq!(
        expected,
        current_inventory(),
        "CLI/TUI capabilities changed; regenerate and review the inventory using cargo test -p shore-cli export_capability_inventory -- --ignored"
    );
}

#[test]
#[ignore = "explicitly regenerate the reviewed capability inventory"]
fn export_capability_inventory() {
    let path = inventory_path();
    std::fs::create_dir_all(path.parent().expect("inventory parent"))
        .expect("create inventory directory");
    std::fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&current_inventory()).expect("serialize inventory")
        ),
    )
    .expect("write inventory");
}
