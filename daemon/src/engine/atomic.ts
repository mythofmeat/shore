import { mkdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

export function atomicWriteSync(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
