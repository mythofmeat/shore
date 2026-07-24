#!/usr/bin/env bash
#
# Cut a shore release and publish it to the local pacman repo.
#
#   ./contrib/arch/release.sh              # patch bump: 0.20.0 -> 0.20.1
#   ./contrib/arch/release.sh minor        # 0.20.0 -> 0.21.0
#   ./contrib/arch/release.sh 1.0.0        # explicit
#   ./contrib/arch/release.sh --repack     # rebuild this version as pkgrel+1
#
# Flags:
#   --init          create the repo dir, print the pacman.conf stanza, exit
#   --dry-run       show what would happen; change nothing
#   --skip-checks   skip fmt/clippy/test (they are the slow part)
#   --no-push       commit and tag locally, but do not push
#   --no-install    build and publish, but do not run pacman -Syu
#   --repack        rebuild the current version as pkgrel+1 (no version bump)
#
# Env overrides:
#   SHORE_PKG_REPO       repo directory   (default /var/lib/pacman-local)
#   SHORE_PKG_REPO_NAME  repo/db name     (default pacman-local)
#   SHORE_PKG_KEEP       builds kept each (default 2)
#   SHORE_SWEEP_DAYS     cargo-sweep age  (default 7; 0 disables)
#
# The db is NOT named `local`, however tempting the directory name makes it.
# Pacman reserves that name for its own database of installed packages, so a
# `[local]` stanza in pacman.conf is refused outright ("could not register
# 'local' database") — leaving a repo that publishes fine and can never be
# installed from. The name is rejected below rather than silently accepted.
#
# The repo is shared by every locally-built program, not just shore — any other
# project publishes into it the same way, by dropping its packages in and
# re-running repo-add. If some other project already ran its own --init against
# the same directory, this one is a no-op. They must agree on the db name,
# since it is baked into the .db filename the directory holds.
#
# The whole pipeline is local: nothing is built in CI and no package leaves this
# machine, so GitHub only ever holds source.
#
# Ordering note: the packages are BUILT before anything is committed, tagged or
# pushed. A failed build must not leave a published version behind with no
# artifact to match it, so the version files are reverted on any failure before
# the commit step is reached.
#
# Relationship to the other two installers: install.sh puts a build under
# /usr/local, scripts/install.sh puts one in ~/shore. This path installs the
# same layout as install.sh with the prefix at /usr, under pacman's ownership.
# Running more than one of the three at a time means two copies on $PATH; see
# the stale-install warning at the end of a release.

set -euo pipefail

REPO_DIR="${SHORE_PKG_REPO:-/var/lib/pacman-local}"
REPO_NAME="${SHORE_PKG_REPO_NAME:-pacman-local}"
KEEP="${SHORE_PKG_KEEP:-2}"
SWEEP_DAYS="${SHORE_SWEEP_DAYS:-7}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
arch_dir="$root/contrib/arch"

BUMP=patch
DRY=0 SKIP_CHECKS=0 NO_PUSH=0 NO_INSTALL=0 REPACK=0 INIT=0

for a in "$@"; do
    case "$a" in
        --init)         INIT=1 ;;
        --dry-run)      DRY=1 ;;
        --skip-checks)  SKIP_CHECKS=1 ;;
        --no-push)      NO_PUSH=1 ;;
        --no-install)   NO_INSTALL=1 ;;
        --repack)       REPACK=1 ;;
        patch|minor|major)    BUMP="$a" ;;
        [0-9]*.[0-9]*.[0-9]*) BUMP="$a" ;;
        *) echo "unknown argument: $a" >&2; exit 2 ;;
    esac
done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==> error:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if (( DRY )); then printf '   would run: %s\n' "$*"; else "$@"; fi; }

# Caught here rather than at install time: repo-add builds a `local.db` happily
# and pacman then refuses to register it, so the failure surfaces much later as
# a package that was published but cannot be found.
if [[ $REPO_NAME == local ]]; then
    die "'local' is reserved for pacman's own database — pick another name (default: localrepo)"
fi

