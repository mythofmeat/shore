#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

git pull || true

PREFIX="${PREFIX:-/usr/local}"
BINDIR="$PREFIX/bin"

BINARIES=(
    "shore"
    "shore-daemon"
    "shore-matrix"
    "shore-tui"
)

cargo build --release --workspace

for bin in "${BINARIES[@]}"; do
    echo "Installing to $BINDIR..."
    sudo install -Dm755 target/release/"$bin" "$BINDIR/$bin"
done

cd ./backend/llm-sidecar
bun install
bun update
bun run build
sudo install -Dm755 ./dist/shore-llm-sidecar "$BINDIR/shore-llm-sidecar"

echo
