//! Fixture generator for the config directory/loader port.
//!
//! Committed, unlike the generators earlier in this series: those ran in
//! throwaway worktrees at 9023b46d, and this development environment is
//! ephemeral, so leaving it on disk would simply lose it. The fixture it writes
//! is still frozen — see the header it emits.
//!
//! Drives the real `shore_common::config` and writes
//! `daemon/tests/config_fixtures/dirs_parity.json`.
//!
//! Run with:
//!   cargo test -p shore-common --test gen_dirs_fixture -- --test-threads=1 --ignored --nocapture
//!
//! Single-threaded is mandatory: the ShoreDirs cases mutate process env.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use shore_common::config::{
    character_active_jsonl, character_compaction_manifest, character_config_dir,
    character_data_dir, character_memory_dir, character_segments_dir, character_workspace_dir,
    character_workspace_file, deep_merge, discover_characters, load_character_definition,
    load_raw_config_table, plugins_dir, resolve_prompt_template, resolve_user_definition,
    ShoreDirs,
};

const VARS: &[&str] = &[
    "SHORE_CONFIG_DIR",
    "SHORE_DATA_DIR",
    "SHORE_RUNTIME_DIR",
    "SHORE_CACHE_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_CACHE_HOME",
    "HOME",
];

fn with_env(pairs: &[(&str, &str)], f: impl FnOnce() -> ShoreDirs) -> ShoreDirs {
    let saved: Vec<(String, Option<String>)> = VARS
        .iter()
        .map(|v| ((*v).to_string(), std::env::var(v).ok()))
        .collect();
    for v in VARS {
        std::env::remove_var(v);
    }
    for (k, val) in pairs {
        std::env::set_var(k, val);
    }
    let out = f();
    for (k, val) in saved {
        match val {
            Some(v) => std::env::set_var(&k, v),
            None => std::env::remove_var(&k),
        }
    }
    out
}

fn dirs_case(name: &str, env: &[(&str, &str)]) -> Value {
    let resolved = with_env(env, ShoreDirs::resolve);
    let env_map: Map<String, Value> = env
        .iter()
        .map(|(k, v)| ((*k).to_string(), json!(v)))
        .collect();
    json!({
        "name": name,
        "env": env_map,
        "config": resolved.config.to_string_lossy(),
        "data": resolved.data.to_string_lossy(),
        "runtime": resolved.runtime.to_string_lossy(),
        "cache": resolved.cache.to_string_lossy(),
    })
}

fn table(src: &str) -> toml::Table {
    src.parse().expect("fixture toml should parse")
}

fn to_json(t: &toml::Table) -> Value {
    serde_json::to_value(t).expect("toml table should serialize")
}

fn merge_case(name: &str, base: &str, overlay: &str) -> Value {
    let mut b = table(base);
    deep_merge(&mut b, &table(overlay));
    json!({ "name": name, "base": base, "overlay": overlay, "merged": to_json(&b) })
}

fn write(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().expect("has parent")).expect("mkdir");
    fs::write(path, content).expect("write");
}

/// Drive `load_raw_config_table` against a scripted directory tree.
fn raw_case(name: &str, files: &[(&str, &str)], config_path: Option<&str>) -> Value {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    for (rel, content) in files {
        write(root, rel, content);
    }

    let explicit = config_path.map(|p| root.join(p));
    // Pin the config dir so an absent explicit path still lands in the tempdir.
    let result = with_env_raw(root, || {
        load_raw_config_table(explicit.as_deref())
    });

    let files_json: Vec<Value> = files.iter().map(|(r, c)| json!({"path": r, "content": c})).collect();
    match result {
        Ok(raw) => json!({
            "name": name,
            "files": files_json,
            "config_path": config_path,
            "ok": {
                "table": to_json(&raw.table),
                // Recorded relative to the tempdir so the replay can rebuild it.
                "config_dir_rel": rel_to(root, &raw.dirs.config),
            },
        }),
        Err(e) => json!({
            "name": name,
            "files": files_json,
            "config_path": config_path,
            "error_kind": error_kind(&e),
        }),
    }
}

fn with_env_raw<T>(root: &Path, f: impl FnOnce() -> T) -> T {
    let saved: Vec<(String, Option<String>)> = VARS
        .iter()
        .map(|v| ((*v).to_string(), std::env::var(v).ok()))
        .collect();
    for v in VARS {
        std::env::remove_var(v);
    }
    std::env::set_var("SHORE_CONFIG_DIR", root);
    std::env::set_var("SHORE_DATA_DIR", root.join("data"));
    std::env::set_var("SHORE_RUNTIME_DIR", root.join("run"));
    std::env::set_var("SHORE_CACHE_DIR", root.join("cache"));
    let out = f();
    for (k, val) in saved {
        match val {
            Some(v) => std::env::set_var(&k, v),
            None => std::env::remove_var(&k),
        }
    }
    out
}

