import { afterEach, describe, expect, test } from "bun:test";

import type { RoutedMessage } from "../src/swp/session.ts";
import { Server } from "../src/swp/server.ts";
import { MAX_TOTAL_ATTACHMENT_BYTES } from "../src/swp/admission.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(characters: string[] = ["ada", "bee"]) {
  const server = new Server({
    addr: "127.0.0.1:0",
    serverName: "shore-test",
    authenticate: () => true,
    handshake: {
      hello: () => Promise.resolve({ characters: characters.map((name) => ({ name })) }),
      history: (selected) =>
        Promise.resolve({
          messages: [],
          previousSegment: null,
          config: { active_model: "test:model" },
          selectedCharacter: selected,
          selectedThread: null,
          revision: 3,
        }),
    },
  });
  const { host, port } = await server.bind();
  const running = server.serve();

  const routed: RoutedMessage[] = [];
  const routing = (async () => {
    for await (const message of server.routes()) if (message.kind !== "session_connected") routed.push(message);
  })();

  cleanups.push(async () => {
    server.stop();
    await Promise.allSettled([running, routing]);
  });

  return { server, routed, addr: `${host}:${port}` };
}

describe("what the peer sends", () => {

  test("a connector cannot bypass aggregate attachment admission", async () => {
    const { server, routed } = await fixture();
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });
    const events = peer.events();
    await events.next();
    const data = Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES / 4).toString("base64");

    await peer.send({
      type: "message",
      text: "",
      stream: true,
      images: [],
      image_data: Array.from({ length: 5 }, (_, i) => ({
        filename: `${String(i)}.png`,
        data,
      })),
    });

    const rejection = await events.next();
    if (rejection.done || rejection.value.type !== "error") throw new Error("expected an error frame");
    expect(rejection.value).toMatchObject({ type: "error", code: "invalid_request" });
    expect(rejection.value.message).toContain("total");
    expect(routed).toHaveLength(0);
  });
});
