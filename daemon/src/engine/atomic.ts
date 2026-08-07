/**
 * Write-then-rename, so a reader never sees a half-written file.
 *
 * Ported from `crates/daemon/src/engine/atomic.rs`. The temp file is created
 * in the destination's own directory because `rename` is only atomic within a
 * filesystem, and a temp directory can easily be on a different one.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Write `data` to `path` atomically, creating parent directories as needed. */
export async function atomicWrite(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}
