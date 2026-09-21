FROM rust:alpine AS patch-builder
RUN apk add --no-cache bash clang cmake git make musl-dev openssl-dev openssl-libs-static pkgconf tar
COPY --from=oven/bun:alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /build/daemon
COPY daemon/scripts/build_patch.ts scripts/build_patch.ts
COPY daemon/vendor/codex-apply-patch vendor/codex-apply-patch
RUN --mount=type=cache,target=/build/daemon/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    bun run scripts/build_patch.ts

FROM alpine:latest
RUN apk update
RUN apk upgrade
RUN apk add bash ca-certificates coreutils curl findutils git jq ripgrep sed libgcc libstdc++ file
RUN apk add python3

COPY --from=oven/bun:alpine /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ARG USERNAME=app
ARG USER_UID=1000
ARG USER_GID=1000
RUN addgroup -g "$USER_GID" "$USERNAME" \
    && adduser \
    -D \
    -u "$USER_UID" \
    -G "$USERNAME" \
    -h "/home/$USERNAME" \
    -s /bin/sh \
    "$USERNAME" \
    && mkdir -p /app \
    && chown "$USER_UID:$USER_GID" /app

WORKDIR /app
COPY --chown=${USER_UID}:${USER_GID} ./daemon .
COPY --from=patch-builder /build/daemon/dist/shore-apply-patch /usr/local/bin/shore-apply-patch
COPY --from=patch-builder /build/daemon/dist/codex-apply-patch.LICENSE /build/daemon/dist/codex-apply-patch.NOTICE /usr/local/share/licenses/shore/
ENV SHORE_APPLY_PATCH_PATH=/usr/local/bin/shore-apply-patch

USER ${USERNAME}
RUN bun install 

ENV SHORE_ADDR=shore-daemon:7320
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
EXPOSE 7320

CMD ["bun", "run", "start"]
