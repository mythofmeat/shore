import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWrite(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}
