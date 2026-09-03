#!/usr/bin/env python3
"""Mutation pass over the thread index and its migration (#12).

`engine/threads.ts` shipped in stage 02 with no direct tests — it was covered
only through 136 fixture paths and one hand-run migration over the live data
directory. That is the wrong shape of evidence for the one module in the feature
that *moves a user's conversation on disk*: a fixture path proves where the code
reads, not that the move is ordered so an interrupted run can be resumed.

The decisions here are almost all orderings and refusals — the index is written
last so a crash mid-move leaves the character un-migrated rather than
half-migrated; the destination is checked before each rename so a partial run
does not clobber what it already moved; the home thread refuses to be archived
so the heartbeat always has somewhere to speak. None of those are visible from a
single successful call, which is exactly the class of hole this harness exists
to find.

A mutant is KILLED if `bun test tests/threads.test.ts` fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_threads.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
THREADS = ROOT / "src/engine/threads.ts"

# (label, find, replace)
MUTANTS = [
    # --- thread ids become path segments, so the pattern is a boundary ------
    ("ids: any non-empty string is a thread id",
     "  return id.length > 0 && id.length <= MAX_THREAD_ID_LENGTH && THREAD_ID.test(id);",
     "  return id.length > 0;"),
    ("ids: the length bound is dropped",
     "  return id.length > 0 && id.length <= MAX_THREAD_ID_LENGTH && THREAD_ID.test(id);",
     "  return id.length > 0 && THREAD_ID.test(id);"),
    ("ids: the bound is exclusive",
     "id.length <= MAX_THREAD_ID_LENGTH",
     "id.length < MAX_THREAD_ID_LENGTH"),
    ("ids: the pattern is unanchored, so a path-shaped id passes",
     "const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;",
     "const THREAD_ID = /[A-Za-z0-9][A-Za-z0-9._-]*/;"),
    ("ids: the first character may be a dot or a dash",
     "const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;",
     "const THREAD_ID = /^[A-Za-z0-9._-]+$/;"),
    ("ids: a separator is an ordinary character",
     "const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;",
     "const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._\\/-]*$/;"),
    ("ids: the assertion never fires",
     "  if (isValidThreadId(id)) return;",
     "  if (true as boolean) return;"),

    # --- the migration is resumable only if the index is written last -------
    ("migration: a migrated character is migrated again",
     "  if (existsSync(characterThreadsIndex(data, character))) return false;\n",
     ""),
    ("migration: the index is written before the move, not after",
     "  await mkdir(to, { recursive: true });\n"
     "  for (const entry of moving) {\n"
     "    await rename(rustJoin(from, entry), rustJoin(to, entry));\n"
     "  }\n"
     "  await writeThreadsIndex(data, character, defaultThreadsIndex(now));",
     "  await mkdir(to, { recursive: true });\n"
     "  await writeThreadsIndex(data, character, defaultThreadsIndex(now));\n"
     "  for (const entry of moving) {\n"
     "    await rename(rustJoin(from, entry), rustJoin(to, entry));\n"
     "  }"),
    ("migration: a half-moved entry is moved over the one already there",
     "    (entry) => existsSync(rustJoin(from, entry)) && !existsSync(rustJoin(to, entry)),",
     "    (entry) => existsSync(rustJoin(from, entry)),"),
    ("migration: an absent entry is renamed anyway",
     "    (entry) => existsSync(rustJoin(from, entry)) && !existsSync(rustJoin(to, entry)),",
     "    (entry) => !existsSync(rustJoin(to, entry)),"),
    ("migration: the archived segments are left behind",
     '  "active.jsonl",\n  "segments",',
     '  "active.jsonl",'),
    ("migration: the active conversation is left behind",
     '  "active.jsonl",\n  "segments",',
     '  "segments",'),
    ("migration: the whole character directory is swept in",
     "  const moving = MIGRATED_ENTRIES.filter(",
     "  const moving = (await import(\"node:fs/promises\")).readdir === undefined\n"
     "    ? []\n"
     "    : ([...MIGRATED_ENTRIES, \"preferences.json\"] as readonly string[]).filter("),
    ("migration: the dry run moves anyway",
     "  if (dryRun) {\n"
     "    shoreLog.warn(",
     "  if (false as boolean) {\n"
     "    shoreLog.warn("),
    ("migration: the dry run reports that it migrated",
     "    return false;\n  }\n\n  await mkdir(to, { recursive: true });",
     "    return true;\n  }\n\n  await mkdir(to, { recursive: true });"),
    ("migration: ensureThreads never migrates first",
     "  await migrateCharacterToThreads(data, character, now, dryRun);\n",
     ""),
    ("migration: a fresh character gets no thread directory",
     "    await mkdir(threadDataDir(data, character, MAIN_THREAD), { recursive: true });\n",
     ""),
    ("migration: ensureThreads writes an index even for a dry run",
     "  if (!dryRun) {\n"
     "    await mkdir(threadDataDir(data, character, MAIN_THREAD), { recursive: true });\n"
     "    await writeThreadsIndex(data, character, fresh);\n"
     "  }",
     "  await mkdir(threadDataDir(data, character, MAIN_THREAD), { recursive: true });\n"
     "  await writeThreadsIndex(data, character, fresh);"),

    # --- home resolution is the heartbeat's address -------------------------
    ("home: a home pointing at nothing is honoured",
     "  return threadRecord(index, index.home) === undefined ? MAIN_THREAD : index.home;",
     "  return index.home;"),
    ("home: home is always main",
     "  return threadRecord(index, index.home) === undefined ? MAIN_THREAD : index.home;",
     "  return MAIN_THREAD;"),
    ("home: a missing index throws rather than falling back",
     "  if (index === undefined) return MAIN_THREAD;\n"
     "  return threadRecord(index, index.home) === undefined ? MAIN_THREAD : index.home;",
     "  return threadRecord(index, index.home) === undefined ? MAIN_THREAD : index.home;"),
    ("index: a corrupt index is fatal rather than absent",
     "    return isThreadsIndex(raw) ? raw : undefined;\n  } catch {\n    return undefined;\n  }",
     "    return isThreadsIndex(raw) ? raw : undefined;\n  } catch (e) {\n    throw e;\n  }"),
    ("index: any json shape is accepted as an index",
     "    return isThreadsIndex(raw) ? raw : undefined;",
     "    return raw as ThreadsIndex;"),
    ("index: a future version is read as this one",
     '  if (v["version"] !== 1) return false;\n',
     ""),
    ("index: the file is written without a trailing newline",
     '`${JSON.stringify(index, null, 2)}\\n`',
     'JSON.stringify(index, null, 2)'),

    # --- creation -----------------------------------------------------------
    ("create: a duplicate id is allowed",
     "  if (threadRecord(index, id) !== undefined) {\n"
     "    throw new ThreadError(\"exists\", `thread ${JSON.stringify(id)} already exists for ${character}`);\n"
     "  }\n",
     ""),
    ("create: the id is not validated",
     "  assertThreadId(id);\n", ""),
    ("create: the directory is not made",
     "  await mkdir(threadDataDir(data, character, id), { recursive: true });\n", ""),
    ("create: new threads compact on schedule by default",
     "    compaction: options.compaction ?? false,",
     "    compaction: options.compaction ?? true,"),
    ("create: the new thread replaces the existing list",
     "  const next: ThreadsIndex = { ...index, threads: [...index.threads, record] };",
     "  const next: ThreadsIndex = { ...index, threads: [record] };"),
    ("create: the new thread is not persisted",
     "  await writeThreadsIndex(data, character, next);\n  return next;\n}\n\nfunction requireThread(",
     "  return next;\n}\n\nfunction requireThread("),

    # --- home, labels and activity -----------------------------------------
    ("home: it can be pointed at a thread that does not exist",
     "  requireThread(index, character, id);\n  const next: ThreadsIndex = { ...index, home: id };",
     "  const next: ThreadsIndex = { ...index, home: id };"),
    ("label: clearing writes an empty label instead of removing it",
     "  const record: ThreadRecord = label === undefined ? rest : { ...rest, label };",
     '  const record: ThreadRecord = { ...rest, label: label ?? "" };'),
    ("label: setting a label is dropped",
     "  const record: ThreadRecord = label === undefined ? rest : { ...rest, label };",
     "  const record: ThreadRecord = rest;"),
    ("label: the whole list is replaced by the edited record",
     "  return { ...index, threads: index.threads.map((t) => (t.id === record.id ? record : t)) };",
     "  return { ...index, threads: [record] };"),
    ("touch: activity is not recorded",
     "  const next = replaceThread(index, { ...current, last_active: now });\n"
     "  await writeThreadsIndex(data, character, next);\n"
     "  return next;",
     "  return index;"),

    # --- archiving ----------------------------------------------------------
    ("archive: the home thread can be archived out from under the heartbeat",
     "  if (index.home === id) {\n"
     "    throw new ThreadError(\n"
     '      "is_home",',
     "  if (false as boolean) {\n"
     "    throw new ThreadError(\n"
     '      "is_home",'),
    ("archive: an unknown thread archives silently",
     "  requireThread(index, character, id);\n  if (index.home === id) {",
     "  if (index.home === id) {"),
    ("archive: the messages land under the bare character key",
     "        character: archiveKey(character, id),",
     "        character,"),
    ("archive: an empty conversation still writes a segment (EQUIVALENT — "
     "archiveAndRetain over empty content archives nothing: it writes no segment "
     "and no database row, and the empty active file it rewrites is inside the "
     "directory removed on the next line, so the guard is a shortcut, not a "
     "correctness boundary)",
     '  if (active.trim() !== "") {',
     "  if (true as boolean) {"),
    ("archive: the messages are dropped instead of archived",
     '  if (active.trim() !== "") {',
     "  if (false as boolean) {"),
    ("archive: the conversation is retained rather than fully archived",
     "    await archiveAndRetain(\n      dir,\n      0,",
     "    await archiveAndRetain(\n      dir,\n      1,"),
    ("archive: the thread directory is left on disk",
     "  await rm(dir, { recursive: true, force: true });\n", ""),
    ("archive: the entry stays in the index",
     "    threads: index.threads.filter((t) => t.id !== id),",
     "    threads: index.threads,"),
    ("archive: every other thread is dropped instead",
     "    threads: index.threads.filter((t) => t.id !== id),",
     "    threads: index.threads.filter((t) => t.id === id),"),
    ("archive: an unreadable active window is fatal",
     "  } catch {\n    active = \"\";\n  }",
     "  } catch (e) {\n    throw e;\n  }"),

    # --- the per-thread model -------------------------------------------------
    ("model: clearing a pin leaves the old model in place",
     "  const record: ThreadRecord = model === undefined ? rest : { ...rest, chat_model: model };",
     "  const record: ThreadRecord = model === undefined ? current : { ...rest, chat_model: model };"),
    ("model: setting a pin clears it instead",
     "  const record: ThreadRecord = model === undefined ? rest : { ...rest, chat_model: model };",
     "  const record: ThreadRecord = rest;"),
    ("model: pinning a thread that does not exist creates one",
     "export async function setThreadModel(\n"
     "  data: string,\n"
     "  character: string,\n"
     "  id: string,\n"
     "  model: string | undefined,\n"
     "  now: string,\n"
     "): Promise<ThreadsIndex> {\n"
     "  const index = await ensureThreads(data, character, now);\n"
     "  const current = requireThread(index, character, id);",
     "export async function setThreadModel(\n"
     "  data: string,\n"
     "  character: string,\n"
     "  id: string,\n"
     "  model: string | undefined,\n"
     "  now: string,\n"
     "): Promise<ThreadsIndex> {\n"
     "  const index = await ensureThreads(data, character, now);\n"
     "  const current = threadRecord(index, id) ?? { id, created_at: now, compaction: false };"),
    ("model: the pin is never written to disk",
     "  const next = replaceThread(index, record);\n"
     "  await writeThreadsIndex(data, character, next);\n"
     "  return next;\n"
     "}\n\n"
     "export async function threadChatModel(",
     "  const next = replaceThread(index, record);\n"
     "  return next;\n"
     "}\n\n"
     "export async function threadChatModel("),
    ("model: an omitted thread reads main rather than wherever home points",
     "  return threadRecord(index, thread ?? homeThread(index))?.chat_model;",
     "  return threadRecord(index, thread ?? MAIN_THREAD)?.chat_model;"),
    ("model: every thread reads the home thread's pin",
     "  return threadRecord(index, thread ?? homeThread(index))?.chat_model;",
     "  return threadRecord(index, homeThread(index))?.chat_model;"),
    ("model: a character with no index reports the first pin it can find",
     "  const index = await readThreadsIndex(data, character);\n"
     "  if (index === undefined) return undefined;\n"
     "  return threadRecord(index, thread ?? homeThread(index))?.chat_model;",
     "  const index = await readThreadsIndex(data, character);\n"
     "  return index?.threads.find((t) => t.chat_model !== undefined)?.chat_model;"),
    ("model: the roster lookup matches on label rather than id",
     "  return records.find((t) => t.id === thread)?.chat_model;",
     "  return records.find((t) => t.label === thread)?.chat_model;"),
    ("model: the roster lookup returns the first thread's pin whatever was asked for",
     "  return records.find((t) => t.id === thread)?.chat_model;",
     "  return records[0]?.chat_model;"),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/threads.test.ts"], src=THREADS)


if __name__ == "__main__":
    sys.exit(main())
