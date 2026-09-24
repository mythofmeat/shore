#!/bin/sh
set -eu

groups="lint daemon client"

usage() {
    printf 'Usage: %s [group...]\nRun daemon and client verification checks, reporting all failures.\nGroups: %s (default: all). CI runs these same groups.\n' "$0" "$groups"
}

case "${1:-}" in
-h | --help)
    usage
    exit 0
    ;;
esac
for group in "$@"; do
    case " $groups " in
    *" $group "*) ;;
    *)
        usage >&2
        exit 2
        ;;
    esac
done
if [ "$#" -eq 0 ]; then
    set -- $groups
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_TOOLCHAIN=stable
failed=""

run() {
    name=$1
    shift
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        printf '::group::%s\n' "$name"
    else
        printf '\n>>> %s\n' "$name"
    fi
    if "$@"; then
        status=0
    else
        status=$?
    fi
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        printf '::endgroup::\n'
    fi
    if [ "$status" -eq 0 ]; then
        printf 'PASS: %s\n' "$name"
    else
        printf 'FAIL: %s (exit %s)\n' "$name" "$status" >&2
        if [ -n "${GITHUB_ACTIONS:-}" ]; then
            printf '::error title=%s failed::exit %s\n' "$name" "$status"
        fi
        failed="$failed $name"
    fi
}

for group in "$@"; do
    case "$group" in
    lint)
        cd "$root/daemon"
        run bun-lint bun run lint
        run bun-lint-comments bun run lint:comments
        run bun-lint-citations bun run lint:citations
        run bun-typecheck bun run typecheck
        ;;
    daemon)
        cd "$root/daemon"
        run bun-build bun run build
        run bun-test bun test
        run bun-mutate-stale bun run mutate --stale
        run bun-rerecord-check bun run rerecord:check
        ;;
    client)
        cd "$root/client"
        run cargo-test cargo test --workspace --locked
        run cargo-fmt cargo fmt --all --check
        run cargo-clippy cargo clippy --workspace --all-targets --locked
        ;;
    esac
done

if [ -n "$failed" ]; then
    printf '\nFailed checks:%s\n' "$failed" >&2
    exit 1
fi

printf '\nAll checks passed.\n'
