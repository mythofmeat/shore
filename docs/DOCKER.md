# Claude Code authentication in Docker

Share the host's Claude Code credential directory with the daemon using a
read-write directory mount. For example, if the host CLI uses
`CLAUDE_CONFIG_DIR=/srv/shore/claude-agent`:

```yaml
services:
  shore-daemon:
    environment:
      - CLAUDE_CONFIG_DIR=/claude-agent
    volumes:
      - /srv/shore/claude-agent:/claude-agent
```

Run the container as a user that can read and write that directory. Mount the
directory rather than only `.credentials.json`, because Claude Code replaces
the credentials file when it refreshes tokens.

Shore keeps authentication pointed at this directory even when the Agent SDK
restores a conversation into a temporary config directory. SDK 0.3.270's
`sessionStore` restore copies credentials into that temporary directory after
removing their refresh token. Using that copy can produce `401 OAuth access
token has expired` on continued or regenerated turns while the host CLI remains
authenticated. Restarting Shore recreates the same unrefreshable copy.

Shore sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` for SDK subprocesses to the original
`CLAUDE_CONFIG_DIR`, or Claude Code's default credential location when it is
unset. Claude Code owns token refresh and writes refreshed credentials back to
the shared store. Shore does not read or copy the tokens itself.

If you explicitly set `CLAUDE_SECURESTORAGE_CONFIG_DIR`, Shore preserves it,
including an empty value (which selects Claude Code's default credential
location). This also supports keeping authentication and SDK session files in
separate directories. A separate authentication directory is optional.

This example uses Linux file-backed credentials. A macOS Keychain login is not
exposed to a Linux container by mounting `~/.claude`.
