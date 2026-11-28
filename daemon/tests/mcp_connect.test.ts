import { describe, expect, test } from "bun:test";

import { McpRegistry, type McpServerConfigView, type Sleep } from "../src/tools/mcp_registry.ts";
import { McpTransportError, type McpClient, type McpServerSpec } from "../src/mcp/client.ts";
import { Texts } from "../src/texts/texts.ts";
import { rejectionOf } from "./support/outcome.ts";

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

describe("calling a tool through the registry", () => {
  const scripted = (spec: McpServerSpec, answers: (() => Promise<unknown>)[], seen: unknown[][]) => ({
    server: spec.name,
    listTools: () => Promise.resolve([{ server: spec.name, name: "ping", description: "ping", input_schema: {}, repeatable: true }]),
    call: (...args: unknown[]) => {
      seen.push(args);
      return (answers.shift() ?? (() => Promise.resolve("pong")))();
    },
    shutdown: () => Promise.resolve(),
  } as unknown as McpClient);

  test("goes to the tool's server with its arguments, the texts, the signal and whether it may be repeated, and answers with what the server did", async () => {
    const seen: unknown[][] = [];
    const registry = await McpRegistry.fromConfig({ web: httpServer() }, PLUGINS, (spec) => Promise.resolve(scripted(spec, [], seen)), () => Promise.resolve());
    const texts = new Texts();
    const signal = new AbortController().signal;
    expect(await registry.call("mcp__web__ping", { a: 1 }, texts, signal)).toBe("pong");
    expect(seen).toEqual([["ping", { a: 1 }, texts, signal, true]]);
    await registry.shutdown();
  });

  test("a server that fails to answer is marked unavailable and the failure passed on, and an HTTP server is reconnected so the next call goes through", async () => {
    const seen: unknown[][] = [];
    let connects = 0;
    const registry = await McpRegistry.fromConfig({ web: httpServer() }, PLUGINS, (spec) => {
      connects += 1;
      return Promise.resolve(scripted(spec, connects === 1 ? [() => Promise.reject(new McpTransportError("socket closed"))] : [], seen));
    }, () => Promise.resolve());
    expect(String(await rejectionOf(registry.call("mcp__web__ping", {}, new Texts())))).toContain("socket closed");
    expect(connects).toBe(2);
    expect(await registry.call("mcp__web__ping", {}, new Texts())).toBe("pong");
    await registry.shutdown();
  });

  test("any other failure is passed on and leaves the server connected", async () => {
    const seen: unknown[][] = [];
    let connects = 0;
    const registry = await McpRegistry.fromConfig({ web: httpServer() }, PLUGINS, (spec) => {
      connects += 1;
      return Promise.resolve(scripted(spec, [() => Promise.reject(new Error("the tool said no"))], seen));
    }, () => Promise.resolve());
    expect(String(await rejectionOf(registry.call("mcp__web__ping", {}, new Texts())))).toContain("the tool said no");
    expect(registry.serverStatus().map((status) => [status.state, status.last_error])).toEqual([["connected", null]]);
    expect(await registry.call("mcp__web__ping", {}, new Texts())).toBe("pong");
    expect(connects).toBe(1);
    await registry.shutdown();
  });

  test("a tool whose server has no client is refused as unavailable once the server has been tried again", async () => {
    const seen: unknown[][] = [];
    const registry = McpRegistry.fromTools([{ full_name: "mcp__web__ping", description: "ping", input_schema: {}, server: "web", tool: "ping", repeatable: false }]);
    expect(String(await rejectionOf(registry.call("mcp__web__ping", {}, new Texts())))).toContain("MCP server 'web' is unavailable");
    expect(seen).toEqual([]);
    let connects = 0;
    const revived = await McpRegistry.fromConfig({ web: httpServer() }, PLUGINS, (spec) => {
      connects += 1;
      if (connects === 2) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve(scripted(spec, connects === 1 ? [() => Promise.reject(new McpTransportError("socket closed"))] : [], seen));
    }, () => Promise.resolve(), { recoveryWait: (_ms, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { resolve(); }); }) });
    expect(String(await rejectionOf(revived.call("mcp__web__ping", {}, new Texts())))).toContain("socket closed");
    expect(revived.serverStatus().map((status) => status.state)).toEqual(["unavailable"]);
    expect(String(await rejectionOf(revived.call("mcp__web__ping", {}, new Texts())))).toContain("MCP server 'web' is unavailable");
    expect(connects).toBe(3);
    expect(await revived.call("mcp__web__ping", {}, new Texts())).toBe("pong");
    await revived.shutdown();
  });
});
