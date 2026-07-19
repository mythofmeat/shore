# Agent Entry Map

## Start Here

- [README.md](README.md): product intent, quick start, repo layout.
- [ARCHITECTURE.md](ARCHITECTURE.md): runtime model, invariants, security,
  observability, and validation.
- [CONFIGURATION.md](CONFIGURATION.md): config reference.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): SWP wire protocol reference for
  client authors (transport, frames, commands, types).
- [CHANGELOG.md](CHANGELOG.md): release history.

When docs and code disagree, inspect the code for behavior and `README.md` for
purpose. Then update the relevant kept doc in the same change.

## Repo Shape

- `core/`: protocol, config, and shared SWP client crates.
- `backend/`: daemon, SWP server, LLM, ledger, and diagnostics crates.
- `clients/`: CLI, TUI, and Matrix bridge, all building against the workspace
  crates by path. The GUIs (`shore-gui`, `shore-gui-godot`) and debug MCP
  (`shore-mcp`) still live in their own repos, pinned to the last-published
  crates.io versions of the core libraries.
- `dev/`: deterministic test harness.

The daemon owns character state. Clients observe and send commands; they do not
fork authoritative state.

## Build And Test

```sh
python3 scripts/harness-check.py
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release -p shore-daemon -p shore-cli
```

Focused checks:

```sh
cargo test -p shore-daemon memory::deferred_edits
cargo test -p shore-daemon tools::workspace
cargo test -p shore-daemon engine::prompt
cargo test -p shore-daemon --test suite
```

Live/provider checks use real credentials and may cost money. Use them only when
provider behavior is in scope.

## Releasing

One version for the whole suite, set in `[workspace.package]` in the root
Cargo.toml (every crate inherits it). Nothing publishes to crates.io. To cut
a release:

1. Bump `version` in `[workspace.package]` and commit to main.
2. `git tag v<version> && git push origin v<version>`

The tag triggers `.github/workflows/package.yml`, which builds the four Arch
packages (daemon, cli, tui, matrix) sequentially and creates a GitHub release
with git-cliff notes.

## Documentation Policy

- Current behavior and product intent: update [README.md](README.md).
- Config changes: update [CONFIGURATION.md](CONFIGURATION.md).
- Runtime, architecture, invariants, security, observability, or validation
  changes: update [ARCHITECTURE.md](ARCHITECTURE.md).
- Patch-note worthy user changes: update [CHANGELOG.md](CHANGELOG.md).
- Runtime prompt changes under `backend/daemon/prompts/**` are code changes.

Run `python3 scripts/harness-check.py` before handing off changes that touch
docs, architecture, tool surfaces, memory, prompt assembly, or agent guidance.
