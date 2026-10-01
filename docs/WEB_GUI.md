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

Sending clears the message box at once, but the browser keeps the text and images until the daemon
confirms it saved the message. If the page closes or reloads first, the next page asks the daemon
what happened to the message and puts it back in its message box unless the daemon saved it.

Settings → Appearance → Notifications makes a tab that isn't focused show a desktop notification and
an unread count in its title for new replies, heartbeat messages and errors in the open
conversation. The setting is saved per browser. Browsers only allow desktop notifications over
HTTPS or `localhost` (an SSH tunnel counts); over plain HTTP on a LAN or Tailscale address you get
only the title count. These are separate from the daemon's own `[notifications]`.

All web settings are visible through the existing configuration schema and require restart. Bind
addresses accept IP literals or resolvable hostnames. HTTP works on any listener, and browser URLs
may use any hostname or forwarded port. TLS is optional and requires both `tls_cert` and `tls_key`.
A listener can also sit behind a same-origin reverse proxy: configure the exact HTTP(S)
`public_origin` and preserve the public Host header and WebSocket upgrades. For requests with that
Host, the configured origin supplies the browser-facing scheme. Other hosts and ports use their
request URL as usual. Session cookies use the browser-facing scheme for each connection, so HTTPS
proxy access and direct HTTP access both work. Provider credentials are never part of this setup.

The browser signs in with the daemon client token and receives an opaque, HttpOnly,
SameSite=Strict session cookie. Tokens never appear in URLs or responses. The browser stays signed
in, across daemon restarts, until the session expires after `daemon.web.session_lifetime` (default
`30d`; accepts durations such as `12h` or `90d`) or the daemon token changes. Disconnecting revokes
the cookie and closes its sockets.

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

## Desktop app

`desktop/` is an Electron app that shows the daemon's browser client in its own window. It runs on
the system Electron and needs nothing from the daemon beyond `[daemon.web]`, the same as a browser.
On Arch, `contrib/arch/PKGBUILD` builds it as the `shore-desktop` package next to `shore-cli`, and
it appears as **Shore** in the application menu.

The first launch asks for the daemon's address, such as `my-host.example.ts.net:7340`. Without a
scheme the app uses `http://`, and without a port it uses 7340. Then sign in with the daemon token,
as in a browser. To change the address later, use the tray menu or the Shore menu (press Alt to
show the menu bar). `shore-desktop --address=<address>` sets it from the command line.

How it differs from a browser tab:

- Desktop notifications work over plain HTTP. The app treats its daemon's address as a secure
  origin, which browsers only do for HTTPS and `localhost`. Switching to such an address restarts
  the app once. Turn notifications on in Settings → Appearance → Notifications, as in a browser.
- Closing the window keeps Shore running in the system tray, so notifications keep arriving.
  Clicking one, or launching Shore again, brings the window back. Close to Tray in the tray or
  Shore menu turns this off.
- Links open in the default browser. The window only shows the daemon's own pages.
- With notifications on, the unread count shows in the window title and as a dot on the tray icon.
- KWin and other desktops that draw window frames give the window their native title bar.

Settings are in `~/.config/shore-desktop/settings.json`, next to the app's browser data (the
sign-in cookie and unsent drafts). `--user-data-dir=<directory>` keeps a separate profile with its
own address, which lets a second window stay connected to another daemon.

To work on it, in `desktop/`:

- `bun run start` builds the app and opens it with the system `electron`.
- `bun test` covers address parsing, failure messages, settings and menus. `.scripts/test.sh` runs
  it with the type check and the build.
- `bun run test:e2e` runs the Playwright journeys against the daemon's browser fixture, so run
  `bun install` in `daemon/` first. They start a private KWin session with no visible output
  (`kwin_wayland --virtual` on its own D-Bus), so they need KWin but never touch your desktop.
  `SHORE_DESKTOP_APP=/usr/lib/shore-desktop SHORE_DESKTOP_ELECTRON=electron44` points them at an
  installed package instead of the build in `desktop/dist`.
- `bun run icons` renders the PNG icons from their SVGs with `rsvg-convert`.

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
