/**
 * Startup connection policy for MCP servers: who gets retried, who does not,
 * and what the result looks like when servers come up out of order (#37).
 *
 * Not parity — the Rust had none of this. `mcp_parity.test.ts` still owns
 * everything the port froze; this file owns the retry that was added on top.
 *
 * Sleep is injected throughout, so the tests assert the *schedule* rather than
 * spending it.
 */

import { describe, expect, test } from "bun:test";

import {
  McpRegistry,
  type McpServerConfigView,
  type Sleep,
} from "../src/tools/mcp_registry.ts";
import type { McpClient, McpServerSpec } from "../src/mcp/client.ts";

const PLUGINS = "/plugins";

/** An `[mcp.<name>]` entry reached over HTTP. */
function httpServer(url = "http://mcp:8080"): McpServerConfigView {
  return { url };
}

/** An `[mcp.<name>]` entry spawned as a stdio child. */
function stdioServer(command = "hue-server"): McpServerConfigView {
  return { command };
}

/** A connected client offering one tool, counting its own shutdowns. */
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

/**
 * A `connect` that records every attempt and fails the first `failures` of
 * them per server, plus a `sleep` that records the delays instead of waiting.
 */
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
    // The case the issue is about: compose starts the container, shore reaches
    // it before the process inside has bound, and today's single attempt loses
    // that server — and its slice of the cache prefix — for the session.
    const h = harness({ failures: { hue: 3 } });
    const registry = await build({ hue: httpServer() }, h);

    expect(registry.connectedServers()).toBe(1);
    expect(registry.allTools().map((t) => t.full_name)).toEqual(["mcp__hue__ping"]);
    expect(h.attemptsFor("hue")).toBe(4);
  });

  test("the backoff follows the documented schedule", async () => {
    const h = harness({ failures: { hue: 3 } });
    await build({ hue: httpServer() }, h);

    // Front-loaded: three failures cost 1.7s, not a flat three-second wait.
    expect(h.delays).toEqual([200, 500, 1000]);
  });

  test("retries are bounded, and exhausting them skips rather than throws", async () => {
    const h = harness({ failures: { hue: 99 } });
    const registry = await build({ hue: httpServer() }, h);

    // Six attempts over ~7.7s, then give up. "A bad server never takes the
    // daemon down" survives the retry.
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
    // Deliberate asymmetry. A stdio child is shore's own to spawn: if it fails
    // once it will keep failing, and retrying only respawns a broken process.
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
    // The requirement that makes the retry safe to add at all: awaited one at
    // a time, three dead servers would hold the daemon's startup for three
    // full backoff windows.
    const h = harness({ failures: { a: 99, b: 99, c: 99 } });
    await build({ a: httpServer(), b: httpServer(), c: httpServer() }, h);

    // Every server's first attempt happens before any server's second — which
    // is only true if they are in flight together.
    expect(h.attempts.slice(0, 3).sort()).toEqual(["a", "b", "c"]);
    expect(h.attempts).toHaveLength(18);

    // Three servers sharing one schedule, rather than serialising it.
    const window = 200 + 500 + 1000 + 2000 + 4000;
    expect(h.delays.reduce((a, b) => a + b, 0)).toBe(window * 3);
    expect(Math.max(...h.delays)).toBe(4000);
  });

  test("the surface is sorted by name, not by who answered first", async () => {
    // Concurrency must not reach the tool list. `zulu` connects immediately and
    // `alpha` only after retries, so completion order is the reverse of the
    // order the registry has to pin.
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

    // Not left running with no tools, and not retried either — the connect
    // succeeded, so this is a server that is up and unhappy, not one that lost
    // a race.
    expect(shutdowns.count).toBe(1);
    expect(registry.connectedServers()).toBe(0);
  });
});
