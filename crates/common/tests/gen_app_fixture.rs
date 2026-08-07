//! Fixture generator for the `AppConfig` port (`crates/common/src/config/app.rs`).
//!
//! Committed for the same reason as `gen_dirs_fixture.rs`: this development
//! environment is ephemeral, so an uncommitted generator is a destroyed one.
//! The fixture it writes is still frozen — see the header it emits.
//!
//! Drives the real `shore_common::config::app` types and writes
//! `daemon/tests/config_fixtures/app_parity.json`.
//!
//! Run with:
//!   cargo test -p shore-common --test gen_app_fixture -- --test-threads=1 --ignored --nocapture
//!
//! Single-threaded is mandatory: the `resolve_display_name` cases mutate `$USER`.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use shore_common::config::app::{
    tool_pattern_matches, AppConfig, BackgroundDefaultsConfig, BackgroundTask, BudgetWeekday,
    CompactionConfig, DefaultsConfig, ThinkingReplay, ToolsConfig, UsageBudgetAction,
    UsageBudgetConfig, UsageBudgetPeriod,
};

// ── Parse cases ─────────────────────────────────────────────────────────

/// Deserialize `src` both ways the daemon can reach `AppConfig`.
///
/// `toml::from_str` walks the *document*, so it reports whichever bad key comes
/// first in the file. `parse_config_table` instead materializes a `toml::Table`
/// — a `BTreeMap`, since the `toml` crate is built without `preserve_order` —
/// and calls `try_into`, so it reports whichever bad key comes first in **code
/// point order**. Production only ever takes the table path; the unit tests in
/// `app.rs` only ever take the document path. Both are recorded so the port
/// cannot accidentally satisfy the tests while disagreeing with the daemon.
fn parse_case(name: &str, src: &str) -> Value {
    let doc: Result<AppConfig, toml::de::Error> = toml::from_str(src);

    let table = src
        .parse::<toml::Table>()
        .expect("every case must be syntactically valid TOML");
    let via_table: Result<AppConfig, toml::de::Error> = toml::Value::Table(table).try_into();

    let mut case = json!({ "name": name, "toml": src });
    let obj = case.as_object_mut().expect("object");

    match (&doc, &via_table) {
        // The overwhelmingly common shape: both paths agree, so the result is
        // recorded once. Anything else gets both columns.
        (Ok(a), Ok(b)) if a == b => {
            drop(obj.insert(
                "ok".to_owned(),
                serde_json::to_value(a).expect("AppConfig serializes"),
            ));
        }
        (Err(a), Err(b)) => {
            drop(obj.insert("doc_err".to_owned(), json!(a.message())));
            drop(obj.insert("table_err".to_owned(), json!(b.message())));
        }
        _ => {
            let render = |r: &Result<AppConfig, toml::de::Error>| match r {
                Ok(v) => json!({ "ok": serde_json::to_value(v).expect("serializes") }),
                Err(e) => json!({ "err": e.message() }),
            };
            drop(obj.insert("doc".to_owned(), render(&doc)));
            drop(obj.insert("table".to_owned(), render(&via_table)));
        }
    }
    case
}

// ── ToolsConfig queries ─────────────────────────────────────────────────

/// Every observable answer `ToolsConfig` gives about a tool name.
fn tools_case(name: &str, src: &str, names: &[&str], subagents: &[&str]) -> Value {
    let config: AppConfig = toml::from_str(src).expect("tools case parses");
    let tools = &config.tools;

    let per_tool: Vec<Value> = names
        .iter()
        .map(|n| {
            json!({
                "name": n,
                "enabled": tools.tool_enabled(n),
                "result_chars": tools.result_chars_for(n),
                // Milliseconds, or null for "no deadline".
                "timeout_ms": tools.timeout_for(n).map(|d| u64::try_from(d.as_millis()).expect("fits")),
            })
        })
        .collect();

    let per_subagent: Vec<Value> = subagents
        .iter()
        .map(|s| json!({ "name": s, "enabled": tools.subagent_enabled(s) }))
        .collect();

    json!({
        "name": name,
        "toml": src,
        "any_enabled": tools.any_enabled(),
        "tools": per_tool,
        "subagents": per_subagent,
    })
}

// ── Defaults resolution ─────────────────────────────────────────────────

fn background_case(name: &str, defaults: DefaultsConfig) -> Value {
    json!({
        "name": name,
        "defaults": serde_json::to_value(&defaults).expect("serializes"),
        "heartbeat": defaults.resolve_background_model_name(BackgroundTask::Heartbeat),
        "compaction": defaults.resolve_background_model_name(BackgroundTask::Compaction),
    })
}

/// `normalize_deprecated_aliases`, recorded before and after, twice over — the
/// second call proves idempotence rather than merely asserting it.
fn normalize_case(name: &str, src: &str) -> Value {
    let mut config: AppConfig = toml::from_str(src).expect("normalize case parses");
    let before = serde_json::to_value(&config.defaults).expect("serializes");
    config.defaults.normalize_deprecated_aliases();
    let once = serde_json::to_value(&config.defaults).expect("serializes");
    config.defaults.normalize_deprecated_aliases();
    let twice = serde_json::to_value(&config.defaults).expect("serializes");

    json!({ "name": name, "toml": src, "before": before, "once": once, "twice": twice })
}

