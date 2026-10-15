pub mod client_config;
pub mod conn_manager;
pub mod connection;
pub mod discovery;
pub mod error;
pub mod sync;

pub use conn_manager::{ConnCommand, ConnEvent, spawn_connection};
pub use connection::{SWPConnection, ServerAddr, read_image_upload};
pub use discovery::discover_or_default;
pub use error::{ClientError, DiscoveryKind, Result};

#[cfg(test)]
mod tests {
    use crate::token::TokenSource;
    use tokio::io::duplex;

    use crate::protocol::client_msg::ClientMessage;
    use crate::protocol::server_msg::*;
    use crate::protocol::types::*;
    use crate::protocol::{MAX_WIRE_MESSAGE_SIZE, SWP_V1};

    use crate::swp_client::connection::SWPConnection;

    async fn write_json_line<W: tokio::io::AsyncWriteExt + Unpin, T: serde::Serialize>(
        w: &mut W,
        val: &T,
    ) {
        let line = serde_json::to_string(val).unwrap();
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

    async fn read_json_line<
        R: tokio::io::AsyncBufReadExt + Unpin,
        T: serde::de::DeserializeOwned,
    >(
        r: &mut R,
    ) -> T {
        let mut line = String::new();
        let _ignored = r.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    async fn write_raw_line<W: tokio::io::AsyncWriteExt + Unpin>(w: &mut W, line: &str) {
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

    fn test_token() -> TokenSource {
        TokenSource::Given("test-token".into())
    }

    #[tokio::test]
    async fn handshake_wrong_version() {
        let (client_stream, server_stream) = duplex(8192);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let bad_hello = ServerMessage::Hello(ServerHello {
                v: 999,
                server_name: "bad".into(),
                server_version: None,
                characters: vec![],
            });
            write_json_line(&mut w, &bad_hello).await;
        });

        let result =
            SWPConnection::connect_raw(client_stream, "tui", "test", None, &test_token()).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("unsupported protocol version"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn handshake_skips_unknown_frames() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            write_raw_line(&mut w, r#"{"type":"future_warning","detail":"x"}"#).await;

            let server_hello = ServerMessage::Hello(ServerHello {
                v: SWP_V1,
                server_name: "test-daemon".into(),
                server_version: None,
                characters: vec![CharacterInfo::new("alice")],
            });
            write_json_line(&mut w, &server_hello).await;

            let client_hello: ClientMessage = read_json_line(&mut reader).await;
            assert!(matches!(client_hello, ClientMessage::Hello(_)));

            write_raw_line(&mut w, r#"{"type":"another_future_frame"}"#).await;

            let history = ServerMessage::History(History {
                delta: None,
                rid: None,
                messages: vec![],
                previous_segment: None,
                config: serde_json::json!({}),
                selected_character: Some("alice".into()),
                selected_thread: None,
                revision: 1,
            });
            write_json_line(&mut w, &history).await;
        });

        let (conn, server_hello, history) =
            SWPConnection::connect_raw(client_stream, "tui", "test-client", None, &test_token())
                .await
                .expect("handshake should skip unknown frames and succeed");

        assert_eq!(server_hello.server_name, "test-daemon");
        assert_eq!(history.revision, 1);

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn recv_rejects_oversized_server_message() {
        let (client_stream, server_stream) = duplex(MAX_WIRE_MESSAGE_SIZE + 4096);

        let server_handle = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let oversized = ServerMessage::Error(Error {
                rid: None,
                code: crate::protocol::error::ErrorCode::InternalError,
                message: "x".repeat(MAX_WIRE_MESSAGE_SIZE + 1),
                retry_after_ms: None,
            });
            let line = serde_json::to_string(&oversized).unwrap();
            write_raw_line(&mut w, &line).await;
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let result = conn.recv().await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("maximum size"),
            "expected explicit framing limit error, got: {err}"
        );

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_rejects_oversized_server_hello() {
        let (client_stream, server_stream) = duplex(MAX_WIRE_MESSAGE_SIZE + 4096);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let oversized = serde_json::json!({
                "type": "hello",
                "v": SWP_V1,
                "server_name": "x".repeat(MAX_WIRE_MESSAGE_SIZE + 1),
                "characters": [],
            });
            write_raw_line(&mut w, &serde_json::to_string(&oversized).unwrap()).await;
        });

        let result =
            SWPConnection::connect_raw(client_stream, "tui", "test-client", None, &test_token())
                .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("maximum size"),
            "expected explicit framing limit error, got: {err}"
        );
    }

    #[test]
    fn client_config_rejects_unknown_fields() {
        let toml = r#"unknown_field = "oops""#;
        let result = toml::from_str::<crate::swp_client::client_config::ClientConfig>(toml);
        assert!(result.is_err());
    }
}
