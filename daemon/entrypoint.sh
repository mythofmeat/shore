#!/bin/sh
set -eu

if [ "$(id -u)" != 0 ]; then
	exec "$@"
fi

say() {
	echo "shore: $*" >&2
}

daemon_user=${SHORE_USER:-app}
daemon_home=/home/$daemon_user
workspace_root=${SHORE_WORKSPACE_DIR:-/workspace}

effective=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)
has_cap() {
	[ $(((0x$effective >> $1) & 1)) = 1 ]
}
if ! has_cap 0 || ! has_cap 6 || ! has_cap 7; then
	say "the container must keep CAP_CHOWN, CAP_SETUID and CAP_SETGID (cap_add: [SETUID, SETGID, KILL, CHOWN])" \
		"so it can make the users, then drop root and run characters' tools as their own users; refusing to run it as root"
	exit 1
fi
keep="+setuid,+setgid"
if has_cap 5; then
	keep="$keep,+kill"
else
	say "the container lacks CAP_KILL (cap_add: KILL), so timeouts and cancellation cannot stop characters' commands"
fi
if [ ! -w /etc ]; then
	say "the root filesystem must be writable (no read_only: true) so the users and timezone can be set at start"
	exit 1
fi

tz=${TZ:-UTC}
if [ -f "/usr/share/zoneinfo/$tz" ]; then
	ln -snf "/usr/share/zoneinfo/$tz" /etc/localtime
	echo "$tz" >/etc/timezone
else
	say "TZ=$tz is not a known timezone; the clock stays on UTC"
fi

ensure_user() {
	getent passwd "$1" >/dev/null && return
	getent group "$1" >/dev/null || groupadd ${3:+-g "$3"} "$1"
	useradd -M ${2:+-u "$2"} -g "$1" -d "/home/$1" -s "$4" "$1"
}

give_fresh_dir() {
	[ -d "$1" ] || mkdir -p "$1"
	[ "$(stat -c %u "$1")" = 0 ] || return 0
	[ -z "${3:-}" ] || chmod "$3" "$1"
	chown "$2:" "$1"
}

ensure_user "$daemon_user" "${SHORE_UID:-1000}" "${SHORE_GID:-${SHORE_UID:-1000}}" /bin/sh
daemon_uid=$(id -u "$daemon_user")
daemon_gid=$(id -g "$daemon_user")

as_daemon() {
	setpriv --reuid="$daemon_uid" --regid="$daemon_gid" --init-groups --inh-caps=-all --ambient-caps=-all -- "$@"
}

for dir in /config /data /cache "$daemon_home" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"}; do
	give_fresh_dir "$dir" "$daemon_user" 700
	if [ "$(stat -c %u "$dir")" != "$daemon_uid" ]; then
		say "$dir belongs to uid $(stat -c %u "$dir"), not to $daemon_user (uid $daemon_uid); the daemon may not be able to use it"
		continue
	fi
	if [ "$(($(stat -c %a "$dir") % 100))" != 0 ]; then
		as_daemon chmod go-rwx "$dir"
		say "made $dir private to $daemon_user, so characters' users cannot open it"
	fi
done

for entry in ${SHORE_CHARACTER_USERS:-}; do
	name=${entry%%:*}
	uid=${entry#"$name"}
	uid=${uid#:}
	ensure_user "$name" "$uid" "$uid" /bin/bash
	usermod -aG "$name" "$daemon_user"
	uid=$(id -u "$name")
	gid=$(id -g "$name")

	home=/home/$name
	give_fresh_dir "$home" "$name" 700
	if [ "$(stat -c %u "$home")" != "$uid" ]; then
		say "$home belongs to uid $(stat -c %u "$home"), not to $name (uid $uid)"
	fi

	workspace=$workspace_root/$name
	[ -d "$workspace" ] || { mkdir -p -m 2770 "$workspace" && chown "$name:" "$workspace"; } 2>/dev/null || true
	if [ ! -d "$workspace" ]; then
		say "$name has no workspace at $workspace; create it owned by $uid:$gid with mode 2770"
	elif [ "$(stat -c %u "$workspace")" != "$uid" ]; then
		say "$workspace belongs to uid $(stat -c %u "$workspace"), not to $name (uid $uid); $name's tools cannot write it"
	elif ! as_daemon test -r "$workspace" -a -x "$workspace"; then
		say "$daemon_user cannot read $workspace; give it group $gid, which $daemon_user is in, and mode 2770"
	fi
done
give_fresh_dir "$workspace_root" "$daemon_user"

export HOME="$daemon_home" USER="$daemon_user" LOGNAME="$daemon_user"
export PATH="$daemon_home/.local/bin:$daemon_home/.bun/bin:$daemon_home/.cargo/bin:$PATH"
exec setpriv --reuid="$daemon_uid" --regid="$daemon_gid" --init-groups \
	--inh-caps="-all,$keep" --ambient-caps="-all,$keep" -- "$@"
