import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { invalidRequest, notFound } from "./errors.ts";

export const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_PER_OWNER = 4;
const SWEEP_MS = 60_000;

export interface SpoolEntry {
  readonly id: string;
  readonly owner: number;
  readonly directory: string;
  readonly file: string;
}

interface Transfer extends SpoolEntry {
  readonly direction: "download" | "upload";
  bytes: number;
  touched: number;
}

export class ArchiveSpool {
  readonly #transfers = new Map<string, Transfer>();
  #root: Promise<string> | undefined;
  #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly directory: string,
    readonly alive: (owner: number) => boolean,
    readonly chunkBytes = TRANSFER_CHUNK_BYTES,
    readonly idleMs = 15 * 60_000,
  ) {}

  async reserve(owner: number): Promise<SpoolEntry> {
    if ([...this.#transfers.values()].filter((transfer) => transfer.owner === owner).length >= MAX_PER_OWNER) {
      throw invalidRequest(`A connection may hold at most ${String(MAX_PER_OWNER)} archive transfers; finish one or reconnect`);
    }
    this.#root ??= rm(this.directory, { recursive: true, force: true })
      .then(async () => { await mkdir(this.directory, { recursive: true, mode: 0o700 }); return this.directory; });
    const id = crypto.randomUUID();
    const directory = join(await this.#root, id);
    await mkdir(directory, { mode: 0o700 });
    return { id, owner, directory, file: join(directory, "archive.tar") };
  }

  publish(entry: SpoolEntry, direction: Transfer["direction"], bytes: number): void {
    this.#transfers.set(entry.id, { ...entry, direction, bytes, touched: Date.now() });
    if (this.#sweeper !== undefined) return;
    this.#sweeper = setInterval(() => { void this.sweep(); }, SWEEP_MS);
    this.#sweeper.unref();
  }

  async read(owner: number, id: string, offset: number): Promise<{ data: string; offset: number; bytes: number }> {
    const transfer = this.#owned(owner, id, "download");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= transfer.bytes) {
      throw invalidRequest(`Offset ${String(offset)} is outside the ${String(transfer.bytes)}-byte archive`);
    }
    const chunk = Buffer.alloc(Math.min(this.chunkBytes, transfer.bytes - offset));
    const file = await open(transfer.file, "r");
    try {
      for (let filled = 0; filled < chunk.length;) {
        const { bytesRead } = await file.read(chunk, filled, chunk.length - filled, offset + filled);
        if (bytesRead === 0) throw new Error("Archive ended before its recorded size");
        filled += bytesRead;
      }
    } finally { await file.close(); }
    if (offset + chunk.length === transfer.bytes) await this.discard(transfer);
    return { data: chunk.toString("base64"), offset, bytes: transfer.bytes };
  }

  async append(owner: number, id: string | undefined, data: string): Promise<{ transfer: string; bytes: number }> {
    const chunk = Buffer.from(data, "base64");
    if (chunk.length === 0 || chunk.length > this.chunkBytes || chunk.toString("base64") !== data) {
      throw invalidRequest(`An archive chunk must be 1 to ${String(this.chunkBytes)} bytes of padded base64`);
    }
    let transfer: Transfer;
    if (id === undefined) {
      const entry = await this.reserve(owner);
      this.publish(entry, "upload", 0);
      transfer = this.#owned(owner, entry.id, "upload");
    } else transfer = this.#owned(owner, id, "upload");
    const file = await open(transfer.file, "a", 0o600);
    try { await file.writeFile(chunk); } finally { await file.close(); }
    transfer.bytes += chunk.length;
    return { transfer: transfer.id, bytes: transfer.bytes };
  }

  claim(owner: number, id: string): SpoolEntry {
    const transfer = this.#owned(owner, id, "upload");
    this.#transfers.delete(id);
    this.#idle();
    return transfer;
  }

  async discard(entry: SpoolEntry): Promise<void> {
    this.#transfers.delete(entry.id);
    this.#idle();
    await rm(entry.directory, { recursive: true, force: true });
  }

  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.idleMs;
    const stale = [...this.#transfers.values()].filter((transfer) => transfer.touched < cutoff || !this.alive(transfer.owner));
    await Promise.all(stale.map(async (transfer) => { await this.discard(transfer); }));
  }

  #owned(owner: number, id: string, direction: Transfer["direction"]): Transfer {
    const transfer = this.#transfers.get(id);
    if (transfer?.owner !== owner || transfer.direction !== direction) throw notFound(`No ${direction} transfer ${id} on this connection`);
    transfer.touched = Date.now();
    return transfer;
  }

  #idle(): void {
    if (this.#transfers.size > 0 || this.#sweeper === undefined) return;
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }
}
