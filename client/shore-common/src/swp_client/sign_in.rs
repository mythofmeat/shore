use std::io::Read as _;

use base64::Engine as _;

use crate::protocol::web::{WebSignInGranted, WebSignInPending};
use crate::swp_client::connection::ServerAddr;
use crate::swp_client::error::{ClientError, Result};

fn secret() -> Result<String> {
    let mut bytes = [0_u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(ClientError::Io)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

async fn answer(response: reqwest::Response) -> Result<(reqwest::StatusCode, String)> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| ClientError::Connect(e.to_string()))?;
    Ok((status, text))
}

fn problem(text: &str, status: reqwest::StatusCode) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.get("message")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("the daemon answered HTTP {status}"))
}

pub async fn sign_in<F: FnOnce(&WebSignInPending)>(
    addr: &ServerAddr,
    name: &str,
    every: std::time::Duration,
    shown: F,
) -> Result<String> {
    let base = addr.base_url();
    let http = reqwest::Client::builder()
        .user_agent(concat!("shore/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| ClientError::Connect(e.to_string()))?;
    let secret = secret()?;
    let started = http
        .post(format!("{base}/api/sign-in"))
        .json(&serde_json::json!({ "name": name, "secret": secret }))
        .send()
        .await
        .map_err(|e| ClientError::Connect(format!("nothing answered at {base}: {e}")))?;
    let (status, text) = answer(started).await?;
    if !status.is_success() {
        return Err(ClientError::Refused(problem(&text, status)));
    }
    let pending: WebSignInPending =
        serde_json::from_str(&text).map_err(ClientError::Deserialize)?;
    shown(&pending);
    loop {
        tokio::time::sleep(every).await;
        let polled = http
            .post(format!("{base}/api/sign-in/{}", pending.id))
            .json(&serde_json::json!({ "secret": secret }))
            .send()
            .await
            .map_err(|e| ClientError::Connect(e.to_string()))?;
        let (decided, said) = answer(polled).await?;
        match decided {
            reqwest::StatusCode::ACCEPTED => {}
            reqwest::StatusCode::OK => {
                let granted: WebSignInGranted =
                    serde_json::from_str(&said).map_err(ClientError::Deserialize)?;
                return Ok(granted.token);
            }
            other => return Err(ClientError::Refused(problem(&said, other))),
        }
    }
}
