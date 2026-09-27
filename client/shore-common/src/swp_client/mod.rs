pub mod client_config;
pub mod conn_manager;
pub mod connection;
pub mod discovery;
pub mod error;
pub mod sync;

pub use conn_manager::{ConnCommand, ConnEvent, spawn_connection};
pub use connection::{SWPConnection, ServerAddr, read_image_upload};
pub use discovery::{discover_config_dir, discover_or_default};
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
    async fn handshake_success() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            let server_hello = ServerMessage::Hello(ServerHello {
                v: SWP_V1,
                server_name: "test-daemon".into(),
                server_version: None,
                characters: vec![CharacterInfo::new("alice")],
            });
            write_json_line(&mut w, &server_hello).await;

            let client_hello: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Hello(h) = client_hello else {
                panic!("expected client hello");
            };
            assert_eq!(h.client_type, "tui");
            assert_eq!(h.client_name, "test-client");
            assert!(h.capabilities.contains(&"streaming".to_owned()));
            assert_eq!(h.token.as_deref(), Some("test-token"));

            let history = ServerMessage::History(History {
                delta: None,
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
                selected_thread: None,
                revision: 4,
            });
            write_json_line(&mut w, &history).await;
        });

        let (conn, server_hello, history) =
            SWPConnection::connect_raw(client_stream, "tui", "test-client", None, &test_token())
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
    async fn handshake_unexpected_first_message() {
        let (client_stream, server_stream) = duplex(8192);

        let _ignored = tokio::spawn(async move {
            let (_r, mut w) = tokio::io::split(server_stream);
            let ping = ServerMessage::Ping(Ping {});
            write_json_line(&mut w, &ping).await;
        });

        let result =
            SWPConnection::connect_raw(client_stream, "tui", "test", None, &test_token()).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            format!("{err}").contains("expected server hello"),
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
                active_start: 0,
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
    async fn send_and_receive_round_trip() {
        let (client_stream, server_stream) = duplex(8192);

        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);

            let msg: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Message(m) = msg else {
                panic!("expected message");
            };
            assert_eq!(m.text, "test message");
            assert!(m.stream);

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

            let regen_msg: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Regen(regen) = regen_msg else {
                panic!("expected regen");
            };
            assert_eq!(regen.guidance.as_deref(), Some("consult memory"));

            let command_msg: ClientMessage = read_json_line(&mut reader).await;
            let ClientMessage::Command(c) = command_msg else {
                panic!("expected command");
            };
            assert_eq!(c.name, "switch_character");
        });

        let mut conn = SWPConnection::from_raw_stream(client_stream);
        let _regen_sent = conn
            .send_regen(true, Some("consult memory".into()))
            .await
            .unwrap();
        let _command_sent = conn
            .send_command("switch_character", serde_json::json!({"name": "alice"}))
            .await
            .unwrap();

        drop(conn);
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn typed_operation_preserves_arguments_and_reply_correlation() {
        use crate::protocol::operations::{ForkThread, ForkThreadArgs};

        let (client_stream, server_stream) = duplex(8192);
        let server_handle = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_stream);
            let mut reader = tokio::io::BufReader::new(r);
            let command: serde_json::Value = read_json_line(&mut reader).await;
            assert_eq!(command.get("type").unwrap(), "command");
            assert_eq!(command.get("name").unwrap(), "fork_thread");
            assert_eq!(
                command.get("args").unwrap(),
                &serde_json::json!({"name": "branch", "from": "main", "turns": 2})
            );
            let rid = command.get("rid").unwrap().as_str().unwrap();
            assert!(!rid.is_empty());
            for (reply_rid, name) in [
                ("unrelated", "fork_thread"),
                (rid, "list_threads"),
                (rid, "fork_thread"),
            ] {
                write_json_line(&mut w, &serde_json::json!({
                    "type": "command_output", "rid": reply_rid, "name": name,
                    "data": {"character": "ada", "threads": [], "current": "main", "home": "main"}
                })).await;
            }
        });
        let mut connection = SWPConnection::from_raw_stream(client_stream);
        let rid = connection
            .send_operation::<ForkThread>(ForkThreadArgs {
                name: "branch".into(),
                from: Some("main".into()),
                turns: Some(2),
            })
            .await
            .unwrap();
        assert!(rid.is_some());
        for matches in [false, false, true] {
            let reply = connection.recv().await.unwrap();
            assert_eq!(connection.matches_last_request(&reply), matches);
        }
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn recv_on_eof_returns_disconnected() {
        let (client_stream, server_stream) = duplex(8192);
        drop(server_stream);

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
