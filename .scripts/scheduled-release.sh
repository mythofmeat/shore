#!/usr/bin/bash
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/.scripts"

./update-deps.sh

CHANGES=$(git status --porcelain)
if ! [ -n "$CHANGES" ]; then
    echo "No dependency updates!"
    exit 0
elif ./test.sh; then
    git commit -am "chore(deps): scheduled update"
    git push
    ./scheduled-release.sh patch
fi
