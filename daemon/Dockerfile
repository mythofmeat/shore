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

FROM oven/bun:debian AS daemon-builder
WORKDIR /build/daemon
COPY daemon/package.json daemon/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY daemon/tsconfig.json ./
COPY daemon/prompts prompts
COPY daemon/scripts scripts
COPY daemon/src src
RUN bun run build:daemon

FROM debian:stable
RUN apt-get update && apt-get upgrade -y

###################
### Mandatory packages ###
RUN apt-get update && apt-get install -y \
    ca-certificates \
    git \
    git-lfs \
    openssh-client \
    procps \
    ripgrep \
    tini \
    tzdata
RUN git lfs install --system

### Basic utilities ###
#### media
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    libimage-exiftool-perl \
    sox

#### archives / compression
RUN apt-get update && apt-get install -y \
    unzip \
    zip \
    zstd

#### network / transfer
RUN apt-get update && apt-get install -y \
    curl \
    iproute2 \
    rsync

#### data wrangling
COPY --from=mikefarah/yq:latest /usr/bin/yq /usr/local/bin/yq
RUN apt-get update && apt-get install -y \
    bc \
    jq \
    sqlite3

#### inspecting files
RUN apt-get update && apt-get install -y \
    bsdextrautils \
    file \
    tree \
    xxd

### Runtimes and languages ###

#### Rust
RUN apt-get update && apt-get install -y \
    cargo

#### Python
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip
RUN apt-get update && apt-get install -y \
    python3-matplotlib \
    python3-numpy \
    python3-pil \
    python3-zstandard
RUN printf '[global]\nbreak-system-packages = true\n' >/etc/pip.conf

#### Bun
COPY --from=oven/bun:debian /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && ln -sf /usr/local/bin/bun /usr/local/bin/node

###################

COPY --from=patch-builder /build/daemon/dist/shore-apply-patch /opt/shore/
COPY --from=daemon-builder /build/daemon/dist/shore-daemon /build/daemon/dist/shore-claude /opt/shore/
COPY --from=patch-builder /build/daemon/dist/codex-apply-patch.LICENSE /build/daemon/dist/codex-apply-patch.NOTICE /usr/local/share/licenses/shore/
COPY --from=daemon-builder /build/daemon/dist/claude-code.LICENSE.md /usr/local/share/licenses/shore/

ARG SHORE_UID=1000
ARG SHORE_GID=1000
ARG SHORE_CHARACTER_USERS=""
RUN groupadd -g "$SHORE_GID" shore \
    && useradd -M -u "$SHORE_UID" -g shore -d /home/shore -s /bin/sh shore \
    && install -d -o shore -g shore -m 700 /config /data /cache /home/shore \
    && install -d -o shore -g shore /workspace \
    && for entry in $SHORE_CHARACTER_USERS; do \
        name=${entry%%:*}; uid=${entry#"$name"}; uid=${uid#:}; \
        groupadd ${uid:+-g "$uid"} "$name" \
        && useradd -M ${uid:+-u "$uid"} -g "$name" -d "/home/$name" -s /bin/bash "$name" \
        && usermod -aG "$name" shore \
        && usermod -aG shore "$name" \
        && install -d -o "$name" -g "$name" -m 700 "/home/$name" \
        && install -d -o "$name" -g "$name" -m 2770 "/workspace/$name" \
        || exit 1; \
    done

WORKDIR /workspace

ENV HOME=/home/shore USER=shore LOGNAME=shore
ENV PATH=/home/shore/.local/bin:/home/shore/.bun/bin:/home/shore/.cargo/bin:$PATH
ENV SHORE_ADDR=0.0.0.0:7320
ENV SHORE_WEB_ADDR=0.0.0.0:7340
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace

EXPOSE 7320
EXPOSE 7340

ENTRYPOINT ["/usr/bin/tini", "-s", "--", \
    "setpriv", "--reuid=shore", "--regid=shore", "--init-groups", \
    "--inh-caps=-all,+setuid,+setgid,+kill", "--ambient-caps=-all,+setuid,+setgid,+kill", "--"]
CMD ["/opt/shore/shore-daemon"]
