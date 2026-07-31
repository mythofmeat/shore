//! The daemon's side of tool execution when the sidecar drives the loop.
//!
//! Moving the tool loop into the sidecar means the sidecar has to run tools it
//! cannot execute: the executors live here, holding the filesystem, the memory
//! store, MCP, and sub-agents. So the seam becomes bidirectional — the daemon
//! POSTs a request to the sidecar as it always has, and the sidecar calls back
//! here once per tool.
//!
//! # Why a channel and not a shared context
//!
//! The obvious shape is a registry mapping a request id to everything a tool
//! needs — [`ToolContext`], the event sender, the growing list of intermediate
//! messages — and having the server dispatch directly. It does not survive
//! contact with the borrow checker: `ToolContext` is a `Sync` trait object
//! borrowed for the length of one request, and the intermediate messages are
//! owned by the loop as a plain `Vec`. Storing either would mean an
//! `Arc<dyn ToolContext>` and a mutex around the message list, for no reason
//! other than to satisfy a registry.
//!
//! So the registry holds a *channel* instead. Everything a tool needs stays
//! exactly where it already lives — owned by the task running the loop, at its
//! natural lifetime — and that task services calls as they arrive, replying on
//! a oneshot. The registry itself holds nothing but a `Sender`, which is
//! trivially `Send + Sync + 'static`.
//!
//! It also gets the concurrency right by construction: one receiver means tool
//! calls within a loop run one at a time, which is what the daemon-side loop
//! did when it ran `for tool_use in &result.tool_uses` sequentially.
//!
//! # Two things route over this socket
//!
//! Tool calls belong to one in-flight request and are keyed by its `rid`.
//! Autonomy calls ([`AutonomyRequest`]) belong to a *character* and outlive
//! every request — the sidecar's tick loop decides a character should compact,
//! archive, dream or run a heartbeat, and asks this side to do it, because all
//! four reach the memory store, the tool registry and MCP.
//!
//! They share the socket and the connection handler, and nothing else: separate
//! registries, separate reply types. A tool answers with output the model reads;
//! an autonomy action answers with what changed — see [`AutonomyResponse`].
//!
//! # Protocol
//!
//! Line-delimited JSON over a Unix socket, one connection per call: the caller
//! writes a [`SidecarRequest`] and a newline, reads an outcome and a newline,
//! and closes. There is no framing beyond the newline, no keep-alive, and no
//! correlation id — a connection *is* the correlation.
//!
//! The daemon→sidecar direction is HTTP over a Unix socket, so this is not
//! symmetric with it. That is deliberate: the daemon has no HTTP server
//! dependency, and one request/response pair per connection does not need one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};

use dashmap::DashMap;

/// One tool the sidecar wants run, as it arrives off the socket.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallRequest {
    /// Identifies the in-flight loop this call belongs to. The sidecar echoes
    /// back the `rid` the daemon sent it.
    pub rid: String,
    /// The provider's id for this tool use, echoed into the result block.
    pub tool_id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// One message the sidecar appended, in the daemon's stored shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReportedMessage {
    pub role: shore_common::protocol::types::Role,
    pub content_blocks: Vec<shore_common::protocol::types::ContentBlock>,
}

/// Messages the sidecar appended to the conversation.
///
/// Once the sidecar drives the loop it is the only side that knows what the
/// conversation became: the whole loop reaches the daemon as a single flat
/// stream whose terminal event carries no per-turn structure. Inferring it from
/// the tool calls alone loses both the grouping (which results belonged to one
/// round) and the order, since a round's tools run concurrently and finish in a
/// race.
///
/// So the daemon is told rather than left to infer. It writes these down
/// verbatim *and* appends them to the request it holds — which is what keeps
/// `last_request` equal to what actually went out. See 756a308f: the keepalive
/// ping clones that body and must stay byte-identical to it or its anchors
/// miss and it rewrites the whole conversation.
///
/// This rides the *tool socket* rather than the event stream so it arrives on
/// the same channel as the tool calls it precedes. That is not a detail — the
/// generated-image side channel attaches its image to the assistant turn that
/// requested it, so that turn has to be recorded before its tools dispatch, and
/// two transports could not guarantee it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessagesRequest {
    pub rid: String,
    pub messages: Vec<ReportedMessage>,
}

/// One autonomy action the sidecar wants run for a character.
///
/// Flat, and the compaction reason is folded into the action name rather than
/// riding beside it: "compact because the conversation is idle" is a different
/// thing to ask for than "compact because it grew past `max_turns`", and the
/// states that would otherwise be representable — a dream with a reason, a
/// compaction without one — are not worth being able to spell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyAction {
    /// A private turn with tools, which may end in the character speaking.
    HeartbeatTick,
    /// The active conversation grew past `max_turns`.
    CompactMaxTurns,
    /// It has been quiet for `idle_trigger`, with enough turns to be worth it.
    CompactIdle,
    /// Archive what is left of a conversation nobody has returned to.
    DeepArchive,
    /// Sweep memory while the character is idle.
    Dream,
}

