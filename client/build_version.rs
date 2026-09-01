use std::process::Command;

pub(crate) fn resolve() -> String {
    std::env::var("SHORE_BUILD_VERSION")
        .ok()
        .filter(|version| !version.is_empty())
        .or_else(describe)
        .unwrap_or_else(|| "unknown".to_owned())
}

pub(crate) fn emit_rerun_directives() {
    println!("cargo::rerun-if-env-changed=SHORE_BUILD_VERSION");
    for path in ["HEAD", "refs", "packed-refs"] {
        let result = Command::new("git")
            .args(["rev-parse", "--path-format=absolute", "--git-path", path])
            .output();
        let Ok(output) = result else { continue };
        if !output.status.success() {
            continue;
        }
        let Ok(git_path) = String::from_utf8(output.stdout) else {
            continue;
        };
        println!("cargo::rerun-if-changed={}", git_path.trim());
    }
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
