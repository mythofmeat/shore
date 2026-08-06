#!/usr/bin/env python3
"""Mutation pass over the deep-idle archive (#18 / #12).

This module decides what happens to a conversation nobody came back to, and
every mutant below still *works* — the archive runs, the trigger clears, nothing
throws. What they change is what survives.

Three groups.

The **plan** picks between spending nothing and spending a model call over a
whole conversation. Its two failure modes are opposite and both permanent: take
the cheap arm when turns are uncovered and those turns are archived without ever
reaching memory; take the expensive arm when everything is covered and every
deep archive pays for a pass that rediscovers what memory already holds.

The **tail** is what the user sees when they come back. It is the run of
unanswered heartbeat messages, and it becomes `keepLastN` unchanged — so an
off-by-one either archives a message the user has not read or leaves a covered
exchange in `active.jsonl` forever.

The **reporting** is what the runner folds in. `deepArchiveDone` is the one that
matters: the LLM arm must not set it, because a pass that wrote no memory
returns the same zero a successful one does, and setting it there stops the next
window retrying a conversation that is still fully intact.

A mutant is KILLED if `bun test tests/deep_archive_parity.test.ts
tests/autonomy_runner.test.ts` fails with it applied — two files, because what
the archive *reports* is only behaviour once the runner folds it in.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_deep_archive.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = "src/autonomy/deep_archive.ts"
R = "src/autonomy/runner.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the plan -------------------------------------------------------------
    ("plan: the tail runs forwards from the start, not backwards from the end",
     D,
     "  for (let i = messages.length - 1; i >= 0; i -= 1) {",
     "  for (let i = 0; i < messages.length; i += 1) {"),
    ("plan: a prompted assistant turn counts towards the tail",
     D,
     '    if (m === undefined || m.role !== "assistant" || m.origin !== "autonomous") break;',
     '    if (m === undefined || m.role !== "assistant") break;'),
    ("plan: an autonomous message of any role counts towards the tail",
     D,
     '    if (m === undefined || m.role !== "assistant" || m.origin !== "autonomous") break;',
     '    if (m === undefined || m.origin !== "autonomous") break;'),
    ("plan: the tail counts autonomous messages anywhere, not just trailing",
     D,
     '    if (m === undefined || m.role !== "assistant" || m.origin !== "autonomous") break;',
     '    if (m === undefined || m.role !== "assistant" || m.origin !== "autonomous") continue;'),
    ("plan: archivable is the whole conversation, tail included",
     D,
     "  const archivable = Math.max(messages.length - tail, 0);",
     "  const archivable = messages.length;"),
    ("plan: an empty conversation is archived rather than quiesced",
     D,
     '  if (archivable === 0) return { arm: "quiesce", tail };',
     '  if (archivable < 0) return { arm: "quiesce", tail };'),
    ("plan: a tool-result intermediate counts as a user turn",
     D,
     '  const userTurns = messages.filter((m) => m.role === "user" && !isToolResultOnly(m)).length;',
     '  const userTurns = messages.filter((m) => m.role === "user").length;'),
    ("plan: coverage is a floor, not equality — the expensive one",
     D,
     "  return userTurns === coveredTurnCount",
     "  return userTurns <= coveredTurnCount"),
    ("plan: coverage is inverted, so covered conversations pay for a pass",
     D,
     "  return userTurns === coveredTurnCount",
     "  return userTurns !== coveredTurnCount"),
    ("plan: assistant turns count towards coverage too",
     D,
     '  const userTurns = messages.filter((m) => m.role === "user" && !isToolResultOnly(m)).length;',
     "  const userTurns = messages.length;"),

    # --- the split ------------------------------------------------------------
    ("split: the tail is not retained, so unanswered messages are archived",
     D,
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: tail, activeContent });",
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: 0, activeContent });"),
    ("split: archivable is retained instead of the tail",
     D,
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: tail, activeContent });",
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: archivable, activeContent });"),
    ("split: the tail is off by one, keeping a message the archive should take",
     D,
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: tail, activeContent });",
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: tail + 1, activeContent });"),
    ("split: the archive runs on whatever is on disk now, not what was read",
     D,
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: tail, activeContent });",
     "    ).archiveAndRetain(\"deep-idle\", { keepLastN: tail, activeContent: \"\" });"),

    # --- the arms -------------------------------------------------------------
    ("arm: quiesce falls through to the archive instead of standing down",
     D,
     '  if (plan.arm === "quiesce") {',
     "  if (false) {"),
    ("arm: everything takes the pure arm — uncovered turns are lost",
     D,
     "  return await compactionArchive(character, deps);",
     "  return await pureArchive(character, deps, loaded.raw, plan.tail, plan.archivable);"),
    ("arm: the keep-0 pass keeps the configured retention instead",
     D,
     "      { keepTurnsOverride: 0, retainTrailingAutonomous: true },",
     "      { retainTrailingAutonomous: true },"),
    ("arm: the keep-0 pass archives the unanswered autonomous run too",
     D,
     "      { keepTurnsOverride: 0, retainTrailingAutonomous: true },",
     "      { keepTurnsOverride: 0, retainTrailingAutonomous: false },"),

    # --- the reporting --------------------------------------------------------
    ("report: the LLM arm declares the idle period finished",
     D,
     "  return { turnCount: retained, events: [], deepArchiveDone: false };",
     "  return { turnCount: retained, events: [], deepArchiveDone: true };"),
    ("report: the pure arm leaves the period open, so it archives again",
     D,
     "  return { turnCount: 0, events: [], deepArchiveDone: true };",
     "  return { turnCount: 0, events: [], deepArchiveDone: false };"),
    ("report: the pure arm reports the archived count as the retained one",
     D,
     "  return { turnCount: 0, events: [], deepArchiveDone: true };",
     "  return { turnCount: archivable, events: [], deepArchiveDone: true };"),
    ("report: quiesce leaves the period open and re-fires every window",
     D,
     '    return { events: [], deepArchiveDone: true };',
     "    return { events: [], deepArchiveDone: false };"),
    ("report: a failed archive finishes the period, so it never retries",
     D,
     "    return { events: [], failed: message(e), deepArchiveDone: false };\n  } finally {",
     "    return { events: [], failed: message(e), deepArchiveDone: true };\n  } finally {"),
    ("report: a conversation that will not load is reported as nothing to do",
     D,
     "    return { events: [], failed: message(e), deepArchiveDone: false };\n  }\n\n  const plan",
     "    return { events: [], deepArchiveDone: true };\n  }\n\n  const plan"),
    ("report: missing compaction deps archives with no pass at all",
     D,
     '      failed: "deep-idle archive has no compaction dependencies",',
     '      failed: undefined as never as string,'),

    # --- the bookkeeping ------------------------------------------------------
    ("bookkeeping: the single-flight guard is not taken",
     D,
     "  const guard = tryBeginCompaction(dataDir, character);\n  if (guard === undefined) {",
     "  const guard = tryBeginCompaction(dataDir, character);\n  if (false) {"),
    ("bookkeeping: the guard is never released, wedging every later pass",
     D,
     "  } finally {\n    guard.release();\n  }",
     "  } finally {\n    void guard;\n  }"),
    ("bookkeeping: the cached body survives the archive",
     D,
     '  deps.cache.invalidate(character, "deep_idle_archive");',
     "  void character;"),
    ("bookkeeping: the keepalive is never re-pointed after the archive",
     D,
     "  await deps.cache.reprimeFromDisk(",
     "  if (false) await deps.cache.reprimeFromDisk("),
    ("bookkeeping: the pure arm sends no notification",
     D,
     "  deps.notify?.(title, body);",
     "  void title;\n  void body;"),
    ("bookkeeping: the notification body quotes the tail, not what was archived",
     D,
     "  const { title, body } = deepArchiveNotification(character, archivable);",
     "  const { title, body } = deepArchiveNotification(character, tail);"),
    ("bookkeeping: the engine is not reloaded, so the prompt stays pre-archive",
     D,
     "  await reloadAndApplyDeferred(character, deps, \"Deep-idle archive\");\n\n  const { title",
     "  void 0;\n\n  const { title"),
    ("bookkeeping: a failed reload aborts the archive it already did",
     D,
     "      console.warn(`shore: ${context}: engine reload failed for ${character}: ${String(e)}`);",
     "      throw e;"),
    ("notification: the count is dropped from the body",
     D,
     "    body: `Idle conversation archived (${archivable} messages, no LLM pass needed)`,",
     "    body: `Idle conversation archived (messages, no LLM pass needed)`,"),
    ("notification: the title loses the character",
     D,
     "    title: `Shore — ${character}`,",
     "    title: `Shore`,"),

    # --- the runner's half ----------------------------------------------------
    ("runner: the archive's own answer is ignored for the old inference",
     R,
     "          if (result.deepArchiveDone ?? result.failed === undefined) {",
     "          if (result.failed === undefined) {"),
    ("runner: a reported false is read as absent",
     R,
     "          if (result.deepArchiveDone ?? result.failed === undefined) {",
     "          if (result.deepArchiveDone || result.failed === undefined) {"),
]


def run() -> bool:
    r = subprocess.run(
        # The runner's half of the contract lives in its own file: what the
        # archive reports is only behaviour if something folds it in.
        ["bun", "test", "tests/deep_archive_parity.test.ts", "tests/autonomy_runner.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    paths = {path for _, path, _, _ in MUTANTS}
    originals = {p: (ROOT / p).read_text() for p in paths}
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, path, find, replace) in enumerate(MUTANTS, 1):
        original = originals[path]
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        (ROOT / path).write_text(original.replace(find, replace, 1))
        killed = not run()
        (ROOT / path).write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    for path, text in originals.items():
        (ROOT / path).write_text(text)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
