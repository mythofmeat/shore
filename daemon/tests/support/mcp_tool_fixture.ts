import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFile, writeFile } from "node:fs/promises";

const server = new McpServer({ name: "tool-fixture", version: "1.0.0" });
server.registerTool("three_images", {
  description: "Return three images, exceeding the model's inline image allowance.", inputSchema: {},
}, () => ({ content: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"].map((data) => ({ type: "image" as const, mimeType: "image/png", data })) }));
server.registerTool("nested", {
  description: "Echo nested entries, nullable flags and a selected mode.",
  inputSchema: { entries: z.array(z.object({ text: z.string(), enabled: z.boolean().nullable() })), mode: z.enum(["single", "all"]), metadata: z.record(z.string(), z.string()).optional(), alternative: z.union([z.strictObject({ first: z.string().optional() }), z.strictObject({ second: z.string().optional() })]).optional() },
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
server.registerTool("every_kind", {
  description: "Return one block of every kind Shore turns into a note.", inputSchema: {},
}, () => ({ content: [
  { type: "text" as const, text: "said" },
  { type: "audio" as const, data: "AAAA", mimeType: "audio/wav" },
  { type: "image" as const, data: "AAAA", mimeType: "image/bmp" },
  { type: "resource" as const, resource: { uri: "file:///notes.txt", text: "the notes" } },
  { type: "resource" as const, resource: { uri: "file:///song.ogg", blob: "AAAA", mimeType: "audio/ogg" } },
  { type: "resource_link" as const, uri: "file:///map.png", name: "map", mimeType: "image/png" },
] }));
server.registerTool("fails", {
  description: "Fail with words and a sound.", inputSchema: {},
}, () => ({ isError: true, content: [{ type: "text" as const, text: "it broke" }, { type: "audio" as const, data: "AAAA", mimeType: "audio/wav" }] }));
await server.connect(new StdioServerTransport());
