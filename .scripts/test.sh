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

# Tests run with an empty home and none of the developer's shore settings, as they do in CI.
# With --own-tmp they also get a temp dir inside that home, and anything they leave in it fails the
# check. That home is kept in memory where the system offers it: the daemon's stores fsync every
# write, which a CI runner's disk turns into multi-second stalls and spurious test timeouts. Cargo
# runs without it: a compiler cache server started under it would outlive the run and be left
# pointing at a deleted temp dir.
hermetic() {
    tmp_var=""
    if [ "$1" = "--own-tmp" ]; then
        shift
        if [ -d /dev/shm ] && [ -w /dev/shm ]; then
            home=$(mktemp -d -p /dev/shm)
        else
            home=$(mktemp -d)
        fi
        mkdir "$home/tmp"
        tmp_var="TMPDIR=$home/tmp"
    else
        home=$(mktemp -d)
    fi
    shore_vars=$(env | sed -n 's/^\(SHORE_[A-Za-z0-9_]*\)=.*/-u \1/p')
    if env $shore_vars $tmp_var \
        RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
        CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" \
        BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}" \
        HOME="$home" \
        XDG_CONFIG_HOME="$home/config" \
        XDG_DATA_HOME="$home/data" \
        XDG_CACHE_HOME="$home/cache" \
        XDG_RUNTIME_DIR="$home/run" \
        "$@"; then
        status=0
    else
        status=$?
    fi
    if [ -n "$tmp_var" ]; then
        leftovers=$(find "$home/tmp" -mindepth 1 -maxdepth 1 | sed "s|^$home/tmp/||" | head -20)
        if [ -n "$leftovers" ]; then
            printf 'tests left these in their temp dir instead of removing them:\n%s\n' "$leftovers" >&2
            [ "$status" -ne 0 ] || status=1
        fi
    fi
    rm -rf "$home"
    return "$status"
}

# Fails when regenerating changed or added any of the given paths. A git hook exports GIT_DIR,
# which makes git treat the current directory as the work tree root, so it is cleared here.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
unchanged() {
    git diff --exit-code -- "$@" && test -z "$(git ls-files --others --exclude-standard -- "$@")"
}

browser_generated() {
    bun run browser:generate &&
        unchanged 'src/browser/*validators.generated.js' 'src/browser/*validators.generated.d.ts' \
            src/browser/preferences.generated.ts
}

inventory_generated() {
    bun run inventory:generate && unchanged ../docs/capabilities/daemon.generated.json
}

client_generated() {
    for export in export_bindings export_operation_schemas export_web_schemas export_wire_schemas; do
        cargo test -p shore-common --lib "$export" --locked || return
    done
    cargo test -p shore-cli export_capability_inventory --locked -- --ignored || return
    unchanged ../daemon/src/protocol ../daemon/src/operations/schemas.generated.json \
        ../daemon/src/web/schemas.generated.json ../docs/capabilities/terminal.generated.json
}

for group in "$@"; do
    case "$group" in
    lint)
        cd "$root/daemon"
        run bun-lint bun run lint
        run bun-lint-comments bun run lint:comments
        run bun-lint-citations bun run lint:citations
        run bun-lint-test-env bun run lint:test-env
        run bun-typecheck bun run typecheck
        run browser-check bun run browser:check
        run browser-generated browser_generated
        run inventory-check bun run inventory:check
        run inventory-generated inventory_generated
        ;;
    daemon)
        cd "$root/daemon"
        run bun-build bun run build
        run bun-test hermetic --own-tmp bun test
        run bun-mutate-stale bun run mutate --stale
        run bun-rerecord-check bun run rerecord:check
        run browser-test bun run test:browser
        run web-assets-generated unchanged src/web/assets.generated.ts
        ;;
    client)
        cd "$root/client"
        run cargo-test hermetic cargo test --workspace --locked -- --skip cli_and_terminal_reliability_flows
        run cargo-end-to-end hermetic cargo test -p shore-cli --test reliability --locked
        run cargo-fmt cargo fmt --all --check
        run cargo-clippy cargo clippy --workspace --all-targets --locked
        run client-generated client_generated
        ;;
    esac
done

if [ -n "$failed" ]; then
    printf '\nFailed checks:%s\n' "$failed" >&2
    exit 1
fi

printf '\nAll checks passed.\n'
