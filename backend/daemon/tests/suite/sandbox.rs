//! End-to-end tests for the exec-tool sandbox helper (`__sandbox-exec`).
//!
//! These drive the real daemon binary in helper mode, the same way
//! `handle_exec` does. They are Linux-only and skip themselves (with a logged
//! note) when the kernel lacks Landlock, so they are safe to run anywhere.

#![cfg(target_os = "linux")]

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

use shore_daemon::sandbox::HELPER_ARG;

fn daemon_bin() -> String {
    std::env::var("CARGO_BIN_EXE_shore-daemon")
        .expect("CARGO_BIN_EXE_shore-daemon — run via `cargo test -p shore-daemon`")
}

/// A fresh workspace directory under a tempdir that is NOT in the sandbox's
/// writable set (`CARGO_TARGET_TMPDIR` lives under `target/`, not `/tmp` or a
/// build cache), so paths outside the `ws/` root are genuinely write-denied.
fn workspace() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("sandbox-")
        .tempdir_in(env!("CARGO_TARGET_TMPDIR"))
        .expect("tempdir");
    std::fs::create_dir_all(dir.path().join("ws")).expect("create ws");
    dir
}

/// Run the helper: `<bin> __sandbox-exec --root <root> [--require]
/// [--allow-network] -- <argv...>`.
fn run_helper_cfg(
    bin: &str,
    root: &Path,
    require: bool,
    allow_network: bool,
    argv: &[&str],
) -> std::process::ExitStatus {
    let mut helper_args: Vec<OsString> = vec![HELPER_ARG.into(), "--root".into(), root.into()];
    if require {
        helper_args.push("--require".into());
    }
    if allow_network {
        helper_args.push("--allow-network".into());
    }
    helper_args.push("--".into());
    helper_args.extend(argv.iter().map(OsString::from));
    Command::new(bin)
        .args(&helper_args)
        .status()
        .expect("spawn sandbox helper")
}

/// The common case: sandboxed with network blocked.
fn run_helper(bin: &str, root: &Path, require: bool, argv: &[&str]) -> std::process::ExitStatus {
    run_helper_cfg(bin, root, require, false, argv)
}

/// True when the sandbox actually enforces on this kernel: a `--require` run of
/// `true` succeeds only if Landlock + seccomp could be installed.
fn sandbox_enforced(bin: &str, root: &Path) -> bool {
    run_helper(bin, root, true, &["true"]).success()
}

#[test]
fn allows_writes_inside_workspace() {
    let bin = daemon_bin();
    let tmp = workspace();
    let ws = tmp.path().join("ws");
    let inside = ws.join("note.txt");

    // No --require: best-effort, so this also passes on kernels without Landlock
    // (where it simply runs unsandboxed).
    let status = run_helper(&bin, &ws, false, &["touch", inside.to_str().unwrap()]);
    assert!(status.success(), "touch inside workspace should succeed");
    assert!(inside.exists(), "file inside workspace should be created");
}

#[test]
fn blocks_writes_outside_workspace() {
    let bin = daemon_bin();
    let tmp = workspace();
    let ws = tmp.path().join("ws");

    if !sandbox_enforced(&bin, &ws) {
        eprintln!("skipping: Landlock not enforced on this kernel");
        return;
    }

    // A sibling of the workspace, outside the confined tree.
    let outside = tmp.path().join("escape.txt");
    let status = run_helper(&bin, &ws, true, &["touch", outside.to_str().unwrap()]);
    assert!(!status.success(), "touch outside workspace must be denied");
    assert!(
        !outside.exists(),
        "file outside workspace must not be created"
    );
}

#[test]
fn blocks_writes_to_home_config() {
    let bin = daemon_bin();
    let tmp = workspace();
    let ws = tmp.path().join("ws");

    if !sandbox_enforced(&bin, &ws) {
        eprintln!("skipping: Landlock not enforced on this kernel");
        return;
    }

    // Simulate the daemon's own config dir living outside the workspace: writes
    // into it (other characters' memory, the .env with keys) must be denied.
    let fake_config = tmp.path().join("config-shore");
    std::fs::create_dir_all(&fake_config).expect("create fake config dir");
    let target = fake_config.join("stolen.txt");
    let status = run_helper(&bin, &ws, true, &["touch", target.to_str().unwrap()]);
    assert!(
        !status.success(),
        "write into outside config dir must be denied"
    );
    assert!(!target.exists(), "outside config file must not be created");
}

#[test]
fn blocks_outbound_network() {
    let bin = daemon_bin();
    let tmp = workspace();
    let ws = tmp.path().join("ws");

    if !sandbox_enforced(&bin, &ws) {
        eprintln!("skipping: Landlock not enforced on this kernel");
        return;
    }

    // A listener the connect attempt can actually reach, so the only thing that
    // can stop it is the seccomp network cut.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let port = listener.local_addr().expect("local addr").port();
    // Only the control connect reaches the listener; the sandboxed connect is
    // blocked at socket() and never arrives.
    let accept_thread = std::thread::spawn(move || {
        drop(listener.accept());
    });

    let connect = format!("exec 3<>/dev/tcp/127.0.0.1/{port}");

    // Control: outside the sandbox the connect must succeed, or this environment
    // can't exercise the network path (e.g. bash lacks /dev/tcp) — skip.
    let control = Command::new("bash").arg("-c").arg(&connect).status();
    match control {
        Ok(status) if status.success() => {}
        _ => {
            eprintln!("skipping: bash /dev/tcp control did not succeed");
            return;
        }
    }

    let status = run_helper(&bin, &ws, true, &["bash", "-c", &connect]);
    assert!(
        !status.success(),
        "outbound TCP connect must be blocked inside the sandbox"
    );
    accept_thread.join().expect("accept thread join");
}

#[test]
fn allows_outbound_network_with_allow_network() {
    let bin = daemon_bin();
    let tmp = workspace();
    let ws = tmp.path().join("ws");

    if !sandbox_enforced(&bin, &ws) {
        eprintln!("skipping: Landlock not enforced on this kernel");
        return;
    }

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let port = listener.local_addr().expect("local addr").port();
    // Two successful connections reach the listener: the unsandboxed control
    // connect and the sandboxed --allow-network connect.
    let accept_thread = std::thread::spawn(move || {
        for _ in 0..2 {
            drop(listener.accept());
        }
    });

    let connect = format!("exec 3<>/dev/tcp/127.0.0.1/{port}");

    // Control: the connect must work unsandboxed, else this environment can't
    // exercise the network path (e.g. bash lacks /dev/tcp) — skip.
    let control = Command::new("bash").arg("-c").arg(&connect).status();
    match control {
        Ok(status) if status.success() => {}
        _ => {
            eprintln!("skipping: bash /dev/tcp control did not succeed");
            return;
        }
    }

    // With --allow-network the seccomp network cut is lifted, so the same
    // connect must succeed even under the (still enforced) sandbox.
    let status = run_helper_cfg(&bin, &ws, true, true, &["bash", "-c", &connect]);
    assert!(
        status.success(),
        "outbound TCP connect must be permitted with --allow-network"
    );
    accept_thread.join().expect("accept thread join");
}