fn display_name_case(name: &str, configured: Option<&str>, user_env: Option<&str>) -> Value {
    let saved = std::env::var("USER").ok();
    match user_env {
        Some(v) => std::env::set_var("USER", v),
        None => std::env::remove_var("USER"),
    }

    let defaults = DefaultsConfig {
        display_name: configured.map(str::to_owned),
        ..DefaultsConfig::default()
    };
    let resolved = defaults.resolve_display_name();

    match saved {
        Some(v) => std::env::set_var("USER", v),
        None => std::env::remove_var("USER"),
    }

    json!({
        "name": name,
        "display_name": configured,
        "user_env": user_env,
        "resolved": resolved,
    })
}

// ── Compaction validation ───────────────────────────────────────────────

fn compaction_case(name: &str, compaction: CompactionConfig) -> Value {
    let result = compaction.validate();
    json!({
        "name": name,
        "compaction": serde_json::to_value(&compaction).expect("serializes"),
        "err": result.err(),
    })
}

// ── Budget helpers ──────────────────────────────────────────────────────

fn budget_case(name: &str, src: &str) -> Value {
    let config: AppConfig = toml::from_str(src).expect("budget case parses");
    let budgets: Vec<Value> = config
        .usage
        .budgets
        .iter()
        .map(|b: &UsageBudgetConfig| {
            json!({
                "pace_action": serde_json::to_value(b.pace_action()).expect("serializes"),
                "pace_warn_at": b.pace_warn_at(),
            })
        })
        .collect();
    json!({ "name": name, "toml": src, "budgets": budgets })
}

