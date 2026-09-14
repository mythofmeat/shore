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

## Execution boundary

Bash runs with the daemon user's filesystem access, environment, and network
access. The working directory is not a sandbox, and Shore applies no command
allowlist or approval prompt. In Docker, the container and its mounts define
the boundary; on a host installation, commands run on that host. Credentials
and writable mounts available to the daemon are also available to commands.
