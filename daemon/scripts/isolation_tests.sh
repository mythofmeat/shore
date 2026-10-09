#!/usr/bin/env bash
# Runs tests/isolation.test.ts the way the Docker image runs the daemon: as an
# ordinary user holding only CAP_SETUID, CAP_SETGID and CAP_KILL, with two
# characters' tools running as users of their own. Switching users needs root,
# so this happens in a throwaway container; the ordinary test suite skips
# these tests. Needs Docker, and bun install (and bun run build:patch, for the
# apply_patch test) in daemon/ first.
set -euo pipefail

daemon=$(cd "$(dirname "$0")/.." && pwd)

exec docker run --rm -i \
	-v "$daemon:/src/daemon:ro" \
	"oven/bun:$(cat "$daemon/.bun-version")-debian" bash -s <<'CONTAINER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends git >/dev/null
groupadd -g 3000 shore
useradd -m -u 3000 -g 3000 shore
for entry in ada:3001 bea:3002; do
	name=${entry%%:*}
	groupadd -g "${entry#*:}" "$name"
	useradd -m -u "${entry#*:}" -g "$name" "$name"
	usermod -aG "$name" shore
done
chmod 700 /home/shore /home/ada /home/bea
install -d -o shore -g shore -m 755 /srv/isolation /srv/isolation/workspace
install -d -o shore -g shore -m 700 /srv/isolation/config
echo isolation-secret >/srv/isolation/config/token
chown shore:shore /srv/isolation/config/token
chmod 600 /srv/isolation/config/token
for name in ada bea; do
	install -d -o "$name" -g "$name" -m 2770 "/srv/isolation/workspace/$name"
done
cd /src/daemon
exec setpriv --reuid=shore --regid=shore --init-groups --no-new-privs \
	--inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill \
	env HOME=/home/shore USER=shore LOGNAME=shore \
	SHORE_ISOLATION_ROOT=/srv/isolation SHORE_ISOLATION_USER=ada SHORE_ISOLATION_OTHER_USER=bea \
	bun test tests/isolation.test.ts
CONTAINER
