#!/usr/bin/env bash
set -eu
srcdir="$(dirname "${BASH_SOURCE[0]}")/../"

build() {
    cd "$srcdir/client"
    cargo build --workspace --release
}

install_completions_fish() {
    cd "$srcdir/client/target/release"
    FISH_COMPLETIONS_FILE=$HOME/.cache/fish/generated_completions/shore.fish

    install -dm755 "$(dirname "$FISH_COMPLETIONS_FILE")"
    ./shore completions fish >"$FISH_COMPLETIONS_FILE"
}

install_shore-cli() {
    cd "$srcdir/client/target/release"
    SHORE_INSTALL_PATH=$HOME/.local/bin

    install -dm755 "$(dirname "$SHORE_INSTALL_PATH")"
    install -Dm755 "./shore" "$SHORE_INSTALL_PATH"
}

build
install_completions_fish
install_shore-cli
