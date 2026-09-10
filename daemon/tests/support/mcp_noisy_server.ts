import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const deadline = setTimeout(() => process.exit(1), 2000);
await new Promise<void>((resolve, reject) => {
  process.stderr.write("diagnostic\n".repeat(210_000), (error) => error ? reject(error) : resolve());
});
clearTimeout(deadline);
const server = new McpServer({ name: "noisy", version: "1.0.0" });
server.registerTool("ping", {}, () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
