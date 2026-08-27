import { describe, expect, test } from "bun:test";

import {
  McpRegistry,
  mcpRecoveryDelayMs,
  type McpServerConfigView,
  type RecoveryWait,
  type Sleep,
} from "../src/tools/mcp_registry.ts";
import { McpCancelled, McpError, McpTransportError } from "../src/mcp/client.ts";
import type { McpClient, McpServerSpec } from "../src/mcp/client.ts";

const PLUGINS = "/plugins";

function httpServer(url = "http://mcp:8080"): McpServerConfigView {
  return { url };
}

function stdioServer(command = "hue-server"): McpServerConfigView {
  return { command };
}

function fakeClient(spec: McpServerSpec, tools: string[], shutdowns: { count: number }) {
  return {
    server: spec.name,
    listTools: () =>
      Promise.resolve(
        tools.map((name) => ({
          server: spec.name,
          name,
          description: `the ${name} tool`,
          input_schema: {},
        })),
      ),
    call: () => Promise.resolve(null),
    shutdown: () => {
      shutdowns.count += 1;
      return Promise.resolve();
    },
  } as unknown as McpClient;
}

function harness(options: {
  failures?: Record<string, number>;
  tools?: Record<string, string[]>;
} = {}) {
  const failures = { ...options.failures };
  const attempts: string[] = [];
  const delays: number[] = [];
  const shutdowns = { count: 0 };

  const connect = (spec: McpServerSpec): Promise<McpClient> => {
    attempts.push(spec.name);
    const left = failures[spec.name] ?? 0;
    if (left > 0) {
      failures[spec.name] = left - 1;
      return Promise.reject(new Error(`ECONNREFUSED ${spec.name}`));
    }
    return Promise.resolve(fakeClient(spec, options.tools?.[spec.name] ?? ["ping"], shutdowns));
  };

  const sleep: Sleep = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };

  return {
    connect,
    sleep,
    attempts,
    delays,
    shutdowns: () => shutdowns.count,
    attemptsFor: (name: string) => attempts.filter((n) => n === name).length,
  };
}

const build = (
  servers: Record<string, McpServerConfigView>,
  h: ReturnType<typeof harness>,
): Promise<McpRegistry> => McpRegistry.fromConfig(servers, PLUGINS, h.connect, h.sleep);

describe("HTTP servers are retried", () => {
  test("a server that is not listening yet is waited for, not dropped", async () => {
    const h = harness({ failures: { hue: 3 } });
    const registry = await build({ hue: httpServer() }, h);

    expect(registry.connectedServers()).toBe(1);
    expect(registry.allTools().map((t) => t.full_name)).toEqual(["mcp__hue__ping"]);
    expect(h.attemptsFor("hue")).toBe(4);
  });

  test("the backoff follows the documented schedule", async () => {
    const h = harness({ failures: { hue: 3 } });
    await build({ hue: httpServer() }, h);

    expect(h.delays).toEqual([200, 500, 1000]);
  });

  test("retries are bounded, and exhausting them skips rather than throws", async () => {
    const h = harness({ failures: { hue: 99 } });
    const registry = await build({ hue: httpServer() }, h);

    expect(h.attemptsFor("hue")).toBe(6);
    expect(h.delays).toEqual([200, 500, 1000, 2000, 4000]);
    expect(registry.connectedServers()).toBe(0);
    expect(registry.allTools()).toEqual([]);
    await registry.shutdown();
  });

  test("one unreachable server does not cost the reachable ones their tools", async () => {
    const h = harness({ failures: { dead: 99 }, tools: { hue: ["set_light"] } });
    const registry = await build({ dead: httpServer(), hue: httpServer() }, h);

    expect(registry.connectedServers()).toBe(1);
    expect(registry.allTools().map((t) => t.full_name)).toEqual(["mcp__hue__set_light"]);
    await registry.shutdown();
  });
});

