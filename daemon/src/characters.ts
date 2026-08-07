import {
  characterDataDir,
  characterWorkspaceFile,
  discoverCharacters,
  loadCharacterDefinition,
  resolveUserDefinition,
  SOUL_FILE,
} from "./config/dirs.ts";
import { loadCharacterConfig, type LoadedConfig } from "./config/loader.ts";
import { ConversationEngine, type HistoryListener } from "./engine/conversation.ts";
import { ensureActivePromptSnapshot } from "./memory/deferred_edits.ts";

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

  static noneAvailable(configDir: string, workspaceRoot?: string | undefined): CharacterError {
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

export class CharacterRegistry {
  readonly #configDir: string;
  readonly #dataDir: string;
  readonly #onHistory: HistoryListener | undefined;
  readonly #engines = new Map<string, ConversationEngine>();
  readonly #charConfigs = new Map<string, LoadedConfig | undefined>();
  #available: string[] = [];
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
        await ensureActivePromptSnapshot(
          characterDataDir(this.#dataDir, name),
          this.#configDir,
          name,
          this.#workspaceRoot(),
        );
      } catch (e) {
        console.warn(
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

  async getOrCreate(name: string): Promise<ConversationEngine> {
    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);

    const existing = this.#engines.get(name);
    if (existing !== undefined) return existing;

    const engine = await ConversationEngine.load(name, this.#dataDir, this.#onHistory);
    this.#engines.set(name, engine);
    return engine;
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
        console.warn(
          `shore: failed to load config for character ${name}, using global: ${String(e)}`,
        );
        this.#charConfigs.set(name, undefined);
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
    for (const name of [...this.#engines.keys()]) {
      if (!afterSet.has(name)) {
        this.#engines.delete(name);
        droppedEngines += 1;
      }
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

  resolveCharacter(requested: string | undefined): string {
    if (requested !== undefined) {
      if (this.hasCharacter(requested)) return requested;
      throw CharacterError.notFound(requested, this.#available);
    }
    if (this.#available.length === 0) {
      throw CharacterError.noneAvailable(this.#configDir, this.#workspaceRoot());
    }
    if (this.#available.length === 1) return this.#available[0] as string;
    throw CharacterError.ambiguous(this.#available);
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
