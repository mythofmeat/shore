/**
 * The listener, over a real loopback socket.
 *
 * `swp_transport.test.ts` drives {@link handleConnection} against in-memory
 * duplexes, which is where the protocol lives. What is left for here is the
 * part that only exists once there is a socket:
 *
 * - **The handshake arrives after construction.** The provider answers out of
 *   the character registry, and the registry is built with this server's
 *   broadcast — so one has to exist first and it is the server. A connection
 *   reads the field when it arrives rather than when the server was made, and
 *   `setHandshakeProvider` is what moves it.
 * - **A connection with no provider still answers.** It gets the default one
 *   character named `default` and an empty conversation, so a client renders an
 *   empty window instead of hanging. That is a fallback, not a state to serve
 *   deliberately, which is why the wiring sets the provider before `serve`.
 * - **`bind` resolves a port without accepting.** `--addr 127.0.0.1:0` depends
 *   on it: the instance registry has to record a port that was really opened,
 *   and it records it before anything is served.
 */

import { describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";

import { Server } from "../src/swp/server.ts";
import type { HandshakeProvider } from "../src/swp/connection.ts";

/** A hello, and the first frame the server answers with. */
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

/** The first newline-delimited JSON object the server sends. */
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

/** A server bound to an ephemeral port and serving, with its port. */
async function serving(): Promise<{ server: Server; port: number; stop: () => Promise<void> }> {
  const server = new Server({ addr: "127.0.0.1:0", serverName: "shore-test" });
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
    const server = new Server({ addr: "127.0.0.1:0", serverName: "shore-test" });
    const { host, port } = await server.bind();

    // `--addr 127.0.0.1:0` depends on this: the instance registry records the
    // address, and a literal `:0` in that file sends every discovery client to
    // a port nobody opened.
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
      // Captured at construction, the second connection would still be told
      // about a character that no longer exists.
      expect((await handshake(port, null))["characters"]).toEqual([{ name: "nova" }]);
    } finally {
      await stop();
    }
  });

  test("with none set, a client gets an empty window rather than a hang", async () => {
    const { port, stop } = await serving();
    try {
      const frame = await handshake(port, null);
      // The Rust's default: one character literally named `default`. A daemon
      // serving this is a daemon whose handshake was never attached, which is
      // why the wiring sets it before `serve` rather than checking for it.
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
      // `hello` and the history snapshot that follows it.
      while (frames.length < 2) await new Promise((r) => setTimeout(r, 5));

      await stop();
      // The write is flushed by the time `stop` returns; the client's `data`
      // event is one turn behind it.
      while (frames.length < 3) await new Promise((r) => setTimeout(r, 5));

      // Written by the connection on its way out rather than broadcast and
      // raced against the same signal, which is how the Rust did it and why a
      // client there was told only sometimes.
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
      // Nothing drains this until `MessageHandler.run` does, which is why the
      // wiring starts the handler before it serves: a client that hand-shakes
      // first would queue here and never be answered.
      expect(first.done).toBe(false);
      expect(first.value?.kind).toBe("command");

      socket.destroy();
    } finally {
      await stop();
    }
  });
});
