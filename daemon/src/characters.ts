import { shoreLog } from "./log.ts";

import {
  characterDataDir,
  characterWorkspaceFile,
  threadDataDir,
  discoverCharacters,
  loadCharacterDefinition,
  resolveUserDefinition,
  SOUL_FILE,
} from "./config/dirs.ts";
import { ConfigError, loadCharacterConfig, type LoadedConfig } from "./config/loader.ts";
import { ConversationEngine, type HistoryListener } from "./engine/conversation.ts";
import {
  ForkBusy,
  forkThread,
  recoverForks,
  type ForkResult,
  type ForkThreadOptions,
} from "./engine/fork.ts";
import { tryBeginCompaction } from "./memory/compaction/manager.ts";
import {
  archiveThread,
  createThread,
  ensureThreads,
  homeThread,
  setHomeThread,
  setThreadLabel,
  setThreadModel,
  threadRecord,
  touchThread,
  ThreadError,
  type ArchiveThreadOptions,
  type NewThread,
  type ThreadRecord,
  type ThreadsIndex,
} from "./engine/threads.ts";
import {
  ensureCharacterWorkspace,
  resetActivePromptSnapshotIfEmpty,
} from "./memory/deferred_edits.ts";

export interface RuntimeReloadSummary {
  availableBefore: number;
  availableAfter: number;
  characterDiscoveryChanged: boolean;
  droppedEngines: number;
}

export type CharacterErrorKind = "not_found" | "none_available" | "ambiguous";

export class CharacterError extends Error {
  constructor(
    readonly kind: CharacterErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CharacterError";
  }

  static #list(available: readonly string[]): string {
    return `[${available.map((n) => JSON.stringify(n)).join(", ")}]`;
  }

  static notFound(name: string, available: readonly string[]): CharacterError {
    return new CharacterError(
      "not_found",
      `character ${JSON.stringify(name)} not found (available: ${CharacterError.#list(available)})`,
    );
  }

  static noneAvailable(configDir: string, workspaceRoot?: string): CharacterError {
    const soul = characterWorkspaceFile(configDir, "<name>", SOUL_FILE, workspaceRoot);
    return new CharacterError(
      "none_available",
      `no characters available — create one at ${soul}, ` +
        "or run: shore character --new <name>",
    );
  }

  static ambiguous(available: readonly string[]): CharacterError {
    return new CharacterError(
      "ambiguous",
      `multiple characters available (${CharacterError.#list(available)}) — ` +
        "specify one with --character or SHORE_CHARACTER",
    );
  }
}

export class EngineCharacterNotFound extends Error {
  constructor(readonly character: string) {
    super(`character not found: ${character}`);
    this.name = "EngineCharacterNotFound";
  }
}

export class CharacterConfigError extends Error {
  readonly code = "invalid_request" as const;

  constructor(readonly character: string, cause: unknown) {
    const detail =
      cause instanceof ConfigError
        ? cause.display
        : cause instanceof Error
          ? cause.message
          : String(cause);
    super(`invalid config for character ${JSON.stringify(character)}: ${detail}`);
    this.name = "CharacterConfigError";
  }
}

export class CharacterRegistry {
  readonly #configDir: string;
  readonly #dataDir: string;
  readonly #onHistory: HistoryListener | undefined;
  readonly #engines = new Map<string, Promise<ConversationEngine>>();
  readonly #charConfigs = new Map<string, LoadedConfig | undefined>();
  readonly #threads = new Map<string, ThreadsIndex>();
  #available: string[] = [];
  #selected: string | undefined;
  #globalConfig: LoadedConfig;

  private constructor(
    configDir: string,
    dataDir: string,
    globalConfig: LoadedConfig,
    onHistory: HistoryListener | undefined,
  ) {
    this.#configDir = configDir;
    this.#dataDir = dataDir;
    this.#globalConfig = globalConfig;
    this.#onHistory = onHistory;
  }

