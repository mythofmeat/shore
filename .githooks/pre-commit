#!/bin/sh
set -u

root=$(CDPATH= cd -- "$(git rev-parse --show-toplevel)" && pwd)
failed=""

if [ -z "${BUN_INSTALL_CACHE_DIR:-}" ]; then
    BUN_INSTALL_CACHE_DIR="$root/daemon/node_modules/.cache/bun-install"
    export BUN_INSTALL_CACHE_DIR
fi

run() {
    name=$1
    shift
    printf '\n===== %s =====\n' "$name"
    if ! "$@"; then
        failed="$failed $name"
    fi
}

dependency_state() {
    for path in "$@"; do
        if [ -f "$root/$path" ]; then
            git hash-object -- "$root/$path" || return 1
        else
            printf 'missing %s\n' "$path"
        fi
    done
}

stop_for_dependency_update() {
    ecosystem=$1
    shift

    printf '\n===== dependency updates require review =====\n'
    printf '%s updated dependency manifests or lockfiles during this hook:\n\n' "$ecosystem"
    git -C "$root" status --short -- "$@"
    printf '\nThe commit was stopped so its index cannot differ from the dependencies that get tested.\n'
    printf 'Review these updates, put unrelated work aside (for example with git stash),\n'
    printf 'and create a dedicated dependency-update commit. Then restore your work and retry.\n'
    exit 1
}

require_staged_dependencies() {
    ecosystem=$1
    shift

    if git -C "$root" diff --quiet -- "$@"; then
        return
    fi

    printf '\n===== dependency updates are not staged =====\n'
    printf '%s dependency files differ from the index that would be committed:\n\n' "$ecosystem"
    git -C "$root" status --short -- "$@"
    printf '\nThe commit was stopped so the tested dependencies cannot differ from its index.\n'
    printf 'Review these updates, put unrelated work aside (for example with git stash),\n'
    printf 'and create a dedicated dependency-update commit. Then restore your work and retry.\n'
    exit 1
}

bun_files="daemon/package.json daemon/bun.lock"
bun_before=$(dependency_state $bun_files) || exit 1

cd "$root/daemon" || exit 1
run "bun-updates" \
    bun update --latest
run "bun-install" \
    bun install
bun_after=$(dependency_state $bun_files) || exit 1
if [ "$bun_before" != "$bun_after" ]; then
    stop_for_dependency_update "Bun" $bun_files
fi
require_staged_dependencies "Bun" $bun_files
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

cargo_files=$(git -C "$root" ls-files -- \
    'client/Cargo.toml' \
    'client/**/Cargo.toml' \
    'client/Cargo.lock') || exit 1
cargo_before=$(dependency_state $cargo_files) || exit 1

cd "$root/client" || exit 1
run "cargo-upgrade" \
    cargo upgrade --incompatible
cargo_after=$(dependency_state $cargo_files) || exit 1
if [ "$cargo_before" != "$cargo_after" ]; then
    stop_for_dependency_update "Cargo" $cargo_files
fi
require_staged_dependencies "Cargo" $cargo_files
run "cargo-test" \
    cargo test --workspace
run "cargo-fmt" \
    cargo fmt --all --check
run "cargo-clippy" \
    cargo clippy --workspace --all-targets

if [ -n "$failed" ]; then
    printf '\nfailed:%s\n' "$failed"
    exit 1
fi

printf '\nall checks passed\n'
