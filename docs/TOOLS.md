# Bash and built-in tools

`bash` is Shore's general command-line tool. It replaces `read`, `edit`,
`delete`, `git`, `fetch_url`, and `roll_dice`. The daemon image includes Bash,
coreutils, curl, find, Git, jq, Python 3, ripgrep, and sed.

Enable it in your configuration, retaining any other tools you use:

```toml
[tools]
enabled_tools = ["bash", "search", "search_chat_logs", "web_search"]

[tools.config.bash]
timeout = "5m"
max_result_chars = 50000
```

Replace the retired names in subagents' `tools` lists and in per-tool timeout
and output overrides as well. Existing grants such as `read` do not implicitly
grant shell access. A wildcard grant (`"*"`) includes Bash. Tools remain disabled
by default until configured.

Try the same execution path a model uses:

```sh
shore debug tool bash --describe
shore debug tool bash 'command=printf "hello\n" > note.txt; cat note.txt'
shore debug tool bash 'command=git status --short'
```

The input is `command` plus an optional `workdir`, relative to the character's
workspace or absolute. Each invocation uses a fresh non-interactive Bash shell
with `pipefail`; it starts in the character's workspace and does not load shell
profiles or `BASH_ENV`. Files persist, but shell variables and `cd` do not carry
between calls. Stdin is closed; scripts can use heredocs and pipelines. Commands
should run in the foreground. `SHORE_WORKSPACE_DIR` points to the character's
workspace, and Git author/committer variables use the character's identity.

Results include exit status, stdout, and stderr. A nonzero exit or signal is
reported as a tool error. Shore drains both streams while retaining at most
1 MiB of each, then applies the configured result window. Redirect large output
to a file and inspect it in parts. The configured timeout and turn cancellation
terminate the process group, escalating to SIGKILL if needed. File changes made
before failure or cancellation remain in place.

Edits or deletions of prompt files (`SOUL.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`,
and `MEMORY.md`) queue a prompt reload. During compaction, Shore snapshots
workspace files, directories, and symlinks, excluding `.git`, around each Bash
call. Changes are included in recovery checkpoints and restored if archiving
fails, including writes made by a command that exits unsuccessfully. External
side effects and Git history are not rolled back. Dry-run compaction blocks
Bash commands.

`search` remains for semantic workspace retrieval; use `rg` or `grep` for normal
text search. `search_chat_logs`, `model_history`, and `activity_heatmap` retain
their access to Shore's stored history. `web_search` and `generate_image` retain
their configured providers. MCP tools, subagents, and heartbeat controls remain
available as configured.

## Targeted file edits

`shore-patch` is a bundled command available through Bash, including when the
daemon runs from source or as a compiled executable. The Docker image also
installs it in `/usr/local/bin`. It requires Bash and Git on the daemon host;
the daemon provides its own command directory on `PATH`.

Read the file, then submit a standard unified diff in a quoted heredoc:

```sh
shore-patch <<'PATCH'
diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1,3 +1,3 @@
 before
-old wording
+new wording
 after
PATCH
```

Paths are relative to the Bash call's working directory, even inside a Git
repository. Start each file with a `diff --git a/path b/path` header, including
in multi-file patches. Use `a/` and `b/` prefixes, with `/dev/null` as the old path for
new files or the new path for deletions. Add a `new file mode 100644` or
`deleted file mode 100644` line after the `diff --git` header for these operations
(`100755` for executables). Include unchanged context around edits.
This is unified diff syntax, not the `*** Begin Patch` format. Run
`shore-patch --help` for usage, or `shore-patch --check` with the same input to
validate without changing files.

The command uses Git's existing `apply` engine with recalculated hunk line
counts and whitespace-preserving edits. If any hunk fails validation, the whole
patch is rejected without changing files. This is not a transaction against
disk errors or process interruption; inspect files after an interrupted write.
Git preserves the executable bit but recreates files using the current umask;
reapply any special permissions or other filesystem metadata after patching.
The command does not require a Git repository and does not stage, commit, or
push. It only accepts `--check` and `--help`; partial-application and index
options are not exposed. Successful edits follow Bash's normal prompt reload
and compaction recovery behavior.

## Prompts and Git syncing

Update personal workspace `TOOLS.md` files and subagent prompts alongside their
tool grants. File reads now use Bash commands such as `cat` or `sed`; exact text
search uses `rg`, Git commands go through Bash, and URL fetching uses `curl`.
Curl returns the response body, often HTML, without rendering JavaScript or
extracting an article. Keep semantic and conversation retrieval on `search`
and `search_chat_logs`.

New workspaces receive the guidance in
[`default_tools.md`](../daemon/prompts/engine/default_tools.md). Existing personal
files are preserved. Custom compaction templates in
`characters/<name>/prompts/compact_rules.md` and `compact.md`, or the global
`prompts/` directory, override the bundled defaults and also need updating.

Compaction appends one user message after the conversation: the rendered
`compact.md` task followed by the rendered `compact_rules.md` rules as separate
text blocks. Both templates support `{{char}}` and `{{user}}`. These are user-turn
instructions; the character's top-level system prompt stays in place. The rules
block is excluded from explicit cache breakpoint placement using the message's
`transient_tail` count of trailing blocks, independently of its role.

The legacy filename `compact_system.md` is still accepted for custom overrides
with the same user-turn semantics. Within each directory, `compact_rules.md`
takes precedence over the legacy name, including an empty override. Character
overrides take precedence over global overrides under either name. Rename custom
`compact_system.md` files to `compact_rules.md` when convenient.

The compaction model is responsible for saving its edits and making a local
commit. After a successful memory-writing pass, `[memory] git_push = true`
makes the daemon run `git push` in that workspace, using Git's configured push
destination and the daemon's credentials. It does not create the commit, set up
a remote, or retry a failed push in the background. Currently push errors are
swallowed, so a compaction success notification does not confirm remote sync.
An archive-only rotation does not trigger a push.

Compaction prompts should leave pushing to this post-pass step so unfinished
memory work is not published mid-pass. Prompt instructions to preserve history
are behavioral guidance. Protect branches on the receiving Git server to
enforce restrictions on force pushes; local shell commands cannot provide that
boundary while the repository is writable.

## Execution boundary

Bash runs with the daemon user's filesystem access, environment, and network
access. The working directory is not a sandbox, and Shore applies no command
allowlist or approval prompt. In Docker, the container and its mounts define
the boundary; on a host installation, commands run on that host. Credentials
and writable mounts available to the daemon are also available to commands.
