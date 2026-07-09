use base64::Engine as _;
use shore_protocol::client_msg::{
    Cancel, ClientMessage, ClientMessageBody, Command, ImageUpload, Regen,
};
use shore_protocol::server_msg::{MessageOrigin, ServerMessage};
use shore_protocol::types::ImageRef;

/// Routing decision for a Matrix message.
#[derive(Debug)]
pub enum MatrixInput {
    /// Regular text → SWP user message.
    Text(String),
    /// Image attachment → SWP message with base64 image data.
    Image {
        /// Local temp copy, sent as a legacy `images` path for daemons that
        /// share the bridge's filesystem.
        path: String,
        /// Raw image bytes, sent base64-encoded via `image_data`.
        data: Vec<u8>,
        /// Declared media type from the Matrix event (`info.mimetype`).
        mime_type: Option<String>,
        caption: Option<String>,
    },
    /// `!bind [character]` — bridge-local room binding (None lists bindings).
    Bind { character: Option<String> },
    /// `!view [key] [on|off|toggle]` — per-room display preferences
    /// (thinking / tools / usage). `key: None` shows current settings;
    /// `value: None` toggles.
    View {
        key: Option<String>,
        value: Option<bool>,
    },
    /// One or more SWP messages to forward to the daemon, in order.
    Forward(Vec<ClientMessage>),
    /// Bridge-local reply (help text, usage hints, "not applicable").
    LocalReply(String),
}

/// Parse a Matrix message into a routing decision.
///
/// Messages starting with `!` are commands; the bridge mirrors the TUI's
/// slash-command translation so users get the same behavior they'd expect
/// from `/foo` in the terminal client. Unknown commands fall through to
/// the daemon as generic `Command { name, args: { "text": rest } }` so
/// power users can hit daemon commands the TUI doesn't shortcut (e.g.
/// `!heartbeat_log`, `!model_info`, `!log`).
pub fn parse_matrix_input(text: &str) -> MatrixInput {
    let Some(rest) = text.strip_prefix('!') else {
        return MatrixInput::Text(text.to_string());
    };
    let rest = rest.trim();
    let (name, args) = match rest.split_once(char::is_whitespace) {
        Some((n, a)) => (n, a.trim()),
        None => (rest, ""),
    };
    parse_bang_command(name, args)
}

fn parse_bang_command(name: &str, args: &str) -> MatrixInput {
    match name {
        // Bridge-handled
        "bind" => MatrixInput::Bind {
            character: (!args.is_empty()).then(|| args.to_string()),
        },

        // Local-only replies
        "help" => MatrixInput::LocalReply(help_text()),
        "clear" | "q" | "quit" => MatrixInput::LocalReply(format!(
            "`!{name}` is a TUI affordance with no Matrix equivalent."
        )),
        "image" => MatrixInput::LocalReply(
            "Send images as Matrix attachments — the bridge picks them up automatically.".into(),
        ),

        // Direct SWP message types
        "cancel" => forward_one(ClientMessage::Cancel(Cancel {})),
        "regen" => forward_one(ClientMessage::Regen(Regen {
            rid: None,
            stream: true,
            guidance: (!args.is_empty()).then(|| args.to_string()),
        })),
        "speak" => MatrixInput::LocalReply(
            "Text-to-speech was removed from Shore; `!speak` is no longer supported.".into(),
        ),

        // Translated daemon commands
        "character" => parse_character(args),
        "model" => parse_model(args),
        "setting" => parse_setting(args),
        "status" => forward_command("status", serde_json::json!({})),
        "memory" => {
            if args.is_empty() {
                MatrixInput::LocalReply("usage: `!memory <query>`".into())
            } else {
                forward_command("memory", serde_json::json!({ "query": args }))
            }
        }
        "compact" => parse_compact(args),
        "delete" => parse_delete(args),
        "edit" => parse_edit(args),
        "sys" | "system" => {
            if args.is_empty() {
                MatrixInput::LocalReply("usage: `!sys <instruction>`".into())
            } else {
                forward_command("inject_system", serde_json::json!({ "text": args }))
            }
        }
        "reasoning" => parse_reasoning(args),
        "alt" => parse_alt(args),
        "view" => parse_view(args),

        // Fallback — any unknown command goes to the daemon as a generic
        // Command. The daemon will reject it with "Unknown command" if it
        // isn't registered there either.
        _ => {
            let args_json = if args.is_empty() {
                serde_json::Value::Object(Default::default())
            } else {
                serde_json::json!({ "text": args })
            };
            forward_command(name, args_json)
        }
    }
}

fn forward_one(msg: ClientMessage) -> MatrixInput {
    MatrixInput::Forward(vec![msg])
}

fn forward_command(name: &str, args: serde_json::Value) -> MatrixInput {
    forward_one(ClientMessage::Command(Command {
        rid: None,
        name: name.to_string(),
        args,
    }))
}

fn parse_character(args: &str) -> MatrixInput {
    if args.is_empty() {
        forward_command("list_characters", serde_json::json!({}))
    } else {
        forward_command("switch_character", serde_json::json!({ "name": args }))
    }
}

fn parse_model(args: &str) -> MatrixInput {
    let (include_hidden, rest) = match args.split_once(' ') {
        Some(("all", rest)) => (true, rest.trim()),
        _ if args == "all" => (true, ""),
        _ => (false, args),
    };
    if rest.is_empty() {
        let mut a = serde_json::json!({});
        if include_hidden {
            a["include_hidden"] = serde_json::json!(true);
        }
        forward_command("list_models", a)
    } else if rest == "reset" {
        forward_command("reset_model", serde_json::json!({}))
    } else {
        let mut a = serde_json::json!({ "name": rest });
        if include_hidden {
            a["include_hidden"] = serde_json::json!(true);
        }
        MatrixInput::Forward(vec![
            ClientMessage::Command(Command {
                rid: None,
                name: "switch_model".into(),
                args: a,
            }),
            ClientMessage::Command(Command {
                rid: None,
                name: "status".into(),
                args: serde_json::json!({}),
            }),
        ])
    }
}

fn parse_setting(args: &str) -> MatrixInput {
    if args.is_empty() {
        forward_command("model_settings", serde_json::json!({}))
    } else if let Some(("reset", key)) = args.split_once(' ') {
        let key = key.trim();
        if key.is_empty() {
            MatrixInput::LocalReply("usage: `!setting reset <key>`".into())
        } else {
            forward_command(
                "set_model_setting",
                serde_json::json!({
                    "key": key,
                    "value": serde_json::Value::Null,
                    "scope": "character",
                }),
            )
        }
    } else if let Some((key, value)) = args.split_once(' ') {
        let value = value.trim();
        forward_command(
            "set_model_setting",
            serde_json::json!({
                "key": key,
                "value": parse_setting_value_str(key, value),
                "scope": "character",
            }),
        )
    } else {
        MatrixInput::LocalReply(
            "usage: `!setting [<key> <value>]` or `!setting reset <key>`".into(),
        )
    }
}

fn parse_compact(args: &str) -> MatrixInput {
    let mut a = serde_json::json!({});
    if !args.is_empty() {
        match args.parse::<u32>() {
            Ok(n) => {
                a["keep_turns"] = serde_json::json!(n);
            }
            Err(_) => return MatrixInput::LocalReply("usage: `!compact [keep_turns]`".into()),
        }
    }
    forward_command("compact", a)
}

