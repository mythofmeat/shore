#[cfg(unix)]
#[test]
fn cli_and_terminal_reliability_flows() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/reliability_flows.py"
        ))
        .arg(env!("CARGO_BIN_EXE_shore"))
        .output()
        .expect("Python 3 runs the local socket and pseudo-terminal regression fixtures");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
