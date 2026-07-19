#!/usr/bin/fish

cd (status dirname)
set -U SHORE_SRC_DIR (git rev-parse --show-toplevel)

cd $SHORE_SRC_DIR

set _depends \
    cargo \
    bun

begin # dep checks and updates
    set fail false

    for d in $_depends
        if not command -q $d
            echo "ERROR: $d is not installed!"
            set -x fail true
        end
    end
    if test "$fail" = true
        exit 1
    end

    rustup toolchain install
    rustup toolchain update
    cargo install cargo-sweep
end

cargo sweep -f

begin # install shore-*
    cargo update
    cargo build --workspace
    cd ./backend/llm-sidecar
    bun install
    bun update
    bun run build
    install -m755 ./dist/shore-llm-sidecar $SHORE_SRC_DIR/target/debug/shore-llm-sidecar
    cd $SHORE_SRC_DIR
    install -m755 ./contrib/fish/shore.fish $HOME/.local/bin/shore
    install -m755 ./contrib/fish/shore-tui.fish $HOME/.local/bin/shore-tui
end

cargo sweep -s
