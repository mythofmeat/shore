use std::process::Command;

fn main() {
    let version = describe().unwrap_or_else(|| "unknown".to_owned());
    println!("cargo::rustc-env=SHORE_VERSION={version}");
    println!("cargo::rerun-if-changed=../../.git/HEAD");
    println!("cargo::rerun-if-changed=../../.git/refs");
    println!("cargo::rerun-if-changed=../../.git/packed-refs");
}

fn describe() -> Option<String> {
    let output = Command::new("git")
        .args(["describe", "--long", "--tags", "--abbrev=7"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let described = String::from_utf8(output.stdout).ok()?;
    Some(normalize(described.trim()))
}

fn normalize(described: &str) -> String {
    let trimmed = described.strip_prefix('v').unwrap_or(described);
    let mut parts: Vec<&str> = trimmed.split('-').collect();
    let Some(hash) = parts.pop() else {
        return trimmed.replace('-', ".");
    };
    let Some(count) = parts.pop() else {
        return trimmed.replace('-', ".");
    };
    if parts.is_empty() {
        return trimmed.replace('-', ".");
    }
    format!("{}.r{count}.{hash}", parts.join("."))
}