fn main_fixture() -> Value {
    let parses = vec![
        parse_case("an empty document is every default", ""),
        parse_case(
            "the subagents table",
            "[defaults]\nsubagent_model = \"anthropic:claude-haiku-4-5\"\n\n\
             [subagents.music]\ndescription = \"Ask about the music library.\"\n\
             prompt = \"You are a music assistant for {{char}}.\"\n\
             tools = [\"search\", \"read\"]\nmax_iterations = 6\n",
        ),
        parse_case(
            "subagent keys sort by code point, not UTF-16 order",
            "[subagents.\"\u{1F3B5}drum\"]\ndescription = \"d\"\nprompt = \"p\"\n\n\
             [subagents.\"\u{FB00}ute\"]\ndescription = \"f\"\nprompt = \"p\"\n\n\
             [subagents.zed]\ndescription = \"z\"\nprompt = \"p\"\n",
        ),
        parse_case(
            "a subagent without a description does not parse",
            "[subagents.music]\nprompt = \"p\"\n",
        ),
        parse_case(
            "a subagent without a prompt does not parse",
            "[subagents.music]\ndescription = \"d\"\n",
        ),
        parse_case(
            "an unknown subagent key does not parse",
            "[subagents.music]\ndescription = \"d\"\nprompt = \"p\"\nmodel_name = \"x\"\n",
        ),
        parse_case(
            "two missing fields report the one declared first, not the one sorted first",
            "[subagents.music]\ntools = []\n",
        ),
        parse_case(
            "an unknown key is reported before a missing one",
            "[subagents.music]\nzzz = 1\n",
        ),
        parse_case(
            "memory.retrieval",
            "[memory.retrieval]\nmode = \"hybrid\"\nmax_file_bytes = 12345\n\
             max_indexed_files = 999\nmax_total_indexed_bytes = 777777\n\
             max_embed_chars_per_file = 222\nbinary = \"metadata\"\n",
        ),
        parse_case(
            "an unknown retrieval mode does not parse",
            "[memory.retrieval]\nmode = \"semantic\"\n",
        ),
        parse_case(
            "an unknown binary mode does not parse",
            "[memory.retrieval]\nbinary = \"embed\"\n",
        ),
        parse_case("memory.git_push", "[memory]\ngit_push = true\n"),
        parse_case(
            "usage budgets and spike warnings",
            "[usage]\ntimezone = \"utc\"\nallow_compaction_over_budget = false\n\n\
             [[usage.budgets]]\nname = \"daily\"\nperiod = \"day\"\ncost_usd = 10.0\n\
             warn_at = [0.5, 0.8]\nlimit = \"block\"\nprovider = \"openrouter\"\n\
             api_key = \"overflow\"\nusage_kind = [\"message_with_tools\"]\n\n\
             [usage.spike_warnings]\nenabled = true\nperiod = \"hour\"\n\
             multiplier = 4.0\nmin_cost_usd = 2.5\n",
        ),
        parse_case(
            "a budget without cost_usd does not parse",
            "[[usage.budgets]]\nname = \"daily\"\n",
        ),
        parse_case(
            "budget anchors and the pace sub-window",
            "[[usage.budgets]]\ncost_usd = 5.0\nperiod = \"week\"\n\
             reset_hour = 4\nreset_day_of_week = \"thursday\"\n\
             pace_period = \"day\"\npace_action = \"pause_background\"\n\
             pace_warn_at = [0.25]\n\n\
             [[usage.budgets]]\ncost_usd = 9.0\nperiod = \"month\"\n\
             reset_day_of_month = 31\nallow_compaction_over_budget = true\n",
        ),
        parse_case(
            "every budget period and action variant",
            "[[usage.budgets]]\ncost_usd = 1.0\nperiod = \"hour\"\nlimit = \"warn\"\n\n\
             [[usage.budgets]]\ncost_usd = 1.0\nperiod = \"day\"\nlimit = \"block\"\n\n\
             [[usage.budgets]]\ncost_usd = 1.0\nperiod = \"week\"\nlimit = \"pause_background\"\n\n\
             [[usage.budgets]]\ncost_usd = 1.0\nperiod = \"month\"\n",
        ),
        parse_case(
            "an unknown budget weekday does not parse",
            "[[usage.budgets]]\ncost_usd = 1.0\nreset_day_of_week = \"Monday\"\n",
        ),
        parse_case(
            "the tools allowlist",
            "[tools]\nenabled_tools = [\"read\", \"search_chat_logs\"]\n",
        ),
        parse_case(
            "mcp globs in the allowlist",
            "[tools]\nenabled_tools = [\"read\", \"mcp__hue__*\"]\n",
        ),
        parse_case(
            "the subagent allowlist",
            "[tools]\nenabled_subagents = [\"memory\"]\n",
        ),
        parse_case(
            "per-tool overrides",
            "[tools]\nenabled_tools = [\"search\", \"read\"]\nmax_result_chars = 20000\n\
             timeout = \"30s\"\n\n[tools.config.search]\nmax_result_chars = 10000\n\n\
             [tools.config.ask_researcher]\ntimeout = \"20m\"\n",
        ),
        parse_case(
            "a zero timeout means no deadline",
            "[tools]\nenabled_tools = [\"read\", \"git\"]\ntimeout = 0\n\n\
             [tools.config.git]\ntimeout = \"45s\"\n",
        ),
        parse_case(
            "an unknown per-tool override key does not parse",
            "[tools.config.search]\nmax_chars = 10\n",
        ),
        parse_case(
            "web search",
            "[tools.web_search]\napi_key_env = \"MY_TAVILY_KEY\"\nresult_limit = 10\n\
             search_depth = \"advanced\"\ninclude_answer = false\n",
        ),
        parse_case(
            "the mcp table, both transports",
            "[mcp.hue]\ncommand = \"node\"\nargs = [\"index.js\"]\n\
             env = { HUE_API_KEY = \"abc\" }\ncwd = \"/srv/hue-mcp\"\n\n\
             [mcp.remote]\nurl = \"http://localhost:9123/sse\"\n",
        ),
        parse_case(
            "mcp env keys sort by code point",
            "[mcp.s]\ncommand = \"x\"\nenv = { ZED = \"1\", \"\u{FB00}\" = \"2\", ABLE = \"3\" }\n",
        ),
        parse_case(
            "an unknown mcp key does not parse",
            "[mcp.hue]\ncommand = \"node\"\ntransport = \"stdio\"\n",
        ),
        parse_case(
            "the daemon section",
            "[daemon]\naddr = \"0.0.0.0:9999\"\nunsafe_allow_remote_access = true\n\
             allowed_hosts = [\"127.0.0.1\", \"192.168.1.100\"]\n",
        ),
        parse_case(
            "autonomy and heartbeat durations",
            "[behavior.autonomy]\nenabled = true\ncache_keepalive_max = \"6h\"\n\n\
             [behavior.autonomy.heartbeat]\nenabled = false\n\
             fallback_heartbeat_interval = \"90m\"\ndormant_after_heartbeat_turns = 7\n\
             dormant_after_idle_time = \"1d\"\nminimum_heartbeat_latency = \"500ms\"\n\
             wrap_up_grace_rounds = 1\n",
        ),
        parse_case(
            "a bare integer duration means seconds",
            "[behavior.autonomy]\ncache_keepalive_max = 90\n",
        ),
        parse_case(
            "a fractional duration is accepted at parse time",
            "[memory.compaction]\nidle_trigger = \"1.5s\"\n",
        ),
        parse_case(
            "an unparseable duration is rejected",
            "[behavior.autonomy]\ncache_keepalive_max = \"6 hours\"\n",
        ),
        parse_case(
            "a negative duration is rejected",
            "[behavior.autonomy]\ncache_keepalive_max = -5\n",
        ),
        parse_case(
            "every user_message_timestamps variant",
            "[behavior]\nuser_message_timestamps = \"always\"\n",
        ),
        parse_case(
            "user_message_timestamps never",
            "[behavior]\nuser_message_timestamps = \"never\"\n",
        ),
        parse_case(
            "an unknown user_message_timestamps variant does not parse",
            "[behavior]\nuser_message_timestamps = \"sometimes\"\n",
        ),
        parse_case(
            "the compaction section",
            "[memory.compaction]\nenabled = true\nidle_trigger = \"45m\"\n\
             archive_after = \"3d\"\nmin_turns = 4\nmax_turns = 20\n\
             max_context_tokens = 150000\nkeep_recent_turns = 3\n",
        ),
        parse_case(
            "replay_prior_thinking accepts the new string form",
            "[memory.thinking]\nreplay_prior_thinking = \"none\"\n",
        ),
        parse_case(
            "replay_prior_thinking accepts the legacy bool true",
            "[memory.thinking]\nreplay_prior_thinking = true\n",
        ),
        parse_case(
            "replay_prior_thinking accepts the legacy bool false",
            "[memory.thinking]\nreplay_prior_thinking = false\n",
        ),
        parse_case(
            "replay_prior_thinking accepts the stringy legacy bools",
            "[memory.thinking]\nreplay_prior_thinking = \"true\"\n",
        ),
        parse_case(
            "the retired last_turn mode still loads, as all",
            "[memory.thinking]\nreplay_prior_thinking = \"last_turn\"\n",
        ),
        parse_case(
            "an unknown replay_prior_thinking is rejected",
            "[memory.thinking]\nreplay_prior_thinking = \"recent\"\n",
        ),
        parse_case(
            "notifications",
            "[notifications]\nenabled = true\nbackend = \"ntfy\"\n\
             generation_threshold = \"20s\"\n\n\
             [notifications.ntfy]\nurl = \"https://ntfy.example.com\"\n\
             topic = \"shore-test\"\ntoken = \"tk_secret\"\n\n\
             [notifications.events]\ncache_warning = false\nmessage_complete = true\n",
        ),
        parse_case(
            "the notifications command backend",
            "[notifications]\nenabled = true\nbackend = \"command\"\n\n\
             [notifications.command]\ntemplate = \"echo '{title}: {body}'\"\n",
        ),
        parse_case(
            "an unknown notifications backend does not parse",
            "[notifications]\nbackend = \"dbus\"\n",
        ),
        parse_case(
            "the advanced section",
            "[advanced]\napi_payload_logging = true\ncache_forensics = true\n\
             editor = \"hx\"\nmax_retries = 5\nretry_backoff = \"250ms\"\n\
             max_image_size = 5000000\n\n[advanced.llm_sidecar]\nenabled = false\n\
             socket_path = \"/tmp/shore-llm.sock\"\n",
        ),
        parse_case(
            "max_image_size = 0 disables resizing",
            "[advanced]\nmax_image_size = 0\n",
        ),
        parse_case(
            "the connections tables flatten unknown keys instead of rejecting them",
            "[connections.telegram]\nbot_token = \"t\"\nchat_id = 42\n\n\
             [connections.discord]\nwebhook = \"https://example.invalid/hook\"\n",
        ),
        parse_case(
            "the removed matrix connection is rejected",
            "[connections.matrix]\nenabled = true\n",
        ),
        parse_case(
            "the removed embedded matrix connection is rejected",
            "[connections.matrix.embedded]\nadmin_password = \"x\"\n",
        ),
        parse_case(
            "the removed tools.exec sandbox is rejected",
            "[tools.exec]\nsandbox = \"off\"\n",
        ),
        parse_case(
            "the removed tools.sandbox section is rejected",
            "[tools.sandbox]\nmode = \"on\"\n",
        ),
        parse_case(
            "an unknown top-level section is rejected",
            "[bogus_section]\nkey = \"value\"\n",
        ),
        parse_case(
            "an unknown notifications key is rejected",
            "[notifications]\nenabled = true\nbogus_key = \"value\"\n",
        ),
        parse_case(
            "an unknown nested key is rejected",
            "[behavior.autonomy]\nenabled = true\nbogus_key = 42\n",
        ),
        parse_case(
            "the deprecated top-level heartbeat key parses without normalizing",
            "[defaults]\nmodel = \"primary\"\nheartbeat = \"hb-old\"\n",
        ),
        parse_case(
            "the background section",
            "[defaults.background]\nmodel = \"bg\"\nheartbeat = \"bg-h\"\ncompaction = \"bg-c\"\n",
        ),
        parse_case(
            "an unknown background key is rejected",
            "[defaults.background]\ntypo_field = \"x\"\n",
        ),
        parse_case(
            "defaults.stream can be turned off",
            "[defaults]\nstream = false\ndisplay_name = \"Alice\"\n\
             embedding = \"e\"\nimage_generation = \"i\"\n",
        ),
        // ── The two paths disagree here, and only here ──────────────────
        parse_case(
            "two unknown top-level keys: the document reports the first written, \
             the table reports the code-point-smallest",
            "[zzz_unknown]\nk = 1\n\n[aaa_unknown]\nk = 2\n",
        ),
        parse_case(
            "an unknown key and a bad type: which is reported depends on the path",
            "[behavior]\nzzz_unknown = 1\n\n[behavior.autonomy]\nenabled = \"yes\"\n",
        ),
        parse_case(
            "two unknown non-ASCII keys sort by code point, not UTF-16 order",
            // U+FB00 sorts BELOW U+1F3B5 by code point and ABOVE it by UTF-16
            // code unit, since an astral character is a surrogate pair starting
            // at 0xD800. The two rules pick different keys to complain about.
            "[\"\u{1F3B5}\"]\nk = 1\n\n[\"\u{FB00}\"]\nk = 2\n",
        ),
        // A serde-derived struct implements `visit_seq` as well as `visit_map`,
        // so a TOML *array* deserializes positionally into its fields.
        parse_case(
            "an empty sequence fills a struct with its defaults",
            "[behavior]\nautonomy = []\n",
        ),
        parse_case(
            "a sequence fills a struct positionally",
            "[behavior]\nautonomy = [true]\n",
        ),
        parse_case(
            "a full positional sequence",
            "[behavior]\nautonomy = [true, { enabled = false }, \"6h\"]\n",
        ),
        parse_case(
            "a bad type at a sequence position",
            "[behavior]\nautonomy = [1]\n",
        ),
        parse_case(
            "a flatten-only struct has no positional form",
            "[connections]\ntelegram = [1]\n",
        ),
        parse_case(
            "trailing elements past the field count",
            "[behavior]\nautonomy = [true, {}, \"6h\", 1]\n",
        ),
        // How short a positional sequence may be, per struct: serde fills the
        // tail from `#[serde(default)]`, and a bare `Option<T>` does NOT have
        // one on this path even though it does on the map path.
        parse_case("seq: DefaultsConfig", "defaults = []\n"),
        parse_case(
            "seq: DefaultsConfig, at its minimum",
            "defaults = [\"m\", [\"bm\", \"bh\", \"bc\"], \"h\", \"e\", \"i\", \"s\", \"d\"]\n",
        ),
        parse_case("seq: BackgroundDefaultsConfig", "[defaults]\nbackground = []\n"),
        parse_case(
            "seq: BackgroundDefaultsConfig, at its minimum",
            "[defaults]\nbackground = [\"m\", \"h\", \"c\"]\n",
        ),
        parse_case("seq: AdvancedConfig", "advanced = []\n"),
        parse_case(
            "seq: AdvancedConfig, at its minimum",
            "advanced = [true, true, \"hx\", 3, \"1s\"]\n",
        ),
        parse_case("seq: LlmSidecarConfig", "[advanced]\nllm_sidecar = []\n"),
        parse_case(
            "seq: LlmSidecarConfig, at its minimum",
            "[advanced]\nllm_sidecar = [true, \"/tmp/s.sock\"]\n",
        ),
        parse_case("seq: McpServerConfig", "[mcp]\ns = []\n"),
        parse_case(
            "seq: McpServerConfig, at its minimum",
            "[mcp]\ns = [\"node\", [], {}, \"/srv\", \"http://x\"]\n",
        ),
        parse_case("seq: UsageBudgetConfig", "[usage]\nbudgets = [[]]\n"),
        parse_case(
            "seq: UsageBudgetConfig, at its minimum",
            "[usage]\nbudgets = [[\"n\", \"week\", 5.0]]\n",
        ),
        parse_case("seq: ToolOverride needs nothing", "[tools.config]\nread = []\n"),
        parse_case("seq: SearchConfig needs nothing", "[tools]\nweb_search = []\n"),
        parse_case(
            "seq: NotificationEventsConfig needs nothing",
            "[notifications]\nevents = []\n",
        ),
        parse_case(
            "a required field missing from a positional sequence",
            "[subagents]\nmusic = [\"d\"]\n",
        ),
        parse_case(
            "a required field supplied positionally",
            "[subagents]\nmusic = [\"d\", \"p\", [\"read\"]]\n",
        ),
        parse_case("a sequence where a map is expected", "[mcp.s]\nenv = []\n"),
        parse_case(
            "an unknown key in a one-field struct",
            "[memory.thinking]\nbogus = 1\n",
        ),
        parse_case(
            "an unknown key in the other one-field struct",
            "[notifications.command]\nbogus = 1\n",
        ),
        parse_case(
            "an unknown key sorting before a bad type is reported on both paths",
            "[aaa_unknown]\nk = 1\n\n[behavior.autonomy]\nenabled = \"yes\"\n",
        ),
        parse_case(
            "an empty per-tool table is not an error",
            "[tools.config.read]\n",
        ),
        parse_case(
            "a zero deadline written as a duration string",
            "[tools]\ntimeout = \"0s\"\n",
        ),
        parse_case(
            "a bare float duration",
            "[behavior.autonomy]\ncache_keepalive_max = 1.5\n",
        ),
        parse_case(
            "a bad type where a bool is expected",
            "[defaults]\nstream = \"yes\"\n",
        ),
        parse_case(
            "a bad type where a string is expected",
            "[daemon]\naddr = 7320\n",
        ),
        parse_case(
            "a bad type where an integer is expected",
            "[tools]\nmax_result_chars = \"lots\"\n",
        ),
        parse_case(
            "a negative integer where a usize is expected",
            "[tools]\nmax_result_chars = -1\n",
        ),
        parse_case(
            "a table where a section is expected to be one",
            "[defaults]\nbackground = \"bg\"\n",
        ),
        // ── How serde renders each unexpected value, one per TOML type ───
        parse_case("integer where a string is expected", "[defaults]\nmodel = 1\n"),
        parse_case("boolean where a string is expected", "[defaults]\nmodel = true\n"),
        parse_case("float where a string is expected", "[defaults]\nmodel = 1.5\n"),
        parse_case("array where a string is expected", "[defaults]\nmodel = []\n"),
        parse_case("table where a string is expected", "[defaults]\nmodel = {}\n"),
        parse_case(
            "datetime where a string is expected",
            "[defaults]\nmodel = 1979-05-27T07:32:00Z\n",
        ),
        parse_case("float where an integer is expected", "[tools]\nmax_result_chars = 1.5\n"),
        parse_case("string where a sequence is expected", "[tools]\nenabled_tools = \"read\"\n"),
        parse_case("wrong element type inside a sequence", "[tools]\nenabled_tools = [1]\n"),
        parse_case("wrong element type inside a float sequence", "[[usage.budgets]]\ncost_usd = 1.0\nwarn_at = [\"half\"]\n"),
        parse_case("integer where a float is expected is widened", "[[usage.budgets]]\ncost_usd = 10\n"),
        parse_case("string where a float is expected", "[[usage.budgets]]\ncost_usd = \"ten\"\n"),
        parse_case("negative u32", "[advanced]\nmax_retries = -1\n"),
        parse_case("negative u64", "[advanced]\nmax_image_size = -1\n"),
        parse_case("integer where a path is expected", "[advanced.llm_sidecar]\nsocket_path = 1\n"),
        parse_case("string where a string map is expected", "[mcp.s]\nenv = \"x\"\n"),
        parse_case("wrong value type inside a string map", "[mcp.s]\nenv = { A = 1 }\n"),
        parse_case("integer where a nested struct is expected", "[behavior.autonomy]\nheartbeat = 1\n"),
        parse_case("string where an array of tables is expected", "[usage]\nbudgets = \"none\"\n"),
        parse_case(
            "an empty telegram table is the only one that parses",
            "[connections.telegram]\n",
        ),
        parse_case("an integer past u32", "[advanced]\nmax_retries = 5000000000\n"),
        parse_case("a non-string where an enum is expected", "[memory.retrieval]\nmode = 1\n"),
        parse_case(
            "a non-string where the notification backend is expected",
            "[notifications]\nbackend = 1\n",
        ),
        parse_case(
            "a boolean where a duration is expected",
            "[behavior.autonomy]\ncache_keepalive_max = true\n",
        ),
        parse_case(
            "an integer where replay_prior_thinking is expected",
            "[memory.thinking]\nreplay_prior_thinking = 1\n",
        ),
        // ── Distinctions Bun's TOML parser destroys before a port can see
        // them. Recorded so what was given up is written down, not so the
        // TypeScript can reproduce it. See the `_header`.
        parse_case(
            "a float that happens to be whole is still a float",
            "[tools]\nmax_result_chars = 20000.0\n",
        ),
        parse_case(
            "exponent notation is a float too",
            "[tools]\nmax_result_chars = 1e3\n",
        ),
        parse_case(
            "u64 fields hold values a double cannot",
            "[advanced]\nmax_image_size = 9007199254740993\n",
        ),
    ];

    let tools_queries = vec![
        tools_case(
            "the empty default offers nothing but still caps and deadlines",
            "[tools]\n",
            &["read", "search_chat_logs", "anything"],
            &["memory"],
        ),
        tools_case(
            "exact allowlist entries",
            "[tools]\nenabled_tools = [\"read\", \"search_chat_logs\"]\n",
            &["read", "ready", "search_chat_logs", "roll_dice", "web_search"],
            &["memory"],
        ),
        tools_case(
            "a trailing star is a prefix glob, scoped to one server",
            "[tools]\nenabled_tools = [\"read\", \"mcp__hue__*\"]\n",
            &[
                "mcp__hue__set_light",
                "mcp__hue__list_lights",
                "mcp__hue__",
                "mcp__nanoleaf__on",
            ],
            &[],
        ),
        tools_case(
            "per-tool caps and deadlines, and what inherits",
            "[tools]\nenabled_tools = [\"search\", \"read\"]\nmax_result_chars = 20000\n\
             timeout = \"30s\"\n\n[tools.config.search]\nmax_result_chars = 10000\n\n\
             [tools.config.ask_researcher]\ntimeout = \"20m\"\n",
            &["search", "read", "ask_researcher", "never_configured"],
            &["researcher"],
        ),
        tools_case(
            "a zero global deadline is overridable per tool",
            "[tools]\nenabled_tools = [\"read\", \"git\"]\ntimeout = 0\n\n\
             [tools.config.git]\ntimeout = \"45s\"\n",
            &["read", "git"],
            &[],
        ),
        tools_case(
            "a zero per-tool deadline opts one tool out of a global one",
            "[tools]\nenabled_tools = [\"read\", \"slow\"]\ntimeout = \"30s\"\n\n\
             [tools.config.slow]\ntimeout = 0\n",
            &["read", "slow"],
            &[],
        ),
        tools_case(
            "a zero cap disables truncation for that tool only",
            "[tools]\nmax_result_chars = 20000\n\n[tools.config.dump]\nmax_result_chars = 0\n",
            &["dump", "read"],
            &[],
        ),
        tools_case(
            "subagents alone make the tool surface active",
            "[tools]\nenabled_subagents = [\"memory\"]\n",
            &["read"],
            &["memory", "research"],
        ),
        tools_case(
            "the subagent allowlist takes no globs",
            "[tools]\nenabled_subagents = [\"mem*\"]\n",
            &[],
            &["mem", "memory", "mem*"],
        ),
    ];

    // `tool_pattern_matches` on its own, including the cases no allowlist in the
    // suite above reaches.
    let patterns: Vec<Value> = [
        ("read", "read"),
        ("read", "ready"),
        ("read", "rea"),
        ("read", ""),
        ("mcp__hue__*", "mcp__hue__set_light"),
        ("mcp__hue__*", "mcp__hue__"),
        ("mcp__hue__*", "mcp__hue_"),
        ("mcp__hue__*", "mcp__nanoleaf__on"),
        ("mcp__*", "mcp__hue__set_light"),
        ("*", "anything"),
        ("*", ""),
        ("", ""),
        ("", "x"),
        // A star anywhere but the end is literal.
        ("mcp__*__on", "mcp__hue__on"),
        ("mcp__*__on", "mcp__*__on"),
        ("mcp__*__on", "mcp__*__onx"),
        ("**", "*"),
        ("**", ""),
    ]
    .iter()
    .map(|(pattern, name)| {
        json!({
            "pattern": pattern,
            "name": name,
            "matches": tool_pattern_matches(pattern, name),
        })
    })
    .collect();

    let backgrounds = vec![
        background_case("nothing set", DefaultsConfig::default()),
        background_case(
            "defaults.model is not a background fallback",
            DefaultsConfig {
                model: Some("chat".into()),
                ..DefaultsConfig::default()
            },
        ),
        background_case(
            "background.model covers every task",
            DefaultsConfig {
                model: Some("chat".into()),
                background: BackgroundDefaultsConfig {
                    model: Some("bg".into()),
                    ..BackgroundDefaultsConfig::default()
                },
                ..DefaultsConfig::default()
            },
        ),
        background_case(
            "a per-task override wins over background.model",
            DefaultsConfig {
                model: Some("chat".into()),
                background: BackgroundDefaultsConfig {
                    model: Some("bg".into()),
                    heartbeat: Some("hb".into()),
                    compaction: None,
                },
                ..DefaultsConfig::default()
            },
        ),
        background_case(
            "a per-task override with no blanket model",
            DefaultsConfig {
                background: BackgroundDefaultsConfig {
                    model: None,
                    heartbeat: None,
                    compaction: Some("c".into()),
                },
                ..DefaultsConfig::default()
            },
        ),
        background_case(
            "the deprecated top-level key is not consulted before normalizing",
            DefaultsConfig {
                heartbeat: Some("hb-old".into()),
                ..DefaultsConfig::default()
            },
        ),
    ];

    let normalizations = vec![
        normalize_case(
            "the deprecated key forwards into background",
            "[defaults]\nmodel = \"primary\"\nheartbeat = \"hb-old\"\n",
        ),
        normalize_case(
            "the new key wins and the alias is dropped",
            "[defaults]\nheartbeat = \"hb-old\"\n\n[defaults.background]\nheartbeat = \"hb-new\"\n",
        ),
        normalize_case(
            "already-normalized values are untouched",
            "[defaults.background]\nheartbeat = \"hb\"\n",
        ),
        normalize_case("nothing to normalize", "[defaults]\nmodel = \"m\"\n"),
        normalize_case(
            "an empty string is a value, not an absence",
            "[defaults]\nheartbeat = \"\"\n",
        ),
    ];

    let display_names = vec![
        display_name_case("configured wins", Some("Alice"), Some("bob")),
        display_name_case("falls back to $USER", None, Some("bob")),
        display_name_case("falls back to User when both are absent", None, None),
        display_name_case("an empty $USER is still a value", None, Some("")),
        display_name_case("an empty configured name is still a value", Some(""), Some("bob")),
    ];

    let compactions = vec![
        compaction_case("the default is valid", CompactionConfig::default()),
        compaction_case(
            "min_turns equal to keep_recent_turns is rejected",
            CompactionConfig {
                min_turns: 4,
                keep_recent_turns: 4,
                ..CompactionConfig::default()
            },
        ),
        compaction_case(
            "max_turns below min_turns is rejected",
            CompactionConfig {
                min_turns: 10,
                max_turns: 5,
                ..CompactionConfig::default()
            },
        ),
        compaction_case(
            "a disabled config is always valid",
            CompactionConfig {
                enabled: false,
                min_turns: 4,
                keep_recent_turns: 4,
                idle_trigger: shore_common::config::duration::ConfigDuration::from_millis(1500),
                ..CompactionConfig::default()
            },
        ),
        compaction_case(
            "a fractional idle_trigger names the two values that would work",
            CompactionConfig {
                idle_trigger: shore_common::config::duration::ConfigDuration::from_millis(90_500),
                ..CompactionConfig::default()
            },
        ),
        compaction_case(
            "a fractional archive_after is rejected too",
            CompactionConfig {
                archive_after: shore_common::config::duration::ConfigDuration::from_millis(1),
                ..CompactionConfig::default()
            },
        ),
        compaction_case(
            "zero is a whole number of seconds",
            CompactionConfig {
                archive_after: shore_common::config::duration::ConfigDuration::from_secs(0),
                idle_trigger: shore_common::config::duration::ConfigDuration::from_secs(0),
                ..CompactionConfig::default()
            },
        ),
        compaction_case(
            "the idle check runs before the turn check",
            CompactionConfig {
                idle_trigger: shore_common::config::duration::ConfigDuration::from_millis(1),
                min_turns: 1,
                keep_recent_turns: 4,
                ..CompactionConfig::default()
            },
        ),
        compaction_case(
            "max_turns equal to keep_recent_turns is rejected by the first check",
            CompactionConfig {
                min_turns: 9,
                max_turns: 2,
                keep_recent_turns: 2,
                ..CompactionConfig::default()
            },
        ),
    ];

    let budgets = vec![
        budget_case(
            "pace fields default to warn and to the budget's own warn_at",
            "[[usage.budgets]]\ncost_usd = 5.0\nwarn_at = [0.3, 0.9]\n",
        ),
        budget_case(
            "explicit pace overrides",
            "[[usage.budgets]]\ncost_usd = 5.0\nwarn_at = [0.3]\n\
             pace_action = \"block\"\npace_warn_at = [0.1, 0.2]\n",
        ),
        budget_case(
            "an empty pace_warn_at is an override, not an absence",
            "[[usage.budgets]]\ncost_usd = 5.0\nwarn_at = [0.3]\npace_warn_at = []\n",
        ),
        budget_case(
            "the default warn_at flows into pace_warn_at",
            "[[usage.budgets]]\ncost_usd = 5.0\n",
        ),
    ];

    let periods: Vec<Value> = [
        UsageBudgetPeriod::Hour,
        UsageBudgetPeriod::Day,
        UsageBudgetPeriod::Week,
        UsageBudgetPeriod::Month,
    ]
    .iter()
    .map(|p| json!({ "period": p.as_str(), "rank": p.rank() }))
    .collect();

    let weekdays: Vec<Value> = [
        BudgetWeekday::Monday,
        BudgetWeekday::Tuesday,
        BudgetWeekday::Wednesday,
        BudgetWeekday::Thursday,
        BudgetWeekday::Friday,
        BudgetWeekday::Saturday,
        BudgetWeekday::Sunday,
    ]
    .iter()
    .map(|d| {
        json!({
            "weekday": serde_json::to_value(d).expect("serializes"),
            "num_days_from_monday": d.num_days_from_monday(),
        })
    })
    .collect();

    let thinking_replay: Vec<Value> = [
        "all", "none", "true", "false", "last_turn", "All", "", "recent", "1", "0",
    ]
    .iter()
    .map(|s| {
        let parsed = ThinkingReplay::parse_wire(s);
        json!({
            "input": s,
            "parsed": parsed.map(ThinkingReplay::as_wire),
        })
    })
    .collect();

    let actions: Vec<Value> = [
        UsageBudgetAction::Warn,
        UsageBudgetAction::Block,
        UsageBudgetAction::PauseBackground,
    ]
    .iter()
    .map(|a| serde_json::to_value(a).expect("serializes"))
    .collect();

    let header = json!([
        "Parity fixture for `AppConfig` — the whole `config.toml` schema.",
        "",
        "GENERATED from `main`. `shore-common` compiles at HEAD, so this pins",
        "current behaviour, the same provenance as models_parity.json and",
        "dirs_parity.json. Do not copy a 9023b46d worktree provenance onto it.",
        "",
        "Driven against the real shore_common::config::app: the serde schema in",
        "both directions, ToolsConfig's allowlist and per-tool resolution,",
        "DefaultsConfig's display-name and background-model resolution and its",
        "deprecated-alias normalization, CompactionConfig::validate,",
        "ThinkingReplay::parse_wire, and the budget period/weekday/action tables.",
        "Ports to daemon/src/config/app.ts.",
        "",
        "The generator IS committed, at crates/common/tests/gen_app_fixture.rs, on",
        "the reasoning recorded in 0b7b4261: development happens in ephemeral",
        "containers, so an uncommitted generator is a destroyed one.",
        "",
        "That does NOT make this file regenerable. It is FROZEN: nothing",
        "regenerates it. A later diff against it is a defect in the TypeScript,",
        "not a fixture that needs updating. Re-running the generator to make a red",
        "replay go green is the exact failure the freeze exists to stop.",
        "",
        "EVERY parse case is recorded through BOTH deserialization paths, because",
        "they are not the same walk. `toml::from_str` visits keys in document",
        "order. `parse_config_table` — the only path production takes — builds a",
        "`toml::Table` first, which is a BTreeMap (the toml crate is built without",
        "`preserve_order`), so `try_into` visits keys in code point order. The two",
        "agree on every success and on every document with a single fault; they",
        "disagree about WHICH fault is reported when there is more than one. The",
        "unit tests in app.rs only ever take the document path, so a port that",
        "satisfied them could still report a different key than the daemon does.",
        "Cases `two unknown top-level keys` and `an unknown key and a bad type`",
        "pin the disagreement in both directions.",
        "",
        "Error strings are the SEMANTIC half only — `toml::de::Error::message()`,",
        "not `Display`. The toml crate decorates a parse error with a line/caret",
        "frame whose shape is inconsistent between otherwise identical failures,",
        "and three earlier fixtures in this series stop short of it for the same",
        "reason.",
        "",
        "A case carrying `doc` and `table` keys instead of `ok`/`*_err` is one",
        "where the two paths do not merely report a different fault — they",
        "reach different outcomes. There are exactly two. One is a datetime,",
        "which no TypeScript can observe (see below). The other is real and the",
        "port implements it: elements past a positional struct's field count",
        "are an error on the table path and silently ignored on the document",
        "path.",
        "",
        "THREE DISTINCTIONS Bun's TOML parser destroys before app.ts can see",
        "them. These cases are recorded to write down what was given up; they",
        "are NOT parity targets, and the replay asserts the TypeScript's actual",
        "(different) behaviour rather than the Rust's:",
        "",
        "  1. Datetimes. `model = 1979-05-27T07:32:00Z` loads on the table path",
        "     as the string \"1979-05-27T07:32:00Z\" and is rejected on the",
        "     document path. Bun.TOML.parse rejects datetime literals outright,",
        "     so no config containing one reaches app.ts at all.",
        "  2. Integer vs float. TOML `20000.0` and `1e3` are floats and Rust",
        "     rejects them for an integer field; Bun yields the JS number 20000",
        "     and 1000, which app.ts cannot tell from `20000` and `1000`.",
        "  3. u64 range. `max_image_size = 9007199254740993` (2^53 + 1) is",
        "     exact in Rust; Bun yields 9007199254740992. Every real value is a",
        "     byte count far below 2^53, and the fields are not durations —",
        "     ConfigDuration already carries bigint for the one place where the",
        "     boundary is observable.",
        "  4. Nested arrays. Bun.TOML.parse rejects `a = [[1]]` outright — not",
        "     the value, the whole document. No field in this schema is a",
        "     Vec<Vec<_>>, and `[[usage.budgets]]` is array-of-tables syntax",
        "     rather than a nested array literal, so nothing in a real config",
        "     hits it. It is recorded because two positional-sequence cases",
        "     below need one to express a nested struct, and because a schema",
        "     that later grows a nested array would be unreadable by the",
        "     sidecar with no other warning.",
        "",
        "`display_name` cases record the $USER they ran under and the replay",
        "injects it, so the result does not depend on the account running it.",
        "",
        "Note `notifications` is ALSO parsed by daemon/src/notifications.ts,",
        "which reads it off a document (`toml::from_str`) rather than a table and",
        "so reports unknown keys in document order. That port is correct for its",
        "own call path. app.ts must NOT reuse it: reaching the same section",
        "through AppConfig means the table path, and therefore code-point order.",
    ]);

    json!({
        "_header": header,
        "defaults": serde_json::to_value(AppConfig::default()).expect("serializes"),
        "tools_defaults": serde_json::to_value(ToolsConfig::default()).expect("serializes"),
        "parse": parses,
        "tools_queries": tools_queries,
        "tool_patterns": patterns,
        "background": backgrounds,
        "normalize": normalizations,
        "display_name": display_names,
        "compaction_validate": compactions,
        "budget_pace": budgets,
        "budget_periods": periods,
        "budget_weekdays": weekdays,
        "budget_actions": actions,
        "thinking_replay": thinking_replay,
    })
}

#[test]
#[ignore = "fixture generator; run explicitly"]
fn generate() {
    let fixture = main_fixture();

    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../daemon/tests/config_fixtures/app_parity.json");
    fs::create_dir_all(out.parent().expect("has parent")).expect("mkdir");
    fs::write(
        &out,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&fixture).expect("json")
        ),
    )
    .expect("write fixture");
    println!("wrote {}", out.display());
}