/// Do this for this character.
///
/// No `rid`: nothing here belongs to a request. The character is the routing
/// key and it is registered for as long as the character is loaded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutonomyRequest {
    pub character: String,
    pub action: AutonomyAction,
}

/// What the sidecar is asking for. Tagged, because they are answered
/// differently and confusing them would persist a turn as a tool result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarRequest {
    /// Run this tool and tell me what it produced.
    Tool(ToolCallRequest),
    /// Record these messages; nothing to compute.
    Messages(MessagesRequest),
    /// Run this autonomy action and tell me what it changed.
    Autonomy(AutonomyRequest),
}

/// What a request routes to. The two live in different registries with
/// different lifetimes: a loop lasts one request, a character lasts as long as
/// it is loaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route<'req> {
    Loop(&'req str),
    Character(&'req str),
}

impl<'req> Route<'req> {
    /// The registry key, for logging and for the "nobody is listening" message.
    pub fn key(self) -> &'req str {
        match self {
            Self::Loop(rid) => rid,
            Self::Character(name) => name,
        }
    }
}

impl SidecarRequest {
    /// Which registry answers this, and under what key.
    pub fn route(&self) -> Route<'_> {
        match self {
            Self::Tool(request) => Route::Loop(&request.rid),
            Self::Messages(request) => Route::Loop(&request.rid),
            Self::Autonomy(request) => Route::Character(&request.character),
        }
    }
}

/// What running it produced.
///
/// A failed tool is a normal outcome, not a transport error: the model is told
/// about it and decides what to do. Only a call that never reached a loop at
/// all is an [`Err`] on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallResponse {
    pub output: String,
    pub is_error: bool,
}

/// The reason a call never reached a loop.
///
/// Distinct from a tool that ran and failed — this means the daemon could not
/// even attempt it, so the sidecar should abandon the turn rather than feed the
/// model a result that describes a plumbing problem as a tool failure.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallError {
    pub error: String,
}

/// What the socket carries back: a result, or a reason there isn't one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolCallOutcome {
    Ok(ToolCallResponse),
    Err(ToolCallError),
}

/// One line for the heartbeat log, produced by an action that ran.
///
/// `kind` is the wire spelling rather than a Rust enum, because the log itself
/// is the sidecar's now and this side no longer has a type for it. What keeps
/// the two agreeing is the parity fixture, the same guard the log file has: an
/// unknown kind is dropped by the reader rather than raised, so drift here
/// costs entries rather than errors, and only a pinned spelling catches it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutonomyEvent {
    pub kind: String,
    pub detail: String,
}

/// What an autonomy action did.
///
/// The distinction that matters is `failed` versus [`ToolCallError`], and it is
/// the same one tools draw. An action that ran and failed is a **result**: the
/// tick logs it, stops there, and the next tick tries again. A call that never
/// reached a character — not registered, shutting down — is a transport error,
/// and means the sidecar is holding state for a character this side does not
/// have.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
// Every field here is optional, so without this an error body — which carries
// only `error` — deserializes cleanly as a *successful* action that changed
// nothing, and [`AutonomyOutcome`] being untagged means it never reaches the
// `Err` arm. `ToolCallResponse` is safe from the same trap only by accident, in
// having two required fields. Do not remove this to add a field: add it as
// optional and the shape stays unambiguous.
#[serde(deny_unknown_fields)]
pub struct AutonomyResponse {
    /// The active conversation's turn count afterwards, when the action changed
    /// it. The sidecar's tick decides on turn counts and cannot see the
    /// conversation, so an action that compacts or speaks has to say so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<usize>,
    /// What to write to the heartbeat log, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<AutonomyEvent>,
    /// Set when the action ran and failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
}

/// What an autonomy call carries back: what happened, or why nothing did.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AutonomyOutcome {
    Ok(AutonomyResponse),
    Err(ToolCallError),
}

/// A request plus the channel its answer goes back on.
#[derive(Debug)]
pub struct ToolCall {
    pub request: SidecarRequest,
    reply: oneshot::Sender<ToolCallResponse>,
}

impl ToolCall {
    /// Build a call and its reply channel directly, for tests that drive a
    /// servicing task without a socket in the way.
    #[cfg(test)]
    pub fn for_test(request: SidecarRequest) -> (Self, oneshot::Receiver<ToolCallResponse>) {
        let (reply, rx) = oneshot::channel();
        (Self { request, reply }, rx)
    }

