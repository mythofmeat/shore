# shore-tui

Terminal UI client for the [Silvershore](https://github.com/mythofmeat/silvershore)
chat daemon. Talks to `shore-daemon` over the Shore Wire Protocol (SWP) using
the published [`shore-swp-client`](https://crates.io/crates/shore-swp-client)
and [`shore-protocol`](https://crates.io/crates/shore-protocol) crates.

Features:

- ratatui-based scrollback with markdown rendering (CommonMark/GFM via
  pulldown-cmark).
- Terminal image protocol auto-detection (Kitty, iTerm2, Sixel).
- Clipboard image paste (Wayland, via `wl-clipboard`).
- Persisted local view preferences (`:view` submenu).

## Build

```sh
cargo build --release
```

The resulting binary is `target/release/shore-tui`.

## Run

```sh
shore-tui
```

Reads connection settings from `~/.config/shore/client.toml` like the rest of
the Shore client family. See the
[Silvershore README](https://github.com/mythofmeat/silvershore#readme) for
config details.

## Development

Renderer fixture mode (no daemon required) is documented in [dev/README.md](dev/README.md).

## License

Dual-licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE-2.0](LICENSE-APACHE-2.0))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option.
