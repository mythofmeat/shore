use std::io::{self, IsTerminal as _, Read as _, Write as _};

use shore_common::protocol::web::{WebDevice, WebDeviceKind, WebDeviceList, WebLoginCode};
use shore_common::swp_client::sign_in::{choose_password, password_set};
use shore_common::swp_client::{SWPConnection, ServerAddr};

use crate::cli::DevicesCommand;

type Failure = Box<dyn std::error::Error>;

fn this_computer() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
        })
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "command line".to_owned())
}

fn password(stdin: bool, prompt: &str) -> Result<String, Failure> {
    if stdin {
        let mut text = String::new();
        _ = io::stdin().read_to_string(&mut text)?;
        return Ok(text.trim_end_matches(['\r', '\n']).to_owned());
    }
    if !io::stdin().is_terminal() {
        return Err(
            "there's no terminal to ask for the password on; pipe it in with --stdin".into(),
        );
    }
    crossterm::terminal::enable_raw_mode()?;
    let mut stderr = io::stderr();
    write!(stderr, "{prompt}")?;
    stderr.flush()?;
    let typed = crate::providers::read_keys();
    crossterm::terminal::disable_raw_mode()?;
    writeln!(stderr)?;
    typed
}

async fn chosen_password(addr: &ServerAddr, stdin: bool) -> Result<String, Failure> {
    cli_err!(
        "{} has no password yet. Choose one; every browser and CLI signs in with it.",
        addr.origin()
    );
    let chosen = password(stdin, "New password (not shown as you type): ")?;
    if !stdin && password(false, "Type it again: ")? != chosen {
        return Err("the two passwords differ; nothing changed".into());
    }
    choose_password(addr, &chosen).await?;
    Ok(chosen)
}

pub(crate) async fn sign_in(address: &str, name: Option<&str>, stdin: bool) -> Result<(), Failure> {
    let addr = ServerAddr(address.to_owned());
    let origin = addr.origin();
    let called = name.map_or_else(this_computer, str::to_owned);
    let given = if password_set(&addr).await? {
        password(stdin, "Password (not shown as you type): ")?
    } else {
        chosen_password(&addr, stdin).await?
    };
    let token = shore_common::swp_client::sign_in::sign_in(&addr, &called, &given).await?;
    let saved = shore_common::token::save_sign_in(&origin, &token)?;
    cli_out!(
        "Signed in to {origin}; the credential is kept in {}.",
        saved.display()
    );
    cli_out!(
        "Point the CLI there with --addr {origin}, SHORE_ADDR, or default_address in client.toml."
    );
    Ok(())
}

fn kind(device: &WebDevice) -> String {
    match device.kind {
        WebDeviceKind::Browser => "browser".to_owned(),
        WebDeviceKind::Cli => "command line".to_owned(),
        WebDeviceKind::Automation => format!(
            "automation key for {}",
            device.operations.as_deref().unwrap_or_default().join(", ")
        ),
    }
}

fn used(at: Option<u64>) -> String {
    let Some(stamp) = at.filter(|&ms| ms > 0) else {
        return "not used yet".to_owned();
    };
    i64::try_from(stamp)
        .ok()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map_or_else(
            || "used at an unreadable time".to_owned(),
            |when| {
                format!(
                    "used {}",
                    when.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M")
                )
            },
        )
}

fn print_devices(list: &WebDeviceList) {
    cli_out!("Signed in:");
    for device in &list.devices {
        let current = if device.current { "  (this one)" } else { "" };
        cli_out!(
            "  {}  {} · {} · {}{current}",
            device.id,
            device.name,
            kind(device),
            used(device.last_used_at)
        );
    }
}

pub(crate) async fn devices(
    conn: &mut SWPConnection,
    command: Option<&DevicesCommand>,
    json: bool,
) -> Result<(), Failure> {
    match command {
        None => {
            let answered: Option<WebDeviceList> = conn
                .post_web("/api/devices/list", &serde_json::json!({}))
                .await?;
            let list = answered.ok_or("the daemon sent no device list")?;
            if json {
                cli_out!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                print_devices(&list);
            }
        }
        Some(DevicesCommand::SignOut { id }) => {
            let _: Option<serde_json::Value> = conn
                .post_web("/api/devices/revoke", &serde_json::json!({ "id": id }))
                .await?;
            cli_out!("Signed out {id}.");
        }
        Some(DevicesCommand::Link { address }) => {
            let answered: Option<WebLoginCode> = conn
                .post_web("/api/login-code", &serde_json::json!({}))
                .await?;
            let code = answered.ok_or("the daemon sent no sign-in code")?;
            let origin = address.as_ref().map_or_else(
                || conn.origin().to_owned(),
                |given| ServerAddr(given.clone()).origin(),
            );
            if json {
                cli_out!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "link": format!("{origin}/#login={}", code.code),
                        "code": code.code,
                        "expires_at": code.expires_at,
                    }))?
                );
            } else {
                cli_out!("{origin}/#login={}", code.code);
                cli_out!(
                    "Open it in the browser within five minutes; it works once and saves typing the password there."
                );
            }
        }
    }
    Ok(())
}
