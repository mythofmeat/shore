#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    printf 'Usage: %s <version>\n' "$0" >&2
    exit 2
fi
version=$1

cd "$(dirname -- "$0")/.."
sed -i "s/^version = \".*\"$/version = \"$version\"/" client/Cargo.toml
sed -i "/^name = \"shore-\(cli\|common\)\"$/{n;s/^version = .*/version = \"$version\"/}" client/Cargo.lock
sed -i "s/^  \"version\": \".*\",$/  \"version\": \"$version\",/" daemon/package.json
sed -i -e "s/^pkgver=.*/pkgver=$version/" -e "s/^pkgrel=.*/pkgrel=1/" contrib/arch/PKGBUILD
