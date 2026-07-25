use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, Instant};

use shore_common::config::binaries;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::watch;
use tracing::{error, info, warn};

const MAX_CONSECUTIVE_FAILURES: u32 = 5;
const STABLE_RUNTIME_THRESHOLD: Duration = Duration::from_mins(5);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const LLM_SIDECAR_HEALTH_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const LLM_SIDECAR_HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(100);
const LLM_SIDECAR_HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(1);
const MATRIX_LOG_ENV: &str = "SHORE_MATRIX_RUST_LOG";
const DEFAULT_MATRIX_LOG_FILTER: &str = "warn,shore_matrix=info,matrix_sdk_crypto::backups=error";
const MATRIX_BINARY: &str = "shore-matrix";
const LLM_SIDECAR_BINARY: &str = "shore-llm-sidecar";

/// Handle to the supervisor's background task; `shutdown()` joins it.
pub(crate) struct MatrixSupervisor {
    handle: tokio::task::JoinHandle<()>,
}

/// Handle to the LLM sidecar supervisor's background task.
pub(crate) struct LlmSidecarSupervisor {
    handle: tokio::task::JoinHandle<()>,
}

/// Spawn a supervisor that manages the lifecycle of `shore-matrix` as a
/// child process. Returns `None` when no binary can be located (see
/// [`shore_common::config::binaries`]) — the supervisor then becomes a no-op and
/// the daemon continues without the Matrix bridge.
pub(crate) fn spawn(shutdown_rx: watch::Receiver<()>) -> Option<MatrixSupervisor> {
    let binary = locate_matrix_binary()?;
    let handle = tokio::spawn(async move {
        let mut rx = shutdown_rx;
        supervise(binary, &mut rx).await;
    });
    Some(MatrixSupervisor { handle })
}

/// Spawn a supervisor that manages the Bun LLM sidecar child process.
///
/// Returns `None` when no `the daemon's llm module-sidecar` binary can be located. This keeps
/// externally-managed sidecars possible during development; packaged installs
/// point `SHORE_LLM_SIDECAR_BIN` at a libexec copy kept off `$PATH`.
pub(crate) fn spawn_llm_sidecar(
    socket_path: PathBuf,
    shutdown_rx: watch::Receiver<()>,
) -> Option<LlmSidecarSupervisor> {
    let binary = locate_llm_sidecar_binary()?;
    let handle = tokio::spawn(async move {
        let mut rx = shutdown_rx;
        supervise_llm_sidecar(binary, socket_path, &mut rx).await;
    });
    Some(LlmSidecarSupervisor { handle })
}

impl MatrixSupervisor {
    /// Wait up to `timeout` for the supervisor task to exit after a
    /// shutdown signal has been sent on the watch channel.
    pub(crate) async fn shutdown(self, timeout: Duration) {
        let _ignored = tokio::time::timeout(timeout, self.handle).await;
    }
}

impl LlmSidecarSupervisor {
    /// Wait up to `timeout` for the supervisor task to exit after a
    /// shutdown signal has been sent on the watch channel.
    pub(crate) async fn shutdown(self, timeout: Duration) {
        let _ignored = tokio::time::timeout(timeout, self.handle).await;
    }
}

fn locate_matrix_binary() -> Option<PathBuf> {
    locate_helper_binary(
        MATRIX_BINARY,
        binaries::MATRIX_BIN_ENV,
        "Matrix bridge disabled",
    )
}

fn locate_llm_sidecar_binary() -> Option<PathBuf> {
    locate_helper_binary(
        LLM_SIDECAR_BINARY,
        binaries::LLM_SIDECAR_BIN_ENV,
        "LLM sidecar supervision disabled; run a sidecar manually at the \
         configured socket path to keep LLM calls working",
    )
}

/// Resolve a helper binary (see [`shore_common::config::binaries`] for the search
/// order), warning about an unusable override and about a binary that no
/// searched location holds. `consequence` describes what the daemon loses.
fn locate_helper_binary(name: &str, env_var: &str, consequence: &str) -> Option<PathBuf> {
    let resolved = binaries::resolve(name, env_var);
    if let Some(ignored) = resolved.ignored_override {
        warn!(
            path = %ignored.display(),
            "{env_var} is set but does not point at a file; falling back to \
             PATH and known install locations"
        );
    }
    if resolved.path.is_none() {
        let searched = binaries::searched_locations(env_var);
        warn!("{name} binary not found via {searched}; {consequence}.");
    }
    resolved.path
}

