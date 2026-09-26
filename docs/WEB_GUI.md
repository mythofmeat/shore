# Browser client

Shore's daemon can serve an optional browser client: a chat workspace for your characters and
conversations, with settings and advanced tools in a separate Settings page. It is off by default.
The design and rebuild plan are in [WEB_UI_V3_PLAN.md](WEB_UI_V3_PLAN.md).

## Enabling it

```toml
[daemon.web]
enabled = true
bind_addr = "127.0.0.1:7340"
```

Restart the daemon, open `http://127.0.0.1:7340`, and connect with the same access token the CLI
uses. Press `?` for keyboard shortcuts or Ctrl/⌘+K for the command palette. Themes and display
options are under Settings → Appearance. Every web setting requires a daemon restart. Disconnect (Settings → Disconnect) ends the
browser session; it does not remove drafts saved in that browser.

All web settings are visible through the existing configuration schema and require restart. Bind
addresses accept IP literals or resolvable hostnames. HTTP works on any listener, and browser URLs
may use any hostname or forwarded port. TLS is optional and requires both `tls_cert` and `tls_key`.
A listener can also sit behind a same-origin reverse proxy: configure the exact HTTP(S)
`public_origin` and preserve the public Host header and WebSocket upgrades. For requests with that
Host, the configured origin supplies the browser-facing scheme. Other hosts and ports use their
request URL as usual. Session cookies use the browser-facing scheme for each connection, so HTTPS
proxy access and direct HTTP access both work. Provider credentials are never part of this setup.

The browser signs in with the daemon client token and receives an opaque, HttpOnly,
SameSite=Strict session cookie. Tokens never appear in URLs or responses. Sessions expire after
eight hours; disconnecting revokes the cookie and closes its sockets.

## LAN, Tailscale and SSH access

For access from another device on your local network, add this to the daemon configuration and
restart the daemon:

```toml
[daemon.web]
enabled = true
bind_addr = "0.0.0.0:7340"
```

Open `http://<daemon-LAN-IP>:7340` and sign in with the same daemon token used by the CLI/TUI.
Tailscale IPs, MagicDNS names and other DNS aliases work too, without a hostname allowlist,
certificate or `public_origin`. To listen only on Tailscale, set `bind_addr` to your machine's
Tailscale address, for example `"100.101.102.103:7340"`.

Shore leaves network exposure and transport security to the operator. Choosing a bind address,
firewall, Tailscale connection, SSH tunnel or reverse proxy is a deployment decision; the daemon
does not require HTTPS or make exceptions based on whether an address is considered local.
Token authentication applies to every connection.

For an SSH tunnel, the daemon can keep `bind_addr = "127.0.0.1:7340"`. On the computer running
your browser:

```sh
ssh -N -L 17340:127.0.0.1:7340 user@daemon-host
```

Open `http://localhost:17340`. The browser port may differ from the daemon port, and both
`localhost` and `127.0.0.1` work. The web listener uses port **7340** by default; port **7320** is
the CLI/TUI protocol and cannot serve a browser.

`public_origin` is optional proxy configuration and does not prevent direct access through another
hostname or port. Remove `tls_cert` and `tls_key` if switching an existing HTTPS listener to HTTP.
All web configuration changes require a daemon restart.

## Operation contracts

Browser and terminal clients call the same daemon operations. Rust is canonical for their shapes, as
it is for SWP envelopes and events (`daemon/src/protocol/README.md`):

- `client/shore-common/src/protocol/operations.rs` pairs each operation's name, input type and result
  type in one `operations!` catalogue. ts-rs generates the TypeScript types. Schemars generates
  `daemon/src/operations/schemas.generated.json`, with a deserialize schema for inputs and a
  serialize schema for results. Regenerate with `cargo test -p shore-common --lib export_bindings`
  and `cargo test -p shore-common --lib export_operation_schemas`, and never hand-edit the output.
- `daemon/src/commands/registry.ts` registers a handler for every catalogue entry, with its scope,
  prerequisites, effects, confirmation and field presentation. Startup fails if a contract has no
  handler or a handler has no contract. Discovery fails if a handler's presentation leaves out an
  input field. Every command dispatches through this registry, and unknown names are rejected.
- Inputs are validated against the schema before the handler runs. Results are validated after the
  handler, and again after the after-command annotations in `daemon/src/handler/command_dispatch.ts`.
  Domain validation stays in the handlers.
- The browser uses Ajv validators precompiled from the same schemas (`bun run browser:generate`).
  `tests/browser_wire.test.ts` fails if they drift.

## Developing the browser client

- Source: `daemon/src/browser/`. The data layer (`connection.ts`, `workspace.ts`, `operations.ts`,
  `drafts.ts`, …) is framework-free; the React UI lives in `app/`, `chat/`, `sidebar/`,
  `settings/` and `ui/`.
- Styles: `daemon/src/browser/styles/`. Components use design tokens only; colors and fonts live in
  `styles/themes/`. See the plan for the theme rules.
- Build: `bun run browser:build` regenerates `daemon/src/web/assets.generated.ts`, which the daemon
  embeds. Rebuild and restart the daemon to pick up UI changes.
- Tests: `bun test tests/browser_*.test.ts` for units, `bun run test:browser` for Playwright. The
  pre-commit hook and CI run the unit tests but not Playwright, so run the journeys before pushing
  UI changes.
- Parity: `tests/browser_parity.test.ts` checks every CLI command and option, TUI view preference,
  local workflow, conversation request and renderer family against `src/browser/surfaces.ts` and the
  shrinking list in `scripts/browser_known_gaps.json`. After implementing something, declare it in
  `surfaces.ts` and run `bun run scripts/browser_parity.ts --prune`.
