import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import patchCommand from "../../bin/shore-patch.sh" with { type: "text" };

let commandsDir: Promise<string> | undefined;

async function installCommands(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shore-bash-bin-"));
  try {
    await writeFile(join(dir, "shore-patch"), patchCommand, { mode: 0o755 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function bashCommandsDir(): Promise<string> {
  commandsDir ??= installCommands().catch((error: unknown) => {
    commandsDir = undefined;
    throw error;
  });
  return await commandsDir;
}
