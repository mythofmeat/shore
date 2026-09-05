#!/usr/bin/env python3
"""Mutation pass over branching a thread into its own context (#203).

A fork is a snapshot operation over a live conversation, so almost every
decision in `engine/fork.ts` is an ordering or a refusal rather than a value
another test would notice. The child's context is written before its provenance,
and its provenance before the registry entry, so an interrupted run can only
ever leave a child that recovery can finish or throw away — never one the user
can open and find empty. The destination is checked under the same lock that
publishes it, so two forks racing for one name cannot both win. Versions are
minted onto the source first, because a copy that shares no identity with what
it was copied from is a duplicate rather than a branch, and every downstream
guarantee — recall showing a shared message once, memory processing running over
it once — rests on that identity.

None of that shows up in a single successful fork, which is exactly the class of
hole this harness exists to find.

A mutant is KILLED if `bun test tests/thread_fork.test.ts` fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_fork.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FORK = ROOT / "src/engine/fork.ts"
VERSIONS = ROOT / "src/engine/versions.ts"

# (label, find, replace)
MUTANTS = [
    # --- what the snapshot takes --------------------------------------------
    ("scope: a turn count is ignored, so every fork copies everything",
     "  const start = tailTurnStart(messages, turns);",
     "  const start = 0;"),
    ("scope: the cut lands one turn late, dropping the turn that was asked for",
     VERSIONS,
     "  return required(indices[indices.length - turns]);",
     "  return required(indices[indices.length - turns + 1] ?? indices[indices.length - turns]);"),
    ("scope: asking for every turn there is drops the context before the first one",
     VERSIONS,
     "  if (indices.length === 0 || turns >= indices.length) return 0;",
     "  if (indices.length === 0) return 0;"),
    ("scope: a tool result is read as a turn the user took",
     VERSIONS,
     "  return blocks.length === 0 || !blocks.every((block) => block.type === \"tool_result\");",
     "  return true;"),
    ("scope: a tool result travels without the call that produced it",
     "  return withoutOrphanToolResults(messages.slice(start));",
     "  return [...messages.slice(start)];"),

    # --- identity is what makes a copy a branch ------------------------------
    ("identity: the copy gets fresh versions, so it is a duplicate not a branch",
     "    const version = versionOf(message) ?? minted.get(message.msg_id);\n"
     "    return version === undefined ? message : { ...message, version };",
     "    return { ...message, version: newMessageVersion() };"),
    ("identity: the source keeps no version, so the two sides never share one",
     "  if (minted.size === 0) return minted;\n"
     "  await store.stampVersions(minted);",
     "  if (minted.size === 0) return minted;"),
    ("identity: an existing version is overwritten rather than carried across "
     "(EQUIVALENT: stampVersions skips a message that already has one, and the copy "
     "prefers the message's own version over the minted map, so overwriting the map "
     "changes nothing either side can see)",
     "    if (versionOf(message) === undefined) minted.set(message.msg_id, newMessageVersion());",
     "    minted.set(message.msg_id, newMessageVersion());"),

    # --- refusals ------------------------------------------------------------
    ("refusal: an existing thread name is forked over rather than refused",
     '    throw new ThreadError("exists", `thread ${JSON.stringify(child)} already exists for ${character}`);',
     "    void 0;"),
    ("refusal: a directory that already holds data is written over",
     "  if (existsSync(childDir) && (await readdir(childDir)).length > 0) {",
     "  if (false as boolean) {"),
    ("refusal: an unknown source is forked from as if it were empty",
     "  if (sourceRecord === undefined) {\n"
     '    throw new ThreadError("not_found", `no thread ${JSON.stringify(source)} for ${character}`);\n'
     "  }\n",
     ""),
    ("refusal: a compaction mid-flight is forked across anyway",
     "  if (pendingCompactionFor(dbPath, archiveKeys)) {",
     "  if (false as boolean) {"),
    ("refusal: only the source thread's own archive is checked for a pending compaction",
     "  const archiveKeys = index.threads.map((record) => archiveKey(character, record.id));",
     "  const archiveKeys = [archiveKey(character, source)];"),
    ("refusal: an invalid destination id is accepted",
     "  assertThreadId(child);\n",
     ""),

    # --- ordering, so an interrupted fork is recoverable ---------------------
    ("ordering: the registry publishes the child before its context is written",
     "  await mkdir(childDir, { recursive: true });\n"
     "  await writeFile(join(childDir, FORK_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\\n`, \"utf8\");",
     "  await mkdir(childDir, { recursive: true });"),
    ("ordering: the child is published before its provenance is durable",
     "  const historyStore = HistoryStore.open(dbPath);\n"
     "  try {\n"
     "    historyStore.recordThreadFork(character, forkRecordOf(marker));\n"
     "  } finally {\n"
     "    historyStore.close();\n"
     "  }\n",
     ""),
    ("ordering: the marker is cleared before the registry entry is written",
     "  await writeThreadsIndex(data, character, published);\n"
     '  if (options.failAfter === "publish") throw new Error("injected fork failure after publish");\n'
     "\n"
     "  await rm(join(childDir, FORK_MARKER_FILE), { force: true });",
     "  await rm(join(childDir, FORK_MARKER_FILE), { force: true });\n"
     "  await writeThreadsIndex(data, character, published);"),
    ("ordering: two forks of one character run concurrently",
     "  return await withForkLock(\n"
     "    `${data}\\u0000${character}`,\n"
     "    async () => await forkThreadLocked(data, character, source, child, options),\n"
     "  );",
     "  return await forkThreadLocked(data, character, source, child, options);"),

    # --- recovery ------------------------------------------------------------
    ("recovery: an unpublished child is left behind instead of removed",
     "    await rm(dir, { recursive: true, force: true });",
     "    void dir;"),
    ("recovery: an unpublished child's provenance outlives the child",
     "        store.forgetThreadFork(character, marker.fork_id);",
     "        void marker;"),
    ("recovery: a published child is thrown away rather than finished",
     "    if (index !== undefined && threadRecord(index, entry) !== undefined) {\n"
     "      await rm(join(dir, FORK_MARKER_FILE), { force: true });",
     "    if (false as boolean) {\n"
     "      await rm(join(dir, FORK_MARKER_FILE), { force: true });"),
    ("recovery: a finished fork's marker is left in place, so it is rolled back later",
     "  await rm(join(childDir, FORK_MARKER_FILE), { force: true });\n"
     "  return { index: published, fork: marker, child: record };",
     "  return { index: published, fork: marker, child: record };"),

    # --- what the child inherits ---------------------------------------------
    ("inheritance: the child ignores the source's compaction setting",
     "    compaction: sourceRecord.compaction,",
     "    compaction: false,"),
    ("inheritance: the child ignores the source's model pin",
     "    ...(sourceRecord.chat_model === undefined ? {} : { chat_model: sourceRecord.chat_model }),",
     "    ...{},"),
    ("inheritance: creating a child moves the heartbeat home to it",
     "  const published: ThreadsIndex = { ...index, threads: [...index.threads, record] };",
     "  const published: ThreadsIndex = { ...index, home: child, threads: [...index.threads, record] };"),
    ("provenance: the child records no source, so its lineage is unreachable",
     "    forked_from: {\n"
     "      fork_id: marker.fork_id,\n"
     "      source,\n"
     "      created_at: marker.created_at,\n"
     "      messages: marker.message_count,\n"
     "      turns: marker.turn_count,\n"
     "    },\n",
     ""),
    ("provenance: the durable record names the child as its own source",
     "    source: marker.source,",
     "    source: marker.child,"),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/thread_fork.test.ts"], src=FORK)


if __name__ == "__main__":
    sys.exit(main())
