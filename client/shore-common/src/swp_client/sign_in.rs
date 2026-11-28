use crate::protocol::web::{WebSignInGranted, WebSignInState};
use crate::swp_client::connection::{ServerAddr, transport};
use crate::swp_client::error::{ClientError, Result};

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

pub async fn password_set(addr: &ServerAddr) -> Result<bool> {
    let base = addr.base_url();
    let asked = reqwest::Client::new()
        .get(format!("{base}/api/sign-in"))
        .send()
        .await
        .map_err(transport)?;
    let (status, text) = answer(asked).await?;
    if !status.is_success() {
        return Err(ClientError::Refused(problem(&text, status)));
    }
    let state: WebSignInState = serde_json::from_str(&text).map_err(ClientError::Deserialize)?;
    Ok(state.password_set)
}

pub async fn choose_password(addr: &ServerAddr, password: &str) -> Result<()> {
    let base = addr.base_url();
    let chosen = reqwest::Client::new()
        .post(format!("{base}/api/password"))
        .json(&serde_json::json!({ "password": password }))
        .send()
        .await
        .map_err(transport)?;
    let (status, text) = answer(chosen).await?;
    if !status.is_success() {
        return Err(ClientError::Refused(problem(&text, status)));
    }
    Ok(())
}

pub async fn sign_in(addr: &ServerAddr, name: &str, password: &str) -> Result<String> {
    let base = addr.base_url();
    let asked = reqwest::Client::new()
        .post(format!("{base}/api/sign-in"))
        .json(&serde_json::json!({ "name": name, "password": password }))
        .send()
        .await
        .map_err(transport)?;
    let (status, text) = answer(asked).await?;
    if !status.is_success() {
        return Err(ClientError::Refused(problem(&text, status)));
    }
    let granted: WebSignInGranted =
        serde_json::from_str(&text).map_err(ClientError::Deserialize)?;
    Ok(granted.token)
}
