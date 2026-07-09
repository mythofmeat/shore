# shore-matrix

Matrix bridge for the [Shore](https://github.com/mythofmeat/shore-core)
chat daemon. Talks to `shore-daemon` over the Shore Wire Protocol (SWP) and
exposes characters as Matrix users on an embedded homeserver.

Features:

- E2E-encrypted Matrix bridging via
  [`matrix-rust-sdk`](https://github.com/matrix-org/matrix-rust-sdk).
- Per-character Matrix accounts with avatars + display names.
- Embedded-homeserver provisioning (continuwuity / conduwuit / tuwunel).
- Health checks and reconnection.
- Live streaming replies (progressive message edits with a typing cursor).
- Matrix-native conversation editing: edit your message to edit the
  conversation, redact to delete, react 🔁 / 🗑️ / ◀️ ▶️ to regenerate,
  delete, or cycle alternate responses.
- Daemon-side mutations (regen, alt swaps, TUI edits) update the room's
  messages in place instead of appending.
- Quiet by default: rooms receive replies to Matrix-sent prompts and the
  character's autonomous (heartbeat) messages. Set
  `[connections.matrix].mirror = "all"` to mirror the entire conversation
  (other clients' prompts render as blockquotes), or `"off"` for legacy
  request/response routing.
- `!` commands mirroring the TUI's (`!help` in any bound room), with
  Markdown-rendered output.
- Per-room `!view` toggles for thinking blocks, tool activity, and a
  token/timing usage footer.

## Build

```sh
cargo build --release
```

The resulting binary is `target/release/shore-matrix`.

## Run

Reads connection settings from `~/.config/shore/client.toml` and Matrix-specific
configuration from environment variables / CLI flags. See
[Shore](https://github.com/mythofmeat/shore-core) for daemon-side
configuration.

## License

Dual-licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE-2.0](LICENSE-APACHE-2.0))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option.
