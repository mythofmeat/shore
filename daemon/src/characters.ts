/**
 * The character registry: which characters exist, and one live conversation
 * engine per character.
 *
 * Port of `crates/daemon/src/characters.rs`, pinned by
 * `tests/engine_fixtures/characters_parity.json`.
 *
 * Almost everything here is a **cache**, and every one of them has different
 * invalidation rules. That is the whole module, and it is why the fixture is
 * scripted runs rather than single calls:
 *
 * | cache | filled by | invalidated by |
 * |---|---|---|
 * | `#available` | construction | `refresh`, `reloadRuntimeState` |
 * | `#engines` | first `getOrCreate` | `reloadRuntimeState`, and only for characters that vanished |
 * | `#charConfigs` | first `effectiveConfig` | `invalidateConfigs`, `setGlobalConfig`, `reloadRuntimeState` |
 *
 * The per-character config cache stores its own **absence** — a character with
 * no `config.toml` caches "no override", so writing that file afterwards
 * changes nothing until something invalidates. That is deliberate in the Rust
 * and reproduced here; it is also the single most surprising thing in the file.
 *
 * # Two directories that are assumed equal and are not checked
 *
 * Discovery walks {@link CharacterRegistry}'s own `configDir`. Per-character
 * overrides are looked up under `globalConfig.dirs.config`, because that is
 * what `loadCharacterConfig` takes. They are the same directory everywhere in
 * production and nothing enforces it — hand `setGlobalConfig` a config loaded
 * from elsewhere and overrides silently stop being found while every character
 * stays available. Pinned rather than fixed: the daemon does not do it, and
 * "fixing" it here would put the port out of step with the Rust for a case
 * that cannot arise.
 */

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

/** What `reloadRuntimeState` did, for the caller to log or report. */
export interface RuntimeReloadSummary {
  availableBefore: number;
  availableAfter: number;
  characterDiscoveryChanged: boolean;
  droppedEngines: number;
}

/** Why a character could not be resolved. */
export type CharacterErrorKind = "not_found" | "none_available" | "ambiguous";

/** A failure to pick a character, carrying what was available at the time. */
export class CharacterError extends Error {
  constructor(
    readonly kind: CharacterErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CharacterError";
  }

  /** Rust's `{available:?}` — a `Vec<String>` in Debug form. */
  static #list(available: readonly string[]): string {
    return `[${available.map((n) => JSON.stringify(n)).join(", ")}]`;
  }

  static notFound(name: string, available: readonly string[]): CharacterError {
    return new CharacterError(
      "not_found",
      `character ${JSON.stringify(name)} not found (available: ${CharacterError.#list(available)})`,
    );
  }

  /**
   * The empty-registry error, naming a path the user can actually act on.
   *
   * The Rust wrote `characters/<name>/workspace/SOUL.md`, relative to the
   * config directory and saying so nowhere — and this is the first error a
   * fresh install hits, from every command, so the working directory is the
   * obvious wrong guess (#41). The path is resolved here instead, which also
   * makes it honest under `SHORE_WORKSPACE_DIR`: with a workspace root set the
   * file is at `<root>/<name>/SOUL.md` and the old string named a location
   * that does not exist in that layout at all.
   */
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

