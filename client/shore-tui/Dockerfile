FROM rust:latest
COPY --chown=1000:1000 ./client /src
RUN cargo install --path /src/shore-tui
ENV SHORE_ADDR=shore-daemon:7320

CMD ["shore-tui"]