async fn supervise(binary: PathBuf, shutdown_rx: &mut watch::Receiver<()>) {
    let mut failures: u32 = 0;

    loop {
        if shutdown_rx.has_changed().unwrap_or(true) {
            return;
        }

        info!(binary = %binary.display(), "spawning shore-matrix");
        let started_at = Instant::now();
        let mut command = Command::new(&binary);
        let _ignored = command
            .kill_on_drop(true)
            .env("RUST_LOG", matrix_log_filter());
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                error!(error = %e, "failed to spawn shore-matrix");
                failures = failures.saturating_add(1);
                if failures >= MAX_CONSECUTIVE_FAILURES {
                    error!(
                        failures,
                        "shore-matrix failed to spawn {MAX_CONSECUTIVE_FAILURES} \
                         times consecutively; giving up. Daemon continuing \
                         without Matrix bridge."
                    );
                    return;
                }
                if !sleep_or_shutdown(backoff(failures), shutdown_rx).await {
                    return;
                }
                continue;
            }
        };

        tokio::select! {
            status = child.wait() => {
                let runtime = started_at.elapsed();
                if runtime >= STABLE_RUNTIME_THRESHOLD {
                    failures = 0;
                }
                failures = failures.saturating_add(1);
                warn!(
                    ?status,
                    runtime_secs = runtime.as_secs(),
                    failures,
                    "shore-matrix exited; will restart with backoff"
                );
                if failures >= MAX_CONSECUTIVE_FAILURES {
                    error!(
                        failures,
                        "shore-matrix crashed {MAX_CONSECUTIVE_FAILURES} times \
                         consecutively; giving up. Daemon continuing without \
                         Matrix bridge."
                    );
                    return;
                }
                if !sleep_or_shutdown(backoff(failures), shutdown_rx).await {
                    return;
                }
            }
            _ = shutdown_rx.changed() => {
                info!("shutdown requested; stopping shore-matrix");
                graceful_shutdown(&mut child, SHUTDOWN_GRACE).await;
                return;
            }
        }
    }
}

async fn supervise_llm_sidecar(
    binary: PathBuf,
    socket_path: PathBuf,
    shutdown_rx: &mut watch::Receiver<()>,
) {
    let mut failures: u32 = 0;

    loop {
        if shutdown_rx.has_changed().unwrap_or(true) {
            return;
        }

        match ensure_llm_sidecar_socket_dir(&socket_path, &mut failures, shutdown_rx).await {
            LlmSidecarStep::Proceed => {}
            LlmSidecarStep::Retry => continue,
            LlmSidecarStep::Stop => return,
        }

        let started_at = Instant::now();
        let mut child = match spawn_llm_sidecar_child(&binary, &socket_path) {
            Ok(child) => child,
            Err(error) => {
                match handle_llm_sidecar_spawn_error(error, &mut failures, shutdown_rx).await {
                    LlmSidecarStep::Retry | LlmSidecarStep::Proceed => continue,
                    LlmSidecarStep::Stop => return,
                }
            }
        };

        let startup = wait_for_llm_sidecar_health(&mut child, &socket_path, shutdown_rx).await;
        match handle_llm_sidecar_startup(
            startup,
            &mut child,
            &socket_path,
            started_at,
            &mut failures,
            shutdown_rx,
        )
        .await
        {
            LlmSidecarStep::Proceed => {}
            LlmSidecarStep::Retry => continue,
            LlmSidecarStep::Stop => return,
        }

        tokio::select! {
            status = child.wait() => {
                let runtime = started_at.elapsed();
                failures = record_child_exit("LLM sidecar", &status, runtime, failures);
                if failures >= MAX_CONSECUTIVE_FAILURES {
                    error!(
                        failures,
                        "LLM sidecar crashed {MAX_CONSECUTIVE_FAILURES} times \
                         consecutively; giving up"
                    );
                    return;
                }
                if !sleep_or_shutdown(backoff(failures), shutdown_rx).await {
                    return;
                }
            }
            _ = shutdown_rx.changed() => {
                info!("shutdown requested; stopping LLM sidecar");
                graceful_shutdown(&mut child, SHUTDOWN_GRACE).await;
                return;
            }
        }
    }
}

enum LlmHealthWait {
    Healthy,
    Exited(std::io::Result<ExitStatus>),
    UnhealthyTimeout,
    Shutdown,
}

enum LlmSidecarStep {
    Proceed,
    Retry,
    Stop,
}

