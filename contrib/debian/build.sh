#!/bin/sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=$(mkdir -p "${1:-$root/out/debian}" && cd "${1:-$root/out/debian}" && pwd)
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/daemon/package.json")
arch=$(dpkg --print-architecture)

cd "$root/daemon"
bun install --frozen-lockfile
bun run build

stage=$(mktemp -d)
pkg="$stage/debian/shore-daemon"
lib="$pkg/usr/lib/shore-daemon"
doc="$pkg/usr/share/doc/shore-daemon"
install -Dm755 -t "$lib" dist/shore-daemon dist/shore-apply-patch
strip "$lib/shore-apply-patch"
install -Dm644 "$here/shore-daemon.service" "$pkg/usr/lib/systemd/system/shore-daemon.service"
install -Dm644 "$here/shore-daemon.tmpfiles" "$pkg/usr/lib/tmpfiles.d/shore-daemon.conf"
install -Dm644 -t "$doc" "$root/LICENSE-MIT" "$root/LICENSE-APACHE-2.0" \
	dist/codex-apply-patch.LICENSE dist/codex-apply-patch.NOTICE
install -Dm755 -t "$pkg/DEBIAN" "$here/postinst" "$here/prerm" "$here/postrm"

printf 'Source: shore\n\nPackage: shore-daemon\nArchitecture: any\n' >"$stage/debian/control"
depends=$(cd "$stage" && dpkg-shlibdeps -O -e "${lib#"$stage/"}/shore-daemon" -e "${lib#"$stage/"}/shore-apply-patch" |
	sed -n 's/^shlibs:Depends=//p')
size=$(du -sk --exclude=DEBIAN "$pkg" | cut -f1)
sed -e "s/@VERSION@/$version/" -e "s/@ARCH@/$arch/" -e "s/@DEPENDS@/$depends/" -e "s/@SIZE@/$size/" \
	"$here/control" >"$pkg/DEBIAN/control"

dpkg-deb --root-owner-group --build "$pkg" "$out/shore-daemon_${version}_${arch}.deb"
