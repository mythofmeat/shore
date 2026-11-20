import { connect } from "node:net";
import { Server } from "../../src/swp/server.ts";

const server = new Server({
  addr: "127.0.0.1:0",
  serverName: "shore-test",
  authenticate: () => true,
  handshake: {
    hello: () => Promise.resolve({ characters: [{ name: "ada" }] }),
    history: (selected) => Promise.resolve({ messages: [], previousSegment: null, config: {}, selectedCharacter: selected, selectedThread: null, revision: 1 }),
  },
});
const { port } = await server.bind();
const running = server.serve();
const routing = (async () => {
  const routed: unknown[] = [];
  for await (const each of server.routes()) routed.push(each);
})();
const socket = connect({ host: "127.0.0.1", port });
let frames = "";
const hungUp = new Promise<void>((resolve) => {
  socket.once("close", () => resolve());
});
await new Promise<void>((resolve) => {
  socket.on("data", (chunk: Buffer) => {
    frames += chunk.toString("utf8");
    if (frames.includes('"type":"history"')) resolve();
  });
  socket.once("data", () => socket.write(`${JSON.stringify({ type: "hello", client_type: "tui", client_name: "test", capabilities: [] })}\n`));
});
server.stop();
await Promise.all([running, routing, hungUp]);
process.stdout.write("stopped\n");
