import { appendFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const marker: string = process.argv[2] ?? "";
if (marker === "") throw new Error("usage: mcp_side_effect_server.ts <marker-file> [hold-ms]");

const HOLD_MS = Number(process.argv[3] ?? "1500");

function hold(signal?: AbortSignal): Promise<"finished" | "cancelled"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve("finished");
    }, HOLD_MS);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve("cancelled");
    });
  });
}

async function run(tool: string, signal?: AbortSignal) {
  if ((await hold(signal)) === "cancelled") {
    await appendFile(marker, "cancelled\n");
    throw new Error("cancelled before the side effect ran");
  }
  await appendFile(marker, `side effect: ${tool}\n`);
  return { content: [{ type: "text" as const, text: "done" }] };
}

const server = new McpServer({ name: "side-effect", version: "1.0.0" });

server.registerTool(
  "obedient",
  { description: "waits, then records a side effect unless it is cancelled first" },
  (extra) => run("obedient", extra.signal),
);

server.registerTool(
  "stubborn",
  { description: "waits and records a side effect no matter what it is told" },
  () => run("stubborn"),
);

server.registerTool(
  "lookup",
  {
    description: "waits, and reads nothing that repeating could damage",
    annotations: { readOnlyHint: true },
  },
  () => run("lookup"),
);

await server.connect(new StdioServerTransport());
