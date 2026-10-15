import { describe, expect, test } from "bun:test";

import { McpRegistry, type McpServerConfigView, type Sleep } from "../src/tools/mcp_registry.ts";
import type { McpClient, McpServerSpec } from "../src/mcp/client.ts";

const PLUGINS = "/plugins";

function httpServer(url = "http://mcp:8080"): McpServerConfigView {
  return { url };
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

  test("one unreachable server does not cost the reachable ones their tools", async () => {
    const h = harness({ failures: { dead: 99 }, tools: { hue: ["set_light"] } });
    const registry = await build({ dead: httpServer(), hue: httpServer() }, h);

    expect(registry.connectedServers()).toBe(1);
    expect(registry.allTools().map((t) => t.full_name)).toEqual(["mcp__hue__set_light"]);
    await registry.shutdown();
  });
});