async fn ensure_llm_sidecar_socket_dir(
    socket_path: &Path,
    failures: &mut u32,
    shutdown_rx: &mut watch::Receiver<()>,
) -> LlmSidecarStep {
    let Some(parent) = socket_path.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return LlmSidecarStep::Proceed;
    };

    let Err(error) = tokio::fs::create_dir_all(parent).await else {
        return LlmSidecarStep::Proceed;
    };

    error!(
        socket = %socket_path.display(),
        error = %error,
        "failed to create LLM sidecar socket directory"
    );
    *failures = failures.saturating_add(1);
    if *failures >= MAX_CONSECUTIVE_FAILURES {
        error!(
            failures,
            "LLM sidecar socket directory setup failed \
             {MAX_CONSECUTIVE_FAILURES} times consecutively; giving up"
        );
        return LlmSidecarStep::Stop;
    }
    retry_llm_sidecar(*failures, shutdown_rx).await
}

fn spawn_llm_sidecar_child(
    binary: &Path,
    socket_path: &Path,
) -> std::io::Result<tokio::process::Child> {
    info!(
        binary = %binary.display(),
        socket = %socket_path.display(),
        "spawning LLM sidecar"
    );
    // A crash or SIGKILL can leave the old socket file behind, and the next
    // bind would fail until the supervisor exhausts its retry budget. Unlink
    // it first, but only when it is actually a socket so we never delete an
    // unrelated file a user placed at that path.
    #[cfg(unix)]
    remove_stale_llm_sidecar_socket(socket_path)?;
    let mut command = Command::new(binary);
    let _ignored = command.kill_on_drop(true).arg("--socket").arg(socket_path);
    command.spawn()
}

#[cfg(unix)]
fn remove_stale_llm_sidecar_socket(socket_path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::FileTypeExt;

    let meta = match std::fs::symlink_metadata(socket_path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };

    if meta.file_type().is_socket() {
        std::fs::remove_file(socket_path)?;
    }

    Ok(())
}

async fn handle_llm_sidecar_spawn_error(
    error: std::io::Error,
    failures: &mut u32,
    shutdown_rx: &mut watch::Receiver<()>,
) -> LlmSidecarStep {
    error!(error = %error, "failed to spawn LLM sidecar");
    *failures = failures.saturating_add(1);
    if *failures >= MAX_CONSECUTIVE_FAILURES {
        error!(
            failures,
            "LLM sidecar failed to spawn {MAX_CONSECUTIVE_FAILURES} \
             times consecutively; giving up"
        );
        return LlmSidecarStep::Stop;
    }
    retry_llm_sidecar(*failures, shutdown_rx).await
}

async fn handle_llm_sidecar_startup(
    startup: LlmHealthWait,
    child: &mut tokio::process::Child,
    socket_path: &Path,
    started_at: Instant,
    failures: &mut u32,
    shutdown_rx: &mut watch::Receiver<()>,
) -> LlmSidecarStep {
    match startup {
        LlmHealthWait::Healthy => {
            info!(
                socket = %socket_path.display(),
                "LLM sidecar health check passed"
            );
            LlmSidecarStep::Proceed
        }
        LlmHealthWait::Exited(status) => {
            let runtime = started_at.elapsed();
            *failures = record_child_exit("LLM sidecar", &status, runtime, *failures);
            if *failures >= MAX_CONSECUTIVE_FAILURES {
                error!(
                    failures = *failures,
                    "LLM sidecar exited {MAX_CONSECUTIVE_FAILURES} times \
                     consecutively before becoming healthy; giving up"
                );
                return LlmSidecarStep::Stop;
            }
            retry_llm_sidecar(*failures, shutdown_rx).await
        }
        LlmHealthWait::UnhealthyTimeout => {
            warn!(
                socket = %socket_path.display(),
                timeout_secs = LLM_SIDECAR_HEALTH_STARTUP_TIMEOUT.as_secs(),
                "LLM sidecar did not pass health check; restarting"
            );
            graceful_shutdown(child, SHUTDOWN_GRACE).await;
            *failures = failures.saturating_add(1);
            if *failures >= MAX_CONSECUTIVE_FAILURES {
                error!(
                    failures = *failures,
                    "LLM sidecar failed health check {MAX_CONSECUTIVE_FAILURES} \
                     times consecutively; giving up"
                );
                return LlmSidecarStep::Stop;
            }
            retry_llm_sidecar(*failures, shutdown_rx).await
        }
        LlmHealthWait::Shutdown => {
            info!("shutdown requested; stopping LLM sidecar");
            graceful_shutdown(child, SHUTDOWN_GRACE).await;
            LlmSidecarStep::Stop
        }
    }
}