/** `EngineError::CharacterNotFound`, which `getOrCreate` throws. */
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
  /** `undefined` value means "looked, and there is no override file". */
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

  /**
   * Scan for characters and prepare each one's workspace.
   *
   * A static factory rather than a constructor because preparing the workspace
   * is asynchronous here — the Rust did it with blocking I/O inside `new`.
   * `onHistory` replaces the Rust's `broadcast::Sender<ServerMessage>`, which
   * the registry only ever cloned into new engines.
   */
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

  /**
   * Re-scan and prepare every character found.
   *
   * A failed workspace preparation is logged and skipped, not thrown: one
   * unwritable character directory must not stop the daemon seeing the others.
   */
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

  /** The characters found by the last scan, in code-point order. */
  availableCharacters(): readonly string[] {
    return this.#available;
  }

  /**
   * Re-scan the characters directory.
   *
   * Note what this does *not* do: engines are untouched, so a character that
   * has been deleted keeps its engine, unreachable through `getOrCreate` but
   * still in the map. Re-creating the character brings the **old** engine
   * back, still holding the conversation it had before — it is not reopened
   * from disk. Only `reloadRuntimeState` drops engines. Both halves are pinned;
   * neither is obviously intended, and both are the Rust's behaviour.
   */
  async refresh(): Promise<void> {
    this.#available = await this.#scan();
  }

  hasCharacter(name: string): boolean {
    return this.#available.includes(name);
  }

  /**
   * The engine for a character, created on first use and cached after.
   *
   * The Rust returned `Arc<Mutex<ConversationEngine>>` and callers held the
   * lock across a whole turn. There is no data race to prevent here, but the
   * mutual exclusion was doing real work: it stopped two turns for the same
   * character interleaving at an `await`. **Whoever drives a turn has to
   * serialize it** — the registry hands out a shared engine and does not do it
   * for them. Left to the caller rather than invented here, because no caller
   * has been ported yet and the shape of that serialization is theirs to pick.
   */
  async getOrCreate(name: string): Promise<ConversationEngine> {
    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);

    const existing = this.#engines.get(name);
    if (existing !== undefined) return existing;

    const engine = await ConversationEngine.load(name, this.#dataDir, this.#onHistory);
    this.#engines.set(name, engine);
    return engine;
  }

  /**
   * Where workspaces live, read from the config the registry is holding *now*
   * rather than cached — a reload can replace it, and every path below has to
   * follow the config that is current when it is asked.
   */
  #workspaceRoot(): string | undefined {
    return this.#globalConfig.dirs.workspace;
  }

  /** The character's system prompt: `workspace/SOUL.md`, else `character.md`. */
  characterDefinition(name: string): string | undefined {
    return loadCharacterDefinition(this.#configDir, name, this.#workspaceRoot());
  }

  /** The character's user context: `workspace/USER.md`, else `user.md`. */
  userDefinition(name: string): string | undefined {
    return resolveUserDefinition(this.#configDir, name, this.#workspaceRoot());
  }

  /**
   * The config a character runs under: its merged override if it has one, the
   * global config otherwise. Cached either way.
   *
   * Membership is not checked. `effectiveConfig` on a character that does not
   * exist returns the global config rather than throwing, and caches that —
   * which is what makes it safe to call before resolution has happened.
   *
   * A character config that fails to load is a **warning**, and the character
   * falls back to the global config. It is not fatal, and the failure is
   * cached like any other miss, so the file is not re-read on every turn.
   */
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

  /** Drop every cached per-character config. */
  invalidateConfigs(): void {
    this.#charConfigs.clear();
  }

  /**
   * Pin an in-memory config for one character, outranking its file.
   *
   * Deliberately never written back to disk: this is how runtime config
   * commands take effect, and `invalidateConfigs` is how they are undone.
   */
  setRuntimeEffectiveConfig(name: string, config: LoadedConfig): void {
    this.#charConfigs.set(name, config);
  }

  /** Replace the global config, dropping every per-character config with it. */
  setGlobalConfig(config: LoadedConfig): void {
    this.#globalConfig = config;
    this.#charConfigs.clear();
  }

  globalConfig(): LoadedConfig {
    return this.#globalConfig;
  }

  /**
   * Shore's process-level invalidation boundary, run after an explicit config
   * refresh: replace the global config, re-scan, drop the per-character config
   * cache, and discard engines for characters that no longer exist.
   *
   * The summary reports counts, but `characterDiscoveryChanged` compares the
   * **lists** — one character replaced by another is a change even though both
   * counts are equal.
   */
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

  /**
   * Pick a character: the requested one if it exists, or the only one if there
   * is exactly one and none was requested.
   *
   * An empty string is a *request*, not an absence, and fails as not-found —
   * `Option<&str>` distinguishes them and so does this.
   */
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

/**
 * Rust's `Vec<String> != Vec<String>` — positional, not a set compare.
 *
 * Written positionally because that is what the Rust does, though on these
 * inputs the two cannot disagree: `discoverCharacters` sorts and directory
 * names are unique, so two equal-length lists with equal contents are equal
 * element-wise. A mutant that swaps this for a set compare is an unkillable
 * equivalent, and is left in the harness saying so rather than deleted.
 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
