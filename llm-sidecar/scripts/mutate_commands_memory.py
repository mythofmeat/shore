#!/usr/bin/env python3
"""Mutation pass over the `memory` command (#18 / #12).

#12 requires every parity fixture be mutation-checked. This command is a
read-only report, so its failure modes are all quiet ones:

- **Reporting the wrong character's memory.** There is no name argument — the
  command always answers for the session's character — so a path built from
  anything else is undetectable from the response, which echoes back the name it
  was asked about rather than the one it read.
- **Bucketing wrong.** `entries`, `curated_files`, `daily_files` and
  `image_files` are four numbers of the same type in one object. Any permutation
  of them still looks like a plausible answer.
- **Losing the routing.** An empty `query` means *status*. Route it to the
  search instead and the command answers a question nobody asked, with no error.
- **Creating the wrong directory.** Opening the store creates it, so a command
  that builds the wrong path does not just misreport — it leaves a stray
  directory behind. The replay asserts on the directory afterwards for exactly
  this reason.

A mutant is KILLED if `bun test tests/memory_command_parity.test.ts` fails with
it applied.

This is **25/25**, from 25/26 on the first pass — the one survivor was an
equivalent mutant, not a gap, and has been removed rather than chased: passing
`searchText` an already-lowercased query changes nothing, because lowercasing
its argument is the first thing `searchText` does.

The fixture earns the rest by carrying the cases that separate the pairs
that would otherwise agree: a store where the four counts are four *different*
numbers (7/4/2/1, so no permutation survives), a `daily.md` and a
`notes/daily/old.md` that are topic files rather than daily ones (so the bucket
test is a top-level prefix and not a substring), a furnished `mid` alongside an
active `other` (so reading the wrong character's store is visible), and a query
with surrounding whitespace (so the echo is pinned as untrimmed while the search
still matches).

The two error paths are the other half of it. `Failed to open markdown store`
and `Memory query failed` are added by different functions, and a memory path
that is a *file* reaches neither: it opens fine, because a file exists and
canonicalises, and fails in the listing. Three rows, three different messages,
from the same kind of broken tree.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_commands_memory.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/memory.ts"

# (label, find, replace)
MUTANTS = [
    # --- routing --------------------------------------------------------------
    ("routing: an empty query searches rather than reporting status",
     '  return query === undefined || query === ""',
     "  return query === undefined"),
    ("routing: a non-string query is coerced rather than ignored",
     '  const query = asStr(args["query"]);',
     '  const query = args["query"] === undefined ? undefined : String(args["query"]);'),
    ("routing: always status",
     '  return query === undefined || query === ""\n'
     "    ? await memoryStatusCommand(configDir, character)\n"
     "    : await memoryQueryCommand(configDir, character, query);",
     "  return await memoryStatusCommand(configDir, character);"),
    ("routing: always a search",
     '  return query === undefined || query === ""\n'
     "    ? await memoryStatusCommand(configDir, character)\n"
     "    : await memoryQueryCommand(configDir, character, query);",
     '  return await memoryQueryCommand(configDir, character, query ?? "");'),
    ("routing: the two branches are swapped",
     "    ? await memoryStatusCommand(configDir, character)\n"
     "    : await memoryQueryCommand(configDir, character, query);",
     '    ? await memoryQueryCommand(configDir, character, query ?? "")\n'
     "    : await memoryStatusCommand(configDir, character);"),

    # --- which store ----------------------------------------------------------
    ("store: the workspace directory rather than its memory subdirectory",
     "    return await MarkdownMemoryStore.open(characterMemoryDir(configDir, character));",
     "    return await MarkdownMemoryStore.open(\n"
     '      characterMemoryDir(configDir, character).replace(/\\/memory$/, ""),\n'
     "    );"),
    ("store: the config root rather than the character's own directory",
     "    return await MarkdownMemoryStore.open(characterMemoryDir(configDir, character));",
     "    return await MarkdownMemoryStore.open(configDir);"),
    ("store: a fixed character rather than the session's",
     "    return await MarkdownMemoryStore.open(characterMemoryDir(configDir, character));",
     '    return await MarkdownMemoryStore.open(characterMemoryDir(configDir, "mid"));'),

    # --- status: the counts ---------------------------------------------------
    ("status: entries is the topic count rather than the total",
     "    entries: status.totalFiles,",
     "    entries: status.topicFiles,"),
    ("status: entries is the sum of the three buckets computed here",
     "    entries: status.totalFiles,",
     "    entries: status.dailyFiles + status.imageFiles,"),
    ("status: curated_files is the total rather than the topic count",
     "    curated_files: status.topicFiles,",
     "    curated_files: status.totalFiles,"),
    ("status: curated and daily are swapped",
     "    curated_files: status.topicFiles,\n"
     "    daily_files: status.dailyFiles,",
     "    curated_files: status.dailyFiles,\n"
     "    daily_files: status.topicFiles,"),
    ("status: daily and image are swapped",
     "    daily_files: status.dailyFiles,\n"
     "    image_files: status.imageFiles,",
     "    daily_files: status.imageFiles,\n"
     "    image_files: status.dailyFiles,"),
    ("status: image_files is always zero",
     "    image_files: status.imageFiles,",
     "    image_files: 0,"),
    ("status: the character is not echoed back",
     "  return {\n    character,\n    entries: status.totalFiles,",
     '  return {\n    character: "",\n    entries: status.totalFiles,'),

    # --- query: the response --------------------------------------------------
    ("query: the query is trimmed before it is echoed",
     "  return { character, query, result: formatDirectResponse(query, hits) };",
     "  return { character, query: query.trim(), result: formatDirectResponse(query, hits) };"),
    ("query: the rendered text is built from a trimmed query",
     "  return { character, query, result: formatDirectResponse(query, hits) };",
     "  return { character, query, result: formatDirectResponse(query.trim(), hits) };"),
    ("query: the hits are reversed before rendering",
     "  return { character, query, result: formatDirectResponse(query, hits) };",
     "  return { character, query, result: formatDirectResponse(query, [...hits].reverse()) };"),
    ("query: nothing ever matches",
     "    hits = await store.searchText(query);",
     "    hits = [];"),
    ("query: the character is not echoed back",
     "  return { character, query, result: formatDirectResponse(query, hits) };",
     '  return { character: "", query, result: formatDirectResponse(query, hits) };'),

    # --- the error prefixes ---------------------------------------------------
    ("errors: the open failure loses its prefix",
     "    throw internalError(`Failed to open markdown store: ${message(e)}`);",
     "    throw internalError(message(e));"),
    ("errors: the open failure wears the query prefix",
     "    throw internalError(`Failed to open markdown store: ${message(e)}`);",
     "    throw internalError(`Memory query failed: ${message(e)}`);"),
    ("errors: the search failure loses its prefix",
     "    throw internalError(`Memory query failed: ${message(e)}`);",
     "    throw internalError(message(e));"),
    ("errors: the search failure wears the open prefix",
     "    throw internalError(`Memory query failed: ${message(e)}`);",
     "    throw internalError(`Failed to open markdown store: ${message(e)}`);"),
    ("errors: a failed listing gains a prefix the status path does not add",
     "  } catch (e) {\n    throw internalError(message(e));\n  }\n"
     "  return {\n    character,",
     "  } catch (e) {\n"
     "    throw internalError(`Failed to open markdown store: ${message(e)}`);\n  }\n"
     "  return {\n    character,"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/memory_command_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    original = SRC.read_text()
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, find, replace) in enumerate(MUTANTS, 1):
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        SRC.write_text(original.replace(find, replace, 1))
        killed = not run()
        SRC.write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    SRC.write_text(original)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
