import { describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";

import { Server } from "../src/swp/server.ts";
import type { HandshakeProvider } from "../src/swp/connection.ts";
import type { ControlRoutedMessage } from "../src/swp/session.ts";

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
        selectedThread: null,
        revision: 0,
      }),
  };
}

describe("binding", () => {
  test("clients arriving before serving begins are closed without holding startup rollback open", async () => {
    const server = new Server({ addr: "127.0.0.1:0", serverName: "shore-test", authenticate: OPEN });
    const { port } = await server.bind();
    const socket = connect({ host: "127.0.0.1", port });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("An early TCP client was left open")), 500);
        socket.on("error", () => {});
        socket.once("close", () => { clearTimeout(timer); resolve(); });
      });
      expect(server.sessionRouter.sessions()).toEqual([]);
    } finally {
      socket.destroy();
      server.stop();
      await server.serve();
    }
  });

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
  test("a peer closing during history load leaves no session or handler error", async () => {
    const warnings: string[] = [];
    const server = new Server({
      addr: "127.0.0.1:0", serverName: "shore-test", authenticate: OPEN,
      log: { warn: (message) => { warnings.push(message); } },
    });
    let releaseHistory = (): void => undefined;
    const held = new Promise<void>((resolve) => { releaseHistory = resolve; });
    let beganHistory = (): void => undefined;
    const started = new Promise<void>((resolve) => { beganHistory = resolve; });
    server.setHandshakeProvider({
      hello: async () => ({ characters: [{ name: "ada" }] }),
      history: async () => {
        beganHistory();
        await held;
        return { messages: [], activeStart: 0, config: {}, selectedCharacter: "ada", selectedThread: "main", revision: 0 };
      },
    });
    const { port } = await server.bind();
    const running = server.serve();
    const socket = connect({ host: "127.0.0.1", port, noDelay: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(`${JSON.stringify({ type: "hello", client_type: "tui", client_name: "closing", capabilities: [] })}\n`);
      await started;
      const closed = new Promise<void>((resolve) => { socket.once("close", () => resolve()); });
      socket.destroy();
      await closed;
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      releaseHistory();
      server.stop();
      await running;
      expect(server.sessionRouter.sessions()).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      releaseHistory();
      socket.destroy();
      server.stop();
      await running;
    }
  });

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
      while (frames.length < 2) {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      await stop();
      while (frames.length < 3) {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      expect(frames.map((f) => f["type"])).toEqual(["hello", "history", "shutdown"]);
    } finally {
      socket.destroy();
    }
  });
});

describe("what a connection produces", () => {
  test("cancel and disconnect bypass blocked regular work", async () => {
    const { server, stop } = await serving();
    server.setHandshakeProvider(providerNaming(["ada"]));
    let releaseCommand = (): void => undefined;
    const commandBlocked = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    let commandStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const routing = (async () => {
      for await (const message of server.routes()) {
        if (message.kind !== "command") continue;
        commandStarted();
        await commandBlocked;
      }
    })();
    const controls: ControlRoutedMessage[] = [];
    server.setControlHandler((message) => {
      controls.push(message);
      return Promise.resolve();
    });
    const peer = await server.attachLocal({
      clientType: "bridge",
      clientName: "shore-matrix",
      character: "ada",
    });

    try {
      await peer.send({ type: "command", name: "status", args: {} });
      await started;

      await peer.send({ type: "cancel" });
      expect(controls).toHaveLength(2);
      expect(controls[0]).toEqual({ kind: "session_connected", sessionId: peer.session.sessionId });
      expect(controls[1]).toMatchObject({ kind: "engine", msg: { type: "cancel" } });

      await peer.detach();
      expect(controls).toHaveLength(3);
      expect(controls[2]).toEqual({ kind: "session_disconnected", sessionId: peer.session.sessionId });
    } finally {
      releaseCommand();
      await stop();
      await routing;
    }
  });

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
      let first = await routes.next();
      while (!first.done && first.value.kind === "session_connected") first = await routes.next();
      expect(first.done).toBe(false);
      expect((first.value as { kind?: string } | undefined)?.kind).toBe("command");

      socket.destroy();
    } finally {
      await stop();
    }
  });

  test("broadcasts for another character do not count against a TCP client's queue", async () => {
    const warnings: string[] = [];
    const server = new Server({ addr: "127.0.0.1:0", serverName: "shore-test", authenticate: OPEN, log: { warn: (msg) => warnings.push(msg) } });
    const { port } = await server.bind();
    const running = server.serve();
    const socket = connect({ host: "127.0.0.1", port, noDelay: true });
    try {
      server.setHandshakeProvider({
        hello: () => Promise.resolve({ characters: [{ name: "ada" }, { name: "bea" }] }),
        history: () => Promise.resolve({ messages: [], activeStart: 0, config: {}, selectedCharacter: "ada", selectedThread: null, revision: 0 }),
      });
      const frames: Record<string, unknown>[] = [];
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
          frames.push(JSON.parse(buffered.slice(0, at)) as Record<string, unknown>);
          buffered = buffered.slice(at + 1);
        }
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(`${JSON.stringify({ type: "hello", client_type: "tui", client_name: "test", capabilities: [], character: "ada" })}\n`);
      const arrived = async (predicate: (frame: Record<string, unknown>) => boolean): Promise<void> => {
        while (!frames.some(predicate)) await Bun.sleep(5);
      };
      await arrived((frame) => frame["type"] === "history");

      for (let index = 0; index < 400; index += 1) {
        server.broadcast({ type: "history", messages: [], config: {}, selected_character: "bea", revision: index });
      }
      server.broadcast({ type: "history", messages: [], config: {}, selected_character: "ada", revision: 999 });
      await arrived((frame) => frame["revision"] === 999);

      expect(warnings).not.toContain("Client lagged on broadcast");
      expect(frames.filter((frame) => frame["selected_character"] === "bea")).toHaveLength(0);
    } finally {
      socket.destroy();
      server.stop();
      await running;
    }
  });
});
