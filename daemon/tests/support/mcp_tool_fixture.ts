import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "tool-fixture", version: "1.0.0" });
server.registerTool("nested", {
  description: "Echo nested entries, nullable flags and a selected mode.",
  inputSchema: { entries: z.array(z.object({ text: z.string(), enabled: z.boolean().nullable() })), mode: z.enum(["single", "all"]), metadata: z.record(z.string(), z.string()).optional() },
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }));
await server.connect(new StdioServerTransport());
