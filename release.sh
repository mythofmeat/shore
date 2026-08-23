#!/bin/sh
set -eu

version=${1:-}
if [ -z "$version" ]; then
    echo "usage: release.sh <version>    e.g. release.sh 4.9.0" >&2
    exit 1
fi

version=${version#v}

root=$(CDPATH= cd -- "$(git rev-parse --show-toplevel)" && pwd)
tap="$root/../homebrew-tap"
arch="$root/../arch-repo"

if [ ! -f "$tap/Formula/shore.rb" ]; then
    echo "no homebrew tap checkout at $tap" >&2
    exit 1
fi

if [ ! -x "$arch/publish.sh" ]; then
    echo "no arch repo checkout at $arch" >&2
    exit 1
fi

sed -i "s/^version = \".*\"\$/version = \"$version\"/" "$root/client/Cargo.toml"
sed -i "s/^pkgver=.*/pkgver=$(printf '%s' "$version" | tr - _)/" "$root/contrib/arch/PKGBUILD"
(cd "$root/client" && cargo metadata --format-version 1 >/dev/null)

versioned="client/Cargo.toml client/Cargo.lock contrib/arch/PKGBUILD"
if ! git -C "$root" diff --quiet HEAD -- $versioned; then
    git -C "$root" commit -m "chore(release): $version" -- $versioned
fi

git -C "$root" tag "v$version"
git -C "$root" push origin HEAD "v$version"

revision=$(git -C "$root" rev-parse "v$version^{commit}")
sed -i \
    -e "s/^  version \".*\"\$/  version \"$version\"/" \
    -e "s/tag: *\".*\"/tag:      \"v$version\"/" \
    -e "s/revision: *\".*\"/revision: \"$revision\"/" \
    "$tap/Formula/shore.rb"
git -C "$tap" commit -m "shore $version" -- Formula/shore.rb
git -C "$tap" push origin main

(cd "$root/contrib/arch" && makepkg --clean --cleanbuild --nocheck)
"$arch/publish.sh" "$root/contrib/arch"/shore-cli-*.pkg.tar.zst
rm -f "$root/contrib/arch"/*.pkg.tar.zst

echo "released $version at $revision"
