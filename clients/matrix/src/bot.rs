use std::path::{Path, PathBuf};

use matrix_sdk::config::SyncSettings;
use matrix_sdk::event_handler::Ctx;
use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
use matrix_sdk::ruma::events::room::member::StrippedRoomMemberEvent;
use matrix_sdk::ruma::events::room::message::{
    MessageType, OriginalSyncRoomMessageEvent, RoomMessageEventContent,
};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, RoomId};
use matrix_sdk::{Client, Room};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

/// Configuration for the Matrix bot.
pub struct BotConfig {
    pub homeserver: String,
    pub user_id: String,
    pub access_token: Option<String>,
    pub password: Option<String>,
    pub device_id: Option<String>,
    pub store_path: String,
    pub config_dir: PathBuf,
}

/// Events from Matrix forwarded to the bridge loop.
#[derive(Debug)]
pub enum MatrixEvent {
    /// A text message was sent in a room.
    Message {
        room_id: OwnedRoomId,
        sender: OwnedUserId,
        text: String,
    },
    /// An image was sent in a room (downloaded to a local temp path).
    Image {
        room_id: OwnedRoomId,
        sender: OwnedUserId,
        path: String,
        body: String,
    },
}

/// The Matrix bot client.
pub struct MatrixBot {
    pub client: Client,
    config_dir: PathBuf,
}

impl MatrixBot {
    /// Create a new Matrix bot and return it with a receiver for Matrix events.
    pub async fn new(
        config: &BotConfig,
    ) -> Result<(Self, mpsc::Receiver<MatrixEvent>), Box<dyn std::error::Error>> {
        let (tx, rx) = mpsc::channel::<MatrixEvent>(256);

        let client = Client::builder()
            .homeserver_url(&config.homeserver)
            .sqlite_store(&config.store_path, None::<&str>)
            .build()
            .await?;

        // Authenticate
        if let Some(ref password) = config.password {
            let mut login = client
                .matrix_auth()
                .login_username(&config.user_id, password);
            if let Some(ref device_id) = config.device_id {
                login = login.device_id(device_id);
            }
            login
                .initial_device_display_name("Shore Matrix Bridge")
                .send()
                .await?;
            info!("logged in as {} with password", config.user_id);
        } else if let Some(ref token) = config.access_token {
            let user_id: OwnedUserId = config.user_id.as_str().try_into()?;
            let device_id = config.device_id.as_deref().unwrap_or("SHORE_MATRIX");

            let session = matrix_sdk::authentication::matrix::MatrixSession {
                meta: matrix_sdk::SessionMeta {
                    user_id,
                    device_id: device_id.into(),
                },
                tokens: matrix_sdk::SessionTokens {
                    access_token: token.clone(),
                    refresh_token: None,
                },
            };
            client.restore_session(session).await?;
            info!("restored session for {}", config.user_id);
        } else {
            return Err("either --password or --access-token is required".into());
        }

        // Register event handlers
        client.add_event_handler_context(tx);
        client.add_event_handler(Self::on_stripped_member);
        client.add_event_handler(Self::on_room_message);

        Ok((
            Self {
                client,
                config_dir: config.config_dir.clone(),
            },
            rx,
        ))
    }

    /// Start the Matrix sync loop in the background.
    pub fn start_sync(&self) {
        let client = self.client.clone();
        tokio::spawn(async move {
            info!("starting Matrix sync");
            if let Err(e) = client.sync(SyncSettings::default()).await {
                error!("Matrix sync error: {e}");
            }
        });
    }

    /// Send a text message (with markdown formatting) to a room.
    pub async fn send_text(&self, room_id: &RoomId, text: &str) {
        let Some(room) = self.client.get_room(room_id) else {
            warn!("room {room_id} not found");
            return;
        };
        let content = RoomMessageEventContent::text_markdown(text);
        if let Err(e) = room.send(content).await {
            error!("failed to send message to {room_id}: {e}");
        }
    }

    /// Upload and send an image to a room.
    pub async fn send_image(&self, room_id: &RoomId, path: &str, caption: Option<&str>) {
        let Some(room) = self.client.get_room(room_id) else {
            warn!("room {room_id} not found");
            return;
        };
        let data = match tokio::fs::read(path).await {
            Ok(d) => d,
            Err(e) => {
                error!("failed to read image {path}: {e}");
                return;
            }
        };
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        let filename = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());

