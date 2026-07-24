#!/usr/bin/env bash
# Personal install: build every binary from this checkout and install the
# suite into a self-contained, backup-friendly app dir (default ~/shore).
#
#   ~/shore/
#     bin/      shore-daemon, shore, shore-tui, shore-matrix, shore-llm-sidecar
#     config/   config.toml, .env, characters (SHORE_CONFIG_DIR)
#     data/     daemon + bridge state, ledgers   (SHORE_DATA_DIR)
#     cache/    rebuildable                      (SHORE_CACHE_DIR)
#     env       the SHORE_*_DIR assignments, sourced by units and wrappers
#
# Back up config/ + data/ (stop the daemon first, or snapshot the filesystem —
# live sqlite copies can tear). bin/ and cache/ are derivable; skip them.
#
# Builds reuse this checkout's target/ dir, so repeat runs are incremental and
# no build artifacts land in the app dir. Rerun after `git pull` to update; a
# daemon unit installed by this script is restarted automatically, hand-managed
# units are never touched.
#
# The systemd user units are only written when absent or when the existing
# file carries this script's "Managed by" marker. A hand-managed unit is left
# alone and the fresh version is written next to it as <unit>.new.
#
# --adopt copies an existing XDG-dirs deployment (~/.config/shore,
# ~/.local/share/shore) into the app dir. It refuses while shore-daemon is
# active and never deletes the originals.
#
# Overridable via environment: SHORE_HOME, SHORE_UNIT_DIR, SHORE_BIN_LINK_DIR,
# SHORE_FISH_COMP_DIR.

set -euo pipefail

SHORE_HOME="${SHORE_HOME:-$HOME/shore}"
UNIT_DIR="${SHORE_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
BIN_LINK_DIR="${SHORE_BIN_LINK_DIR:-$HOME/.local/bin}"
FISH_COMP_DIR="${SHORE_FISH_COMP_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# Managed by scripts/install.sh — edits are overwritten on reinstall; delete this line to take ownership."

adopt=false
for arg in "$@"; do
    case "$arg" in
        --adopt) adopt=true ;;
        -h|--help)
            sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
    esac
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

for tool in cargo bun install; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

# ── Build ────────────────────────────────────────────────────────────────
say "Building workspace binaries (incremental, reuses target/)"
cargo build --release --manifest-path "$REPO/Cargo.toml" \
    -p shore-daemon -p shore-cli -p shore-matrix

# shore-tui builds under [profile.tui-release] — fat LTO, abort on panic, both
# of which are profile-global in cargo and so need an invocation of their own.
# install.sh and the Arch PKGBUILD build it the same way, so every shore-tui
# that ships is the same binary.
cargo build --profile tui-release --manifest-path "$REPO/Cargo.toml" -p shore-tui

say "Building LLM sidecar"
(cd "$REPO/backend/llm-sidecar" && bun install --frozen-lockfile --silent && bun run build >/dev/null)

# ── App dir ──────────────────────────────────────────────────────────────
say "Installing into $SHORE_HOME"
mkdir -p "$SHORE_HOME/bin" "$SHORE_HOME/config" "$SHORE_HOME/data" "$SHORE_HOME/cache"

# shore-matrix sits next to shore-daemon on purpose: bin/ is off $PATH, and
# binary presence is what enables in-daemon bridge supervision (the unit's
# SHORE_MATRIX_BIN points here). Remove it from bin/ to disable the bridge.
for bin in shore-daemon shore shore-matrix; do
    install -m755 "$REPO/target/release/$bin" "$SHORE_HOME/bin/$bin"
done
install -m755 "$REPO/target/tui-release/shore-tui" "$SHORE_HOME/bin/shore-tui"
install -m755 "$REPO/backend/llm-sidecar/dist/shore-llm-sidecar" "$SHORE_HOME/bin/shore-llm-sidecar"

# The env file is config, not a build product: write once, never clobber.
if [[ ! -f "$SHORE_HOME/env" ]]; then
    cat > "$SHORE_HOME/env" <<EOF
SHORE_CONFIG_DIR=$SHORE_HOME/config
SHORE_DATA_DIR=$SHORE_HOME/data
SHORE_CACHE_DIR=$SHORE_HOME/cache
EOF
    note "wrote $SHORE_HOME/env"
fi

# ── Adopt an existing XDG deployment ─────────────────────────────────────
if $adopt; then
    say "Adopting XDG-dirs deployment into $SHORE_HOME"
    command -v rsync >/dev/null || { echo "--adopt needs rsync" >&2; exit 1; }
    if systemctl --user is-active --quiet shore-daemon 2>/dev/null; then
        echo "shore-daemon is running — stop it first: systemctl --user stop shore-daemon" >&2
        exit 1
    fi
    if [[ -e "$SHORE_HOME/config/config.toml" ]]; then
        echo "$SHORE_HOME/config/config.toml already exists — refusing to adopt over it" >&2
        exit 1
    fi
    [[ -d "$HOME/.config/shore" ]]      && rsync -a "$HOME/.config/shore/"      "$SHORE_HOME/config/"
    [[ -d "$HOME/.local/share/shore" ]] && rsync -a "$HOME/.local/share/shore/" "$SHORE_HOME/data/"
    note "copied (not moved) — originals remain until you delete them yourself"