# --------------------------------------------------------------------------
# --init: one-time setup of the shared local repo
# --------------------------------------------------------------------------
if (( INIT )); then
    if [[ -d $REPO_DIR && -w $REPO_DIR ]]; then
        say "$REPO_DIR already exists and is writable."
    else
        say "Creating $REPO_DIR owned by $USER (needs sudo once)..."
        sudo install -d -o "$USER" -g "$(id -gn)" -m 755 "$REPO_DIR"
    fi
    cat <<EOF

Register the repo by appending this to /etc/pacman.conf:

    [$REPO_NAME]
    SigLevel = Optional TrustAll
    Server = file://$REPO_DIR

Copy-paste to append it now:

sudo tee -a /etc/pacman.conf >/dev/null <<'PACMANCONF'

[$REPO_NAME]
SigLevel = Optional TrustAll
Server = file://$REPO_DIR
PACMANCONF

Do that AFTER the first release — an empty repo has no database file and
'pacman -Sy' will complain it cannot retrieve $REPO_NAME.db.
EOF

    # A `[local]` stanza is the one mistake that looks like it works: pacman
    # prints the registration error on every single invocation and then acts as
    # if the repo does not exist.
    if grep -q '^\[local\]' /etc/pacman.conf 2>/dev/null; then
        warn "/etc/pacman.conf has a [local] section. pacman reserves that name for"
        warn "its own installed-package database and refuses to register the repo —"
        warn "rename the section header to [$REPO_NAME] and keep the Server line."
    fi
    exit 0
fi

cd "$root"

# --------------------------------------------------------------------------
# Guards — a package is only as trustworthy as the tree it was built from
# --------------------------------------------------------------------------
command -v makepkg  >/dev/null || die "makepkg not found (install base-devel)"
command -v repo-add >/dev/null || die "repo-add not found (install pacman)"
command -v paccache >/dev/null || die "paccache not found (install pacman-contrib)"
command -v cargo    >/dev/null || die "cargo not found (install rustup and a stable toolchain)"
command -v bun      >/dev/null || die "bun not found (needed to build the LLM sidecar)"

[[ -d $REPO_DIR ]] || die "local repo $REPO_DIR does not exist. Run: $0 --init"
[[ -w $REPO_DIR ]] || die "local repo $REPO_DIR is not writable by $USER. Run: $0 --init"

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ $branch == main ]] || die "on branch '$branch'; releases are cut from main"

git diff --quiet && git diff --cached --quiet \
    || die "working tree is dirty — commit or stash first"

# Not fatal, but worth saying once per release: .gitignore's blanket *.lock
# rule swallows Cargo.lock, so the release commit records no dependency
# versions and the PKGBUILD's --locked build is only pinned by whatever
# happens to be in the working tree.
if ! git ls-files --error-unmatch Cargo.lock >/dev/null 2>&1; then
    warn "Cargo.lock is untracked — this release will not record what it was built against."
    warn "  fix once with: git add -f Cargo.lock"
fi

say "Fetching origin..."
run git fetch --quiet origin main
if ! (( DRY )); then
    behind="$(git rev-list --count HEAD..origin/main)"
    (( behind == 0 )) || die "local main is $behind commit(s) behind origin/main — pull first"
fi

# --------------------------------------------------------------------------
# Quality gates
#
# The same set CLAUDE.md and README name as the pre-handoff checks, plus the
# sidecar's own typecheck and tests — it is a shipped binary here, and cargo
# knows nothing about it.
# --------------------------------------------------------------------------
if (( SKIP_CHECKS )); then
    warn "Skipping fmt/clippy/test (--skip-checks)"
else
    say "Running quality gates..."
    run cargo fmt --all -- --check
    run cargo clippy --workspace --all-targets -- -D warnings
    run cargo test --workspace
    say "Checking the LLM sidecar..."
    run env -C "$root/backend/llm-sidecar" bun install --silent
    run env -C "$root/backend/llm-sidecar" bun run typecheck
    run env -C "$root/backend/llm-sidecar" bun test
fi

# --------------------------------------------------------------------------
# Work out the new version
# --------------------------------------------------------------------------
OLD="$(awk -F'"' '/^version = /{print $2; exit}' Cargo.toml)"
[[ -n $OLD ]] || die "could not read workspace version from Cargo.toml"
OLD_RE="${OLD//./\\.}"

