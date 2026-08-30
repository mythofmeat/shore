import { describe, expect, test } from "bun:test";

import { defaultMemoryBackendConfig } from "../src/config/app.ts";
import { McpTransportError, type McpClient, type McpServerSpec } from "../src/mcp/client.ts";
import {
  HindsightBackend,
  MemoryBackends,
  memoryBackendTarget,
  sameTarget,
} from "../src/memory/backend.ts";

function config(url: string, bank = ""): ReturnType<typeof defaultMemoryBackendConfig> {
  const backend = defaultMemoryBackendConfig();
  backend.url = url;
  backend.bank = bank;
  return backend;
}

interface FakeClient {
  client: McpClient;
  calls: { tool: string; args: Record<string, unknown> }[];
  shutdowns: number;
}

function fakeClient(reply: (tool: string) => unknown): FakeClient {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const state = { shutdowns: 0 };
  const client = {
    call: async (tool: string, args: unknown) => {
      calls.push({ tool, args: args as Record<string, unknown> });
      const answer = reply(tool);
      if (answer instanceof Error) throw answer;
      return await Promise.resolve(answer);
    },
    shutdown: async () => {
      state.shutdowns += 1;
      await Promise.resolve();
    },
  } as unknown as McpClient;
  return {
    client,
    calls,
    get shutdowns() {
      return state.shutdowns;
    },
  };
}

async function rejection(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the call to reject");
}

describe("memory backend targets", () => {
  test("the bank becomes a path segment under the configured base", () => {
    expect(memoryBackendTarget(config("http://mcp-hindsight:8888/mcp/"), "qifei").url).toBe(
      "http://mcp-hindsight:8888/mcp/qifei/",
    );
  });

  test("a base without a trailing slash still gets one", () => {
    expect(memoryBackendTarget(config("http://mcp-hindsight:8888/mcp"), "qifei").url).toBe(
      "http://mcp-hindsight:8888/mcp/qifei/",
    );
  });

  test("an explicit bank overrides the character name", () => {
    expect(memoryBackendTarget(config("http://h/mcp/", "shared"), "qifei").url).toBe(
      "http://h/mcp/shared/",
    );
  });

  test("two characters on one base get separate banks", () => {
    const base = config("http://h/mcp/");
    expect(sameTarget(memoryBackendTarget(base, "qifei"), memoryBackendTarget(base, "Yuna"))).toBe(
      false,
    );
  });

  test("a bank that needs escaping is encoded", () => {
    expect(memoryBackendTarget(config("http://h/mcp/", "a b/c"), "x").url).toBe(
      "http://h/mcp/a%20b%2Fc/",
    );
  });
});

describe("hindsight backend connections", () => {
  test("one connection is shared across calls", async () => {
    const fake = fakeClient(() => ({ ok: true }));
    let connects = 0;
    const backend = new HindsightBackend(
      "qifei",
      { url: "http://h/mcp/qifei/", headers: {} },
      async (_spec: McpServerSpec) => {
        connects += 1;
        return await Promise.resolve(fake.client);
      },
    );

    await backend.call("recall", { query: "a" });
    await backend.call("retain", { document: "b" });

    expect(connects).toBe(1);
    expect(fake.calls.map((entry) => entry.tool)).toEqual(["recall", "retain"]);
  });

  test("concurrent first calls open a single connection", async () => {
    const fake = fakeClient(() => ({ ok: true }));
    let connects = 0;
    const backend = new HindsightBackend(
      "qifei",
      { url: "http://h/mcp/qifei/", headers: {} },
      async () => {
        connects += 1;
        return await Promise.resolve(fake.client);
      },
    );

    await Promise.all([backend.call("recall", {}), backend.call("recall", {})]);

    expect(connects).toBe(1);
  });

  test("a transport failure drops the client so the next call reconnects", async () => {
    let connects = 0;
    const broken = fakeClient(() => new McpTransportError("socket closed"));
    const healthy = fakeClient(() => ({ ok: true }));
    const backend = new HindsightBackend(
      "qifei",
      { url: "http://h/mcp/qifei/", headers: {} },
      async () => {
        connects += 1;
        return await Promise.resolve(connects === 1 ? broken.client : healthy.client);
      },
    );

    expect(await rejection(backend.call("recall", {}))).toContain("socket closed");
    await backend.call("recall", {});

    expect(connects).toBe(2);
    expect(broken.shutdowns).toBe(1);
    expect(healthy.calls).toHaveLength(1);
  });

  test("a failed connection is not cached", async () => {
    let connects = 0;
    const fake = fakeClient(() => ({ ok: true }));
    const backend = new HindsightBackend(
      "qifei",
      { url: "http://h/mcp/qifei/", headers: {} },
      async () => {
        connects += 1;
        if (connects === 1) throw new McpTransportError("refused");
        return await Promise.resolve(fake.client);
      },
    );

    expect(await rejection(backend.call("recall", {}))).toContain("refused");
    await backend.call("recall", {});

    expect(connects).toBe(2);
  });

  test("a shut down backend refuses further calls", async () => {
    const fake = fakeClient(() => ({ ok: true }));
    const backend = new HindsightBackend(
      "qifei",
      { url: "http://h/mcp/qifei/", headers: {} },
      async () => await Promise.resolve(fake.client),
    );

    await backend.call("recall", {});
    await backend.shutdown();

    expect(fake.shutdowns).toBe(1);
    expect(await rejection(backend.call("recall", {}))).toContain("memory backend is shut down");
  });
});

describe("per-character memory backends", () => {
  test("each character resolves its own backend and unknown ones resolve to nothing", () => {
    const fake = fakeClient(() => ({}));
    const backends = new MemoryBackends(async () => await Promise.resolve(fake.client));
    backends.set("qifei", { url: "http://h/mcp/qifei/", headers: {} });
    backends.set("Yuna", { url: "http://h/mcp/Yuna/", headers: {} });

    expect(backends.characters().sort()).toEqual(["Yuna", "qifei"]);
    expect(backends.get("qifei")).toBeDefined();
    expect(backends.get("absent")).toBeUndefined();
  });

  test("setting the same target keeps the live connection", async () => {
    let connects = 0;
    const fake = fakeClient(() => ({}));
    const backends = new MemoryBackends(async () => {
      connects += 1;
      return await Promise.resolve(fake.client);
    });
    backends.set("qifei", { url: "http://h/mcp/qifei/", headers: {} });
    await backends.get("qifei")?.call("recall", {});
    backends.set("qifei", { url: "http://h/mcp/qifei/", headers: {} });
    await backends.get("qifei")?.call("recall", {});

    expect(connects).toBe(1);
  });

  test("a changed target replaces the backend", async () => {
    let connects = 0;
    const fake = fakeClient(() => ({}));
    const backends = new MemoryBackends(async () => {
      connects += 1;
      return await Promise.resolve(fake.client);
    });
    backends.set("qifei", { url: "http://h/mcp/qifei/", headers: {} });
    await backends.get("qifei")?.call("recall", {});
    backends.set("qifei", { url: "http://other/mcp/qifei/", headers: {} });
    await backends.get("qifei")?.call("recall", {});

    expect(connects).toBe(2);
  });

  test("removing a character drops it", () => {
    const fake = fakeClient(() => ({}));
    const backends = new MemoryBackends(async () => await Promise.resolve(fake.client));
    backends.set("qifei", { url: "http://h/mcp/qifei/", headers: {} });
    backends.remove("qifei");

    expect(backends.get("qifei")).toBeUndefined();
    expect(backends.characters()).toEqual([]);
  });
});