fn parse_delete(args: &str) -> MatrixInput {
    if args.is_empty() {
        return MatrixInput::LocalReply("usage: `!delete <ref>` (e.g. `last`, `-1`)".into());
    }
    let refs: Vec<&str> = args.split_whitespace().collect();
    let args_json = if refs.len() == 1 {
        serde_json::json!({ "refs": refs[0] })
    } else {
        serde_json::json!({ "refs": refs })
    };
    forward_command("delete", args_json)
}

fn parse_edit(args: &str) -> MatrixInput {
    let usage = "usage: `!edit <ref> <new content>`";
    let Some((raw_ref, content)) = args.split_once(char::is_whitespace) else {
        return MatrixInput::LocalReply(usage.into());
    };
    let content = content.trim();
    if raw_ref.is_empty() || content.is_empty() {
        return MatrixInput::LocalReply(usage.into());
    }
    forward_command(
        "edit",
        serde_json::json!({ "ref": raw_ref, "content": content }),
    )
}

fn parse_reasoning(args: &str) -> MatrixInput {
    // Thin sugar over `!setting reasoning_effort …`: reasoning_effort
    // lives in the same per-model preferences store as the rest of the
    // sampler, so route through `set_model_setting` / `model_settings`.
    if args.is_empty() {
        return forward_command("model_settings", serde_json::json!({}));
    }
    if args.eq_ignore_ascii_case("reset") {
        return forward_command(
            "set_model_setting",
            serde_json::json!({
                "key": "reasoning_effort",
                "value": serde_json::Value::Null,
                "scope": "character",
            }),
        );
    }
    forward_command(
        "set_model_setting",
        serde_json::json!({
            "key": "reasoning_effort",
            "value": parse_setting_value_str("reasoning_effort", args),
            "scope": "character",
        }),
    )
}

/// `!view [key] [on|off|toggle]` — mirrors the TUI's `:view` toggles that
/// make sense over Matrix (thinking / tools / usage).
fn parse_view(args: &str) -> MatrixInput {
    const USAGE: &str = "usage: `!view [thinking|tools|usage] [on|off|toggle]`";
    let mut parts = args.split_whitespace();
    let Some(key) = parts.next() else {
        return MatrixInput::View {
            key: None,
            value: None,
        };
    };
    let value = match parts.next().map(str::to_ascii_lowercase).as_deref() {
        None | Some("toggle") => None,
        Some("on" | "true" | "yes" | "1") => Some(true),
        Some("off" | "false" | "no" | "0") => Some(false),
        Some(_) => return MatrixInput::LocalReply(USAGE.into()),
    };
    if parts.next().is_some() {
        return MatrixInput::LocalReply(USAGE.into());
    }
    MatrixInput::View {
        key: Some(key.to_ascii_lowercase()),
        value,
    }
}

/// Selector half of an `!alt` invocation: which alternative to switch to.
enum AltSelector {
    Direction(&'static str),
    Position(u64),
}

fn classify_alt_selector(word: &str) -> Option<AltSelector> {
    match word.to_ascii_lowercase().as_str() {
        "next" => Some(AltSelector::Direction("next")),
        "prev" | "previous" => Some(AltSelector::Direction("prev")),
        _ => match word.parse::<u64>() {
            // 1-based position; 0 is never valid and negative ints are refs.
            Ok(n) if n > 0 => Some(AltSelector::Position(n)),
            _ => None,
        },
    }
}

/// `!alt` — browse/select alternate responses (the TUI's alt picker).
///
/// - `!alt` / `!alt <ref>` — list alternatives (of the last assistant
///   message, or of `<ref>`; refs are `last`, negative indices, msg_ids)
/// - `!alt next|prev` / `!alt <n>` — switch the last assistant message's
///   alternative (by direction or 1-based position)
/// - `!alt <ref> next|prev|<n>` — same, for a specific message
fn parse_alt(args: &str) -> MatrixInput {
    const USAGE: &str = "usage: `!alt [ref] [next|prev|<position>]`";
    let parts: Vec<&str> = args.split_whitespace().collect();
    let (msg_ref, selector) = match parts.as_slice() {
        [] => {
            return forward_command("list_alternatives", serde_json::json!({}));
        }
        [one] => match classify_alt_selector(one) {
            Some(sel) => (None, sel),
            // Not a selector → treat as a message ref and list its alternatives.
            None => {
                return forward_command("list_alternatives", serde_json::json!({ "ref": one }));
            }
        },
        [msg_ref, sel] => match classify_alt_selector(sel) {
            Some(sel) => (Some(*msg_ref), sel),
            None => return MatrixInput::LocalReply(USAGE.into()),
        },
        _ => return MatrixInput::LocalReply(USAGE.into()),
    };
    let mut a = serde_json::Map::new();
    if let Some(r) = msg_ref {
        a.insert("ref".into(), serde_json::json!(r));
    }
    match selector {
        AltSelector::Direction(d) => a.insert("direction".into(), serde_json::json!(d)),
        AltSelector::Position(n) => a.insert("position".into(), serde_json::json!(n)),
    };
    forward_command("alt", serde_json::Value::Object(a))
}

/// Map a `!setting` value string to the JSON shape the daemon's
/// `set_model_setting` expects. Mirrors the TUI's `parse_setting_value_str`.
fn parse_setting_value_str(key: &str, raw: &str) -> serde_json::Value {
    use serde_json::Value;
    let trimmed = raw.trim();
    match key {
        "thinking_enabled" => match trimmed.to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => Value::Bool(true),
            "false" | "no" | "off" | "0" => Value::Bool(false),
            _ => Value::String(trimmed.to_string()),
        },
        "temperature" | "top_p" => trimmed
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(trimmed.to_string())),
        "budget_tokens" | "max_tokens" => trimmed
            .parse::<u64>()
            .map(|n| Value::Number(n.into()))
            .unwrap_or_else(|_| Value::String(trimmed.to_string())),
        "reasoning_effort" => match trimmed.to_ascii_lowercase().as_str() {
            "off" | "none" | "disable" | "disabled" | "unset" | "" => Value::String("off".into()),
            _ => Value::String(trimmed.to_string()),
        },
        _ => Value::String(trimmed.to_string()),
    }
}

fn help_text() -> String {
    [
        "**Native Matrix interactions**",
        "- Edit your message → the conversation updates and the reply can be regenerated",
        "- Delete (redact) a message → it's removed from the conversation",
        "- React 🔁 to the latest reply → regenerate",
        "- React 🗑️ to any message → delete it",
        "- React ◀️ / ▶️ on a reply → cycle alternate responses",
        "",
        "**Bridge commands**",
        "- `!bind [character]` — bind this room to a character (no arg lists bindings)",
        "- `!view [thinking|tools|usage] [on|off|toggle]` — per-room display of generation internals",
        "",
        "**Conversation**",
        "- `!regen [guidance]` — regenerate the last response",
        "- `!alt [ref] [next|prev|<n>]` — list or switch alternate responses",
        "- `!cancel` — cancel an in-flight generation",
        "- `!log [count]` — fetch recent message history",
        "- `!edit <ref> <content>` — edit a message by ref (e.g. `last`, `-1`)",
        "- `!delete <ref...>` — delete one or more messages",
        "- `!compact [keep_turns]` — compact the conversation",
        "- `!sys <instruction>` — inject a system message",
        "",
        "**State**",
        "- `!status` — show daemon/character status",
        "- `!character [name]` — list characters or switch",
        "- `!model [name|all|reset]` — list/switch models",
        "- `!setting [<key> <value>|reset <key>]` — view or change sampler settings",
        "- `!reasoning [value|reset]` — set reasoning effort",
        "- `!memory <query>` — search character memory",
        "",
        "Unknown `!cmd` is forwarded to the daemon as-is.",
    ]
    .join("\n")
}