if (( REPACK )); then
    NEW="$OLD"
    PKGREL=$(( $(awk -F= '/^pkgrel=/{print $2; exit}' "$arch_dir/PKGBUILD") + 1 ))
    say "Repacking $NEW as pkgrel=$PKGREL (no version bump)"
else
    PKGREL=1
    case "$BUMP" in
        patch|minor|major)
            IFS=. read -r MA MI PA <<<"$OLD"
            case "$BUMP" in
                major) NEW="$((MA + 1)).0.0" ;;
                minor) NEW="$MA.$((MI + 1)).0" ;;
                patch) NEW="$MA.$MI.$((PA + 1))" ;;
            esac
            ;;
        *) NEW="$BUMP" ;;
    esac
    [[ $NEW != "$OLD" ]] || die "new version equals current ($OLD); use --repack to rebuild"

    if git rev-parse -q --verify "refs/tags/v$NEW" >/dev/null; then
        die "tag v$NEW already exists"
    fi
    say "Version $OLD -> $NEW"
fi

# --------------------------------------------------------------------------
# Rewrite the version files
#
# Anything that fails from here until the commit must leave the tree exactly as
# it was found, so the edits are trapped and reverted.
# --------------------------------------------------------------------------
TOUCHED=0
revert_on_failure() {
    local rc=$? f
    if (( rc != 0 && TOUCHED )); then
        warn "Failed — reverting version changes to leave the tree clean."
        # One path per checkout, deliberately. `git checkout -- a b c` aborts
        # the whole operation if any single pathspec is unknown to git, and
        # Cargo.lock is untracked in this repo (blanket *.lock rule) — one
        # combined call would revert nothing at all.
        for f in Cargo.toml CHANGELOG.md "$arch_dir/PKGBUILD"; do
            git checkout -- "$f" 2>/dev/null || true
        done
        rm -f CHANGELOG.md.new
        # Regenerate rather than check out, for the same reason: with the
        # manifest back at the old version this rewrites the members' versions
        # in Cargo.lock to match, tracked or not.
        git checkout -- Cargo.lock 2>/dev/null \
            || cargo update --workspace --offline --quiet 2>/dev/null || true
    fi
    exit $rc
}
trap revert_on_failure EXIT

# Promote the CHANGELOG's [Unreleased] section into a dated version heading and
# open a fresh empty one. Only when it has content: an empty section would
# stamp a hollow heading that says a release changed nothing.
stamp_changelog() {
    local ver="$1" day
    day="$(date +%F)"

    grep -q '^## \[Unreleased\]' CHANGELOG.md || {
        warn "no [Unreleased] section in CHANGELOG.md — left unchanged"
        return 0
    }
    if ! awk '
        /^## \[Unreleased\]/ { inside = 1; next }
        /^## \[/             { inside = 0 }
        inside && NF         { found = 1 }
        END                  { exit !found }
    ' CHANGELOG.md; then
        warn "CHANGELOG.md [Unreleased] is empty — left unchanged"
        return 0
    fi

    awk -v ver="$ver" -v day="$day" '
        !stamped && /^## \[Unreleased\]/ {
            print "## [Unreleased]"
            print ""
            print "## [" ver "] - " day
            stamped = 1
            next
        }
        { print }
    ' CHANGELOG.md > CHANGELOG.md.new
    mv CHANGELOG.md.new CHANGELOG.md
    say "Stamped CHANGELOG.md [Unreleased] as [$ver] - $day"
}

if (( DRY )); then
    printf '   would set version to %s-%s in Cargo.toml, Cargo.lock, PKGBUILD\n' "$NEW" "$PKGREL"
    (( REPACK )) || printf '   would stamp CHANGELOG.md [Unreleased] as [%s]\n' "$NEW"
