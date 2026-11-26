FROM rust:slim AS builder
WORKDIR /src
COPY client .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin shore \
    && cp target/release/shore /usr/local/bin/shore

FROM debian:testing
RUN apt-get update && apt-get install -y --no-install-recommends vim-tiny \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/shore /usr/local/bin/shore
RUN useradd -m -u 1000 shore
USER shore
ENV SHORE_ADDR=shore-daemon:7320
ENTRYPOINT ["shore"]