fn rel_to(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

fn error_kind(e: &shore_common::config::ConfigError) -> &'static str {
    use shore_common::config::ConfigError as E;
    match e {
        E::ReadFile { .. } => "read_file",
        E::ParseApp(_) => "parse_app",
        E::ParseInclude { .. } => "parse_include",
        E::ConfD { .. } => "conf_d",
        E::Catalog(_) => "catalog",
        E::ProviderRegistry(_) => "provider_registry",
        E::Validation(_) => "validation",
    }
}

/// Drive the four filesystem lookups against a scripted tree.
fn discovery_case(name: &str, files: &[(&str, &str)], dirs_only: &[&str], probe: &str) -> Value {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    for d in dirs_only {
        fs::create_dir_all(root.join(d)).expect("mkdir");
    }
    for (rel, content) in files {
        write(root, rel, content);
    }
    json!({
        "name": name,
        "files": files.iter().map(|(r, c)| json!({"path": r, "content": c})).collect::<Vec<_>>(),
        "dirs": dirs_only,
        "probe": probe,
        "discovered": discover_characters(root),
        "definition": load_character_definition(root, probe),
        "user": resolve_user_definition(root, probe),
        "prompt_compaction": resolve_prompt_template(root, probe, "compaction.md"),
    })
}

fn path_case(base: &str, name: &str) -> Value {
    let b = PathBuf::from(base);
    json!({
        "base": base,
        "name": name,
        "character_config_dir": character_config_dir(&b, name).to_string_lossy(),
        "character_workspace_dir": character_workspace_dir(&b, name).to_string_lossy(),
        "character_workspace_file": character_workspace_file(&b, name, "SOUL.md").to_string_lossy(),
        "character_memory_dir": character_memory_dir(&b, name).to_string_lossy(),
        "character_data_dir": character_data_dir(&b, name).to_string_lossy(),
        "character_active_jsonl": character_active_jsonl(&b, name).to_string_lossy(),
        "character_segments_dir": character_segments_dir(&b, name).to_string_lossy(),
        "character_compaction_manifest": character_compaction_manifest(&b, name)
            .to_string_lossy(),
        "plugins_dir": plugins_dir(&b).to_string_lossy(),
    })
}

/// Pin `Path::parent().unwrap_or(Path::new("."))`, which is how an explicit
/// `--config` path becomes the config directory.
fn parent_case(input: &str) -> Value {
    let parent = Path::new(input)
        .parent()
        .unwrap_or(Path::new("."))
        .to_string_lossy()
        .to_string();
    json!({ "input": input, "parent": parent })
}

/// Drive `load_character_config` and record the merged *raw* table it produces.
///
/// `parse_config_table` stashes the merged table on the result before doing
/// anything else with it, so `raw_table()` is exactly the table-level merge
/// this port is responsible for — reachable without porting `AppConfig`.
fn char_config_case(name: &str, global: &str, overlay: Option<&str>) -> Value {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    write(root, "config.toml", global);
    if let Some(o) = overlay {
        write(root, "characters/aria/config.toml", o);
    }

    let merged = with_env_raw(root, || {
        let g = shore_common::config::load_config(None).expect("global config should load");
        shore_common::config::load_character_config(&g, "aria")
            .expect("character config should load")
            .map(|c| c.raw_table().cloned().unwrap_or_default())
    });

    json!({
        "name": name,
        "global": global,
        "overlay": overlay,
        "merged": merged.as_ref().map(to_json),
    })
}

