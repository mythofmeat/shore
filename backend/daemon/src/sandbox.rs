//! Capability-based sandbox for the `exec` tool's subprocesses.
//!
//! The command allowlist and git denylist (see [`crate::tools::workspace`]) are
//! a fat-finger guard: they cannot fully enclose a programmable surface like
//! `git`. This module adds containment *underneath* them, so that what an
//! escaped command can do is bounded regardless of how it escaped.
//!
//! On Linux, every program run through `exec` is re-executed inside this
//! binary's hidden [`HELPER_ARG`] mode, which — before `execve` of the real
//! program — applies:
//!
//! - **`no_new_privs`** so privileges cannot be regained across `execve`,
//! - **Landlock** for filesystem confinement: read-only everywhere, writable
//!   only under the character workspace and the standard build-tool caches, so
//!   an escape cannot trash `~/.ssh`, `~/.config/shore`, or the system,
//! - **seccomp** to cut outbound network (IPv4/IPv6 sockets), namespace tricks
//!   (`unshare`/`setns`/`mount`/namespace `clone` flags), and `ptrace`.
//!
//! The design goal is invisibility: normal `git`/read workloads — and cached
//! `cargo`/`npm` builds — are unaffected; only genuinely dangerous or malicious
//! actions are blocked. Non-Linux platforms fall back to denylist-only `exec`.

use std::sync::OnceLock;

use shore_config::app::{ExecConfig, SandboxMode};

/// Hidden first argument that switches the daemon binary into sandbox-helper
/// mode. The entrypoint dispatches to [`run_sandbox_child`] when it sees this as
/// `argv[1]`, before any async runtime starts (the restrictions must be applied
/// single-threaded, before `execve`).
pub const HELPER_ARG: &str = "__sandbox-exec";

static POLICY: OnceLock<ExecConfig> = OnceLock::new();

/// Install the process-wide exec sandbox policy. Called once at daemon startup
/// from the loaded config; later calls are ignored.
pub fn init_policy(cfg: ExecConfig) {
    let _ignored = POLICY.set(cfg);
}

/// The active policy. Defaults to fully disabled when uninitialized so that test
/// binaries and any other non-daemon caller of [`plan_for`] never accidentally
/// re-exec themselves as a sandbox helper.
fn policy() -> ExecConfig {
    POLICY.get().cloned().unwrap_or(ExecConfig {
        sandbox: SandboxMode::Off,
        allow_network: false,
    })
}

/// How [`crate::tools::workspace::handle_exec`] should spawn a validated command.
#[derive(Debug)]
pub enum SandboxPlan {
    /// Spawn the program directly — the sandbox is disabled, or it is `auto` and
    /// cannot be enforced (degrade to denylist-only).
    Direct,
    /// Re-exec the daemon binary (`helper`) in [`HELPER_ARG`] mode: pass
    /// `prefix_args`, then `--`, then the real program and its arguments.
    Wrapped {
        helper: std::path::PathBuf,
        prefix_args: Vec<String>,
    },
    /// The sandbox is **required** (`mode = "on"`) but cannot be applied (e.g. no
    /// workspace root, or `current_exe()` failed). The caller must fail closed —
    /// refuse to run the command rather than run it unsandboxed.
    Unavailable { reason: String },
}

/// Decide how to spawn an exec command for the given character workspace.
#[cfg(target_os = "linux")]
#[must_use]
pub fn plan_for(workspace_dir: &str) -> SandboxPlan {
    let pol = policy();
    let require = match pol.sandbox {
        SandboxMode::Off => return SandboxPlan::Direct,
        SandboxMode::On => true,
        SandboxMode::Auto => {
            if landlock_abi() < 1 {
                warn_fallback();
                return SandboxPlan::Direct;
            }
            false
        }
    };

    // Without a workspace root there is nothing to confine to. In `auto` we
    // degrade to a direct spawn; in `on` we must fail closed.
    if workspace_dir.is_empty() {
        return unavailable_or_direct(require, "exec sandbox requires a workspace root");
    }

    let helper = match std::env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            return unavailable_or_direct(require, &format!("current_exe() failed: {err}"));
        }
    };

    let mut prefix_args = vec![
        HELPER_ARG.to_owned(),
        "--root".to_owned(),
        workspace_dir.to_owned(),
    ];
    if require {
        prefix_args.push("--require".to_owned());
    }
    if pol.allow_network {
        prefix_args.push("--allow-network".to_owned());
    }
    SandboxPlan::Wrapped {
        helper,
        prefix_args,
    }
}

