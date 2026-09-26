import { BrowserConnection, type BrowserConnectionOptions, type ConnectionUpdate } from "../../src/browser/connection.ts";
import { WEB_CONTRACT, WEB_PROTOCOL } from "../../src/web/contract.ts";

export function browserConnection(origin: string, extra: Partial<BrowserConnectionOptions> = {}) {
  let cookie = "";
  const sockets: WebSocket[] = [];
  const updates: ConnectionUpdate[] = [];
  const client = new BrowserConnection({
    origin, contract: WEB_CONTRACT, protocol: WEB_PROTOCOL, character: "ada", thread: "main", retryDelayMs: 5,
    fetch: async (url, options) => {
      const headers = new Headers(options.headers);
      headers.set("origin", origin);
      headers.set("cookie", cookie);
      const response = await fetch(url, { ...options, headers });
      cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
      return response;
    },
    socket: (url, subprotocol) => {
      const socket = new WebSocket(url, { protocols: [subprotocol], headers: { origin, cookie } });
      sockets.push(socket);
      return socket;
    },
    ...extra,
  });
  client.subscribe((update) => { updates.push(update); });
  return { client, sockets, updates };
}