else
    TOUCHED=1
    if ! (( REPACK )); then
        # One workspace version for the whole suite. Internal crates are
        # path-only with no version field, so unlike a publishing workspace
        # there is exactly one line to move.
        sed -i -E "s/^version = \"$OLD_RE\"$/version = \"$NEW\"/" Cargo.toml

        grep -q "^version = \"$NEW\"$" Cargo.toml \
            || die "Cargo.toml workspace version did not move to $NEW"

        # Cargo.lock records the workspace members' own versions, so it must be
        # refreshed or the PKGBUILD's --locked build will refuse to run.
        cargo update --workspace --offline --quiet

        stamp_changelog "$NEW"
    fi

    # Keep the literal pkgver/pkgrel in the PKGBUILD in step with Cargo.toml.
    # pkgver() would derive the same value, but committing it stops makepkg
    # from rewriting the file into a surprise diff later. pacman also only
    # treats a rebuild as an upgrade if pkgrel actually moves.
    sed -i -E "s/^pkgver=.*/pkgver=$NEW/"    "$arch_dir/PKGBUILD"
    sed -i -E "s/^pkgrel=.*/pkgrel=$PKGREL/" "$arch_dir/PKGBUILD"
fi

# --------------------------------------------------------------------------
# Build — before any commit, so a failure publishes nothing
#
# --nocheck because the gates above already ran the suite; -f to overwrite an
# existing tarball; -d to skip dependency checks (the Rust toolchain is
# rustup-managed and invisible to pacman); -c to drop src/ and pkg/ afterwards.
# --------------------------------------------------------------------------
say "Building packages (reusing $root/target)..."
run env -C "$arch_dir" makepkg -f -d -c --nocheck --noconfirm

if (( DRY )); then
    trap - EXIT
    say "Dry run complete — nothing was changed."
    exit 0
fi

# --------------------------------------------------------------------------
# Commit, tag, push — the build succeeded, so this version is real
# --------------------------------------------------------------------------
if (( REPACK )); then
    say "Committing repack v$NEW-$PKGREL..."
    git add "$arch_dir/PKGBUILD"
    git commit -q -m "chore(release): repack v$NEW-$PKGREL"
else
    say "Committing and tagging v$NEW..."
    staged=(Cargo.toml CHANGELOG.md "$arch_dir/PKGBUILD")
    # Only when the repo tracks it: `git add` on an ignored path is an error,
    # and this failing here would strand a built version with no commit.
    git ls-files --error-unmatch Cargo.lock >/dev/null 2>&1 && staged+=(Cargo.lock)
    git add "${staged[@]}"
    git commit -q -m "chore(release): v$NEW"
    git tag -a "v$NEW" -m "v$NEW"
fi
TOUCHED=0
trap - EXIT

if (( NO_PUSH )); then
    warn "Not pushed (--no-push). Later: git push origin main"
    (( REPACK )) || warn "  and: git push origin v$NEW"
else
    git push -q origin main
    (( REPACK )) || git push -q origin "v$NEW"
fi