async fn retry_llm_sidecar(failures: u32, shutdown_rx: &mut watch::Receiver<()>) -> LlmSidecarStep {
    if sleep_or_shutdown(backoff(failures), shutdown_rx).await {
        LlmSidecarStep::Retry
    } else {
        LlmSidecarStep::Stop
    }
}

async fn wait_for_llm_sidecar_health(
    child: &mut tokio::process::Child,
    socket_path: &Path,
    shutdown_rx: &mut watch::Receiver<()>,
) -> LlmHealthWait {
    let started_at = Instant::now();
    loop {
        if llm_sidecar_healthz(socket_path).await {
            return LlmHealthWait::Healthy;
        }
        if started_at.elapsed() >= LLM_SIDECAR_HEALTH_STARTUP_TIMEOUT {
            return LlmHealthWait::UnhealthyTimeout;
        }

        return tokio::select! {
            status = child.wait() => LlmHealthWait::Exited(status),
            _ = shutdown_rx.changed() => LlmHealthWait::Shutdown,
            () = tokio::time::sleep(LLM_SIDECAR_HEALTH_POLL_INTERVAL) => continue,
        };
    }
}

#[cfg(unix)]
async fn llm_sidecar_healthz(socket_path: &Path) -> bool {
    use tokio::net::UnixStream;

    let connect_result = tokio::time::timeout(
        LLM_SIDECAR_HEALTH_REQUEST_TIMEOUT,
        UnixStream::connect(socket_path),
    )
    .await;
    let Ok(Ok(mut stream)) = connect_result else {
        return false;
    };

    let request = b"GET /healthz HTTP/1.1\r\nHost: sidecar\r\nConnection: close\r\n\r\n";
    let wrote = tokio::time::timeout(
        LLM_SIDECAR_HEALTH_REQUEST_TIMEOUT,
        stream.write_all(request),
    )
    .await;
    let Ok(Ok(())) = wrote else {
        return false;
    };

    let mut buf = [0_u8; 64];
    let read =
        tokio::time::timeout(LLM_SIDECAR_HEALTH_REQUEST_TIMEOUT, stream.read(&mut buf)).await;
    let Ok(Ok(n)) = read else {
        return false;
    };
    buf.get(..n).is_some_and(|bytes| {
        bytes.starts_with(b"HTTP/1.1 200") || bytes.starts_with(b"HTTP/1.0 200")
    })
}

#[cfg(not(unix))]
async fn llm_sidecar_healthz(_socket_path: &Path) -> bool {
    false
}

fn record_child_exit(
    service: &'static str,
    status: &std::io::Result<ExitStatus>,
    runtime: Duration,
    mut failures: u32,
) -> u32 {
    if runtime >= STABLE_RUNTIME_THRESHOLD {
        failures = 0;
    }
    failures = failures.saturating_add(1);
    warn!(
        service = service,
        ?status,
        runtime_secs = runtime.as_secs(),
        failures,
        "supervised child exited; will restart with backoff"
    );
    failures
}

/// Send SIGTERM to `child` and wait up to `grace` for it to exit. If the
/// child is still alive after the grace period, escalate to SIGKILL.
///
/// We route SIGTERM through `libc::kill` because tokio's `Child::start_kill`
/// sends SIGKILL on Unix, which gives supervised children no chance to tear
/// down their own subprocesses or flush state.
#[expect(
    unsafe_code,
    reason = "SIGTERM is routed through libc::kill so children can tear down gracefully; tokio's Child::start_kill only sends SIGKILL"
)]
async fn graceful_shutdown(child: &mut tokio::process::Child, grace: Duration) {
    if let Some(pid) = child.id() {
        let Ok(pid_t) = libc::pid_t::try_from(pid) else {
            warn!(
                pid,
                "supervised child pid does not fit platform pid_t; escalating"
            );
            let _ignored = child.start_kill();
            _ = child.wait().await;
            return;
        };
        // SAFETY: `libc::kill` is a standard syscall; passing a valid pid
        // retrieved from the still-running child is sound.
        let rc = unsafe { libc::kill(pid_t, libc::SIGTERM) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            warn!(pid, error = %err, "SIGTERM to supervised child failed; escalating");
        }
    } else {
        // No pid means the child has already been reaped.
        return;
    }

    if tokio::time::timeout(grace, child.wait()).await.is_err() {
        warn!(
            grace_secs = grace.as_secs(),
            "supervised child did not exit within grace period; sending SIGKILL"
        );
        let _ignored = child.start_kill();
        _ = child.wait().await;
    }
}

/// Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 32s. `failures`
/// is the 1-indexed consecutive failure count.
fn backoff(failures: u32) -> Duration {
    let shift = failures.saturating_sub(1).min(5);
    Duration::from_secs(1_u64 << shift)
}

