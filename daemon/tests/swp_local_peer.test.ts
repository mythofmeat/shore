import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";

import type { RoutedMessage } from "../src/swp/session.ts";
import { Server } from "../src/swp/server.ts";

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
          activeStart: 0,
          config: { active_model: "test:model" },
          selectedCharacter: selected,
          revision: 3,
        }),
    },
  });
  const { host, port } = await server.bind();
  const running = server.serve();

  const routed: RoutedMessage[] = [];
  const routing = (async () => {
    for await (const message of server.routes()) routed.push(message);
  })();

  cleanups.push(async () => {
    server.stop();
    await Promise.allSettled([running, routing]);
  });

  return { server, routed, addr: `${host}:${port}` };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

async function socketClient(addr: string): Promise<Socket> {
  const at = addr.lastIndexOf(":");
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: addr.slice(0, at), port: Number(addr.slice(at + 1)) });
    s.once("error", reject);
    s.once("connect", () => resolve(s));
  });
  socket.write(
    `${JSON.stringify({
      type: "hello",
      client_type: "cli",
      client_name: "test",
      capabilities: [],
      token: "anything",
    })}\n`,
  );
  await settle();
  return socket;
}

describe("attaching without a socket", () => {
  test("the peer gets the same hello and history a socket client would", async () => {
    const { server } = await fixture();
    const peer = await server.attachLocal({
      clientType: "bridge",
      clientName: "shore-matrix",
      character: "bee",
    });

    expect(peer.characters.map((c) => c.name)).toEqual(["ada", "bee"]);
    expect(peer.history.selectedCharacter).toBe("bee");
    expect(peer.history.revision).toBe(3);
    expect(peer.session.clientName).toBe("shore-matrix");
  });

  test("an unknown character selection is dropped, exactly as the handshake does", async () => {
    const { server } = await fixture();
    const peer = await server.attachLocal({
      clientType: "bridge",
      clientName: "shore-matrix",
      character: "nobody",
    });
    expect(peer.history.selectedCharacter).toBeNull();
  });

  test("a single character is selected for a peer that asked for none", async () => {
    const { server } = await fixture(["ada"]);
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });
    expect(peer.history.selectedCharacter).toBe("ada");
  });

  test("the history frame is the peer's first event, as it is a socket client's", async () => {
    const { server } = await fixture(["ada"]);
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });

    const events = peer.events();
    const first = await events.next();
    expect(first.value).toMatchObject({ type: "history", revision: 3, selected_character: "ada" });
  });
});

describe("what the peer sends", () => {
  test("a message is routed with the session's selected character", async () => {
    const { server, routed } = await fixture();
    const peer = await server.attachLocal({
      clientType: "bridge",
      clientName: "shore-matrix",
      character: "ada",
    });

    await peer.send({ type: "message", text: "hello", stream: true, images: [], image_data: [] });
    await settle();

    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      kind: "engine",
      meta: { kind: "message", session: { selectedCharacter: "ada" } },
    });
  });

  test("a command carries its rid through to the route", async () => {
    const { server, routed } = await fixture();
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });

    await peer.send({ type: "command", rid: "matrix-1", name: "status", args: {} });
    await settle();

    expect(routed[0]).toMatchObject({ kind: "command", meta: { rid: "matrix-1", kind: "command" } });
  });

  test("a switched character is what later sends carry", async () => {
    const { server, routed } = await fixture();
    const peer = await server.attachLocal({
      clientType: "bridge",
      clientName: "shore-matrix",
      character: "ada",
    });

    server.sessionRouter.setSelectedCharacter(peer.session.sessionId, "bee");
    await peer.send({ type: "message", text: "hi", stream: true, images: [], image_data: [] });
    await settle();

    expect(routed[0]).toMatchObject({ meta: { session: { selectedCharacter: "bee" } } });
  });

  test("a second hello is refused as a protocol error, not routed", async () => {
    const { server, routed } = await fixture();
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });
    const events = peer.events();
    await events.next();

    await peer.send({
      type: "hello",
      client_type: "bridge",
      client_name: "shore-matrix",
      capabilities: [],
    });
    const next = await events.next();

    expect(next.value).toMatchObject({ type: "error", code: "protocol_error" });
    expect(routed).toHaveLength(0);
  });
});

describe("what the peer receives", () => {
  test("broadcasts arrive, and so do frames addressed to its session alone", async () => {
    const { server } = await fixture(["ada"]);
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });
    const events = peer.events();
    await events.next();

    server.broadcast({
      type: "new_message",
      revision: 4,
      character: "ada",
      msg_id: "m1",
      role: "assistant",
      content: "broadcast",
      images: [],
      content_blocks: [],
      timestamp: "2026-08-08T00:00:00Z",
    });
    expect((await events.next()).value).toMatchObject({ type: "new_message", msg_id: "m1" });

    await server.sessionRouter.sendToSession(peer.session.sessionId, {
      type: "command_output",
      name: "status",
      data: { character: "ada" },
    });
    expect((await events.next()).value).toMatchObject({ type: "command_output", name: "status" });
  });

  test("the event stream ends when the peer detaches", async () => {
    const { server } = await fixture(["ada"]);
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });

    const drained: string[] = [];
    const pump = (async () => {
      for await (const msg of peer.events()) drained.push(msg.type);
    })();

    await settle();
    await peer.detach();
    await pump;

    expect(drained).toEqual(["history"]);
  });
});

describe("all_clients_disconnected, which is where the shapes differ", () => {
  test("a socket client leaving does not fire it while the bridge is attached", async () => {
    const { server, routed, addr } = await fixture(["ada"]);
    await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });

    const socket = await socketClient(addr);
    socket.destroy();
    await settle();

    expect(routed.filter((r) => r.kind === "all_clients_disconnected")).toHaveLength(0);
  });

  test("without the bridge, the same disconnect fires it", async () => {
    const { routed, addr } = await fixture(["ada"]);

    const socket = await socketClient(addr);
    socket.destroy();
    await settle();

    expect(routed.filter((r) => r.kind === "all_clients_disconnected")).toHaveLength(1);
  });

  test("the bridge detaching last fires it, so nothing is left generating", async () => {
    const { server, routed } = await fixture(["ada"]);
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });

    await peer.detach();
    await settle();

    expect(routed.filter((r) => r.kind === "all_clients_disconnected")).toHaveLength(1);
  });

  test("detaching twice is quiet", async () => {
    const { server, routed } = await fixture(["ada"]);
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });

    await peer.detach();
    await peer.detach();
    await settle();

    expect(routed.filter((r) => r.kind === "all_clients_disconnected")).toHaveLength(1);
  });
});
