import { homeThreadOf, threadChatModel } from "../engine/threads.ts";
import { shoreLog } from "../log.ts";
import { findEffectiveModel } from "./effective_catalog.ts";
import type { LoadedConfig } from "./loader.ts";
import {
  configView,
  loadForCharacter,
  pinnedModel,
  saveCharacterPreferences,
  savedModelForCharacter,
  type FindEffectiveModel,
} from "./preferences.ts";

export interface HomeModelRegistry {
  availableCharacters(): readonly string[];
  effectiveConfig(character: string): LoadedConfig;
  setThreadModel(character: string, thread: string, model: string | undefined): Promise<unknown>;
}

const findEffective: FindEffectiveModel = (view, cacheDir, name, includeHidden) =>
  findEffectiveModel(view, cacheDir, name, includeHidden);

export async function adoptHomeThreadModel(
  config: LoadedConfig,
  character: string,
  unpin: (thread: string) => Promise<unknown>,
): Promise<boolean> {
  const dataDir = config.dirs.data;
  const home = await homeThreadOf(dataDir, character);
  const pin = await threadChatModel(dataDir, character, home);
  if (pin === undefined) return false;
  const view = configView(config);
  if (savedModelForCharacter(view, character, findEffective) !== undefined) return false;
  const model = pinnedModel(view, pin, findEffective);
  if (model === undefined) return false;
  const [, prefs] = loadForCharacter(dataDir, character);
  prefs.selected.provider = model.providerKey;
  prefs.selected.modelId = model.modelId;
  saveCharacterPreferences(dataDir, character, prefs);
  await unpin(home);
  shoreLog.info(
    `shore: ${character}'s home thread "${home}" was pinned to ${model.qualifiedName}; ` +
      `that is now ${character}'s model, which every thread without its own model uses`,
  );
  return true;
}

export async function adoptHomeThreadModels(registry: HomeModelRegistry): Promise<void> {
  for (const character of registry.availableCharacters()) {
    try {
      await adoptHomeThreadModel(
        registry.effectiveConfig(character),
        character,
        async (thread) => await registry.setThreadModel(character, thread, undefined),
      );
    } catch (e) {
      shoreLog.warn(`shore: could not hand ${character}'s home thread model to the character: ${String(e)}`);
    }
  }
}
