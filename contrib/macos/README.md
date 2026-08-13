# macOS packaging

Three formulae, mirroring the Arch and Alpine split:

| Formula | Installs |
|---|---|
| `shore-cli` | `shore` + bash/zsh/fish completions |
| `shore-tui` | `shore-tui` |
| `shore-daemon` | `shore-daemon` + a launchd agent via `brew services` |

These files are the source of truth. The tap that serves them is a separate
repo (`mythofmeat/homebrew-shore`, created with `brew tap-new`); copy them into
its `Formula/` directory when cutting a release.

## Cutting a release

`url` points at the GitHub tag tarball and `sha256` is a placeholder. After
pushing a tag:

```sh
version=4.6.2
curl -fsSL "https://github.com/mythofmeat/shore/archive/refs/tags/v$version.tar.gz" | shasum -a 256
```

Substitute the tag and the digest into all three formulae, then copy them into
the tap.

Two things block that today:

- **The repo is not public.** `https://github.com/mythofmeat/shore` answers 404
  unauthenticated, so Homebrew cannot fetch the tarball on anyone else's
  machine. Until it is public, the tap only works for people whose git can
  already reach the repo, via `brew install --HEAD mythofmeat/shore/shore-cli`.
- **Three different version numbers are in play.** `client/Cargo.toml` says
  `0.20.7`, the newest tag is `v4.6.2`, and `contrib/alpine/APKBUILD` pins
  `4.4.0`. `shore --version` prints the Cargo one, so it will not match the
  formula version. Pick one before publishing.

## Verifying a change

From a checkout, with the formulae copied into the tap:

```sh
brew style mythofmeat/shore
brew audit --strict --formula mythofmeat/shore/shore-daemon
brew install --build-from-source --HEAD mythofmeat/shore/shore-daemon
brew test mythofmeat/shore/shore-daemon
```

## The daemon service

`brew services start shore-daemon` generates a LaunchAgent from the `service`
block: restart on crash, logs to `$(brew --prefix)/var/log/shore-daemon.log`.
It is the counterpart of `contrib/systemd/shore-daemon.service`, minus
`SHORE_MATRIX_BIN` — nothing reads that variable any more, the Matrix bridge
lives in the daemon itself (`daemon/src/connections/matrix/`).

Credentials are the wrinkle. Provider keys are only ever read from the
environment (`daemon/src/llm/credentials.ts`), and a LaunchAgent does not
inherit your shell, so `ANTHROPIC_API_KEY` exported in `.zshrc` is invisible to
it. The agent therefore runs with `~/.config/shore` as its working directory,
and Bun auto-loads `.env` from the working directory:

```sh
mkdir -p ~/.config/shore && chmod 700 ~/.config/shore
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' >> ~/.config/shore/.env
chmod 600 ~/.config/shore/.env
```

That directory has to exist before the first `brew services start`; launchd
fails a job whose working directory is missing.

## Known gaps on macOS

Neither blocks packaging, both are visible to anyone using a Mac:

- **Notifications.** The daemon and the cache-anomaly warning both shell out to
  `notify-send`, which does not exist here (`daemon/src/notifications.ts:46`,
  `daemon/src/ledger/record.ts:125`). `terminal-notifier` or an `osascript`
  shim would be the substitute.
- **Image paste in the TUI.** `client/shore-tui/src/clipboard.rs:69` shells out
  to `wl-paste`; the macOS equivalent is `pbpaste` or an AppleScript call.

## Builds are not reproducible

There is no `bun.lock` in the repo, so `bun install` resolves dependency ranges
afresh at build time — two builds of the same tag can embed different
dependency versions. `contrib/alpine` and `contrib/arch` have the same hole.
Committing a lockfile and switching the formula to `bun install
--frozen-lockfile` would close it.

## Codesigning

Not needed for the tap: Homebrew builds locally, and a locally-built binary
carries no quarantine attribute. The tarballs the `macos` job in
`.github/workflows/release.yml` attaches to the release are a different matter
— downloaded through a browser they are quarantined, and unsigned binaries will
be refused by Gatekeeper. Signing and notarizing them needs a paid Apple
Developer ID plus credentials in CI, and is only worth doing if distribution
outside Homebrew is wanted.
