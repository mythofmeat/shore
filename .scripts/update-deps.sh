#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

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
