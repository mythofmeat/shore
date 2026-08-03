/**
 * `<data_dir>/<character>/runtime_state.json` — the legacy home of the
 * character's active model.
 *
 * Port of `crates/daemon/src/runtime_state.rs`. Preferences superseded this:
 * it is still *read*, as the migration fallback for installs that predate
 * `models.toml`, but nothing writes it on the resolution path any more.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_STATE_FILE = "runtime_state.json";

export interface CharacterRuntimeState {
  activeModel?: string;
}

export function characterRuntimeStatePath(characterDataDir: string): string {
  return join(characterDataDir, RUNTIME_STATE_FILE);
}

/** A missing file is empty state; a malformed one is an error. */
export function loadCharacterRuntimeState(characterDataDir: string): CharacterRuntimeState {
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

export function saveCharacterRuntimeState(
  characterDataDir: string,
  state: CharacterRuntimeState,
): void {
  mkdirSync(characterDataDir, { recursive: true });
  // `skip_serializing_if = "Option::is_none"` on the Rust side: an unset model
  // writes `{}`, not `{"active_model": null}`.
  const body = state.activeModel === undefined ? {} : { active_model: state.activeModel };
  writeFileSync(characterRuntimeStatePath(characterDataDir), `${JSON.stringify(body, null, 2)}`);
}

/** The active model name, or `undefined` if unset or unreadable. */
export function loadActiveModel(characterDataDir: string): string | undefined {
  try {
    return loadCharacterRuntimeState(characterDataDir).activeModel;
  } catch {
    // `.ok()` in the Rust: a corrupt runtime_state.json is not worth failing
    // model resolution over — preferences are authoritative now.
    return undefined;
  }
}

export function saveActiveModel(characterDataDir: string, activeModel: string | undefined): void {
  saveCharacterRuntimeState(
    characterDataDir,
    activeModel === undefined ? {} : { activeModel },
  );
}