/// When the sandbox can't be applied: fail closed under `on` (required), or
/// degrade to a direct spawn under `auto`.
#[cfg(target_os = "linux")]
fn unavailable_or_direct(require: bool, reason: &str) -> SandboxPlan {
    if require {
        SandboxPlan::Unavailable {
            reason: reason.to_owned(),
        }
    } else {
        tracing::warn!(reason = %reason, "exec sandbox: running unsandboxed (auto fallback)");
        SandboxPlan::Direct
    }
}

/// Non-Linux platforms have no Landlock/seccomp: always spawn directly.
#[cfg(not(target_os = "linux"))]
#[must_use]
pub fn plan_for(_workspace_dir: &str) -> SandboxPlan {
    let _ = policy();
    SandboxPlan::Direct
}

/// The kernel's supported Landlock ABI version (>= 1), or a non-positive value
/// when Landlock is unavailable. Cached after the first probe.
#[cfg(target_os = "linux")]
fn landlock_abi() -> libc::c_long {
    static ABI: OnceLock<libc::c_long> = OnceLock::new();
    *ABI.get_or_init(probe_landlock_abi)
}

#[cfg(target_os = "linux")]
#[expect(
    unsafe_code,
    reason = "landlock_create_ruleset has no libc wrapper; the VERSION query is a pure read"
)]
fn probe_landlock_abi() -> libc::c_long {
    // LANDLOCK_CREATE_RULESET_VERSION
    let version_flag: libc::c_ulong = 1;
    // SAFETY: landlock_create_ruleset(NULL, 0, VERSION) is a pure query — with
    // the VERSION flag it creates no ruleset and only returns the supported ABI
    // version (>= 1) or -1 on a kernel without Landlock.
    unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0_usize,
            version_flag,
        )
    }
}

/// Warn exactly once that the sandbox is degrading to denylist-only `exec`.
#[cfg(target_os = "linux")]
fn warn_fallback() {
    static WARNED: OnceLock<()> = OnceLock::new();
    if WARNED.set(()).is_ok() {
        tracing::warn!(
            "exec sandbox: kernel does not support Landlock; running exec with the command denylist only"
        );
    }
}

// ---------------------------------------------------------------------------
// Sandbox helper child (`HELPER_ARG` mode)
// ---------------------------------------------------------------------------

/// Apply the sandbox to the current (single-threaded) process and `execve` the
/// requested program. Only returns on failure — the returned error aborts the
/// exec and surfaces as the tool's stderr.
#[cfg(target_os = "linux")]
#[must_use]
pub fn run_sandbox_child() -> std::io::Error {
    use std::os::unix::process::CommandExt as _;

    let parsed = match parse_child_args() {
        Ok(parsed) => parsed,
        Err(err) => return err,
    };
    if let Err(err) = apply_restrictions(&parsed.root, parsed.allow_network, parsed.require) {
        return err;
    }
    let mut command = std::process::Command::new(&parsed.program);
    let _ = command.args(&parsed.program_args);
    // `exec` replaces the process image on success and only returns on failure.
    command.exec()
}

/// Non-Linux stub: the helper mode is never dispatched off Linux.
#[cfg(not(target_os = "linux"))]
#[must_use]
pub fn run_sandbox_child() -> std::io::Error {
    std::io::Error::other("exec sandbox helper is only supported on Linux")
}

#[cfg(target_os = "linux")]
struct ChildArgs {
    root: std::path::PathBuf,
    require: bool,
    allow_network: bool,
    program: std::ffi::OsString,
    program_args: Vec<std::ffi::OsString>,
}

#[cfg(target_os = "linux")]
fn child_arg_err(msg: &str) -> std::io::Error {
    std::io::Error::other(msg.to_owned())
}

/// Parse the helper argv: `<exe> __sandbox-exec --root R [--require]
/// [--allow-network] -- PROGRAM ARGS...`.
#[cfg(target_os = "linux")]
fn parse_child_args() -> std::io::Result<ChildArgs> {
    use std::ffi::OsString;

    let mut args = std::env::args_os();
    let _ = args.next(); // executable path
    let _ = args.next(); // HELPER_ARG

    let mut root: Option<OsString> = None;
    let mut require = false;
    let mut allow_network = false;
    let mut program: Option<OsString> = None;
    let mut program_args: Vec<OsString> = Vec::new();

    while let Some(arg) = args.next() {
        if arg == "--root" {
            root = Some(
                args.next()
                    .ok_or_else(|| child_arg_err("--root requires a value"))?,
            );
        } else if arg == "--require" {
            require = true;
        } else if arg == "--allow-network" {
            allow_network = true;
        } else if arg == "--" {
            program = args.next();
            program_args = args.collect();
            break;
        } else {
            return Err(child_arg_err("unexpected sandbox helper argument"));
        }
    }

    let root_arg = root.ok_or_else(|| child_arg_err("missing --root"))?;
    let program_name = program.ok_or_else(|| child_arg_err("missing program after --"))?;
    Ok(ChildArgs {
        root: std::path::PathBuf::from(root_arg),
        require,
        allow_network,
        program: program_name,
        program_args,
    })
}

