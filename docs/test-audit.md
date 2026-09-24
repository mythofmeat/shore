# Test suite audit

The first CI runs on #240 failed three different ways across three runs, all on
tests that pass on a developer machine. This audit asks why, and what the tests
are for. It covers every Rust test in `client/` (1,186 of them) and the fragile
patterns in the daemon's bun suite (~4,150 tests). It does not judge each
daemon test's value individually; that is follow-up work.

## What a test here has to be

1. **Hermetic.** A test reads only what it was given. No developer config, no
   token files, no environment left behind by another test.
2. **Order- and parallelism-independent.** `cargo test` runs tests on parallel
   threads in one process; `bun test` runs files in one process. Any
   process-wide state a test writes is visible to the others.
3. **Not timed by the wall clock.** "Finished within 250 ms" or "still pending
   after 20 ms" tests the machine as much as the code. Time is a dependency to
   inject or pause.
4. **About behaviour that matters.** A test should protect a wire/protocol
   contract, user-visible output, or a bug that actually happened. Tests that
   pin an intermediate data shape, or check a library does what it documents,
   cost upkeep without catching real breakage.

The TUI scenario tests in `tui/ui.rs` and `tui/mod.rs` already follow this
well: they drive the app through `Harness` and assert on what the user sees.
They are the model for the rest.

## Findings

Ranked by how much CI pain they cause. Each has evidence and a recommendation.

### 1. Hidden ambient inputs: the connection tests depend on your token

**Confirmed cause of the `conn_manager::lifecycle_tests` CI failures.**

`SWPConnection::handshake` (`shore-common/src/swp_client/connection.rs`)
resolves the client token from `SHORE_TOKEN` or the real config directory
*before* reading the server hello. With no token it fails at once with
`Unauthorized`, so:

- On a developer machine there is a real token file, so the tests pass.
- On CI there is none, so they pass only if another test has already called
  `set_env(SHORE_TOKEN, ...)` in the same process. The handshake tests in
  `swp_client/mod.rs` do (through `with_token()`), and so does
  `an_open_socket_without_a_hello_reaches_the_handshake_deadline`. None of them
  unset it. Whether the lifecycle tests pass depends on scheduling.

Reproduced deterministically: with `SHORE_TOKEN` unset and an empty config
directory, `cargo test -p shore-common lifecycle_tests` fails the same two
tests every time.

Related:

- `shore-common/src/test_env.rs` justifies `unsafe { set_var }` with
  "tests touching env run single-threaded". They don't; this is a data race
  with any concurrent `getenv`.
- `an_open_socket_without_a_hello_reaches_the_handshake_deadline` waits out the
  real 10 s handshake deadline on every run.
- The TUI reads and writes real paths through `dirs::config_dir()`
  (`keymap.save()`, `tui_prefs.json`). No test reaches those writes today, but
  nothing prevents one from overwriting a developer's `tui.toml`.

**Recommendation.** Pass the token (and config/data dirs) into the connection
and the app, instead of resolving them from the environment deep inside. Tests
then pass an explicit token. Delete `test_env.rs`. Make the handshake deadline
a parameter so the deadline test runs with a short, virtual one.

### 2. A process-global colour flag

**Confirmed cause of the `vocab::a_marked_row_paints_its_name_the_way_the_mark_does`
CI failure** (reproduced locally 1 in 20 on two cores).

`output::use_color()` reads a static `AtomicBool` that defaults to *on*.
69 tests call `set_color_enabled`; 6 hold `COLOR_TEST_LOCK`. Every test that
renders output is exposed, including those that never touch the flag, because
another thread can flip it mid-render. `output/styling.rs` has the same shape
with `CHUNK_STATE`, a global `Mutex`, and `DECORATE_STDOUT` is a third flag.

| file | tests toggling colour | holding the lock |
|---|---|---|
| `output/transcript.rs` | 20 | 3 |
| `output/commands.rs` | 17 | 0 |
| `output/styling.rs` | 9 | 0 |
| `output/status.rs` | 7 | 0 |
| `output/catalog.rs` | 6 | 0 |
| `output/mod.rs` | 5 | 0 |
| `output/config.rs` | 3 | 0 |
| `output/vocab.rs` | 2 | 2 |

