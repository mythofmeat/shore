import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_STATE_FILE = "runtime_state.json";

export interface CharacterRuntimeState {
  activeModel?: string;
}

function characterRuntimeStatePath(characterDataDir: string): string {
  return join(characterDataDir, RUNTIME_STATE_FILE);
}

function loadCharacterRuntimeState(characterDataDir: string): CharacterRuntimeState {
  const path = characterRuntimeStatePath(characterDataDir);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const parsed = JSON.parse(content) as { active_model?: unknown };
  const activeModel = parsed.active_model;
  return typeof activeModel === "string" ? { activeModel } : {};
}

export function loadActiveModel(characterDataDir: string): string | undefined {
  try {
    return loadCharacterRuntimeState(characterDataDir).activeModel;
  } catch {
    return undefined;
  }
}
