#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

git pull || true

PREFIX="${PREFIX:-/usr/local}"
BINDIR="$PREFIX/bin"
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
done

(
    cd ./backend/llm-sidecar
    bun install
    bun update
    bun run build
)
sudo install -Dm755 ./backend/llm-sidecar/dist/shore-llm-sidecar "$LIBEXECDIR/shore-llm-sidecar"

sudo install -Dm644 ./contrib/shore-daemon.service /usr/lib/systemd/user/shore-daemon.service
sudo install -Dm644 ./contrib/shore-notify.service /usr/lib/systemd/user/shore-notify.service

if command -v fish &> /dev/null; then
    "$BINDIR/shore" completions fish > ./target/shore.fish
    sudo install -Dm755 ./target/shore.fish /usr/share/fish/vendor_completions.d/shore.fish
    rm -f ./target/shore.fish
fi

echo
