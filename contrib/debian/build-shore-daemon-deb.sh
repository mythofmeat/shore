#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$REPO_ROOT"

for cmd in awk bun cargo du install mktemp tar uname; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: required command not found: $cmd" >&2
        exit 1
    fi
done

if ! command -v dpkg-deb >/dev/null 2>&1 && ! command -v ar >/dev/null 2>&1; then
    echo "error: required command not found: dpkg-deb or ar" >&2
    exit 1
fi

build_deb_with_ar() {
    local pkg_root=$1
    local pkg_path=$2
    local tmp

    tmp=$(mktemp -d)
    printf '2.0\n' >"$tmp/debian-binary"

    (
        cd "$pkg_root/DEBIAN"
        tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$tmp/control.tar.gz" .
    )
    (
        cd "$pkg_root"
        tar --exclude=./DEBIAN --sort=name --owner=0 --group=0 --numeric-owner \
            -czf "$tmp/data.tar.gz" .
    )
    (
        cd "$tmp"
        ar rcs "$pkg_path" debian-binary control.tar.gz data.tar.gz
    )

    rm -rf "$tmp"
}

PKG_NAME=${PKG_NAME:-shore-daemon}
PKG_VERSION=${PKG_VERSION:-$(awk -F '"' '/^version = / { print $2; exit }' backend/daemon/Cargo.toml)}
# The crate version was reset 16.1.0 -> 0.1.0. The control Version below carries
# an epoch (default 1) so `1:0.1.0` sorts above the old `16.1.0` and apt offers
# it as an upgrade rather than refusing a downgrade. (Mirrored `epoch=1` in
# the Arch PKGBUILD, which has since been removed.)
if [[ -z "$PKG_VERSION" ]]; then
    echo "error: could not read backend/daemon package version" >&2
    exit 1
fi

if [[ -n "${DEB_ARCH:-}" ]]; then
    ARCH=$DEB_ARCH
elif command -v dpkg >/dev/null 2>&1; then
    ARCH=$(dpkg --print-architecture)
else
    case "$(uname -m)" in
        x86_64) ARCH=amd64 ;;
        aarch64 | arm64) ARCH=arm64 ;;
        armv6l | armv7l) ARCH=armhf ;;
        *)
            echo "error: set DEB_ARCH for architecture $(uname -m)" >&2
            exit 1
            ;;
    esac
fi

# `bun` is a runtime dependency: the sidecar ships as a Bun-script bundle with a
# `#!/usr/bin/env bun` shebang (not a self-contained binary), so the target must
# provide `/usr/bin/bun`. (The removed Arch PKGBUILD declared the same
# `depends=('bun')`.)
DEB_DEPENDS=${DEB_DEPENDS:-"ca-certificates, libssl3, bun"}
OUT_DIR=${OUT_DIR:-"$REPO_ROOT/target/debian"}
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-target}
export CARGO_TARGET_DIR
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-stable}

mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
PKG_ROOT="$OUT_DIR/${PKG_NAME}_${PKG_VERSION}_${ARCH}"
PKG_PATH="$OUT_DIR/${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb"

rm -rf "$PKG_ROOT"
mkdir -p "$PKG_ROOT/DEBIAN"

cargo build --release --frozen -p shore-daemon

(
    cd backend/llm-sidecar
    bun install --frozen-lockfile
    bun run build
)

install -Dm755 "$CARGO_TARGET_DIR/release/shore-daemon" \
    "$PKG_ROOT/usr/bin/shore-daemon"
# Kept out of /usr/bin on purpose: the daemon supervises this directly and
# resolves it via SHORE_LLM_SIDECAR_BIN=/usr/lib/shore/shore-llm-sidecar (see
# contrib/shore-daemon.service), so it must not be runnable by name off $PATH.
install -Dm755 backend/llm-sidecar/dist/shore-llm-sidecar \
    "$PKG_ROOT/usr/lib/shore/shore-llm-sidecar"

install -Dm644 contrib/shore-daemon.service \
    "$PKG_ROOT/usr/lib/systemd/user/shore-daemon.service"

install -Dm644 examples/config.toml \
    "$PKG_ROOT/usr/share/doc/shore/config.toml.example"
install -Dm644 examples/models.toml \
    "$PKG_ROOT/usr/share/doc/shore/models.toml.example"
install -Dm644 examples/client.toml \
    "$PKG_ROOT/usr/share/doc/shore/client.toml.example"

install -d "$PKG_ROOT/usr/share/doc/$PKG_NAME"
printf 'Shore is private software. All rights reserved.\n' \
    >"$PKG_ROOT/usr/share/doc/$PKG_NAME/copyright"

INSTALLED_SIZE=$(du -sk "$PKG_ROOT/usr" | awk '{ print $1 }')
cat >"$PKG_ROOT/DEBIAN/control" <<CONTROL
Package: $PKG_NAME
Version: ${PKG_EPOCH:-1}:$PKG_VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Maintainer: eshen
Depends: $DEB_DEPENDS
Installed-Size: $INSTALLED_SIZE
Description: Persistent AI character engine daemon
 Shore daemon plus the supervised LLM sidecar binary.
CONTROL

if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb --root-owner-group --build "$PKG_ROOT" "$PKG_PATH"
else
    build_deb_with_ar "$PKG_ROOT" "$PKG_PATH"
fi

echo "$PKG_PATH"
