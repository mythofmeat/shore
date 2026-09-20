import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFile, writeFile } from "node:fs/promises";

const server = new McpServer({ name: "tool-fixture", version: "1.0.0" });
server.registerTool("nested", {
  description: "Echo nested entries, nullable flags and a selected mode.",
  inputSchema: { entries: z.array(z.object({ text: z.string(), enabled: z.boolean().nullable() })), mode: z.enum(["single", "all"]), metadata: z.record(z.string(), z.string()).optional() },
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }));
server.registerTool("cancel_late", {
  description: "Demonstrate an external effect that finishes after cancellation.",
  inputSchema: { marker: z.string() },
}, async ({ marker }, extra) => {
  await writeFile(marker, "started\n");
  await new Promise<void>((resolve) => { if (extra.signal.aborted) resolve(); else extra.signal.addEventListener("abort", () => resolve(), { once: true }); });
  await appendFile(marker, "finished despite cancellation\n");
  return { content: [{ type: "text", text: "Effect committed" }] };
});
await server.connect(new StdioServerTransport());
