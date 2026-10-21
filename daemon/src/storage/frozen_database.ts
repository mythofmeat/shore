import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";

export interface FrozenDatabase {
  readonly bytes: number;
  blocks(size: number): AsyncGenerator<Buffer>;
  release(): void;
}

export async function freezeDatabase(path: string, attempts = 20): Promise<FrozenDatabase> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const checkpoint = new Database(path);
    let busy: number;
    try {
      checkpoint.run("PRAGMA busy_timeout = 2000");
      busy = Number(checkpoint.query("PRAGMA wal_checkpoint(TRUNCATE)").values()[0]?.[0] ?? 1);
    } finally {
      checkpoint.close();
    }
    const reader = new Database(path);
    reader.run("PRAGMA busy_timeout = 5000");
    reader.run("BEGIN");
    reader.query("SELECT count(*) FROM sqlite_schema").get();
    if (busy === 0 && await logBytes(path) === 0) return frozen(path, reader, (await stat(path)).size);
    reader.run("ROLLBACK");
    reader.close();
    await Bun.sleep(100);
  }
  throw new Error("The database never went quiet long enough to take a consistent snapshot");
}

async function logBytes(path: string): Promise<number> {
  try {
    return (await stat(`${path}-wal`)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function frozen(path: string, reader: Database, bytes: number): FrozenDatabase {
  let released = false;
  return {
    bytes,
    async *blocks(size) {
      const child = spawn("cat", ["--", path], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
      const exited = once(child, "close") as Promise<[number | null]>;
      exited.catch(() => {});
      let carry: Buffer | undefined;
      let total = 0;
      let finished = false;
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
          const data = carry === undefined ? chunk : Buffer.concat([carry, chunk]);
          let offset = 0;
          for (; data.length - offset >= size; offset += size) {
            total += size;
            yield data.subarray(offset, offset + size);
          }
          carry = offset < data.length ? Buffer.from(data.subarray(offset)) : undefined;
        }
        if (carry !== undefined) {
          total += carry.length;
          yield carry;
        }
        finished = true;
      } finally {
        if (!finished) child.kill();
      }
      const [code] = await exited;
      if (code !== 0) throw new Error(`Could not read the database snapshot: cat exited with ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`);
      if (total !== bytes) throw new Error(`The database snapshot changed size while it was read (${String(total)} of ${String(bytes)} bytes)`);
    },
    release() {
      if (released) return;
      released = true;
      reader.run("ROLLBACK");
      reader.close();
    },
  };
}
