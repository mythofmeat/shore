#!/usr/bin/env python3
"""Exercise browser authentication, compatibility, correlation and network limits."""
import sys

from mutation import run

SERVER = "src/web/server.ts"
SOCKET = "src/web/socket.ts"
AUTH = "src/web/auth.ts"
POLICY = "src/web/policy.ts"

MUTANTS = [
    ("sign-in accepts the wrong daemon token", SERVER,
     'if (!options.authenticate(body.token) && !codes.redeem(body.token)) {',
     'if (false) {'),
    ("a page on another host or port can use the daemon", POLICY,
     'if (origin === publicOrigin || originHost(origin) === host) return { origin };',
     'return { origin };'),
    ("a request with no Origin header reaches the API", POLICY,
     'if (origin === null) return { refused:',
     'if (origin === null) return { origin: "", ignored:'),
    ("a same-site page can use the daemon", POLICY,
     '["cross-site", "same-site"].includes(',
     '["cross-site"].includes('),
    ("a proxy that rewrites Host is refused despite its public origin", POLICY,
     'origin === publicOrigin || ',
     ''),
    ("an HTTPS page gets a cookie without Secure", SERVER,
     'const secureCookie = page.origin.startsWith("https:");',
     'const secureCookie = false;'),
    ("using a sign-in does not extend it", AUTH,
     'stored.expiresAt = expiresAt;',
     'void expiresAt;'),
    ("a renewed sign-in keeps the browser's old cookie expiry", SERVER,
     'headers.set("set-cookie", sessions.renew(session, request, secureCookie));',
     'sessions.renew(session, request, secureCookie);'),
    ("a sign-in code works more than once", AUTH,
     'this.#codes.delete(id);\n    return expiresAt',
     'return expiresAt'),
    ("an expired sign-in code still works", AUTH,
     'return expiresAt !== undefined && expiresAt > Date.now();',
     'return expiresAt !== undefined;'),
    ("sign-in codes pile up without a bound", AUTH,
     'while (this.#codes.size >= this.capacity) {',
     'while (false) {'),
    ("an incompatible tab reaches the shared peer", SERVER,
     'if (request.headers.get("sec-websocket-protocol") !== WEB_SUBPROTOCOL) {',
     'if (false) {'),
    ("pending WebSockets do not count against the connection limit", SERVER,
     'if (http.pendingWebSockets >= config.max_connections || peers.size >= config.max_connections) {',
     'if (false) {'),
    ("browser script can read the authentication cookie", AUTH,
     'httpOnly: true, sameSite: "strict", secure, path: "/",',
     'httpOnly: false, sameSite: "strict", secure, path: "/",'),
    ("logout and expiry leave an authenticated socket alive", AUTH,
     'stored.controller.abort(new Error("Browser sign-in expired or was revoked"));',
     'void stored.controller;'),
    ("pending requests have no aggregate byte bound", SOCKET,
     'state.pending.size >= WEB_LIMITS.pendingRequests || state.pendingBytes + bytes > this.#maxBytes',
     'state.pending.size >= WEB_LIMITS.pendingRequests'),
    ("a repeated request ID reaches the application again", SOCKET,
     ' || state.pending.has(rid)',
     ''),
    ("a paused network reader can hold the peer indefinitely", SOCKET,
     'this.close(socket, 1013, "Slow connection; reconnect to refresh history");',
     'void socket;'),
    ("a buffered send is sent again after draining", SOCKET,
     'delete socket.data.drain;\n        resolve();',
     'delete socket.data.drain;\n        socket.send(JSON.stringify(message));\n        resolve();'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/web_transport.test.ts"]))
