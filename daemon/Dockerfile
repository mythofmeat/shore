FROM oven/bun:latest
RUN apt-get update && apt-get --yes install --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    jq \
    python3 \
    ripgrep \
    sed
RUN rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY ./daemon .
RUN bun install 
RUN install -m 0755 bin/shore-patch.sh /usr/local/bin/shore-patch

ENV SHORE_ADDR=shore-daemon:7320
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace
EXPOSE 7320

RUN if [ "$USERNAME" != "bun" ]; then \
    usermod -l "$USERNAME" bun && \
    groupmod -n "$USERNAME" bun; \
    fi

CMD ["bun", "run", "start"]
