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

# The daemon runs as USERNAME, which owns the mount points, so named volumes
# start out writable, and only it can open /config, /data and /cache.
#
# CHARACTER_USERS ("name" or "name:uid", separated by spaces) creates a user
# for each character, with a group of the same name and number, a private
# home under /home and a workspace under /workspace that belongs to both.
# The daemon's user joins each of those groups so it can read the workspace;
# join one with the same gid on the host to read and write it yourself. Set
# tools.user to that name in the character's config.toml and its tools run
# as that user.
# The daemon switches to it when started as root with cap_add SETUID, SETGID
# and KILL, as in compose.yaml. Started as any other UID (docker run --user,
# or user: in compose), it runs every tool as that UID.
ARG USERNAME=app
ARG USER_UID=1000
ARG USER_GID=1000
ARG CHARACTER_USERS=
RUN groupadd -g "$USER_GID" "$USERNAME" \
    && useradd \
    -m \
    -u "$USER_UID" \
    -g "$USER_GID" \
    -d "/home/$USERNAME" \
    -s /bin/sh \
    "$USERNAME" \
    && chmod 700 "/home/$USERNAME" \
    && install -d -o "$USER_UID" -g "$USER_GID" -m 700 /config /data /cache \
    && install -d -o "$USER_UID" -g "$USER_GID" /workspace \
    && mkdir -p /opt/shore \
    && echo "$USERNAME" > /opt/shore/daemon-user \
    && : > /opt/shore/character-users \
    && for entry in $CHARACTER_USERS; do \
    name="${entry%%:*}"; uid="${entry#"$name"}"; uid="${uid#:}"; \
    groupadd ${uid:+-g "$uid"} "$name" \
    && useradd -m ${uid:+-u "$uid"} -g "$name" -d "/home/$name" -s /bin/bash "$name" \
    && usermod -aG "$name" "$USERNAME" \
    && chmod 700 "/home/$name" \
    && install -d -o "$name" -g "$name" -m 2770 "/workspace/$name" \
    && echo "$name" >> /opt/shore/character-users \
    || exit 1; \
    done

# TZ at run time sets the clock programs report, but the character also reads
# /etc/localtime and /etc/timezone to find the zone, so build them to match.
ARG TZ=UTC
RUN test -f "/usr/share/zoneinfo/$TZ" \
    && ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime \
    && echo "$TZ" > /etc/timezone
ENV TZ=${TZ}

# Root-owned and outside every mount, so nothing the character runs can change
# the daemon. shore-daemon finds shore-apply-patch and shore-claude beside it.
COPY daemon/entrypoint.sh /opt/shore/entrypoint
COPY --from=patch-builder /build/daemon/dist/shore-apply-patch /opt/shore/
COPY --from=daemon-builder /build/daemon/dist/shore-daemon /build/daemon/dist/shore-claude /opt/shore/
COPY --from=patch-builder /build/daemon/dist/codex-apply-patch.LICENSE /build/daemon/dist/codex-apply-patch.NOTICE /usr/local/share/licenses/shore/
COPY --from=daemon-builder /build/daemon/dist/claude-code.LICENSE.md /usr/local/share/licenses/shore/

WORKDIR /workspace

# Listen on every interface inside the container; publish the port to choose
# who can reach it. Clients use the service's name instead, e.g.
# SHORE_ADDR=shore-daemon:7320. SHORE_WEB_ADDR serves the browser client;
# set it empty to leave that to [daemon.web] in config.toml.
ENV SHORE_ADDR=0.0.0.0:7320
ENV SHORE_WEB_ADDR=0.0.0.0:7340
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
# The character installs software as its own user (see prompts/tools/bash.md).
# pip may install into the user site although Debian marks the system Python
# as externally managed. What the installers put in $HOME is on PATH: below
# for tools that run as the daemon's user, and added by the daemon for a
# character with a user of its own.
RUN printf '[global]\nbreak-system-packages = true\n' > /etc/pip.conf
ENV PATH=/home/${USERNAME}/.local/bin:/home/${USERNAME}/.bun/bin:/home/${USERNAME}/.cargo/bin:${PATH}
EXPOSE 7320
EXPOSE 7340

# tini reaps the processes the bash tool leaves behind and forwards stop
# signals. -s keeps that working under docker run --init too. The entrypoint
# drops root before starting the daemon.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/shore/entrypoint"]
CMD ["/opt/shore/shore-daemon"]
