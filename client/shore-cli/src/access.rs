use std::time::Duration;

use shore_common::protocol::web::{WebDevice, WebDeviceKind, WebDeviceList, WebLoginCode};
use shore_common::swp_client::{SWPConnection, ServerAddr};

use crate::cli::DevicesCommand;

type Failure = Box<dyn std::error::Error>;

const POLL_EVERY: Duration = Duration::from_secs(2);

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

pub(crate) async fn sign_in(address: &str, name: Option<&str>) -> Result<(), Failure> {
    let addr = ServerAddr(address.to_owned());
    let origin = addr.origin();
    let called = name.map_or_else(this_computer, str::to_owned);
    let every = std::env::var("SHORE_SIGN_IN_POLL_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .map_or(POLL_EVERY, Duration::from_millis);
    let token = shore_common::swp_client::sign_in::sign_in(&addr, &called, every, |pending| {
        cli_err!("To let this CLI in as {called:?}, allow the code");
        cli_err!();
        cli_err!("    {}", pending.code);
        cli_err!();
        cli_err!(
            "in the web UI (Settings › Devices), or with `shore devices allow {}` on a CLI that's already signed in.",
            pending.code
        );
        cli_err!("Waiting for up to five minutes...");
    })
    .await?;
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
    if !list.requests.is_empty() {
        cli_out!("Waiting to sign in:");
        for request in &list.requests {
            cli_out!("  {}  {}", request.code, request.name);
        }
        cli_out!("  (shore devices allow <code>, or shore devices refuse <code>)");
        cli_out!();
    }
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
        Some(DevicesCommand::Allow { code } | DevicesCommand::Refuse { code }) => {
            let allow = matches!(command, Some(DevicesCommand::Allow { .. }));
            let _: Option<serde_json::Value> = conn
                .post_web(
                    "/api/devices/decide",
                    &serde_json::json!({ "code": code, "allow": allow }),
                )
                .await?;
            if allow {
                cli_out!("Let in the CLI showing {code}.");
            } else {
                cli_out!("Turned away the CLI showing {code}.");
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
                    "Open it in the browser within five minutes; it works once. A browser that can't open it can take the code: {}",
                    code.code
                );
            }
        }
    }
    Ok(())
}
