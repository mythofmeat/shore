# Working on Shore

## Update before starting work

Before investigating a bug or starting implementation, update all project toolchains and dependencies to their latest stable releases. This includes Bun, the Rust toolchain and Cargo tooling, and dependencies in both `daemon/` and `client/`. Include major-version updates; do not intentionally stay on older versions just to avoid compatibility work.

Dependency freshness is a project requirement. API SDKs move quickly, and upstream may already have fixed the problem or implemented the functionality we need. We want to discover compatibility problems with current releases early.

- Update dependencies before diagnosing the original problem: run `bun update --latest` and `bun install` in `daemon/`, and `cargo upgrade --incompatible` followed by `cargo update` in `client/`. Update toolchains and build tooling as well.
- Establish a tested baseline after updating, then reproduce the original problem again before writing a fix.
- Inspect the installed dependency's implementation and matching documentation before adding a workaround or duplicating upstream functionality.
- Keep toolchain/dependency changes separate from feature or bug-fix commits so regressions can be attributed clearly.
- If an update is blocked, report the specific blocker and which versions remain in use. Do not silently proceed as though the environment is current.

## Verify before committing

Run all tests relevant to the change before committing. Run the daemon suite for daemon changes, the Rust workspace suite for client changes, and both for changes spanning the protocol or shared behavior. For bug fixes, verify the original failure through the affected user flow; passing isolated helper tests is not enough.

Run the applicable verification commands before committing:

- In `daemon/`: `bun run lint`, `bun run lint:comments`, `bun run lint:citations`, `bun run typecheck`, `bun test`, `bun run mutate --stale`, `bun run rerecord:check`, and `bun run build`.
- In `client/`: `cargo test --workspace`, `cargo fmt --all --check`, and `cargo clippy --workspace --all-targets`.

Resolve failures before committing. Report any checks that could not run and why; do not describe unrun checks as passing. Verification is the agent's responsibility and must happen before the commit.
