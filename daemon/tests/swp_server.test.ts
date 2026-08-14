import { describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";

import { Server } from "../src/swp/server.ts";
import type { HandshakeProvider } from "../src/swp/connection.ts";

const OPEN = (): boolean => true;

async function handshake(port: number, selected: string | null): Promise<Record<string, unknown>> {
  const socket = connect({ host: "127.0.0.1", port, noDelay: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `${JSON.stringify({
        type: "hello",
        client_type: "tui",
        client_name: "test",
        capabilities: [],
        ...(selected === null ? {} : { selected_character: selected }),
      })}\n`,
    );
    return await firstFrame(socket);
  } finally {
    socket.destroy();
  }
}

function firstFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const at = buffered.indexOf("\n");
      if (at === -1) return;
      resolve(JSON.parse(buffered.slice(0, at)) as Record<string, unknown>);
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before a frame arrived")));
  });
}

async function serving(): Promise<{ server: Server; port: number; stop: () => Promise<void> }> {
  const server = new Server({ addr: "127.0.0.1:0", serverName: "shore-test", authenticate: OPEN });
  const { port } = await server.bind();
  const running = server.serve();
  return {
    server,
    port,
    stop: async () => {
      server.stop();
      await running;
    },
  };
}

function providerNaming(names: readonly string[]): HandshakeProvider {
  return {
    hello: () => Promise.resolve({ characters: names.map((name) => ({ name })) }),
    history: () =>
      Promise.resolve({
        messages: [],
        activeStart: 0,
        config: {},
        selectedCharacter: null,
        revision: 0,
      }),
  };
}

describe("binding", () => {
  test("port zero resolves to a real port before anything is served", async () => {
    const server = new Server({ addr: "127.0.0.1:0", serverName: "shore-test", authenticate: OPEN });
    const { host, port } = await server.bind();

    expect(host).toBe("127.0.0.1");
    expect(port).toBeGreaterThan(0);

    server.stop();
    await server.serve();
  });
});

describe("the handshake provider", () => {
  test("a connection reads the one set after construction", async () => {
    const { server, port, stop } = await serving();
    try {
      server.setHandshakeProvider(providerNaming(["ada", "nova"]));

      const frame = await handshake(port, null);
      expect(frame["type"]).toBe("hello");
      expect(frame["characters"]).toEqual([{ name: "ada" }, { name: "nova" }]);
    } finally {
      await stop();
    }
  });

  test("it is read per connection, so a later one supersedes", async () => {
    const { server, port, stop } = await serving();
    try {
      server.setHandshakeProvider(providerNaming(["ada"]));
      expect((await handshake(port, null))["characters"]).toEqual([{ name: "ada" }]);

      server.setHandshakeProvider(providerNaming(["nova"]));
      expect((await handshake(port, null))["characters"]).toEqual([{ name: "nova" }]);
    } finally {
      await stop();
    }
  });

  test("with none set, a client gets an empty window rather than a hang", async () => {
    const { port, stop } = await serving();
    try {
      const frame = await handshake(port, null);
      expect(frame["characters"]).toEqual([{ name: "default" }]);
    } finally {
      await stop();
    }
  });

  test("one built with a provider keeps it", async () => {
    const server = new Server({
      addr: "127.0.0.1:0",
      serverName: "shore-test",
      handshake: providerNaming(["constructed"]),
      authenticate: OPEN,
    });
    const { port } = await server.bind();
    const running = server.serve();
    try {
      expect((await handshake(port, null))["characters"]).toEqual([{ name: "constructed" }]);
    } finally {
      server.stop();
      await running;
    }
  });
});

describe("stopping", () => {
  test("a connected client is told, rather than seeing a bare EOF", async () => {
    const { server, port, stop } = await serving();
    server.setHandshakeProvider(providerNaming(["ada"]));

    const socket = connect({ host: "127.0.0.1", port, noDelay: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const frames: Record<string, unknown>[] = [];
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        for (;;) {
          const at = buffered.indexOf("\n");
          if (at === -1) return;
          frames.push(JSON.parse(buffered.slice(0, at)) as Record<string, unknown>);
          buffered = buffered.slice(at + 1);
        }
      });
      socket.write(
        `${JSON.stringify({
          type: "hello",
          client_type: "tui",
          client_name: "test",
          capabilities: [],
        })}\n`,
      );
      while (frames.length < 2) await new Promise((r) => setTimeout(r, 5));

      await stop();
      while (frames.length < 3) await new Promise((r) => setTimeout(r, 5));

      expect(frames.map((f) => f["type"])).toEqual(["hello", "history", "shutdown"]);
    } finally {
      socket.destroy();
    }
  });
});

describe("what a connection produces", () => {
  test("a command reaches the route stream", async () => {
    const { server, port, stop } = await serving();
    try {
      server.setHandshakeProvider(providerNaming(["ada"]));

      const socket = connect({ host: "127.0.0.1", port, noDelay: true });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `${JSON.stringify({
          type: "hello",
          client_type: "tui",
          client_name: "test",
          capabilities: [],
          selected_character: "ada",
        })}\n`,
      );
      await firstFrame(socket);
      socket.write(`${JSON.stringify({ type: "command", name: "list_characters" })}\n`);

      const routes = server.routes();
      const first = await routes.next();
      expect(first.done).toBe(false);
      expect(first.value?.kind).toBe("command");

      socket.destroy();
    } finally {
      await stop();
    }
  });
});
