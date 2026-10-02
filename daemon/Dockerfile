# Build from the repository root: docker build -f daemon/Dockerfile .
# compose.yaml at the root shows how to run it.

FROM rust:alpine AS patch-builder
RUN apk add --no-cache openssl-dev openssl-libs-static pkgconf
COPY --from=oven/bun:alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /build/daemon
COPY daemon/scripts/build_patch.ts scripts/build_patch.ts
COPY daemon/vendor/codex-apply-patch vendor/codex-apply-patch
RUN --mount=type=cache,target=/root/.cache/shore \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    bun run scripts/build_patch.ts

# Compiles the daemon into one executable and puts the Claude Code build that
# bun.lock pins beside it as shore-claude, so the runtime image needs no source
# and no node_modules.
FROM oven/bun:debian AS daemon-builder
WORKDIR /build/daemon
COPY daemon/package.json daemon/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY daemon/tsconfig.json ./
COPY daemon/prompts prompts
COPY daemon/scripts scripts
COPY daemon/src src
RUN bun run build:daemon

FROM debian:stable-slim
# Everything but tini is for the character: the bash tool runs in this
# container, so these are the commands it has.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    cargo \
    coreutils \
    curl \
    file \
    findutils \
    git \
    git-lfs \
    jq \
    python3 \
    python3-pip \
    ripgrep \
    sed \
    tini \
    tzdata \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

COPY --from=mikefarah/yq:latest /usr/bin/yq /usr/local/bin/yq
COPY --from=oven/bun:debian /usr/local/bin/bun /usr/local/bin/bun
# Commands from npm packages start with #!/usr/bin/env node, and bun runs them
# when it is called as node.
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && ln -s /usr/local/bin/bun /usr/local/bin/node
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# The default user owns the mount points, so named volumes start out writable.
# Any other UID works too (docker run --user, or user: in compose) as long as
# it can write the mounted directories and $HOME.
ARG USERNAME=app
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd -g "$USER_GID" "$USERNAME" \
    && useradd \
    -m \
    -u "$USER_UID" \
    -g "$USER_GID" \
    -d "/home/$USERNAME" \
    -s /bin/sh \
    "$USERNAME" \
    && install -d -o "$USER_UID" -g "$USER_GID" /config /data /cache /workspace

# TZ at run time sets the clock programs report, but the character also reads
# /etc/localtime and /etc/timezone to find the zone, so build them to match.
ARG TZ=UTC
RUN test -f "/usr/share/zoneinfo/$TZ" \
    && ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime \
    && echo "$TZ" > /etc/timezone
ENV TZ=${TZ}

# Root-owned and outside every mount, so nothing the character runs can change
# the daemon. shore-daemon finds shore-apply-patch and shore-claude beside it.
COPY --from=patch-builder /build/daemon/dist/shore-apply-patch /opt/shore/
COPY --from=daemon-builder /build/daemon/dist/shore-daemon /build/daemon/dist/shore-claude /opt/shore/
COPY --from=patch-builder /build/daemon/dist/codex-apply-patch.LICENSE /build/daemon/dist/codex-apply-patch.NOTICE /usr/local/share/licenses/shore/
COPY --from=daemon-builder /build/daemon/dist/claude-code.LICENSE.md /usr/local/share/licenses/shore/

USER ${USERNAME}
WORKDIR /workspace

# Listen on every interface inside the container; publish the port to choose
# who can reach it. Clients use the service's name instead, e.g.
# SHORE_ADDR=shore-daemon:7320.
ENV SHORE_ADDR=0.0.0.0:7320
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
# The character installs software as its own user (see prompts/tools/bash.md).
# pip may install into the user site although Debian marks the system Python
# as externally managed, and what the installers put in $HOME is on PATH.
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH=/home/${USERNAME}/.local/bin:/home/${USERNAME}/.bun/bin:/home/${USERNAME}/.cargo/bin:${PATH}
EXPOSE 7320
EXPOSE 7340

# tini reaps the processes the bash tool leaves behind and forwards stop
# signals. -s keeps that working under docker run --init too.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["/opt/shore/shore-daemon"]
