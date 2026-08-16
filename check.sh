#!/bin/sh
set -u

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
failed=""

run() {
    name=$1
    shift
    printf '\n===== %s =====\n' "$name"
    if ! "$@"; then
        failed="$failed $name"
    fi
}

cd "$root/daemon" || exit 1
run install bun install
run comments bun run lint:comments
run citations bun run lint:citations
run typecheck bun run typecheck
run daemon-tests bun test

cd "$root/client" || exit 1
run fmt cargo fmt --all --check
run clippy cargo clippy --workspace --all-targets
run client-tests cargo test --workspace

if [ -n "$failed" ]; then
    printf '\nfailed:%s\n' "$failed"
    exit 1
fi

printf '\nall checks passed\n'
