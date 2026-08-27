import { shoreLog } from "../log.ts";

import { toolPatternMatches } from "./registry.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { compareByCodePoint } from "../util/sort.ts";
import type { ToolDefinition } from "../llm/types.ts";
import { McpTransportError } from "../mcp/client.ts";
import type { McpClient, McpServerSpec, Transport } from "../mcp/client.ts";
import { compileToolSchema } from "./validate.ts";

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
export type RecoveryWait = (ms: number, signal: AbortSignal) => Promise<void>;

export type McpServerState = "connected" | "unavailable" | "retrying" | "invalid";

export interface McpServerStatus {
  name: string;
  transport: Transport["kind"] | null;
  state: McpServerState;
  connected_tools: number;
  last_error: string | null;
  next_retry_at: number | null;
}

export interface McpRegistryOptions {
  recoveryWait?: RecoveryWait | undefined;
  random?: (() => number) | undefined;
  now?: (() => number) | undefined;
  onToolsChanged?:
    | ((registry: McpRegistry, server: string) => Promise<void> | void)
    | undefined;
}

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const realRecoveryWait: RecoveryWait = (ms, signal) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

const HTTP_CONNECT_RETRY_DELAYS_MS: readonly number[] = [200, 500, 1000, 2000, 4000];
const MCP_RECOVERY_BASE_MS = 1000;
const MCP_RECOVERY_MAX_MS = 60_000;
const MCP_RECOVERY_JITTER = 0.2;

export function mcpRecoveryDelayMs(failures: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, failures), 16);
  const uncapped = MCP_RECOVERY_BASE_MS * 2 ** exponent;
  const base = Math.min(MCP_RECOVERY_MAX_MS, uncapped);
  const jitter = 1 - MCP_RECOVERY_JITTER + random() * MCP_RECOVERY_JITTER * 2;
  return Math.min(MCP_RECOVERY_MAX_MS, Math.max(1, Math.round(base * jitter)));
}

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
  | { kind: "list-failed"; name: string; transport: Transport["kind"]; error: string }
  | { kind: "connected"; name: string; client: McpClient; tools: McpToolDef[]; attempts: number };

function listedTools(
  name: string,
  tools: Awaited<ReturnType<McpClient["listTools"]>>,
): McpToolDef[] {
  return acceptedTools(
    tools.map((tool) => ({
      full_name: `mcp__${name}__${tool.name}`,
      description: tool.description,
      input_schema: tool.input_schema,
      server: name,
      tool: tool.name,
      repeatable: tool.repeatable,
    })),
  );
}

function acceptedTools(tools: readonly McpToolDef[]): McpToolDef[] {
  const accepted: McpToolDef[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.full_name)) {
      shoreLog.warn(`shore: rejecting duplicate MCP tool ${tool.full_name}`);
      continue;
    }
    try {
      compileToolSchema(tool.full_name, tool.input_schema);
      names.add(tool.full_name);
      accepted.push(tool);
    } catch (error) {
      shoreLog.warn(`shore: rejecting ${tool.full_name}: ${String(error)}`);
    }
  }
  return accepted;
}

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
    const tools = listedTools(name, await client.listTools());
    return { kind: "connected", name, client, tools, attempts };
  } catch (e) {
    try {
      await client.shutdown();
    } catch (shutdownError) {
      shoreLog.warn(
        `shore: shutting down mcp client '${name}' after tools/list failed: ` +
          String(shutdownError),
      );
    }
    return { kind: "list-failed", name, transport: spec.transport.kind, error: String(e) };
  }
}

interface RecoveryDeps {
  connect: (spec: McpServerSpec) => Promise<McpClient>;
  specs: Map<string, McpServerSpec>;
  wait: RecoveryWait;
  random: () => number;
  now: () => number;
  onToolsChanged?: (registry: McpRegistry, server: string) => Promise<void> | void;
}

interface ServerLifecycle {
  name: string;
  spec: McpServerSpec | undefined;
  state: McpServerState;
  client: McpClient | undefined;
  tools: McpToolDef[];
  lastError: string | undefined;
  nextRetryAt: number | undefined;
}

interface ToolSurface {
  clients: ReadonlyMap<string, McpClient>;
  tools: readonly McpToolDef[];
}

export class McpRegistry {
  private surface: ToolSurface;
  private readonly source: Record<string, McpServerConfigView>;
  private readonly servers: Map<string, ServerLifecycle>;
  private readonly recovery: RecoveryDeps | undefined;
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly connecting = new Map<string, Promise<McpClient | undefined>>();
  private readonly stopRecovery = new AbortController();
  private closed = false;
  private shutdownTask: Promise<void> | undefined;

