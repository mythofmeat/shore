import { describe, expect, test } from "bun:test";

import {
  McpRegistry,
  type McpServerConfigView,
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
  });

  test("one unreachable server does not cost the reachable ones their tools", async () => {
    const h = harness({ failures: { dead: 99 }, tools: { hue: ["set_light"] } });
    const registry = await build({ dead: httpServer(), hue: httpServer() }, h);

    expect(registry.connectedServers()).toBe(1);
    expect(registry.allTools().map((t) => t.full_name)).toEqual(["mcp__hue__set_light"]);
  });
});

describe("stdio servers are not retried", () => {
  test("a child that fails to spawn gets exactly one attempt", async () => {
    const h = harness({ failures: { hue: 1 } });
    const registry = await build({ hue: stdioServer() }, h);

    expect(h.attemptsFor("hue")).toBe(1);
    expect(h.delays).toEqual([]);
    expect(registry.connectedServers()).toBe(0);
  });

  test("a stdio server alongside a retrying HTTP one is unaffected", async () => {
    const h = harness({ failures: { child: 1, remote: 2 } });
    const registry = await build({ child: stdioServer(), remote: httpServer() }, h);

    expect(h.attemptsFor("child")).toBe(1);
    expect(h.attemptsFor("remote")).toBe(3);
    expect(registry.connectedServers()).toBe(1);
  });
});

describe("servers are brought up concurrently", () => {
  test("N unavailable servers cost one backoff window, not N", async () => {
    const h = harness({ failures: { a: 99, b: 99, c: 99 } });
    await build({ a: httpServer(), b: httpServer(), c: httpServer() }, h);

    expect(h.attempts.slice(0, 3).sort()).toEqual(["a", "b", "c"]);
    expect(h.attempts).toHaveLength(18);

    const window = 200 + 500 + 1000 + 2000 + 4000;
    expect(h.delays.reduce((a, b) => a + b, 0)).toBe(window * 3);
    expect(Math.max(...h.delays)).toBe(4000);
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

  test("a stdio server is not revived", async () => {
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

describe("the pre-existing skips are unchanged", () => {
  test("an entry with neither command nor url is skipped without connecting", async () => {
    const h = harness();
    const registry = await build({ hue: {} }, h);

    expect(h.attempts).toEqual([]);
    expect(registry.connectedServers()).toBe(0);
  });

  test("a server that connects but fails tools/list is shut down", async () => {
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
  });
});
