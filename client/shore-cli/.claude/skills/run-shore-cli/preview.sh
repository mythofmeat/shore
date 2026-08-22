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
#   .claude/skills/run-shore-cli/preview.sh            # every preview
#   .claude/skills/run-shore-cli/preview.sh log        # just the log render
#   .claude/skills/run-shore-cli/preview.sh stream     # just live streaming
#   .claude/skills/run-shore-cli/preview.sh models     # just shore model
#   .claude/skills/run-shore-cli/preview.sh status     # just shore status
#   .claude/skills/run-shore-cli/preview.sh errors     # just shore trace errors
#   .claude/skills/run-shore-cli/preview.sh compact    # just shore compact
#   .claude/skills/run-shore-cli/preview.sh roles      # just model role changes
#
# Add a new preview by writing another `#[ignore]`-d `render_preview_*` test in
# client/shore-cli/src/output/{transcript.rs,styling.rs,catalog.rs,status.rs,commands.rs}; it is picked up here
# automatically by the `render_preview` filter.
set -euo pipefail

case "${1:-all}" in
  log)    filter=render_preview_log ;;
  stream) filter=render_preview_stream ;;
  models) filter=render_preview_models ;;
  status) filter=render_preview_status ;;
  errors) filter=render_preview_errors ;;
  compact) filter=render_preview_compaction_result ;;
  compaction-lane) filter=render_preview_compaction_lane ;;
  roles)  filter=render_preview_model_roles ;;
  all|"") filter=render_preview ;;
  *) echo "usage: preview.sh [log|stream|models|status|errors|compact|compaction-lane|roles|all]" >&2; exit 2 ;;
esac

# --test-threads=1 is REQUIRED: COLOR_ENABLED and the streaming chunk state are
# process-global, so parallel tests would race on them. --nocapture lets the
# rendered bytes reach the terminal. Keep stderr (build errors) visible; the
# sed range extracts only the rendered blocks from stdout, preserving color.
cargo test -p shore-cli "$filter" -- --ignored --nocapture --test-threads=1 \
  | sed -n '/^----- /,/^----- end -----/p'