    /// Answer the call. Dropping a [`ToolCall`] without answering it is also
    /// valid — the caller sees the loop having gone away, same as a cancel.
    pub fn respond(self, response: ToolCallResponse) {
        // The receiver is gone when the sidecar hung up mid-call (cancellation,
        // or a dead sidecar). The tool already ran; there is nobody to tell.
        let _ignored = self.reply.send(response);
    }
}

/// An autonomy action plus the channel its answer goes back on.
#[derive(Debug)]
pub struct AutonomyCall {
    pub request: AutonomyRequest,
    reply: oneshot::Sender<AutonomyResponse>,
}

impl AutonomyCall {
    /// Build a call and its reply channel directly, for tests that drive a
    /// servicing task without a socket in the way.
    #[cfg(test)]
    pub fn for_test(request: AutonomyRequest) -> (Self, oneshot::Receiver<AutonomyResponse>) {
        let (reply, rx) = oneshot::channel();
        (Self { request, reply }, rx)
    }

    /// Answer the call. Dropping one without answering is also valid — the
    /// sidecar sees the character having gone away and retries next tick.
    pub fn respond(self, response: AutonomyResponse) {
        let _ignored = self.reply.send(response);
    }
}

/// The autonomy channel holds one message, and never more than briefly:
/// [`ToolRpcRegistry::busy`] is what actually stops a second action, so nothing
/// queues here. One slot rather than zero only so the send completes without
/// waiting for the servicing task to be scheduled.
const AUTONOMY_QUEUE_DEPTH: usize = 1;

/// Which in-flight loops are accepting tool calls, and which characters are
/// accepting autonomy actions.
#[derive(Debug, Default)]
pub struct ToolRpcRegistry {
    loops: DashMap<String, mpsc::Sender<ToolCall>>,
    characters: DashMap<String, mpsc::Sender<AutonomyCall>>,
    /// Characters with an action outstanding.
    ///
    /// The channel's capacity cannot serve for this: it frees the moment the
    /// servicing task takes the message, which is the instant *before* the LLM
    /// round trip everything is actually waiting on. A depth-based guard would
    /// therefore admit a second action for the entire duration of the first.
    busy: DashMap<String, ()>,
}

/// Keeps a loop registered for as long as it is running.
///
/// Deregistration is on drop rather than an explicit call so that a panic, an
/// error return, or a cancelled task all clean up the same way — a stale entry
/// would route later calls at a loop that no longer exists.
#[derive(Debug)]
pub struct LoopRegistration {
    registry: std::sync::Arc<ToolRpcRegistry>,
    rid: String,
}

impl Drop for LoopRegistration {
    fn drop(&mut self) {
        let _removed = self.registry.loops.remove(&self.rid);
    }
}

/// Keeps a character reachable for as long as it is loaded.
///
/// Same drop-to-deregister discipline as [`LoopRegistration`], and it matters
/// more here: a stale entry would take an autonomy call and never answer it,
/// which the sidecar cannot tell apart from a heartbeat that is simply slow.
#[derive(Debug)]
pub struct CharacterRegistration {
    registry: std::sync::Arc<ToolRpcRegistry>,
    character: String,
}

impl Drop for CharacterRegistration {
    fn drop(&mut self) {
        let _removed = self.registry.characters.remove(&self.character);
    }
}

