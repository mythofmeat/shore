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
RUN apt-get install -y ca-certificates
RUN apt-get install -y cargo
RUN apt-get install -y curl
RUN apt-get install -y file
RUN apt-get install -y git
RUN apt-get install -y git-lfs
RUN apt-get install -y jq
RUN apt-get install -y openssh-client
RUN apt-get install -y procps
RUN apt-get install -y python3
RUN apt-get install -y python3-pip
RUN apt-get install -y ripgrep
RUN apt-get install -y tini
RUN apt-get install -y tzdata
RUN git lfs install --system

COPY --from=mikefarah/yq:latest /usr/bin/yq /usr/local/bin/yq
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --from=oven/bun:debian /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && ln -sf /usr/local/bin/bun /usr/local/bin/node
RUN printf '[global]\nbreak-system-packages = true\n' >/etc/pip.conf

ARG EXTRA_PACKAGES=
RUN if [ -n "$EXTRA_PACKAGES" ]; then \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y $EXTRA_PACKAGES; \
    fi

COPY daemon/entrypoint.sh /opt/shore/entrypoint
COPY --from=patch-builder /build/daemon/dist/shore-apply-patch /opt/shore/
COPY --from=daemon-builder /build/daemon/dist/shore-daemon /build/daemon/dist/shore-claude /opt/shore/
COPY --from=patch-builder /build/daemon/dist/codex-apply-patch.LICENSE /build/daemon/dist/codex-apply-patch.NOTICE /usr/local/share/licenses/shore/
COPY --from=daemon-builder /build/daemon/dist/claude-code.LICENSE.md /usr/local/share/licenses/shore/

WORKDIR /workspace

ENV SHORE_ADDR=0.0.0.0:7320
ENV SHORE_WEB_ADDR=0.0.0.0:7340
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace

EXPOSE 7320
EXPOSE 7340

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/shore/entrypoint"]
CMD ["/opt/shore/shore-daemon"]
