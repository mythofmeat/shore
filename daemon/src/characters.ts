import { shoreLog } from "./log.ts";

import {
  characterConfigDir,
  characterDataDir,
  threadDataDir,
  discoverCharacters,
} from "./config/dirs.ts";
import { toolEnabled } from "./config/app.ts";
import { ConfigError, loadCharacterConfig, type LoadedConfig } from "./config/loader.ts";
import { ConversationEngine, type HistoryListener } from "./engine/conversation.ts";
import {
  ForkBusy,
  forkThread,
  recoverForks,
  type ForkResult,
  type ForkThreadOptions,
} from "./engine/fork.ts";
import { openDueSeals, sealThread, type NewSealedThread } from "./engine/sealed.ts";
import { interruptedReplyNote, replyWasInterrupted } from "./engine/interrupted_reply.ts";
import { sealedIn, sealedThreads, type SealedThread } from "./engine/sealed_list.ts";
import { tryBeginCompaction } from "./memory/compaction/manager.ts";
import { KeyedMutex } from "./util/keyed_mutex.ts";
import {
  archiveThread,
  createThread,
  editThreadAsCharacter,
  ensureThreads,
  ensureWakesThread,
  homeThread,
  wakesThread,
  refuseCommandPins,
  requireEditableByCharacter,
  resolveThreadPins,
  setHomeThread,
  setThreadPins,
  setThreadLabel,
  setThreadCompaction,
  setThreadLocked,
  setThreadModel,
  setThreadPurpose,
  threadRecord,
  ThreadError,
  writeThreadsIndex,
  type ArchiveThreadOptions,
  type NewThread,
  type ThreadEdit,
  type ThreadRecord,
  type ThreadsIndex,
} from "./engine/threads.ts";
import {
  resetActivePromptSnapshotIfEmpty,
} from "./memory/deferred_edits.ts";
import { characterWorkspace } from "./tools/character_workspace.ts";
import { required } from "./util/required.ts";

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

  static noneAvailable(configDir: string): CharacterError {
    return new CharacterError(
      "none_available",
      `no characters available — create a folder for one at ${characterConfigDir(configDir, "<name>")}, ` +
        "or run: shore character new <name>",
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

const threadIndexMutex = new KeyedMutex();

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
    const found = discoverCharacters(this.#configDir);
    for (const name of found) {
      try {
        await recoverForks(this.#dataDir, name);
        const index = await this.#withThreadIndex(name, async () =>
          this.#remember(name, await ensureThreads(this.#dataDir, name, new Date().toISOString())),
        );
        const workspace = characterWorkspace(this.#globalConfig, name);
        await workspace.call("mkdir", { path: workspace.dir });
        await resetActivePromptSnapshotIfEmpty(
          characterDataDir(this.#dataDir, name),
          threadDataDir(this.#dataDir, name, homeThread(index)),
          homeThread(index),
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

  wakesThread(name: string): string | undefined {
    return wakesThread(this.#threads.get(name));
  }

  async ensureWakesThread(name: string): Promise<{ thread: string; created: boolean }> {
    return await this.#withThreadIndex(name, async () => {
      const { index, created } = await ensureWakesThread(this.#dataDir, name, new Date().toISOString());
      return { thread: required(wakesThread(this.#remember(name, index))), created };
    });
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

  sealedThreads(name: string): SealedThread[] {
    return sealedThreads(characterDataDir(this.#dataDir, name));
  }

  async sealThread(name: string, request: NewSealedThread): Promise<SealedThread> {
    return await this.#withThreadIndex(name, async () => await sealThread(this.#dataDir, name, request, Date.now()));
  }

  async openDueSeals(name: string, now: number): Promise<SealedThread[]> {
    return await this.#withThreadIndex(name, async () => {
      const { opened, index } = await openDueSeals(this.#dataDir, name, now);
      if (index !== undefined) this.#remember(name, index);
      for (const sealed of opened) this.#drop(engineKey(name, sealed.id));
      return opened;
    });
  }

  async sealedEngine(name: string, thread: string): Promise<ConversationEngine | undefined> {
    if (sealedIn(characterDataDir(this.#dataDir, name), thread) === undefined) return undefined;
    const key = engineKey(name, thread);
    const loading = this.#engines.get(key) ?? this.#load(name, thread, false);
    this.#engines.set(key, loading);
    return await loading;
  }

  #drop(key: string): void {
    const loading = this.#engines.get(key);
    this.#engines.delete(key);
    void loading?.then(async (engine) => { await engine.closeWhenIdle(); }, () => {});
  }

  async close(): Promise<void> {
    for (const loaded of await Promise.allSettled(this.#engines.values())) {
      if (loaded.status === "fulfilled") loaded.value.close();
    }
  }

  async #load(name: string, thread: string, heard = true): Promise<ConversationEngine> {
    const engine = await ConversationEngine.load(name, this.#dataDir, heard ? this.#onHistory : undefined, thread);
    const recovered = await engine.recoverInterruptedToolLoop("Tool execution was interrupted by a Shore daemon restart before it returned a result.");
    if (replyWasInterrupted(this.#dataDir, name, thread)) await engine.appendMessage(interruptedReplyNote(new Date().toISOString()));
    if (recovered > 0) {
      shoreLog.warn(
        `shore: recovered ${String(recovered)} interrupted tool call(s) for ${name}/${thread}`,
      );
    }
    return engine;
  }

  async createThread(
    name: string,
    id: string,
    options: NewThread = {},
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    const pins = options.pins === undefined ? undefined : await this.#threadPins(name, options.pins, signal);
    if (pins !== undefined && options.created_by === "character" && !this.#runsCommands(name)) refuseCommandPins(pins, []);
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await createThread(this.#dataDir, name, this.#unsealed(name, id), new Date().toISOString(), {
            ...options,
            ...(pins === undefined ? {} : { pins }),
          }),
        ),
      signal,
    );
  }

  #unsealed(name: string, id: string): string {
    if (sealedIn(characterDataDir(this.#dataDir, name), id) === undefined) return id;
    throw new ThreadError("exists", `thread ${JSON.stringify(id)} already exists for ${name}`);
  }

  #runsCommands(name: string): boolean {
    return toolEnabled(this.effectiveConfig(name).app.tools, "bash");
  }

  async #threadPins(name: string, pins: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const workspace = characterWorkspace(this.#globalConfig, name);
    return await resolveThreadPins(pins, async (requested) =>
      await workspace.call("locateFiles", { workspaceDir: workspace.dir, files: requested }, signal), workspace.promptFiles);
  }

  async archiveThread(
    name: string,
    id: string,
    options: ArchiveThreadOptions = {},
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(name, async () => {
      const index = await archiveThread(this.#dataDir, name, id, options);
      this.#drop(engineKey(name, id));
      return this.#remember(name, index);
    }, signal);
  }

  async forkThread(
    name: string,
    source: string,
    child: string,
    options: ForkThreadOptions = {},
    signal?: AbortSignal,
  ): Promise<ForkResult> {
    const guard = tryBeginCompaction(this.#dataDir, name);
    if (guard === undefined) {
      throw new ForkBusy(name, source, "a compaction pass holds this character");
    }
    try {
      const live = await this.getOrCreate(name, source);
      return await this.#withThreadIndex(
        name,
        async () => {
          const result = await forkThread(this.#dataDir, name, source, child, {
            ...options,
            source: options.source ?? live,
          });
          this.#remember(name, result.index);
          return result;
        },
        signal,
      );
    } finally {
      guard.release();
    }
  }

  async setHomeThread(name: string, id: string, signal?: AbortSignal): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await setHomeThread(this.#dataDir, name, id, new Date().toISOString()),
        ),
      signal,
    );
  }

  async setThreadLabel(
    name: string,
    id: string,
    label: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await setThreadLabel(this.#dataDir, name, id, label, new Date().toISOString()),
        ),
      signal,
    );
  }

  async setThreadPurpose(
    name: string,
    id: string,
    purpose: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await setThreadPurpose(this.#dataDir, name, id, purpose, new Date().toISOString()),
        ),
      signal,
    );
  }

  async setThreadPins(
    name: string,
    id: string,
    pins: readonly string[],
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    const resolved = await this.#threadPins(name, pins, signal);
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await setThreadPins(this.#dataDir, name, id, resolved, new Date().toISOString()),
        ),
      signal,
    );
  }

  async setThreadModel(
    name: string,
    id: string,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await setThreadModel(this.#dataDir, name, id, model, new Date().toISOString()),
        ),
      signal,
    );
  }

  async setThreadLocked(
    name: string,
    id: string,
    locked: boolean,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await setThreadLocked(this.#dataDir, name, id, locked, new Date().toISOString()),
        ),
      signal,
    );
  }

  async setThreadCompaction(
    name: string,
    id: string,
    compaction: boolean,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await setThreadCompaction(this.#dataDir, name, id, compaction, new Date().toISOString()),
        ),
      signal,
    );
  }

  async changeThreadLayout(
    name: string,
    change: (index: ThreadsIndex) => ThreadsIndex,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    return await this.#withThreadIndex(
      name,
      async () => {
        const next = change(await ensureThreads(this.#dataDir, name, new Date().toISOString()));
        await writeThreadsIndex(this.#dataDir, name, next);
        return this.#remember(name, next);
      },
      signal,
    );
  }

  async editThreadAsCharacter(
    name: string,
    id: string,
    edit: ThreadEdit,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex> {
    const known = this.#threads.get(name);
    if (known !== undefined) requireEditableByCharacter(known, name, id);
    const pins = edit.pins === undefined ? undefined : await this.#threadPins(name, edit.pins, signal);
    return await this.#withThreadIndex(
      name,
      async () =>
        this.#remember(
          name,
          await editThreadAsCharacter(this.#dataDir, name, id, {
            ...edit,
            ...(pins === undefined ? {} : { pins }),
          }, new Date().toISOString(), this.#runsCommands(name)),
        ),
      signal,
    );
  }

  async #withThreadIndex<T>(
    name: string,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await threadIndexMutex.withKey(`${this.#dataDir}\u0000${name}`, async () => {
      signal?.throwIfAborted();
      return await run();
    });
  }

  #remember(name: string, index: ThreadsIndex): ThreadsIndex {
    this.#threads.set(name, index);
    return index;
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
        this.#drop(key);
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
    }
    if (this.#available.length === 0) {
      throw CharacterError.noneAvailable(this.#configDir);
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
