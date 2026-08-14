pub mod client_config;
pub mod conn_manager;
pub mod connection;
pub mod discovery;
pub mod error;
pub mod sync;

pub use conn_manager::{ConnCommand, ConnEvent, spawn_connection};
pub use connection::{SWPConnection, ServerAddr};
pub use discovery::{discover_config_dir, discover_or_default};
pub use error::{ClientError, DiscoveryKind, Result};

#[cfg(test)]
mod tests {
    use crate::test_env::{set_env, unset_env};
    use tokio::io::duplex;

    use crate::protocol::client_msg::ClientMessage;
    use crate::protocol::server_msg::*;
    use crate::protocol::types::*;
    use crate::protocol::{MAX_WIRE_MESSAGE_SIZE, SWP_V1};

    use crate::swp_client::connection::SWPConnection;

    /// Helper: write a JSON line to a writer.
    async fn write_json_line<W: tokio::io::AsyncWriteExt + Unpin, T: serde::Serialize>(
        w: &mut W,
        val: &T,
    ) {
        let line = serde_json::to_string(val).unwrap();
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

    /// Helper: read one JSON line from a reader.
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

    /// The token every handshake test needs, since `do_handshake` resolves one
    /// before it sends anything.
    ///
    /// Set once and never cleared. The process environment is shared by this
    /// parallel test binary, so a test that removed it would break whichever
    /// neighbour happened to be mid-handshake. `token.rs`'s own tests use the
    /// injectable `resolve_token_with` and never touch the global at all.
    fn with_token() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| set_env(crate::token::TOKEN_ENV, "test-token"));
    }

    // ── Handshake tests ──────────────────────────────────────────────

    #[tokio::test]
    async fn handshake_success() {
        with_token();
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // Server sends hello
            let server_hello = ServerMessage::Hello(ServerHello {
                v: SWP_V1,
                server_name: "test-daemon".into(),
                characters: vec![CharacterInfo::new("alice")],
            });
            write_json_line(&mut w, &server_hello).await;

            // Server reads client hello
            let client_hello: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Hello(h) = client_hello else {
                panic!("expected client hello");
            };
            assert_eq!(h.client_type, "tui");
            assert_eq!(h.client_name, "test-client");
            assert!(h.capabilities.contains(&"streaming".to_owned()));
            // Resolved inside `do_handshake`, so no caller can forget it.
            assert_eq!(h.token.as_deref(), Some("test-token"));

            // Server sends history
            let history = ServerMessage::History(History {
                rid: None,
                messages: vec![Message {
                    msg_id: "m1".into(),
                    origin: None,
                    role: Role::User,
                    content: "hello".into(),
                    images: vec![],
                    content_blocks: vec![],
                    alt_index: None,
                    alt_count: None,
                    alternatives: vec![],
                    provider_key: None,
                    model: None,
                    timestamp: "2026-01-01T00:00:00Z".into(),
                }],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: Some("alice".into()),
                revision: 4,
            });
            write_json_line(&mut w, &history).await;
        });

        let (conn, server_hello, history) =
            SWPConnection::connect_raw(client_stream, "tui", "test-client", None)
                .await
                .unwrap();

        assert_eq!(server_hello.v, SWP_V1);
        assert_eq!(server_hello.server_name, "test-daemon");
        assert_eq!(server_hello.characters.len(), 1);
        assert_eq!(history.messages.len(), 1);
        assert_eq!(
            history
                .messages
                .first()
                .map(|message| message.content.as_str()),
            Some("hello")
        );
        assert_eq!(history.selected_character.as_deref(), Some("alice"));
        assert_eq!(history.revision, 4);

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_wrong_version() {
        with_token();
        let (client_stream, server_stream) = duplex(8192);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let bad_hello = ServerMessage::Hello(ServerHello {
                v: 999,
                server_name: "bad".into(),
                characters: vec![],
            });
            write_json_line(&mut w, &bad_hello).await;
        });

        let result = SWPConnection::connect_raw(client_stream, "tui", "test", None).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("unsupported protocol version"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn handshake_unexpected_first_message() {
        with_token();
        let (client_stream, server_stream) = duplex(8192);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let ping = ServerMessage::Ping(Ping {});
            write_json_line(&mut w, &ping).await;
        });

        let result = SWPConnection::connect_raw(client_stream, "tui", "test", None).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("expected server hello"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn handshake_skips_unknown_frames() {
        with_token();
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // A newer daemon emits an additive frame the client predates,
            // ahead of the hello. The client must skip it, not disconnect.
            write_raw_line(&mut w, r#"{"type":"future_warning","detail":"x"}"#).await;

            let server_hello = ServerMessage::Hello(ServerHello {
                v: SWP_V1,
                server_name: "test-daemon".into(),
                characters: vec![CharacterInfo::new("alice")],
            });
            write_json_line(&mut w, &server_hello).await;

            let client_hello: ClientMessage = read_json_line(&mut reader).await;
            assert!(matches!(client_hello, ClientMessage::Hello(_)));

            // Another unknown frame ahead of history — also skipped.
            write_raw_line(&mut w, r#"{"type":"another_future_frame"}"#).await;

            let history = ServerMessage::History(History {
                rid: None,
                messages: vec![],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: Some("alice".into()),
                revision: 1,
            });
            write_json_line(&mut w, &history).await;
        });

        let (conn, server_hello, history) =
            SWPConnection::connect_raw(client_stream, "tui", "test-client", None)
                .await
                .expect("handshake should skip unknown frames and succeed");

        assert_eq!(server_hello.server_name, "test-daemon");
        assert_eq!(history.revision, 1);

        drop(conn);
        server_handle.await.unwrap();
    }

    // ── Send/receive tests ───────────────────────────────────────────

    #[tokio::test]
    async fn send_and_receive_round_trip() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // Read client message
            let msg: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Message(m) = msg else {
                panic!("expected message");
            };
            assert_eq!(m.text, "test message");
            assert!(m.stream);

            // Send a ping back
            let pong = ServerMessage::Ping(Ping {});
            write_json_line(&mut w, &pong).await;
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let rid = conn.send_message("test message", true).await.unwrap();
        assert!(rid.is_some());

        let reply = conn.recv().await.unwrap();
        assert!(matches!(reply, ServerMessage::Ping(_)));

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn send_regen_and_command() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, _w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            // Read regen
            let regen_msg: ClientMessage = read_json_line(&mut reader).await;
            assert!(matches!(regen_msg, ClientMessage::Regen(_)));

            // Read command
            let command_msg: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Command(c) = command_msg else {
                panic!("expected command");
            };
            assert_eq!(c.name, "switch_character");
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let _regen_sent = conn.send_regen(true).await.unwrap();
        let _command_sent = conn
            .send_command("switch_character", serde_json::json!({"name": "alice"}))
            .await
            .unwrap();

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn recv_on_eof_returns_disconnected() {
        let (client_stream, server_stream) = duplex(8192);
        drop(server_stream); // close immediately

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let result = conn.recv().await;
        assert!(result.is_err());
        assert!(
            format!("{}", result.unwrap_err()).contains("disconnected"),
            "expected disconnected error"
        );
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
        with_token();
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

        let result = SWPConnection::connect_raw(client_stream, "tui", "test-client", None).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("maximum size"),
            "expected explicit framing limit error, got: {err}"
        );
    }

    // ── Discovery tests ──────────────────────────────────────────────

    #[test]
    fn discovery_instances_path_uses_xdg() {
        // Save and restore env
        let orig = std::env::var("XDG_RUNTIME_DIR").ok();
        set_env("XDG_RUNTIME_DIR", "/tmp/test-xdg");
        let path = crate::swp_client::discovery::instances_path();
        assert_eq!(path.to_str().unwrap(), "/tmp/test-xdg/shore/instances.json");
        // Restore
        match orig {
            Some(v) => set_env("XDG_RUNTIME_DIR", v),
            None => unset_env("XDG_RUNTIME_DIR"),
        }
    }

    // ── ClientConfig tests ──────────────────────────────────────────

    #[test]
    fn client_config_parses_tcp_address() {
        let toml = r#"default_address = "192.168.1.50:7320""#;
        let cfg: crate::swp_client::client_config::ClientConfig = toml::from_str(toml).unwrap();
        assert_eq!(cfg.default_address.as_deref(), Some("192.168.1.50:7320"));
    }

    #[test]
    fn client_config_empty_file() {
        let cfg: crate::swp_client::client_config::ClientConfig = toml::from_str("").unwrap();
        assert!(cfg.default_address.is_none());
    }

    #[test]
    fn client_config_rejects_unknown_fields() {
        let toml = r#"unknown_field = "oops""#;
        let result = toml::from_str::<crate::swp_client::client_config::ClientConfig>(toml);
        assert!(result.is_err());
    }
}
