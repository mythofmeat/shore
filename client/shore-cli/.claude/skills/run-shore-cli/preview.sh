#!/usr/bin/env bash
#
# Preview shore-cli terminal output rendering WITHOUT a running daemon.
#
# shore-cli is a binary-only crate, so the `output` module (transcript +
# streaming renderers) can't be reached from an example or an external driver.
# Instead this drives the real renderers through `#[ignore]`-d preview tests
# that write with color ON into a buffer and dump the raw bytes — ANSI escapes
# and all — so your terminal shows it exactly as the CLI would.
#
# Usage:
#   .claude/skills/run-shore-cli/preview.sh            # both previews
#   .claude/skills/run-shore-cli/preview.sh log        # just the log render
#   .claude/skills/run-shore-cli/preview.sh stream     # just live streaming
#
# Add a new preview by writing another `#[ignore]`-d `render_preview_*` test in
# client/shore-cli/src/output/{transcript.rs,styling.rs}; it is picked up here
# automatically by the `render_preview` filter.
set -euo pipefail

case "${1:-all}" in
  log)    filter=render_preview_log ;;
  stream) filter=render_preview_stream ;;
  all|"") filter=render_preview ;;
  *) echo "usage: preview.sh [log|stream|all]" >&2; exit 2 ;;
esac

# --test-threads=1 is REQUIRED: COLOR_ENABLED and the streaming chunk state are
# process-global, so parallel tests would race on them. --nocapture lets the
# rendered bytes reach the terminal. Keep stderr (build errors) visible; the
# sed range extracts only the rendered blocks from stdout, preserving color.
cargo test -p shore-cli "$filter" -- --ignored --nocapture --test-threads=1 \
  | sed -n '/^----- /,/^----- end -----/p'
