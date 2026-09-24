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
#   .claude/skills/run-shore-cli/preview.sh config-set # just shore config set
#   .claude/skills/run-shore-cli/preview.sh subagent   # just shore trace subagent
#   .claude/skills/run-shore-cli/preview.sh wire       # just shore trace calls --wire
#   .claude/skills/run-shore-cli/preview.sh config-panel  # TUI settings panel
#   .claude/skills/run-shore-cli/preview.sh pager      # TUI output pager
#
# Add a new preview by writing another `#[ignore = "preview: ..."]` `render_preview_*`
# test that prints its frames between `----- <label> -----` and `----- end -----`;
# `all` picks it up through the `render_preview` filter.
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
  config-set) filter=render_preview_config_set ;;
  subagent) filter=render_preview_subagent ;;
  wire)   filter=render_preview_wire ;;
  config-panel) filter=render_preview_config_panel ;;
  pager)  filter=render_preview_output_pager ;;
  all|"") filter=render_preview ;;
  *) echo "usage: preview.sh [log|stream|models|status|errors|compact|compaction-lane|roles|config-set|subagent|wire|config-panel|pager|all]" >&2; exit 2 ;;
esac

# --test-threads=1 keeps each preview's blocks together on stdout; colour is set
# per test thread, so it is not needed for correctness. --nocapture lets the
# rendered bytes reach the terminal. Keep stderr (build errors) visible; the
# sed range extracts only the rendered blocks from stdout, preserving color.
cargo test -p shore-cli "$filter" -- --ignored --nocapture --test-threads=1 \
  | sed -n '/^----- /,/^----- end -----/p'
