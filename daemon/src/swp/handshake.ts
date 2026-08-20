import type { CharacterInfo } from "../protocol/CharacterInfo";
import { EngineCharacterNotFound } from "../characters.ts";
import { characterMetadata } from "../commands/navigation.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { firstChatModel } from "../config/models.ts";
import { configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { HandshakeProvider, HelloSnapshot, HistorySnapshot } from "./connection";

export interface HandshakeRegistry {
  availableCharacters(): readonly string[];
  selectedCharacter?(): string | undefined;
  globalConfig(): LoadedConfig;
  effectiveConfig(name: string): LoadedConfig;
  getOrCreate(name: string): Promise<ConversationEngine>;
}

export class HistorySnapshotError extends Error {
  readonly code = "internal_error" as const;

  constructor(
    readonly character: string,
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`could not load ${JSON.stringify(character)}'s conversation: ${detail}`);
    this.name = "HistorySnapshotError";
  }
}

export function buildHandshakeProvider(registry: HandshakeRegistry): HandshakeProvider {
  return {
    hello: () => Promise.resolve(helloSnapshot(registry)),
    history: async (selectedCharacter) =>
      await buildSessionHistorySnapshot(registry, selectedCharacter),
  };
}

export function helloSnapshot(registry: HandshakeRegistry): HelloSnapshot {
  const configDir = registry.globalConfig().dirs.config;
  const characters: CharacterInfo[] = registry
    .availableCharacters()
    .map((name) => characterMetadata(configDir, name));
  const selected = registry.selectedCharacter?.();
  return { characters, ...(selected === undefined ? {} : { selected }) };
}

export async function buildSessionHistorySnapshot(
  registry: HandshakeRegistry,
  selectedCharacter: string | null,
  activeModel?: string,
): Promise<HistorySnapshot> {
  const config =
    selectedCharacter === null
      ? registry.globalConfig()
      : registry.effectiveConfig(selectedCharacter);
  const resolvedModel = snapshotActiveModel(config, selectedCharacter, activeModel);
  const configBlock = historyConfigSnapshot(config, resolvedModel);

  const engine =
    selectedCharacter === null ? undefined : await engineIfCharacterExists(registry, selectedCharacter);
  if (engine === undefined) {
    return {
      messages: [],
      activeStart: 0,
      config: configBlock,
      selectedCharacter: null,
      revision: 0,
    };
  }

  const history = engine.historySnapshot({});
  return {
    messages: history.messages as HistorySnapshot["messages"],
    activeStart: history.active_start ?? 0,
    config: configBlock,
    selectedCharacter: history.selected_character ?? selectedCharacter,
    revision: history.revision,
  };
}

async function engineIfCharacterExists(
  registry: HandshakeRegistry,
  character: string,
): Promise<ConversationEngine | undefined> {
  try {
    return await registry.getOrCreate(character);
  } catch (e) {
    if (e instanceof EngineCharacterNotFound) return undefined;
    throw new HistorySnapshotError(character, e);
  }
}

function historyConfigSnapshot(config: LoadedConfig, activeModel: string | undefined): unknown {
  return {
    active_model:
      activeModel ?? config.app.defaults.model ?? firstChatModel(config.models)?.qualifiedName ?? null,
  };
}

function snapshotActiveModel(
  config: LoadedConfig,
  selectedCharacter: string | null,
  activeModel: string | undefined,
): string | undefined {
  if (activeModel !== undefined) return activeModel;
  if (selectedCharacter === null) return undefined;
  return resolveChatModelForCharacter(configView(config), selectedCharacter, findEffectiveModel)
    ?.qualifiedName;
}