        let body = caption.unwrap_or(&filename);
        let config = matrix_sdk::attachment::AttachmentConfig::new();
        if let Err(e) = room.send_attachment(body, &mime, data, config).await {
            error!("failed to send image to {room_id}: {e}");
        }
    }

    /// Set or clear the typing indicator in a room.
    pub async fn set_typing(&self, room_id: &RoomId, typing: bool) {
        if let Some(room) = self.client.get_room(room_id) {
            let _ = room.typing_notice(typing).await;
        }
    }

    /// Upload character avatar and set display name on the Matrix profile.
    ///
    /// Looks for `avatar.{png,jpg,jpeg,webp}` in the character config
    /// directory (`<config>/characters/<character>/`). Always sets the display
    /// name to the character name.
    pub async fn sync_avatar(&self, character: &str) {
        // Set display name to character name
        if let Err(e) = self
            .client
            .account()
            .set_display_name(Some(character))
            .await
        {
            warn!("failed to set display name: {e}");
        } else {
            info!("display name set to {character}");
        }

        for path in avatar_candidates(&self.config_dir, character) {
            if path.exists() {
                match tokio::fs::read(&path).await {
                    Ok(data) => {
                        let mime = mime_guess::from_path(&path).first_or_octet_stream();
                        if let Err(e) = self.client.account().upload_avatar(&mime, data).await {
                            warn!("failed to upload avatar: {e}");
                        } else {
                            info!("uploaded avatar for {character} from {}", path.display());
                        }
                    }
                    Err(e) => warn!("failed to read avatar file {}: {e}", path.display()),
                }
                return;
            }
        }
        info!("no avatar file found for {character}");
    }

    // --- Event handlers ---

    /// Auto-join rooms the bot is invited to.
    async fn on_stripped_member(ev: StrippedRoomMemberEvent, room: Room, client: Client) {
        if client.user_id() == Some(&*ev.state_key) {
            info!("auto-joining room {}", room.room_id());
            if let Err(e) = room.join().await {
                warn!("failed to auto-join {}: {e}", room.room_id());
            }
        }
    }

    /// Forward text and image messages from Matrix users to the bridge.
    async fn on_room_message(
        ev: OriginalSyncRoomMessageEvent,
        room: Room,
        client: Client,
        Ctx(tx): Ctx<mpsc::Sender<MatrixEvent>>,
    ) {
        // Skip our own messages
        if client.user_id() == Some(&*ev.sender) {
            return;
        }

        match &ev.content.msgtype {
            MessageType::Text(text_content) => {
                let _ = tx
                    .send(MatrixEvent::Message {
                        room_id: room.room_id().to_owned(),
                        sender: ev.sender.clone(),
                        text: text_content.body.clone(),
                    })
                    .await;
            }
            MessageType::Image(image_content) => {
                // Download image from Matrix homeserver
                let request = MediaRequestParameters {
                    source: image_content.source.clone(),
                    format: MediaFormat::File,
                };
                match client.media().get_media_content(&request, false).await {
                    Ok(data) => {
                        let filename = &image_content.body;
                        let temp_path = std::env::temp_dir()
                            .join(format!("shore_matrix_{}_{filename}", std::process::id()));
                        if let Err(e) = tokio::fs::write(&temp_path, &data).await {
                            warn!("failed to save downloaded image: {e}");
                            return;
                        }
                        let _ = tx
                            .send(MatrixEvent::Image {
                                room_id: room.room_id().to_owned(),
                                sender: ev.sender.clone(),
                                path: temp_path.to_string_lossy().into_owned(),
                                body: image_content.body.clone(),
                            })
                            .await;
                    }
                    Err(e) => {
                        warn!("failed to download image from Matrix: {e}");
                    }
                }
            }
            _ => {}
        }
    }
}

/// Candidate character avatar files, in lookup priority order.
pub fn avatar_candidates(config_dir: &Path, character: &str) -> Vec<PathBuf> {
    let char_dir = shore_config::character_config_dir(config_dir, character);
    ["png", "jpg", "jpeg", "webp"]
        .into_iter()
        .map(|ext| char_dir.join(format!("avatar.{ext}")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::avatar_candidates;
    use std::path::PathBuf;

    #[test]
    fn avatar_candidates_use_character_config_dir() {
        let config_dir = PathBuf::from("/home/user/.config/shore");
        let paths = avatar_candidates(&config_dir, "qifei");

        assert_eq!(
            paths,
            vec![
                PathBuf::from("/home/user/.config/shore/characters/qifei/avatar.png"),
                PathBuf::from("/home/user/.config/shore/characters/qifei/avatar.jpg"),
                PathBuf::from("/home/user/.config/shore/characters/qifei/avatar.jpeg"),
                PathBuf::from("/home/user/.config/shore/characters/qifei/avatar.webp"),
            ]
        );
    }
}
