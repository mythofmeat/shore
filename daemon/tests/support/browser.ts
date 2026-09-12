import type { ServerMessage } from "../../src/protocol/ServerMessage.ts";
import type { WebSocketOptions } from "bun";
import { WEB_SUBPROTOCOL } from "../../src/web/contract.ts";

export class BrowserSocket {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<CloseEvent>;
  readonly opened: Promise<void>;
  closeDetail = "";

  constructor(origin: string, cookie: string, protocol = WEB_SUBPROTOCOL, options: Pick<WebSocketOptions, "headers" | "tls"> = {}) {
    this.socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/swp`, {
      protocols: [protocol], ...options, headers: { origin, cookie, ...options.headers },
    });
    this.opened = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("WebSocket rejected")), { once: true });
    });
    this.closed = new Promise<CloseEvent>((resolve) => { this.socket.addEventListener("close", resolve, { once: true }); });
    this.socket.addEventListener("close", (event) => { this.closeDetail = `${String(event.code)} ${event.reason}`; });
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.messages.push(JSON.parse(event.data) as ServerMessage);
    });
  }

  async close(): Promise<void> { this.socket.close(); await this.closed; }

  async attach(character = "ada", thread = "main"): Promise<void> {
    await this.opened;
    this.send({ type: "hello", client_type: "web", client_name: "test-tab", capabilities: ["history-deltas"], character, thread });
    await this.frame("history");
  }

  send(message: unknown): void { this.socket.send(JSON.stringify(message)); }

  async frame(type: ServerMessage["type"], rid?: string): Promise<ServerMessage> {
    const until = Date.now() + 2000;
    for (;;) {
      const message = this.messages.find((frame) => frame.type === type && (rid === undefined || ("rid" in frame && frame.rid === rid)));
      if (message !== undefined) return message;
      if (Date.now() > until) throw new Error(`No ${type} frame; state ${String(this.socket.readyState)} ${this.closeDetail}; saw ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
    }
  }
}
