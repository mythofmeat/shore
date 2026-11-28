ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-debian
RUN apt-get update -qq \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git >/dev/null \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd -g 3000 shore \
	&& useradd -m -u 3000 -g 3000 shore \
	&& for entry in ada:3001 bea:3002; do \
		name=${entry%%:*}; \
		groupadd -g "${entry#*:}" "$name"; \
		useradd -m -u "${entry#*:}" -g "$name" "$name"; \
		usermod -aG "$name" shore; \
		usermod -aG shore "$name"; \
	done \
	&& chmod 700 /home/shore /home/ada /home/bea \
	&& install -d -o shore -g shore -m 755 /srv/isolation /srv/isolation/workspace \
	&& install -d -o shore -g shore -m 700 /srv/isolation/config \
	&& echo isolation-secret >/srv/isolation/config/token \
	&& chown shore:shore /srv/isolation/config/token \
	&& chmod 600 /srv/isolation/config/token \
	&& for name in ada bea; do install -d -o "$name" -g "$name" -m 2770 "/srv/isolation/workspace/$name"; done \
	&& install -d -o ada -g ada -m 700 /run/user/3001
WORKDIR /src/daemon
ENTRYPOINT ["setpriv", "--reuid=shore", "--regid=shore", "--init-groups", "--no-new-privs", "--inh-caps=-all,+setuid,+setgid,+kill", "--ambient-caps=-all,+setuid,+setgid,+kill", "env", "HOME=/home/shore", "USER=shore", "LOGNAME=shore", "SHORE_ISOLATION_ROOT=/srv/isolation", "SHORE_ISOLATION_USER=ada", "SHORE_ISOLATION_OTHER_USER=bea", "SHORE_GENERATED=1", "bun", "test"]
CMD ["tests/isolation.test.ts"]