/// Convert a Text or Image input to a single SWP `ClientMessage`. Returns
/// `None` for variants that the bridge handles directly (Bind / Forward /
/// LocalReply) — those are dispatched in the main loop.
pub fn input_to_swp(input: &MatrixInput) -> Option<ClientMessage> {
    match input {
        MatrixInput::Text(text) => Some(ClientMessage::Message(ClientMessageBody {
            rid: None,
            text: text.clone(),
            stream: true,
            images: vec![],
            image_data: vec![],
            absence_seconds: None,
            overrides: None,
        })),
        MatrixInput::Image {
            path,
            data,
            mime_type,
            caption,
        } => Some(ClientMessage::Message(ClientMessageBody {
            rid: None,
            text: caption.clone().unwrap_or_default(),
            stream: true,
            // Legacy path mechanism, kept for older daemons. Daemons that
            // understand image_data prefer it when both are present, so a
            // path the daemon can't see (PrivateTmp, remote daemon) is
            // harmless.
            images: vec![path.clone()],
            image_data: vec![ImageUpload {
                filename: sanitize_filename(caption.as_deref().unwrap_or_default()),
                data: base64::engine::general_purpose::STANDARD.encode(data),
                mime_type: mime_type.clone(),
            }],
            absence_seconds: None,
            overrides: None,
        })),
        MatrixInput::Bind { .. }
        | MatrixInput::View { .. }
        | MatrixInput::Forward(_)
        | MatrixInput::LocalReply(_) => None,
    }
}

/// Reduce a Matrix image event body to a single safe path component for use
/// as a filename. The body is arbitrary remote input: a separator in it would
/// break (or escape) any path built from it, so keep only the last component
/// and fall back to `"image"` when nothing usable remains.
pub fn sanitize_filename(body: &str) -> String {
    let name = body.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    match name {
        "" | "." | ".." => "image".to_string(),
        n => n.to_string(),
    }
}

/// An image buffered during streaming, to be sent as a Matrix attachment.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingImage {
    pub path: String,
    pub caption: Option<String>,
}

/// Action the bridge should take after processing a daemon message.
pub enum CollectorAction {
    /// Start typing indicator in the active room.
    StartTyping,
    /// Send a text message with optional image attachments.
    SendMessage {
        text: String,
        images: Vec<PendingImage>,
    },
    /// Send a command response (rendered by the caller).
    SendCommandOutput {
        name: String,
        data: serde_json::Value,
    },
    /// Send an error message.
    SendError(String),
    /// Send an autonomous/push message.
    SendPush(String),
    /// No action needed.
    None,
}

/// Collects daemon streaming responses and buffered images.
#[derive(Default)]
pub struct ResponseCollector {
    images: Vec<PendingImage>,
    streaming: bool,
}

impl ResponseCollector {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(dead_code)]
    pub fn is_streaming(&self) -> bool {
        self.streaming
    }

    /// Feed a server message and return the action to take.
    pub fn feed(&mut self, msg: &ServerMessage) -> CollectorAction {
        match msg {
            ServerMessage::StreamStart(_) => {
                self.streaming = true;
                self.images.clear();
                CollectorAction::StartTyping
            }
            ServerMessage::StreamChunk(_) => {
                // Chunks accumulate server-side; re-assert typing on each one so
                // the indicator survives generations longer than the ~4s Matrix
                // typing timeout (the SDK debounces to one request per 3s).
                CollectorAction::StartTyping
            }
            ServerMessage::StreamEnd(end) => {
                self.streaming = false;
                let images = std::mem::take(&mut self.images);
                CollectorAction::SendMessage {
                    text: end.content.clone(),
                    images,
                }
            }
            ServerMessage::SendImage(img) => {
                self.images.push(PendingImage {
                    path: img.path.clone(),
                    caption: img.caption.clone(),
                });
                CollectorAction::None
            }
            ServerMessage::CommandOutput(out) => CollectorAction::SendCommandOutput {
                name: out.name.clone(),
                data: out.data.clone(),
            },
            ServerMessage::Error(err) => {
                CollectorAction::SendError(format!("{:?}: {}", err.code, err.message))
            }
            ServerMessage::NewMessage(new_msg) => {
                CollectorAction::SendPush(new_msg.message.content.clone())
            }
            _ => CollectorAction::None,
        }
    }
}

// ── Conversation mirroring ─────────────────────────────────────────────────
//
// In mirror modes (`mirror = "all"` or the default `"replies"`), the daemon
// broadcasts every conversation message as `NewMessage` (tagged with
// `character` and `MessageOrigin`) and the bridge routes each one to the right
// room. This module only *translates* frames; mode-dependent filtering — in
// `"replies"` mode other clients' prompts and their replies stay out of the
// room — is applied by the caller, which knows which generations the bridge
// itself requested. Streaming frames stay private to the originating session;
// `NewMessage(AssistantReply)` is the single source of truth for reply content
// (this also avoids double-posting a Matrix-originated reply).

/// Which room a routed daemon message targets, before room resolution.
#[derive(Debug, PartialEq, Eq)]
pub enum RoomTarget {
    /// The room bound to this character; the caller falls back to the active
    /// room when the character is unknown or unbound.
    Character(Option<String>),
    /// The active conversation room (stream lifecycle, command/error replies).
    Active,
}

/// What to do with a routed message once its room is resolved.
#[derive(Debug, PartialEq)]
pub enum MirrorAction {
    /// Start the typing indicator.
    StartTyping,
    /// Stop the typing indicator (no content; the reply arrives via NewMessage).
    StopTyping,
    /// Post assistant/autonomous content as the character bot.
    Post {
        /// Daemon message id, for the event map. `None` on legacy daemons.
        msg_id: Option<String>,
        /// `alternatives.len() >= 2` on a *fresh* `AssistantReply` means this
        /// message replaced the previous reply (regen attaches the old content
        /// as an alternative) — the caller edits the old reply in place
        /// instead of appending.
        replaces_last: bool,
        /// Heartbeat-initiated message — never the product of a stream this
        /// bridge is mirroring, so it must not adopt an in-flight streamed
        /// event.
        autonomous: bool,
        /// Concatenated thinking blocks, for rooms with `!view thinking on`.
        thinking: Option<String>,
        text: String,
        images: Vec<PendingImage>,
    },
    /// Mirror a user prompt that arrived for this character. The caller drops it
    /// first if it is this bridge's own echo (see self-echo suppression).
    UserPrompt {
        msg_id: Option<String>,
        content: String,
    },
    /// Post a command response (rendered by the caller).
    CommandOutput {
        name: String,
        data: serde_json::Value,
    },
    /// Post an error.
    Error(String),
    /// Post dimmed system output (`m.notice`) — warnings and the like.
    Notice(String),
    /// Nothing to do for this frame.
    None,
}

/// A routed daemon message in `mirror_all` mode.
#[derive(Debug, PartialEq)]
pub struct MirrorRoute {
    pub target: RoomTarget,
    pub action: MirrorAction,
}

