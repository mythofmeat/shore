#!/bin/sh
set -eu

version=${1:-}
if [ -z "$version" ]; then
    echo "usage: release.sh <version>    e.g. release.sh 4.9.0" >&2
    exit 1
fi

version=${version#v}

root=$(CDPATH= cd -- "$(git rev-parse --show-toplevel)" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet git@github.com:mythofmeat/homebrew-tap.git "$work/tap"
git clone --quiet git@github.com:mythofmeat/arch-repo.git "$work/arch"

sed -i "s/^version = \".*\"\$/version = \"$version\"/" "$root/client/Cargo.toml"
sed -i "s/^pkgver=.*/pkgver=$(printf '%s' "$version" | tr - _)/" "$root/contrib/arch/PKGBUILD"
(cd "$root/client" && cargo metadata --format-version 1 >/dev/null)

versioned="client/Cargo.toml client/Cargo.lock contrib/arch/PKGBUILD"
if ! git -C "$root" diff --quiet HEAD -- $versioned; then
    git -C "$root" commit -m "chore(release): $version" -- $versioned
fi

head=$(git -C "$root" rev-parse HEAD)
if tagged=$(git -C "$root" rev-parse -q --verify "refs/tags/v$version^{commit}"); then
    if [ "$tagged" != "$head" ]; then
        echo "v$version already tags $tagged, not $head" >&2
        exit 1
    fi
else
    git -C "$root" tag "v$version"
fi
git -C "$root" push origin HEAD "v$version"

(cd "$root/contrib/arch" && makepkg --force --clean --cleanbuild --nocheck)

sed -i \
    -e "s/^  version \".*\"\$/  version \"$version\"/" \
    -e "s/tag: *\".*\"/tag:      \"v$version\"/" \
    -e "s/revision: *\".*\"/revision: \"$head\"/" \
    "$work/tap/Formula/shore.rb"
git -C "$work/tap" commit -m "shore $version" -- Formula/shore.rb
git -C "$work/tap" push origin main

"$work/arch/publish.sh" "$root/contrib/arch"/shore-cli-*.pkg.tar.zst
rm -f "$root/contrib/arch"/*.pkg.tar.zst

echo "released $version at $head"
