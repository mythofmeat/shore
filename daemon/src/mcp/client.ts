import { shoreLog } from "../log.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type Transport =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | {
      kind: "http";
      url: string;
      headers: Record<string, string>;
    };

export interface McpServerSpec {
  name: string;
  transport: Transport;
}

export interface McpTool {
  server: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class McpError extends Error {}

export class McpTransportError extends McpError {}

export function childEnvironment(
  configured: Record<string, string>,
  parent: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...configured };
}

export class McpClient {
  private readonly serverName: string;
  private readonly client: Client;

  private constructor(serverName: string, client: Client) {
    this.serverName = serverName;
    this.client = client;
  }

  get server(): string {
    return this.serverName;
  }

  static async connect(this: void, spec: McpServerSpec): Promise<McpClient> {
    const client = new Client({ name: "shore", version: "1.0.0" });
    try {
      if (spec.transport.kind === "stdio") {
        const { command, args, env, cwd } = spec.transport;
        await client.connect(
          new StdioClientTransport({
            command,
            args,
            env: childEnvironment(env),
            stderr: "pipe",
            ...(cwd === undefined ? {} : { cwd }),
          }),
        );
      } else {
        const { url, headers } = spec.transport;
        const opts =
          Object.keys(headers).length === 0 ? undefined : { requestInit: { headers } };
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(url),
            opts,
          ) as unknown as Parameters<Client["connect"]>[0],
        );
      }
    } catch (e) {
      throw new McpError(`connect to MCP server '${spec.name}': ${String(e)}`);
    }
    return new McpClient(spec.name, client);
  }

  async listTools(): Promise<McpTool[]> {
    let result: Awaited<ReturnType<Client["listTools"]>>;
    try {
      result = await this.client.listTools();
    } catch (e) {
      throw new McpTransportError(`MCP request to '${this.serverName}': ${String(e)}`);
    }
    return result.tools.map((tool) => ({
      server: this.serverName,
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  async call(tool: string, args: unknown): Promise<unknown> {
    let argumentsMap: Record<string, unknown> | undefined;
    if (args === null || args === undefined) {
      argumentsMap = undefined;
    } else if (typeof args === "object" && !Array.isArray(args)) {
      argumentsMap = args as Record<string, unknown>;
    } else {
      throw new McpError(
        `invalid arguments for MCP tool '${tool}': expected a JSON object, got ${JSON.stringify(args)}`,
      );
    }

    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await this.client.callTool({
        name: tool,
        ...(argumentsMap === undefined ? {} : { arguments: argumentsMap }),
      });
    } catch (e) {
      throw new McpTransportError(`MCP request to '${this.serverName}': ${String(e)}`);
    }

    if (result.isError === true) {
      throw new McpError(`MCP tool '${tool}' returned an error: ${flattenText(result)}`);
    }
    return flattenResult(result);
  }

  async shutdown(): Promise<void> {
    try {
      await this.client.close();
    } catch (e) {
      shoreLog.warn(`MCP shutdown error for '${this.serverName}': ${String(e)}`);
    }
  }
}

export function flattenResult(result: Record<string, unknown>): unknown {
  if (result["structuredContent"] !== undefined) return result["structuredContent"];
  return flattenText(result);
}

export function flattenText(result: Record<string, unknown>): string {
  const content = result["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}
