use std::io::{self, IsTerminal, Read, Write};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::Value;
use shore_common::swp_client::SWPConnection;

use crate::cli::{KeyInput, KeyRequest, ProviderCommand, ProviderPlan, SignInRequest};

type Failure = Box<dyn std::error::Error>;

pub(crate) fn plan_or_report(
    command: &ProviderCommand,
) -> Result<Option<(ProviderPlan, bool)>, Failure> {
    let json = match command {
        ProviderCommand::Add(add) => add.json,
        ProviderCommand::Named(rest) => match crate::cli::provider_target(rest) {
            Ok((_, target)) => target.json,
            Err(error) => {
                let rendered = error.render().to_string();
                if matches!(
                    error.kind(),
                    clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
                ) {
                    cli_out!("{}", rendered.trim_end());
                    return Ok(None);
                }
                let message = rendered.trim_end();
                return Err(message
                    .strip_prefix("error: ")
                    .unwrap_or(message)
                    .to_owned()
                    .into());
            }
        },
        ProviderCommand::Models { .. } | ProviderCommand::Refresh { .. } => return Ok(None),
    };
    let plan = crate::cli::provider_plan(command)?;
    Ok(Some((plan, json)))
}

async fn command(conn: &mut SWPConnection, name: &str, args: Value) -> Result<Value, Failure> {
    _ = conn.send_command(name, args).await?;
    let data = crate::run::recv_command_data(conn).await?;
    crate::run::validate_registered_output(name, &data)?;
    Ok(data)
}

fn render(name: &str, data: &Value, json: bool) -> Result<(), Failure> {
    if json {
        cli_out!("{}", serde_json::to_string_pretty(data)?);
    } else if let Some(render) = crate::run::catalog_render(name) {
        render(data);
    } else {
        crate::output::format_command(name, data);
    }
    Ok(())
}