#[cfg(target_os = "linux")]
fn apply_restrictions(
    root: &std::path::Path,
    allow_network: bool,
    require: bool,
) -> std::io::Result<()> {
    set_no_new_privs(require)?;
    apply_landlock(root, require)?;
    apply_seccomp(allow_network, require)?;
    Ok(())
}

#[cfg(target_os = "linux")]
#[expect(
    unsafe_code,
    reason = "prctl(PR_SET_NO_NEW_PRIVS) is a required precondition for Landlock and seccomp"
)]
fn set_no_new_privs(require: bool) -> std::io::Result<()> {
    // SAFETY: prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) takes only scalar arguments
    // and has no memory side effects; it sets the calling thread's no_new_privs
    // bit so privileges cannot be regained across execve.
    let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc == 0 {
        Ok(())
    } else if require {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Confine the filesystem: read-only everywhere, writable only under the
/// workspace and the standard build-tool caches.
#[cfg(target_os = "linux")]
fn apply_landlock(root: &std::path::Path, require: bool) -> std::io::Result<()> {
    use landlock::{
        path_beneath_rules, Access, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr,
        RulesetStatus, ABI,
    };

    // ABI v3 (Linux 6.2) adds TRUNCATE, closing the open(O_TRUNC) write path.
    // BestEffort (the crate default) downgrades on older kernels.
    let abi = ABI::V3;

    let mut write_roots: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    write_roots.extend(cache_write_dirs());
    write_roots.push(std::path::PathBuf::from("/dev/null"));

    let built = (|| -> Result<RulesetStatus, landlock::RulesetError> {
        let status = Ruleset::default()
            .handle_access(AccessFs::from_all(abi))?
            .create()?
            .add_rules(path_beneath_rules(["/"], AccessFs::from_read(abi)))?
            .add_rules(path_beneath_rules(&write_roots, AccessFs::from_all(abi)))?
            .restrict_self()?;
        Ok(status.ruleset)
    })();

    match built {
        Ok(status) => {
            if require && status == RulesetStatus::NotEnforced {
                return Err(std::io::Error::other("Landlock could not be enforced"));
            }
            Ok(())
        }
        Err(err) => {
            if require {
                return Err(std::io::Error::other(format!("Landlock error: {err}")));
            }
            Ok(())
        }
    }
}

/// Directories an exec'd program may legitimately write to outside the
/// workspace: the standard cargo/rustup/npm/cache locations and temp dirs.
/// Non-existent paths are silently skipped by `path_beneath_rules`.
#[cfg(target_os = "linux")]
fn cache_write_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = Vec::new();

    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".cargo")));
    if let Some(dir) = cargo_home {
        dirs.push(dir);
    }
    let rustup_home = std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".rustup")));
    if let Some(dir) = rustup_home {
        dirs.push(dir);
    }
    if let Some(h) = home.as_ref() {
        dirs.push(h.join(".npm"));
        dirs.push(h.join(".cache"));
    }
    dirs.push(std::env::temp_dir());
    dirs.push(PathBuf::from("/tmp"));
    dirs.push(PathBuf::from("/var/tmp"));
    dirs
}

