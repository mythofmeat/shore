import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { z } from "zod";

import { defaultMemoryBackendConfig } from "../src/config/app.ts";
import { HindsightBackend, memoryBackendTarget } from "../src/memory/backend.ts";

interface Seen {
  bank: string;
  tool: string;
  args: Record<string, unknown>;
}

const seen: Seen[] = [];
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
const open: WebStandardStreamableHTTPServerTransport[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

async function newBank(bank: string): Promise<WebStandardStreamableHTTPServerTransport> {
  const mcp = new McpServer({ name: `bank-${bank}`, version: "1.0.0" });
  mcp.registerTool(
    "recall",
    {
      description: "search memories",
      inputSchema: { query: z.string(), max_tokens: z.number().optional() },
    },
    (args: { query: string; max_tokens?: number | undefined }) => {
      seen.push({ bank, tool: "recall", args: { ...args } });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ memories: [{ text: `from ${bank}` }] }),
          },
        ],
      };
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id: string) => {
      sessions.set(id, transport);
    },
  });
  await mcp.connect(transport);
  open.push(transport);
  return transport;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: async (request) => {
      const bank = new URL(request.url).pathname.split("/").filter((part) => part !== "").at(-1);
      if (bank === undefined) return new Response("no bank", { status: 404 });
      const id = request.headers.get("mcp-session-id");
      const existing = id === null ? undefined : sessions.get(id);
      const body = request.method === "POST" ? await request.json() : undefined;
      const transport = existing ?? (await newBank(bank));
      return await transport.handleRequest(
        request,
        body === undefined ? undefined : { parsedBody: body },
      );
    },
  });
});

afterAll(async () => {
  for (const transport of open) await transport.close();
  await server?.stop(true);
});

function backendFor(character: string, bank = ""): HindsightBackend {
  const config = defaultMemoryBackendConfig();
  config.url = `http://127.0.0.1:${String(server?.port ?? 0)}/mcp/`;
  config.bank = bank;
  return new HindsightBackend(character, memoryBackendTarget(config, character));
}

describe("memory backend over a real http transport", () => {
  test("a recall reaches the bank named by the character", async () => {
    const backend = backendFor("qifei");
    const raw = await backend.call("recall", { query: "music script", max_tokens: 2048 });

    expect(JSON.stringify(raw)).toContain("from qifei");
    expect(seen.at(-1)).toEqual({
      bank: "qifei",
      tool: "recall",
      args: { query: "music script", max_tokens: 2048 },
    });
    await backend.shutdown();
  });

  test("two characters on one base reach separate banks", async () => {
    const qifei = backendFor("qifei");
    const yuna = backendFor("Yuna");

    expect(JSON.stringify(await qifei.call("recall", { query: "a" }))).toContain("from qifei");
    expect(JSON.stringify(await yuna.call("recall", { query: "a" }))).toContain("from Yuna");

    await qifei.shutdown();
    await yuna.shutdown();
  });

  test("an explicit bank overrides the character name on the wire", async () => {
    const backend = backendFor("qifei", "shared");

    expect(JSON.stringify(await backend.call("recall", { query: "a" }))).toContain("from shared");
    await backend.shutdown();
  });

  test("a tool the bank does not expose fails loudly", async () => {
    const backend = backendFor("qifei");
    let message = "";
    try {
      await backend.call("retain", { document: "x" });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    expect(message).not.toBe("");
    expect(message.toLowerCase()).toContain("retain");
    await backend.shutdown();
  });
});