describe("stdio servers do not delay startup", () => {
  test("a child that fails to spawn gets one startup attempt before background recovery", async () => {
    const h = harness({ failures: { hue: 1 } });
    const registry = await build({ hue: stdioServer() }, h);

    expect(h.attemptsFor("hue")).toBe(1);
    expect(h.delays).toEqual([]);
    expect(registry.connectedServers()).toBe(0);
    await registry.shutdown();
  });

  test("a stdio server alongside a retrying HTTP one is unaffected", async () => {
    const h = harness({ failures: { child: 1, remote: 2 } });
    const registry = await build({ child: stdioServer(), remote: httpServer() }, h);

    expect(h.attemptsFor("child")).toBe(1);
    expect(h.attemptsFor("remote")).toBe(3);
    expect(registry.connectedServers()).toBe(1);
    await registry.shutdown();
  });
});

describe("servers are brought up concurrently", () => {
  test("N unavailable servers cost one backoff window, not N", async () => {
    const h = harness({ failures: { a: 99, b: 99, c: 99 } });
    const registry = await build({ a: httpServer(), b: httpServer(), c: httpServer() }, h);

    expect(h.attempts.slice(0, 3).sort()).toEqual(["a", "b", "c"]);
    expect(h.attempts).toHaveLength(18);

    const window = 200 + 500 + 1000 + 2000 + 4000;
    expect(h.delays.reduce((a, b) => a + b, 0)).toBe(window * 3);
    expect(Math.max(...h.delays)).toBe(4000);
    await registry.shutdown();
  });

  test("the surface is sorted by name, not by who answered first", async () => {
    const h = harness({
      failures: { alpha: 2 },
      tools: { alpha: ["a_tool"], zulu: ["z_tool"] },
    });
    const registry = await build({ zulu: httpServer(), alpha: httpServer() }, h);

    expect(registry.allTools().map((t) => t.full_name)).toEqual([
      "mcp__alpha__a_tool",
      "mcp__zulu__z_tool",
    ]);
    await registry.shutdown();
  });
});

function revivableServer(options: { tools?: string[] } = {}) {
  const state = {
    listening: true,
    tools: options.tools ?? ["ping"],
    connects: 0,
    calls: 0,
    shutdowns: 0,
  };

  const makeClient = (spec: McpServerSpec): McpClient => {
    let dead = false;
    const client = {
      server: spec.name,
      listTools: () =>
        Promise.resolve(
          state.tools.map((name) => ({
            server: spec.name,
            name,
            description: `the ${name} tool`,
            input_schema: {},
          })),
        ),
      call: (tool: string, _args: unknown, signal?: AbortSignal) => {
        state.calls += 1;
        if (signal?.aborted === true) {
          return Promise.reject(new McpCancelled(`MCP tool '${tool}' was asked to stop`, false));
        }
        if (dead) return Promise.reject(new McpTransportError(`MCP request to '${spec.name}'`));
        return Promise.resolve(`${tool} ran`);
      },
      shutdown: () => {
        state.shutdowns += 1;
        return Promise.resolve();
      },
      kill: () => {
        dead = true;
      },
    };
    live.push(client);
    return client as unknown as McpClient;
  };

  const live: { kill: () => void }[] = [];

  const connect = (spec: McpServerSpec): Promise<McpClient> => {
    state.connects += 1;
    if (!state.listening) return Promise.reject(new Error(`ECONNREFUSED ${spec.name}`));
    return Promise.resolve(makeClient(spec));
  };

  return {
    connect,
    state,
    killConnection: () => live.at(-1)?.kill(),
  };
}

const noSleep: Sleep = () => Promise.resolve();

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect(predicate()).toBe(true);
}

function recoveryClock(start = 1_000_000): {
  wait: RecoveryWait;
  now: () => number;
  pending: () => readonly number[];
  releaseNext: () => Promise<void>;
} {
  let now = start;
  const waits: Array<{ ms: number; resolve: () => void }> = [];
  return {
    now: () => now,
    pending: () => waits.map((wait) => wait.ms),
    wait: (ms, signal) =>
      new Promise((resolve) => {
        const finish = (): void => {
          signal.removeEventListener("abort", finish);
          resolve();
        };
        signal.addEventListener("abort", finish, { once: true });
        waits.push({ ms, resolve: finish });
      }),
    releaseNext: async () => {
      await eventually(() => waits.length > 0);
      const next = waits.shift();
      if (next === undefined) throw new Error("no recovery wait to release");
      now += next.ms;
      next.resolve();
      await Promise.resolve();
    },
  };
}

