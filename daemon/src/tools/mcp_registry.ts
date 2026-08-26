import { shoreLog } from "../log.ts";

import { toolPatternMatches } from "./registry.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { compareByCodePoint } from "../util/sort.ts";
import type { ToolDefinition } from "../llm/types.ts";
import { McpTransportError } from "../mcp/client.ts";
import type { McpClient, McpServerSpec, Transport } from "../mcp/client.ts";

export interface McpToolDef {
  full_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  server: string;
  tool: string;
  repeatable: boolean;
}

export interface McpServerConfigView {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export function toToolDef(def: McpToolDef): ToolDefinition {
  return {
    name: def.full_name,
    description: def.description,
    input_schema: def.input_schema,
  };
}

export function resolveUnder(raw: string, base: string): string {
  if (raw.startsWith("/")) return raw;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return base;
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}${parts.join("/")}`;
}

export function resolveCommand(command: string, base: string): string {
  if (!command.includes("/")) return command;
  return resolveUnder(command, base);
}

export function toSpec(
  name: string,
  cfg: McpServerConfigView,
  pluginsDir: string,
): McpServerSpec | undefined {
  if (cfg.command !== undefined) {
    const cwd = cfg.cwd === undefined ? undefined : resolveUnder(cfg.cwd, pluginsDir);
    const commandBase = cwd ?? pluginsDir;
    return {
      name,
      transport: {
        kind: "stdio",
        command: resolveCommand(cfg.command, commandBase),
        args: cfg.args ?? [],
        env: cfg.env ?? {},
        ...(cwd === undefined ? {} : { cwd }),
      },
    };
  }
  if (cfg.url !== undefined) {
    return { name, transport: { kind: "http", url: cfg.url, headers: cfg.headers ?? {} } };
  }
  return undefined;
}

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const HTTP_CONNECT_RETRY_DELAYS_MS: readonly number[] = [200, 500, 1000, 2000, 4000];

async function connectWithRetry(
  spec: McpServerSpec,
  connect: (spec: McpServerSpec) => Promise<McpClient>,
  sleep: Sleep,
): Promise<
  { ok: true; client: McpClient; attempts: number } | { ok: false; attempts: number; error: string }
> {
  const delays = spec.transport.kind === "http" ? HTTP_CONNECT_RETRY_DELAYS_MS : [];
  let attempts = 0;
  for (;;) {
    try {
      attempts += 1;
      return { ok: true, client: await connect(spec), attempts };
    } catch (e) {
      const delay = delays[attempts - 1];
      if (delay === undefined) return { ok: false, attempts, error: String(e) };
      await sleep(delay);
    }
  }
}

type ServerOutcome =
  | { kind: "no-transport"; name: string }
  | {
      kind: "connect-failed";
      name: string;
      transport: Transport["kind"];
      attempts: number;
      error: string;
    }
  | { kind: "list-failed"; name: string; error: string }
  | { kind: "connected"; name: string; client: McpClient; tools: McpToolDef[]; attempts: number };

async function connectOne(
  name: string,
  cfg: McpServerConfigView,
  pluginsDir: string,
  connect: (spec: McpServerSpec) => Promise<McpClient>,
  sleep: Sleep,
): Promise<ServerOutcome> {
  const spec = toSpec(name, cfg, pluginsDir);
  if (spec === undefined) return { kind: "no-transport", name };

  const attempt = await connectWithRetry(spec, connect, sleep);
  if (!attempt.ok) {
    return {
      kind: "connect-failed",
      name,
      transport: spec.transport.kind,
      attempts: attempt.attempts,
      error: attempt.error,
    };
  }
  const { client, attempts } = attempt;

  try {
    const tools = (await client.listTools()).map((tool) => ({
      full_name: `mcp__${name}__${tool.name}`,
      description: tool.description,
      input_schema: tool.input_schema,
      server: name,
      tool: tool.name,
      repeatable: tool.repeatable,
    }));
    return { kind: "connected", name, client, tools, attempts };
  } catch (e) {
    await client.shutdown();
    return { kind: "list-failed", name, error: String(e) };
  }
}

interface RevivalDeps {
  connect: (spec: McpServerSpec) => Promise<McpClient>;
  specs: Map<string, McpServerSpec>;
}

export class McpRegistry {
  private readonly clients: Map<string, McpClient>;
  private readonly tools: McpToolDef[];
  private readonly source: Record<string, McpServerConfigView>;
  private readonly revival: RevivalDeps | undefined;
  private readonly reviving = new Map<string, Promise<McpClient | undefined>>();
  private closed = false;

  private constructor(
    clients: Map<string, McpClient>,
    tools: McpToolDef[],
    source: Record<string, McpServerConfigView>,
    revival?: RevivalDeps,
  ) {
    this.clients = clients;
    this.tools = [...tools].sort((a, b) => compareByCodePoint(a.full_name, b.full_name));
    this.source = source;
    this.revival = revival;
  }

  connectedServers(): number {
    return this.clients.size;
  }

  static empty(): McpRegistry {
    return new McpRegistry(new Map(), [], {});
  }

  static fromTools(
    tools: McpToolDef[],
    clients: Map<string, McpClient> = new Map(),
    source: Record<string, McpServerConfigView> = {},
  ): McpRegistry {
    return new McpRegistry(clients, tools, source);
  }

  static async fromConfig(
    mcp: Record<string, McpServerConfigView>,
    pluginsDir: string,
    connect: (spec: McpServerSpec) => Promise<McpClient>,
    sleep: Sleep = realSleep,
  ): Promise<McpRegistry> {
    const names = Object.keys(mcp).sort(compareByCodePoint);

    const outcomes = await Promise.all(
      names.map((name) =>
        connectOne(name, mcp[name] as McpServerConfigView, pluginsDir, connect, sleep),
      ),
    );

    const clients = new Map<string, McpClient>();
    const tools: McpToolDef[] = [];
    for (const outcome of outcomes) {
      switch (outcome.kind) {
        case "no-transport":
          shoreLog.warn(`mcp server has no valid transport; skipping: ${outcome.name}`);
          break;
        case "connect-failed":
          shoreLog.error(
            `shore: mcp server '${outcome.name}' ` +
              (outcome.transport === "http"
                ? `unreachable after ${outcome.attempts} attempts`
                : "failed to start") +
              `; running without its tools. Its tools are part of the prompt cache ` +
              `prefix, so this session will not reuse any cache built with them. It ` +
              `rejoins on a daemon restart, or on an edit to [mcp] — note that ` +
              `touching config.toml is not enough, the [mcp] section itself has to ` +
              `change: ${outcome.error}`,
          );
          break;
        case "list-failed":
          shoreLog.warn(`mcp tools/list failed; skipping: ${outcome.name}: ${outcome.error}`);
          break;
        case "connected":
          if (outcome.attempts > 1) {
            shoreLog.info(
              `shore: mcp server '${outcome.name}' connected on attempt ${outcome.attempts}`,
            );
          }
          tools.push(...outcome.tools);
          clients.set(outcome.name, outcome.client);
          break;
      }
    }

    if (tools.length > 0) {
      shoreLog.info(`connected MCP tools: ${tools.length}`);
    }
    const specs = new Map<string, McpServerSpec>();
    for (const name of names) {
      const spec = toSpec(name, mcp[name] as McpServerConfigView, pluginsDir);
      if (spec !== undefined) specs.set(name, spec);
    }
    return new McpRegistry(clients, tools, mcp, { connect, specs });
  }

  allTools(): readonly McpToolDef[] {
    return this.tools;
  }

  matchesConfig(mcp: Record<string, McpServerConfigView>): boolean {
    return JSON.stringify(normalizeSource(this.source)) === JSON.stringify(normalizeSource(mcp));
  }

  toolDefsFiltered(patterns: readonly string[]): ToolDefinition[] {
    return this.namesMatching(patterns).map(toToolDef);
  }

  namesMatching(patterns: readonly string[]): McpToolDef[] {
    return this.tools.filter((t) => patterns.some((p) => toolPatternMatches(p, t.full_name)));
  }

  async call(fullName: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const def = this.tools.find((t) => t.full_name === fullName);
    if (def === undefined) throw new InvalidArgs(`${fullName}: not yet implemented`);
    const client = this.clients.get(def.server);
    if (client === undefined) throw new InvalidArgs(`${fullName}: not yet implemented`);
    try {
      return await client.call(def.tool, args, signal, def.repeatable);
    } catch (e) {
      if (!(e instanceof McpTransportError)) throw e;
      await this.reviveClient(def.server);
      throw e;
    }
  }

  private async reviveClient(server: string): Promise<McpClient | undefined> {
    const inFlight = this.reviving.get(server);
    if (inFlight !== undefined) return await inFlight;

    const spec = this.revival?.specs.get(server);
    if (this.revival === undefined || spec === undefined) return undefined;
    if (spec.transport.kind !== "http") return undefined;
    if (this.closed) return undefined;

    const connect = this.revival.connect;
    const attempt = (async (): Promise<McpClient | undefined> => {
      let next: McpClient;
      try {
        next = await connect(spec);
      } catch (e) {
        shoreLog.warn(`shore: mcp server '${server}' is still unreachable: ${String(e)}`);
        return undefined;
      }
      if (this.closed) {
        await next.shutdown();
        return undefined;
      }
      const previous = this.clients.get(server);
      this.clients.set(server, next);
      if (previous !== undefined) {
        try {
          await previous.shutdown();
        } catch {
        }
      }
      shoreLog.info(
        `shore: mcp server '${server}' reconnected; its tools work again, ` +
          `and the tool surface did not change so cached prefixes still match`,
      );
      return next;
    })();

    this.reviving.set(server, attempt);
    try {
      return await attempt;
    } finally {
      this.reviving.delete(server);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
  }
}

function normalizeSource(
  mcp: Record<string, McpServerConfigView>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(mcp).sort(compareByCodePoint)) {
    const c = mcp[name] as McpServerConfigView;
    out[name] = {
      command: c.command ?? null,
      args: c.args ?? [],
      env: Object.fromEntries(Object.entries(c.env ?? {}).sort(([a], [b]) => compareByCodePoint(a, b))),
      cwd: c.cwd ?? null,
      url: c.url ?? null,
      headers: Object.fromEntries(
        Object.entries(c.headers ?? {}).sort(([a], [b]) => compareByCodePoint(a, b)),
      ),
    };
  }
  return out;
}

export { InvalidArgs, ToolIoError };
