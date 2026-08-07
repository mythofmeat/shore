FROM rust:latest AS rust
WORKDIR /src
COPY . .
RUN cargo build --release --bin shore
RUN cargo build --release --bin shore-tui

FROM oven/bun:latest AS bun
WORKDIR /src
COPY . .
WORKDIR /src/daemon
RUN bun install
RUN bun run build

FROM archlinux:latest AS entry
COPY --from=rust    /src/target/release/shore /usr/bin/shore
COPY --from=rust    /src/target/release/shore-tui /usr/bin/shore-tui
COPY --from=bun     /src/daemon/dist/shore-daemon /usr/bin/shore-daemon

RUN groupadd --gid 1000 shore \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash shore
RUN mkdir -p /home/shore/.config/nvim /home/shore/.local/share/nvim /shared

RUN pacman -Syu --noconfirm neovim
RUN pacman -Syu --noconfirm yazi
RUN pacman -Syu --noconfirm fd
RUN pacman -Syu --noconfirm ripgrep
RUN pacman -Syu --noconfirm fzf
RUN pacman -Syu --noconfirm git
RUN pacman -Syu --noconfirm tree-sitter-cli
RUN pacman -Syu --noconfirm python
RUN pacman -Syu --noconfirm bun
RUN pacman -Syu --noconfirm unzip
ENV EDITOR=nvim

ENV HOME=/home/shore
# The mount points are created and owned here so a named volume inherits uid
# 1000 rather than root. A bind mount takes its owner from the host either way.
RUN mkdir -p /config /data /cache /workspace \
    && chown -R 1000:1000 /home/shore /shared /config /data /cache /workspace
WORKDIR /shared

ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
ENV SHORE_UNSAFE_ALLOW_REMOTE_ACCESS=1
ENV SHORE_ADDR=0.0.0.0:7320

EXPOSE 7320

# Everything above needs root — pacman, useradd, chown. Nothing below does:
# the daemon binds 7320, which is not privileged. Running as the owner of the
# mounts is also what keeps git usable inside the workspace, which is a real
# repository the memory passes commit to.
USER shore

CMD ["shore-daemon"]
