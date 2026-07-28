//! Live OpenAI-compatible reasoning replay smoke test.
//!
//! This sends a post-tool-call continuation request through Shore's
//! OpenAI-compatible adapter. It is intentionally not part of normal tests:
//! it uses real provider credentials and may cost money.
//!
//! Usage:
//!   cargo run -p the daemon's llm module --example live_reasoning_replay -- deepseek
//!   cargo run -p the daemon's llm module --example live_reasoning_replay -- opencode-kimi
//!   cargo run -p the daemon's llm module --example live_reasoning_replay -- openrouter-kimi
//!   cargo run -p the daemon's llm module --example live_reasoning_replay -- nanogpt-deepseek
//!
//! Optional:
//!   SHORE_ENV_FILE=/path/to/.env

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::json;
use shore_common::config::app::ThinkingReplay;
use shore_common::config::models::Sdk;
use shore_daemon::llm::types::{
    LlmRequest, ReasoningCarrier, SystemBlock, ToolDefinition, ToolResultContent, WireBlock,
    WireMessage, WireRole,
};
use shore_daemon::llm::LlmClient;

macro_rules! example_out {
    () => {
        write_stdout_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        write_stdout_line(format_args!($($arg)*))
    };
}

macro_rules! example_err {
    () => {
        write_stderr_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        write_stderr_line(format_args!($($arg)*))
    };
}

fn write_stdout_line(args: std::fmt::Arguments<'_>) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ignored = std::io::Write::write_fmt(&mut out, format_args!("{args}\n"));
}

fn write_stderr_line(args: std::fmt::Arguments<'_>) {
    let stderr = std::io::stderr();
    let mut out = stderr.lock();
    let _ignored = std::io::Write::write_fmt(&mut out, format_args!("{args}\n"));
}

struct Target {
    provider_key: &'static str,
    auth_provider: &'static str,
    model: &'static str,
    api_key_env: &'static str,
    base_url: &'static str,
    reasoning_effort: Option<&'static str>,
}

fn load_env_file() {
    let path = env::var("SHORE_ENV_FILE").map_or_else(
        |_| PathBuf::from("/home/eshen/.config/shore/.env"),
        PathBuf::from,
    );
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("export ") {
            continue;
        }
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }
        let value = raw_value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_owned();
        env::set_var(key, value);
    }
}

fn target(name: &str) -> Option<Target> {
    match name {
        "deepseek" => Some(Target {
            provider_key: "deepseek",
            auth_provider: "deepseek",
            model: "deepseek-v4-pro",
            api_key_env: "DEEPSEEK_API_KEY",
            base_url: "https://api.deepseek.com/v1",
            reasoning_effort: Some("high"),
        }),
        "opencode-kimi" => Some(Target {
            provider_key: "opencode",
            auth_provider: "opencode-go",
            model: "kimi-k2.6",
            api_key_env: "OPENCODE_API_KEY",
            base_url: "https://opencode.ai/zen/go/v1",
            reasoning_effort: Some("high"),
        }),
        "openrouter-kimi" => Some(Target {
            provider_key: "openrouter",
            auth_provider: "openrouter",
            model: "moonshotai/kimi-k2.6",
            api_key_env: "OPENROUTER_API_KEY",
            base_url: "https://openrouter.ai/api/v1",
            reasoning_effort: Some("high"),
        }),
        "nanogpt-deepseek" => Some(Target {
            provider_key: "nanogpt",
            auth_provider: "nanogpt",
            model: "deepseek/deepseek-v4-pro:thinking",
            api_key_env: "NANOGPT_API_KEY",
            base_url: "https://nano-gpt.com/api/v1",
            reasoning_effort: Some("high"),
        }),
        _ => None,
    }
}

fn opencode_auth_key(provider: &str) -> Option<String> {
    let path = PathBuf::from("/home/eshen/.local/share/opencode/auth.json");
    let contents = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let key = value.get(provider)?.get("key")?.as_str()?.trim().to_owned();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// The fixed thinking → tool_use → tool_result conversation replayed at the
/// provider to exercise prior-turn reasoning handling.
fn replay_messages() -> Vec<WireMessage> {
    vec![
        WireMessage::text(
            WireRole::User,
            "Use the tool result and answer in one short sentence.",
        ),
        WireMessage::new(
            WireRole::Assistant,
            vec![
                WireBlock::Thinking {
                    thinking: "I need the lookup result before answering.".to_owned(),
                    carrier: ReasoningCarrier::default(),
                },
                WireBlock::ToolUse {
                    id: "call_live_reasoning_1".to_owned(),
                    name: "lookup_fact".to_owned(),
                    input: json!({"topic": "live smoke test"}),
                },
            ],
        ),
        WireMessage::new(
            WireRole::User,
            vec![WireBlock::ToolResult {
                tool_use_id: "call_live_reasoning_1".to_owned(),
                content: ToolResultContent::Text(
                    "The lookup result is: live reasoning replay succeeded.".to_owned(),
                ),
                is_error: false,
            }],
        ),
    ]
}

#[tokio::main]
async fn main() -> ExitCode {
    load_env_file();

    let Some(name) = env::args().nth(1) else {
        example_err!(
            "usage: live_reasoning_replay <deepseek|opencode-kimi|openrouter-kimi|nanogpt-deepseek>"
        );
        return ExitCode::from(2);
    };
    let Some(target) = target(&name) else {
        example_err!("unknown target: {name}");
        return ExitCode::from(2);
    };

    let Some(api_key) = env::var(target.api_key_env)
        .ok()
        .or_else(|| opencode_auth_key(target.auth_provider))
        .filter(|v| !v.trim().is_empty())
    else {
        example_err!(
            "{} is not set and opencode auth has no {} key",
            target.api_key_env,
            target.auth_provider
        );
        return ExitCode::from(2);
    };

    let provider_options =
        target
            .reasoning_effort
            .map(|effort| shore_daemon::llm::types::ProviderOptions {
                reasoning_effort: Some(effort.to_owned()),
                ..Default::default()
            });

    let request = LlmRequest {
        sdk: Sdk::Openai,
        model: target.model.to_owned(),
        api_key,
        api_key_name: Some("default".into()),
        base_url: Some(target.base_url.to_owned()),
        messages: replay_messages(),
        system: vec![SystemBlock::new(
            "You are a concise live API smoke-test assistant.",
            "system",
        )],
        tools: Some(vec![ToolDefinition::new(
            "lookup_fact",
            "Looks up one short fact for a live smoke test.",
            json!({
                "type": "object",
                "properties": {
                    "topic": {"type": "string"}
                },
                "required": ["topic"]
            }),
        )]),
        max_tokens: 96,
        temperature: Some(0.0),
        top_p: None,
        provider_options,
        provider_key: Some(target.provider_key.to_owned()),
        replay_prior_thinking: ThinkingReplay::All,
        rid: Some(format!("live-reasoning-replay-{name}")),
        forensic_character: None,
        retain_long: false,
        keepalive_interval: None,
    };

    let client = match LlmClient::try_new() {
        Ok(client) => client,
        Err(e) => {
            example_err!("failed to build HTTP client: {e}");
            return ExitCode::FAILURE;
        }
    };
    match client.generate(&request, None).await {
        Ok(resp) => {
            let text = resp.extract_text();
            example_out!(
                "PASS target={name} model={} finish_reason={} input_tokens={} output_tokens={} text={}",
                resp.model,
                resp.finish_reason,
                resp.usage.input_tokens,
                resp.usage.output_tokens,
                text.trim().replace('\n', " ")
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            example_err!("FAIL target={name} error={err}");
            ExitCode::from(1)
        }
    }
}
