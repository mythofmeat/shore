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
//! # Protocol
//!
//! Line-delimited JSON over a Unix socket, one connection per call: the caller
//! writes a [`ToolCallRequest`] and a newline, reads a [`ToolCallResponse`] and
//! a newline, and closes. There is no framing beyond the newline, no
//! keep-alive, and no correlation id — a connection *is* the correlation.
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

/// A call plus the channel its answer goes back on.
#[derive(Debug)]
pub struct ToolCall {
    pub request: ToolCallRequest,
    reply: oneshot::Sender<ToolCallResponse>,
}

impl ToolCall {
    /// Build a call and its reply channel directly, for tests that drive a
    /// servicing task without a socket in the way.
    #[cfg(test)]
    pub fn for_test(request: ToolCallRequest) -> (Self, oneshot::Receiver<ToolCallResponse>) {
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

/// Which in-flight loops are accepting tool calls.
#[derive(Debug, Default)]
pub struct ToolRpcRegistry {
    loops: DashMap<String, mpsc::Sender<ToolCall>>,
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

    /// Route one call to its loop and wait for the answer.
    async fn dispatch(&self, request: ToolCallRequest) -> ToolCallOutcome {
        let Some(sender) = self.loops.get(&request.rid).map(|entry| entry.clone()) else {
            return ToolCallOutcome::Err(ToolCallError {
                error: format!("no in-flight loop for rid {}", request.rid),
            });
        };

        let rid = request.rid.clone();
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

    let outcome = match serde_json::from_str::<ToolCallRequest>(line.trim_end()) {
        Ok(request) => {
            debug!(rid = %request.rid, tool = %request.name, "Tool RPC: dispatching");
            registry.dispatch(request).await
        }
        Err(e) => ToolCallOutcome::Err(ToolCallError {
            error: format!("malformed tool call: {e}"),
        }),
    };

    let mut body = serde_json::to_string(&outcome).unwrap_or_else(|e| {
        // Only reachable if a tool's output is not representable as JSON, which
        // it always is — it is a String and a bool.
        format!(r#"{{"error":"failed to encode tool response: {e}"}}"#)
    });
    body.push('\n');

    let mut answered = reader.into_inner();
    answered.write_all(body.as_bytes()).await?;
    answered.flush().await
}

/// Make one tool call over the socket. Used by tests and by anything on this
/// side that needs to speak the protocol; the sidecar has its own client.
pub async fn call(socket: &Path, request: &ToolCallRequest) -> std::io::Result<ToolCallOutcome> {
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

    fn request(rid: &str, name: &str) -> ToolCallRequest {
        ToolCallRequest {
            rid: rid.to_owned(),
            tool_id: "tu_1".to_owned(),
            name: name.to_owned(),
            input: json!({"path": "/tmp/x"}),
        }
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
    async fn call_ok(socket: &Path, request: &ToolCallRequest) -> ToolCallOutcome {
        call(socket, request).await.expect("tool socket round trip")
    }

    #[tokio::test]
    async fn a_call_reaches_its_loop_and_the_answer_comes_back() {
        let h = harness().await;
        let (mut calls, _registration) = h.registry.register("rid_1", 4);

        // The loop side: take one call, run it, answer.
        let loop_task = tokio::spawn(async move {
            let call = calls.recv().await.expect("a call should arrive");
            let name = call.request.name.clone();
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
