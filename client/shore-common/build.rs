#[path = "../build_version.rs"]
mod build_version;

fn main() {
    let version = build_version::resolve();
    println!("cargo::rustc-env=SHORE_VERSION={version}");
    build_version::emit_rerun_directives();
}