impl ToolRpcRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Announce that `rid` is running a loop and will service tool calls.
    ///
    /// Returns the receiver to select on, and a guard that deregisters when
    /// dropped. Registering an `rid` that is already present replaces it —
    /// the previous loop's receiver then sees its channel close, which is the
    /// correct signal that it has been superseded.
    pub fn register<R>(
        self: &std::sync::Arc<Self>,
        rid: R,
        depth: usize,
    ) -> (mpsc::Receiver<ToolCall>, LoopRegistration)
    where
        R: Into<String>,
    {
        let key: String = rid.into();
        let (tx, rx) = mpsc::channel(depth);
        let _superseded = self.loops.insert(key.clone(), tx);
        (
            rx,
            LoopRegistration {
                registry: std::sync::Arc::clone(self),
                rid: key,
            },
        )
    }

    /// Announce that `character` is loaded and will service autonomy actions.
    ///
    /// Same contract as [`Self::register`]: a receiver to select on, and a
    /// guard that deregisters on drop. Re-registering a character replaces it,
    /// which is what a config reload does.
    pub fn register_character<C>(
        self: &std::sync::Arc<Self>,
        character: C,
    ) -> (mpsc::Receiver<AutonomyCall>, CharacterRegistration)
    where
        C: Into<String>,
    {
        let key: String = character.into();
        let (tx, rx) = mpsc::channel(AUTONOMY_QUEUE_DEPTH);
        let _superseded = self.characters.insert(key.clone(), tx);
        (
            rx,
            CharacterRegistration {
                registry: std::sync::Arc::clone(self),
                character: key,
            },
        )
    }

    /// Route one call to its loop and wait for the answer.
    async fn dispatch(&self, request: SidecarRequest) -> ToolCallOutcome {
        let rid = request.route().key().to_owned();
        let Some(sender) = self.loops.get(&rid).map(|entry| entry.clone()) else {
            return ToolCallOutcome::Err(ToolCallError {
                error: format!("no in-flight loop for rid {rid}"),
            });
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        let call = ToolCall {
            request,
            reply: reply_tx,
        };

        if sender.send(call).await.is_err() {
            return ToolCallOutcome::Err(ToolCallError {
                error: format!("loop for rid {rid} stopped accepting tool calls"),
            });
        }

        match reply_rx.await {
            Ok(response) => ToolCallOutcome::Ok(response),
            // The loop took the call and went away without answering — a
            // cancelled turn, or a panic in the executor.
            Err(_recv_error) => ToolCallOutcome::Err(ToolCallError {
                error: format!("loop for rid {rid} dropped the call without answering"),
            }),
        }
    }

    /// Route one autonomy action to its character and wait for the answer.
    ///
    /// One at a time per character, refused rather than queued: an action's
    /// triggers were evaluated when it was sent, and running the second one
    /// after however long the first LLM round trip takes would act on a
    /// decision that is by then minutes stale. The sidecar declines to start a
    /// second anyway; this is the half that holds when it is not the only
    /// caller.
    ///
    /// No timeout, deliberately. A slow action is ordinary here, and a hang
    /// costs that character's autonomy and nothing else.
    async fn dispatch_autonomy(&self, request: AutonomyRequest) -> AutonomyOutcome {
        let character = request.character.clone();
        let Some(sender) = self.characters.get(&character).map(|entry| entry.clone()) else {
            return AutonomyOutcome::Err(ToolCallError {
                error: format!("character {character} is not loaded"),
            });
        };

        // Test-and-set in one shard-locked operation: a previous value means
        // somebody else holds it, and this call must not clear it on the way
        // out.
        if self.busy.insert(character.clone(), ()).is_some() {
            return AutonomyOutcome::Err(ToolCallError {
                error: format!("character {character} is already running one"),
            });
        }
        let outcome = Self::await_autonomy(sender, request, &character).await;
        let _released = self.busy.remove(&character);
        outcome
    }

    /// Send and wait, split out so the busy flag has exactly one release point.
    async fn await_autonomy(
        sender: mpsc::Sender<AutonomyCall>,
        request: AutonomyRequest,
        character: &str,
    ) -> AutonomyOutcome {
        let (reply_tx, reply_rx) = oneshot::channel();
        let call = AutonomyCall {
            request,
            reply: reply_tx,
        };

        if sender.send(call).await.is_err() {
            return AutonomyOutcome::Err(ToolCallError {
                error: format!("character {character} stopped accepting autonomy actions"),
            });
        }

        match reply_rx.await {
            Ok(response) => AutonomyOutcome::Ok(response),
            Err(_recv_error) => AutonomyOutcome::Err(ToolCallError {
                error: format!("character {character} dropped the action without answering"),
            }),
        }
    }
}

/// Bind the tool socket, replacing any stale file left by a previous run.
pub async fn bind(path: &Path) -> std::io::Result<UnixListener> {
    // A socket file outlives the process that made it, so a crash leaves one
    // behind and the next bind fails with AddrInUse. Nothing else owns this
    // path, so removing it is safe.
    if let Err(e) = tokio::fs::remove_file(path).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            debug!(path = %path.display(), error = %e, "Tool RPC: stale socket not removed");
        }
    }
    UnixListener::bind(path)
}

/// Serve tool calls until the listener fails.
///
/// Each connection is handled on its own task: a slow tool must not stall calls
/// belonging to a *different* loop. Calls within one loop still serialize,
/// because they queue on that loop's single receiver.
pub async fn serve(listener: UnixListener, registry: std::sync::Arc<ToolRpcRegistry>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _addr)) => stream,
            Err(e) => {
                warn!(error = %e, "Tool RPC: accept failed, stopping");
                return;
            }
        };
        let connection_registry = std::sync::Arc::clone(&registry);
        drop(tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, &connection_registry).await {
                debug!(error = %e, "Tool RPC: connection ended");
            }
        }));
    }
}

