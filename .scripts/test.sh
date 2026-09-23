#!/bin/sh
set -eu

usage() {
    printf 'Usage: %s\nRun every daemon and client verification check, reporting all failures.\n' "$0"
}

case "${1:-}" in
-h | --help)
    usage
    exit 0
    ;;
esac
if [ "$#" -ne 0 ]; then
    usage >&2
    exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_TOOLCHAIN=stable
failed=""

run() {
    name=$1
    shift
    printf '\n>>> %s\n' "$name"
    if "$@"; then
        printf 'PASS: %s\n' "$name"
    else
        status=$?
        printf 'FAIL: %s (exit %s)\n' "$name" "$status" >&2
        failed="$failed $name"
    fi
}

cd "$root/daemon"
run bun-lint bun run lint
run bun-lint-comments bun run lint:comments
run bun-lint-citations bun run lint:citations
run bun-typecheck bun run typecheck
run bun-build bun run build
run bun-test bun test
run bun-mutate-stale bun run mutate --stale
run bun-rerecord-check bun run rerecord:check

cd "$root/client"
run cargo-test cargo test --workspace
run cargo-fmt cargo fmt --all --check
run cargo-clippy cargo clippy --workspace --all-targets

if [ -n "$failed" ]; then
    printf '\nFailed checks:%s\n' "$failed" >&2
    exit 1
fi

printf '\nAll checks passed.\n'
