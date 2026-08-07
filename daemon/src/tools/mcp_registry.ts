/**
 * Live MCP connections and the dynamic tool surface they contribute.
 *
 * Ported from `crates/daemon/src/tools/mcp_registry.rs`, pinned by
 * `tests/tools_fixtures/mcp_parity.json`.
 *
 * Each `[mcp.<name>]` config entry is connected at startup (and on hot-reload),
 * all of them concurrently, with a bounded retry for HTTP servers only — see
 * {@link connectWithRetry} for why the two transports are treated differently.
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
import type { McpClient, McpServerSpec, Transport } from "../mcp/client.ts";

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

// ── Connecting ──────────────────────────────────────────────────────────

/** Injected so tests do not spend real time asleep. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff between HTTP connect attempts: six tries over ~7.7s.
 *
 * Sized for the case it exists to absorb — a compose stack starting shore
 * alongside its MCP servers, where `depends_on` waits for the *container* to
 * start rather than for the process inside it to bind. That window is seconds,
 * so the schedule front-loads short retries and gives up well before a human
 * would wonder whether the daemon had hung.
 *
 * Not configurable on purpose. A knob here would be one more thing to get
 * wrong per deployment, and nothing about the failure it covers varies by
 * install.
 */
const HTTP_CONNECT_RETRY_DELAYS_MS: readonly number[] = [200, 500, 1000, 2000, 4000];

/**
 * Connect `spec`, retrying the HTTP transport and only the HTTP transport.
 *
 * The distinction is the whole point (#37). A stdio server is a child process
 * shore spawns itself: if it fails to start it will keep failing to start, and
 * retrying just respawns a broken process on a loop. An HTTP server is a
 * network peer with an independent lifecycle, where "not listening yet" is the
 * overwhelmingly common transient and resolves on its own within seconds.
 *
 * Every HTTP connect error is retried rather than only the connection-refused
 * shaped ones. Classifying failures across the SDK's transport and the fetch
 * stack underneath it is guesswork that rots, and the cost of being wrong is
 * asymmetric: retrying a genuinely bad URL wastes the backoff window once at
 * startup, while *not* retrying a slow server costs the session its cache
 * prefix.
 */
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
      // Returned rather than thrown so the attempt count travels with the
      // failure: the log is the whole point here, and a caller recomputing
      // "how many tries did that get" from the transport would be a second
      // copy of the retry policy waiting to disagree with this one.
      if (delay === undefined) return { ok: false, attempts, error: String(e) };
      await sleep(delay);
    }
  }
}

/** What became of one `[mcp.<name>]` entry. Reported, never thrown. */
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

/**
 * Bring up one server, resolving to an outcome instead of rejecting.
 *
 * Never rejecting is what lets the servers run concurrently without one bad
 * entry deciding the fate of the batch: `Promise.all` over rejecting tasks
 * would abandon the others' results while their connects stayed in flight,
 * leaking transports nothing holds a reference to.
 */
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
      // Namespace on the config key, which the registry owns, rather than the
      // server-reported name — the two match today, but keying both the full
      // name and the dispatch lookup on the config key keeps them
      // authoritative here.
      full_name: `mcp__${name}__${tool.name}`,
      description: tool.description,
      input_schema: tool.input_schema,
      server: name,
      tool: tool.name,
    }));
    return { kind: "connected", name, client, tools, attempts };
  } catch (e) {
    await client.shutdown();
    return { kind: "list-failed", name, error: String(e) };
  }
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

  /**
   * How many servers are actually connected.
   *
   * Not the tool count: a server can legitimately offer none, and the question
   * a reload asks is whether anything answered at all (#28).
   */
  connectedServers(): number {
    return this.clients.size;
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
   *
   * HTTP servers get a bounded retry before they are given up on; stdio
   * servers get one attempt, as before. See {@link connectWithRetry} for why
   * the two differ, and why exhausting the retries is worth an `error` rather
   * than a `warn`.
   */
  static async fromConfig(
    mcp: Record<string, McpServerConfigView>,
    pluginsDir: string,
    connect: (spec: McpServerSpec) => Promise<McpClient>,
    sleep: Sleep = realSleep,
  ): Promise<McpRegistry> {
    // Config order is irrelevant to the outcome — the list is sorted at the
    // end — but work through it sorted anyway so the logs read the same each
    // run.
    const names = Object.keys(mcp).sort(compareByCodePoint);

    // Concurrent, and that is a requirement rather than a speed-up. Awaiting
    // each server in turn would make N unavailable HTTP servers cost N x the
    // whole backoff window before the daemon finished starting (#37).
    //
    // Determinism survives it because nothing is decided here: the outcomes
    // are collected and then folded in sorted order below, so the client map,
    // the tool list and the log lines all come out exactly as the serial
    // version produced them, whatever order the connects actually finish in.
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
          console.warn(`mcp server has no valid transport; skipping: ${outcome.name}`);
          break;
        case "connect-failed":
          // Loud, and deliberately not `warn`, for both transports. The
          // visible symptom of a server that failed to come up is nothing at
          // all — the daemon runs on with a smaller tool surface, and the
          // model works around a tool it never knew it was missing, which
          // reads as the character being unhelpful. The invisible symptom is
          // the expensive one: the tool surface is part of the cached prefix,
          // so a server that is absent at startup and cannot come back
          // without a restart turns every character's warm cache into a full
          // write for the rest of the session.
          console.error(
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
          console.warn(`mcp tools/list failed; skipping: ${outcome.name}: ${outcome.error}`);
          break;
        case "connected":
          if (outcome.attempts > 1) {
            console.info(
              `shore: mcp server '${outcome.name}' connected on attempt ${outcome.attempts}`,
            );
          }
          tools.push(...outcome.tools);
          clients.set(outcome.name, outcome.client);
          break;
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