describe("background recovery", () => {
  test("an unavailable startup server rejoins without a config change", async () => {
    const hue = revivableServer({ tools: ["set_light", "scene"] });
    hue.state.listening = false;
    const clock = recoveryClock();
    const changed: string[] = [];
    const publishedSurfaces: string[][] = [];
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
      {
        recoveryWait: clock.wait,
        now: clock.now,
        random: () => 0.5,
        onToolsChanged: (current, server) => {
          changed.push(server);
          publishedSurfaces.push(current.allTools().map((tool) => tool.full_name));
        },
      },
    );

    expect(registry.allTools()).toEqual([]);
    expect(registry.serverStatus()).toEqual([
      {
        name: "hue",
        transport: "http",
        state: "unavailable",
        connected_tools: 0,
        last_error: "Error: ECONNREFUSED hue",
        next_retry_at: 1_001_000,
      },
    ]);
    expect(clock.pending()).toEqual([1000]);

    hue.state.listening = true;
    await clock.releaseNext();
    await eventually(() => registry.connectedServers() === 1);

    expect(registry.allTools().map((tool) => tool.full_name)).toEqual([
      "mcp__hue__scene",
      "mcp__hue__set_light",
    ]);
    expect(changed).toEqual(["hue"]);
    expect(publishedSurfaces).toEqual([
      ["mcp__hue__scene", "mcp__hue__set_light"],
    ]);
    expect(registry.serverStatus()[0]).toMatchObject({
      state: "connected",
      connected_tools: 2,
      last_error: null,
      next_retry_at: null,
    });
    await registry.shutdown();
  });

  test("a tools/list failure is retried with a fresh client", async () => {
    const clock = recoveryClock();
    let listHealthy = false;
    let connects = 0;
    let shutdowns = 0;
    const connect = (spec: McpServerSpec): Promise<McpClient> => {
      connects += 1;
      return Promise.resolve({
        server: spec.name,
        listTools: () =>
          listHealthy
            ? Promise.resolve([
                {
                  server: spec.name,
                  name: "ping",
                  description: "ping",
                  input_schema: {},
                },
              ])
            : Promise.reject(new Error("tools are warming up")),
        call: () => Promise.resolve("pong"),
        shutdown: () => {
          shutdowns += 1;
          return Promise.resolve();
        },
      } as unknown as McpClient);
    };
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      connect,
      noSleep,
      { recoveryWait: clock.wait, now: clock.now, random: () => 0.5 },
    );

    expect(connects).toBe(1);
    expect(shutdowns).toBe(1);
    listHealthy = true;
    await clock.releaseNext();
    await eventually(() => registry.connectedServers() === 1);

    expect(connects).toBe(2);
    expect(registry.allTools().map((tool) => tool.full_name)).toEqual(["mcp__hue__ping"]);
    await registry.shutdown();
    expect(shutdowns).toBe(2);
  });

  test("repeated failures advance the background backoff until recovery", async () => {
    const hue = revivableServer();
    hue.state.listening = false;
    const clock = recoveryClock();
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
      { recoveryWait: clock.wait, now: clock.now, random: () => 0.5 },
    );

    expect(clock.pending()).toEqual([1000]);
    await clock.releaseNext();
    await eventually(() => clock.pending().length > 0);
    expect(clock.pending()).toEqual([2000]);
    await clock.releaseNext();
    await eventually(() => clock.pending().length > 0);
    expect(clock.pending()).toEqual([4000]);

    hue.state.listening = true;
    await clock.releaseNext();
    await eventually(() => registry.connectedServers() === 1);
    expect(registry.serverStatus()[0]?.state).toBe("connected");
    await registry.shutdown();
  });

  test("shutdown cancels a scheduled retry", async () => {
    const hue = revivableServer();
    hue.state.listening = false;
    const clock = recoveryClock();
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
      { recoveryWait: clock.wait, now: clock.now, random: () => 0.5 },
    );
    const attempts = hue.state.connects;

    await registry.shutdown();
    hue.state.listening = true;
    await Promise.resolve();

    expect(hue.state.connects).toBe(attempts);
    expect(registry.serverStatus()[0]?.next_retry_at).toBeNull();
  });

  test("shutdown joins a recovery connection already in flight", async () => {
    const clock = recoveryClock();
    let connects = 0;
    let finishConnect!: (client: McpClient) => void;
    const pendingConnect = new Promise<McpClient>((resolve) => {
      finishConnect = resolve;
    });
    let shutdowns = 0;
    const recovered = {
      server: "hue",
      listTools: () => Promise.resolve([]),
      call: () => Promise.resolve(null),
      shutdown: () => {
        shutdowns += 1;
        return Promise.resolve();
      },
    } as unknown as McpClient;
    const connect = (): Promise<McpClient> => {
      connects += 1;
      return connects <= 6 ? Promise.reject(new Error("offline")) : pendingConnect;
    };
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      connect,
      noSleep,
      { recoveryWait: clock.wait, now: clock.now, random: () => 0.5 },
    );

    await clock.releaseNext();
    await eventually(() => connects === 7);
    expect(registry.serverStatus()[0]).toMatchObject({
      state: "retrying",
      next_retry_at: null,
    });
    let stopped = false;
    const shutdown = registry.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishConnect(recovered);
    await shutdown;
    expect(shutdowns).toBe(1);
    expect(registry.connectedServers()).toBe(0);
  });

  test("the exponential schedule is jittered and strictly capped", () => {
    expect(mcpRecoveryDelayMs(0, () => 0.5)).toBe(1000);
    expect(mcpRecoveryDelayMs(1, () => 0.5)).toBe(2000);
    expect(mcpRecoveryDelayMs(99, () => 0)).toBe(48_000);
    expect(mcpRecoveryDelayMs(99, () => 1)).toBe(60_000);
  });
});

