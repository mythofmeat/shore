#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PREFIX="${PREFIX:-/usr/local}"
BINDIR="$PREFIX/bin"
LIBEXECDIR="$PREFIX/lib/shore"

BINARIES=(
    "shore"
    "shore-daemon"
)

HELPERS=(
    "shore-matrix"
)

cargo sweep --stamp || true
cargo build --release --workspace --exclude shore-tui
# shore-tui builds under [profile.tui-release] — fat LTO, abort on panic, both
# of which are profile-global in cargo and so need an invocation of their own.
# The Arch PKGBUILD and scripts/install.sh build it the same way.
cargo build --profile tui-release -p shore-tui
cargo sweep --file || true

echo "Installing to $BINDIR..."
for bin in "${BINARIES[@]}"; do
    sudo install -Dm755 target/release/"$bin" "$BINDIR/$bin"
done
sudo install -Dm755 target/tui-release/shore-tui "$BINDIR/shore-tui"

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
