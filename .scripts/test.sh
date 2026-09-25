#!/bin/sh
set -u

# A git hook exports these, which would point any git command the tests run at this repo.
unset $(git rev-parse --local-env-vars)
# The tests must not reach the shore daemon and settings this shell is set up for.
for var in $(env | sed -n 's/^\(SHORE_[A-Za-z0-9_]*\)=.*/\1/p'); do
    unset "$var"
done

root=$(CDPATH= cd -- "$(git rev-parse --show-toplevel)" && pwd)
failed=""

if [ -z "${BUN_INSTALL_CACHE_DIR:-}" ]; then
    BUN_INSTALL_CACHE_DIR="$root/daemon/node_modules/.cache/bun-install"
    export BUN_INSTALL_CACHE_DIR
fi
command -v sccache &&
    export RUSTC_WRAPPER=sccache

run() {
    name=$1
    shift
    printf '\n===== %s =====\n' "$name"
    if ! "$@"; then
        failed="$failed $name"
    fi
}

if cd "$root/daemon"; then
    run "bun-install" \
        bun install
    run "bun-lint" \
        bun run lint
    run "bun-lint-comments" \
        bun run lint:comments
    run "bun-lint-citations" \
        bun run lint:citations
    run "bun-typecheck" \
        bun run typecheck
    run "bun-test" \
        bun test
    run "bun-mutate-stale" \
        bun run mutate --stale
    run "bun-rerecord-check" \
        bun run rerecord:check
    run "bun-build" \
        bun run build
else
    exit 1
fi

if cd "$root/client"; then
    run "cargo-test" \
        cargo test --workspace
    run "cargo-fmt" \
        cargo fmt --all --check
    run "cargo-clippy" \
        cargo clippy --workspace --all-targets
else
    exit 1
fi

if [ -n "$failed" ]; then
    printf '\nfailed:%s\n' "$failed"
    exit 1
fi

printf '\nall checks passed\n'
