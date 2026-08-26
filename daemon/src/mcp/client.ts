import { shoreLog } from "../log.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  base64Bytes,
  carryToolMedia,
  deepEqual,
  renderPayload,
  type ToolMediaItem,
  type ToolResultPayload,
} from "../tools/media.ts";

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
    return carryToolMedia(interpretResult(result));
  }

  async shutdown(): Promise<void> {
    try {
      await this.client.close();
    } catch (e) {
      shoreLog.warn(`MCP shutdown error for '${this.serverName}': ${String(e)}`);
    }
  }
}

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function interpretResult(result: Record<string, unknown>): ToolResultPayload {
  const blocks: unknown[] = Array.isArray(result["content"]) ? result["content"] : [];
  const texts: string[] = [];
  const media: ToolMediaItem[] = [];
  const extra: string[] = [];

  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    switch (b["type"]) {
      case "text":
        if (typeof b["text"] === "string") texts.push(b["text"]);
        break;
      case "image":
        absorbBinary(b["data"], b["mimeType"], "image", media, extra);
        break;
      case "audio":
        absorbBinary(b["data"], b["mimeType"], "audio", media, extra);
        break;
      case "resource":
        absorbResource(b, media, extra);
        break;
      case "resource_link":
        extra.push(describeLink(b));
        break;
      default:
        extra.push(`[${describeType(b["type"])} content omitted: shore cannot render it]`);
        break;
    }
  }

  const structured = result["structuredContent"];
  if (structured === undefined) return { value: texts.join("\n"), media, extra };

  const distinct = texts.filter((t) => !mirrorsStructured(t, structured));
  return { value: structured, media, extra: [...distinct, ...extra] };
}

export function flattenText(result: Record<string, unknown>): string {
  return renderPayload(interpretResult(result));
}

function absorbBinary(
  data: unknown,
  mimeType: unknown,
  kind: "image" | "audio",
  media: ToolMediaItem[],
  extra: string[],
): void {
  const mime = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  if (typeof data !== "string" || data === "") {
    extra.push(`[${kind} omitted: the server sent no ${kind} data]`);
    return;
  }
  if (kind === "audio") {
    extra.push(
      `[audio omitted: ${describeMime(mime)}, ${describeSize(data)} — ` +
        `shore cannot send audio to a model]`,
    );
    return;
  }
  if (!IMAGE_MIME.has(mime)) {
    extra.push(`[image omitted: ${describeMime(mime)} is not a supported format]`);
    return;
  }
  media.push({ mime_type: mime, data, label: `${mime}, ${describeSize(data)}` });
}

function absorbResource(
  block: Record<string, unknown>,
  media: ToolMediaItem[],
  extra: string[],
): void {
  const nested = block["resource"];
  const r = (
    typeof nested === "object" && nested !== null ? nested : block
  ) as Record<string, unknown>;
  const uri = typeof r["uri"] === "string" && r["uri"] !== "" ? r["uri"] : "an unnamed resource";
  const mime = typeof r["mimeType"] === "string" ? r["mimeType"].toLowerCase() : "";

  if (typeof r["text"] === "string") {
    extra.push(`[resource ${uri}]\n${r["text"]}`);
    return;
  }

  const blob = r["blob"];
  if (typeof blob === "string" && blob !== "") {
    if (IMAGE_MIME.has(mime)) {
      media.push({ mime_type: mime, data: blob, label: `${uri} (${mime}, ${describeSize(blob)})` });
      return;
    }
    extra.push(
      `[resource ${uri} omitted: ${describeMime(mime)}, ${describeSize(blob)} — ` +
        `shore cannot render it]`,
    );
    return;
  }

  extra.push(`[resource ${uri} omitted: it carried no text or data]`);
}

function describeLink(block: Record<string, unknown>): string {
  const uri = typeof block["uri"] === "string" && block["uri"] !== "" ? block["uri"] : "an unnamed resource";
  const name = typeof block["name"] === "string" && block["name"] !== "" ? `${block["name"]}: ` : "";
  const mime = typeof block["mimeType"] === "string" && block["mimeType"] !== "" ? ` (${block["mimeType"]})` : "";
  return `[resource link: ${name}${uri}${mime}]`;
}

function describeType(type: unknown): string {
  return typeof type === "string" && type !== "" ? type : "unlabelled";
}

function describeMime(mime: string): string {
  return mime === "" ? "an unlabelled type" : mime;
}

function describeSize(data: string): string {
  const bytes = base64Bytes(data);
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mirrorsStructured(text: string, structured: unknown): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return deepEqual(parsed, structured);
}