fi

# ── Wrappers on PATH ─────────────────────────────────────────────────────
# Wrappers, not symlinks: clients must see the same SHORE_*_DIR as the daemon
# or they would read the XDG config instead of the app dir's.
say "Installing wrappers in $BIN_LINK_DIR"
mkdir -p "$BIN_LINK_DIR"
for bin in shore shore-tui; do
    cat > "$BIN_LINK_DIR/$bin" <<EOF
#!/bin/sh
$MARKER
set -a; . "$SHORE_HOME/env"; set +a
exec "$SHORE_HOME/bin/$bin" "\$@"
EOF
    chmod 755 "$BIN_LINK_DIR/$bin"
done

# ── Fish completions ─────────────────────────────────────────────────────
if command -v fish >/dev/null; then
    mkdir -p "$FISH_COMP_DIR"
    "$SHORE_HOME/bin/shore" completions fish > "$FISH_COMP_DIR/shore.fish"
fi

# ── systemd user units ───────────────────────────────────────────────────
# Only overwrite units this script wrote (identified by the marker); a
# hand-managed unit is preserved and the new one lands beside it as .new.
write_unit() {
    local name="$1" content="$2" target="$UNIT_DIR/$1"
    if [[ -f "$target" ]] && ! grep -qF "Managed by scripts/install.sh" "$target"; then
        printf '%s\n' "$content" > "$target.new"
        note "$name is hand-managed — wrote $target.new instead"
        return 1
    fi
    printf '%s\n' "$content" > "$target"
    note "wrote $target"
}

say "Installing systemd user units"
mkdir -p "$UNIT_DIR"

daemon_unit="[Unit]
$MARKER
Description=Shore daemon — persistent AI character engine
After=network.target

[Service]
Type=simple
ExecStart=$SHORE_HOME/bin/shore-daemon
Restart=on-failure
RestartSec=5

EnvironmentFile=$SHORE_HOME/env
Environment=RUST_LOG=warn,shore_daemon=info,shore_llm=info,shore_ledger=info,shore_swp_server=info
Environment=SHORE_MATRIX_RUST_LOG=warn,shore_matrix=info,matrix_sdk_crypto::backups=error
Environment=SHORE_LLM_SIDECAR_BIN=$SHORE_HOME/bin/shore-llm-sidecar
Environment=SHORE_MATRIX_BIN=$SHORE_HOME/bin/shore-matrix
RuntimeDirectory=shore
Environment=SHORE_RUNTIME_DIR=%t/shore

# Hardening — the daemon may only write inside the app dir and its runtime dir.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$SHORE_HOME/config $SHORE_HOME/data $SHORE_HOME/cache
PrivateTmp=yes

[Install]
WantedBy=default.target"

notify_unit="[Unit]
$MARKER
Description=Shore desktop notifications

[Service]
Type=simple
ExecStart=$SHORE_HOME/bin/shore notify --all-messages
Restart=on-failure
RestartSec=5

EnvironmentFile=$SHORE_HOME/env
EnvironmentFile=-$SHORE_HOME/config/notify.env
Environment=RUST_LOG=warn
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%U/bus

[Install]
WantedBy=default.target"

daemon_owned=true
write_unit shore-daemon.service "$daemon_unit" || daemon_owned=false
write_unit shore-notify.service "$notify_unit" || true

# Reload/restart only when writing to the directory systemd actually reads —
# with SHORE_UNIT_DIR pointed elsewhere (tests, staging) systemd never sees
# these files and touching the live services would be wrong.
real_unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if command -v systemctl >/dev/null && [[ "$UNIT_DIR" == "$real_unit_dir" ]]; then
    systemctl --user daemon-reload 2>/dev/null || true
    if $daemon_owned && systemctl --user is-active --quiet shore-daemon 2>/dev/null; then
        say "Restarting shore-daemon (unit is script-managed and was active)"
        systemctl --user restart shore-daemon
    fi
fi

# ── Summary ──────────────────────────────────────────────────────────────
say "Done"
note "app dir:   $SHORE_HOME  (back up config/ + data/; bin/ and cache/ are derivable)"
note "clients:   $BIN_LINK_DIR/shore, $BIN_LINK_DIR/shore-tui (wrappers exporting the app-dir env)"
if ! $daemon_owned; then
    note "daemon:    your existing unit was left alone; review $UNIT_DIR/shore-daemon.service.new,"
    note "           then swap it in and: systemctl --user daemon-reload && systemctl --user restart shore-daemon"
fi
if [[ ! -e "$SHORE_HOME/config/config.toml" && -d "$HOME/.config/shore" ]]; then
    note "migrate:   existing XDG deployment detected — rerun with --adopt to copy it in"
    note "           (stop the daemon first: systemctl --user stop shore-daemon)"
fi
