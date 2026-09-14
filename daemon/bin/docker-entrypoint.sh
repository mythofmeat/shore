#!/bin/sh
set -e

username="${CONTAINER_USER:-bun}"

if [ "$username" != "bun" ]; then
  usermod -l "$username" bun
  groupmod -n "$username" bun
fi

exec su-exec "$username" "$@"