# --------------------------------------------------------------------------
# Publish into the shared local repo
# --------------------------------------------------------------------------
say "Publishing to $REPO_DIR..."
shopt -s nullglob
built=("$arch_dir"/*.pkg.tar.zst)
(( ${#built[@]} )) || die "makepkg produced no packages"

# Package names, taken from what was actually built rather than re-parsing the
# PKGBUILD, so adding or renaming a split package needs no edit here.
pkgs=()
for f in "${built[@]}"; do
    f="$(basename "$f")"
    pkgs+=("${f%-"$NEW"-"$PKGREL"-*}")
done

mv -f "${built[@]}" "$REPO_DIR/"

# Retention. paccache already understands package filenames, so it keeps the
# newest $KEEP of each package without confusing shore-tui for a build of
# shore, and it orders by version rather than mtime — so rebuilding an old
# version cannot evict a newer one. It leaves the .db/.files entries alone.
if (( KEEP > 0 )); then
    paccache -r -k "$KEEP" -c "$REPO_DIR" >/dev/null 2>&1 || true
fi

# Rebuild the db from what survived rather than adding incrementally, so it can
# never reference a package file that retention just deleted.
#
# Two safeguards, both learned the hard way. repo-add exits non-zero on any
# unreadable file, and a stray or half-copied .pkg.tar.zst from some other
# project's interrupted build is enough to trigger it — so validate first and
# skip junk rather than letting one bad file abort the rebuild. And build the
# new database in a temp dir, swapping it in only once repo-add has succeeded:
# deleting the old db up front means a failure here leaves the repo with *no*
# database, which breaks pacman -Syu for every program in it, not just shore.
valid=()
for f in "$REPO_DIR"/*.pkg.tar.*; do
    [[ $f == *.sig ]] && continue
    if bsdtar -tqf "$f" .PKGINFO >/dev/null 2>&1; then
        valid+=("$f")
    else
        warn "not a readable package, skipping: $(basename "$f")"
    fi
done
(( ${#valid[@]} )) || die "no valid packages in $REPO_DIR — database left untouched"

tmpdb="$(mktemp -d)"
trap 'rm -rf "$tmpdb"' EXIT
repo-add --quiet "$tmpdb/$REPO_NAME.db.tar.gz" "${valid[@]}"
rm -f "$REPO_DIR/$REPO_NAME".db* "$REPO_DIR/$REPO_NAME".files*
mv -f "$tmpdb/$REPO_NAME".db* "$tmpdb/$REPO_NAME".files* "$REPO_DIR/"
rm -rf "$tmpdb"
trap - EXIT

# --------------------------------------------------------------------------
# Reclaim space
#
# --time rather than --installed or --maxsize: --installed reclaims almost
# nothing on a single-toolchain setup, and --maxsize would evict the warm cache
# this whole design exists to preserve. Age-based pruning clears genuinely stale
# artifacts while leaving the current build intact.
# --------------------------------------------------------------------------
if (( SWEEP_DAYS > 0 )) && command -v cargo-sweep >/dev/null; then
    say "Sweeping cargo artifacts older than ${SWEEP_DAYS}d..."
    cargo sweep --time "$SWEEP_DAYS" "$root" >/dev/null 2>&1 || true
fi

say "Released ${NEW}-${PKGREL}"

# An earlier install.sh run leaves files behind in two flavours, and both bite
# at install time rather than here:
#
#   - Binaries under /usr/local, which precedes /usr/bin on a default $PATH.
#     Nothing fails; the stale build just silently wins, and the mismatch stays
#     invisible until something misbehaves.
#   - Files at paths these packages also ship — the systemd units, the shell
#     completions. pacman refuses to overwrite a file it does not own, so the
#     whole transaction aborts with "exists in filesystem".
unowned=()
for f in /usr/lib/systemd/user/shore-daemon.service \
         /usr/lib/systemd/user/shore-notify.service \
         /usr/share/fish/vendor_completions.d/shore.fish \
         /usr/share/bash-completion/completions/shore \
         /usr/share/zsh/site-functions/_shore; do
    [[ -e $f ]] || continue
    pacman -Qo "$f" >/dev/null 2>&1 || unowned+=("$f")
done

shadowing=()
for f in /usr/local/bin/shore /usr/local/bin/shore-daemon /usr/local/bin/shore-tui \
         /usr/local/lib/shore/shore-llm-sidecar /usr/local/lib/shore/shore-matrix; do
    [[ -e $f ]] && shadowing+=("$f")
done

if (( ${#unowned[@]} )); then
    warn "These files are not owned by pacman and sit where the packages install."
    warn "pacman will abort the transaction until they are gone:"
    printf '      %s\n' "${unowned[@]}"
    warn "  sudo rm -f ${unowned[*]}"
fi
if (( ${#shadowing[@]} )); then
    warn "An install.sh deployment under /usr/local shadows the packaged build on \$PATH:"
    printf '      %s\n' "${shadowing[@]}"
    warn "  sudo rm -rf /usr/local/bin/shore /usr/local/bin/shore-daemon /usr/local/bin/shore-tui /usr/local/lib/shore"
fi

# `pacman -Syu` only upgrades what is already installed; the first release has
# to be installed by name.
installed=()
for p in "${pkgs[@]}"; do
    pacman -Qq "$p" >/dev/null 2>&1 && installed+=("$p")
done

if (( ${#installed[@]} )); then
    install_cmd="sudo pacman -Syu"
else
    install_cmd="sudo pacman -Sy ${pkgs[*]}"
fi

if (( NO_INSTALL )); then
    say "Skipping install (--no-install). Run: $install_cmd"
elif (( ${#installed[@]} == 0 )); then
    say "No shore packages installed yet — install them with:"
    say "  $install_cmd"
else
    say "Upgrading..."
    $install_cmd
fi
