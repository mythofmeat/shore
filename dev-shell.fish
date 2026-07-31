#!/usr/bin/env fish

cd (status dirname)
begin # rust
    cargo build --workspace
end

begin # bun
    cd (status dirname)/llm-sidecar
    bun install
    bun update
    bun run build
    mv dist/shore-llm-sidecar ../target/debug/shore-llm-sidecar
    cd (status dirname)
end

function shore
    cargo run --bin shore $argv
end

function shore-tui
    cargo run --bin shore-tui $argv
end

function shore-daemon
    nohup cargo run --bin shore-daemon &
    string collect $last_pid >/tmp/SHORE_DAEMON_PID
end

function shore-daemon-stop
    set pid (cat /tmp/SHORE_DAEMON_PID)
    kill -INT $pid
end
