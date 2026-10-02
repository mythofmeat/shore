#!/usr/bin/env python3
"""Mutation pass over thread initialization, selection, and archiving."""
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

    ("initialization: a fresh character gets no thread directory",
     "    await mkdir(threadDataDir(data, character, MAIN_THREAD), { recursive: true });\n",
     ""),
    ("initialization: ensureThreads writes an index even for a dry run",
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

    # --- home and labels ---------------------------------------------------
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

    # --- archiving ----------------------------------------------------------
    ("archive: the home thread can be archived out from under the heartbeat",
     '\n    if (index.home === id) {\n      throw new ThreadError(\n        "is_home",',
     '  if (false as boolean) {\n    throw new ThreadError(\n      "is_home",'),
    ("archive: an unknown thread archives silently",
     '\n    requireThread(index, character, id);\n    if (index.home === id) {',
     '  if (index.home === id) {'),
    ("archive: the messages land under the bare character key",
     "        archiveKey: archiveKey(character, id),",
     "        archiveKey: character,"),
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
     '        0,\n        active,',
     '        1,\n        active,'),
    ("archive: the thread directory is left on disk",
     "  await rm(dir, { recursive: true, force: true });\n", ""),
    ("archive: the entry stays in the index",
     "    threads: index.threads.filter((t) => t.id !== id),",
     "    threads: index.threads,"),
    ("archive: every other thread is dropped instead",
     "    threads: index.threads.filter((t) => t.id !== id),",
     "    threads: index.threads.filter((t) => t.id === id),"),
    ("archive: an unreadable active window is fatal",
     '\n    } catch {\n      active = "";\n    }',
     '  } catch (e) {\n    throw e;\n  }'),

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

    # --- how far along a thread is ------------------------------------------
    ("turns: tool results are counted as turns the user took",
     "  return !Array.isArray(msg.content_blocks) || !isToolResultOnly(msg);",
     "  return true;"),
    ("turns: assistant replies are counted too, so every thread reads twice as long",
     '  if (msg.role !== "user") return false;',
     "  if (false as boolean) return false;"),
    ("turns: a line with no blocks at all is dropped rather than counted",
     "  return !Array.isArray(msg.content_blocks) || !isToolResultOnly(msg);",
     "  return Array.isArray(msg.content_blocks) && !isToolResultOnly(msg);"),
    ("turns: a thread that was never opened fails instead of counting zero",
     "  try {\n"
     '    raw = readDurable(threadFile(data, character, id, \"active.jsonl\"));\n'
     "  } catch {\n"
     "    return 0;\n"
     "  }",
     '  raw = readDurable(threadFile(data, character, id, \"active.jsonl\"));'),
    ("turns: a torn tail line stops the count instead of being skipped",
     "    try {\n"
     "      parsed = JSON.parse(line);\n"
     "    } catch {\n"
     "      continue;\n"
     "    }",
     "    parsed = JSON.parse(line);"),
    ("turns: every thread is counted against home's window",
     "    raw = readDurable(threadFile(data, character, id, \"active.jsonl\"));",
     "    raw = readDurable(threadFile(data, character, MAIN_THREAD, \"active.jsonl\"));"),
    ("turns: the roster is counted, but every entry gets the first thread's count",
     "    ids.map(async (id) => [id, await threadTurnCount(data, character, id)] as const),",
     "    ids.map(async (id) => [id, await threadTurnCount(data, character, ids[0] ?? id)] as const),"),

    # --- archiving lets go of the SDK session too ----------------------------
    ("archive: the SDK session outlives the thread, so a new one of the same name resumes it",
     "  forgetThreadSessions(data, character, id);\n",
     ""),
    ("archive: archiving one thread forgets home's session as well",
     "  forgetThreadSessions(data, character, id);",
     "  forgetThreadSessions(data, character, MAIN_THREAD);"),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/threads.test.ts"], src=THREADS)


if __name__ == "__main__":
    sys.exit(main())