  private constructor(
    clients: Map<string, McpClient>,
    tools: McpToolDef[],
    source: Record<string, McpServerConfigView>,
    servers: Map<string, ServerLifecycle> = new Map(),
    recovery?: RecoveryDeps,
  ) {
    this.surface = {
      clients,
      tools: [...tools].sort((a, b) => compareByCodePoint(a.full_name, b.full_name)),
    };
    this.source = source;
    this.servers = servers;
    this.recovery = recovery;
  }

  connectedServers(): number {
    return this.surface.clients.size;
  }

  static empty(): McpRegistry {
    return new McpRegistry(new Map(), [], {});
  }

  static fromTools(
    tools: McpToolDef[],
    clients: Map<string, McpClient> = new Map(),
    source: Record<string, McpServerConfigView> = {},
  ): McpRegistry {
    const registeredTools = acceptedTools(tools);
    const servers = new Map<string, ServerLifecycle>();
    const names = new Set([
      ...Object.keys(source),
      ...clients.keys(),
      ...registeredTools.map((tool) => tool.server),
    ]);
    for (const name of names) {
      const client = clients.get(name);
      servers.set(name, {
        name,
        spec: undefined,
        state: client === undefined ? "unavailable" : "connected",
        client,
        tools: registeredTools.filter((tool) => tool.server === name),
        lastError: undefined,
        nextRetryAt: undefined,
      });
    }
    return new McpRegistry(clients, registeredTools, source, servers);
  }

  static async fromConfig(
    mcp: Record<string, McpServerConfigView>,
    pluginsDir: string,
    connect: (spec: McpServerSpec) => Promise<McpClient>,
    sleep: Sleep = realSleep,
    options: McpRegistryOptions = {},
  ): Promise<McpRegistry> {
    const names = Object.keys(mcp).sort(compareByCodePoint);

    const outcomes = await Promise.all(
      names.map((name) =>
        connectOne(name, mcp[name] as McpServerConfigView, pluginsDir, connect, sleep),
      ),
    );

    const clients = new Map<string, McpClient>();
    const tools: McpToolDef[] = [];
    const servers = new Map<string, ServerLifecycle>();
    const specs = new Map<string, McpServerSpec>();
    for (const name of names) {
      const spec = toSpec(name, mcp[name] as McpServerConfigView, pluginsDir);
      if (spec !== undefined) specs.set(name, spec);
    }
    for (const outcome of outcomes) {
      const spec = specs.get(outcome.name);
      switch (outcome.kind) {
        case "no-transport":
          shoreLog.warn(`mcp server has no valid transport; skipping: ${outcome.name}`);
          servers.set(outcome.name, {
            name: outcome.name,
            spec: undefined,
            state: "invalid",
            client: undefined,
            tools: [],
            lastError: "no valid transport",
            nextRetryAt: undefined,
          });
          break;
        case "connect-failed":
          shoreLog.error(
            `shore: mcp server '${outcome.name}' ` +
              (outcome.transport === "http"
                ? `unreachable after ${outcome.attempts} attempts`
                : "failed to start") +
              `; running without its tools and retrying in the background: ${outcome.error}`,
          );
          servers.set(outcome.name, {
            name: outcome.name,
            spec,
            state: "unavailable",
            client: undefined,
            tools: [],
            lastError: outcome.error,
            nextRetryAt: undefined,
          });
          break;
        case "list-failed":
          shoreLog.warn(
            `shore: mcp tools/list failed for '${outcome.name}'; ` +
              `retrying in the background: ${outcome.error}`,
          );
          servers.set(outcome.name, {
            name: outcome.name,
            spec,
            state: "unavailable",
            client: undefined,
            tools: [],
            lastError: outcome.error,
            nextRetryAt: undefined,
          });
          break;
        case "connected":
          if (outcome.attempts > 1) {
            shoreLog.info(
              `shore: mcp server '${outcome.name}' connected on attempt ${outcome.attempts}`,
            );
          }
          tools.push(...outcome.tools);
          clients.set(outcome.name, outcome.client);
          servers.set(outcome.name, {
            name: outcome.name,
            spec,
            state: "connected",
            client: outcome.client,
            tools: [...outcome.tools].sort((a, b) =>
              compareByCodePoint(a.full_name, b.full_name),
            ),
            lastError: undefined,
            nextRetryAt: undefined,
          });
          break;
      }
    }

    if (tools.length > 0) {
      shoreLog.info(`connected MCP tools: ${tools.length}`);
    }
    const registry = new McpRegistry(clients, tools, mcp, servers, {
      connect,
      specs,
      wait: options.recoveryWait ?? realRecoveryWait,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      ...(options.onToolsChanged === undefined
        ? {}
        : { onToolsChanged: options.onToolsChanged }),
    });
    for (const entry of servers.values()) {
      if (entry.state === "unavailable") registry.startRecovery(entry.name);
    }
    return registry;
  }

