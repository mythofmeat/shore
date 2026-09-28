#!/usr/bin/bash
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")"

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
    cd "$root"
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        git commit -am "chore(deps): update"
    else
        echo "No dependency updates!"
        exit 0
    fi
}

current_versions() {
    cd "$root"
    versions="client/Cargo.toml $(sed -n '/^\[workspace\.package\]$/,/^\[/s/^version = "\(.*\)"$/\1/p' client/Cargo.toml)
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
        printf 'Usage: bump_version_to <version>\n' >&2
        return 2
    fi
    version=${1#v}
    if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        printf 'Not a MAJOR.MINOR.PATCH version: %s\n' "$version" >&2
        return 2
    fi
    sed -i "/^\[workspace\.package\]$/,/^\[/s/^version = \".*\"$/version = \"$version\"/" client/Cargo.toml
    sed -i "/^name = \"shore-\(cli\|common\)\"$/{n;s/^version = .*/version = \"$version\"/}" client/Cargo.lock
    sed -i "s/^  \"version\": \".*\",$/  \"version\": \"$version\",/" daemon/package.json
    sed -i -e "s/^pkgver=.*/pkgver=$version/" -e "s/^pkgrel=.*/pkgrel=1/" contrib/arch/PKGBUILD
    [ "$(current_versions)" = "$version" ]
    # Only the version files: anything else in the working tree stays out of
    # the release commit.
    git commit --no-verify -m "chore(release): v$version" -- \
        client/Cargo.toml client/Cargo.lock daemon/package.json contrib/arch/PKGBUILD
}

version_increment() {
    ver="$(current_versions)"
    IFS='.' read -ra ver_parts <<<"${ver#v}"
    case "$1" in
    "major")
        ver_parts=($((ver_parts[0] + 1)) 0 0)
        ;;
    "minor")
        ver_parts=("${ver_parts[0]}" $((ver_parts[1] + 1)) 0)
        ;;
    "patch")
        ver_parts=("${ver_parts[0]}" "${ver_parts[1]}" $((ver_parts[2] + 1)))
        ;;
    *)
        printf 'Usage: version_increment major|minor|patch\n' >&2
        return 2
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

    cd "$root"
    local_ver="$(current_versions)"
    gh_ver=$(gh release list --limit 1 --json tagName | jq -r '.[0].tagName // "v0.0.0"')
    gh_ver=${gh_ver#v}

    # Must be strictly newer than the latest GitHub release.
    if [ "$local_ver" = "$gh_ver" ] ||
        [ "$(printf '%s\n%s\n' "$local_ver" "$gh_ver" | sort -V | tail -n1)" != "$local_ver" ]; then
        printf 'Local version %s is not newer than released %s\n' "$local_ver" "$gh_ver" >&2
        return 1
    fi

    git tag v"$local_ver"
    # The release commit and its tag go up together.
    git push --atomic origin HEAD "refs/tags/v$local_ver"
    gh release create v"$local_ver" --generate-notes --draft --verify-tag
}

packaging_arch() {
    cd "$root"/contrib/arch
    makepkg -f
    pkg="$(find . -maxdepth 1 -name "*.pkg.tar.zst")"
    gh release upload "v$(current_versions)" "$pkg"
    rm -f "$pkg"
}

release_gh_final() {
    gh release edit "v$(current_versions)" --draft=false
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
