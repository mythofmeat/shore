import { join } from "node:path";

import type { CharacterRegistry } from "../characters.ts";
import { characterDataDir } from "../config/dirs.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { NewSealedThread } from "../engine/sealed.ts";
import type { SealedThread } from "../engine/sealed_list.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { ToolIoError } from "../tools/errors.ts";

export async function sealedFilesDir(config: LoadedConfig, character: string, thread: string): Promise<string> {
  const home = (await characterWorkspace(config, character).user())?.home;
  return join(home ?? characterDataDir(config.dirs.data, character), "sealed", thread);
}

export interface StartedSeal {
  sealed: SealedThread;
  filesDir: string;
}

export async function startSealedThread(
  registry: Pick<CharacterRegistry, "sealThread" | "effectiveConfig">,
  character: string,
  request: NewSealedThread,
): Promise<StartedSeal> {
  const config = registry.effectiveConfig(character);
  const filesDir = await sealedFilesDir(config, character, request.id);
  const made = await characterWorkspace(config, character).run("mkdir", ["-p", filesDir]);
  if (made.code !== 0) throw new ToolIoError(`nothing was sealed, because the folder for its files, ${filesDir}, could not be made: ${made.stderr.trim()}`);
  return { sealed: await registry.sealThread(character, request), filesDir };
}
