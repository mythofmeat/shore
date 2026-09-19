use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use toml_edit::{DocumentMut, Item, Key, Table, Value};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
struct Edit {
    from: Option<Vec<String>>,
    to: Option<Vec<String>>,
    value: Option<Json>,
    #[serde(default)]
    merge: bool,
}

#[derive(Debug, Deserialize)]
struct Source {
    path: PathBuf,
    before: String,
    sha256: String,
    mode: u32,
    edits: Vec<Edit>,
    kind: String,
}

#[derive(Debug, Deserialize)]
struct Plan {
    version: u32,
    data_dir: PathBuf,
    files: Vec<Source>,
    manual: Vec<String>,
    notices: Vec<String>,
}

struct Helper {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Helper {
    fn start(executable: &Path) -> Result<Self> {
        let mut child = Command::new(executable)
            .arg("--config-migration-helper")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("cannot start local {}: {error}; install a matching shore-daemon or pass --daemon", executable.display()))?;
        let input = child.stdin.take().ok_or("migration helper has no stdin")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("migration helper has no stdout")?,
        );
        Ok(Self {
            child,
            input,
            output,
        })
    }

    fn request(&mut self, request: Json) -> Result<Json> {
        serde_json::to_writer(&mut self.input, &request)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        let mut line = String::new();
        if self.output.read_line(&mut line)? == 0 {
            return Err(
                "local daemon does not support the migration protocol; no files written".into(),
            );
        }
        let response: Json = serde_json::from_str(&line).map_err(
            |_| "invalid migration helper response; install matching client and daemon versions",
        )?;
        if response.get("version").and_then(Json::as_u64) != Some(u64::from(VERSION)) {
            return Err("client and daemon migration protocol versions differ".into());
        }
        if let Some(error) = response.get("error").and_then(Json::as_str) {
            return Err(error.to_owned().into());
        }
        response
            .get("ok")
            .cloned()
            .ok_or_else(|| "migration helper returned no result".into())
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ignored = self.child.kill();
        let _waited = self.child.wait();
    }
}

pub(crate) fn run(
    config: &Path,
    data_dir: Option<&Path>,
    write: bool,
    daemon: Option<&Path>,
) -> Result<()> {
    let executable = daemon.map(Path::to_path_buf).unwrap_or_else(default_daemon);
    let mut helper = Helper::start(&executable)?;
    let raw = helper.request(
        json!({ "version": VERSION, "action": "plan", "config": config, "data_dir": data_dir }),
    )?;
    let plan: Plan = serde_json::from_value(raw)?;
    if plan.version != VERSION {
        return Err("unsupported migration plan version".into());
    }
    cli_out!(
        "Local configuration migration (data: {})",
        plan.data_dir.display()
    );
    let mut candidates = BTreeMap::new();
    for source in &plan.files {
        if !source.edits.is_empty() {
            cli_out!("{}", source.path.display());
            for edit in &source.edits {
                let from = edit
                    .from
                    .as_ref()
                    .map_or_else(|| "(inherited)".to_owned(), |path| display_path(path));
                let to = edit
                    .to
                    .as_ref()
                    .map_or_else(|| "(removed)".to_owned(), |path| display_path(path));
                cli_out!("  {from} -> {to}");
            }
        }
    }
    for notice in &plan.notices {
        cli_out!("{notice}");
    }
    if !plan.manual.is_empty() {
        for action in &plan.manual {
            cli_err!("Manual action: {action}");
        }
        return Err("migration needs the listed manual actions; no files written".into());
    }
    for source in &plan.files {
        _ = candidates.insert(source.path.clone(), render(source)?);
    }
    _ = helper.request(json!({ "version": VERSION, "action": "validate", "files": candidates }))?;
    let changed = plan
        .files
        .iter()
        .filter(|source| candidates.get(&source.path) != Some(&source.before))
        .count();
    if changed == 0 {
        cli_out!("Already current; no changes.");
        return Ok(());
    }
    if !write {
        cli_out!(
            "Validated {changed} changed file(s). Values are omitted from this plan. Re-run with --write to apply."
        );
        return Ok(());
    }
    _ = helper.request(json!({ "version": VERSION, "action": "acquire" }))?;
    let result = transaction(&plan.files, &candidates);
    let release = helper.request(json!({ "version": VERSION, "action": "release" }));
    result?;
    _ = release?;
    cli_out!("Migrated {changed} file(s); protected backups retained beside each file.");
    Ok(())
}

