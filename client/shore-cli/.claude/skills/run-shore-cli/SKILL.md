---
name: run-shore-cli
description: Build, test, and preview the shore CLI's terminal output rendering. Use when asked to run shore-cli, see/preview/screenshot how its transcript or streaming output looks, check colors/separators/thinking rendering, or verify a change to client/shore-cli/src/output without standing up a daemon.
---

`shore-cli` is the `shore` command-line client for the Silvershore daemon.
The interesting, frequently-changed surface is the **output renderer**
(`src/output/`): the transcript shown by `shore log` / `shore get` and the
live token stream. The catch — the real CLI needs a running daemon and a
thinking-capable model to produce that output, and the crate is **binary-only
(no `lib` target)**, so the `output` module can't be reached from an
`examples/` file or any external driver.

The agent path here drives the **real renderers** through `#[ignore]`-d preview
tests and dumps the colorized bytes to your terminal:
**`.claude/skills/run-shore-cli/preview.sh`**.

All paths below are relative to `client/shore-cli/` (the unit). The driver also
works from the repo root.

## Prerequisites

The Rust workspace toolchain — nothing else (no `apt-get` packages were needed;
it builds and tests clean on a stock Linux toolchain).

```bash
cargo --version   # 1.95.0 used here; any recent stable works
```

## Build

No separate build step for the preview path — `cargo test` compiles what it
needs. To build the actual binary:

```bash
cargo build -p shore-cli            # produces target/debug/shore
```

## Run (agent path) — preview the rendering

```bash
.claude/skills/run-shore-cli/preview.sh           # both previews, colorized
.claude/skills/run-shore-cli/preview.sh log       # just shore log / shore get
.claude/skills/run-shore-cli/preview.sh stream    # just live token streaming
```

Each preview renders a representative assistant turn with **interleaved
thinking** (thinking → text → tool call → redacted_thinking → thinking → text)
through the real `render_message_content` (log) and `print_chunk_to` (stream)
functions, with color ON, and prints the raw bytes so your terminal colorizes
them. The layout is a two-channel design: response **speech** is flush-left and
plain, while thinking, tool calls, and results form one **process channel** down
a dim `│` left gutter — each block opened by a colored sigil + label header
(magenta `◌ Thinking`, yellow `→ <tool> · <arg>`, green `✓ result` / red
`✗ error`) with a dim, gutter-barred body. The gutter is continuous across
consecutive process blocks (joined by a bar-only line) and breaks only at
speech. Thinking content is word-wrapped to the terminal width; tool results are
not truncated; `redacted_thinking` is hidden. The preview thinking blocks are
long on purpose so you can see the wrapping; resize your terminal and re-run to
confirm.

Expected shape (log path; headers are colored, the gutter + bodies dim):

```text
│ ◌ Thinking
│   Let me reason about this first. The user asked about a long-standing
│   issue, and this paragraph is long so it wraps under the gutter.

Here's the first part of my answer.

│ → read_file · src/main.rs
│   path: src/main.rs
│
│ ✓ result
│   fn main() { ... }

And here's the refined conclusion.
```

## Direct invocation — the technique, and adding a preview

The preview tests live next to their assertion counterparts:

- `src/output/transcript.rs` → `render_preview_log` (drives `render_message_content`)
- `src/output/styling.rs` → `render_preview_stream` (drives `print_chunk_to`)

To preview a different message/stream, copy one of those tests, change the
`content_blocks` / chunk sequence, and run it directly:

```bash
cargo test -p shore-cli render_preview_log \
  -- --ignored --nocapture --test-threads=1
```

The recipe for any in-crate visual preview:

1. In the relevant `#[cfg(test)] mod tests`, `set_color_enabled(true)`. The
   setting belongs to the test's own thread, so it cannot tint other tests.
2. Render into a `Vec<u8>` via the real (private) renderer.
3. Write the buffer straight to `io::stdout()` between `----- <label> -----`
   and `----- end -----` so the ANSI escapes survive and `preview.sh` finds it.
4. Name it `render_preview_*`, mark it
   `#[ignore = "preview: .claude/skills/run-shore-cli/preview.sh <name>"]`, and
   add `<name>` to `preview.sh`.

## Test (assertions)

The behavior is pinned by ordinary (non-ignored) tests in the same modules
(`interleaved_thinking_header_both_directions`,
`tool_call_and_result_render_with_sigils_and_separators`,
`redacted_thinking_is_hidden`, …):

```bash
cargo test -p shore-cli output::      # 68 pass, 2 ignored (the previews)
```

## Run (human path) — the real CLI

The actual client needs a daemon and a model; it is not driveable headless here
for rendering previews. For reference only:

```bash
cargo run -p shore-cli -- log          # talks to a running daemon over its socket
cargo run -p shore-cli -- log --plain  # plain variant: prefixes thinking with [thinking]
```

Use the preview path above instead when you only need to see how output looks.

## Gotchas

- **`--test-threads=1` keeps previews readable.** Colour is per test thread,
  so parallel runs are correct, but their stdout blocks would interleave. The
  driver already sets this.
- **`#[ignore]`, not deletion.** Previews live permanently in the test modules
  but are skipped by default — that's why a normal `output::` run reports
  `2 ignored`. Don't "clean them up."
- **Shared process-channel primitives.** The sigils, gutter, wrap width, and
  the per-line writers live in `output/mod.rs` (`write_sigil_header`,
  `write_process_body`, `write_thinking_content_line`, `write_channel_rule`,
  `primary_tool_arg`, `process_wrap_width`, the `SIGIL_*`/`COLOR_*`/`CHANNEL_BAR`
  consts) and are shared by both the transcript renderer and the streaming path
  so they stay identical. Change them there, not in one path.
- **Two render paths, different rules.** The colored transcript
  (`render_message_content`) and stream use the sigil channel; the `--plain`
  path (`print_log_plain`) instead prefixes each thinking line with `[thinking]`
  and uses no box-drawing/sigils. All hide `redacted_thinking`. Preview the one
  your change touches.
- **Streaming buffers thinking per logical line.** Wrap width is only known per
  complete line, so thinking chunks accumulate until a `\n` (or a flush at a
  tool call / stream end). `reset_chunk_state()` runs once per turn (not per
  tool-loop round) so blank-line separation survives across rounds.
- **No `lib` target.** You cannot add an `examples/preview.rs` that imports
  `output::…` — the symbols aren't exported. The in-crate test is the only
  handle on these private renderers.

## Troubleshooting

- **Driver prints nothing.** The `sed` range only emits lines between
  `----- … -----` and `----- end -----`. If a compile error occurred, it went to
  stderr — rerun the raw command (`cargo test -p shore-cli render_preview --
  --ignored --nocapture --test-threads=1`) to see it.
- **Colors don't show, you see raw `^[[38;5;8m`.** Your viewer is escaping the
  bytes (e.g. piping through `cat -v`). Run the driver directly in a terminal.
- **`0 ignored` / preview didn't run.** You dropped `--ignored`, or the test
  name filter didn't match. Use `render_preview` (both), `render_preview_log`,
  or `render_preview_stream`.
