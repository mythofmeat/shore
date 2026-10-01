# Build from the repository root: docker build -f client/shore-cli/Dockerfile .
# compose.yaml at the root runs it against the daemon as the `shore` service.

FROM rust:alpine AS builder
WORKDIR /src
COPY client .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin shore \
    && cp target/release/shore /usr/local/bin/shore

FROM alpine:latest
COPY --from=builder /usr/local/bin/shore /usr/local/bin/shore
RUN adduser -D -u 1000 shore
USER shore
ENV SHORE_ADDR=shore-daemon:7320
ENTRYPOINT ["shore"]
