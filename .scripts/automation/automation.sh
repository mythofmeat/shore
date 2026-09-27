#!/usr/bin/bash
set -eu
cd "$(dirname -- "$0")"

srcdir="$(git rev-parse --show-toplevel)"

update_deps() {
    "$srcdir"/.scripts/update-deps.sh
    if ! [ -n "$(git status --porcelain)" ]; then
        echo "No dependency updates!"
        exit 0
    else
        git commit -am "chore(deps): scheduled update"
    fi
}

bump_version() {
    ver=$("$srcdir"/.scripts/check-version.sh)
    IFS='.' read -ra ver_parts <<<"$ver"
    ver_parts[2]=$((${ver_parts[2]#v} + 1))
    bumped_ver=$(
        IFS='.'
        echo "${ver_parts[*]}"
    )
    "$srcdir"/.scripts/version-bump.sh "$bumped_ver"
    git commit -am "chore(release): v$bumped_ver" --no-verify
    git tag "$bumped_ver"
}

update_deps
bump_version
git push --tags
"$srcdir"/.scripts/release-gh.sh

main