#[test]
#[ignore = "fixture generator; run explicitly"]
fn generate() {
    let shore_dirs = vec![
        dirs_case(
            "SHORE_* overrides win and are used verbatim, with no /shore suffix",
            &[
                ("SHORE_CONFIG_DIR", "/o/cfg"),
                ("SHORE_DATA_DIR", "/o/data"),
                ("SHORE_RUNTIME_DIR", "/o/run"),
                ("SHORE_CACHE_DIR", "/o/cache"),
                ("XDG_CONFIG_HOME", "/x/cfg"),
                ("HOME", "/home/u"),
            ],
        ),
        dirs_case(
            "absolute XDG vars get /shore appended",
            &[
                ("XDG_CONFIG_HOME", "/x/cfg"),
                ("XDG_DATA_HOME", "/x/data"),
                ("XDG_RUNTIME_DIR", "/x/run"),
                ("XDG_CACHE_HOME", "/x/cache"),
                ("HOME", "/home/u"),
            ],
        ),
        dirs_case(
            "an empty XDG var is Ok(\"\") and short-circuits the platform lookup",
            &[("XDG_CONFIG_HOME", ""), ("HOME", "/home/u")],
        ),
        dirs_case(
            "a relative XDG var is taken as-is, though the dirs crate would reject it",
            &[("XDG_CONFIG_HOME", "cfg"), ("HOME", "/home/u")],
        ),
        dirs_case(
            "an unnormalized XDG var stays unnormalized",
            &[("XDG_CONFIG_HOME", "/x/a/../b"), ("HOME", "/home/u")],
        ),
        dirs_case("HOME only: platform defaults", &[("HOME", "/home/u")]),
        dirs_case("nothing set: getpwuid answers, so the ~ literal is not reached", &[]),
        dirs_case(
            "an empty HOME is treated as unset and falls through to getpwuid",
            &[("HOME", "")],
        ),
        dirs_case(
            "XDG_RUNTIME_DIR has no platform fallback, so runtime lands in the temp dir",
            &[("XDG_CONFIG_HOME", "/x/cfg"), ("HOME", "/home/u")],
        ),
    ];

    let deep_merges = vec![
        merge_case("overlay scalar overwrites base scalar", "a = 1\nb = 2", "a = 9"),
        merge_case("new keys are added", "a = 1", "b = 2"),
        merge_case(
            "tables recurse rather than replace",
            "[t]\na = 1\nb = 2",
            "[t]\nb = 9\nc = 3",
        ),
        merge_case(
            "arrays are replaced wholesale, not concatenated",
            "a = [1, 2, 3]",
            "a = [9]",
        ),
        merge_case("an empty overlay changes nothing", "[t]\na = 1", ""),
        merge_case(
            "a table in the overlay replaces a scalar in the base",
            "a = 1",
            "[a]\nb = 2",
        ),
        merge_case(
            "a scalar in the overlay replaces a table in the base",
            "[a]\nb = 2",
            "a = 1",
        ),
        merge_case(
            "recursion goes all the way down",
            "[a.b.c]\nx = 1\ny = 2",
            "[a.b.c]\ny = 9\nz = 3",
        ),
        merge_case(
            "an array of tables is a value, not a table",
            "[[a]]\nx = 1",
            "[[a]]\ny = 2",
        ),
    ];

    let raw_configs = vec![
        raw_case("config.toml alone", &[("config.toml", "a = 1\n[t]\nb = 2")], None),
        raw_case("no config.toml at all yields an empty table", &[], None),
        raw_case(
            "include is removed from the table and its file merged over it",
            &[
                ("config.toml", "include = [\"extra.toml\"]\na = 1\nb = 1"),
                ("extra.toml", "b = 2\nc = 3"),
            ],
            None,
        ),
        raw_case(
            "includes merge in written order, last wins",
            &[
                ("config.toml", "include = [\"one.toml\", \"two.toml\"]\nv = 0"),
                ("one.toml", "v = 1"),
                ("two.toml", "v = 2"),
            ],
            None,
        ),
        raw_case(
            "a missing include is skipped, not an error",
            &[("config.toml", "include = [\"nope.toml\"]\na = 1")],
            None,
        ),
        raw_case(
            "an include that does not parse is fatal",
            &[
                ("config.toml", "include = [\"bad.toml\"]"),
                ("bad.toml", "this is not toml"),
            ],
            None,
        ),
        raw_case(
            "a non-string include entry is skipped",
            &[("config.toml", "include = [42]\na = 1")],
            None,
        ),
        raw_case(
            "conf.d merges in sorted filename order and beats include",
            &[
                ("config.toml", "include = [\"inc.toml\"]\nv = 0"),
                ("inc.toml", "v = 1"),
                ("conf.d/20-b.toml", "v = 3"),
                ("conf.d/10-a.toml", "v = 2"),
            ],
            None,
        ),
        raw_case(
            "conf.d skips non-.toml, .TOML, and a bare .toml dotfile",
            &[
                ("config.toml", "v = 0"),
                ("conf.d/a.toml", "v = 1"),
                ("conf.d/b.txt", "skipped_txt = 1"),
                ("conf.d/c.TOML", "skipped_upper = 1"),
                ("conf.d/.toml", "skipped_dotfile = 1"),
                ("conf.d/notatoml", "skipped_no_dot = 1"),
                // Ends with "toml" but its extension is "xtoml": a suffix test
                // instead of an extension test would load this.
                ("conf.d/a.xtoml", "skipped_suffix_only = 1"),
                ("conf.d/d.b.toml", "w = 5"),
            ],
            None,
        ),
        raw_case(
            "conf.d order is by code point, and beats directory order",
            &[
                ("config.toml", "v = 0"),
                // Created z-first so an unsorted merge yields a different answer,
                // and spanning the BMP so a UTF-16 sort yields a third.
                ("conf.d/z.toml", "v = 1"),
                ("conf.d/a.toml", "v = 2"),
                ("conf.d/\u{1F3B5}.toml", "u = 1"),
                ("conf.d/\u{FB00}.toml", "u = 2"),
            ],
            None,
        ),
        raw_case(
            "conf.d that is a file, not a directory, is fatal",
            &[("config.toml", "v = 0"), ("conf.d", "not a directory")],
            None,
        ),
        raw_case(
            "a conf.d file that does not parse is fatal",
            &[("config.toml", "v = 0"), ("conf.d/bad.toml", "= nope")],
            None,
        ),
        raw_case(
            "conf.d deep-merges rather than replacing whole tables",
            &[
                ("config.toml", "[t]\na = 1\nb = 2"),
                ("conf.d/z.toml", "[t]\nb = 9\nc = 3"),
            ],
            None,
        ),
        raw_case(
            "an explicit config path re-homes the config dir to its parent",
            &[
                ("nested/other.toml", "include = [\"sib.toml\"]\na = 1"),
                ("nested/sib.toml", "b = 2"),
                ("nested/conf.d/x.toml", "c = 3"),
                ("conf.d/should-not-load.toml", "d = 4"),
            ],
            Some("nested/other.toml"),
        ),
        raw_case(
            "config.toml that does not parse is fatal",
            // NB: deliberately *not* an unterminated `[` header. Bun's TOML
            // parser accepts `[unclosed` as the table `[unclosed]`, so no
            // TypeScript on that parser can observe the Rust's rejection. The
            // divergence is recorded in a test instead; see the fixture header.
            &[("config.toml", "this is not toml")],
            None,
        ),
    ];

    let discoveries = vec![
        discovery_case(
            "workspace SOUL.md, legacy character.md, and a directory with neither",
            &[
                ("characters/aria/workspace/SOUL.md", "aria soul"),
                ("characters/legacy/character.md", "legacy soul"),
                ("characters/empty/notes.txt", "x"),
            ],
            &["characters/empty"],
            "aria",
        ),
        discovery_case(
            "names sort by code point, not UTF-16 order",
            &[
                ("characters/\u{1F3B5}drum/workspace/SOUL.md", "a"),
                ("characters/\u{FB00}ute/workspace/SOUL.md", "b"),
                ("characters/zed/workspace/SOUL.md", "c"),
            ],
            &[],
            "zed",
        ),
        discovery_case(
            "an empty SOUL.md is a definition and stops the legacy fallback",
            &[
                ("characters/hollow/workspace/SOUL.md", ""),
                ("characters/hollow/character.md", "legacy"),
            ],
            &[],
            "hollow",
        ),
        discovery_case(
            "the legacy user.md fallback, and a character prompt override",
            &[
                ("characters/u/workspace/SOUL.md", "s"),
                ("characters/u/user.md", "legacy user"),
                ("characters/u/prompts/compaction.md", "char prompt"),
                ("prompts/compaction.md", "global prompt"),
            ],
            &[],
            "u",
        ),
        discovery_case(
            "the global prompt is used when the character has none",
            &[
                ("characters/g/workspace/SOUL.md", "s"),
                ("characters/g/workspace/USER.md", "ws user"),
                ("prompts/compaction.md", "global prompt"),
            ],
            &[],
            "g",
        ),
        discovery_case(
            "an absent characters/ directory yields no names and no definitions",
            &[("unrelated.txt", "x")],
            &[],
            "nobody",
        ),
    ];

    let parent_of = vec![
        parent_case("/a/config.toml"),
        parent_case("config.toml"),
        parent_case("/config.toml"),
        parent_case("a/b/"),
        parent_case("/"),
        parent_case("a"),
        parent_case("./config.toml"),
    ];

    let char_configs = vec![
        char_config_case("no override file yields None", "[defaults]\nstream = true", None),
        char_config_case(
            "the overlay deep-merges over the global raw table",
            "[defaults]\nstream = true\n[behavior]\nuser_message_timestamps = \"always\"",
            Some("[defaults]\nstream = false"),
        ),
        char_config_case(
            "a table the overlay does not mention keeps every global key",
            "[tools]\nmax_result_chars = 100\nenabled_tools = [\"read\"]\n[memory]\n",
            Some("[tools]\nmax_result_chars = 200"),
        ),
        char_config_case(
            "an array in the overlay replaces rather than extends",
            "[tools]\nenabled_tools = [\"read\", \"write\"]",
            Some("[tools]\nenabled_tools = [\"read\"]"),
        ),
    ];

    let paths = vec![
        path_case("/base", "aria"),
        path_case("/base", ".."),
        path_case("/base", "a/b"),
        path_case("/base", "/etc"),
        path_case("/base", ""),
        path_case("/base", "\u{1F3B5}"),
        path_case("rel/base", "aria"),
        path_case("/base/", "aria"),
    ];

    // The passwd home the `dirs` crate falls back to when HOME is unset. It is
    // machine-specific, so the replay injects this value rather than reading its own.
    let passwd_home = with_env(&[], || ShoreDirs::resolve())
        .config
        .to_string_lossy()
        .strip_suffix("/.config/shore")
        .map(str::to_string)
        .unwrap_or_default();

    let header = json!([
        "Parity fixture for the config directory layout and the config-file loader.",
        "",
        "GENERATED from `main`, NOT from the 9023b46d worktree most of this series",
        "uses. `shore-common` compiles at HEAD, so this pins current behaviour rather",
        "than behaviour from the last green daemon commit — same provenance as",
        "models_parity.json. Do not copy a 9023b46d provenance onto this file.",
        "",
        "Driven against the real shore_common::config: ShoreDirs::resolve, the path",
        "helpers, deep_merge, load_raw_config_table, discover_characters,",
        "load_character_definition, resolve_user_definition and",
        "resolve_prompt_template. Ports to daemon/src/config/dirs.ts and",
        "src/config/loader.ts.",
        "",
        "The generator IS committed, at crates/common/tests/gen_dirs_fixture.rs —",
        "unlike the rest of this series, whose generators lived in throwaway",
        "worktrees. Development happens in ephemeral containers, so a generator left",
        "uncommitted is a generator destroyed, and #12 asks for reproducibility",
        "rather than for deletion.",
        "",
        "That does NOT make this file regenerable. It is FROZEN: nothing regenerates",
        "this file. A later diff against it is a defect in the TypeScript, not a",
        "fixture that needs updating. The generator is kept so the *derivation* can",
        "be audited and so new cases can be added deliberately — appending a case and",
        "re-running is a considered change to what is pinned, whereas re-running to",
        "make a red replay go green is the exact failure the freeze exists to stop.",
        "",
        "`passwd_home` is the getpwuid home directory of the account that ran the",
        "generator. It is recorded because the `dirs` crate falls back to it when",
        "HOME is unset, which makes the no-environment case machine-specific; the",
        "replay injects this value instead of reading its own.",
        "",
        "The `~/.config` literal fallback in resolve_xdg_dir is very nearly dead",
        "code and the fixture shows why: clearing the entire environment still",
        "resolves through getpwuid, so the config directory is <passwd_home>/.config",
        "and not a relative directory named `~`. Only an account with no passwd",
        "entry would reach the literal.",
        "",
        "The paths section pins that an absolute character name swallows the base:",
        "character_data_dir(\"/base\", \"/etc\") is \"/etc\", because PathBuf::push",
        "replaces on an absolute component where node:path's join concatenates. A",
        "name can arrive over the wire, so this one has security weight and the",
        "replay asserts it separately.",
    ]);

    let fixture = json!({
        "_header": header,
        "passwd_home": passwd_home,
        "shore_dirs": shore_dirs,
        "deep_merge": deep_merges,
        "raw_config": raw_configs,
        "discovery": discoveries,
        "parent_of": parent_of,
        "char_config": char_configs,
        "paths": paths,
    });

    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../daemon/tests/config_fixtures/dirs_parity.json");
    fs::create_dir_all(out.parent().expect("has parent")).expect("mkdir");
    fs::write(&out, format!("{}\n", serde_json::to_string_pretty(&fixture).expect("json")))
        .expect("write fixture");
    println!("wrote {}", out.display());
}
