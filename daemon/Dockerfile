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
RUN apt-get install -y tzda
RUN git lfs install --system

COPY --from=mikefarah/yq:latest /usr/bin/yq /usr/local/bin/yq
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --from=oven/bun:debian /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && ln -sf /usr/local/bin/bun /usr/local/bin/node
RUN printf '[global]\nbreak-system-packages = true\n' >/etc/pip.conf

ARG USERNAME=app
ARG USER_UID=1000
ARG USER_GID=1000
ARG CHARACTER_USERS=
RUN groupadd -g "$USER_GID" "$USERNAME"
RUN useradd -m -u "$USER_UID" -g "$USER_GID" -d "/home/$USERNAME" -s /bin/sh "$USERNAME"
RUN chmod 700 "/home/$USERNAME"
RUN install -d -o "$USER_UID" -g "$USER_GID" -m 700 /config /data /cache
RUN install -d -o "$USER_UID" -g "$USER_GID" /workspace
RUN mkdir -p /opt/shore
RUN echo "$USERNAME" >/opt/shore/daemon-user
RUN : >/opt/shore/character-users
RUN for entry in $CHARACTER_USERS; do \
    name="${entry%%:*}"; uid="${entry#"$name"}"; uid="${uid#:}"; \
    groupadd ${uid:+-g "$uid"} "$name" \
    && useradd -m ${uid:+-u "$uid"} -g "$name" -d "/home/$name" -s /bin/bash "$name" \
    && usermod -aG "$name" "$USERNAME" \
    && chmod 700 "/home/$name" \
    && install -d -o "$name" -g "$name" -m 2770 "/workspace/$name" \
    && echo "$name" >> /opt/shore/character-users \
    || exit 1; \
    done

ARG TZ=UTC
RUN test -f "/usr/share/zoneinfo/$TZ"
RUN ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
RUN echo "$TZ" >/etc/timezone
ENV TZ=${TZ}

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

ENV PATH=/home/${USERNAME}/.local/bin:/home/${USERNAME}/.bun/bin:/home/${USERNAME}/.cargo/bin:${PATH}
EXPOSE 7320
EXPOSE 7340

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/shore/entrypoint"]
CMD ["/opt/shore/shore-daemon"]
