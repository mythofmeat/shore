import { open, type FileHandle } from "node:fs/promises";
import { Header, Pax } from "tar";

const BLOCK = 512;
const FLUSH_BYTES = 1024 * 1024;

export interface TarFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly mtime: Date;
}

interface EntryHeader {
  path: string;
  mode: number;
  size: number;
  type: "File" | "Directory" | "SymbolicLink";
  mtime?: Date;
  linkpath?: string;
}

export class TarWriter {
  readonly #file: FileHandle;
  readonly #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #bytes = 0;

  private constructor(file: FileHandle) {
    this.#file = file;
  }

  static async create(path: string): Promise<TarWriter> {
    return new TarWriter(await open(path, "wx", 0o600));
  }

  async add(entry: TarFile, content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void> {
    await this.#header({ path: entry.path, mode: entry.mode & 0o7777, size: entry.size, mtime: entry.mtime, type: "File" });
    let written = 0;
    for await (const chunk of content) {
      written += chunk.length;
      if (written > entry.size) throw new Error(`${entry.path} grew while it was being backed up`);
      await this.#write(chunk);
    }
    if (written !== entry.size) throw new Error(`${entry.path} shrank while it was being backed up`);
    const padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
    if (padding > 0) await this.#write(new Uint8Array(padding));
  }

  async directory(path: string, mode: number): Promise<void> {
    await this.#header({ path: `${path}/`, mode: mode & 0o7777, size: 0, type: "Directory" });
  }

  async symlink(path: string, target: string): Promise<void> {
    await this.#header({ path, linkpath: target, mode: 0o777, size: 0, type: "SymbolicLink" });
  }

  async #header(fields: EntryHeader): Promise<void> {
    const header = new Header(fields);
    if (header.encode()) {
      const { path, size, mtime, linkpath } = fields;
      await this.#write(new Pax({ path, size, ...(mtime === undefined ? {} : { mtime }), ...(linkpath === undefined ? {} : { linkpath }) }).encode());
    }
    if (header.block === undefined) throw new Error(`Could not encode a tar header for ${fields.path}`);
    await this.#write(header.block);
  }

  async close(): Promise<number> {
    try {
      await this.#write(new Uint8Array(BLOCK * 2));
      await this.#flush();
    } finally {
      await this.#file.close();
    }
    return this.#bytes;
  }

  async abort(): Promise<void> {
    await this.#file.close().catch(() => {});
  }

  async #write(data: Uint8Array): Promise<void> {
    this.#pending.push(data);
    this.#pendingBytes += data.length;
    this.#bytes += data.length;
    if (this.#pendingBytes >= FLUSH_BYTES) await this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#pendingBytes === 0) return;
    const data = this.#pending.length === 1 ? this.#pending[0] as Uint8Array : Buffer.concat(this.#pending);
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    for (let offset = 0; offset < data.length;) {
      const { bytesWritten } = await this.#file.write(data, offset, data.length - offset);
      offset += bytesWritten;
    }
  }
}