#[cfg(target_os = "linux")]
fn apply_seccomp(allow_network: bool, require: bool) -> std::io::Result<()> {
    if let Err(err) = build_and_apply_seccomp(allow_network) {
        if require {
            return Err(std::io::Error::other(format!("seccomp error: {err}")));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn build_and_apply_seccomp(allow_network: bool) -> Result<(), Box<dyn std::error::Error>> {
    for program in build_seccomp_programs(allow_network)? {
        seccompiler::apply_filter(&program)?;
    }
    Ok(())
}

/// Compile the two stacked seccomp filters to BPF without installing them.
///
/// Filter 1 returns `ENOSYS` for `clone3` so glibc transparently falls back to
/// `clone` (which filter 2 screens for namespace flags); returning `EPERM`
/// there would break threading. Filter 2 returns `EPERM` for the network,
/// namespace, and ptrace surface. Stacked filters take the most restrictive
/// action, and the two never overlap on a syscall, so there is no conflict.
#[cfg(target_os = "linux")]
fn build_seccomp_programs(
    allow_network: bool,
) -> Result<Vec<seccompiler::BpfProgram>, Box<dyn std::error::Error>> {
    use std::convert::TryInto as _;

    use seccompiler::{BpfProgram, SeccompAction, SeccompFilter, SeccompRule};

    let clone3_rules: std::collections::BTreeMap<i64, Vec<SeccompRule>> =
        std::collections::BTreeMap::from([(libc::SYS_clone3, Vec::new())]);
    let filter1 = SeccompFilter::new(
        clone3_rules,
        SeccompAction::Allow,
        SeccompAction::Errno(u32::try_from(libc::ENOSYS)?),
        std::env::consts::ARCH.try_into()?,
    )?;

    let filter2 = SeccompFilter::new(
        build_deny_rules(allow_network)?,
        SeccompAction::Allow,
        SeccompAction::Errno(u32::try_from(libc::EPERM)?),
        std::env::consts::ARCH.try_into()?,
    )?;

    let program1: BpfProgram = filter1.try_into()?;
    let program2: BpfProgram = filter2.try_into()?;
    Ok(vec![program1, program2])
}

/// The match-to-`EPERM` rule set: network, namespace, and ptrace syscalls.
#[cfg(target_os = "linux")]
fn build_deny_rules(
    allow_network: bool,
) -> Result<
    std::collections::BTreeMap<i64, Vec<seccompiler::SeccompRule>>,
    Box<dyn std::error::Error>,
> {
    use seccompiler::{SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompRule};

    let mut rules: std::collections::BTreeMap<i64, Vec<SeccompRule>> =
        std::collections::BTreeMap::new();

    // Unconditional denials: namespace manipulation, process tracing, and
    // io_uring. None have a legitimate use in the allowlisted exec programs.
    // io_uring is blocked because its ring ops (IORING_OP_SOCKET/CONNECT,
    // OPENAT/WRITE) execute outside the syscall path and would otherwise bypass
    // both the socket filter below and (on some kernels) Landlock.
    let unconditional = [
        libc::SYS_setns,
        libc::SYS_unshare,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_io_uring_setup,
    ];
    for nr in unconditional {
        let _ = rules.insert(nr, Vec::new());
    }

    // socket(AF_INET|AF_INET6, ...) -> blocked. AF_UNIX and AF_NETLINK stay
    // allowed so local IPC and name lookups still create their sockets.
    if !allow_network {
        let af_inet = u64::try_from(libc::AF_INET)?;
        let af_inet6 = u64::try_from(libc::AF_INET6)?;
        let _ = rules.insert(
            libc::SYS_socket,
            vec![
                SeccompRule::new(vec![SeccompCondition::new(
                    0,
                    SeccompCmpArgLen::Dword,
                    SeccompCmpOp::Eq,
                    af_inet,
                )?])?,
                SeccompRule::new(vec![SeccompCondition::new(
                    0,
                    SeccompCmpArgLen::Dword,
                    SeccompCmpOp::Eq,
                    af_inet6,
                )?])?,
            ],
        );
    }

    // clone(flags, ...) with any new-namespace bit set -> blocked. Ordinary
    // fork/thread clones carry no CLONE_NEW* bits and are unaffected.
    let new_namespace_flags = [
        libc::CLONE_NEWNS,
        libc::CLONE_NEWUTS,
        libc::CLONE_NEWIPC,
        libc::CLONE_NEWUSER,
        libc::CLONE_NEWPID,
        libc::CLONE_NEWNET,
        libc::CLONE_NEWCGROUP,
    ];
    let mut clone_rules: Vec<SeccompRule> = Vec::new();
    for flag in new_namespace_flags {
        let bit = u64::try_from(flag)?;
        clone_rules.push(SeccompRule::new(vec![SeccompCondition::new(
            0,
            SeccompCmpArgLen::Qword,
            SeccompCmpOp::MaskedEq(bit),
            bit,
        )?])?);
    }
    let _ = rules.insert(libc::SYS_clone, clone_rules);

    Ok(rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninitialized_policy_is_off_and_direct() {
        // With no init_policy() call, the policy is Off, so planning never wraps
        // (and never re-execs the test binary as a helper).
        assert!(matches!(plan_for("/some/workspace"), SandboxPlan::Direct));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn empty_workspace_is_direct() {
        // Uninitialized policy is Off, so an empty workspace plans Direct.
        assert!(matches!(plan_for(""), SandboxPlan::Direct));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn required_but_unavailable_fails_closed() {
        // `on` (require=true) must surface Unavailable; `auto` degrades to Direct.
        assert!(matches!(
            unavailable_or_direct(true, "no root"),
            SandboxPlan::Unavailable { .. }
        ));
        assert!(matches!(
            unavailable_or_direct(false, "no root"),
            SandboxPlan::Direct
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn seccomp_programs_compile() {
        // Both stacked filters must compile to BPF (without being installed).
        assert_eq!(
            build_seccomp_programs(false)
                .expect("blocked-network filter")
                .len(),
            2,
            "two stacked filters expected"
        );
        assert_eq!(
            build_seccomp_programs(true)
                .expect("allowed-network filter")
                .len(),
            2,
            "two stacked filters expected"
        );
    }
}
