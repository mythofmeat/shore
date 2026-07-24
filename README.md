# Shore

Shore is a persistent AI character engine built in Rust. A long-running daemon
owns character state, conversation history, memory, autonomy, tools, cache
accounting, and client connections. Clients are views and command senders; they
do not fork authoritative state.

The intent is personal and specific: make an AI character chat program that
keeps the SillyTavern-style repairable conversation workflow, but improves the
parts that hurt with long-lived character continuity, inspectable markdown
memory, Anthropic cache discipline, useful tools, and private autonomous time.

## What Matters

- **One daemon, many clients.** CLI, TUI, GUI, MCP, and Matrix all talk to the
  same daemon state.
- **Repairable replies.** Regenerating an assistant response is non-destructive:
  old and new responses are kept as selectable alternates.
- **Archive-visible history.** When older conversation is compacted (folded
  into memory to keep the prompt bounded), it remains visible in bounded
  CLI/TUI scrollback pages, with a boundary showing what is outside active
  context.
- **Markdown memory.** Long-term memory lives under each character's
  `workspace/memory/` as ordinary git-diffable files. The workspace is a real
  git repository: compaction and dreaming passes commit their memory changes
  in small chunks, with the reasoning and sources in the commit messages.
- **Cache-safe prompt edits.** Character self-edits to prompt-visible files are
  staged and only activate at compaction/reload boundaries.
- **Heartbeat autonomy.** Characters can use private heartbeat ticks to reflect,
  maintain memory, use tools, schedule the next wake, and optionally message the
  user.
- **Tool-rich conversations.** Characters can inspect and edit workspace files,
  search workspace/history, use web/image/time/activity tools, and run narrow
  workspace commands.
- **MCP tools.** Characters can use external Model Context Protocol servers
  (declared in `[mcp]`), directly or behind a sub-agent. See CONFIGURATION.md.
- **Budget awareness.** Usage and cost are recorded in SQLite with model,
  call-kind, and configured API-key breakdowns; configurable hourly, daily,
  weekly, and monthly budgets can warn, block, or pause background work. A
  budget can also pace itself — a `$14`/week budget shows what today's share is
  and re-divides what's left after every cheap or expensive day.

## Quick Start

Prerequisites: a Rust toolchain and [Bun](https://bun.sh) (the LLM transport
sidecar is a TypeScript process).

**1. Build the binaries:**

```sh
cargo build --release -p shore-daemon -p shore-cli
(cd backend/llm-sidecar && bun install --frozen-lockfile && bun run build)
cp backend/llm-sidecar/dist/shore-llm-sidecar target/release/
```