pub(crate) async fn run(
    conn: &mut SWPConnection,
    plan: ProviderPlan,
    json: bool,
) -> Result<(), Failure> {
    match plan {
        ProviderPlan::Op { name, args } => {
            let data = command(conn, name, args).await?;
            render(name, &data, json)
        }
        ProviderPlan::Confirm {
            prompt,
            yes,
            name,
            args,
        } => {
            if !yes && !confirm(&prompt)? {
                cli_err!("Left as it was.");
                return Ok(());
            }
            let data = command(conn, name, args).await?;
            render(name, &data, json)
        }
        ProviderPlan::Key(request) => {
            if request.asks_for_a_key() && signs_in(conn, &request.provider).await? {
                return sign_in(conn, &request.sign_in(), json).await;
            }
            add_key(conn, &request, json).await
        }
        ProviderPlan::SignIn(request) => sign_in(conn, &request, json).await,
        ProviderPlan::Add { args, key } => {
            let data = command(conn, "add_provider", args).await?;
            render("add_provider", &data, json)?;
            let Some(request) = key else {
                return Ok(());
            };
            let credentials = data
                .get("provider")
                .and_then(|provider| provider.get("credentials"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let usable = credentials
                .iter()
                .find(|c| c.get("standing").and_then(Value::as_str) != Some("missing"));
            match (&request.input, usable) {
                (KeyInput::Prompt, Some(found)) => {
                    let env = found
                        .get("env")
                        .and_then(Value::as_str)
                        .unwrap_or("its key");
                    cli_out!();
                    cli_out!(
                        "It reads ${env} from the daemon's environment. Add another key with `shore provider {} auth --add`.",
                        request.provider
                    );
                    Ok(())
                }
                (KeyInput::Prompt, None) if !io::stdin().is_terminal() || json => {
                    cli_out!();
                    cli_out!(
                        "Add its key with `shore provider {} auth --add`, or pipe one in with --stdin.",
                        request.provider
                    );
                    Ok(())
                }
                _ => {
                    cli_out!();
                    add_key(conn, &request, json).await
                }
            }
        }
    }
}

async fn signs_in(conn: &mut SWPConnection, provider: &str) -> Result<bool, Failure> {
    let detail = command(
        conn,
        "provider_detail",
        serde_json::json!({ "provider": provider }),
    )
    .await?;
    Ok(detail.get("credential_kind").and_then(Value::as_str) == Some("login"))
}

async fn sign_in(
    conn: &mut SWPConnection,
    request: &SignInRequest,
    json: bool,
) -> Result<(), Failure> {
    let started = command(conn, "start_sign_in", request.args()).await?;
    let field = |key: &str| {
        started
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let (provider, credential) = (field("provider"), field("credential"));
    cli_err!("{}:", field("message"));
    cli_err!();
    cli_err!("{}", field("url"));
    cli_err!();
    let Some(code) = read_code().await? else {
        _ = command(
            conn,
            "cancel_sign_in",
            serde_json::json!({ "provider": provider, "credential": credential }),
        )
        .await;
        return Err("stopped signing in; nothing changed".into());
    };
    let data = command(
        conn,
        "finish_sign_in",
        serde_json::json!({ "provider": provider, "credential": credential, "code": code }),
    )
    .await
    .inspect_err(|_| cli_err!("Run the same command again to pick the sign-in back up."))?;
    render("finish_sign_in", &data, json)
}

async fn read_code() -> Result<Option<String>, Failure> {
    let mut stderr = io::stderr();
    write!(stderr, "Paste the code here: ")?;
    stderr.flush()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    _ = std::thread::spawn(move || {
        let mut line = String::new();
        let read = io::stdin().read_line(&mut line);
        _ = sender.send(read.map(|_| line));
    });
    tokio::select! {
        read = receiver => {
            let code = read??.trim().to_owned();
            Ok((!code.is_empty()).then_some(code))
        }
        _ = tokio::signal::ctrl_c() => {
            writeln!(stderr)?;
            Ok(None)
        }
    }
}

async fn add_key(
    conn: &mut SWPConnection,
    request: &KeyRequest,
    json: bool,
) -> Result<(), Failure> {
    let secret = match &request.input {
        KeyInput::Env(_) => None,
        KeyInput::Stdin => Some(read_piped()?),
        KeyInput::Prompt => {
            let what = request
                .replace
                .as_deref()
                .or(request.name.as_deref())
                .filter(|n| !n.is_empty());
            let label = what.map_or_else(
                || format!("{} API key", request.provider),
                |name| format!("{} key {name}", request.provider),
            );
            Some(read_hidden(&format!("{label} (not shown as you type): "))?)
        }
    };
    let (name, args) = request.operation(secret.as_deref());
    let data = command(conn, name, args).await?;
    render(name, &data, json)
}

fn read_piped() -> Result<String, Failure> {
    let mut text = String::new();
    _ = io::stdin().read_to_string(&mut text)?;
    let secret = text.trim().to_owned();
    if secret.is_empty() {
        return Err("nothing came in on standard input".into());
    }
    Ok(secret)
}

fn read_hidden(prompt: &str) -> Result<String, Failure> {
    if !io::stdin().is_terminal() {
        return Err("there's no terminal to ask for the key on; pipe it in with --stdin, or point at an environment variable with --env".into());
    }
    let mut stderr = io::stderr();
    write!(stderr, "{prompt}")?;
    stderr.flush()?;
    crossterm::terminal::enable_raw_mode()?;
    let typed = read_keys();
    crossterm::terminal::disable_raw_mode()?;
    writeln!(stderr)?;
    let secret = typed?;
    if secret.trim().is_empty() {
        return Err("no key was typed; nothing changed".into());
    }
    Ok(secret.trim().to_owned())
}

fn read_keys() -> Result<String, Failure> {
    let mut secret = String::new();
    loop {
        match event::read()? {
            Event::Key(KeyEvent {
                code,
                modifiers,
                kind: KeyEventKind::Press | KeyEventKind::Repeat,
                ..
            }) => {
                let control = modifiers.contains(KeyModifiers::CONTROL);
                match code {
                    KeyCode::Enter => return Ok(secret),
                    KeyCode::Esc => return Err("cancelled; nothing changed".into()),
                    KeyCode::Char('c' | 'd') if control => {
                        return Err("cancelled; nothing changed".into());
                    }
                    KeyCode::Char('u') if control => secret.clear(),
                    KeyCode::Backspace => _ = secret.pop(),
                    KeyCode::Char(c) if !control => secret.push(c),
                    KeyCode::Char(_)
                    | KeyCode::Left
                    | KeyCode::Right
                    | KeyCode::Up
                    | KeyCode::Down
                    | KeyCode::Home
                    | KeyCode::End
                    | KeyCode::PageUp
                    | KeyCode::PageDown
                    | KeyCode::Tab
                    | KeyCode::BackTab
                    | KeyCode::Delete
                    | KeyCode::Insert
                    | KeyCode::F(_)
                    | KeyCode::Null
                    | KeyCode::CapsLock
                    | KeyCode::ScrollLock
                    | KeyCode::NumLock
                    | KeyCode::PrintScreen
                    | KeyCode::Pause
                    | KeyCode::Menu
                    | KeyCode::KeypadBegin
                    | KeyCode::Media(_)
                    | KeyCode::Modifier(_) => {}
                }
            }
            Event::Paste(text) => secret.push_str(text.trim()),
            Event::Key(_)
            | Event::FocusGained
            | Event::FocusLost
            | Event::Mouse(_)
            | Event::Resize(..) => {}
        }
    }
}

fn confirm(prompt: &str) -> Result<bool, Failure> {
    if !io::stdin().is_terminal() {
        return Err(
            format!("{prompt} This can't be undone; re-run with --yes to go ahead.").into(),
        );
    }
    cli_err!("{prompt} [y/N]");
    let mut answer = String::new();
    _ = io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}