  allTools(): readonly McpToolDef[] {
    return this.surface.tools;
  }

  serverStatus(): McpServerStatus[] {
    return [...this.servers.values()]
      .sort((a, b) => compareByCodePoint(a.name, b.name))
      .map((entry) => ({
        name: entry.name,
        transport: entry.spec?.transport.kind ?? null,
        state: entry.state,
        connected_tools: entry.state === "connected" ? entry.tools.length : 0,
        last_error: entry.lastError ?? null,
        next_retry_at: entry.nextRetryAt ?? null,
      }));
  }

  matchesConfig(mcp: Record<string, McpServerConfigView>): boolean {
    return JSON.stringify(normalizeSource(this.source)) === JSON.stringify(normalizeSource(mcp));
  }

  toolDefsFiltered(patterns: readonly string[]): ToolDefinition[] {
    return this.namesMatching(patterns).map(toToolDef);
  }

  namesMatching(patterns: readonly string[]): McpToolDef[] {
    return this.surface.tools.filter((t) => patterns.some((p) => toolPatternMatches(p, t.full_name)));
  }

  async call(fullName: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const surface = this.surface;
    const def = surface.tools.find((t) => t.full_name === fullName);
    if (def === undefined) throw new InvalidArgs(`${fullName}: not yet implemented`);
    const client = surface.clients.get(def.server);
    if (client === undefined) {
      await this.reviveClient(def.server);
      throw new McpTransportError(`MCP server '${def.server}' is unavailable`);
    }
    try {
      return await client.call(def.tool, args, signal, def.repeatable);
    } catch (e) {
      if (!(e instanceof McpTransportError)) throw e;
      this.markUnavailable(def.server, String(e));
      await this.reviveClient(def.server);
      throw e;
    }
  }

