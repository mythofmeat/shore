#!/bin/sh
# Starts the daemon as its own user, keeping the three capabilities it needs
# to run each character's tools as that character's user: CAP_SETUID and
# CAP_SETGID to switch to it, and CAP_KILL to stop its commands on timeout or
# cancellation. Started as any other user, it runs the daemon unchanged.
set -eu

if [ "$(id -u)" != 0 ]; then
	exec "$@"
fi

say() {
	echo "shore: $*" >&2
}

daemon_user=$(cat /opt/shore/daemon-user)
entry=$(getent passwd "$daemon_user") || {
	say "the image's daemon user $daemon_user is missing"
	exit 1
}
daemon_uid=$(echo "$entry" | cut -d: -f3)
daemon_gid=$(echo "$entry" | cut -d: -f4)
daemon_home=$(echo "$entry" | cut -d: -f6)

effective=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)
has_cap() {
	[ $(((0x$effective >> $1) & 1)) = 1 ]
}
if ! has_cap 6 || ! has_cap 7; then
	say "the container must keep CAP_SETUID and CAP_SETGID (cap_add: [SETUID, SETGID, KILL])" \
		"so the daemon can drop root and run characters' tools as their own users; refusing to run it as root"
	exit 1
fi
keep="+setuid,+setgid"
if has_cap 5; then
	keep="$keep,+kill"
else
	say "the container lacks CAP_KILL (cap_add: KILL), so timeouts and cancellation cannot stop characters' commands"
fi

as_daemon() {
	setpriv --reuid="$daemon_uid" --regid="$daemon_gid" --init-groups --inh-caps=-all --ambient-caps=-all -- "$@"
}

for dir in /config /data /cache "$daemon_home" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"}; do
	[ -d "$dir" ] || continue
	if [ "$(stat -c %u "$dir")" != "$daemon_uid" ]; then
		say "$dir belongs to uid $(stat -c %u "$dir"), not to $daemon_user (uid $daemon_uid); the daemon may not be able to use it"
		continue
	fi
	if [ "$(($(stat -c %a "$dir") % 100))" != 0 ]; then
		as_daemon chmod go-rwx "$dir"
		say "made $dir private to $daemon_user, so characters' users cannot open it"
	fi
done

while read -r name; do
	[ -n "$name" ] || continue
	uid=$(id -u "$name" 2>/dev/null) || {
		say "character user $name is missing from the image"
		continue
	}
	home=$(getent passwd "$name" | cut -d: -f6)
	if [ ! -d "$home" ]; then
		say "$name has no home at $home; mount a volume there"
	elif [ "$(stat -c %u "$home")" != "$uid" ]; then
		say "$home belongs to uid $(stat -c %u "$home"), not to $name (uid $uid)"
	fi
	workspace="${SHORE_WORKSPACE_DIR:-/workspace}/$name"
	if [ ! -d "$workspace" ]; then
		say "$name has no workspace at $workspace; create it owned by $name with group $daemon_gid and mode 2750"
	elif [ "$(stat -c %u "$workspace")" != "$uid" ]; then
		say "$workspace belongs to uid $(stat -c %u "$workspace"), not to $name (uid $uid); $name's tools cannot write it"
	elif ! as_daemon test -r "$workspace" -a -x "$workspace"; then
		say "$daemon_user cannot read $workspace; give it group $daemon_gid and mode 2750"
	fi
done </opt/shore/character-users

export HOME="$daemon_home" USER="$daemon_user" LOGNAME="$daemon_user"
exec setpriv --reuid="$daemon_uid" --regid="$daemon_gid" --init-groups \
	--inh-caps="-all,$keep" --ambient-caps="-all,$keep" -- "$@"
