import type { CharacterInfo } from "../protocol/CharacterInfo";
import { EngineCharacterNotFound } from "../characters.ts";
import { characterMetadata } from "../commands/navigation.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { firstChatModel } from "../config/models.ts";
import { configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import { threadModelOf, type ThreadRecord } from "../engine/threads.ts";
import type { HandshakeProvider, HelloSnapshot, HistorySnapshot } from "./connection";

export interface HandshakeRegistry {
  availableCharacters(): readonly string[];
  selectedCharacter?(): string | undefined;
  globalConfig(): LoadedConfig;
  effectiveConfig(name: string): LoadedConfig;
  getOrCreate(name: string, thread?: string): Promise<ConversationEngine>;
  listThreads(name: string): readonly ThreadRecord[];
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
    history: async (selectedCharacter, selectedThread) =>
      await buildSessionHistorySnapshot(registry, selectedCharacter, selectedThread ?? null),
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
  selectedThread: string | null = null,
  activeModel?: string,
): Promise<HistorySnapshot> {
  const config =
    selectedCharacter === null
      ? registry.globalConfig()
      : registry.effectiveConfig(selectedCharacter);
  const engine =
    selectedCharacter === null
      ? undefined
      : await engineIfCharacterExists(
          registry,
          selectedCharacter,
          liveThread(registry, selectedCharacter, selectedThread),
        );
  if (engine === undefined) {
    return {
      messages: [],
      activeStart: 0,
      config: historyConfigSnapshot(
        config,
        snapshotActiveModel(config, selectedCharacter, activeModel, undefined),
      ),
      selectedCharacter: null,
      selectedThread: null,
      revision: 0,
    };
  }

  const history = engine.historySnapshot({});
  const thread = engine.thread;
  return {
    messages: history.messages as HistorySnapshot["messages"],
    activeStart: history.active_start ?? 0,
    config: historyConfigSnapshot(
      config,
      snapshotActiveModel(
        config,
        selectedCharacter,
        activeModel,
        selectedCharacter === null
          ? undefined
          : threadModelOf(registry.listThreads(selectedCharacter), thread),
      ),
    ),
    selectedCharacter: history.selected_character ?? selectedCharacter,
    selectedThread: thread,
    revision: history.revision,
  };
}

function liveThread(
  registry: HandshakeRegistry,
  character: string,
  selected: string | null,
): string | undefined {
  if (selected === null) return undefined;
  return registry.listThreads(character).some((t) => t.id === selected) ? selected : undefined;
}

async function engineIfCharacterExists(
  registry: HandshakeRegistry,
  character: string,
  thread: string | undefined,
): Promise<ConversationEngine | undefined> {
  try {
    return await registry.getOrCreate(character, thread);
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
  threadModel: string | undefined,
): string | undefined {
  if (activeModel !== undefined) return activeModel;
  if (selectedCharacter === null) return undefined;
  return resolveChatModelForCharacter(
    configView(config),
    selectedCharacter,
    findEffectiveModel,
    threadModel,
  )?.qualifiedName;
}