  static async create(
    configDir: string,
    dataDir: string,
    globalConfig: LoadedConfig,
    onHistory?: HistoryListener,
  ): Promise<CharacterRegistry> {
    const registry = new CharacterRegistry(configDir, dataDir, globalConfig, onHistory);
    registry.#available = await registry.#scan();
    return registry;
  }

  async #scan(): Promise<string[]> {
    const found = discoverCharacters(this.#configDir, this.#workspaceRoot());
    for (const name of found) {
      try {
        await recoverForks(this.#dataDir, name);
        const index = await ensureThreads(this.#dataDir, name, new Date().toISOString());
        this.#threads.set(name, index);
        await ensureCharacterWorkspace(
          characterDataDir(this.#dataDir, name),
          this.#configDir,
          name,
          this.#workspaceRoot(),
        );
        await resetActivePromptSnapshotIfEmpty(
          characterDataDir(this.#dataDir, name),
          threadDataDir(this.#dataDir, name, homeThread(index)),
        );
      } catch (e) {
        shoreLog.warn(
          `shore: failed to prepare workspace for character ${name}: ${String(e)}`,
        );
      }
    }
    return found;
  }

  availableCharacters(): readonly string[] {
    return this.#available;
  }

  async refresh(): Promise<void> {
    this.#available = await this.#scan();
  }

  hasCharacter(name: string): boolean {
    return this.#available.includes(name);
  }

  threads(name: string): ThreadsIndex | undefined {
    return this.#threads.get(name);
  }

  homeThread(name: string): string {
    return homeThread(this.#threads.get(name));
  }

  listThreads(name: string): readonly ThreadRecord[] {
    return this.#threads.get(name)?.threads ?? [];
  }

  async getOrCreate(name: string, thread?: string): Promise<ConversationEngine> {
    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);

    const id = thread ?? this.homeThread(name);
    const index = this.#threads.get(name);
    if (thread !== undefined && index !== undefined && threadRecord(index, thread) === undefined) {
      throw new ThreadError("not_found", `no thread ${JSON.stringify(thread)} for ${name}`);
    }
    const key = engineKey(name, id);
    const existing = this.#engines.get(key);
    if (existing !== undefined) return await existing;

    const loading = this.#load(name, id);
    this.#engines.set(key, loading);
    try {
      return await loading;
    } catch (e) {
      if (this.#engines.get(key) === loading) this.#engines.delete(key);
      throw e;
    }
  }

  async #load(name: string, thread: string): Promise<ConversationEngine> {
    const engine = await ConversationEngine.load(name, this.#dataDir, this.#onHistory, thread);
    const recovered = await engine.recoverInterruptedToolLoop();
    if (recovered > 0) {
      shoreLog.warn(
        `shore: recovered ${String(recovered)} interrupted tool call(s) for ${name}/${thread}`,
      );
    }
    return engine;
  }

  async createThread(name: string, id: string, options: NewThread = {}): Promise<ThreadsIndex> {
    return this.#remember(
      name,
      await createThread(this.#dataDir, name, id, new Date().toISOString(), options),
    );
  }

  async archiveThread(
    name: string,
    id: string,
    options: ArchiveThreadOptions = {},
  ): Promise<ThreadsIndex> {
    const index = await archiveThread(this.#dataDir, name, id, {
      ...options,
      retain: options.retain ?? this.effectiveConfig(name).app.memory.retain.enabled,
    });
    this.#engines.delete(engineKey(name, id));
    return this.#remember(name, index);
  }

  async forkThread(
    name: string,
    source: string,
    child: string,
    options: ForkThreadOptions = {},
  ): Promise<ForkResult> {
    const guard = tryBeginCompaction(this.#dataDir, name);
    if (guard === undefined) {
      throw new ForkBusy(name, source, "a compaction pass holds this character");
    }
    try {
      const live = await this.getOrCreate(name, source);
      const result = await forkThread(this.#dataDir, name, source, child, {
        ...options,
        source: options.source ?? live,
      });
      this.#remember(name, result.index);
      return result;
    } finally {
      guard.release();
    }
  }

  async setHomeThread(name: string, id: string): Promise<ThreadsIndex> {
    return this.#remember(
      name,
      await setHomeThread(this.#dataDir, name, id, new Date().toISOString()),
    );
  }

  async setThreadLabel(name: string, id: string, label: string | undefined): Promise<ThreadsIndex> {
    return this.#remember(
      name,
      await setThreadLabel(this.#dataDir, name, id, label, new Date().toISOString()),
    );
  }

  async setThreadModel(name: string, id: string, model: string | undefined): Promise<ThreadsIndex> {
    return this.#remember(
      name,
      await setThreadModel(this.#dataDir, name, id, model, new Date().toISOString()),
    );
  }

  async touchThread(name: string, id: string): Promise<void> {
    const index = await touchThread(this.#dataDir, name, id, new Date().toISOString());
    if (index !== undefined) this.#threads.set(name, index);
  }

  #remember(name: string, index: ThreadsIndex): ThreadsIndex {
    this.#threads.set(name, index);
    return index;
  }

  #workspaceRoot(): string | undefined {
    return this.#globalConfig.dirs.workspace;
  }

  characterDefinition(name: string): string | undefined {
    return loadCharacterDefinition(this.#configDir, name, this.#workspaceRoot());
  }

  userDefinition(name: string): string | undefined {
    return resolveUserDefinition(this.#configDir, name, this.#workspaceRoot());
  }

  effectiveConfig(name: string): LoadedConfig {
    if (!this.#charConfigs.has(name)) {
      try {
        this.#charConfigs.set(name, loadCharacterConfig(this.#globalConfig, name));
      } catch (e) {
        throw new CharacterConfigError(name, e);
      }
    }
    return this.#charConfigs.get(name) ?? this.#globalConfig;
  }

  invalidateConfigs(): void {
    this.#charConfigs.clear();
  }

  setRuntimeEffectiveConfig(name: string, config: LoadedConfig): void {
    this.#charConfigs.set(name, config);
  }

  setGlobalConfig(config: LoadedConfig): void {
    this.#globalConfig = config;
    this.#charConfigs.clear();
  }

  globalConfig(): LoadedConfig {
    return this.#globalConfig;
  }

  async reloadRuntimeState(config: LoadedConfig): Promise<RuntimeReloadSummary> {
    const before = this.#available;
    const after = await this.#scan();
    const afterSet = new Set(after);

    let droppedEngines = 0;
    for (const key of Array.from(this.#engines.keys())) {
      if (!afterSet.has(engineCharacter(key))) {
        this.#engines.delete(key);
        droppedEngines += 1;
      }
    }
    for (const name of Array.from(this.#threads.keys())) {
      if (!afterSet.has(name)) this.#threads.delete(name);
    }

    this.#globalConfig = config;
    this.#charConfigs.clear();
    this.#available = after;

    return {
      availableBefore: before.length,
      availableAfter: after.length,
      characterDiscoveryChanged: !sameList(before, after),
      droppedEngines,
    };
  }

  selectedCharacter(): string | undefined {
    return this.#selected !== undefined && this.hasCharacter(this.#selected)
      ? this.#selected
      : undefined;
  }

  resolveCharacter(requested: string | undefined): string {
    if (requested !== undefined) {
      if (!this.hasCharacter(requested)) {
        throw CharacterError.notFound(requested, this.#available);
      }
      this.#selected = requested;
      return requested;
    }
    if (this.#available.length === 0) {
      throw CharacterError.noneAvailable(this.#configDir, this.#workspaceRoot());
    }
    const held = this.selectedCharacter();
    if (held !== undefined) return held;
    const only = this.#available.length === 1 ? this.#available[0] : undefined;
    if (only !== undefined) {
      this.#selected = only;
      return only;
    }
    throw CharacterError.ambiguous(this.#available);
  }
}

const ENGINE_KEY_SEPARATOR = "\u0000";

function engineKey(name: string, thread: string): string {
  return `${name}${ENGINE_KEY_SEPARATOR}${thread}`;
}

function engineCharacter(key: string): string {
  return key.split(ENGINE_KEY_SEPARATOR)[0] ?? key;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