fn matrix_log_filter() -> String {
    matrix_log_filter_from(std::env::var(MATRIX_LOG_ENV).ok())
}

fn matrix_log_filter_from(value: Option<String>) -> String {
    value
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MATRIX_LOG_FILTER.to_owned())
}

/// Sleep for `dur` unless a shutdown signal arrives first. Returns
/// `true` if the sleep completed normally, `false` if interrupted by
/// shutdown.
async fn sleep_or_shutdown(dur: Duration, rx: &mut watch::Receiver<()>) -> bool {
    tokio::select! {
        () = tokio::time::sleep(dur) => true,
        _ = rx.changed() => false,
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    unused_results,
    reason = "asserts in `?`-returning tests and detached spawn handles; the test-exemption equivalent of clippy.toml's allow-panic-in-tests"
)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn bind_once_healthz(
        response: &'static [u8],
    ) -> Result<(tempfile::TempDir, PathBuf), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let socket_path = tmp.path().join("llm.sock");
        let listener = tokio::net::UnixListener::bind(&socket_path)?;
        let probe_path = socket_path.clone();

        tokio::spawn(async move {
            let Ok((mut stream, _addr)) = listener.accept().await else {
                return;
            };
            let mut buf = [0_u8; 128];
            let _ignored = stream.read(&mut buf).await;
            _ = stream.write_all(response).await;
        });

        Ok((tmp, probe_path))
    }

    #[test]
    fn backoff_progression() {
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(2), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(4));
        assert_eq!(backoff(4), Duration::from_secs(8));
        assert_eq!(backoff(5), Duration::from_secs(16));
        assert_eq!(backoff(6), Duration::from_secs(32));
        // Saturates at the 32-second cap beyond the 5-retry window.
        assert_eq!(backoff(7), Duration::from_secs(32));
        assert_eq!(backoff(100), Duration::from_secs(32));
    }

    #[test]
    fn backoff_zero_failures_is_one_second() {
        // Not a real code path, but guards against a `saturating_sub`
        // regression turning 0 into the cap.
        assert_eq!(backoff(0), Duration::from_secs(1));
    }

    #[test]
    fn matrix_log_filter_uses_quiet_default() {
        assert_eq!(
            matrix_log_filter_from(None),
            "warn,shore_matrix=info,matrix_sdk_crypto::backups=error"
        );
        assert_eq!(
            matrix_log_filter_from(Some("   ".into())),
            "warn,shore_matrix=info,matrix_sdk_crypto::backups=error"
        );
    }

    #[test]
    fn matrix_log_filter_accepts_override() {
        assert_eq!(
            matrix_log_filter_from(Some("shore_matrix=debug".into())),
            "shore_matrix=debug"
        );
    }

    #[test]
    fn record_child_exit_increments_consecutive_failures() {
        let status = Err(std::io::Error::other("boom"));
        let next = record_child_exit("test child", &status, Duration::from_secs(1), 2);
        assert_eq!(next, 3);
    }

    #[test]
    fn record_child_exit_resets_after_stable_runtime() {
        let status = Err(std::io::Error::other("boom"));
        let next = record_child_exit("test child", &status, STABLE_RUNTIME_THRESHOLD, 4);
        assert_eq!(next, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn llm_sidecar_healthz_accepts_http_200() -> Result<(), Box<dyn std::error::Error>> {
        let (_tmp, socket_path) =
            bind_once_healthz(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")?;

        assert!(llm_sidecar_healthz(&socket_path).await);
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn llm_sidecar_healthz_rejects_non_200() -> Result<(), Box<dyn std::error::Error>> {
        let (_tmp, socket_path) =
            bind_once_healthz(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")?;

        assert!(!llm_sidecar_healthz(&socket_path).await);
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn llm_sidecar_healthz_rejects_missing_socket() -> Result<(), Box<dyn std::error::Error>>
    {
        let tmp = tempfile::tempdir()?;
        let socket_path = tmp.path().join("missing.sock");

        assert!(!llm_sidecar_healthz(&socket_path).await);
        Ok(())
    }

    #[tokio::test]
    async fn llm_sidecar_socket_dir_allows_relative_socket() {
        let (_tx, mut rx) = watch::channel(());
        let mut failures = 0;

        let step =
            ensure_llm_sidecar_socket_dir(Path::new("llm.sock"), &mut failures, &mut rx).await;

        assert!(matches!(step, LlmSidecarStep::Proceed));
        assert_eq!(failures, 0);
    }
}
