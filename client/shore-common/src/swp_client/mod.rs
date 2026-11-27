pub mod client_config;
pub mod connection;
mod daemon_version;
pub mod discovery;
pub mod error;
pub mod sign_in;

pub use connection::{DEFAULT_WEB_PORT, SWPConnection, ServerAddr, read_image_upload};
pub use daemon_version::daemon_version;
pub use discovery::discover_or_default;
pub use error::{ClientError, DiscoveryKind, Result};

#[cfg(test)]
mod tests {
    #[test]
    fn client_config_rejects_unknown_fields() {
        let toml = r#"unknown_field = "oops""#;
        let result = toml::from_str::<crate::swp_client::client_config::ClientConfig>(toml);
        assert!(result.is_err(), "an unknown field is refused");
    }
}
