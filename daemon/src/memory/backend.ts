import { McpClient, McpTransportError, type McpServerSpec } from "../mcp/client.ts";
import { memoryBackendBank, type MemoryBackendConfig } from "../config/app.ts";
import { shoreLog } from "../log.ts";

export interface MemoryBackend {
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface MemoryBackendTarget {
  url: string;
  headers: Record<string, string>;
}

export function memoryBackendTarget(
  backend: MemoryBackendConfig,
  character: string,
): MemoryBackendTarget {
  const base = backend.url.trim();
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  const bank = encodeURIComponent(memoryBackendBank(backend, character));
  return {
    url: new URL(`${bank}/`, withSlash).toString(),
    headers: Object.fromEntries(backend.headers),
  };
}

export function sameTarget(a: MemoryBackendTarget, b: MemoryBackendTarget): boolean {
  return a.url === b.url && JSON.stringify(a.headers) === JSON.stringify(b.headers);
}

export type ConnectMemoryBackend = (spec: McpServerSpec) => Promise<McpClient>;

export class HindsightBackend implements MemoryBackend {
  readonly #character: string;
  readonly #target: MemoryBackendTarget;
  readonly #connect: ConnectMemoryBackend;
  #client: Promise<McpClient> | undefined;
  #closed = false;

  constructor(
    character: string,
    target: MemoryBackendTarget,
    connect: ConnectMemoryBackend = McpClient.connect,
  ) {
    this.#character = character;
    this.#target = target;
    this.#connect = connect;
  }

  get target(): MemoryBackendTarget {
    return this.#target;
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed) throw new McpTransportError("memory backend is shut down");
    const client = await this.#connected();
    try {
      return await client.call(tool, args, signal);
    } catch (e) {
      if (e instanceof McpTransportError) this.#drop(client);
      throw e;
    }
  }

  async #connected(): Promise<McpClient> {
    const pending = this.#client ?? this.#open();
    this.#client = pending;
    try {
      return await pending;
    } catch (e) {
      if (this.#client === pending) this.#client = undefined;
      throw e;
    }
  }

  #open(): Promise<McpClient> {
    return this.#connect({
      name: `memory:${this.#character}`,
      transport: { kind: "http", url: this.#target.url, headers: this.#target.headers },
    });
  }

  #drop(client: McpClient): void {
    this.#client = undefined;
    void client.shutdown().catch((e: unknown) => {
      shoreLog.warn(`shore: memory backend shutdown for '${this.#character}': ${String(e)}`);
    });
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    const pending = this.#client;
    this.#client = undefined;
    if (pending === undefined) return;
    try {
      await (await pending).shutdown();
    } catch (e) {
      shoreLog.warn(`shore: memory backend shutdown for '${this.#character}': ${String(e)}`);
    }
  }
}

export class MemoryBackends {
  readonly #backends = new Map<string, HindsightBackend>();
  readonly #connect: ConnectMemoryBackend;

  constructor(connect: ConnectMemoryBackend = McpClient.connect) {
    this.#connect = connect;
  }

  set(character: string, target: MemoryBackendTarget): void {
    const existing = this.#backends.get(character);
    if (existing !== undefined) {
      if (sameTarget(existing.target, target)) return;
      this.#backends.delete(character);
      void existing.shutdown();
    }
    this.#backends.set(character, new HindsightBackend(character, target, this.#connect));
  }

  remove(character: string): void {
    const existing = this.#backends.get(character);
    if (existing === undefined) return;
    this.#backends.delete(character);
    void existing.shutdown();
  }

  get(character: string): MemoryBackend | undefined {
    return this.#backends.get(character);
  }

  characters(): string[] {
    return [...this.#backends.keys()];
  }

  async shutdown(): Promise<void> {
    const all = [...this.#backends.values()];
    this.#backends.clear();
    await Promise.all(all.map(async (backend) => { await backend.shutdown(); }));
  }
}
