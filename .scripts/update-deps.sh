#!/bin/sh
set -eu

usage() {
    printf 'Usage: %s\nUpdate stable toolchains, Cargo tooling, and daemon/client dependencies (including major versions).\n' "$0"
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac
if [ "$#" -ne 0 ]; then
    usage >&2
    exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_TOOLCHAIN=stable
export PATH="${CARGO_HOME:-"$HOME/.cargo"}/bin:$PATH"
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-"$root/daemon/node_modules/.cache/bun-install"}"

run() {
    printf '\n>>> %s\n' "$*"
    if "$@"; then
        return 0
    else
        status=$?
        printf '\nUpdate failed (exit %s): %s\n' "$status" "$*" >&2
        printf 'Earlier updates may have succeeded. Resolve the failure and rerun before testing or releasing.\n' >&2
        bun --version || true
        rustup --version || true
        cargo --version || true
        cargo upgrade --version || true
        exit "$status"
    fi
}

cd "$root"
run bun upgrade
run rustup update stable
run rustup component add --toolchain stable rustfmt clippy
run cargo install cargo-edit --locked

cd "$root/daemon"
run bun update --latest
run bun install

cd "$root/client"
run cargo upgrade --incompatible
run cargo update

printf '\nDependency updates completed. Run .scripts/test.sh, then review and commit dependency changes separately.\n'