describe("a connection that dies mid-session is rebuilt", () => {
  test("the failed call reports the failure, and the next call works", async () => {
    const hue = revivableServer({ tools: ["set_light"] });
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    hue.killConnection();
    expect(registry.call("mcp__hue__set_light", {})).rejects.toThrow(McpTransportError);
    expect(registry.call("mcp__hue__set_light", {})).resolves.toBe("set_light ran");
    expect(hue.state.connects).toBe(2);
  });

  test("the failed call is never retried", async () => {
    const hue = revivableServer({ tools: ["send_message"] });
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    hue.killConnection();
    expect(registry.call("mcp__hue__send_message", {})).rejects.toThrow(McpTransportError);
    expect(hue.state.calls).toBe(1);
  });

  test("the tool surface does not move, so cached prefixes still match", async () => {
    const hue = revivableServer({ tools: ["set_light"] });
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );
    const before = registry.allTools().map((t) => t.full_name);

    hue.state.tools = ["set_light", "brand_new_tool"];
    hue.killConnection();
    expect(registry.call("mcp__hue__set_light", {})).rejects.toThrow(McpTransportError);

    expect(registry.allTools().map((t) => t.full_name)).toEqual(before);
    expect(registry.call("mcp__hue__set_light", {})).resolves.toBe("set_light ran");
  });

  test("the old connection is closed once the new one is in place", async () => {
    const hue = revivableServer();
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    hue.killConnection();
    expect(registry.call("mcp__hue__ping", {})).rejects.toThrow(McpTransportError);
    expect(hue.state.shutdowns).toBe(1);
  });

  test("a cancelled call leaves the healthy connection alone", async () => {
    const hue = revivableServer({ tools: ["set_light"] });
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    const cancelled = new AbortController();
    cancelled.abort();
    expect(registry.call("mcp__hue__set_light", {}, cancelled.signal)).rejects.toThrow(
      McpCancelled,
    );

    expect(hue.state.connects).toBe(1);
    expect(hue.state.shutdowns).toBe(0);
    expect(registry.call("mcp__hue__set_light", {})).resolves.toBe("set_light ran");
  });

  test("concurrent calls to a dead server share one reconnect", async () => {
    const hue = revivableServer({ tools: ["a", "b", "c"] });
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    hue.killConnection();
    const results = await Promise.allSettled([
      registry.call("mcp__hue__a", {}),
      registry.call("mcp__hue__b", {}),
      registry.call("mcp__hue__c", {}),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(hue.state.connects).toBe(2);
  });

  test("a peer that is still down leaves the registry usable and tries again later", async () => {
    const hue = revivableServer();
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    hue.killConnection();
    hue.state.listening = false;
    expect(registry.call("mcp__hue__ping", {})).rejects.toThrow(McpTransportError);
    expect(hue.state.connects).toBe(2);

    hue.state.listening = true;
    expect(registry.call("mcp__hue__ping", {})).rejects.toThrow(McpTransportError);
    expect(registry.call("mcp__hue__ping", {})).resolves.toBe("ping ran");
    await registry.shutdown();
  });

  test("a tool that returns an error does not touch the connection", async () => {
    let connects = 0;
    const connect = (spec: McpServerSpec): Promise<McpClient> => {
      connects += 1;
      return Promise.resolve({
        server: spec.name,
        listTools: () =>
          Promise.resolve([
            { server: spec.name, name: "ping", description: "", input_schema: {} },
          ]),
        call: () => Promise.reject(new McpError("MCP tool 'ping' returned an error: nope")),
        shutdown: () => Promise.resolve(),
      } as unknown as McpClient);
    };

    const registry = await McpRegistry.fromConfig({ hue: httpServer() }, PLUGINS, connect, noSleep);
    expect(registry.call("mcp__hue__ping", {})).rejects.toThrow("returned an error");
    expect(connects).toBe(1);
  });

  test("a stdio server is left for background recovery rather than retried inline", async () => {
    const hue = revivableServer();
    const registry = await McpRegistry.fromConfig(
      { hue: stdioServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    hue.killConnection();
    expect(registry.call("mcp__hue__ping", {})).rejects.toThrow(McpTransportError);
    expect(hue.state.connects).toBe(1);
    expect(registry.serverStatus()[0]).toMatchObject({ state: "unavailable" });
    await registry.shutdown();
  });

  test("a registry being shut down does not adopt a late reconnect", async () => {
    const hue = revivableServer();
    const registry = await McpRegistry.fromConfig(
      { hue: httpServer() },
      PLUGINS,
      hue.connect,
      noSleep,
    );

    await registry.shutdown();
    hue.killConnection();
    expect(registry.call("mcp__hue__ping", {})).rejects.toThrow(McpTransportError);

    expect(hue.state.connects).toBe(1);
  });
});

describe("invalid entries and initial list failures", () => {
  test("an entry with neither command nor url is skipped without connecting", async () => {
    const h = harness();
    const registry = await build({ hue: {} }, h);

    expect(h.attempts).toEqual([]);
    expect(registry.connectedServers()).toBe(0);
    await registry.shutdown();
  });

  test("a server that fails tools/list is shut down before background recovery", async () => {
    const shutdowns = { count: 0 };
    const connect = (spec: McpServerSpec): Promise<McpClient> =>
      Promise.resolve({
        server: spec.name,
        listTools: () => Promise.reject(new Error("no tools for you")),
        call: () => Promise.resolve(null),
        shutdown: () => {
          shutdowns.count += 1;
          return Promise.resolve();
        },
      } as unknown as McpClient);

    const registry = await McpRegistry.fromConfig({ hue: httpServer() }, PLUGINS, connect);

    expect(shutdowns.count).toBe(1);
    expect(registry.connectedServers()).toBe(0);
    await registry.shutdown();
  });
});
