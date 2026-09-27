#!/usr/bin/bash
set -eu
cd "$(dirname -- "$0")"

srcdir="$(git rev-parse --show-toplevel)"
cd "$srcdir/.scripts"

update_deps() {
    ./update-deps.sh
    if ! [ -n "$(git status --porcelain)" ]; then
        echo "No dependency updates!"
        exit 0
    else
        git commit -am "chore(deps): scheduled update"
    fi
}

bump_version() {
    ver=$(./check-version.sh)
    IFS='.' read -ra ver_parts <<<"$ver"
    ver_parts[2]=$((${ver_parts[2]#v} + 1))
    bumped_ver=$(
        IFS='.'
        echo "${ver_parts[*]}"
    )
    ./version-bump.sh "$bumped_ver"
    git commit -am "chore(release): $bumped_ver" --no-verify
}

update_deps
bump_version
git push
./release-gh.sh

main
