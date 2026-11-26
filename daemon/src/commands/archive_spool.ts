import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { invalidRequest, notFound } from "./errors.ts";

const MAX_PER_OWNER = 4;
const SWEEP_MS = 60_000;
const READ_BYTES = 1024 * 1024;

export interface SpoolEntry {
  readonly id: string;
  readonly owner: string;
  readonly directory: string;
  readonly file: string;
}

interface Transfer extends SpoolEntry {
  readonly direction: "download" | "upload";
  readonly bytes: number;
  touched: number;
}

export class ArchiveSpool {
  readonly #transfers = new Map<string, Transfer>();
  #root: Promise<string> | undefined;
  #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(readonly directory: string, readonly idleMs = 15 * 60_000) {}

  async reserve(owner: string): Promise<SpoolEntry> {
    if ([...this.#transfers.values()].filter((transfer) => transfer.owner === owner).length >= MAX_PER_OWNER) {
      throw invalidRequest(`A device may hold at most ${String(MAX_PER_OWNER)} archive transfers; download or use one, or wait a quarter of an hour`);
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

  async receive(owner: string, body: AsyncIterable<Uint8Array>): Promise<{ transfer: string; bytes: number }> {
    const entry = await this.reserve(owner);
    let bytes = 0;
    try {
      const file = await open(entry.file, "wx", 0o600);
      try {
        for await (const chunk of body) {
          await file.writeFile(chunk);
          bytes += chunk.byteLength;
        }
      } finally { await file.close(); }
      if (bytes === 0) throw invalidRequest("An upload needs at least one byte");
    } catch (error) {
      await rm(entry.directory, { recursive: true, force: true });
      throw error;
    }
    this.publish(entry, "upload", bytes);
    return { transfer: entry.id, bytes };
  }

  send(owner: string, id: string): { bytes: number; stream: ReadableStream<Uint8Array> } {
    const transfer = this.#owned(owner, id, "download");
    this.#transfers.delete(id);
    this.#idle();
    let offset = 0;
    const finish = async () => { await rm(transfer.directory, { recursive: true, force: true }); };
    const stream = new ReadableStream<Uint8Array>({
      pull: async (output) => {
        try {
          if (offset >= transfer.bytes) { await finish(); output.close(); return; }
          const chunk = Buffer.alloc(Math.min(READ_BYTES, transfer.bytes - offset));
          const file = await open(transfer.file, "r");
          try {
            const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
            if (bytesRead === 0) throw new Error("Archive ended before its recorded size");
            offset += bytesRead;
            output.enqueue(chunk.subarray(0, bytesRead));
          } finally { await file.close(); }
        } catch (error) {
          await finish();
          output.error(error);
        }
      },
      cancel: finish,
    });
    return { bytes: transfer.bytes, stream };
  }

  claim(owner: string, id: string): SpoolEntry {
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
    const stale = [...this.#transfers.values()].filter((transfer) => transfer.touched < cutoff);
    await Promise.all(stale.map(async (transfer) => { await this.discard(transfer); }));
  }

  #owned(owner: string, id: string, direction: Transfer["direction"]): Transfer {
    const transfer = this.#transfers.get(id);
    if (transfer?.owner !== owner || transfer.direction !== direction) throw notFound(`No ${direction} transfer ${id} for this device`);
    transfer.touched = Date.now();
    return transfer;
  }

  #idle(): void {
    if (this.#transfers.size > 0 || this.#sweeper === undefined) return;
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }
}
