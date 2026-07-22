#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

git pull || true

PREFIX="${PREFIX:-/usr/local}"
BINDIR="$PREFIX/bin"
# Helpers other processes spawn, never a human: kept off $PATH and reached
# through SHORE_*_BIN in contrib/shore-daemon.service.
LIBEXECDIR="$PREFIX/lib/shore"

BINARIES=(
    "shore"
    "shore-daemon"
    "shore-tui"
)

HELPERS=(
    "shore-matrix"
)

cargo build --release --workspace

echo "Installing to $BINDIR..."
for bin in "${BINARIES[@]}"; do
    sudo install -Dm755 target/release/"$bin" "$BINDIR/$bin"
done

echo "Installing to $LIBEXECDIR..."
for bin in "${HELPERS[@]}"; do
    sudo install -Dm755 target/release/"$bin" "$LIBEXECDIR/$bin"
    # A copy left on $PATH by an older install would shadow the libexec one.
    sudo rm -f "$BINDIR/$bin"
done

cd ./backend/llm-sidecar
bun install
bun update
bun run build
sudo install -Dm755 ./dist/shore-llm-sidecar "$LIBEXECDIR/shore-llm-sidecar"
sudo rm -f "$BINDIR/shore-llm-sidecar" "$PREFIX/lib/shore-llm-sidecar"

echo
