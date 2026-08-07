/**
 * MCP (Model Context Protocol) client.
 *
 * Ported from `crates/daemon/src/mcp/mod.rs`. The daemon is an MCP *client*:
 * each `[mcp.<name>]` config entry points at an external server — a stdio child
 * process or a remote HTTP endpoint — that it connects to, discovers tools from
 * via `tools/list`, and invokes via `tools/call`. Servers are never daemon
 * code; anything speaking standard MCP works unchanged.
 *
 * A thin, transport-agnostic wrapper, the same shape the Rust had over `rmcp`.
 * Namespacing lives in `tools/mcp_registry.ts`, not here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** How to reach an MCP server. */
export type Transport =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      /** Working directory for the child. Absent inherits the daemon's. */
      cwd?: string;
    }
  | { kind: "http"; url: string };

/** A named MCP server to connect to. */
export interface McpServerSpec {
  name: string;
  transport: Transport;
}

/** A single tool discovered from a server via `tools/list`. */
export interface McpTool {
  /** The server this tool belongs to (the `[mcp.<name>]` key). */
  server: string;
  /** The server-side tool name (e.g. `set_light`), without namespacing. */
  name: string;
  description: string;
  /** The tool's JSON Schema for its arguments. */
  input_schema: Record<string, unknown>;
}

/** Anything that went wrong talking to a server. */
export class McpError extends Error {}

/**
 * Environment variables a stdio server inherits.
 *
 * **The daemon's environment is not passed through.** MCP servers are
 * third-party code and the daemon's environment holds every provider API key,
 * so the child starts from a clean slate with only what a server needs to run —
 * `PATH` to resolve its command, `HOME` for tool caches and config — plus the
 * explicitly configured `env`.
 *
 * The SDK's own `getDefaultEnvironment()` inherits a wider set and is
 * deliberately not used.
 */
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

/** A live connection to one MCP server. */
export class McpClient {
  private readonly serverName: string;
  private readonly client: Client;

  private constructor(serverName: string, client: Client) {
    this.serverName = serverName;
    this.client = client;
  }

  /** The server name (the `[mcp.<name>]` key). */
  get server(): string {
    return this.serverName;
  }

  /** Connect to `spec`, performing the MCP `initialize` handshake. */
  static async connect(spec: McpServerSpec): Promise<McpClient> {
    const client = new Client({ name: "shore", version: "1.0.0" });
    try {
      if (spec.transport.kind === "stdio") {
        const { command, args, env, cwd } = spec.transport;
        await client.connect(
          new StdioClientTransport({
            command,
            args,
            env: childEnvironment(env),
            // Relay the server's diagnostics rather than letting them land on
            // the daemon's own stderr uninvited.
            stderr: "pipe",
            ...(cwd === undefined ? {} : { cwd }),
          }),
        );
      } else {
        // The cast is `exactOptionalPropertyTypes` friction, not a real
        // mismatch: the SDK declares `sessionId?: string` on the interface and
        // `string | undefined` on the class, which this project's stricter
        // setting treats as different types.
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(spec.transport.url),
          ) as unknown as Parameters<Client["connect"]>[0],
        );
      }
    } catch (e) {
      throw new McpError(`connect to MCP server '${spec.name}': ${String(e)}`);
    }
    return new McpClient(spec.name, client);
  }

  /**
   * List the server's tools.
   *
   * Called once at connect; the registry pins the result for the session so the
   * tool surface — and the cache prefix built on it — is stable. A server that
   * gains a tool mid-session does not get it offered until the next reload.
   */
  async listTools(): Promise<McpTool[]> {
    let result: Awaited<ReturnType<Client["listTools"]>>;
    try {
      result = await this.client.listTools();
    } catch (e) {
      throw new McpError(`MCP request to '${this.serverName}': ${String(e)}`);
    }
    return result.tools.map((tool) => ({
      server: this.serverName,
      name: tool.name,
      // A server may omit the description; the Rust defaulted it to empty
      // rather than dropping the tool.
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  /**
   * Invoke `tool` with `args`, returning a flattened JSON result.
   *
   * `args` must be a JSON object or null — a bare scalar or array is a caller
   * error, not something to forward and let the server reject.
   */
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
      throw new McpError(`MCP request to '${this.serverName}': ${String(e)}`);
    }

    if (result.isError === true) {
      throw new McpError(`MCP tool '${tool}' returned an error: ${flattenText(result)}`);
    }
    return flattenResult(result);
  }

  /** Gracefully close the connection, and for stdio the child process. */
  async shutdown(): Promise<void> {
    try {
      await this.client.close();
    } catch (e) {
      console.warn(`MCP shutdown error for '${this.serverName}': ${String(e)}`);
    }
  }
}

/**
 * Reduce a tool result to JSON: prefer structured content, else join text.
 *
 * Typed loosely on purpose. The SDK's `callTool` return is a union that
 * includes a legacy `{ toolResult }` shape carrying neither field, and a
 * narrower parameter would reject it outright rather than flattening it to the
 * empty string the Rust produced.
 */
export function flattenResult(result: Record<string, unknown>): unknown {
  if (result["structuredContent"] !== undefined) return result["structuredContent"];
  return flattenText(result);
}

/**
 * Join all text content blocks with newlines.
 *
 * Non-text blocks — images, embedded resources — are dropped rather than
 * described. The Rust did the same: a tool returning only an image flattens to
 * an empty string, which reads to the model as a tool that returned nothing.
 */
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