  private async reviveClient(server: string): Promise<McpClient | undefined> {
    const spec = this.recovery?.specs.get(server);
    if (this.recovery === undefined || spec === undefined) return undefined;
    if (this.closed) return undefined;
    if (spec.transport.kind !== "http") {
      this.startRecovery(server);
      return undefined;
    }
    const next = await this.attemptConnection(server, false);
    if (next === undefined) this.startRecovery(server);
    return next;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownTask === undefined) this.shutdownTask = this.performShutdown();
    await this.shutdownTask;
  }

  private startRecovery(server: string): void {
    if (this.closed || this.recovering.has(server)) return;
    const entry = this.servers.get(server);
    if (entry?.spec === undefined || entry.state === "invalid") return;
    const task = this.trackRecovery(server);
    this.recovering.set(server, task);
  }

  private async trackRecovery(server: string): Promise<void> {
    try {
      await this.recover(server);
    } finally {
      this.recovering.delete(server);
    }
  }

  private async recover(server: string): Promise<void> {
    const entry = this.servers.get(server);
    const recovery = this.recovery;
    if (entry === undefined || recovery === undefined) return;
    let failures = 0;
    for (;;) {
      if (this.closed || entry.state === "connected") return;
      const delay = mcpRecoveryDelayMs(failures, recovery.random);
      entry.nextRetryAt = recovery.now() + delay;
      shoreLog.warn(
        `shore: mcp server '${server}' unavailable; retrying in ${delay}ms: ` +
          (entry.lastError ?? "unknown error"),
      );
      try {
        await recovery.wait(delay, this.stopRecovery.signal);
      } catch (e) {
        if (this.closed || this.stopRecovery.signal.aborted) return;
        this.recordFailure(entry, `recovery wait failed: ${String(e)}`);
        failures += 1;
        continue;
      }
      if (
        this.closed ||
        this.stopRecovery.signal.aborted ||
        this.servers.get(server)?.state === "connected"
      ) {
        return;
      }
      entry.state = "retrying";
      entry.nextRetryAt = undefined;
      const next = await this.attemptConnection(server, true);
      if (next !== undefined) return;
      failures += 1;
    }
  }

  private async attemptConnection(
    server: string,
    refreshTools: boolean,
  ): Promise<McpClient | undefined> {
    const inFlight = this.connecting.get(server);
    if (inFlight !== undefined) return await inFlight;
    const attempt = this.trackConnectionAttempt(server, refreshTools);
    this.connecting.set(server, attempt);
    return await attempt;
  }

  private async trackConnectionAttempt(
    server: string,
    refreshTools: boolean,
  ): Promise<McpClient | undefined> {
    try {
      return await this.connectServer(server, refreshTools);
    } finally {
      this.connecting.delete(server);
    }
  }

  private async connectServer(
    server: string,
    refreshTools: boolean,
  ): Promise<McpClient | undefined> {
    const entry = this.servers.get(server);
    const spec = entry?.spec;
    const recovery = this.recovery;
    if (entry === undefined || spec === undefined || recovery === undefined || this.closed) {
      return undefined;
    }

    let next: McpClient;
    try {
      next = await recovery.connect(spec);
    } catch (e) {
      this.recordFailure(entry, String(e));
      return undefined;
    }
    if (this.closed) {
      await this.shutdownClient(next, server);
      return undefined;
    }

    let tools = entry.tools;
    if (refreshTools) {
      try {
        tools = listedTools(server, await next.listTools());
      } catch (e) {
        await this.shutdownClient(next, server);
        this.recordFailure(entry, String(e));
        return undefined;
      }
    }
    if (this.closed) {
      await this.shutdownClient(next, server);
      return undefined;
    }
    await this.adoptClient(entry, next, tools);
    return next;
  }

  private recordFailure(entry: ServerLifecycle, error: string): void {
    entry.state = "unavailable";
    entry.lastError = error;
    entry.nextRetryAt = undefined;
    shoreLog.warn(`shore: mcp server '${entry.name}' is still unavailable: ${error}`);
  }

  private async shutdownClient(client: McpClient, server: string): Promise<void> {
    try {
      await client.shutdown();
    } catch (e) {
      shoreLog.warn(`shore: shutting down mcp client '${server}' failed: ${String(e)}`);
    }
  }

  private markUnavailable(server: string, error: string): void {
    const entry = this.servers.get(server);
    if (entry === undefined) return;
    this.recordFailure(entry, error);
    const clients = new Map(this.surface.clients);
    clients.delete(server);
    this.surface = { clients, tools: this.surface.tools };
  }

  private async adoptClient(
    entry: ServerLifecycle,
    next: McpClient,
    tools: McpToolDef[],
  ): Promise<void> {
    const orderedTools = [...tools].sort((a, b) => compareByCodePoint(a.full_name, b.full_name));
    const surfaceChanged = JSON.stringify(entry.tools) !== JSON.stringify(orderedTools);
    const previous = entry.client;
    const clients = new Map([...this.surface.clients, [entry.name, next] as const]);
    const nextTools = this.surface.tools
      .filter((tool) => tool.server !== entry.name)
      .concat(orderedTools)
      .sort((a, b) => compareByCodePoint(a.full_name, b.full_name));

    entry.client = next;
    entry.tools = orderedTools;
    entry.state = "connected";
    entry.lastError = undefined;
    entry.nextRetryAt = undefined;
    this.surface = { clients, tools: nextTools };

    if (previous !== undefined && previous !== next) {
      try {
        await previous.shutdown();
      } catch (e) {
        shoreLog.warn(`shore: shutting down old mcp client '${entry.name}' failed: ${String(e)}`);
      }
    }

    shoreLog.info(
      surfaceChanged
        ? `shore: mcp server '${entry.name}' recovered with ${orderedTools.length} tool(s); ` +
            `the tool surface was updated`
        : `shore: mcp server '${entry.name}' reconnected; its tool surface is unchanged`,
    );
    if (surfaceChanged && this.recovery?.onToolsChanged !== undefined) {
      try {
        await this.recovery.onToolsChanged(this, entry.name);
      } catch (e) {
        shoreLog.warn(
          `shore: mcp server '${entry.name}' recovered, but cache refresh failed: ${String(e)}`,
        );
      }
    }
  }

  private async performShutdown(): Promise<void> {
    this.closed = true;
    this.stopRecovery.abort();
    await Promise.allSettled([...this.recovering.values(), ...this.connecting.values()]);
    const clients = new Set<McpClient>();
    for (const client of this.surface.clients.values()) clients.add(client);
    for (const entry of this.servers.values()) {
      if (entry.client !== undefined) clients.add(entry.client);
      entry.nextRetryAt = undefined;
    }
    this.surface = { clients: new Map(), tools: this.surface.tools };
    const outcomes = await Promise.allSettled(
      [...clients].map(async (client) => await client.shutdown()),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        shoreLog.warn(`shore: shutting down an mcp client failed: ${String(outcome.reason)}`);
      }
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
