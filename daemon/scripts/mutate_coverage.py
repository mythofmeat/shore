#!/usr/bin/env python3
"""Mutation pass over compaction coverage: claims become coverage only when an
archive commits, and forks process inherited material once, across failures
and resumptions.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COVERAGE = ROOT / "src/memory/coverage.ts"
STORE = ROOT / "src/engine/history_store.ts"
MANAGER = ROOT / "src/memory/compaction/manager.ts"
RUN = ROOT / "src/memory/compaction/run.ts"
PLAN = ROOT / "src/memory/compaction/plan.ts"
VERSIONS = ROOT / "src/engine/versions.ts"

MUTANTS = [
    # --- a claim is not coverage --------------------------------------------
    ("claim: claiming records coverage outright, so a crashed pass looks done",
     STORE,
     "         VALUES (?1, ?2, ?3, 'claimed', ?4, ?5, ?6, ?7)`,",
     "         VALUES (?1, ?2, ?3, 'covered', ?4, ?5, ?6, ?7)`,"),
    ("claim: a second branch's claim overwrites the first, so both do the work",
     STORE,
     "      const insert = this.#db.query(\n"
     "        `INSERT OR IGNORE INTO memory_coverage",
     "      const insert = this.#db.query(\n"
     "        `INSERT OR REPLACE INTO memory_coverage"),
    ("claim: committing promotes every claim, not the one that finished",
     STORE,
     "         WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'`,\n"
     "      )\n"
     "      .run(character, path, claim, stamp ?? new Date().toISOString(), unit ?? null).changes;",
     "         WHERE character = ?1 AND path = ?2 AND state = 'claimed'`,\n"
     "      )\n"
     "      .run(character, path, stamp ?? new Date().toISOString(), unit ?? null).changes;"),
    ("claim: releasing a claim marks it covered instead of giving it back",
     STORE,
     "      .query(\n"
     "        `DELETE FROM memory_coverage\n"
     "         WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'`,\n"
     "      )\n"
     "      .run(character, path, claim).changes;",
     "      .query(\n"
     "        `UPDATE memory_coverage SET state = 'covered'\n"
     "         WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'`,\n"
     "      )\n"
     "      .run(character, path, claim).changes;"),
    ("claim: an abandoned claim is never reclaimed, so its material is stranded",
     STORE,
     "      this.expireMemoryClaims(character, path, nowMs - leaseMs);",
     "      void leaseMs;"),
    ("claim: a live claim is expired immediately, so two passes overlap",
     STORE,
     "      this.expireMemoryClaims(character, path, nowMs - leaseMs);",
     "      this.expireMemoryClaims(character, path, nowMs + leaseMs);"),

    # --- coverage is scoped and per-path -------------------------------------
    ("scope: coverage is read across every character, so imports collide",
     STORE,
     "         WHERE character = ?1 AND path = ?2 AND state = 'covered' AND version IN (${marks})`,",
     "         WHERE path = ?2 AND state = 'covered' AND version IN (${marks})`,"),

    # --- inheritance is not evidence of processing ---------------------------
    ("inheritance: material with no version is assumed already processed",
     COVERAGE,
     "  return claim.unversioned === 0 && claim.covered.length === claim.versions;",
     "  return claim.covered.length === claim.versions;"),
    ("inheritance: material another pass holds is counted as processed",
     COVERAGE,
     "  return claim.unversioned === 0 && claim.covered.length === claim.versions;",
     "  return claim.unversioned === 0 && claim.claimed.length === 0;"),
    ("inheritance: the background is any covered message, not the run at the front",
     COVERAGE,
     "  const backgroundMessages = options.contiguous === true\n"
     "    ? coveredPrefixLength(messages, covered)",
     "  const backgroundMessages = options.contiguous === true\n"
     "    ? covered.size"),
    ("inheritance: a covered message stops the prefix instead of extending it",
     COVERAGE,
     "    if (version === undefined || !covered.has(version)) break;",
     "    if (version === undefined || covered.has(version)) break;"),
    ("inheritance: an unversioned message is folded into the background prefix",
     COVERAGE,
     "    if (version === undefined || !covered.has(version)) break;",
     "    if (version !== undefined && !covered.has(version)) break;"),
    ("inheritance: covered material is claimed again alongside the new",
     COVERAGE,
     "  const covered = store.coveredMemoryVersions(character, path, versions);",
     "  const covered = new Set<string>();"),

    # --- a processing unit is the material, not the segment -------------------
    ("unit: the unit ignores what is in it, so unrelated ranges share a document",
     VERSIONS,
     '  const digest = createHash("sha256").update(versions.join("\\n")).digest("hex");',
     '  const digest = createHash("sha256").update("").digest("hex");'),
    ("unit: the unit is order-insensitive, so a reordered range collides",
     VERSIONS,
     '  const digest = createHash("sha256").update(versions.join("\\n")).digest("hex");',
     '  const digest = createHash("sha256").update([...versions].sort().join("\\n")).digest("hex");'),



    # --- a paused pass another branch finished is retired, not wedged --------
    ("wedge: retiring a pass leaves its checkpoint on disk",
     RUN,
     "  await removeCompactionCheckpoint(dataDir, character, thread);\n"
     "  shoreLog.warn(",
     "  shoreLog.warn("),
    ("wedge: a pass that already archived its turns archives them a second time",
     RUN,
     "  const archived = await hasCompactionOperation(\n"
     "    conversationRef(dataDir, character, thread, false),\n"
     "    checkpointId,\n"
     "  );",
     "  const archived = false as boolean;\n"
     "  void checkpointId;"),

    # --- a claim the pass does not hold is not a licence to archive ----------
    ("blocking: a partial claim counts as owning the range",
     COVERAGE,
     "  return claim.claimed.length !== claim.pending;",
     "  return claim.claimed.length === 0 && claim.pending > 0;"),
    ("blocking: material covered outside the background counts as contested",
     COVERAGE,
     "  const pending = versionsIn(fresh).filter((version) => !covered.has(version));",
     "  const pending = versionsIn(fresh).filter((version) => !background.has(version));"),


    # --- a mixed segment stands behind what it inherited ---------------------
    ("blocking: a claim is not reclaimable by the pass that already holds it",
     STORE,
     "           WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'\n"
     "             AND version IN (${marks})`,",
     "           WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'\n"
     "             AND claimed_at < 0 AND version IN (${marks})`,"),


    # --- one plan, resolved once, carried to the archive ---------------------
    ("plan: the frozen source is abandoned for whatever is live now",
     PLAN,
     "  const sourceContent = resumed ? checkpoint.sourceContent : input.rawContent;",
     "  const sourceContent = input.rawContent;"),
    ("plan: the split is recomputed from the live conversation, not the frozen one",
     PLAN,
     "  const splitAt = Math.min(resumed ? checkpoint.splitAt : liveSplitAt, messages.length);",
     "  const splitAt = Math.min(liveSplitAt, messages.length);"),
    ("plan: the range is read past the split the checkpoint recorded",
     PLAN,
     "  const archival = messages.slice(0, splitAt);",
     "  const archival = [...messages];"),
    ("plan: a checkpoint the conversation outgrew is resumed anyway",
     PLAN,
     "  if (!sourceIsCurrent(checkpoint.sourceContent, checkpoint.sourceHash, liveContent)) return false;",
     "  void liveContent;"),
    ("plan: an explicit keep-turns count cannot move a frozen split",
     PLAN,
     "  if (settings.keepTurnsOverride !== undefined && checkpoint.splitAt !== splitAt) return false;",
     "  void splitAt;"),
    ("plan: a restart resumes the checkpoint it was told to throw away",
     PLAN,
     "  if (checkpoint === undefined || settings.restart === true) return false;",
     "  if (checkpoint === undefined) return false;"),
    ("plan: the versions carried are the whole conversation, not the range",
     PLAN,
     "    versions: versionsIn(archival),",
     "    versions: versionsIn(messages),"),
    ("commit: the source is never verified before the archive is written",
     PLAN,
     "  if (!planSourceIsCurrent(plan, liveContent)) return undefined;",
     "  void liveContent;"),
    ("commit: the retained tail is measured against the live split, not the plan's",
     PLAN,
     "    retained: Math.max(liveLines.length - plan.splitAt, 0),",
     "    retained: 0,"),
    ("commit: the retained turns are counted over the whole conversation",
     PLAN,
     "    retainedTurns: retainedTurnCount(liveContent, plan.splitAt),",
     "    retainedTurns: retainedTurnCount(liveContent, 0),"),
    ("commit: a rotation writes the snapshot it planned from rather than what is live",
     RUN,
     "      keepLastN: commit.retained,\n"
     "      activeContent: commit.liveContent,",
     "      keepLastN: commit.retained,\n"
     "      activeContent: plan.sourceContent,"),
    ("commit: a rotation commits even when the conversation moved under it",
     RUN,
     "  if (commit === undefined) {",
     "  if (false as boolean) {"),
    ("plan: coverage is claimed over something other than the resolved range",
     RUN,
     '    return claimUncovered(store, character, "compaction", plan.archival, {',
     '    return claimUncovered(store, character, "compaction", plan.messages, {'),
    ("plan: a resumed pass mints a new claim instead of reusing its checkpoint's",
     RUN,
     "  const resumeClaim = plan.resumed ? plan.checkpoint?.coverageClaim : undefined;",
     "  const resumeClaim = undefined;"),
    ("blocking: a pass that owns none of the range archives it anyway",
     RUN,
     "  if (coverageIsPartial(claimed) || (claimed.pending === 0 && claimed.unversioned === 0)) {",
     "  if (false as boolean) {"),
    ("blocking: half a range is enough to archive the whole of it",
     RUN,
     "  if (coverageIsPartial(claimed) || (claimed.pending === 0 && claimed.unversioned === 0)) {",
     "  if (claimed.claimed.length === 0 && claimed.unversioned === 0) {"),
    ("wedge: a range someone else finished stays an outstanding claim forever",
     RUN,
     "  if (coverageIsRedundant(claimed)) return { redundant: true };",
     "  if (coverageIsRedundant(claimed) && plan.checkpoint === undefined) {\n"
     "    return { redundant: true };\n"
     "  }"),
    ("wedge: the checkpoint is rotated over without being retired",
     RUN,
     '\n      if (plan.checkpoint !== undefined) {\n        const settled = await reconcileAbandonedPass(dataDir, character, thread, plan.checkpoint.id);\n        if (settled) return undefined;\n      }\n      ',
     ''),
    ("recovery: an already-archived pass is re-run instead of recognised",
     MANAGER,
     "  const recovered = await recoverArchivedPass(opts, plan);\n"
     "  if (recovered !== undefined) return recovered;\n",
     ""),
    ("recovery: a pass whose turns are still live is mistaken for one already archived",
     MANAGER,
     "  if (checkpointSourceIsCompatible(prior, liveContent)) return undefined;",
     "  void liveContent;"),
    ("manager: the archive commits without checking the plan's source is still current",
     MANAGER,
     "  const commit = openArchivalCommit(plan, await currentActiveContent(opts));\n"
     "  if (commit === undefined) {",
     "  const commit = required(openArchivalCommit(plan, plan.sourceContent));\n"
     "  if (false as boolean) {"),
    ("manager: the archive is written from the plan's snapshot, not what is live",
     MANAGER,
     "    commit.liveContent,\n"
     "    state.writesApplied,",
     "    plan.sourceContent,\n"
     "    state.writesApplied,"),
    ("manager: the checkpoint is written from live content rather than the plan's source",
     MANAGER,
     "      plan.sourceContent,\n"
     "      plan.splitAt,\n"
     "      compactedTurns,\n"
     "      request,\n"
     "      opts.dryRun,\n"
     "      abandonedBefore ?? abandoned?.memoryBefore ?? workspaceHead,",
     "      liveSourceOf(opts),\n"
     "      plan.splitAt,\n"
     "      compactedTurns,\n"
     "      request,\n"
     "      opts.dryRun,\n"
     "      abandonedBefore ?? abandoned?.memoryBefore ?? workspaceHead,"),
    ("manager: a resumed plan still re-resolves its own checkpoint",
     MANAGER,
     "    if (plan.resumed && abandoned !== undefined && sameModel) return abandoned;",
     "    if (false as boolean) return required(plan.checkpoint);"),

    # --- the archive commit is where compaction coverage lands ---------------
    ("archive: coverage is committed even when the archive is abandoned",
     STORE,
     "        this.releaseMemoryCoverage(\n"
     "          characterOfArchiveKey(character),\n"
     '          "compaction",\n'
     "          pending.coverage_claim,\n"
     "        );",
     "        this.commitMemoryCoverage(\n"
     "          characterOfArchiveKey(character),\n"
     '          "compaction",\n'
     "          pending.coverage_claim,\n"
     "        );"),
    ("archive: finishing the archive records no coverage at all",
     STORE,
     "        this.commitMemoryCoverage(\n"
     "          characterOfArchiveKey(character),\n"
     '          "compaction",\n'
     "          pending.coverage_claim,\n"
     "        );",
     "        void pending;"),
    ("archive: a thread archive's coverage is filed under the thread, not the character",
     STORE,
     "export function characterOfArchiveKey(archiveKey: string): string {\n"
     '  const slash = archiveKey.indexOf("/");\n'
     "  return slash === -1 ? archiveKey : archiveKey.slice(0, slash);",
     "export function characterOfArchiveKey(archiveKey: string): string {\n"
     "  return archiveKey;"),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(
        MUTANTS,
        [
            "tests/memory_coverage.test.ts",
            "tests/compaction_coverage.test.ts",
            "tests/registry_threads.test.ts",
            "tests/compaction_resume.test.ts",
            "tests/compaction_truncated.test.ts",
        ],
    )


if __name__ == "__main__":
    sys.exit(main())
