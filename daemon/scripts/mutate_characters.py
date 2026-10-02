#!/usr/bin/env python3
"""Mutation pass over `CharacterRegistry`: scanning, the engine, config and
thread caches, reload summaries, and resolving a requested character.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHARACTERS = ROOT / "src/characters.ts"

MUTANTS = [
    # --- discovery and the available cache --------------------------------
    ("scan: construction does not scan",
     "    registry.#available = await registry.#scan();",
     "    registry.#available = [];"),
    ("scan: reload does not re-scan",
     "    const after = await this.#scan();",
     "    const after = this.#available;"),
    ("scan: the workspace is not prepared",
     "        await ensureCharacterWorkspace(",
     "        if (false as boolean) await ensureCharacterWorkspace("),
    ("scan: a failed workspace preparation is fatal",
     "      } catch (e) {\n        shoreLog.warn(\n          `shore: failed to prepare workspace for character ${name}: ${String(e)}`,\n        );\n      }",
     "      } catch (e) {\n        throw e;\n      }"),
    ("scan: an empty conversation keeps the snapshot it inherited",
     "        await resetActivePromptSnapshotIfEmpty(\n"
     "          characterDataDir(this.#dataDir, name),\n"
     "          threadDataDir(this.#dataDir, name, homeThread(index)),\n"
     "          homeThread(index),\n"
     "        );",
     "        void resetActivePromptSnapshotIfEmpty;"),
    ("scan: every character's snapshot is dropped, live conversation or not",
     "        await resetActivePromptSnapshotIfEmpty(\n"
     "          characterDataDir(this.#dataDir, name),\n"
     "          threadDataDir(this.#dataDir, name, homeThread(index)),\n"
     "          homeThread(index),\n"
     "        );",
     '        await (await import("./memory/deferred_edits.ts")).resetActivePromptSnapshot(\n'
     "          characterDataDir(this.#dataDir, name),\n"
     "        );"),
    ("scan: the snapshot is reset under the config dir, not the data dir",
     "        await resetActivePromptSnapshotIfEmpty(\n"
     "          characterDataDir(this.#dataDir, name),\n"
     "          threadDataDir(this.#dataDir, name, homeThread(index)),\n"
     "          homeThread(index),\n"
     "        );",
     "        await resetActivePromptSnapshotIfEmpty(\n"
     "          characterDataDir(this.#configDir, name),\n"
     "          threadDataDir(this.#dataDir, name, homeThread(index)),\n"
     "          homeThread(index),\n"
     "        );"),
    ("available: membership is case insensitive",
     "    return this.#available.includes(name);",
     "    return this.#available.some((n) => n.toLowerCase() === name.toLowerCase());"),
    ("available: membership is a prefix test",
     "    return this.#available.includes(name);",
     "    return this.#available.some((n) => n.startsWith(name));"),

    # --- engines ----------------------------------------------------------
    ("engines: no cache, a fresh engine every time",
     "    const existing = this.#engines.get(key);\n    if (existing !== undefined) return await existing;\n",
     ""),
    ("engines: the cache is not populated",
     "    this.#engines.set(key, loading);\n", ""),
    ("engines: the in-flight load is not shared, so a race makes two engines",
     "    const loading = this.#load(name, id);\n    this.#engines.set(key, loading);",
     "    const loading = Promise.resolve(await this.#load(name, id));\n    this.#engines.set(key, loading);"),
    ("engines: membership is not checked",
     "    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);\n",
     ""),
    ("engines: the cache is consulted before membership",
     "    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);\n\n    const id = thread ?? this.homeThread(name);",
     "    const id = thread ?? this.homeThread(name);\n"
     "    const cached = this.#engines.get(engineKey(name, id));\n"
     "    if (cached !== undefined) return await cached;\n"
     "    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);"),
    ("engines: reload drops all of them, not just the vanished",
     "      if (!afterSet.has(engineCharacter(key))) {",
     "      if (true as boolean) {"),
    ("engines: reload drops none",
     "      if (!afterSet.has(engineCharacter(key))) {",
     "      if (false as boolean) {"),
    ("engines: the drop count is the survivor count",
     "        this.#engines.delete(key);\n        droppedEngines += 1;",
     "        this.#engines.delete(key);"),

    # --- the per-character config cache -----------------------------------
    ("config: no cache",
     "    if (!this.#charConfigs.has(name)) {",
     "    if (true as boolean) {"),
    ("config: absence is not cached",
     "        this.#charConfigs.set(name, loadCharacterConfig(this.#globalConfig, name));",
     "        const c = loadCharacterConfig(this.#globalConfig, name);\n        if (c !== undefined) this.#charConfigs.set(name, c);\n        else return this.#globalConfig;"),
    ("config: a load failure falls back to the global instead of throwing",
     "      } catch (e) {\n        throw new CharacterConfigError(name, e);\n      }",
     "      } catch (e) {\n        return this.#globalConfig;\n      }"),
    ("config: a load failure is cached",
     "      } catch (e) {\n        throw new CharacterConfigError(name, e);\n      }",
     "      } catch (e) {\n        this.#charConfigs.set(name, this.#globalConfig);\n        throw new CharacterConfigError(name, e);\n      }"),
    ("config: membership is checked",
     "  effectiveConfig(name: string): LoadedConfig {",
     "  effectiveConfig(name: string): LoadedConfig {\n    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);"),
    ("config: setGlobalConfig keeps the per-character cache",
     "    this.#globalConfig = config;\n    this.#charConfigs.clear();\n  }\n\n  globalConfig()",
     "    this.#globalConfig = config;\n  }\n\n  globalConfig()"),
    ("config: reload keeps the per-character cache",
     "    this.#globalConfig = config;\n    this.#charConfigs.clear();\n    this.#available = after;",
     "    this.#globalConfig = config;\n    this.#available = after;"),
    ("config: the runtime override does not take",
     "  setRuntimeEffectiveConfig(name: string, config: LoadedConfig): void {\n    this.#charConfigs.set(name, config);",
     "  setRuntimeEffectiveConfig(name: string, config: LoadedConfig): void {"),
    ("config: the override is merged against the registry's own dir",
     "        this.#charConfigs.set(name, loadCharacterConfig(this.#globalConfig, name));",
     "        this.#charConfigs.set(\n          name,\n          loadCharacterConfig({ ...this.#globalConfig, dirs: { ...this.#globalConfig.dirs, config: this.#configDir } }, name),\n        );"),

    # --- reload summary ---------------------------------------------------
    ("summary: before and after are swapped",
     "      availableBefore: before.length,\n      availableAfter: after.length,",
     "      availableBefore: after.length,\n      availableAfter: before.length,"),
    ("summary: discovery_changed compares counts, not names",
     "      characterDiscoveryChanged: !sameList(before, after),",
     "      characterDiscoveryChanged: before.length !== after.length,"),
    ("summary: discovery_changed is a set compare (EQUIVALENT — both lists come "
     "from discoverCharacters, which returns a de-duplicated, code-point-sorted "
     "array, so for equal lengths set containment and element-wise equality agree; "
     "the ordered compare is kept because sameList is a general helper)",
     "  return a.length === b.length && a.every((item, i) => item === b[i]);",
     "  return a.length === b.length && a.every((item) => b.includes(item));"),
    ("summary: discovery_changed is inverted",
     "      characterDiscoveryChanged: !sameList(before, after),",
     "      characterDiscoveryChanged: sameList(before, after),"),
    ("summary: `before` is the new list, not the old one",
     "    const before = this.#available;\n    const after = await this.#scan();",
     "    const after = await this.#scan();\n    const before = after;"),

    # --- resolveCharacter -------------------------------------------------
    ("resolve: an empty request is treated as absent",
     "    if (requested !== undefined) {",
     "    if (requested !== undefined && requested !== \"\") {"),
    ("resolve: a bad request auto-selects instead of failing",
     "      throw CharacterError.notFound(requested, this.#available);",
     "      if (this.#available.length === 1) return this.#available[0] as string;\n      throw CharacterError.notFound(requested, this.#available);"),
    ("resolve: empty and ambiguous are swapped",
     "      throw CharacterError.noneAvailable(this.#configDir, this.#workspaceRoot());",
     "      throw CharacterError.ambiguous(this.#available);"),
    ("resolve: two characters auto-select the first",
     "    const only = this.#available.length === 1 ? this.#available[0] : undefined;",
     "    const only = this.#available.length >= 1 ? this.#available[0] : undefined;"),
    ("resolve: the not-found message omits the available list",
     "      `character ${JSON.stringify(name)} not found (available: ${CharacterError.#list(available)})`,",
     "      `character ${JSON.stringify(name)} not found`,"),
    ("resolve: the available list is rendered without quotes",
     "    return `[${available.map((n) => JSON.stringify(n)).join(\", \")}]`;",
     "    return `[${available.join(\", \")}]`;"),
    ("resolve: the ambiguous message names the wrong flag",
     '        "specify one with --character or SHORE_CHARACTER",',
     '        "specify one with --name or SHORE_NAME",'),
    ("resolve: the none-available message loses how to create one",
     '      `no characters available — create one at ${soul}, ` +\n        "or run: shore character --new <name>",',
     '      `no characters available — create one at ${soul}`,'),
    ("resolve: the error kind is always not_found",
     '    return new CharacterError(\n      "ambiguous",',
     '    return new CharacterError(\n      "not_found",'),

    # --- threads ----------------------------------------------------------
    ("threads: the index is not cached at scan time",
     "        const index = await this.#withThreadIndex(name, async () =>\n"
     "          this.#remember(name, await ensureThreads(this.#dataDir, name, new Date().toISOString())),\n"
     "        );",
     "        const index = await this.#withThreadIndex(name, async () =>\n"
     "          await ensureThreads(this.#dataDir, name, new Date().toISOString()),\n"
     "        );"),
    ("threads: an unqualified call opens main rather than home",
     "    const id = thread ?? this.homeThread(name);",
     "    const id = thread ?? MAIN_THREAD;"),
    ("threads: the thread is not part of the engine key",
     "function engineKey(name: string, thread: string): string {\n"
     "  return `${name}${ENGINE_KEY_SEPARATOR}${thread}`;\n"
     "}",
     "function engineKey(name: string, thread: string): string {\n"
     "  void thread;\n"
     "  return name;\n"
     "}"),
    ("threads: an unknown thread opens an empty conversation instead of failing",
     "    if (thread !== undefined && index !== undefined && threadRecord(index, thread) === undefined) {\n"
     "      throw new ThreadError(\"not_found\", `no thread ${JSON.stringify(thread)} for ${name}`);\n"
     "    }\n",
     ""),
    ("threads: the guard also rejects the home thread when it is named",
     "    if (thread !== undefined && index !== undefined && threadRecord(index, thread) === undefined) {",
     "    if (thread !== undefined && index !== undefined && thread !== index.home) {"),
    ("threads: archiving leaves the cached engine behind",
     "    this.#engines.delete(engineKey(name, id));\n", ""),
    ("threads: archiving does not refresh the cached index",
     "      this.#engines.delete(engineKey(name, id));\n"
     "      return this.#remember(name, index);",
     "      this.#engines.delete(engineKey(name, id));\n"
     "      return index;"),
    ("threads: moving home does not refresh the cached index",
     "      async () =>\n"
     "        this.#remember(\n"
     "          name,\n"
     "          await setHomeThread(this.#dataDir, name, id, new Date().toISOString()),\n"
     "        ),",
     "      async () => await setHomeThread(this.#dataDir, name, id, new Date().toISOString()),"),
    ("threads: a vanished character keeps its cached index",
     "    for (const name of Array.from(this.#threads.keys())) {\n"
     "      if (!afterSet.has(name)) this.#threads.delete(name);\n"
     "    }\n",
     ""),

    ("engines: the engine is opened against the config dir",
     "    const engine = await ConversationEngine.load(name, this.#dataDir, this.#onHistory, thread);",
     "    const engine = await ConversationEngine.load(name, this.#configDir, this.#onHistory, thread);"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(
        MUTANTS,
        ["tests/characters.test.ts", "tests/registry_threads.test.ts"],
        src=CHARACTERS,
    )


if __name__ == "__main__":
    sys.exit(main())
