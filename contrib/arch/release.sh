#!/usr/bin/env bash
#
# Cut a shore release: run the tests, bump the version, build the packages,
# publish them to the local pacman repo and install them.
#
#   ./contrib/arch/release.sh          # 0.20.1 -> 0.20.2
#   ./contrib/arch/release.sh minor    # 0.20.1 -> 0.21.0
#   ./contrib/arch/release.sh major    # 0.20.1 -> 1.0.0
#   ./contrib/arch/release.sh 1.2.3    # explicit
#
# Does not touch git. The version bump is left in the working tree; commit it
# however you like.

set -euo pipefail
shopt -s nullglob

repo_dir="${SHORE_PKG_REPO:-/var/lib/pacman-local}"
repo_name="${SHORE_PKG_REPO_NAME:-pacman-local}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
arch_dir="$root/contrib/arch"
cd "$root"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m==> error:\033[0m %s\n' "$*" >&2; exit 1; }

# --- work out the new version ------------------------------------------------
old="$(awk -F'"' '/^version = /{print $2; exit}' Cargo.toml)"
[[ -n $old ]] || die "could not read the workspace version from Cargo.toml"

IFS=. read -r major minor patch <<<"$old"
case "${1:-patch}" in
    patch)                new="$major.$minor.$((patch + 1))" ;;
    minor)                new="$major.$((minor + 1)).0" ;;
    major)                new="$((major + 1)).0.0" ;;
    [0-9]*.[0-9]*.[0-9]*) new="$1" ;;
    *) die "usage: $(basename "$0") [patch|minor|major|X.Y.Z]" ;;
esac

# --- test --------------------------------------------------------------------
say "Testing..."
cargo test --workspace
env -C "$root/backend/llm-sidecar" bun install --silent
env -C "$root/backend/llm-sidecar" bun test

# --- bump --------------------------------------------------------------------
say "Version $old -> $new"
sed -i -E "s/^version = \"${old//./\\.}\"$/version = \"$new\"/" Cargo.toml
grep -q "^version = \"$new\"$" Cargo.toml || die "Cargo.toml version did not move to $new"

# The PKGBUILD builds with --locked, so Cargo.lock has to learn the workspace
# members' new versions or makepkg refuses to start.
cargo update --workspace --offline --quiet

sed -i -E "s/^pkgver=.*/pkgver=$new/" "$arch_dir/PKGBUILD"
sed -i -E "s/^pkgrel=.*/pkgrel=1/"    "$arch_dir/PKGBUILD"

# --- build -------------------------------------------------------------------
# --nocheck: the suite already ran above.  -d: the Rust toolchain is
# rustup-managed and invisible to pacman.  -f: overwrite.  -c: drop src/ and pkg/.
say "Building..."
env -C "$arch_dir" makepkg -f -d --nocheck --noconfirm

# --- publish -----------------------------------------------------------------
# Globbed on $new so a tarball left behind by an earlier failed run cannot be
# published, or mistaken for a package name below.
built=("$arch_dir"/*-"$new"-*.pkg.tar.zst)
(( ${#built[@]} )) || die "makepkg produced no packages for $new"

say "Publishing to $repo_dir..."
mv -f "${built[@]}" "$repo_dir/"

published=() pkgs=()
for f in "${built[@]}"; do
    f="$(basename "$f")"
    published+=("$repo_dir/$f")
    pkgs+=("${f%-"$new"-*}")
done

repo-add --quiet "$repo_dir/$repo_name.db.tar.gz" "${published[@]}"

# --- install -----------------------------------------------------------------
# Named explicitly rather than a bare -Syu: pacman only upgrades packages that
# are already installed, so the first release would otherwise be a no-op.
say "Released $new — installing ${pkgs[*]}"
sudo pacman -Syu "${pkgs[@]}"
