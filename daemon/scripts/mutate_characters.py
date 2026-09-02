#!/usr/bin/env python3
"""Mutation pass over the CharacterRegistry port (#18 / #12).

#12 requires every parity fixture be mutation-checked, on the evidence that
five ports in a row had a fixture replay green while still full of holes.

Almost every decision in `characters.ts` is a *cache* decision — whether the
second call sees the first one's work, and which of four operations drops which
of three caches. None of it is visible from a single call, so the fixture is
scripted runs and this harness is the check that the scripts actually reach the
decisions they were written for.

A mutant is KILLED if `bun test tests/characters.test.ts` fails with it
applied; a survivor means either the fixture cannot see that decision, or the
code is equivalent under it.

The first pass was 39/44. One survivor was a no-op mutant of mine — `#scan()`
returns the list rather than assigning it, so reading `#available` on either
side of the call is the same read; it was rewritten to lose the old list, which
is the mutant that matters. Three were real fixture gaps and are now scenarios:
no character whose workspace preparation *fails*, so a fatal handler survived;
no config that failed to load and was then FIXED without an invalidation, so
"the failure is cached too" was unreachable; and nothing recorded about an
engine beyond its identity, so opening it against the wrong root was invisible
— the generator now records which root and leaf it was opened under.

The last survivor is a true equivalent and is kept: `discovery_changed` compares
lists positionally, and a set compare cannot disagree on sorted lists of unique
directory names. It is noted at the call site in `characters.ts`.

Run from the repository root:
    python3 daemon/scripts/mutate_characters.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHARACTERS = ROOT / "src/characters.ts"

# (label, find, replace)
MUTANTS = [
    # --- discovery and the available cache --------------------------------
    ("scan: construction does not scan",
     "    registry.#available = await registry.#scan();",
     "    registry.#available = [];"),
    ("scan: refresh does not re-scan",
     "  async refresh(): Promise<void> {\n    this.#available = await this.#scan();",
     "  async refresh(): Promise<void> {\n    await this.#scan();"),
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
     "        await resetActivePromptSnapshotIfEmpty(characterDataDir(this.#dataDir, name));",
     "        void resetActivePromptSnapshotIfEmpty;"),
    ("scan: every character's snapshot is dropped, live conversation or not",
     "        await resetActivePromptSnapshotIfEmpty(characterDataDir(this.#dataDir, name));",
     '        await (await import("./memory/deferred_edits.ts")).resetActivePromptSnapshot(\n'
     "          characterDataDir(this.#dataDir, name),\n"
     "        );"),
    ("scan: the snapshot is reset under the config dir, not the data dir",
     "        await resetActivePromptSnapshotIfEmpty(characterDataDir(this.#dataDir, name));",
     "        await resetActivePromptSnapshotIfEmpty(characterDataDir(this.#configDir, name));"),
    ("available: membership is case insensitive",
     "    return this.#available.includes(name);",
     "    return this.#available.some((n) => n.toLowerCase() === name.toLowerCase());"),
    ("available: membership is a prefix test",
     "    return this.#available.includes(name);",
     "    return this.#available.some((n) => n.startsWith(name));"),

    # --- engines ----------------------------------------------------------
    ("engines: no cache, a fresh engine every time",
     "    const existing = this.#engines.get(name);\n    if (existing !== undefined) return await existing;\n",
     ""),
    ("engines: the cache is not populated",
     "    this.#engines.set(name, loading);\n", ""),
    ("engines: the in-flight load is not shared, so a race makes two engines",
     "    const loading = this.#load(name);\n    this.#engines.set(name, loading);",
     "    const loading = Promise.resolve(await this.#load(name));\n    this.#engines.set(name, loading);"),
    ("engines: membership is not checked",
     "    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);\n",
     ""),
    ("engines: the cache is consulted before membership",
     "    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);\n\n    const existing = this.#engines.get(name);\n    if (existing !== undefined) return await existing;",
     "    const existing = this.#engines.get(name);\n    if (existing !== undefined) return await existing;\n    if (!this.hasCharacter(name)) throw new EngineCharacterNotFound(name);"),
    ("engines: refresh drops them like a reload does",
     "  async refresh(): Promise<void> {\n    this.#available = await this.#scan();",
     "  async refresh(): Promise<void> {\n    this.#available = await this.#scan();\n    for (const n of [...this.#engines.keys()]) {\n      if (!this.#available.includes(n)) this.#engines.delete(n);\n    }"),
    ("engines: reload drops all of them, not just the vanished",
     "      if (!afterSet.has(name)) {",
     "      if (true as boolean) {"),
    ("engines: reload drops none",
     "      if (!afterSet.has(name)) {",
     "      if (false as boolean) {"),
    ("engines: the drop count is the survivor count",
     "        this.#engines.delete(name);\n        droppedEngines += 1;",
     "        this.#engines.delete(name);"),

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
    ("config: invalidateConfigs does nothing",
     "  invalidateConfigs(): void {\n    this.#charConfigs.clear();",
     "  invalidateConfigs(): void {"),
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
    # NOT a reordering: `#scan()` returns the list rather than assigning it, so
    # reading `#available` on either side of the call gives the same value. The
    # mutant that matters is the one that loses the old list entirely.
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

    # --- definitions ------------------------------------------------------
    ("definition: the character definition reads the user file",
     "    return loadCharacterDefinition(this.#configDir, name, this.#workspaceRoot());",
     "    return resolveUserDefinition(this.#configDir, name, this.#workspaceRoot());"),
    ("definition: the user definition reads the character file",
     "    return resolveUserDefinition(this.#configDir, name, this.#workspaceRoot());",
     "    return loadCharacterDefinition(this.#configDir, name, this.#workspaceRoot());"),
    ("definition: definitions are read from the data dir",
     "    return loadCharacterDefinition(this.#configDir, name, this.#workspaceRoot());",
     "    return loadCharacterDefinition(this.#dataDir, name, this.#workspaceRoot());"),
    ("engines: the engine is opened against the config dir",
     "    const engine = await ConversationEngine.load(name, this.#dataDir, this.#onHistory);",
     "    const engine = await ConversationEngine.load(name, this.#configDir, this.#onHistory);"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/characters.test.ts"], src=CHARACTERS)


if __name__ == "__main__":
    sys.exit(main())
