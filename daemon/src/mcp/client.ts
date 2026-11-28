import { shoreLog } from "../log.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  carryToolMedia,
  deepEqual,
  renderPayload,
  type ToolMediaItem,
  type ToolResultPayload,
} from "../tools/media.ts";
import { base64Bytes } from "../util/base64.ts";
import {
  CharacterUserError,
  characterPath,
  characterRuntimeDir,
  characterUser,
  hasAmbientCapabilities,
  setprivArgs,
  setprivFor,
  switchUserProblem,
} from "../tools/character_user.ts";
import type { Texts } from "../texts/texts.ts";

export type Transport =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      user?: string;
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
  repeatable: boolean;
}

export class McpError extends Error {}

export class McpTransportError extends McpError {}

export class McpCancelled extends McpError {
  readonly repeatable: boolean;

  constructor(message: string, repeatable: boolean) {
    super(message);
    this.repeatable = repeatable;
  }
}

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

interface StdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export async function stdioLaunch(
  transport: Extract<Transport, { kind: "stdio" }>,
  parent: Record<string, string | undefined> = process.env,
): Promise<StdioLaunch> {
  const { command, args, env, cwd, user: spec } = transport;
  if (spec === undefined) {
    const plain = { env: childEnvironment(env, parent), ...(cwd === undefined ? {} : { cwd }) };
    return hasAmbientCapabilities()
      ? { command: setprivFor(plain.env["PATH"]), args: [...setprivArgs(undefined), "--", command, ...args], ...plain }
      : { command, args, ...plain };
  }
  const user = await characterUser(spec);
  const problem = switchUserProblem(user);
  if (problem !== undefined) throw new CharacterUserError(problem.replace("tools.user", "the server's user"));
  const path = characterPath(user, parent["PATH"]);
  const runtime = characterRuntimeDir(user);
  return {
    command: setprivFor(path),
    args: [...setprivArgs(user), "--", "env", `--chdir=${cwd ?? user.home ?? "/"}`, "--", command, ...args],
    env: {
      ...(path === undefined ? {} : { PATH: path }),
      ...(user.home === undefined ? {} : { HOME: user.home }),
      ...(runtime === undefined ? {} : { XDG_RUNTIME_DIR: runtime }),
      ...env,
    },
    cwd: "/",
  };
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
    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
    let diagnostics = "";
    try {
      if (spec.transport.kind === "stdio") {
        const { command, args, env, cwd } = await stdioLaunch(spec.transport);
        transport = new StdioClientTransport({
            command,
            args,
            env,
            stderr: "pipe",
            ...(cwd === undefined ? {} : { cwd }),
          });
        transport.stderr?.on("data", (chunk: Buffer) => {
          diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8192);
        });
        await client.connect(transport);
      } else {
        const { url, headers } = spec.transport;
        const opts =
          Object.keys(headers).length === 0 ? undefined : { requestInit: { headers } };
        transport = new StreamableHTTPClientTransport(
            new URL(url),
            opts,
          );
        await client.connect(transport);
      }
    } catch (e) {
      await transport?.close().catch(() => {});
      throw new McpError(`connect to MCP server '${spec.name}': ${String(e)}${diagnostics === "" ? "" : `\nstderr: ${diagnostics}`}`);
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
      repeatable:
        tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
    }));
  }

  async call(
    tool: string,
    args: unknown,
    texts: Texts,
    signal: AbortSignal | undefined,
    repeatable: boolean,
  ): Promise<unknown> {
    const none = args === null || args === undefined;
    if (!none && (typeof args !== "object" || Array.isArray(args))) throw new McpError(texts.always("mcp_bad_arguments", { tool, args: JSON.stringify(args) }));
    const argumentsMap = none ? undefined : args as Record<string, unknown>;

    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await this.client.callTool(
        {
          name: tool,
          ...(argumentsMap === undefined ? {} : { arguments: argumentsMap }),
        },
        undefined,
        signal === undefined ? undefined : { signal },
      );
    } catch (e) {
      if (signal?.aborted === true) {
        throw new McpCancelled(texts.always("mcp_cancelled", { tool, server: this.serverName }), repeatable);
      }
      throw new McpTransportError(texts.always("mcp_request_failed", { server: this.serverName, error: String(e) }));
    }

    if (result.isError === true) {
      throw new McpError(texts.always("mcp_tool_error", { tool, error: flattenText(texts, result) }));
    }
    return carryToolMedia(interpretResult(texts, result));
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

export function interpretResult(texts: Texts, result: Record<string, unknown>): ToolResultPayload {
  const blocks: unknown[] = Array.isArray(result["content"]) ? result["content"] : [];
  const said: string[] = [];
  const media: ToolMediaItem[] = [];
  const extra: string[] = [];
  const note = (text: string | undefined): void => {
    if (text !== undefined) extra.push(text);
  };

  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    switch (b["type"]) {
      case "text":
        if (typeof b["text"] === "string") said.push(b["text"]);
        break;
      case "image":
        absorbImage(texts, b["data"], b["mimeType"], media, note);
        break;
      case "audio":
        note(typeof b["data"] !== "string" || b["data"] === ""
          ? texts.render("mcp_no_audio")
          : texts.render("mcp_audio", { type: given(b["mimeType"])?.toLowerCase(), size: describeSize(b["data"]) }));
        break;
      case "resource":
        absorbResource(texts, b, media, note);
        break;
      case "resource_link":
        note(texts.render("mcp_resource_link", { name: given(b["name"]), uri: given(b["uri"]), type: given(b["mimeType"]) }));
        break;
      default:
        note(texts.render("mcp_unknown", { type: given(b["type"]) }));
        break;
    }
  }

  const structured = result["structuredContent"];
  if (structured === undefined) return { value: said.join("\n"), media, extra };

  const distinct = said.filter((t) => !mirrorsStructured(t, structured));
  return { value: structured, media, extra: [...distinct, ...extra] };
}

export function flattenText(texts: Texts, result: Record<string, unknown>): string {
  return renderPayload(texts, interpretResult(texts, result));
}

function given(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function absorbImage(texts: Texts, data: unknown, mimeType: unknown, media: ToolMediaItem[], note: (text: string | undefined) => void): void {
  const mime = given(mimeType)?.toLowerCase();
  if (typeof data !== "string" || data === "") note(texts.render("mcp_no_image"));
  else if (mime === undefined || !IMAGE_MIME.has(mime)) note(texts.render("mcp_image_type", { type: mime }));
  else media.push({ mime_type: mime, data, label: `${mime}, ${describeSize(data)}` });
}

function absorbResource(texts: Texts, block: Record<string, unknown>, media: ToolMediaItem[], note: (text: string | undefined) => void): void {
  const nested = block["resource"];
  const r = (typeof nested === "object" && nested !== null ? nested : block) as Record<string, unknown>;
  const uri = given(r["uri"]);
  const mime = given(r["mimeType"])?.toLowerCase();
  const blob = r["blob"];
  if (typeof r["text"] === "string") note(texts.render("mcp_resource", { uri, text: r["text"] }));
  else if (typeof blob !== "string" || blob === "") note(texts.render("mcp_resource_empty", { uri }));
  else if (mime !== undefined && IMAGE_MIME.has(mime)) media.push({ mime_type: mime, data: blob, label: `${uri === undefined ? "" : `${uri} `}(${mime}, ${describeSize(blob)})` });
  else note(texts.render("mcp_resource_binary", { uri, type: mime, size: describeSize(blob) }));
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