/// One request, one response, then the connection closes.
async fn handle_connection(stream: UnixStream, registry: &ToolRpcRegistry) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        // Peer connected and hung up without asking anything.
        return Ok(());
    }

    // The two outcome types are both untagged, so what goes on the wire is the
    // inner object either way. Which one to build is decided by what was asked
    // for, not by the answer — a caller that sent an autonomy action must not
    // get a tool-shaped refusal back.
    let encoded = match serde_json::from_str::<SidecarRequest>(line.trim_end()) {
        Ok(SidecarRequest::Autonomy(request)) => {
            debug!(character = %request.character, action = ?request.action, "Tool RPC: dispatching");
            serde_json::to_string(&registry.dispatch_autonomy(request).await)
        }
        Ok(request) => {
            debug!(rid = %request.route().key(), "Tool RPC: dispatching");
            serde_json::to_string(&registry.dispatch(request).await)
        }
        Err(e) => serde_json::to_string(&ToolCallOutcome::Err(ToolCallError {
            error: format!("malformed tool call: {e}"),
        })),
    };

    let mut body = encoded.unwrap_or_else(|e| {
        // Only reachable if an output is not representable as JSON, which it
        // always is — these are strings, numbers and bools.
        format!(r#"{{"error":"failed to encode tool response: {e}"}}"#)
    });
    body.push('\n');

    let mut answered = reader.into_inner();
    answered.write_all(body.as_bytes()).await?;
    answered.flush().await
}

/// Make one tool call over the socket. Used by tests and by anything on this
/// side that needs to speak the protocol; the sidecar has its own client.
pub async fn call(socket: &Path, request: &SidecarRequest) -> std::io::Result<ToolCallOutcome> {
    round_trip(socket, request).await
}

/// Make one autonomy call over the socket. Same protocol, different answer.
pub async fn call_autonomy(
    socket: &Path,
    request: &AutonomyRequest,
) -> std::io::Result<AutonomyOutcome> {
    round_trip(socket, &SidecarRequest::Autonomy(request.clone())).await
}

/// Write one request, read one answer, close.
async fn round_trip<T: serde::de::DeserializeOwned>(
    socket: &Path,
    request: &SidecarRequest,
) -> std::io::Result<T> {
    let stream = UnixStream::connect(socket).await?;
    let mut reader = BufReader::new(stream);
    let mut body = serde_json::to_string(request).map_err(std::io::Error::other)?;
    body.push('\n');
    reader.get_mut().write_all(body.as_bytes()).await?;
    reader.get_mut().flush().await?;

    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "tool socket closed before answering",
        ));
    }
    serde_json::from_str(line.trim_end()).map_err(std::io::Error::other)
}

