import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";

import type { RoutedMessage } from "../src/swp/session.ts";
import { Server } from "../src/swp/server.ts";
import { MAX_TOTAL_ATTACHMENT_BYTES } from "../src/swp/admission.ts";
import { outcomeOf } from "./support/outcome.ts";

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

describe("what the peer receives", () => {
  for (const selection of ["character", "thread"]) test(`queued history is filtered again after switching ${selection}`, async () => {
    const { server } = await fixture();
    const peer = await server.attachLocal({ clientType: "browser", clientName: "switching", character: "ada", capabilities: ["history-deltas"] });
    const events = peer.events();
    await events.next();
    server.sessionRouter.setSelectedThread(peer.session.sessionId, "main");
    server.broadcast({ type: "history", messages: [], config: {}, revision: 4, selected_character: "ada", selected_thread: "main" });
    const character = selection === "character" ? "bee" : "ada";
    const thread = selection === "thread" ? "side" : "main";
    server.sessionRouter.setSelectedCharacter(peer.session.sessionId, character);
    server.sessionRouter.setSelectedThread(peer.session.sessionId, thread);
    await server.sessionRouter.sendToSession(peer.session.sessionId, {
      type: "history", messages: [], config: {}, revision: 5, selected_character: character, selected_thread: thread,
    });
    server.broadcast({ type: "ping" });
    expect((await events.next()).value).toMatchObject({ type: "history", selected_character: character, selected_thread: thread });
    expect((await events.next()).value).toEqual({ type: "ping" });
    expect(server.sessionRouter.characterFor(peer.session.sessionId)).toBe(character);
    expect(server.sessionRouter.threadFor(peer.session.sessionId)).toBe(thread);
  });

  test("selection is checked again after loading a broadcast's full history", async () => {
    const { server } = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    server.setHandshakeProvider({
      hello: async () => ({ characters: [{ name: "ada" }, { name: "bee" }] }),
      history: async (character) => {
        if (++calls > 1) { started.resolve(); await release.promise; }
        return { messages: [], previousSegment: null, config: {}, selectedCharacter: character, selectedThread: "main", revision: 4 };
      },
    });
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "refreshing", character: "ada" });
    const events = peer.events();
    await events.next();
    server.broadcast({ type: "history", messages: [], config: {}, revision: 4, selected_character: "ada", selected_thread: "main", delta: { base_revision: 3, after: null } });
    await started.promise;
    server.sessionRouter.setSelectedCharacter(peer.session.sessionId, "bee");
    await server.sessionRouter.sendToSession(peer.session.sessionId, { type: "history", messages: [], config: {}, revision: 5, selected_character: "bee", selected_thread: "main" });
    release.resolve();
    server.broadcast({ type: "ping" });
    expect((await events.next()).value).toMatchObject({ type: "history", selected_character: "bee" });
    expect((await events.next()).value).toEqual({ type: "ping" });
  });

  test("a slow peer is detached on queue overflow without affecting another peer", async () => {
    const { server, routed } = await fixture(["ada"]);
    let overflow = 0;
    const slow = await server.attachLocal({
      clientType: "browser", clientName: "slow",
      outboundLimits: { messages: 2, bytes: 4096, onOverflow: () => { overflow += 1; } },
    });
    const other = await server.attachLocal({ clientType: "browser", clientName: "other" });
    for (let i = 0; i < 10; i += 1) {
      await server.sessionRouter.sendToSession(slow.session.sessionId, {
        type: "command_output", name: "status", data: { sequence: i },
      });
    }
    await slow.detach();
    expect(overflow).toBe(1);
    expect(server.sessionRouter.has(slow.session.sessionId)).toBe(false);
    expect(server.sessionRouter.has(other.session.sessionId)).toBe(true);
    expect(await slow.events().next()).toMatchObject({ done: true });
    expect(await outcomeOf(slow.send({ type: "command", name: "status", args: {} }))).toThrow("detached");
    await settle();
    expect(routed).toEqual([{ kind: "session_disconnected", sessionId: slow.session.sessionId }]);
    const otherEvents = other.events();
    await otherEvents.next();
    await server.sessionRouter.sendToSession(other.session.sessionId, { type: "ping" });
    expect((await otherEvents.next()).value).toEqual({ type: "ping" });
  });

  test("the byte limit counts UTF-8 bytes and a drained inbox releases its allowance", async () => {
    const { server } = await fixture(["ada"]);
    let overflow = 0;
    const peer = await server.attachLocal({
      clientType: "browser", clientName: "bounded",
      outboundLimits: { messages: 8, bytes: 300, onOverflow: () => { overflow += 1; } },
    });
    const events = peer.events();
    await events.next();
    const message = { type: "command_output" as const, name: "status", data: "x".repeat(240) };
    for (let i = 0; i < 3; i += 1) {
      await server.sessionRouter.sendToSession(peer.session.sessionId, message);
      expect((await events.next()).value).toEqual(message);
    }
    expect(overflow).toBe(0);
    await server.sessionRouter.sendToSession(peer.session.sessionId, { ...message, data: "🦀".repeat(100) });
    await peer.detach();
    expect(overflow).toBe(1);
    expect(await events.next()).toMatchObject({ done: true });
  });

  test("an oversized first history cannot leave an attached session", async () => {
    const { server, routed } = await fixture(["ada"]);
    let overflow = 0;
    const peer = await server.attachLocal({
      clientType: "browser", clientName: "tiny",
      outboundLimits: { messages: 1, bytes: 1, onOverflow: () => { overflow += 1; } },
    });
    await peer.detach();
    expect(overflow).toBe(1);
    expect(server.sessionRouter.sessions()).toEqual([]);
    expect(await peer.events().next()).toMatchObject({ done: true });
    await settle();
    expect(routed).toEqual([{ kind: "session_disconnected", sessionId: peer.session.sessionId }]);
  });

  test("overflow in the broadcast relay detaches instead of silently skipping state", async () => {
    const { server } = await fixture(["ada"]);
    let overflow = 0;
    const peer = await server.attachLocal({
      clientType: "browser", clientName: "lagged",
      outboundLimits: { messages: 2, bytes: 300, onOverflow: () => { overflow += 1; } },
    });
    const events = peer.events();
    await events.next();
    server.broadcast({ type: "cache_warning", expected_tokens: 100, message: "🦀".repeat(100) });
    expect(await events.next()).toMatchObject({ done: true });
    await peer.detach();
    expect(overflow).toBe(1);
    expect(server.sessionRouter.sessions()).toEqual([]);
  });

  test("shutdown does not wait for a stalled history refresh", async () => {
    const { server } = await fixture(["ada"]);
    const held = new Promise<void>(() => {});
    let refreshing: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { refreshing = resolve; });
    let calls = 0;
    server.setHandshakeProvider({
      hello: async () => ({ characters: [{ name: "ada" }] }),
      history: async () => {
        calls += 1;
        if (calls > 1) {
          refreshing?.();
          await held;
        }
        return { messages: [], previousSegment: null, config: {}, selectedCharacter: "ada", selectedThread: "main", revision: 0 };
      },
    });
    const peer = await server.attachLocal({ clientType: "bridge", clientName: "refreshing" });
    const events = peer.events();
    await events.next();
    server.broadcast({
      type: "history", messages: [], config: {}, revision: 1,
      selected_character: "ada", selected_thread: "main", delta: { base_revision: 0, after: null },
    });
    await started;
    server.stop();
    await peer.detach();
    expect(await events.next()).toMatchObject({ done: true });
    expect(server.sessionRouter.sessions()).toEqual([]);
  });

  test("aborting while history loads prevents a late session attachment", async () => {
    const { server } = await fixture(["ada"]);
    const controller = new AbortController();
    const held = new Promise<void>(() => {});
    let historyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { historyStarted = resolve; });
    server.setHandshakeProvider({
      hello: async () => ({ characters: [{ name: "ada" }] }),
      history: async () => {
        historyStarted?.();
        await held;
        return { messages: [], previousSegment: null, config: {}, selectedCharacter: "ada", selectedThread: "main", revision: 0 };
      },
    });
    const attaching = server.attachLocal({ clientType: "browser", clientName: "cancelled", signal: controller.signal });
    await started;
    controller.abort(new Error("tab closed"));
    expect(await outcomeOf(attaching)).toThrow("tab closed");
    expect(server.sessionRouter.sessions()).toEqual([]);
  });

  test("abort and shutdown each detach sessions and prevent subsequent routing", async () => {
    const { server } = await fixture(["ada"]);
    const controller = new AbortController();
    const aborted = await server.attachLocal({ clientType: "browser", clientName: "aborted", signal: controller.signal });
    const stopped = await server.attachLocal({ clientType: "browser", clientName: "stopped" });
    controller.abort();
    await aborted.detach();
    expect(server.sessionRouter.has(aborted.session.sessionId)).toBe(false);
    server.stop();
    await settle();
    expect(server.sessionRouter.sessions()).toEqual([]);
    expect(await stopped.events().next()).toMatchObject({ done: true });
    expect(await outcomeOf(server.attachLocal({ clientType: "browser", clientName: "late" }))).toThrow("stopping");
  });

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

describe("disconnects are per session", () => {
  test("a socket client leaving routes only its own disconnect, bridge or not", async () => {
    const { server, routed, addr } = await fixture(["ada"]);
    const bridge = await server.attachLocal({ clientType: "bridge", clientName: "shore-matrix" });

    const socket = await socketClient(addr);
    socket.destroy();
    await settle();
    await bridge.detach();
    await bridge.detach();
    await settle();

    const disconnected = routed.filter((r) => r.kind === "session_disconnected");
    expect(disconnected).toHaveLength(2);
    expect(disconnected).toContainEqual({ kind: "session_disconnected", sessionId: bridge.session.sessionId });
    expect(routed.map((r) => r.kind).filter((kind) => kind !== "session_disconnected")).toEqual([]);
  });
});
