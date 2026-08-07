/**
 * Live MCP connections and the dynamic tool surface they contribute.
 *
 * Ported from `crates/daemon/src/tools/mcp_registry.rs`, pinned by
 * `tests/tools_fixtures/mcp_parity.json`.
 *
 * Each `[mcp.<name>]` config entry is connected at startup (and on hot-reload).
 * The tools discovered from every server are flattened into one list,
 * namespaced `mcp__<server>__<tool>`, sorted by that full name, and **pinned
 * for the registry's lifetime**. Pinning is what keeps the outbound tool
 * surface — and therefore the Anthropic cache prefix — stable across turns: a
 * server is listed once at connect, never re-listed mid-session.
 */

import { toolPatternMatches } from "./registry.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { compareByCodePoint } from "../sort.ts";
import type { ToolDefinition } from "../llm/types.ts";
import type { McpClient, McpServerSpec } from "../mcp/client.ts";

/** One discovered MCP tool. Owned, because names and schemas are runtime facts. */
export interface McpToolDef {
  /** Namespaced name offered to the model: `mcp__<server>__<tool>`. */
  full_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** The `[mcp.<name>]` key this tool came from. */
  server: string;
  /** The bare server-side tool name, used for the actual `tools/call`. */
  tool: string;
}

/** The `[mcp.<name>]` fields this module reads. */
export interface McpServerConfigView {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

/** Render to the provider-neutral tool shape. */
export function toToolDef(def: McpToolDef): ToolDefinition {
  return {
    name: def.full_name,
    description: def.description,
    input_schema: def.input_schema,
  };
}

// ── Path resolution ─────────────────────────────────────────────────────

/**
 * Resolve `raw` against `base`, leaving absolute paths untouched.
 *
 * **Not `path.join`.** `path.join` normalizes, so it collapses
 * `plugins/../sibling` to `sibling`; Rust's `PathBuf::push` does not, and the
 * difference decides which directory a server is launched in. `..` and
 * symlinks are left for the OS to resolve, exactly as the Rust leaves them.
 *
 * Bare `.` components are dropped so a `./`-prefixed entry does not produce a
 * `<base>/./x` path in logs. That matches Rust's `Components`, which also
 * collapses empty segments — so `a//b` becomes `a/b` — while keeping `..`.
 */
export function resolveUnder(raw: string, base: string): string {
  if (raw.startsWith("/")) return raw;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return base;
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}${parts.join("/")}`;
}

/**
 * Resolve a configured `command`.
 *
 * A bare name with no separator stays a `PATH` lookup; anything path-shaped
 * resolves against `base`. Resolving it here is required, not cosmetic:
 * spawning with a `cwd` does *not* define whether a relative program path
 * resolves against the parent's directory or the child's.
 */
export function resolveCommand(command: string, base: string): string {
  if (!command.includes("/")) return command;
  return resolveUnder(command, base);
}

/**
 * Convert a config entry into a connection spec.
 *
 * `command` wins when both it and `url` are set — config validation rejects
 * that combination, so this only decides what a hand-built config does.
 * Returns `undefined` when neither is set.
 */
export function toSpec(
  name: string,
  cfg: McpServerConfigView,
  pluginsDir: string,
): McpServerSpec | undefined {
  if (cfg.command !== undefined) {
    const cwd = cfg.cwd === undefined ? undefined : resolveUnder(cfg.cwd, pluginsDir);
    // A relative command resolves against the *resolved* cwd, falling back to
    // the plugins directory when no cwd is configured.
    const commandBase = cwd ?? pluginsDir;
    return {
      name,
      transport: {
        kind: "stdio",
        command: resolveCommand(cfg.command, commandBase),
        args: cfg.args ?? [],
        env: cfg.env ?? {},
        // Spread rather than assign: under `exactOptionalPropertyTypes` an
        // absent `cwd` and a `cwd` explicitly set to `undefined` are different
        // types, and only the former means "inherit the daemon's directory".
        ...(cwd === undefined ? {} : { cwd }),
      },
    };
  }
  if (cfg.url !== undefined) {
    return { name, transport: { kind: "http", url: cfg.url } };
  }
  return undefined;
}

// ── The registry ────────────────────────────────────────────────────────

/** Live MCP connections plus the pinned, sorted tool surface they expose. */
export class McpRegistry {
  private readonly clients: Map<string, McpClient>;
  /** Sorted by `full_name`; pinned for the registry's lifetime. */
  private readonly tools: McpToolDef[];
  /** The `[mcp.*]` config this was built from, for the hot-reload check. */
  private readonly source: Record<string, McpServerConfigView>;

  private constructor(
    clients: Map<string, McpClient>,
    tools: McpToolDef[],
    source: Record<string, McpServerConfigView>,
  ) {
    this.clients = clients;
    this.tools = [...tools].sort((a, b) => compareByCodePoint(a.full_name, b.full_name));
    this.source = source;
  }

  /** An empty registry — no servers configured, or none reachable. */
  static empty(): McpRegistry {
    return new McpRegistry(new Map(), [], {});
  }

  /** Build from an already-discovered tool list. Sorts on the way in. */
  static fromTools(
    tools: McpToolDef[],
    clients: Map<string, McpClient> = new Map(),
    source: Record<string, McpServerConfigView> = {},
  ): McpRegistry {
    return new McpRegistry(clients, tools, source);
  }

  /**
   * Connect every configured server and discover its tools.
   *
   * A server that fails to connect or list is logged and skipped — a bad
   * server never takes the daemon down, and the surface it would have
   * contributed is simply absent. A server that connects but fails `tools/list`
   * is shut down rather than left running with no tools.
   */
  static async fromConfig(
    mcp: Record<string, McpServerConfigView>,
    pluginsDir: string,
    connect: (spec: McpServerSpec) => Promise<McpClient>,
  ): Promise<McpRegistry> {
    const clients = new Map<string, McpClient>();
    const tools: McpToolDef[] = [];

    // Config order is irrelevant to the outcome — the list is sorted at the
    // end — but iterate sorted anyway so the logs read the same each run.
    for (const name of Object.keys(mcp).sort(compareByCodePoint)) {
      const cfg = mcp[name] as McpServerConfigView;
      const spec = toSpec(name, cfg, pluginsDir);
      if (spec === undefined) {
        console.warn(`mcp server has no valid transport; skipping: ${name}`);
        continue;
      }
      let client: McpClient;
      try {
        client = await connect(spec);
      } catch (e) {
        console.warn(`mcp server connect failed; skipping: ${name}: ${String(e)}`);
        continue;
      }
      try {
        for (const tool of await client.listTools()) {
          // Namespace on the config key, which the registry owns, rather than
          // the server-reported name — the two match today, but keying both
          // the full name and the dispatch lookup on the config key keeps them
          // authoritative here.
          tools.push({
            full_name: `mcp__${name}__${tool.name}`,
            description: tool.description,
            input_schema: tool.input_schema,
            server: name,
            tool: tool.name,
          });
        }
        clients.set(name, client);
      } catch (e) {
        console.warn(`mcp tools/list failed; skipping: ${name}: ${String(e)}`);
        await client.shutdown();
      }
    }

    if (tools.length > 0) {
      console.info(`connected MCP tools: ${tools.length}`);
    }
    return new McpRegistry(clients, tools, mcp);
  }

  /** Every tool, in pinned order. */
  allTools(): readonly McpToolDef[] {
    return this.tools;
  }

  /**
   * Whether this registry was built from `mcp`, letting hot-reload skip a
   * needless reconnect when the `[mcp.*]` section is unchanged.
   */
  matchesConfig(mcp: Record<string, McpServerConfigView>): boolean {
    return JSON.stringify(normalizeSource(this.source)) === JSON.stringify(normalizeSource(mcp));
  }

  /**
   * Tool defs whose full name matches any allowlist pattern, in pinned order.
   *
   * Filtering, never reordering: a config listing its patterns in a different
   * order offers the same surface in the same sequence. Overlapping patterns
   * offer a tool once, because the filter runs over the tools rather than over
   * the patterns.
   */
  toolDefsFiltered(patterns: readonly string[]): ToolDefinition[] {
    return this.namesMatching(patterns).map(toToolDef);
  }

  /**
   * Tools whose full name matches any pattern. Used to expand a sub-agent's
   * `tools = ["mcp__hue__*"]` grant against the live surface.
   */
  namesMatching(patterns: readonly string[]): McpToolDef[] {
    return this.tools.filter((t) => patterns.some((p) => toolPatternMatches(p, t.full_name)));
  }

  /**
   * Invoke `fullName` with `args`.
   *
   * The server and tool are resolved through the *pinned list*, not by
   * splitting the name on `__`. That is what makes `mcp__multi__part__tool__name`
   * route correctly: both the config key and the server-side tool name may
   * contain `__`, so the name is not parseable, only lookup-able.
   */
  async call(fullName: string, args: unknown): Promise<unknown> {
    const def = this.tools.find((t) => t.full_name === fullName);
    if (def === undefined) throw new InvalidArgs(`${fullName}: not yet implemented`);
    const client = this.clients.get(def.server);
    if (client === undefined) throw new InvalidArgs(`${fullName}: not yet implemented`);
    return await client.call(def.tool, args);
  }

  /** Shut down every connection, draining stdio child processes. */
  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
  }
}

/**
 * Config comparison ignores the difference between an absent optional and an
 * explicitly empty one, which is what the Rust's `BTreeMap` equality did after
 * serde applied its defaults.
 */
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
    };
  }
  return out;
}

export { InvalidArgs, ToolIoError };
