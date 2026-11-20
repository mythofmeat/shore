#!/usr/bin/env bash
set -euo pipefail

daemon=$(cd "$(dirname "$0")/.." && pwd)
image=$(docker build -q --build-arg "BUN_VERSION=$(cat "$daemon/.bun-version")" -f "$daemon/scripts/isolation.Dockerfile" "$daemon/scripts")
exec docker run --rm -v "$daemon:/src/daemon:ro" "$image" "$@"
