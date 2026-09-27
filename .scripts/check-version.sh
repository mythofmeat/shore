#!/bin/sh
set -eu

cd "$(dirname -- "$0")/.."
versions="client/Cargo.toml $(sed -n 's/^version = "\(.*\)"$/\1/p' client/Cargo.toml)
client/Cargo.lock:shore-cli $(sed -n '/^name = "shore-cli"$/{n;s/^version = "\(.*\)"$/\1/p}' client/Cargo.lock)
client/Cargo.lock:shore-common $(sed -n '/^name = "shore-common"$/{n;s/^version = "\(.*\)"$/\1/p}' client/Cargo.lock)
daemon/package.json $(sed -n 's/^  "version": "\(.*\)",$/\1/p' daemon/package.json)
contrib/arch/PKGBUILD $(sed -n 's/^pkgver=//p' contrib/arch/PKGBUILD)"

if [ "$(printf '%s\n' "$versions" | awk '{ print $2 }' | sort -u | wc -l)" -ne 1 ]; then
    printf 'Versions differ:\n%s\n' "$versions" >&2
    exit 1
fi
printf '%s\n' "$versions" | awk 'NR == 1 { print $2 }'