The daemon looks for `shore-llm-sidecar` next to its own binary or on `$PATH`
— that is what the `cp` is for. Packaged installs instead keep it (and
`shore-matrix`) off `$PATH` and point `SHORE_LLM_SIDECAR_BIN` /
`SHORE_MATRIX_BIN` at them; see
[CONFIGURATION.md](CONFIGURATION.md#helper-binaries).

**2. Configure a provider** in `~/.config/shore/config.toml`:

```toml
[defaults]
model = "anthropic:claude-sonnet-4-6"   # provider:model_id

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[providers.anthropic.defaults]
cache_ttl = "1h"
```

The named environment variable (here `ANTHROPIC_API_KEY`) must be set in the
daemon's environment.

**3. Create a character.** Only `workspace/SOUL.md` is required:

```text
~/.config/shore/characters/Alice/
  workspace/
    SOUL.md       # character identity — the only required file
```

Minimal `SOUL.md`:

```markdown
Alice is a warm, curious companion who loves literature and long conversations.
She remembers the user across time and keeps her own notes carefully.
```

The rest of the workspace is optional and fills in over time, partly by the
character's own hand:

```text
  avatar.png    # Matrix profile / desktop notification avatar
  workspace/
    USER.md       # what this character knows about the user
    AGENTS.md     # standing operating guidance (built-in default otherwise)
    TOOLS.md      # tool-use guidance
    MEMORY.md     # active memory: dated, pruned, prompt-visible
    memory/       # markdown long-term memory
```

Legacy `character.md`, `user.md`, and `prompts/system.md` character layouts are
migrated into the workspace on first load.

**4. Start the daemon and talk:**

```sh
target/release/shore-daemon &
target/release/shore send "Hello!"
```

From here: `shore log -f` follows the conversation live, `shore regen`
re-rolls the last reply, `shore status` shows session and budget state, and
`shore --help` lists the rest. For an interactive chat UI, use `shore-tui` or
`shore-gui` (see [Repo Layout](#repo-layout)).

## Desktop Notifications

To receive desktop notifications for autonomous character messages, run the
listener in your user session:

```sh
target/release/shore notify
```

Packaged installs can enable the user service:

```sh
systemctl --user enable --now shore-notify.service
```

The service does not start or require a local daemon. For a remote daemon, put
`SHORE_ADDR=host:7320` in `~/.config/shore/notify.env` or set
`default_address = "host:7320"` in `~/.config/shore/client.toml`.
The daemon includes avatar image data in character metadata, so notification
icons still work when the daemon's config directory is on another machine.

Use `shore notify --all-messages` to notify for normal assistant replies too.

## Personal Install (portable app dir)

`scripts/install.sh` builds every binary from the checkout and installs the
whole suite into one self-contained, backup-friendly directory (default
`~/shore`): binaries in `bin/`, all state in `config/` + `data/`, systemd user
units and PATH wrappers pointing in via `SHORE_*_DIR`. Rerun it after
`git pull` to update. `--adopt` copies an existing XDG-dirs deployment into
the app dir (daemon must be stopped; originals are kept). Back up `config/` +
`data/` — `bin/` and `cache/` are derivable. See the script header for
details and overrides.

## Repo Layout

| Path | Contents |
| --- | --- |
| `core/` | shared protocol, config, and SWP client crates |
| `backend/` | daemon runtime plus backend support crates |
| `clients/` | CLI, TUI, and Matrix bridge clients |
| `dev/` | deterministic test harness |

Main binaries built here:

| Binary | Purpose |
| --- | --- |
| `shore-daemon` | persistent daemon |
| `shore` | CLI client |
| `shore-llm-sidecar` | supervised TypeScript LLM wire process |

Out-of-tree clients and bridges (separate repos, pinned to the last-published
crates.io versions of the core libraries — this workspace no longer publishes
to crates.io):

- `shore-gui` (Tauri desktop) — [mythofmeat/shore-gui](https://github.com/mythofmeat/shore-gui)
- `shore-gui-godot` (Godot client) — [mythofmeat/shore-gui-godot](https://github.com/mythofmeat/shore-gui-godot)
- `shore-mcp` (debug/development MCP) — [mythofmeat/shore-mcp](https://github.com/mythofmeat/shore-mcp)

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — runtime model, invariants, security,
  observability, and validation guidance.
- [CONFIGURATION.md](CONFIGURATION.md) — config reference and examples.
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — SWP wire protocol reference for
  client authors.
- [CLAUDE.md](CLAUDE.md) — short entry map for coding agents.
- [CHANGELOG.md](CHANGELOG.md) — release history.

Markdown under `backend/daemon/prompts/**` is runtime prompt text, not ordinary
documentation. Treat prompt changes like code changes.

## Build And Test

```sh
python3 scripts/harness-check.py
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
(cd backend/llm-sidecar && bun install --frozen-lockfile && bun run typecheck && bun test && bun run build)
cargo build --release -p shore-daemon -p shore-cli
```

Coverage visibility in CI is produced with:

```sh
cargo llvm-cov --workspace --all-targets --lcov --output-path lcov.info
```

Focused checks:

```sh
cargo test -p shore-daemon memory::deferred_edits
cargo test -p shore-daemon tools::workspace
cargo test -p shore-daemon engine::prompt
cargo test -p shore-daemon --test suite
```

Live provider checks use real credentials and may cost money. Use them only when
provider behavior, streaming, tool use, or cache economics are in scope.

## License

Private — all rights reserved.
