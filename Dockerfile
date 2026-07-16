# syntax=docker/dockerfile:1.7
#
# Shore daemon — slim runtime image.
#
# Scope: shore-daemon + shore-cli + the Bun LLM sidecar. shore-matrix and
# shore-tui live in their own repos and are not built here.
#
# shore-matrix is deliberately ABSENT: supervisor.rs::locate_matrix_binary()
# probes $PATH and the daemon's own directory, and returns None -> the Matrix
# supervisor silently no-ops. Presence of the binary IS the switch, so leaving
# it out is what disables in-daemon supervision. Run the bridge as its own
# service against the daemon's TCP port instead.
#
# git is the load-bearing exec dependency: every character workspace is a real
# git repo and the compaction/dreaming passes commit to it. rg/fd/file/tree ride
# along for ~15 MB. The Rust and Node toolchains are deliberately absent — they
# would add ~2 GB for a character that mostly reads, writes, and commits prose.
#
# Builder and runtime are both bookworm on purpose — a trixie builder would
# link against a newer glibc than the bookworm runtime provides.

# ── Rust builder ─────────────────────────────────────────────────────────
FROM rust:1-bookworm AS rust-builder
WORKDIR /src
COPY . .
# The target dir is a cache mount, so it is gone by the next layer: copy the
# binaries out inside the same RUN or they vanish.
# The shore-cli crate builds a binary named `shore`, not `shore-cli`
# (clients/cli/Cargo.toml:9-10).
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release -p shore-daemon -p shore-cli \
 && mkdir -p /out \
 && cp target/release/shore-daemon target/release/shore /out/

# ── LLM sidecar builder ──────────────────────────────────────────────────
FROM oven/bun:1-debian AS sidecar-builder
# The sidecar shares source with the workspace by design: src/llm/capabilities.ts
# imports "../../../../core/config/capabilities.toml" so the capability table has
# one definition, not two. Bun inlines it at build time, so this stage has to
# reproduce the repo-root layout or the import cannot resolve.
WORKDIR /src/backend/llm-sidecar
COPY backend/llm-sidecar/package.json backend/llm-sidecar/bun.lock ./
RUN bun install --frozen-lockfile
COPY backend/llm-sidecar/ ./
COPY core/config/capabilities.toml /src/core/config/capabilities.toml
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
COPY --from=rust-builder /out/shore-daemon /usr/local/bin/shore-daemon
COPY --from=rust-builder /out/shore /usr/local/bin/shore
# The daemon probes for the sidecar next to its own binary or on $PATH.
COPY --from=sidecar-builder /src/backend/llm-sidecar/dist/shore-llm-sidecar /usr/local/bin/shore-llm-sidecar

# SHORE_*_DIR beats XDG_* and is used verbatim — no "/shore" suffix appended
# (core/config/src/lib.rs:134-156). SHORE_RUNTIME_DIR is set explicitly because
# the unset fallback is temp_dir()/shore; /tmp is 1777 so uid 1000 can write it,
# but naming it keeps the llm.sock location obvious.
ENV SHORE_CONFIG_DIR=/config \
    SHORE_DATA_DIR=/data \
    SHORE_CACHE_DIR=/cache \
    SHORE_RUNTIME_DIR=/tmp/shore

USER shore
ENTRYPOINT ["shore-daemon"]
