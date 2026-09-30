import { createServer } from "node:http";
import type { Socket } from "node:net";

export interface HomeserverRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly hungUp: boolean;
}

export type HomeserverAnswer = "never" | { readonly status: number; readonly body: unknown };

export interface FakeHomeserver {
  readonly url: string;
  readonly requests: readonly HomeserverRequest[];
  close(): Promise<void>;
}

export function healthyAnswer(request: HomeserverRequest): HomeserverAnswer {
  const { path } = request;
  if (path === "/_matrix/client/versions") {
    return { status: 200, body: { versions: ["v1.11"], unstable_features: {} } };
  }
  if (path === "/_matrix/client/v3/capabilities") return { status: 200, body: { capabilities: {} } };
  if (path.startsWith("/_matrix/client/v3/pushrules")) return { status: 200, body: { global: {} } };
  if (path.endsWith("/filter")) return { status: 200, body: { filter_id: "filter" } };
  if (path === "/_matrix/client/v3/sync") {
    return request.query.has("since") ? "never" : { status: 200, body: { next_batch: "batch", rooms: {} } };
  }
  return { status: 404, body: { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" } };
}

export async function fakeHomeserver(
  answer: (request: HomeserverRequest) => HomeserverAnswer = healthyAnswer,
): Promise<FakeHomeserver> {
  const requests: HomeserverRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://homeserver.invalid");
    const request = { path: url.pathname, query: url.searchParams, hungUp: false };
    outgoing.once("close", () => {
      request.hungUp = !outgoing.writableEnded;
    });
    requests.push(request);
    const reply = answer(request);
    if (reply === "never") return;
    outgoing.writeHead(reply.status, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(reply.body));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
