FROM rust:latest AS rust
WORKDIR /src
COPY . .
RUN cargo build --workspace --release

FROM oven/bun:latest AS bun
WORKDIR /src
COPY . .
WORKDIR /src/llm-sidecar
RUN bun install
RUN bun run build 

FROM debian:testing-slim
COPY --from=rust /src/target/release/shore /usr/bin/shore
COPY --from=rust /src/target/release/shore-daemon /usr/bin/shore-daemon
COPY --from=rust /src/target/release/shore-tui /usr/bin/shore-tui
COPY --from=rust /src/target/release/shore-matrix /usr/lib/shore/shore-matrix
COPY --from=bun /src/llm-sidecar/dist/shore-llm-sidecar /usr/lib/shore/shore-llm-sidecar

RUN apt-get update 
RUN apt-get install npm --yes
RUN npm install -g bun
RUN apt-get install curl --yes
RUN curl -fsSL -o /usr/share/keyrings/tuwunel-archive-keyring.gpg https://apt.f.dog/tuwunel-archive-keyring.gpg
RUN tee /etc/apt/sources.list.d/tuwunel.sources >/dev/null <<EOF
Types: deb
URIs: https://apt.f.dog
Suites: stable
Components: main
Signed-By: /usr/share/keyrings/tuwunel-archive-keyring.gpg
EOF
RUN apt-get update
RUN apt-get install tuwunel --yes

ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache

CMD ["shore-daemon"]
