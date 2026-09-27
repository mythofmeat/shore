#!/bin/sh
set -eu

usage() {
    printf 'Usage: %s <major|minor|patch|X.Y.Z>\nSet the release version in the manifests, commit it, tag the commit vX.Y.Z, and push the tag with the current branch.\n' "$0"
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

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
    printf 'Working tree is not clean; commit or discard changes first.\n' >&2
    exit 1
fi

# client/Cargo.toml's [workspace.package] version is the source of truth.
current=$(sed -n 's/^version = "\([0-9]*\.[0-9]*\.[0-9]*\)"$/\1/p' client/Cargo.toml)
if [ -z "$current" ]; then
    printf 'No version found in client/Cargo.toml.\n' >&2
    exit 1
fi
major=${current%%.*}
rest=${current#*.}
minor=${rest%%.*}
patch=${rest#*.}

case "$1" in
major) version="$((major + 1)).0.0" ;;
minor) version="$major.$((minor + 1)).0" ;;
patch) version="$major.$minor.$((patch + 1))" ;;
*)
    if ! printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
        usage >&2
        exit 2
    fi
    version=$1
    ;;
esac

tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    printf 'Tag %s already exists.\n' "$tag" >&2
    exit 1
fi

.scripts/version-bump.sh "$version"

git add client/Cargo.toml client/Cargo.lock daemon/package.json contrib/arch/PKGBUILD
if ! git commit -q -m "chore(release): $tag"; then
    # The tree was clean before the bump, so this only discards the bump.
    git reset -q --hard HEAD
    printf 'Commit failed; reverted the version bump.\n' >&2
    exit 1
fi
git tag "$tag"
# Push the branch with the tag so the tagged commit is never missing from it on the remote.
if ! git push --atomic origin HEAD "refs/tags/$tag"; then
    git tag -d "$tag" >/dev/null
    printf 'Push failed; removed local tag %s. The release commit is still on the branch (git reset --hard HEAD~1 to drop it).\n' "$tag" >&2
    exit 1
fi
printf 'Released %s at %s.\n' "$tag" "$(git rev-parse --short HEAD)"
