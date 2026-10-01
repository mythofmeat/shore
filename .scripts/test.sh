#!/bin/sh
set -u

usage() {
    printf 'Usage: %s [daemon|client]\nRun every check, or one half of them, and report all failures.\nThe pre-commit hook runs both halves; CI runs each half as its own job.\n' "$0"
}

case "${1:-}" in
"" | daemon | client) only=${1:-} ;;
-h | --help)
    usage
    exit 0
    ;;
*)
    usage >&2
    exit 2
    ;;
esac

# A git hook exports these, which would point any git command the tests run at this repo.
unset $(git rev-parse --local-env-vars)
# The tests must not reach the shore daemon and settings this shell is set up for.
for var in $(env | sed -n 's/^\(SHORE_[A-Za-z0-9_]*\)=.*/\1/p'); do
    unset "$var"
done

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
failed=""

if [ -z "${BUN_INSTALL_CACHE_DIR:-}" ]; then
    BUN_INSTALL_CACHE_DIR="$root/daemon/node_modules/.cache/bun-install"
    export BUN_INSTALL_CACHE_DIR
fi
command -v sccache &&
    export RUSTC_WRAPPER=sccache

# Under GitHub Actions each check folds into its own log group, and a failure is annotated with
# its name so the run summary says which check failed.
run() {
    name=$1
    shift
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        printf '::group::%s\n' "$name"
    else
        printf '\n===== %s =====\n' "$name"
    fi
    "$@"
    status=$?
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        printf '::endgroup::\n'
    fi
    if [ "$status" -ne 0 ]; then
        failed="$failed $name"
        if [ -n "${GITHUB_ACTIONS:-}" ]; then
            printf '::error title=%s failed::exit %s\n' "$name" "$status"
        fi
    fi
}

if [ "$only" != client ]; then
    cd "$root/daemon" || exit 1
    run "bun-install" \
        bun install
    run "bun-lint" \
        bun run lint
    run "bun-lint-comments" \
        bun run lint:comments
    run "bun-lint-citations" \
        bun run lint:citations
    run "bun-lint-test-env" \
        bun run lint:test-env
    run "bun-typecheck" \
        bun run typecheck
    # Before the tests: they run the native patch helper this builds into dist/.
    run "bun-build" \
        bun run build
    run "bun-test" \
        bun test
    run "bun-mutate-stale" \
        bun run mutate --stale
    run "bun-rerecord-check" \
        bun run rerecord:check

    # The desktop app only needs Bun too, so its checks ride along with the daemon's. Its
    # Playwright journeys need a KWin session and stay manual: `bun run test:e2e` in desktop/.
    cd "$root/desktop" || exit 1
    run "desktop-install" \
        bun install
    run "desktop-typecheck" \
        bun run typecheck
    run "desktop-test" \
        bun test
    run "desktop-build" \
        bun run build
fi

if [ "$only" != daemon ]; then
    cd "$root/client" || exit 1
    run "cargo-test" \
        cargo test --workspace
    run "cargo-fmt" \
        cargo fmt --all --check
    run "cargo-clippy" \
        cargo clippy --workspace --all-targets
fi

if [ -n "$failed" ]; then
    printf '\nfailed:%s\n' "$failed"
    exit 1
fi

printf '\nall checks passed\n'
