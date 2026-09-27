#!/bin/env bash

set -eu

command -v gh
command -v jq
cd "$(dirname "$0")"

srcdir="$(git rev-parse --show-toplevel)"
cd $srcdir/.scripts/
! test -n "$(git status --porcelain)" || exit 1

local_ver=v$(./check-version.sh)
gh_ver=$(gh release list --json tagName | jq -r .[0].tagName)
IFS='.' read -ra local_ver_parts <<<"$local_ver"
IFS='.' read -ra gh_ver_parts <<<"$gh_ver"
[ ${local_ver_parts[0]#v} -ge ${gh_ver_parts[0]#v} ]
[ ${local_ver_parts[1]} -ge ${gh_ver_parts[1]} ]
[ ${local_ver_parts[2]} -ge ${gh_ver_parts[2]} ]

gh release create $local_ver --generate-notes --draft

packaging_arch() {
    cd $srcdir/contrib/arch
    makepkg
    pkg="$(find . -name "*.pkg.tar.zst")"
    gh release upload "$local_ver" "$pkg"
}

if command -v makepkg; then
    packaging_arch
fi

gh release edit $local_ver --draft=false
