#!/usr/bin/env python3
"""Exercise browser authentication, compatibility, correlation and network limits."""
import sys

from mutation import run

SERVER = "src/web/server.ts"
SOCKET = "src/web/socket.ts"
AUTH = "src/web/auth.ts"

MUTANTS = [
    ("sign-in accepts the wrong daemon token", SERVER,
     'if (!options.authenticate(body.token)) {',
     'if (false) {'),
    ("API requests accept a forged or missing origin", SERVER,
     'if (!sameOrigin(request, origin)) return problem(403, "forbidden", "Use the daemon\'s own browser origin");',
     'void request;'),
    ("an incompatible tab reaches the shared peer", SERVER,
     'if (request.headers.get("sec-websocket-protocol") !== WEB_SUBPROTOCOL) {',
     'if (false) {'),
    ("pending WebSockets do not count against the connection limit", SERVER,
     'if (http.pendingWebSockets >= config.max_connections || peers.size >= config.max_connections) {',
     'if (false) {'),
    ("browser script can read the authentication cookie", AUTH,
     'httpOnly: true, sameSite: "strict", secure: this.#secure, path: "/",',
     'httpOnly: false, sameSite: "strict", secure: this.#secure, path: "/",'),
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
