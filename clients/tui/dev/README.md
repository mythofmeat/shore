# TUI Debug Fixtures

`shore-tui` has env-var-only debug hooks so renderer testing does not touch a
real daemon, character, conversation history, preference state, or TUI log.
Fixture mode also skips terminal image-protocol probing.

Interactive fixture mode:

```sh
SHORE_TUI_FIXTURE=dev/fixtures/markdown.md target/debug/shore-tui
```

One-shot render to stdout:

```sh
SHORE_TUI_FIXTURE=dev/fixtures/markdown.md \
SHORE_TUI_FIXTURE_RENDER=80x24 \
target/debug/shore-tui
```

Useful env vars:

- `SHORE_TUI_FIXTURE`: markdown file to render as an offline transcript entry.
- `SHORE_TUI_FIXTURE_ROLE`: `assistant`, `user`, or `system`; defaults to
  `assistant`.
- `SHORE_TUI_FIXTURE_REPEAT`: repeat the fixture entry to exercise scrolling.
- `SHORE_TUI_FIXTURE_SCROLL`: initial scroll offset from the bottom.
- `SHORE_TUI_FIXTURE_CHARACTER`: assistant name shown for fixture entries;
  defaults to `Fixture`.
- `SHORE_TUI_FIXTURE_RENDER`: `WIDTHxHEIGHT` one-shot frame render to stdout.
- `SHORE_TUI_RENDER_SIZE`: alias for `SHORE_TUI_FIXTURE_RENDER`.
- `SHORE_TUI_DEBUG_FRAMES`: append every interactive redraw as text frames to
  the given file.
- `SHORE_TUI_DEBUG_NO_IMAGE_PROBE`: set to `1`/`true`/`yes`/`on` to skip
  terminal image-protocol probing.