/// Route a daemon message in `mirror_all` mode.
///
/// Pure: room resolution, typing/send IO, and self-echo suppression are handled
/// by the caller. `NewMessage` routes by `character`; everything else that needs
/// a room rides the active conversation room.
pub fn route_mirror(msg: &ServerMessage) -> MirrorRoute {
    match msg {
        ServerMessage::NewMessage(nm) => {
            let character = nm.character.clone();
            let msg_id = Some(nm.message.msg_id.clone()).filter(|id| !id.is_empty());
            let action = match nm.message.origin {
                Some(MessageOrigin::UserInput) => MirrorAction::UserPrompt {
                    msg_id,
                    content: nm.message.content.clone(),
                },
                // AssistantReply, Autonomous, or unset → post as the bot.
                _ => {
                    let alt_count = nm
                        .message
                        .alt_count
                        .map(|c| c as usize)
                        .unwrap_or(nm.message.alternatives.len());
                    // Regen persists the replacement with the prior reply
                    // attached as an alternative, so a *fresh* AssistantReply
                    // carrying ≥2 alternatives displaced the previous reply.
                    let replaces_last =
                        nm.message.origin == Some(MessageOrigin::AssistantReply) && alt_count >= 2;
                    MirrorAction::Post {
                        msg_id,
                        replaces_last,
                        autonomous: nm.message.origin == Some(MessageOrigin::Autonomous),
                        thinking: extract_thinking(&nm.message.content_blocks),
                        text: nm.message.content.clone(),
                        images: pending_images(&nm.message.images),
                    }
                }
            };
            MirrorRoute {
                target: RoomTarget::Character(character),
                action,
            }
        }
        ServerMessage::StreamStart(_) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::StartTyping,
        },
        // Re-assert typing per chunk; the indicator otherwise expires ~4s in
        // (matrix-sdk debounces, so this costs at most one request per 3s).
        ServerMessage::StreamChunk(_) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::StartTyping,
        },
        ServerMessage::StreamEnd(_) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::StopTyping,
        },
        ServerMessage::CommandOutput(out) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::CommandOutput {
                name: out.name.clone(),
                data: out.data.clone(),
            },
        },
        ServerMessage::Error(err) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::Error(format!("{:?}: {}", err.code, err.message)),
        },
        ServerMessage::UsageWarning(w) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::Notice(format!(
                "⚠️ {} — ${:.2} of ${:.2} ({:.0}%) this {}",
                w.message,
                w.current_cost,
                w.cost_limit,
                w.percent_used * 100.0,
                w.period,
            )),
        },
        ServerMessage::CacheWarning(w) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::Notice(format!("⚠️ cache: {}", w.message)),
        },
        ServerMessage::ProviderFallbackWarning(w) => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::Notice(match w.status {
                Some(status) => format!(
                    "⚠️ provider `{}`: key **{}** failed ({}, HTTP {status}) — now using **{}**",
                    w.provider, w.from_key, w.kind, w.to_key,
                ),
                None => format!(
                    "⚠️ provider `{}`: key **{}** failed ({}) — now using **{}**",
                    w.provider, w.from_key, w.kind, w.to_key,
                ),
            }),
        },
        // SendImage is covered by the NewMessage images in mirror mode;
        // Ping/Hello/History/Shutdown and any unknown frame need no per-room
        // action here.
        _ => MirrorRoute {
            target: RoomTarget::Active,
            action: MirrorAction::None,
        },
    }
}

