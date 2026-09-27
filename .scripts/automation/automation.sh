#!/usr/bin/bash
set -eu
cd "$(dirname -- "$0")"

srcdir="$(git rev-parse --show-toplevel)"
cd "$srcdir/.scripts"

main() {

    git commit -am "chore(deps): scheduled update"

    ver=$(./check-version.sh)
    IFS='.' read -ra ver_parts <<<"$ver"
    ver_parts[2]=$((${ver_parts[2]#v} + 1))
    bumped_ver=$(
        IFS='.'
        echo "${ver_parts[*]}"
    )

    ./version-bump.sh "$bumped_ver"
    # TODO: THERE NEEDS TO BE SOMETHING THAT COMMITS THE CHANGES LOL
    git commit -am "chore(release ) "
    ./release-gh.sh # TODO: TEST
    ./check-version.sh
}

./update-deps.sh
if ! [ -n "$(git status --porcelain)" ]; then
    echo "No dependency updates!"
    exit 0
else
    main
fi
