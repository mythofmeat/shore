#!/usr/bin/env python3
"""Mutation pass over memory-processing coverage across branches (#203).

Once a fork exists, the same conversation lives in two threads, and both of them
will eventually compact and both of them will eventually be retained. The rules
that keep that from writing everything up twice — or, far worse, from writing it
up zero times — are all negatives: a claim is not coverage, a submission is not a
confirmation, material another pass is holding is not material that is done, and
an inherited copy is not evidence that anybody ever processed the original.

Every one of those reads as a no-op on the happy path. A single branch that
compacts once and retains once behaves identically whether coverage is committed
transactionally with the archive or optimistically before the LLM runs; the
difference only shows when the pass crashes in between, or when the other branch
gets there first. That is the class of hole this harness exists to find.

A mutant is KILLED if the coverage suites fail with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_coverage.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COVERAGE = ROOT / "src/memory/coverage.ts"
STORE = ROOT / "src/engine/history_store.ts"
HINDSIGHT = ROOT / "src/memory/hindsight_retain_service.ts"
RUN = ROOT / "src/memory/compaction/run.ts"
VERSIONS = ROOT / "src/engine/versions.ts"

# (label, [path,] find, replace)
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
    ("scope: the two memory paths share one coverage record",
     STORE,
     "         WHERE character = ?1 AND path = ?2 AND state = 'covered' AND version IN (${marks})`,",
     "         WHERE character = ?1 AND state = 'covered' AND version IN (${marks})`,"),

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

    # --- hindsight: submitted is not stored ----------------------------------
    ("hindsight: the whole segment is resubmitted, not just what is unprocessed",
     HINDSIGHT,
     "  const fresh = messages.filter((message) => {\n"
     "    const version = versionOf(message);\n"
     "    return version === undefined || claimable.has(version);\n"
     "  });",
     "  const fresh = [...messages];"),
    ("hindsight: a fully covered segment is retained a second time",
     HINDSIGHT,
     '  if (!unversioned && covered.size === present.length) return { kind: "covered" };',
     "  void unversioned;"),
    ("hindsight: material another branch is retaining is marked stored here",
     HINDSIGHT,
     '  if (fresh.length === 0) return { kind: "claimed_elsewhere" };',
     '  if (fresh.length === 0) return { kind: "covered" };'),
    ("hindsight: the document id is per segment, so two branches never share one",
     HINDSIGHT,
     "    documentId:\n"
     "      versions.length === 0\n"
     "        ? hindsightDocumentId(archiveKey, segment)\n"
     "        : hindsightUnitDocumentId(character, versions),",
     "    documentId: hindsightDocumentId(archiveKey, segment),"),
    ("hindsight: submitting counts as coverage, before anything confirms it",
     HINDSIGHT,
     "    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, documentId, unit.claim);",
     "    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, documentId, unit.claim);\n"
     '    store.commitMemoryCoverage(registration.character, "hindsight", unit.claim);'),
    ("hindsight: confirming stores the document but records no coverage",
     HINDSIGHT,
     "    if (claim !== undefined) {\n"
     '      store.commitMemoryCoverage(character, "hindsight", claim, unitOf(character, documentId));\n'
     "    }",
     "    void claim;"),
    ("hindsight: the coverage record forgets which document covered it",
     HINDSIGHT,
     '      store.commitMemoryCoverage(character, "hindsight", claim, unitOf(character, documentId));',
     '      store.commitMemoryCoverage(character, "hindsight", claim);'),
    ("hindsight: a confirmed document records no occurrence, so exclusion loses it",
     HINDSIGHT,
     "    store.markMemoryDocumentOccurrence(\n"
     "      character,\n"
     '      "hindsight",\n'
     "      documentId,\n"
     "      job.archiveKey,\n"
     "      job.segment,\n"
     "    );\n",
     ""),
    ("hindsight: a requeued job keeps the claim it already holds, so it can never retake it",
     HINDSIGHT,
     "    if (job.claim !== undefined) {\n"
     '      store.releaseMemoryCoverage(character, "hindsight", job.claim);\n'
     "    }\n",
     ""),
    ("hindsight: a requeued job keeps its document identity, so a stale claim outlives it "
     "(EQUIVALENT: a requeued job comes back as a retain, which recomputes both the "
     "document id and the claim before either is read, and the claim it left behind has "
     "already been released)",
     HINDSIGHT,
     "    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, null, null);\n"
     "    store.requeueMemoryDocument(job.archiveKey, job.segment, error, exhausted, due);",
     "    store.requeueMemoryDocument(job.archiveKey, job.segment, error, exhausted, due);"),
    ("hindsight: a failed retain releases the claim it read, not the one it took",
     HINDSIGHT,
     "        { ...job, claim: inFlight.claim ?? job.claim },",
     "        job,"),

    # --- deletion respects the other branches --------------------------------
    ("deletion: a shared document is deleted while another branch still needs it",
     HINDSIGHT,
     "    if (supporting.length > 0) {",
     "    if (false as boolean) {"),
    ("deletion: an excluded occurrence still counts as eligible",
     STORE,
     "           AND s.committed = 1 AND s.excluded = 0\n"
     "         ORDER BY d.archive_key, d.segment`,",
     "           AND s.committed = 1\n"
     "         ORDER BY d.archive_key, d.segment`,"),
    ("deletion: deleting the last copy leaves its material marked processed",
     HINDSIGHT,
     "      store.releaseHindsightUnitCoverage(registration.character, candidate);",
     "      void candidate;"),
    ("deletion: only the segment's named document is considered, not the ones it backs",
     HINDSIGHT,
     "    for (const candidate of recorded.length === 0 ? [documentId] : recorded) {",
     "    for (const candidate of [documentId]) {"),
    ("deletion: a segment with no recorded documents deletes nothing at all",
     HINDSIGHT,
     "    for (const candidate of recorded.length === 0 ? [documentId] : recorded) {",
     "    for (const candidate of recorded) {"),

    # --- a claim the pass does not hold is not a licence to archive ----------
    ("blocking: a pass that claimed nothing archives the material anyway",
     RUN,
     "  if (planned.claimed.length === 0 && planned.unversioned === 0) {",
     "  if (false as boolean) {"),
    ("blocking: a resumed pass mints a new claim instead of reusing its checkpoint's",
     RUN,
     "      ...(resumeClaim === undefined ? {} : { claim: resumeClaim }),",
     "      ...{},"),
    ("blocking: a claim is not reclaimable by the pass that already holds it",
     STORE,
     "           WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'\n"
     "             AND version IN (${marks})`,",
     "           WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'\n"
     "             AND claimed_at < 0 AND version IN (${marks})`,"),
    ("blocking: a paused pass drops the claim its checkpoint will resume with",
     RUN,
     '      outcome.kind !== "paused"\n',
     ""),

    # --- inherited context reaches the retainer, marked ----------------------
    ("context: the inherited half of a unit is dropped from the document",
     HINDSIGHT,
     "    messages,\n"
     "    background: new Set(",
     "    messages: fresh,\n"
     "    background: new Set("),
    ("context: inherited lines are not marked, so they read as new material",
     HINDSIGHT,
     '      `${inherited ? "[already recorded] " : ""}${names[message.role]} ` +',
     "      `${names[message.role]} ` +"),
    ("context: a document of nothing but inherited lines is still submitted",
     HINDSIGHT,
     "  if (fresh === 0 || first === undefined || last === undefined) return undefined;",
     "  if (lines.length === 0 || first === undefined || last === undefined) return undefined;"),

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

from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(
        MUTANTS,
        [
            "tests/memory_coverage.test.ts",
            "tests/compaction_coverage.test.ts",
            "tests/hindsight_branches.test.ts",
            "tests/registry_threads.test.ts",
        ],
    )


if __name__ == "__main__":
    sys.exit(main())
