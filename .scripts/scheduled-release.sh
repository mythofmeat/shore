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
    git switch -C "automated/$(date -I)"
    git commit -am "chore(deps): scheduled update"
    git push
    gh pr create --dry-run -b '' -t "chore(deps): $(date -I)"
fi
