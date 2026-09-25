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
uses. Every web setting requires a daemon restart. Disconnect (Settings → Disconnect) ends the
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

## Schema ownership decision

Rust remains canonical for SWP envelopes, events and existing wire value types, as specified in
`daemon/src/protocol/README.md`. Extend that path for operation payloads: define typed inputs and
results in `client/shore-common`, generate TypeScript with ts-rs, and derive runtime JSON Schemas from
the same Rust definitions. Use those schemas for server validation and GUI controls. Schemars 1.2.2
has been added in a separate dependency change; its installed implementation supports explicit
2020-12 schemas and distinct deserialize/input and serialize/result contracts. All Rust workspace
checks pass with the addition. Do not hand-edit generated protocol files or duplicate validators/UI schemas.

Pair an operation's input and result in the canonical catalogue so Rust and TypeScript callers keep
the association. Handler registration, scope/prerequisites, effects, confirmation and presentation
metadata reference that catalogue. The executable registry must replace the dispatch switches;
discovery comes from that registry, not the source inventory. During migration, explicitly track the
unmigrated names and keep the final parity gate failing until they are closed. Keep all existing
golden assertions as independent behavioral evidence.

The runtime validator must validate payloads before side effects and validate observable results
after the existing after-command annotations. Field names, optional/null behavior, discriminated
variants, modes, defaults and result information must match current clients. Domain validation stays
in shared daemon handlers. Genuinely open tool/config values may remain structured dynamic values;
all-operation `unknown` results may not.

## Developing the browser client

- Source: `daemon/src/browser/`. The data layer (`connection.ts`, `workspace.ts`, `operations.ts`,
  `drafts.ts`, …) is framework-free; the React UI lives in `app/`, `chat/`, `sidebar/`,
  `settings/` and `ui/`.
- Styles: `daemon/src/browser/styles/`. Components use design tokens only; colors and fonts live in
  `styles/themes/`. See the plan for the theme rules.
- Build: `bun run browser:build` regenerates `daemon/src/web/assets.generated.ts`, which the daemon
  embeds. Rebuild and restart the daemon to pick up UI changes.
- Tests: `bun test tests/browser_*.test.ts` for units, `bun run test:browser` for Playwright.
- Parity: `tests/browser_parity.test.ts` checks every CLI command and option, TUI view preference,
  local workflow, conversation request and renderer family against `src/browser/surfaces.ts` and the
  shrinking list in `scripts/browser_known_gaps.json`. After implementing something, declare it in
  `surfaces.ts` and run `bun run scripts/browser_parity.ts --prune`.