fn default_daemon() -> PathBuf {
    if let Ok(executable) = std::env::current_exe()
        && let Some(parent) = executable.parent()
    {
        let sibling = parent.join("shore-daemon");
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from("shore-daemon")
}

fn display_path(path: &[String]) -> String {
    path.iter()
        .map(|part| {
            if part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            {
                part.clone()
            } else {
                format!("{part:?}")
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn descend<'item>(item: &'item mut Item, path: &[String], create: bool) -> Result<&'item mut Item> {
    let Some((head, tail)) = path.split_first() else {
        return Ok(item);
    };
    if create && item.is_none() {
        *item = Item::Table(Table::new());
    }
    let child = if item.is_array() || item.is_array_of_tables() {
        item.get_mut(head.parse::<usize>()?)
            .ok_or("array index missing from migration source")?
    } else {
        if !create && item.get(head).is_none() {
            return Err("key missing from migration source".into());
        }
        item.get_mut(head)
            .ok_or("migration path crosses a scalar")?
    };
    descend(child, tail, create)
}

fn take(item: &mut Item, path: &[String]) -> Result<(Key, Item)> {
    let (leaf, parent) = path.split_last().ok_or("empty migration path")?;
    let container = descend(item, parent, false)?;
    if container.is_array() {
        let slot = container
            .get_mut(leaf.parse::<usize>()?)
            .ok_or("array element missing")?;
        return Ok((Key::new(leaf), std::mem::take(slot)));
    }
    let table = container
        .as_table_like_mut()
        .ok_or("migration source is not a table")?;
    let key = table.key(leaf).cloned().ok_or("migration key missing")?;
    let value = table.remove(leaf).ok_or("migration value missing")?;
    Ok((key, value))
}

fn insert(
    item: &mut Item,
    path: &[String],
    old_key: Option<Key>,
    mut value: Item,
    merge: bool,
) -> Result<()> {
    let (leaf, parent) = path.split_last().ok_or("empty migration destination")?;
    let container = descend(item, parent, true)?;
    if container.is_array() {
        let slot = container
            .get_mut(leaf.parse::<usize>()?)
            .ok_or("array destination missing")?;
        *slot = value;
        return Ok(());
    }
    if container.is_none() {
        *container = Item::Table(Table::new());
    }
    let table = container
        .as_table_like_mut()
        .ok_or("migration destination is not a table")?;
    if merge && let Some(existing) = table.get_mut(leaf) {
        let incoming = value
            .as_table_like_mut()
            .ok_or("cannot merge non-table settings")?;
        let target = existing
            .as_table_like_mut()
            .ok_or("cannot merge settings into a scalar")?;
        let names = incoming
            .iter()
            .map(|(name, _)| name.to_owned())
            .collect::<Vec<_>>();
        for name in names {
            if target.contains_key(&name) {
                return Err("migration merge would overwrite a setting".into());
            }
            let key = incoming.key(&name).cloned().ok_or("merge key missing")?;
            let child = incoming.remove(&name).ok_or("merge value missing")?;
            _ = target.entry_format(&key).or_insert(child);
        }
        return Ok(());
    }
    if table.contains_key(leaf) {
        return Err("migration destination already exists".into());
    }
    let key = old_key.map_or_else(
        || Key::new(leaf),
        |old| {
            if old.get() == leaf {
                old
            } else {
                Key::new(leaf)
                    .with_leaf_decor(old.leaf_decor().clone())
                    .with_dotted_decor(old.dotted_decor().clone())
            }
        },
    );
    _ = table.entry_format(&key).or_insert(value);
    Ok(())
}

fn json_value(json: &Json) -> Result<Value> {
    match json {
        Json::String(text) => Ok(Value::from(text.as_str())),
        Json::Bool(value) => Ok(Value::from(*value)),
        Json::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Ok(Value::from(integer))
            } else if let Some(float) = number.as_f64() {
                Ok(Value::from(float))
            } else {
                Err("numeric migration value is outside TOML range".into())
            }
        }
        Json::Array(items) => {
            let mut array = toml_edit::Array::new();
            for child in items {
                array.push(json_value(child)?);
            }
            Ok(Value::Array(array))
        }
        Json::Object(fields) => {
            let mut table = toml_edit::InlineTable::new();
            for (key, child) in fields {
                _ = table.insert(key, json_value(child)?);
            }
            Ok(Value::InlineTable(table))
        }
        Json::Null => Err("null is not a TOML migration value".into()),
    }
}

fn render(source: &Source) -> Result<String> {
    if source.edits.is_empty() {
        return Ok(source.before.clone());
    }
    if source.kind == "threads" {
        return render_threads(source);
    }
    let mut document: DocumentMut = source.before.parse().map_err(|_| {
        format!(
            "{}: cannot parse TOML for migration; values omitted",
            source.path.display()
        )
    })?;
    for edit in &source.edits {
        let old = edit
            .from
            .as_ref()
            .map(|path| take(document.as_item_mut(), path))
            .transpose()?;
        let (mut key, previous) = old.map_or((None, Item::None), |(key, value)| (Some(key), value));
        let value = if let Some(replacement) = &edit.value {
            let mut next = json_value(replacement)?;
            if let Some(prior) = previous.as_value() {
                *next.decor_mut() = prior.decor().clone();
            } else {
                if let Some(ref mut moved_key) = key {
                    let mut comments = String::new();
                    collect_comments(&previous, &mut comments);
                    let prefix = moved_key
                        .leaf_decor()
                        .prefix()
                        .and_then(toml_edit::RawString::as_str)
                        .unwrap_or_default();
                    let combined = format!("{comments}{prefix}");
                    moved_key.leaf_decor_mut().set_prefix(combined);
                }
            }
            Item::Value(next)
        } else {
            previous
        };
        if let Some(path) = &edit.to {
            insert(document.as_item_mut(), path, key, value, edit.merge)?;
        } else {
            let mut comments = String::new();
            collect_comments(&value, &mut comments);
            if let Some(removed_key) = key {
                decor_comments(removed_key.leaf_decor(), &mut comments);
            }
            let trailing = document.trailing().as_str().unwrap_or_default();
            document.set_trailing(format!("{trailing}{comments}"));
        }
    }
    remove_empty_ancestors(&mut document, &source.edits)?;
    Ok(document.to_string())
}

fn render_threads(source: &Source) -> Result<String> {
    let mut value: Json =
        serde_json::from_str(&source.before).map_err(|_| "invalid threads index JSON")?;
    for edit in &source.edits {
        if edit.from != edit.to {
            return Err("thread migration can only replace model pins".into());
        }
        let path = edit.to.as_ref().ok_or("thread pin path missing")?;
        let mut node = &mut value;
        for segment in path {
            node = if node.is_array() {
                node.get_mut(segment.parse::<usize>()?)
            } else {
                node.get_mut(segment)
            }
            .ok_or("thread model pin missing")?;
        }
        *node = edit.value.clone().ok_or("thread model pin value missing")?;
    }
    Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
}

fn decor_comments(decor: &toml_edit::Decor, output: &mut String) {
    for raw in [decor.prefix(), decor.suffix()].into_iter().flatten() {
        if let Some(text) = raw.as_str()
            && text.contains('#')
        {
            output.push_str(text);
            if !text.ends_with('\n') {
                output.push('\n');
            }
        }
    }
}

fn collect_comments(item: &Item, output: &mut String) {
    if let Some(value) = item.as_value() {
        decor_comments(value.decor(), output);
    }
    if let Some(table) = item.as_table() {
        decor_comments(table.decor(), output);
    }
    if let Some(table) = item.as_table_like() {
        for (name, child) in table.iter() {
            if let Some(key) = table.key(name) {
                decor_comments(key.leaf_decor(), output);
            }
            collect_comments(child, output);
        }
    }
}

fn remove_empty_ancestors(document: &mut DocumentMut, edits: &[Edit]) -> Result<()> {
    let mut ancestors = BTreeMap::new();
    let mut retained = BTreeSet::new();
    for edit in edits {
        if let Some(destination) = &edit.to {
            let mut prefix = Vec::new();
            for segment in destination {
                prefix.push(segment.clone());
                _ = retained.insert(prefix.clone());
            }
        }
        if let Some(source) = &edit.from {
            let mut parent = source.clone();
            _ = parent.pop();
            while !parent.is_empty() {
                _ = ancestors.insert(parent.clone(), edit.to.clone());
                _ = parent.pop();
            }
        }
    }
    let mut ordered = ancestors.into_iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
    for (path, destination) in ordered {
        if retained.contains(&path) {
            continue;
        }
        let Ok(item) = descend(document.as_item_mut(), &path, false) else {
            continue;
        };
        let Some(table) = item.as_table() else {
            continue;
        };
        if !table.is_empty() {
            continue;
        }
        let prefix = table
            .decor()
            .prefix()
            .and_then(toml_edit::RawString::as_str)
            .unwrap_or_default();
        let suffix = table
            .decor()
            .suffix()
            .and_then(toml_edit::RawString::as_str)
            .unwrap_or_default();
        let comments = format!("{prefix}{suffix}\n");
        _ = take(document.as_item_mut(), &path)?;
        if !comments.contains('#') {
            continue;
        }
        let mut target_path = destination.unwrap_or_default();
        _ = target_path.pop();
        if let Ok(target) = descend(document.as_item_mut(), &target_path, false)
            && let Some(target_table) = target.as_table_mut()
        {
            let existing = target_table
                .decor()
                .prefix()
                .and_then(toml_edit::RawString::as_str)
                .unwrap_or_default();
            let combined = format!("{comments}{existing}");
            target_table.decor_mut().set_prefix(combined);
        } else {
            let trailing = document.trailing().as_str().unwrap_or_default();
            document.set_trailing(format!("{trailing}{comments}"));
        }
    }
    Ok(())
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn verify_source(source: &Source) -> Result<fs::Permissions> {
    let metadata = fs::symlink_metadata(&source.path)?;
    if !metadata.is_file() || fs::canonicalize(&source.path)? != source.path {
        return Err(format!(
            "{} is no longer a regular, direct file",
            source.path.display()
        )
        .into());
    }
    if digest(&fs::read_to_string(&source.path)?) != source.sha256 {
        return Err(format!(
            "{} changed since planning; no further files written",
            source.path.display()
        )
        .into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != source.mode {
            return Err("source permissions changed since planning".into());
        }
    }
    Ok(metadata.permissions())
}

#[derive(Serialize)]
struct RecoveryFile {
    path: PathBuf,
    backup: PathBuf,
}

struct Prepared<'source> {
    source: &'source Source,
    temporary: NamedTempFile,
    backup: PathBuf,
}

fn transaction(sources: &[Source], candidates: &BTreeMap<PathBuf, String>) -> Result<()> {
    transaction_with(sources, candidates, |_| Ok(()))
}

fn transaction_with(
    sources: &[Source],
    candidates: &BTreeMap<PathBuf, String>,
    mut before_write: impl FnMut(&Path) -> Result<()>,
) -> Result<()> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let mut prepared = Vec::new();
    for source in sources {
        let contents = candidates
            .get(&source.path)
            .ok_or("missing validated candidate")?;
        let permissions = verify_source(source)?;
        if contents == &source.before {
            continue;
        }
        let parent = source
            .path
            .parent()
            .ok_or("source has no parent directory")?;
        let name = source
            .path
            .file_name()
            .ok_or("source has no filename")?
            .to_string_lossy();
        let backup = parent.join(format!("{name}.shore-migrate-{nonce}.bak"));
        let mut backup_file = protected_create(&backup)?;
        backup_file.set_permissions(permissions.clone())?;
        backup_file.write_all(source.before.as_bytes())?;
        backup_file.sync_all()?;
        let mut temporary = NamedTempFile::new_in(parent)?;
        temporary.as_file().set_permissions(permissions)?;
        temporary.write_all(contents.as_bytes())?;
        temporary.as_file().sync_all()?;
        sync_parent(&source.path)?;
        prepared.push(Prepared {
            source,
            temporary,
            backup,
        });
    }
    let Some(first) = prepared.first() else {
        return Ok(());
    };
    let journal = first
        .source
        .path
        .with_file_name(format!(".shore-config-migration-{nonce}.json"));
    let recovery = prepared
        .iter()
        .map(|entry| RecoveryFile {
            path: entry.source.path.clone(),
            backup: entry.backup.clone(),
        })
        .collect::<Vec<_>>();
    let mut journal_file = protected_create(&journal)?;
    serde_json::to_writer_pretty(&mut journal_file, &recovery)?;
    journal_file.sync_all()?;
    sync_parent(&journal)?;
    let mut written: Vec<&Source> = Vec::new();
    let result: Result<()> = (|| {
        for source in sources {
            _ = verify_source(source)?;
        }
        for entry in prepared {
            before_write(&entry.source.path)?;
            _ = verify_source(entry.source)?;
            _ = entry.temporary.persist(&entry.source.path)?;
            written.push(entry.source);
            sync_parent(&entry.source.path)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for source in written.into_iter().rev() {
            let rollback: Result<()> = (|| {
                if fs::read_to_string(&source.path).ok().as_ref() != candidates.get(&source.path) {
                    return Err("file changed again; preserving it for manual recovery".into());
                }
                let parent = source.path.parent().ok_or("no rollback directory")?;
                let mut temporary = NamedTempFile::new_in(parent)?;
                temporary
                    .as_file()
                    .set_permissions(fs::metadata(&source.path)?.permissions())?;
                temporary.write_all(source.before.as_bytes())?;
                temporary.as_file().sync_all()?;
                _ = temporary.persist(&source.path)?;
                sync_parent(&source.path)
            })();
            if let Err(failure) = rollback {
                failures.push(format!("{}: {failure}", source.path.display()));
            }
        }
        if !failures.is_empty() {
            return Err(format!(
                "{error}; rollback incomplete: {}; recovery journal: {}",
                failures.join("; "),
                journal.display()
            )
            .into());
        }
        fs::remove_file(&journal)?;
        return Err(format!("{error}; changes rolled back; backups retained").into());
    }
    fs::remove_file(&journal)?;
    sync_parent(&journal)?;
    Ok(())
}

fn protected_create(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    _ = options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        _ = options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    Ok(options.open(path)?)
}

fn sync_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(path: PathBuf, before: &str, edits: Json) -> Source {
        Source {
            path,
            before: before.to_owned(),
            sha256: digest(before),
            mode: 0o600,
            edits: serde_json::from_value(edits).expect("edits"),
            kind: "config".to_owned(),
        }
    }

    #[test]
    fn writer_preserves_comments_quoted_keys_multiline_and_array_tables() {
        let before = concat!(
            "# model choices\n[defaults]\nmodel = 'vendor:family.v2' # active\n",
            "[tools.config.bash]\ntimeout = '5m' # long jobs\n",
            "[chat.\"vendor:family.v2\"]\nbudget_tokens = 400 # reasoning\n",
            "[subagents.research]\ndescription = 'Research'\nprompt = '''first\nsecond'''\n",
            "[[usage.budgets]]\nname = 'daily'\nwarn_at = [0.5, 0.9] # early warnings\n",
            "[[usage.budgets]]\nname = 'weekly'\nwarn_at = [0.8]\n",
        );
        let file = source(
            PathBuf::from("/unused/config.toml"),
            before,
            json!([
                {"from":["defaults","model"],"to":["chat","model"]},
                {"from":["tools","config","bash"],"to":["tools","bash"]},
                {"from":["chat","vendor:family.v2","budget_tokens"],"to":["chat","vendor:family.v2","reasoning_budget_tokens"]},
                {"from":["usage","budgets"],"to":["budgets"]},
                {"from":["budgets","0","warn_at"],"to":["budgets","0","warn_fractions"]},
                {"from":["budgets","1","warn_at"],"to":["budgets","1","warn_fractions"]}
            ]),
        );
        let written = render(&file).expect("render");
        let parsed: DocumentMut = written.parse().expect("valid TOML");
        assert_eq!(
            parsed
                .get("chat")
                .expect("field")
                .get("model")
                .expect("field")
                .as_str(),
            Some("vendor:family.v2")
        );
        assert_eq!(
            parsed
                .get("chat")
                .expect("field")
                .get("vendor:family.v2")
                .expect("field")
                .get("reasoning_budget_tokens")
                .expect("field")
                .as_integer(),
            Some(400)
        );
        assert_eq!(
            parsed
                .get("budgets")
                .expect("field")
                .get(1)
                .expect("budget")
                .get("name")
                .expect("field")
                .as_str(),
            Some("weekly")
        );
        assert!(!written.contains("[defaults]"));
        for retained in [
            "# model choices",
            "# active",
            "# long jobs",
            "# reasoning",
            "# early warnings",
            "'''first\nsecond'''",
        ] {
            assert!(written.contains(retained), "missing {retained}: {written}");
        }
    }

    #[test]
    fn writer_handles_inline_and_dotted_keys_without_losing_neighbor_values() {
        let file = source(
            PathBuf::from("/unused/config.toml"),
            "tools.config.bash = { timeout = '5m', max_result_chars = 500 } # keep\n[notifications.events]\n# messages\nmessage_complete = true\nerror = false # quiet\n",
            json!([
                {"from":["tools","config","bash"],"to":["tools","bash"]},
                {"from":["notifications","events"],"to":["notifications","events"],"value":["message_complete"]}
            ]),
        );
        let written = render(&file).expect("render");
        let parsed: DocumentMut = written.parse().expect("valid TOML");
        assert_eq!(
            parsed
                .get("tools")
                .expect("field")
                .get("bash")
                .expect("field")
                .get("max_result_chars")
                .expect("field")
                .as_integer(),
            Some(500)
        );
        assert_eq!(
            parsed
                .get("notifications")
                .expect("field")
                .get("events")
                .expect("field")
                .get(0)
                .expect("event")
                .as_str(),
            Some("message_complete")
        );
        for comment in ["# messages", "# quiet", "# keep"] {
            assert!(written.contains(comment), "{written}");
        }
    }

    #[cfg(unix)]
    fn files() -> (tempfile::TempDir, Vec<Source>, BTreeMap<PathBuf, String>) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        let sources = ["one.toml", "two.toml"]
            .map(|name| {
                let path = dir.path().canonicalize().expect("path").join(name);
                fs::write(&path, "[defaults]\nmodel = 'p:m'\n").expect("write");
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("mode");
                source(path, "[defaults]\nmodel = 'p:m'\n", json!([]))
            })
            .into_iter()
            .collect::<Vec<_>>();
        let candidates = sources
            .iter()
            .map(|file| (file.path.clone(), "[chat]\nmodel = 'p:m'\n".to_owned()))
            .collect();
        (dir, sources, candidates)
    }

    #[test]
    #[cfg(unix)]
    fn transaction_preserves_permissions_and_keeps_exact_backups() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, sources, candidates) = files();
        transaction(&sources, &candidates).expect("transaction");
        for file in &sources {
            assert_eq!(
                fs::read_to_string(&file.path).expect("read"),
                *candidates.get(&file.path).expect("candidate")
            );
            assert_eq!(
                fs::metadata(&file.path)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let backups: Vec<_> = fs::read_dir(dir.path())
            .expect("entries")
            .map(|entry| entry.expect("entry").path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "bak"))
            .collect();
        assert_eq!(backups.len(), 2);
        for path in backups {
            assert_eq!(
                fs::read_to_string(&path).expect("backup"),
                sources.first().expect("first source").before
            );
            assert_eq!(
                fs::metadata(path).expect("metadata").permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn failed_second_write_rolls_back_first_file() {
        let (_dir, sources, candidates) = files();
        let result = transaction_with(&sources, &candidates, |path| {
            if path == sources.get(1).expect("second source").path {
                return Err("injected write failure".into());
            }
            Ok(())
        });
        assert!(
            result
                .expect_err("failure")
                .to_string()
                .contains("changes rolled back")
        );
        for file in sources {
            assert_eq!(fs::read_to_string(file.path).expect("read"), file.before);
        }
    }

    #[test]
    #[cfg(unix)]
    fn concurrent_edit_is_preserved_and_prior_write_is_rolled_back() {
        let (_dir, sources, candidates) = files();
        let result = transaction_with(&sources, &candidates, |path| {
            if path == sources.get(1).expect("second source").path {
                fs::write(path, "changed = true\n")?;
            }
            Ok(())
        });
        assert!(
            result
                .expect_err("failure")
                .to_string()
                .contains("changed since planning")
        );
        assert_eq!(
            fs::read_to_string(&sources.first().expect("first source").path).expect("first"),
            sources.first().expect("first source").before
        );
        assert_eq!(
            fs::read_to_string(&sources.get(1).expect("second source").path).expect("second"),
            "changed = true\n"
        );
    }

    #[test]
    #[cfg(unix)]
    fn refuses_changed_permissions_and_symlink_sources() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let (_dir, sources, candidates) = files();
        fs::set_permissions(
            &sources.first().expect("first source").path,
            fs::Permissions::from_mode(0o644),
        )
        .expect("permissions");
        assert!(transaction(&sources, &candidates).is_err());
        fs::remove_file(&sources.first().expect("first source").path).expect("remove");
        symlink(
            &sources.get(1).expect("second source").path,
            &sources.first().expect("first source").path,
        )
        .expect("symlink");
        assert!(transaction(&sources, &candidates).is_err());
        assert_eq!(
            fs::read_to_string(&sources.get(1).expect("second source").path).expect("unchanged"),
            sources.get(1).expect("second source").before
        );
    }
}
