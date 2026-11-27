import type { CharacterInfo } from "../protocol/CharacterInfo";
import type { Message } from "../protocol/Message";
import type { SegmentSummary } from "../protocol/SegmentSummary";
import type { ServerMessage } from "../protocol/ServerMessage";
import { EngineCharacterNotFound } from "../characters.ts";
import { characterMetadata } from "../commands/navigation.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { firstChatModel } from "../config/models.ts";
import { configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import { threadModelOf, type ThreadRecord } from "../engine/threads.ts";

export const SWP_V1 = 1;

export interface HelloSnapshot {
  readonly characters: readonly CharacterInfo[];
  readonly selected?: string | undefined;
}

export interface HistorySnapshot {
  readonly messages: readonly Message[];
  readonly previousSegment: SegmentSummary | null;
  readonly config: unknown;
  readonly selectedCharacter: string | null;
  readonly selectedThread: string | null;
  readonly revision: number;
}

export interface Selection {
  readonly character: string | null;
  readonly thread: string | null;
}

export interface HandshakeProvider {
  hello(): Promise<HelloSnapshot>;
  history(selectedCharacter: string | null, selectedThread?: string | null): Promise<HistorySnapshot>;
  select(character: string | null, thread: string | null): Promise<Selection>;
}

export const DEFAULT_HANDSHAKE: HandshakeProvider = {
  hello: () => Promise.resolve({ characters: [{ name: "default" }] }),
  history: (selectedCharacter) =>
    Promise.resolve({
      messages: [],
      previousSegment: null,
      config: {},
      selectedCharacter,
      selectedThread: null,
      revision: 0,
    }),
  select: (character) => Promise.resolve({ character, thread: null }),
};

export interface Logger {
  info?(msg: string, fields?: Record<string, unknown>): void;
  warn?(msg: string, fields?: Record<string, unknown>): void;
  error?(msg: string, fields?: Record<string, unknown>): void;
}

export function historyMessage(history: HistorySnapshot, rid?: string): ServerMessage {
  return {
    type: "history",
    ...(rid === undefined ? {} : { rid }),
    messages: history.messages as Message[],
    ...(history.previousSegment === null ? {} : { previous_segment: history.previousSegment }),
    config: history.config,
    ...(history.selectedThread === null ? {} : { selected_thread: history.selectedThread }),
    ...(history.selectedCharacter === null
      ? {}
      : { selected_character: history.selectedCharacter }),
    revision: history.revision,
  };
}

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
    select: async (character, thread) => await resolveSelection(registry, character, thread),
  };
}

async function resolveSelection(registry: HandshakeRegistry, character: string | null, thread: string | null): Promise<Selection> {
  const engine = character === null ? undefined : await engineIfCharacterExists(registry, character, liveThread(registry, character, thread));
  return engine === undefined ? { character: null, thread: null } : { character, thread: engine.thread };
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
      previousSegment: null,
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
    messages: history.messages,
    previousSegment: history.previous_segment ?? null,
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
      activeModel ?? config.app.chat.model ?? firstChatModel(config.models)?.qualifiedName ?? null,
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
