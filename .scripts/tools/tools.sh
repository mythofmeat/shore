#!/usr/bin/bash
set -eu
cd "$(dirname "$0")"

root="$(git rev-parse --show-toplevel)"

update_deps() {
    update_tools() {
        cd "$root"
        bun upgrade
        rustup update stable
        rustup component add --toolchain stable rustfmt clippy
        cargo install cargo-edit
    }

    update_bun() {
        cd "$root/daemon"
        bun update --latest
        bun install
    }

    update_rust() {
        cd "$root/client"
        run cargo upgrade --incompatible
        run cargo update
    }

    update_tools
    update_bun
    update_rust

    if ! [ -n "$(git status --porcelain)" ]; then
        echo "No dependency updates!"
        exit 0
    else
        git commit -am "chore(deps): update"
    fi
}

current_versions() {
    cd "$root"
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
}

bump_version_to() {
    if [ "$#" -ne 1 ]; then
        printf 'Usage: %s <version>\n' "$0" >&2
        return 2
    fi
    version=$1
    sed -i "s/^version = \".*\"$/version = \"$version\"/" client/Cargo.toml
    sed -i "/^name = \"shore-\(cli\|common\)\"$/{n;s/^version = .*/version = \"$version\"/}" client/Cargo.lock
    sed -i "s/^  \"version\": \".*\",$/  \"version\": \"$version\",/" daemon/package.json
    sed -i -e "s/^pkgver=.*/pkgver=$version/" -e "s/^pkgrel=.*/pkgrel=1/" contrib/arch/PKGBUILD
    ver=$("$root"/.scripts/check-version.sh)
    IFS='.' read -ra ver_parts <<<"$ver"
    ver_parts[2]=$((${ver_parts[2]#v} + 1))
    bumped_ver=$(
        IFS='.'
        echo "${ver_parts[*]}"
    )

    git commit -am "chore(release): v$bumped_ver" --no-verify
    git tag v"$bumped_ver"
}

update_deps
bump_version_to "4.16.13"
git push --tags
"$root"/.scripts/release-gh.sh