**Recommendation.** Don't add the lock to 63 more tests. Make colour,
decoration and chunk state values the renderer is given (a small `Style` or
render context built once from `detect_color()` in `main`), and have tests
build their own. Then `COLOR_TEST_LOCK` and `set_color_enabled` can be deleted.

### 3. Wall-clock assertions

| test | what it asserts |
|---|---|
| `conn_manager::blocked_io_tests::shutdown_interrupts_a_full_event_queue` | not done after 20 ms, done within 250 ms |
| `conn_manager::blocked_io_tests::shutdown_interrupts_a_write_to_a_peer_that_is_not_reading` | same |
| `conn_manager::lifecycle_tests::*` (3) | an event within 250 ms / 1 s over a real TCP socket |
| `conn_manager::rejecting_an_extra_command_keeps_the_original_socket_and_response` | events within 1 s |
| `conn_manager::revision_gap_notifies_the_ui_before_reconnecting` | session ends within 1 s |
| `tui::full_command_queue_does_not_block_input_or_leave_pending_navigation` | done within 100 ms |
| `connection::deadline_tests::an_open_socket_without_a_hello_reaches_the_handshake_deadline` | real 10 s wait, 12 s cap |

Daemon side: 66 `sleep`/`setTimeout` uses across 28 test files, and only 2
files that use fake timers. The worst is `tests/daemon_hot_reload.test.ts`: it writes
files 80 ms apart against a 150 ms debounce, then sleeps 150–300 ms and asserts
exactly one reload. On a loaded runner, a late filesystem event splits that
into two reloads. `daemon_run`, `runtime`, `matrix_supervise` and
`daemon_auto_discovery` use the same pattern.

**Recommendation.** For "still blocked" use `tokio_test`'s `assert_pending!` or
a single poll rather than a 20 ms timeout. For "eventually finishes" use
`#[tokio::test(start_paused = true)]`, so timeouts are virtual and only a real
hang fails. Test the debounce logic with an injected clock, and keep one
real-watcher smoke test with a generous deadline. Swap real sockets for
`tokio::io::duplex` where the socket isn't the thing under test; most of these
tests already use it.

### 4. Unit tests that start another runtime

- `tui/tool_image_tests.rs` runs `bun daemon/tests/support/read_image_preview.ts`
  from `cargo test`. This is why the client CI job needs bun and the daemon's
  `node_modules`.
- `shore-cli/tests/reliability.rs` runs a Python harness that drives the built
  `shore` binary through a pseudo-terminal and local sockets. That's a
  legitimate end-to-end test, but it's hidden inside a one-line Rust test.

**Recommendation.** Record the daemon's read-image output as a fixture with
the existing `rerecord` mechanism (`rerecord:check` already keeps captures
honest) and have the Rust test read it. Keep `reliability` but name it for
what it is, and run it as its own CI step so its failures are legible.

### 5. Tests whose value is worth re-checking

- **`cli.rs`: 66 `parse_*` and 28 `*_maps_to_command` tests.** The first set
  checks that clap's derive produces a given enum shape; the second maps a
  hand-built enum to a wire command. What matters to the daemon is the
  composition: *argv in, wire command out*. **Replace both sets with one
  table-driven test** of `(argv, command name, args JSON)`, which is shorter
  and tests the real contract. Keep the tests that assert user-facing
  rejections (conflicting flags, missing values). The 16 completion tests
  (bash/zsh/fish output) are user-visible, so keep them.
- **`shore-common/tests/golden_json.rs`: 52 tests.** The "golden" fixtures are
  JSON literals hand-written in the Rust file. The daemon never produces or
  checks them, so they prove Rust agrees with itself, not that it agrees with
  the daemon. **Replace with fixtures emitted by the daemon, or schema-checked
  on both sides.** The schema export on #232 (`export_wire_schemas`) is most of
  the way there. Until then they're round-trip tests, not contract tests.
- **12 ignored `render_preview_*` tests.** These are preview printers for
  `.claude/skills/run-shore-cli/preview.sh`, not tests, and they set the
  global colour flag. **Move them to a `cargo run --example preview <name>`**
  so `--ignored` and the test count mean something.
- **`keymap::the_live_config_file_loads_without_complaint`** reads the real
  `~/.config/shore/tui.toml`. That's a personal lint, not a test. **Make it a
  command** (e.g. `shore ui check-keymap`) **or delete it.**
