import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";

export async function startMockClaudeOAuth(messagesUrl: string) {
  const fixtures = join(import.meta.dir, "../../tests/support/claude-oauth");
  const refreshTokens: string[] = [];
  const accessToken = () => `test-access-${refreshTokens.length}`;
  const refreshToken = () => `test-refresh-${refreshTokens.length}`;
  const oauth = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(join(fixtures, "key.pem")), cert: Bun.file(join(fixtures, "cert.pem")) },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/oauth/token") {
        const body = await request.json() as { refresh_token: string; grant_type: string };
        if (body.grant_type !== "refresh_token" || body.refresh_token !== refreshToken()) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        refreshTokens.push(body.refresh_token);
        return Response.json({
          access_token: accessToken(), refresh_token: refreshToken(), expires_in: 28_800,
          scope: "user:inference user:profile user:sessions:claude_code",
        });
      }
      if (url.pathname === "/v1/messages") {
        return fetch(`${messagesUrl}${url.pathname}${url.search}`, {
          method: request.method, headers: request.headers, body: await request.arrayBuffer(),
        });
      }
      return Response.json({});
    },
  });
  const port = oauth.port;
  if (port === undefined) throw new Error("OAuth server did not bind a port");
  const sockets = new Set<Duplex>();
  const proxy = createServer((_request, response) => { response.writeHead(502); response.end(); });
  proxy.on("connect", (_request, client, head) => {
    const remote = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
    sockets.add(client);
    sockets.add(remote);
    client.on("error", () => remote.destroy());
    remote.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); remote.destroy(); });
    remote.on("close", () => { sockets.delete(remote); client.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("OAuth proxy did not bind a port");
  return {
    accessToken,
    refreshTokens,
    credentials: (expired: boolean) => JSON.stringify({ claudeAiOauth: {
      accessToken: accessToken(), refreshToken: refreshToken(),
      expiresAt: Date.now() + (expired ? -60_000 : 3_600_000),
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"], subscriptionType: "pro",
    } }),
    env: {
      HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
      NODE_EXTRA_CA_CERTS: join(fixtures, "cert.pem"),
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => { proxy.close(() => resolve()); }),
        oauth.stop(true),
      ]);
    },
  };
}