/// Concatenate a message's thinking blocks (redacted ones are ciphertext and
/// are skipped). `None` when the message carries no readable thinking.
fn extract_thinking(blocks: &[shore_protocol::types::ContentBlock]) -> Option<String> {
    let parts: Vec<&str> = blocks
        .iter()
        .filter_map(|b| match b {
            shore_protocol::types::ContentBlock::Thinking { thinking, .. } => {
                Some(thinking.as_str())
            }
            _ => None,
        })
        .filter(|t| !t.trim().is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn pending_images(images: &[ImageRef]) -> Vec<PendingImage> {
    images
        .iter()
        .map(|img| PendingImage {
            path: img.path.clone(),
            caption: img.caption.clone(),
        })
        .collect()
}

/// A control action requested by reacting to a mapped message.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ReactionControl {
    /// Regenerate the last reply (valid only on the room's latest reply).
    Regen,
    /// Delete the reacted-to message.
    Delete,
    /// Switch to the previous alternate response.
    AltPrev,
    /// Switch to the next alternate response.
    AltNext,
}

/// Map a reaction emoji to a control action.
///
/// Variation selectors (U+FE0F) are stripped first so emoji-style and
/// text-style renderings of the same character both match.
pub fn parse_reaction(key: &str) -> Option<ReactionControl> {
    let normalized: String = key.chars().filter(|&c| c != '\u{fe0f}').collect();
    match normalized.as_str() {
        "🔁" | "🔄" => Some(ReactionControl::Regen),
        "🗑" | "❌" => Some(ReactionControl::Delete),
        "◀" | "⬅" => Some(ReactionControl::AltPrev),
        "▶" | "➡" => Some(ReactionControl::AltNext),
        _ => None,
    }
}

/// Render a user prompt that arrived from another client (CLI/TUI) for mirroring
/// into the Matrix room. Blockquoted and prefixed so it reads as someone else's
/// input rather than the character bot speaking.
pub fn format_user_mirror(content: &str) -> String {
    let mut out = String::new();
    let mut lines = content.lines();
    match lines.next() {
        Some(first) => out.push_str(&format!("> \u{1f464} {first}")),
        None => return "> \u{1f464}".to_string(),
    }
    for line in lines {
        out.push_str(&format!("\n> {line}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use shore_protocol::server_msg::*;
    use shore_protocol::types::*;

    fn forward_msgs(input: MatrixInput) -> Vec<ClientMessage> {
        match input {
            MatrixInput::Forward(msgs) => msgs,
            other => panic!("expected Forward, got {:?}", other),
        }
    }

    fn forward_command_only(input: MatrixInput) -> Command {
        let mut msgs = forward_msgs(input);
        assert_eq!(msgs.len(), 1, "expected single forwarded message");
        match msgs.remove(0) {
            ClientMessage::Command(c) => c,
            other => panic!("expected Command, got {:?}", other),
        }
    }

    #[test]
    fn parse_text_message() {
        match parse_matrix_input("hello world") {
            MatrixInput::Text(t) => assert_eq!(t, "hello world"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn parse_bind_no_arg() {
        match parse_matrix_input("!bind") {
            MatrixInput::Bind { character } => assert!(character.is_none()),
            other => panic!("expected Bind, got {:?}", other),
        }
    }

    #[test]
    fn parse_bind_with_character() {
        match parse_matrix_input("!bind Alice") {
            MatrixInput::Bind { character } => assert_eq!(character.as_deref(), Some("Alice")),
            other => panic!("expected Bind, got {:?}", other),
        }
    }

    #[test]
    fn parse_help_returns_local_reply() {
        let input = parse_matrix_input("!help");
        match input {
            MatrixInput::LocalReply(text) => {
                assert!(text.contains("!regen"));
                assert!(text.contains("!status"));
            }
            other => panic!("expected LocalReply, got {:?}", other),
        }
    }

    #[test]
    fn parse_image_command_explains_attachments() {
        let input = parse_matrix_input("!image");
        match input {
            MatrixInput::LocalReply(text) => assert!(text.contains("attachment")),
            other => panic!("expected LocalReply, got {:?}", other),
        }
    }

    #[test]
    fn parse_clear_and_quit_explain_inapplicability() {
        for cmd in ["!clear", "!q", "!quit"] {
            match parse_matrix_input(cmd) {
                MatrixInput::LocalReply(text) => assert!(text.contains("no Matrix equivalent")),
                other => panic!("{cmd}: expected LocalReply, got {:?}", other),
            }
        }
    }

    #[test]
    fn parse_cancel() {
        let input = parse_matrix_input("!cancel");
        let msgs = forward_msgs(input);
        assert_eq!(msgs.len(), 1);
        assert!(matches!(msgs[0], ClientMessage::Cancel(_)));
    }

    #[test]
    fn parse_regen_no_guidance() {
        let input = parse_matrix_input("!regen");
        let msgs = forward_msgs(input);
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            ClientMessage::Regen(r) => {
                assert!(r.stream);
                assert!(r.guidance.is_none());
            }
            other => panic!("expected Regen, got {:?}", other),
        }
    }

    #[test]
    fn parse_regen_with_guidance() {
        let input = parse_matrix_input("!regen be more concise");
        match &forward_msgs(input)[0] {
            ClientMessage::Regen(r) => assert_eq!(r.guidance.as_deref(), Some("be more concise")),
            other => panic!("expected Regen, got {:?}", other),
        }
    }

    #[test]
    fn parse_speak_reports_removed() {
        // TTS was removed from the protocol; every `!speak ...` form should
        // now be a bridge-local reply rather than a forwarded SWP message.
        for input in ["!speak", "!speak on", "!speak off", "!speak loud"] {
            match parse_matrix_input(input) {
                MatrixInput::LocalReply(text) => {
                    assert!(text.contains("no longer supported"), "got: {text}")
                }
                other => panic!("expected LocalReply for {input:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn parse_character_lists_with_no_arg() {
        let cmd = forward_command_only(parse_matrix_input("!character"));
        assert_eq!(cmd.name, "list_characters");
    }

    #[test]
    fn parse_character_switches_with_name() {
        let cmd = forward_command_only(parse_matrix_input("!character Alice"));
        assert_eq!(cmd.name, "switch_character");
        assert_eq!(cmd.args["name"], "Alice");
    }

    #[test]
    fn parse_model_lists() {
        let cmd = forward_command_only(parse_matrix_input("!model"));
        assert_eq!(cmd.name, "list_models");
        assert!(cmd.args.get("include_hidden").is_none());
    }

    #[test]
    fn parse_model_all_includes_hidden() {
        let cmd = forward_command_only(parse_matrix_input("!model all"));
        assert_eq!(cmd.name, "list_models");
        assert_eq!(cmd.args["include_hidden"], true);
    }

    #[test]
    fn parse_model_reset() {
        let cmd = forward_command_only(parse_matrix_input("!model reset"));
        assert_eq!(cmd.name, "reset_model");
    }

    #[test]
    fn parse_model_switch_sends_status_followup() {
        let input = parse_matrix_input("!model gpt-4");
        let msgs = forward_msgs(input);
        assert_eq!(msgs.len(), 2);
        match &msgs[0] {
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "switch_model");
                assert_eq!(c.args["name"], "gpt-4");
            }
            _ => panic!("expected switch_model first"),
        }
        match &msgs[1] {
            ClientMessage::Command(c) => assert_eq!(c.name, "status"),
            _ => panic!("expected status second"),
        }
    }

    #[test]
    fn parse_model_switch_all_marks_include_hidden() {
        let msgs = forward_msgs(parse_matrix_input("!model all hidden-model"));
        match &msgs[0] {
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "switch_model");
                assert_eq!(c.args["name"], "hidden-model");
                assert_eq!(c.args["include_hidden"], true);
            }
            _ => panic!("expected switch_model"),
        }
    }

    #[test]
    fn parse_setting_lists() {
        let cmd = forward_command_only(parse_matrix_input("!setting"));
        assert_eq!(cmd.name, "model_settings");
    }

    #[test]
    fn parse_setting_assigns_value() {
        let cmd = forward_command_only(parse_matrix_input("!setting temperature 0.7"));
        assert_eq!(cmd.name, "set_model_setting");
        assert_eq!(cmd.args["key"], "temperature");
        assert_eq!(cmd.args["value"], 0.7);
        assert_eq!(cmd.args["scope"], "character");
    }

    #[test]
    fn parse_setting_reset_clears_value() {
        let cmd = forward_command_only(parse_matrix_input("!setting reset temperature"));
        assert_eq!(cmd.name, "set_model_setting");
        assert_eq!(cmd.args["key"], "temperature");
        assert!(cmd.args["value"].is_null());
    }

    #[test]
    fn parse_setting_typed_values() {
        let cmd = forward_command_only(parse_matrix_input("!setting thinking_enabled on"));
        assert_eq!(cmd.args["value"], true);

        let cmd = forward_command_only(parse_matrix_input("!setting max_tokens 4096"));
        assert_eq!(cmd.args["value"], 4096);

        let cmd = forward_command_only(parse_matrix_input("!setting reasoning_effort off"));
        assert_eq!(cmd.args["value"], "off");
    }

    #[test]
    fn parse_status() {
        let cmd = forward_command_only(parse_matrix_input("!status"));
        assert_eq!(cmd.name, "status");
    }

    #[test]
    fn parse_memory_requires_query() {
        match parse_matrix_input("!memory") {
            MatrixInput::LocalReply(t) => assert!(t.contains("usage")),
            other => panic!("expected LocalReply, got {:?}", other),
        }

        let cmd = forward_command_only(parse_matrix_input("!memory tea"));
        assert_eq!(cmd.name, "memory");
        assert_eq!(cmd.args["query"], "tea");
    }

    #[test]
    fn parse_compact_variants() {
        let cmd = forward_command_only(parse_matrix_input("!compact"));
        assert_eq!(cmd.name, "compact");
        assert!(cmd.args.get("keep_turns").is_none());

        let cmd = forward_command_only(parse_matrix_input("!compact 5"));
        assert_eq!(cmd.args["keep_turns"], 5);

        match parse_matrix_input("!compact bogus") {
            MatrixInput::LocalReply(t) => assert!(t.contains("usage")),
            other => panic!("expected LocalReply, got {:?}", other),
        }
    }

    #[test]
    fn parse_delete_variants() {
        match parse_matrix_input("!delete") {
            MatrixInput::LocalReply(t) => assert!(t.contains("usage")),
            other => panic!("expected LocalReply, got {:?}", other),
        }

        let cmd = forward_command_only(parse_matrix_input("!delete last"));
        assert_eq!(cmd.args["refs"], "last");

        let cmd = forward_command_only(parse_matrix_input("!delete -1 -2"));
        assert_eq!(cmd.args["refs"], serde_json::json!(["-1", "-2"]));
    }

    #[test]
    fn parse_edit_requires_ref_and_content() {
        match parse_matrix_input("!edit") {
            MatrixInput::LocalReply(t) => assert!(t.contains("usage")),
            other => panic!("expected LocalReply, got {:?}", other),
        }
        match parse_matrix_input("!edit last") {
            MatrixInput::LocalReply(t) => assert!(t.contains("usage")),
            other => panic!("expected LocalReply, got {:?}", other),
        }

        let cmd = forward_command_only(parse_matrix_input("!edit last new content here"));
        assert_eq!(cmd.name, "edit");
        assert_eq!(cmd.args["ref"], "last");
        assert_eq!(cmd.args["content"], "new content here");
    }

    #[test]
    fn parse_sys_inject() {
        let cmd = forward_command_only(parse_matrix_input("!sys be brief"));
        assert_eq!(cmd.name, "inject_system");
        assert_eq!(cmd.args["text"], "be brief");

        let cmd = forward_command_only(parse_matrix_input("!system be brief"));
        assert_eq!(cmd.name, "inject_system");
    }

    #[test]
    fn parse_reasoning_variants() {
        // Bare `!reasoning` shows the effective sampler.
        let cmd = forward_command_only(parse_matrix_input("!reasoning"));
        assert_eq!(cmd.name, "model_settings");
        assert!(cmd.args.as_object().unwrap().is_empty());

        // A value is stored under the reasoning_effort key on the
        // active model's preferences (character scope).
        let cmd = forward_command_only(parse_matrix_input("!reasoning high"));
        assert_eq!(cmd.name, "set_model_setting");
        assert_eq!(cmd.args["key"], "reasoning_effort");
        assert_eq!(cmd.args["value"], "high");
        assert_eq!(cmd.args["scope"], "character");

        // Disable synonyms collapse to the "off" sentinel.
        let cmd = forward_command_only(parse_matrix_input("!reasoning off"));
        assert_eq!(cmd.name, "set_model_setting");
        assert_eq!(cmd.args["value"], "off");

        // `reset` clears the saved value (null → use config default).
        let cmd = forward_command_only(parse_matrix_input("!reasoning reset"));
        assert_eq!(cmd.name, "set_model_setting");
        assert_eq!(cmd.args["key"], "reasoning_effort");
        assert!(cmd.args["value"].is_null());
    }

    #[test]
    fn parse_alt_variants() {
        // Bare → list alternatives of the last assistant message.
        let cmd = forward_command_only(parse_matrix_input("!alt"));
        assert_eq!(cmd.name, "list_alternatives");
        assert!(cmd.args.as_object().unwrap().is_empty());

        // A lone non-selector arg is a message ref.
        let cmd = forward_command_only(parse_matrix_input("!alt -2"));
        assert_eq!(cmd.name, "list_alternatives");
        assert_eq!(cmd.args["ref"], "-2");

        // Directions switch the last assistant message's alternative.
        let cmd = forward_command_only(parse_matrix_input("!alt next"));
        assert_eq!(cmd.name, "alt");
        assert_eq!(cmd.args["direction"], "next");
        assert!(cmd.args.get("ref").is_none());

        let cmd = forward_command_only(parse_matrix_input("!alt previous"));
        assert_eq!(cmd.args["direction"], "prev");

        // Positive integers are 1-based positions, not refs.
        let cmd = forward_command_only(parse_matrix_input("!alt 2"));
        assert_eq!(cmd.name, "alt");
        assert_eq!(cmd.args["position"], 2);

        // Ref + selector.
        let cmd = forward_command_only(parse_matrix_input("!alt -3 prev"));
        assert_eq!(cmd.name, "alt");
        assert_eq!(cmd.args["ref"], "-3");
        assert_eq!(cmd.args["direction"], "prev");

        let cmd = forward_command_only(parse_matrix_input("!alt last 3"));
        assert_eq!(cmd.args["ref"], "last");
        assert_eq!(cmd.args["position"], 3);

        // Unrecognized selector → usage hint.
        match parse_matrix_input("!alt last bogus") {
            MatrixInput::LocalReply(t) => assert!(t.contains("usage")),
            other => panic!("expected LocalReply, got {other:?}"),
        }
    }

    #[test]
    fn parse_view_variants() {
        // Bare → show current settings.
        match parse_matrix_input("!view") {
            MatrixInput::View { key: None, value } => assert!(value.is_none()),
            other => panic!("expected View, got {other:?}"),
        }

        // Key alone toggles.
        match parse_matrix_input("!view thinking") {
            MatrixInput::View { key, value } => {
                assert_eq!(key.as_deref(), Some("thinking"));
                assert!(value.is_none());
            }
            other => panic!("expected View, got {other:?}"),
        }

        // Explicit on/off (case-insensitive key).
        match parse_matrix_input("!view TOOLS on") {
            MatrixInput::View { key, value } => {
                assert_eq!(key.as_deref(), Some("tools"));
                assert_eq!(value, Some(true));
            }
            other => panic!("expected View, got {other:?}"),
        }
        match parse_matrix_input("!view usage off") {
            MatrixInput::View { key, value } => {
                assert_eq!(key.as_deref(), Some("usage"));
                assert_eq!(value, Some(false));
            }
            other => panic!("expected View, got {other:?}"),
        }

        // Junk value / extra args → usage hint.
        for bad in ["!view thinking maybe", "!view thinking on extra"] {
            match parse_matrix_input(bad) {
                MatrixInput::LocalReply(t) => assert!(t.contains("usage"), "{bad}"),
                other => panic!("{bad}: expected LocalReply, got {other:?}"),
            }
        }
    }

    #[test]
    fn extract_thinking_joins_blocks_and_skips_redacted() {
        use shore_protocol::types::ContentBlock;
        let blocks = vec![
            ContentBlock::Thinking {
                thinking: "first thought".into(),
                signature: None,
            },
            ContentBlock::Text {
                text: "the reply".into(),
            },
            ContentBlock::RedactedThinking {
                data: "opaque".into(),
            },
            ContentBlock::Thinking {
                thinking: "second thought".into(),
                signature: Some("sig".into()),
            },
        ];
        assert_eq!(
            extract_thinking(&blocks).as_deref(),
            Some("first thought\n\nsecond thought")
        );

        assert_eq!(extract_thinking(&[]), None);
        let only_text = vec![ContentBlock::Text { text: "hi".into() }];
        assert_eq!(extract_thinking(&only_text), None);
    }

    #[test]
    fn parse_unknown_command_falls_through_to_daemon() {
        // `log` isn't translated by the bridge, so it's forwarded as-is and
        // the daemon's dispatcher handles it.
        let cmd = forward_command_only(parse_matrix_input("!log"));
        assert_eq!(cmd.name, "log");
        assert!(cmd.args.as_object().unwrap().is_empty());

        let cmd = forward_command_only(parse_matrix_input("!heartbeat_log limit=5"));
        assert_eq!(cmd.name, "heartbeat_log");
        assert_eq!(cmd.args["text"], "limit=5");
    }

    #[test]
    fn parse_command_extra_whitespace() {
        let cmd = forward_command_only(parse_matrix_input("!  character   Alice  "));
        assert_eq!(cmd.name, "switch_character");
        assert_eq!(cmd.args["name"], "Alice");
    }

    #[test]
    fn text_to_swp_message() {
        let input = MatrixInput::Text("hi".to_string());
        let msg = input_to_swp(&input).unwrap();
        if let ClientMessage::Message(body) = msg {
            assert_eq!(body.text, "hi");
            assert!(body.stream);
        } else {
            panic!("expected Message");
        }
    }

    #[test]
    fn input_to_swp_returns_none_for_non_message_variants() {
        assert!(input_to_swp(&MatrixInput::Bind { character: None }).is_none());
        assert!(input_to_swp(&MatrixInput::LocalReply("hi".into())).is_none());
        assert!(input_to_swp(&MatrixInput::Forward(vec![])).is_none());
    }

    #[test]
    fn collector_stream_lifecycle() {
        let mut c = ResponseCollector::new();

        let action = c.feed(&ServerMessage::StreamStart(StreamStart {
            regen: false,
            rid: None,
            subagent: None,
        }));
        assert!(matches!(action, CollectorAction::StartTyping));
        assert!(c.is_streaming());

        // Chunks re-assert typing so the indicator outlives the 4s timeout.
        let action = c.feed(&ServerMessage::StreamChunk(StreamChunk {
            text: "hello".into(),
            content_type: "text".into(),
            rid: None,
            subagent: None,
        }));
        assert!(matches!(action, CollectorAction::StartTyping));

        let action = c.feed(&ServerMessage::StreamEnd(StreamEnd {
            content: "hello world".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 10,
                    output: 5,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 100,
                    ttft_ms: 50,
                },
                model: "test".into(),
            },
            finish_reason: "end_turn".into(),
            rid: None,
            is_final: true,
            msg_id: None,
            revision: None,
            subagent: None,
        }));
        if let CollectorAction::SendMessage { text, images } = action {
            assert_eq!(text, "hello world");
            assert!(images.is_empty());
        } else {
            panic!("expected SendMessage");
        }
        assert!(!c.is_streaming());
    }

    #[test]
    fn collector_buffers_images() {
        let mut c = ResponseCollector::new();

        c.feed(&ServerMessage::StreamStart(StreamStart {
            regen: false,
            rid: None,
            subagent: None,
        }));

        c.feed(&ServerMessage::SendImage(SendImage {
            path: "/tmp/img.png".into(),
            caption: Some("test image".into()),
            data: None,
            rid: None,
            subagent: None,
        }));
        c.feed(&ServerMessage::SendImage(SendImage {
            path: "/tmp/img2.png".into(),
            caption: None,
            data: None,
            rid: None,
            subagent: None,
        }));

        let action = c.feed(&ServerMessage::StreamEnd(StreamEnd {
            content: "here are images".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 10,
                    output: 5,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 100,
                    ttft_ms: 50,
                },
                model: "test".into(),
            },
            finish_reason: "end_turn".into(),
            rid: None,
            is_final: true,
            msg_id: None,
            revision: None,
            subagent: None,
        }));

        if let CollectorAction::SendMessage { text, images } = action {
            assert_eq!(text, "here are images");
            assert_eq!(images.len(), 2);
            assert_eq!(images[0].path, "/tmp/img.png");
            assert_eq!(images[0].caption.as_deref(), Some("test image"));
            assert_eq!(images[1].path, "/tmp/img2.png");
            assert!(images[1].caption.is_none());
        } else {
            panic!("expected SendMessage");
        }
    }

    #[test]
    fn collector_command_output() {
        let mut c = ResponseCollector::new();
        let action = c.feed(&ServerMessage::CommandOutput(CommandOutput {
            name: "status".into(),
            data: serde_json::json!({"active": true}),
            rid: None,
        }));
        if let CollectorAction::SendCommandOutput { name, data } = action {
            assert_eq!(name, "status");
            assert_eq!(data["active"], true);
        } else {
            panic!("expected SendCommandOutput");
        }
    }

    #[test]
    fn collector_error() {
        let mut c = ResponseCollector::new();
        let action = c.feed(&ServerMessage::Error(Error {
            code: shore_protocol::error::ErrorCode::NotFound,
            message: "not found".into(),
            rid: None,
        }));
        if let CollectorAction::SendError(err) = action {
            assert!(err.contains("NotFound"));
            assert!(err.contains("not found"));
        } else {
            panic!("expected SendError");
        }
    }

    #[test]
    fn collector_new_message() {
        let mut c = ResponseCollector::new();
        let action = c.feed(&ServerMessage::NewMessage(NewMessage {
            revision: 0,
            character: None,
            message: Message {
                msg_id: "1".into(),
                role: Role::Assistant,
                content: "autonomous hello".into(),
                images: vec![],
                content_blocks: vec![],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                timestamp: "2026-01-01T00:00:00Z".into(),
                provider_key: None,
                model: None,
                origin: None,
            },
        }));
        if let CollectorAction::SendPush(text) = action {
            assert_eq!(text, "autonomous hello");
        } else {
            panic!("expected SendPush");
        }
    }

    #[test]
    fn collector_ignores_unrelated_messages() {
        let mut c = ResponseCollector::new();
        let action = c.feed(&ServerMessage::Ping(Ping {}));
        assert!(matches!(action, CollectorAction::None));
    }

    #[test]
    fn image_to_swp_message() {
        let bytes = b"fake image bytes".to_vec();
        let input = MatrixInput::Image {
            path: "/tmp/photo.jpg".into(),
            data: bytes.clone(),
            mime_type: Some("image/jpeg".into()),
            caption: Some("photo.jpg".into()),
        };
        let msg = input_to_swp(&input).unwrap();
        if let ClientMessage::Message(body) = msg {
            assert_eq!(body.text, "photo.jpg");
            assert!(body.stream);
            // Legacy path stays populated for older daemons...
            assert_eq!(body.images, vec!["/tmp/photo.jpg"]);
            // ...but the bytes travel as base64 image_data, which works even
            // when the daemon can't see the bridge's filesystem.
            assert_eq!(body.image_data.len(), 1);
            let upload = &body.image_data[0];
            assert_eq!(upload.filename, "photo.jpg");
            assert_eq!(upload.mime_type.as_deref(), Some("image/jpeg"));
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&upload.data)
                .unwrap();
            assert_eq!(decoded, bytes);
        } else {
            panic!("expected Message");
        }
    }

    #[test]
    fn image_to_swp_no_caption() {
        let input = MatrixInput::Image {
            path: "/tmp/photo.jpg".into(),
            data: vec![1, 2, 3],
            mime_type: None,
            caption: None,
        };
        let msg = input_to_swp(&input).unwrap();
        if let ClientMessage::Message(body) = msg {
            assert_eq!(body.text, "");
            assert_eq!(body.images, vec!["/tmp/photo.jpg"]);
            assert_eq!(body.image_data.len(), 1);
            assert_eq!(body.image_data[0].filename, "image");
            assert!(body.image_data[0].mime_type.is_none());
        } else {
            panic!("expected Message");
        }
    }

    #[test]
    fn image_to_swp_sanitizes_body_with_path_separators() {
        // The event body is remote input; it must not contribute more than a
        // single path component to the upload filename.
        let input = MatrixInput::Image {
            path: "/tmp/x".into(),
            data: vec![1, 2, 3],
            mime_type: None,
            caption: Some("../../etc/passwd".into()),
        };
        let msg = input_to_swp(&input).unwrap();
        if let ClientMessage::Message(body) = msg {
            // The caption text passes through untouched; only the filename
            // is sanitized.
            assert_eq!(body.text, "../../etc/passwd");
            assert_eq!(body.image_data[0].filename, "passwd");
        } else {
            panic!("expected Message");
        }
    }

    #[test]
    fn sanitize_filename_reduces_to_single_component() {
        assert_eq!(sanitize_filename("photo.jpg"), "photo.jpg");
        assert_eq!(sanitize_filename("a/b/c.png"), "c.png");
        assert_eq!(sanitize_filename("a\\b.png"), "b.png");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename(""), "image");
        assert_eq!(sanitize_filename("dir/"), "image");
        assert_eq!(sanitize_filename(".."), "image");
        assert_eq!(sanitize_filename("."), "image");
        assert_eq!(sanitize_filename("  "), "image");
    }

    #[test]
    fn collector_images_cleared_on_new_stream() {
        let mut c = ResponseCollector::new();

        // First stream with images
        c.feed(&ServerMessage::StreamStart(StreamStart {
            regen: false,
            rid: None,
            subagent: None,
        }));
        c.feed(&ServerMessage::SendImage(SendImage {
            path: "/old.png".into(),
            caption: None,
            data: None,
            rid: None,
            subagent: None,
        }));
        c.feed(&ServerMessage::StreamEnd(StreamEnd {
            content: "first".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 0,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 0,
                    ttft_ms: 0,
                },
                model: "test".into(),
            },
            finish_reason: "end_turn".into(),
            rid: None,
            is_final: true,
            msg_id: None,
            revision: None,
            subagent: None,
        }));

        // Second stream should start clean
        c.feed(&ServerMessage::StreamStart(StreamStart {
            regen: false,
            rid: None,
            subagent: None,
        }));
        let action = c.feed(&ServerMessage::StreamEnd(StreamEnd {
            content: "second".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 0,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 0,
                    ttft_ms: 0,
                },
                model: "test".into(),
            },
            finish_reason: "end_turn".into(),
            rid: None,
            is_final: true,
            msg_id: None,
            revision: None,
            subagent: None,
        }));

        if let CollectorAction::SendMessage { images, .. } = action {
            assert!(images.is_empty());
        } else {
            panic!("expected SendMessage");
        }
    }

    // ── mirror_all routing ────────────────────────────────────────────────

    fn new_message(
        character: Option<&str>,
        origin: Option<MessageOrigin>,
        content: &str,
    ) -> ServerMessage {
        ServerMessage::NewMessage(NewMessage {
            revision: 1,
            character: character.map(str::to_string),
            message: Message {
                msg_id: "m1".into(),
                role: Role::Assistant,
                content: content.into(),
                images: vec![],
                content_blocks: vec![],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                timestamp: "2026-01-01T00:00:00Z".into(),
                provider_key: None,
                model: None,
                origin,
            },
        })
    }

    #[test]
    fn mirror_assistant_reply_routes_to_character_room() {
        let route = route_mirror(&new_message(
            Some("Alice"),
            Some(MessageOrigin::AssistantReply),
            "hi there",
        ));
        assert_eq!(route.target, RoomTarget::Character(Some("Alice".into())));
        assert_eq!(
            route.action,
            MirrorAction::Post {
                msg_id: Some("m1".into()),
                replaces_last: false,
                autonomous: false,
                thinking: None,
                text: "hi there".into(),
                images: vec![],
            }
        );
    }

    #[test]
    fn mirror_autonomous_routes_to_character_room() {
        let route = route_mirror(&new_message(
            Some("Bob"),
            Some(MessageOrigin::Autonomous),
            "thinking of you",
        ));
        assert_eq!(route.target, RoomTarget::Character(Some("Bob".into())));
        assert!(matches!(route.action, MirrorAction::Post { .. }));
    }

    #[test]
    fn mirror_regen_reply_marks_replaces_last() {
        // A fresh AssistantReply carrying ≥2 alternatives is a regen
        // replacement of the previous reply.
        let mut msg = new_message(
            Some("Alice"),
            Some(MessageOrigin::AssistantReply),
            "better answer",
        );
        if let ServerMessage::NewMessage(nm) = &mut msg {
            nm.message.alt_count = Some(2);
            nm.message.alt_index = Some(1);
        }
        let route = route_mirror(&msg);
        match route.action {
            MirrorAction::Post { replaces_last, .. } => assert!(replaces_last),
            other => panic!("expected Post, got {other:?}"),
        }

        // Autonomous messages never replace, whatever their alt metadata.
        let mut msg = new_message(Some("Alice"), Some(MessageOrigin::Autonomous), "hey");
        if let ServerMessage::NewMessage(nm) = &mut msg {
            nm.message.alt_count = Some(2);
        }
        match route_mirror(&msg).action {
            MirrorAction::Post { replaces_last, .. } => assert!(!replaces_last),
            other => panic!("expected Post, got {other:?}"),
        }
    }

    #[test]
    fn mirror_user_input_becomes_user_prompt() {
        let route = route_mirror(&new_message(
            Some("Alice"),
            Some(MessageOrigin::UserInput),
            "ping from the cli",
        ));
        assert_eq!(route.target, RoomTarget::Character(Some("Alice".into())));
        assert_eq!(
            route.action,
            MirrorAction::UserPrompt {
                msg_id: Some("m1".into()),
                content: "ping from the cli".into()
            }
        );
    }

    #[test]
    fn parse_reaction_controls() {
        // With and without the emoji variation selector.
        assert_eq!(parse_reaction("🔁"), Some(ReactionControl::Regen));
        assert_eq!(parse_reaction("🔄"), Some(ReactionControl::Regen));
        assert_eq!(parse_reaction("🗑️"), Some(ReactionControl::Delete));
        assert_eq!(parse_reaction("🗑"), Some(ReactionControl::Delete));
        assert_eq!(parse_reaction("❌"), Some(ReactionControl::Delete));
        assert_eq!(parse_reaction("◀️"), Some(ReactionControl::AltPrev));
        assert_eq!(parse_reaction("▶️"), Some(ReactionControl::AltNext));
        assert_eq!(parse_reaction("⬅️"), Some(ReactionControl::AltPrev));
        assert_eq!(parse_reaction("➡"), Some(ReactionControl::AltNext));

        assert_eq!(parse_reaction("👍"), None);
        assert_eq!(parse_reaction("❤️"), None);
        assert_eq!(parse_reaction(""), None);
    }

    #[test]
    fn mirror_stream_lifecycle_rides_active_room() {
        let start = route_mirror(&ServerMessage::StreamStart(StreamStart {
            regen: false,
            rid: None,
            subagent: None,
        }));
        assert_eq!(start.target, RoomTarget::Active);
        assert_eq!(start.action, MirrorAction::StartTyping);

        // Chunks keep the typing indicator alive across long generations.
        let chunk = route_mirror(&ServerMessage::StreamChunk(StreamChunk {
            text: "partial".into(),
            content_type: "text".into(),
            rid: None,
            subagent: None,
        }));
        assert_eq!(chunk.target, RoomTarget::Active);
        assert_eq!(chunk.action, MirrorAction::StartTyping);

        // StreamEnd stops typing only — the reply content arrives via NewMessage,
        // so it must NOT post here (otherwise a Matrix-originated reply doubles).
        let end = route_mirror(&ServerMessage::StreamEnd(StreamEnd {
            content: "the reply".into(),
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 0,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    total_ms: 0,
                    ttft_ms: 0,
                },
                model: "test".into(),
            },
            finish_reason: "end_turn".into(),
            rid: None,
            is_final: true,
            msg_id: None,
            revision: None,
            subagent: None,
        }));
        assert_eq!(end.target, RoomTarget::Active);
        assert_eq!(end.action, MirrorAction::StopTyping);
    }

    #[test]
    fn format_user_mirror_quotes_and_prefixes() {
        assert_eq!(format_user_mirror("hello"), "> \u{1f464} hello");
        assert_eq!(
            format_user_mirror("line one\nline two"),
            "> \u{1f464} line one\n> line two"
        );
    }
}
