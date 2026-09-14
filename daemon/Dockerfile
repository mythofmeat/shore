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
RUN install -m 0755 bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh 

ENV SHORE_ADDR=shore-daemon:7320
EXPOSE 7320

ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
