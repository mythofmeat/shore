use matrix_sdk::encryption::verification::Verification;
use matrix_sdk::event_handler::Ctx;
use matrix_sdk::ruma::events::key::verification::{
    key::ToDeviceKeyVerificationKeyEvent, request::ToDeviceKeyVerificationRequestEvent,
    start::ToDeviceKeyVerificationStartEvent,
};
use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::Client;
use tracing::{info, warn};

/// Wrapper for the trusted user ID, used as event handler context.
#[derive(Clone)]
pub(crate) struct TrustedUser(pub OwnedUserId);

/// Set up automatic SAS key verification for the trusted user.
///
/// Registers event handlers that automatically accept and confirm SAS
/// verification requests from the specified user, enabling E2E encryption
/// without manual emoji comparison.
pub fn setup_verification(
    client: &Client,
    trusted_user: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let trusted_user_id: OwnedUserId = trusted_user.try_into()?;

    client.add_event_handler_context(TrustedUser(trusted_user_id));

    client.add_event_handler(on_verification_request);
    client.add_event_handler(on_verification_start);
    client.add_event_handler(on_verification_key);

    info!("SAS auto-verification enabled for {trusted_user}");
    Ok(())
}

/// Accept incoming verification requests from the trusted user.
async fn on_verification_request(
    ev: ToDeviceKeyVerificationRequestEvent,
    client: Client,
    Ctx(trusted): Ctx<TrustedUser>,
) {
    if ev.sender != trusted.0 {
        return;
    }

    info!("accepting verification request from {}", ev.sender);
    if let Some(request) = client
        .encryption()
        .get_verification_request(&ev.sender, ev.content.transaction_id.as_str())
        .await
    {
        if let Err(e) = request.accept().await {
            warn!("failed to accept verification request: {e}");
        }
    }
}

/// Accept SAS start from the trusted user.
async fn on_verification_start(
    ev: ToDeviceKeyVerificationStartEvent,
    client: Client,
    Ctx(trusted): Ctx<TrustedUser>,
) {
    if ev.sender != trusted.0 {
        return;
    }

    info!("accepting SAS verification from {}", ev.sender);
    if let Some(Verification::SasV1(sas)) = client
        .encryption()
        .get_verification(&ev.sender, ev.content.transaction_id.as_str())
        .await
    {
        if let Err(e) = sas.accept().await {
            warn!("failed to accept SAS: {e}");
        }
    }
}

/// Auto-confirm SAS after key exchange with the trusted user.
async fn on_verification_key(
    ev: ToDeviceKeyVerificationKeyEvent,
    client: Client,
    Ctx(trusted): Ctx<TrustedUser>,
) {
    if ev.sender != trusted.0 {
        return;
    }

    info!("confirming SAS verification with {}", ev.sender);
    if let Some(Verification::SasV1(sas)) = client
        .encryption()
        .get_verification(&ev.sender, ev.content.transaction_id.as_str())
        .await
    {
        if let Err(e) = sas.confirm().await {
            warn!("failed to confirm SAS: {e}");
        }
    }
}
