# Application capability inventory

This directory holds the generated inventories of every CLI/TUI capability and daemon operation.
The browser tracks them through a ratchet rather than a one-to-one mapping: every command, option,
view preference, local workflow and conversation request is either surfaced by the browser
(declared in `daemon/src/browser/surfaces.ts` at an `inline`, `settings` or `advanced` tier) or
listed in `daemon/scripts/browser_known_gaps.json`, which may only shrink. Terminal-only concepts
are listed with reasons in `daemon/scripts/browser_parity.ts`. See [WEB_UI_V3_PLAN.md](../WEB_UI_V3_PLAN.md).

## Reproducible source inventory

- `terminal.generated.json` is produced from the actual Clap command tree, including hidden commands,
  every argument, aliases, defaults, enum choices, arity, conflicts, and environment variable names.
  It also records examples passed through the actual `to_swp_command` mapping, the complete `ViewKey`
  preferences, and the production key bindings and shortcut menu. A null example mapping marks a
  special runner or local workflow rather than a single daemon command.
- `daemon.generated.json` combines the executable operation registry and every generated wire type.
  It includes characterless dispatch, core message/regen/cancel requests, results, images, tools,
  warnings, and all known server-event variants. All 56 named operations are registered and
  validated against their generated schemas, so `legacy_operations` is empty. The `requests`
  collection records the message/regen/cancel registrations and their input/completion schemas.
  The inventory itself is not a runtime validator.

Regenerate from `client/`, then from `daemon/`:

```sh
cargo test -p shore-common --lib export_bindings
cargo test -p shore-common --lib export_operation_schemas
cargo test -p shore-cli export_capability_inventory -- --ignored
```

```sh
bun run inventory:generate
```

The normal Rust and daemon test suites compare the inventories against the running source, so a new
command, argument or operation fails until the inventory is regenerated. Review regenerated
differences together with the browser parity gate below.

## Where terminal capabilities live in the browser

`TERMINAL_ROUTES` in `daemon/scripts/browser_parity.ts` is the authoritative mapping. Each terminal
command path names the daemon operations it reaches, the operation field behind each argument, and
the tier the browser must reach it at. Individual arguments can override their command's tier. The
tiers correspond to places in the UI:

| Tier | Where it appears | Examples |
| --- | --- | --- |
| `inline` | The chat screen: sidebar, top bar, conversation menu, message actions, composer | Send, regenerate, edit, delete, swipe, compact, clear, creating characters, conversation create/rename/fork/archive, model picker |
| `settings` | Settings → Chat and Daemon pages | Display preferences, model roles and settings, providers, usage and budgets, configuration, character info and deletion |
| `advanced` | Settings → Advanced pages, which may use generated forms | Segments, traces and call log, status, tool runner, character archives, heartbeat and keepalive controls |

`NOT_APPLICABLE` in the same file lists terminal-only concepts with a reason each: help and version
output, `--json`, TOML formatting, the TCP address, shell completions, the TUI output pane and one
request field the daemon ignores.

## How coverage is checked

- `daemon/tests/browser_parity.test.ts` turns every terminal command, field and finite choice, view
  preference, `shore ui` command, conversation request field and result renderer family into a unit.
  Each unit must be declared in `surfaces.ts` at its route's tier or a more accessible one, listed as
  a known gap, or listed as not applicable. New terminal commands, fields and choices fail until they
  are tracked. A known gap that becomes covered fails until it is removed
  (`bun run scripts/browser_parity.ts --prune`). A terminal field that maps to no daemon operation
  field fails as an API parity error, whatever the UI declares.
- `daemon/tests/browser_local_workflows.test.ts` checks that `shore ui` commands keep their fields and
  choices, that conversation shortcuts resolve to the operation catalogue, and that line scrolling
  keeps the terminal defaults.

Surface declarations are claims. The Playwright journeys in `daemon/tests/browser/` back them up:
sign-in, the chat workspace and every settings page. Run them with `bun run test:browser` from
`daemon/`. The pre-commit hook and CI run the unit gates above but not the journeys.