/// Where the tool socket lives for a given sidecar socket.
///
/// Derived from the sidecar's path rather than configured separately so the two
/// always belong to the same daemon instance.
pub fn socket_path_for(sidecar_socket: &Path) -> PathBuf {
    let mut name = sidecar_socket
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("sidecar.sock"))
        .to_owned();
    name.push(".tools");
    sidecar_socket.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn request(rid: &str, name: &str) -> SidecarRequest {
        SidecarRequest::Tool(ToolCallRequest {
            rid: rid.to_owned(),
            tool_id: "tu_1".to_owned(),
            name: name.to_owned(),
            input: json!({"path": "/tmp/x"}),
        })
    }

    /// A bound socket plus a running server, torn down with the temp dir.
    struct Harness {
        socket: PathBuf,
        registry: Arc<ToolRpcRegistry>,
        _dir: tempfile::TempDir,
    }

    async fn harness() -> Harness {
        let dir = tempfile::tempdir().expect("temp dir");
        let socket = dir.path().join("tools.sock");
        let registry = Arc::new(ToolRpcRegistry::new());
        let listener = bind(&socket).await.expect("bind tool socket");
        drop(tokio::spawn(serve(listener, Arc::clone(&registry))));
        Harness {
            socket,
            registry,
            _dir: dir,
        }
    }

    /// Make one call, failing the test rather than propagating.
    async fn call_ok(socket: &Path, request: &SidecarRequest) -> ToolCallOutcome {
        call(socket, request).await.expect("tool socket round trip")
    }

    #[tokio::test]
    async fn a_call_reaches_its_loop_and_the_answer_comes_back() {
        let h = harness().await;
        let (mut calls, _registration) = h.registry.register("rid_1", 4);

        // The loop side: take one call, run it, answer.
        let loop_task = tokio::spawn(async move {
            let call = calls.recv().await.expect("a call should arrive");
            let SidecarRequest::Tool(request) = &call.request else {
                panic!("expected a tool request")
            };
            let name = request.name.clone();
            call.respond(ToolCallResponse {
                output: format!("ran {name}"),
                is_error: false,
            });
            name
        });

        let outcome = call_ok(&h.socket, &request("rid_1", "read")).await;
        assert_eq!(
            outcome,
            ToolCallOutcome::Ok(ToolCallResponse {
                output: "ran read".to_owned(),
                is_error: false,
            })
        );
        assert_eq!(loop_task.await.expect("loop task"), "read");
    }

    #[tokio::test]
    async fn a_failed_tool_is_a_result_not_a_transport_error() {
        // The model is told about a failed tool and decides what to do; only a
        // call that never ran is an error on the wire.
        let h = harness().await;
        let (mut calls, _registration) = h.registry.register("rid_1", 4);
        drop(tokio::spawn(async move {
            let call = calls.recv().await.expect("a call should arrive");
            call.respond(ToolCallResponse {
                output: "no such file".to_owned(),
                is_error: true,
            });
        }));

        let outcome = call_ok(&h.socket, &request("rid_1", "read")).await;
        assert_eq!(
            outcome,
            ToolCallOutcome::Ok(ToolCallResponse {
                output: "no such file".to_owned(),
                is_error: true,
            })
        );
    }

    #[tokio::test]
    async fn a_call_for_an_unknown_loop_is_refused() {
        let h = harness().await;
        let outcome = call_ok(&h.socket, &request("rid_missing", "read")).await;
        let ToolCallOutcome::Err(err) = outcome else {
            panic!("expected a refusal for an unregistered rid");
        };
        assert!(err.error.contains("rid_missing"), "{}", err.error);
    }

    #[tokio::test]
    async fn a_finished_loop_stops_accepting_calls() {
        // What a cancelled or completed turn looks like from the socket: the
        // registration guard drops, and later calls are refused rather than
        // hanging forever.
        let h = harness().await;
        {
            let (_calls, _registration) = h.registry.register("rid_1", 4);
        }
        let outcome = call_ok(&h.socket, &request("rid_1", "read")).await;
        assert!(
            matches!(outcome, ToolCallOutcome::Err(_)),
            "a deregistered loop must refuse, not hang"
        );
    }

    #[tokio::test]
    async fn a_loop_that_drops_a_call_does_not_hang_the_caller() {
        // A panic in an executor, or a turn cancelled between taking the call
        // and answering it. The caller must learn about it.
        let h = harness().await;
        let (mut calls, _registration) = h.registry.register("rid_1", 4);
        drop(tokio::spawn(async move {
            let call = calls.recv().await.expect("a call should arrive");
            drop(call);
        }));

        let outcome = call_ok(&h.socket, &request("rid_1", "read")).await;
        let ToolCallOutcome::Err(err) = outcome else {
            panic!("expected an error when the call is dropped unanswered");
        };
        assert!(err.error.contains("without answering"), "{}", err.error);
    }

    #[tokio::test]
    async fn malformed_input_is_answered_rather_than_dropped() {
        let h = harness().await;
        let stream = UnixStream::connect(&h.socket).await.expect("connect");
        let mut reader = BufReader::new(stream);
        reader
            .get_mut()
            .write_all(b"{not json\n")
            .await
            .expect("write");
        reader.get_mut().flush().await.expect("flush");

        let mut line = String::new();
        let _read = reader.read_line(&mut line).await.expect("read answer");
        let outcome: ToolCallOutcome =
            serde_json::from_str(line.trim_end()).expect("answer is json");
        assert!(
            matches!(outcome, ToolCallOutcome::Err(_)),
            "malformed input must get an answer, not a silent close"
        );
    }

    #[tokio::test]
    async fn calls_for_different_loops_do_not_block_each_other() {
        // Each connection is its own task, so a slow tool in one turn must not
        // stall a different turn. Second loop answers while the first is held.
        let h = harness().await;
        let (mut slow_calls, _slow_reg) = h.registry.register("rid_slow", 4);
        let (mut fast_calls, _fast_reg) = h.registry.register("rid_fast", 4);

        let (release_tx, release_rx) = oneshot::channel::<()>();
        drop(tokio::spawn(async move {
            let call = slow_calls.recv().await.expect("a call should arrive");
            let _ignored = release_rx.await;
            call.respond(ToolCallResponse {
                output: "slow".to_owned(),
                is_error: false,
            });
        }));
        drop(tokio::spawn(async move {
            let call = fast_calls.recv().await.expect("a call should arrive");
            call.respond(ToolCallResponse {
                output: "fast".to_owned(),
                is_error: false,
            });
        }));

        let slow_task = tokio::spawn({
            let socket = h.socket.clone();
            async move { call_ok(&socket, &request("rid_slow", "read")).await }
        });

        // Completes while the slow call is still parked.
        let fast = call_ok(&h.socket, &request("rid_fast", "read")).await;
        assert_eq!(
            fast,
            ToolCallOutcome::Ok(ToolCallResponse {
                output: "fast".to_owned(),
                is_error: false,
            })
        );

        let _ignored = release_tx.send(());
        let slow = slow_task.await.expect("slow task");
        assert_eq!(
            slow,
            ToolCallOutcome::Ok(ToolCallResponse {
                output: "slow".to_owned(),
                is_error: false,
            })
        );
    }

    fn autonomy(character: &str, action: AutonomyAction) -> AutonomyRequest {
        AutonomyRequest {
            character: character.to_owned(),
            action,
        }
    }

    /// Make one autonomy call, failing the test rather than propagating.
    async fn autonomy_ok(socket: &Path, request: &AutonomyRequest) -> AutonomyOutcome {
        call_autonomy(socket, request)
            .await
            .expect("tool socket round trip")
    }

    #[tokio::test]
    async fn an_action_reaches_its_character_and_what_changed_comes_back() {
        let h = harness().await;
        let (mut actions, _registration) = h.registry.register_character("nova");

        let character_task = tokio::spawn(async move {
            let call = actions.recv().await.expect("an action should arrive");
            let action = call.request.action;
            call.respond(AutonomyResponse {
                turn_count: Some(12),
                events: vec![AutonomyEvent {
                    kind: "message_sent".to_owned(),
                    detail: "said something".to_owned(),
                }],
                failed: None,
            });
            action
        });

        let outcome =
            autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::HeartbeatTick)).await;
        assert_eq!(
            outcome,
            AutonomyOutcome::Ok(AutonomyResponse {
                turn_count: Some(12),
                events: vec![AutonomyEvent {
                    kind: "message_sent".to_owned(),
                    detail: "said something".to_owned(),
                }],
                failed: None,
            })
        );
        assert_eq!(
            character_task.await.expect("character task"),
            AutonomyAction::HeartbeatTick
        );
    }

    #[tokio::test]
    async fn an_action_that_ran_and_failed_is_a_result_not_a_transport_error() {
        // Same distinction tools draw: the tick logs it and tries again next
        // time, where a transport error means the sidecar holds state for a
        // character this side does not have.
        let h = harness().await;
        let (mut actions, _registration) = h.registry.register_character("nova");
        drop(tokio::spawn(async move {
            let call = actions.recv().await.expect("an action should arrive");
            call.respond(AutonomyResponse {
                failed: Some("no conversation to compact".to_owned()),
                ..AutonomyResponse::default()
            });
        }));

        let outcome = autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::CompactIdle)).await;
        assert_eq!(
            outcome,
            AutonomyOutcome::Ok(AutonomyResponse {
                turn_count: None,
                events: Vec::new(),
                failed: Some("no conversation to compact".to_owned()),
            })
        );
    }

    #[tokio::test]
    async fn an_action_for_an_unloaded_character_is_refused() {
        let h = harness().await;
        let outcome = autonomy_ok(&h.socket, &autonomy("ghost", AutonomyAction::Dream)).await;
        assert_eq!(
            outcome,
            AutonomyOutcome::Err(ToolCallError {
                error: "character ghost is not loaded".to_owned(),
            })
        );
    }

    #[tokio::test]
    async fn a_second_action_is_refused_rather_than_queued_behind_the_first() {
        // The triggers behind an action were evaluated when it was sent. Queueing
        // would run the second one after however long the first LLM round trip
        // takes, on a decision that is by then minutes stale.
        //
        // Note *where* the first call is parked: the servicing task has already
        // taken it off the channel, so the channel is empty and its capacity
        // says nothing. This is the window a depth-based guard misses, and it is
        // the entire duration of the action.
        let h = harness().await;
        let (mut actions, _registration) = h.registry.register_character("nova");

        let (taken_tx, taken_rx) = oneshot::channel::<()>();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        drop(tokio::spawn(async move {
            let call = actions.recv().await.expect("an action should arrive");
            let _announced = taken_tx.send(());
            let _released = release_rx.await;
            call.respond(AutonomyResponse::default());
            // Stay alive so a second call would meet a live receiver rather
            // than a closed channel — the refusal under test has to be the busy
            // one, not "this character went away".
            let _parked = actions.recv().await;
        }));

        let held = tokio::spawn({
            let socket = h.socket.clone();
            async move { autonomy_ok(&socket, &autonomy("nova", AutonomyAction::Dream)).await }
        });
        taken_rx
            .await
            .expect("the first action reached the character");

        let second = autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::DeepArchive)).await;
        assert_eq!(
            second,
            AutonomyOutcome::Err(ToolCallError {
                error: "character nova is already running one".to_owned(),
            })
        );

        let _ignored = release_tx.send(());
        assert_eq!(
            held.await.expect("held task"),
            AutonomyOutcome::Ok(AutonomyResponse::default())
        );
    }

    #[tokio::test]
    async fn the_next_action_goes_through_once_the_last_one_answered() {
        // The busy flag has to clear on every path out, or one action would
        // disable that character's autonomy for the life of the daemon.
        let h = harness().await;
        let (mut actions, _registration) = h.registry.register_character("nova");
        drop(tokio::spawn(async move {
            while let Some(call) = actions.recv().await {
                call.respond(AutonomyResponse::default());
            }
        }));

        for _attempt in 0..3 {
            assert_eq!(
                autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::Dream)).await,
                AutonomyOutcome::Ok(AutonomyResponse::default())
            );
        }
    }

    #[tokio::test]
    async fn a_dropped_action_still_clears_the_busy_flag() {
        let h = harness().await;
        let (mut actions, _registration) = h.registry.register_character("nova");
        drop(tokio::spawn(async move {
            // First call is dropped without an answer; the rest are answered.
            drop(actions.recv().await.expect("an action should arrive"));
            while let Some(call) = actions.recv().await {
                call.respond(AutonomyResponse::default());
            }
        }));

        let dropped = autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::Dream)).await;
        assert!(matches!(dropped, AutonomyOutcome::Err(_)));
        assert_eq!(
            autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::Dream)).await,
            AutonomyOutcome::Ok(AutonomyResponse::default())
        );
    }

    #[tokio::test]
    async fn a_character_that_drops_an_action_does_not_hang_the_caller() {
        let h = harness().await;
        let (mut actions, _registration) = h.registry.register_character("nova");
        drop(tokio::spawn(async move {
            // Takes the call and goes away — a panic in an executor, or a
            // character unloaded mid-action.
            drop(actions.recv().await.expect("an action should arrive"));
        }));

        let outcome = autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::Dream)).await;
        assert_eq!(
            outcome,
            AutonomyOutcome::Err(ToolCallError {
                error: "character nova dropped the action without answering".to_owned(),
            })
        );
    }

    #[tokio::test]
    async fn an_unloaded_character_stops_accepting_actions() {
        let h = harness().await;
        let (actions, registration) = h.registry.register_character("nova");
        drop(actions);
        drop(registration);

        let outcome = autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::Dream)).await;
        assert_eq!(
            outcome,
            AutonomyOutcome::Err(ToolCallError {
                error: "character nova is not loaded".to_owned(),
            })
        );
    }

    #[tokio::test]
    async fn a_character_and_a_loop_may_share_a_name_without_meeting() {
        // Two registries, two key spaces. Nothing stops a request id and a
        // character name colliding, and if they shared a map an autonomy action
        // would be handed to a tool loop that has no idea what to do with it.
        let h = harness().await;
        let (mut tools, _loop_reg) = h.registry.register("nova", 4);
        let (mut actions, _character_reg) = h.registry.register_character("nova");

        drop(tokio::spawn(async move {
            let call = tools.recv().await.expect("a tool call should arrive");
            call.respond(ToolCallResponse {
                output: "the loop answered".to_owned(),
                is_error: false,
            });
        }));
        drop(tokio::spawn(async move {
            let call = actions.recv().await.expect("an action should arrive");
            call.respond(AutonomyResponse {
                turn_count: Some(7),
                ..AutonomyResponse::default()
            });
        }));

        let tool = call_ok(&h.socket, &request("nova", "read")).await;
        assert_eq!(
            tool,
            ToolCallOutcome::Ok(ToolCallResponse {
                output: "the loop answered".to_owned(),
                is_error: false,
            })
        );

        let action = autonomy_ok(&h.socket, &autonomy("nova", AutonomyAction::Dream)).await;
        assert_eq!(
            action,
            AutonomyOutcome::Ok(AutonomyResponse {
                turn_count: Some(7),
                ..AutonomyResponse::default()
            })
        );
    }

    #[tokio::test]
    async fn binding_replaces_a_socket_left_by_a_crashed_run() {
        let dir = tempfile::tempdir().expect("temp dir");
        let socket = dir.path().join("tools.sock");
        let first = bind(&socket).await.expect("first bind");
        drop(first);
        // The file survives the listener, so a naive re-bind would hit AddrInUse.
        assert!(socket.exists());
        let _second = bind(&socket).await.expect("rebind over stale socket");
    }

    #[test]
    fn the_tool_socket_sits_beside_the_sidecar_socket() {
        assert_eq!(
            socket_path_for(Path::new("/run/shore/sidecar.sock")),
            PathBuf::from("/run/shore/sidecar.sock.tools")
        );
    }
}
