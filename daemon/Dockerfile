FROM oven/bun:latest
RUN apt-get update && apt-get --yes install --no-install-recommends bash ca-certificates coreutils curl findutils git jq python3 ripgrep sed && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY ./daemon .
RUN bun install

ENV SHORE_ADDR=shore-daemon:7320
EXPOSE 7320

ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_WORKSPACE_DIR=/workspace

CMD ["bun", "run", "start"]
