#!/usr/bin/bash
set -eu

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
        cargo upgrade --incompatible
        cargo update
    }

    update_tools
    update_bun
    update_rust
}

is_updated() {
    if [ -n "$(git status --porcelain)" ]; then
        git commit -am "chore(deps): update"
    else
        echo "No dependency updates!"
        return 1
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
    cd "$root"
    if [ "$#" -ne 1 ]; then
        printf 'Usage: %s <version>\n' "$0" >&2
        return 2
    fi
    version=$1
    sed -i "s/^version = \".*\"$/version = \"$version\"/" client/Cargo.toml
    sed -i "/^name = \"shore-\(cli\|common\)\"$/{n;s/^version = .*/version = \"$version\"/}" client/Cargo.lock
    sed -i "s/^  \"version\": \".*\",$/  \"version\": \"$version\",/" daemon/package.json
    sed -i -e "s/^pkgver=.*/pkgver=$version/" -e "s/^pkgrel=.*/pkgrel=1/" contrib/arch/PKGBUILD
    git commit --no-verify -am "chore(release): v$version"
}

version_increment() {
    ver="$(current_versions)"
    IFS='.' read -ra ver_parts <<<"$ver"
    case "$1" in
    "major")
        ver_parts[0]=$((${ver_parts[0]#v} + 1))
        ;;
    "minor")
        ver_parts[1]=$((${ver_parts[1]#v} + 1))
        ;;
    "patch")
        ver_parts[2]=$((${ver_parts[2]#v} + 1))
        ;;
    esac
    bumped_ver=$(
        IFS='.'
        echo "${ver_parts[*]}"
    )
    echo "$bumped_ver"
}

release_gh() {
    command -v gh
    command -v jq

    local_ver="$(current_versions)"
    gh_ver=$(gh release list --json tagName | jq -r .[0].tagName)
    IFS='.' read -ra local_ver_parts <<<"$local_ver"
    IFS='.' read -ra gh_ver_parts <<<"$gh_ver"

    for i in {0..2}; do
        [ "${local_ver_parts[$i]#v}" -ge "${gh_ver_parts[$i]#v}" ] ||
            return 1
    done

    git tag v"$local_ver"
    git push --tags
    gh release create v"$local_ver" --generate-notes --draft --verify-tag

}

packaging_arch() {
    cd "$root"/contrib/arch
    makepkg
    pkg="$(find . -name "*.pkg.tar.zst")"
    gh release upload "v$(current_versions)" "$pkg"
    rm -f "$pkg"
}

release_gh_final() {
    gh release edit "$v(current_versions)" --draft=false
}

#####

release_and_package() {
    bump_version_to "$(version_increment "$1")"
    release_gh
    packaging_arch
    release_gh_final
}

#####
unattended_upgrade() {
    update_deps
    is_updated && release_and_package patch
}