- **`daemon/tests/fixture_env.ts`** hardcoded the developer's own name as
  `USER`. Use a neutral test name.

### 6. Daemon environment writes

78 direct `process.env` writes across 20 test files, while
`tests/support/env.ts` already provides `setTestEnv` / `restoreTestEnv` (used
in 14 files). Bun runs every file in one process, so a write that isn't
restored leaks into later files. The biggest are `claude_agent_stream` (16) and
`claude_agent_auth` (12).

**Recommendation.** Short term, route all of them through `setTestEnv` with
`restoreTestEnv` in `afterEach`, and add a lint rule that forbids direct
`process.env` writes in `tests/`. Longer term, as with finding 1, inject the
values the code reads rather than setting the environment.

## CI changes that follow from this

- **Run local tests like CI does.** `.scripts/test.sh` should run the client
  group with `SHORE_TOKEN` unset and `HOME`/`XDG_*` pointed at an empty
  temporary directory. Finding 1 would have shown up locally on day one.
- **Make the client job required once findings 1–3 are fixed.** Until then it
  fails intermittently for reasons unrelated to the PR under test.
- **No automatic retries.** Retrying (e.g. nextest `--retries`) would turn
  these jobs green by hiding the races this audit found.

## Status

All findings are addressed on `chore/test-hygiene`, one commit per change.

| finding | what changed | notes |
|---|---|---|
| 1. ambient token, env and config | `TokenSource` passed into `connect`/`spawn_connection`; `ShoreDirs` resolves from an env lookup; both `test_env.rs` deleted; the TUI's keymap/prefs paths live on `App::settings_files`, set only by the real entry point; the clap test parser ignores `SHORE_CHARACTER`/`SHORE_THREAD`/`SHORE_ADDR` | The CLI table (below) surfaced the clap env fallback: `usage` was sending the developer's own character. |
| CI: run like CI | `test.sh` runs `cargo test` and `bun test` with an empty `HOME`/`XDG_*` and every `SHORE_*` variable unset | |
| 2. global colour flag | tests override colour and decoration through a thread-local that production builds do not have; `COLOR_TEST_LOCK` is gone; the one test that wrote `CHUNK_STATE` is removed | **Differs from the recommendation.** A render context would have changed nearly every function in `output/`. What was needed is that no test writes process-wide state, and a per-thread test override achieves that. 0 failures in 40 stress runs that previously failed 1 in 20. |
| 3. wall-clock assertions | paused tokio time and `is_finished()` in Rust; injectable clocks for the config watcher and SWP pings; positive checks after a fixed sleep now wait for the condition (`tests/support/until.ts`); rejected reloads are observed through `config_warning` | Sleeps that only simulate a slow peer, or guard a negative assertion that cannot fail spuriously, stay. Real-socket lifecycle tests keep real time with a hang guard below the handshake deadline. |
| 4. other runtimes | read-image frames are a recorded capture checked by a daemon test; the Rust test `include_str!`s it and the client job no longer installs bun; the PTY/socket harness is its own `test.sh` step (`cargo-end-to-end`) | |
| 5. `cli.rs` parse/mapping tests | 74 tests became one argv → daemon-command table generated from the current code | Parse tests for locally handled commands stay. |
| 5. `golden_json.rs` | the 28 canonical fixtures are TypeScript that `satisfies` the daemon's generated types, recorded to a capture Rust reads; client fixtures go through `WireReader` and `admitClientMessage` | Surfaced that the daemon writes `8.0` as `8`; the round trip compares numbers numerically. |
| 5. previews | all 13 are `render_preview_*` with one ignore reason and reachable from `preview.sh` | **Differs from the recommendation.** `shore-cli` is binary-only, so an example cannot reach the crate-private renderers. |
| 5. live-config test, `USER` | deleted; `USER` is a placeholder | |
| 6. daemon env writes | all go through `setTestEnv`/`unsetTestEnv`; the preload restores after every test; `lint:test-env` forbids direct writes | |
| personal data | test names replaced with same-length placeholders | `LICENSE-MIT`'s copyright line is unchanged. |

Still to do outside the code: make the `client tests and clippy` check required in branch protection once this branch's CI is green.
