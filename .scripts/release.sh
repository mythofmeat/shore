#!/bin/sh
set -eu

usage() {
    printf 'Usage: %s <major|minor|patch>\nBump the latest stable vMAJOR.MINOR.PATCH tag and tag the current commit locally.\n' "$0"
}

case "${1:-}" in
-h | --help)
    usage
    exit 0
    ;;
esac
if [ "$#" -ne 1 ]; then
    usage >&2
    exit 2
fi
case "$1" in
major | minor | patch) bump=$1 ;;
*)
    usage >&2
    exit 2
    ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
tags=$(git tag --list --sort=-version:refname)
latest=$(printf '%s\n' "$tags" | LC_ALL=C awk '/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ && !found { print; found = 1 }')
version=${latest:-v0.0.0}
version=${version#v}
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
patch=${rest#*.}

case "$bump" in
major)
    major=$((major + 1))
    minor=0
    patch=0
    ;;
minor)
    minor=$((minor + 1))
    patch=0
    ;;
patch) patch=$((patch + 1)) ;;
esac

tag="v$major.$minor.$patch"
git tag "$tag"
git push origin --tag
printf 'Created local tag %s at %s.\n' "$tag" "$(git rev-parse --short HEAD)"
