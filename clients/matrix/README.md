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
