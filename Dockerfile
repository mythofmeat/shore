# syntax=docker/dockerfile:1.7
#
# Shore — runtime images for the disposable compose test instance.
#
# Targets: `slim` (shore-daemon + shore-cli + the Bun LLM sidecar), `tui`
# (shore-tui), and `matrix` (shore-matrix). The builder stages share one
# cargo target cache, so workspace deps compile once across all three.
#
# shore-matrix is deliberately ABSENT from the daemon image:
# supervisor.rs::locate_matrix_binary() probes $PATH and the daemon's own
# directory, and returns None -> the Matrix supervisor silently no-ops.
# Presence of the binary IS the switch, so leaving it out is what disables
# in-daemon supervision. The bridge runs as its own compose service (the
# `matrix` target) against the daemon's TCP port instead.
#
# git is the load-bearing exec dependency: every character workspace is a real
# git repo and the compaction/dreaming passes commit to it. rg/fd/file/tree ride
# along for ~15 MB. The Rust and Node toolchains are deliberately absent — they
# would add ~2 GB for a character that mostly reads, writes, and commits prose.
#
# Builder and runtime are both bookworm on purpose — a trixie builder would
# link against a newer glibc than the bookworm runtime provides.

# ── Rust builder base ────────────────────────────────────────────────────
FROM rust:1-bookworm AS rust-builder
# The workspace .cargo/config.toml (COPYed below) sets clang + mold as the
# linker, so the builder must provide them — installed before COPY so source
# changes don't invalidate the apt layer.
RUN apt-get update && apt-get install -y --no-install-recommends clang mold \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .

# The target dir is a cache mount, so it is gone by the next layer: copy the
# binaries out inside the same RUN or they vanish. `sharing=locked` serializes
# concurrent builder stages against the shared cache, which is what lets them
# reuse each other's compiled deps instead of racing.
# The shore-cli crate builds a binary named `shore`, not `shore-cli`
# (crates/cli/Cargo.toml:9-10).
FROM rust-builder AS daemon-builder
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release -p shore-daemon -p shore-cli \
 && mkdir -p /out \
 && cp target/release/shore-daemon target/release/shore /out/

# Plain --release, not --profile tui-release (the Arch package's size
# profile): a different profile gets its own target subdir and would recompile
# every dep instead of sharing the cache with the other stages. Size doesn't
# matter for a throwaway test image.
FROM rust-builder AS tui-builder
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release -p shore-tui \
 && mkdir -p /out \
 && cp target/release/shore-tui /out/

FROM rust-builder AS matrix-builder
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release -p shore-matrix \
 && mkdir -p /out \
 && cp target/release/shore-matrix /out/

# ── LLM sidecar builder ──────────────────────────────────────────────────
FROM oven/bun:1-debian AS sidecar-builder
# The sidecar shares source with the workspace by design: src/llm/capabilities.ts
# imports "../../../crates/common/capabilities.toml" so the capability table has
# one definition, not two. Bun inlines it at build time, so this stage has to
# reproduce the repo-root layout or the import cannot resolve.
WORKDIR /src/llm-sidecar
COPY llm-sidecar/package.json llm-sidecar/bun.lock ./
RUN bun install --frozen-lockfile
COPY llm-sidecar/ ./
COPY crates/common/capabilities.toml /src/crates/common/capabilities.toml
# Produces a Bun bundle with a `#!/usr/bin/env bun` banner — NOT a standalone
# binary. The bun runtime has to ship in the final image alongside it.
RUN bun run build

# ── Runtime ──────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      ripgrep \
      fd-find \
      file \
      tree \
 # Debian ships fd as `fdfind`; exec resolves bare names off $PATH, so give it
 # the conventional one.
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# uid 1000 matches the host owner of the bind-mounted config dir. Without a
# real passwd entry git refuses some operations ("unable to look up current
# user"), so create the user rather than relying on compose's `user:` alone.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin shore

COPY --from=sidecar-builder /usr/local/bin/bun /usr/local/bin/bun
COPY --from=daemon-builder /out/shore-daemon /usr/local/bin/shore-daemon
COPY --from=daemon-builder /out/shore /usr/local/bin/shore
# The daemon probes for the sidecar next to its own binary or on $PATH.
COPY --from=sidecar-builder /src/llm-sidecar/dist/shore-llm-sidecar /usr/local/bin/shore-llm-sidecar

# SHORE_*_DIR beats XDG_* and is used verbatim — no "/shore" suffix appended
# (crates/common/src/config/mod.rs:134-156). SHORE_RUNTIME_DIR is set explicitly because
# the unset fallback is temp_dir()/shore; /tmp is 1777 so uid 1000 can write it,
# but naming it keeps the llm.sock location obvious.
ENV SHORE_CONFIG_DIR=/config \
    SHORE_DATA_DIR=/data \
    SHORE_CACHE_DIR=/cache \
    SHORE_RUNTIME_DIR=/tmp/shore

USER shore
ENTRYPOINT ["shore-daemon"]

# ── TUI runtime ──────────────────────────────────────────────────────────
# Interactive-only: run via `docker compose run --rm tui`, never detached.
# The tui talks plain TCP to the daemon and persists its view prefs
# daemon-side, so it needs no TLS certs, no config mounts, no env.
FROM debian:bookworm-slim AS tui

RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin shore

COPY --from=tui-builder /out/shore-tui /usr/local/bin/shore-tui

USER shore
ENTRYPOINT ["shore-tui"]

# ── Matrix bridge runtime ────────────────────────────────────────────────
# External mode only: the image ships no homeserver binary, so an `embedded`
# block in [connections.matrix] has nothing to spawn here. Point the bridge
# at a real homeserver via config or the MATRIX_* env vars instead.
# ca-certificates + libssl3 because the bridge speaks TLS to homeservers
# (reqwest native-tls links libssl dynamically); libsqlite3-0 because
# matrix-sdk's store links system sqlite, not a bundled copy.
FROM debian:bookworm-slim AS matrix

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libssl3 \
      libsqlite3-0 \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin shore

COPY --from=matrix-builder /out/shore-matrix /usr/local/bin/shore-matrix

# Same dir contract as the daemon image: the bridge reads [connections.matrix]
# from SHORE_CONFIG_DIR and keeps its session store under SHORE_DATA_DIR.
ENV SHORE_CONFIG_DIR=/config \
    SHORE_DATA_DIR=/data \
    SHORE_CACHE_DIR=/cache \
    SHORE_RUNTIME_DIR=/tmp/shore

USER shore
ENTRYPOINT ["shore-matrix"]
