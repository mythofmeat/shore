FROM rust:latest AS rust
WORKDIR /src
COPY . .
RUN cargo build --bin shore-daemon --release

FROM oven/bun:latest
COPY --from=rust /src /src
WORKDIR /src/llm-sidecar
RUN bun install
RUN bun run build
RUN mv dist/shore-llm-sidecar ../target/release
WORKDIR /src/target/release
ENV SHORE_CONFIG_DIR=/config
ENV SHORE_DATA_DIR=/data
ENV SHORE_CACHE_DIR=/cache
ENV SHORE_ADDR=0.0.0.0
ENV SHORE_UNSAFE_ALLOW_REMOTE_ACCESS=1

CMD ["./shore-daemon"]


# FROM debian:testing-slim
# COPY --from=rust /src/target/release/shore /usr/bin/shore
# COPY --from=rust /src/target/release/shore-tui /usr/bin/shore-tui
# COPY --from=rust /src/target/release/shore-matrix /usr/lib/shore/shore-matrix
# COPY --from=bun /src/llm-sidecar/dist/shore-llm-sidecar /usr/lib/shore/shore-llm-sidecar
#
# RUN apt-get update 
# RUN apt-get install npm --yes
# RUN npm install -g bun
# RUN apt-get install curl --yes
# RUN curl -fsSL -o /usr/share/keyrings/tuwunel-archive-keyring.gpg https://apt.f.dog/tuwunel-archive-keyring.gpg
# RUN tee /etc/apt/sources.list.d/tuwunel.sources >/dev/null <<EOF
# Types: deb
# URIs: https://apt.f.dog
# Suites: stable
# Components: main
# Signed-By: /usr/share/keyrings/tuwunel-archive-keyring.gpg
# EOF
# RUN apt-get update
# RUN apt-get install tuwunel --yes
