/**
 * The part of dreaming that decides what is worth remembering.
 *
 * Ported from the pure core of `crates/daemon/src/memory/dreaming.rs` and
 * pinned by `tests/engine_fixtures/dreaming_core_parity.json`. The I/O shell
 * around it — the librarian sweep, the state file, the diary and reports —
 * follows separately; this is the half where a silent divergence changes which
 * memories a character keeps.
 *
 * ## Every score is f32
 *
 * The Rust computes these in `f32`; JavaScript has only `f64`. The difference
 * is not academic: `round_score(0.125)` is `0.13` as an f32, which read back as
 * a double is `0.12999999523162842`, and a candidate sitting on the 0.60
 * promotion threshold can land either side of it. So every arithmetic step goes
 * through {@link f32}, in the order the Rust performs it — the fixture's
 * `rounding` table exists to hold that line.
 *
 * ## Lengths are bytes
 *
 * `MIN_CANDIDATE_LEN` and the 48-byte durability bonus are `str::len()`, which
 * is UTF-8 bytes. `.length` in JavaScript is UTF-16 code units and disagrees on
 * anything non-ASCII — a Japanese note would cross both thresholds elsewhere.
 */

/** Round a double to the nearest f32, as every Rust `f32` operation does. */
const f32 = Math.fround;

/**
 * Below this a candidate is never promoted to the memory index.
 *
 * Held as the **f32** value, not the double `0.6`. The comparison in
 * `promotionGates` is `>=`, and a score that lands exactly on the threshold is
 * the case that distinguishes it from `>`. Since scores are f32, the value they
 * can equal is `Math.fround(0.6)` — against the double, every f32 at or above
 * the threshold is strictly greater, so `>` and `>=` would agree and the
 * boundary would go untested.
 */
export const MIN_PROMOTION_SCORE = f32(0.6);

/** Shorter than this, in UTF-8 bytes, and it is not a candidate at all. */
export const MIN_CANDIDATE_LEN = 18;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Two decimal places, computed the way the Rust does: `(v * 100).round() / 100`
 * entirely in f32.
 *
 * `Math.round` is half-up and Rust's `f32::round` is half-away-from-zero; they
 * agree here because every score reaching this is non-negative.
 */
export function roundScore(value: number): number {
  return f32(Math.round(f32(f32(value) * 100)) / 100);
}

// ── paths ───────────────────────────────────────────────────────────────────

/** Files dreaming itself produces. Never sources for the next sweep — promoting
 *  from them would let the index feed on its own output. */
export function isGeneratedDreamingPath(path: string): boolean {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  return (
    lower === "memory.md" ||
    lower === "dreams.md" ||
    lower === "dreams" ||
    lower === "dreams/" ||
    lower.startsWith(".dreams/") ||
    lower.startsWith("dreaming/")
  );
}

/** A markdown file that is not dreaming's own output. The extension match is
 *  case-insensitive; nothing else here is. */
export function isCandidateSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // Rust's `Path::extension` treats a leading dot as part of the file name, so
  // a bare ".md" has no extension at all.
  const ext = dot > 0 ? base.slice(dot + 1) : undefined;
  return !isGeneratedDreamingPath(path) && ext?.toLowerCase() === "md";
}

/** Where a candidate came from, which the report groups by. */
export function sourceKind(path: string): string {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  if (lower.startsWith("daily/") || lower.startsWith("journal/") || lower.includes("/daily/")) {
    return "daily";
  }
  return lower.includes("compact") ? "compacted_note" : "curated_markdown";
}

// ── text ────────────────────────────────────────────────────────────────────

export function isHeadingLine(text: string): boolean {
  return text.trimStart().startsWith("#");
}

const TRANSIENT_MARKERS = [
  "maybe later",
  "temporary",
  "transient",
  "scratch",
  "draft",
  "wip",
  "todo",
  "tomorrow",
  "today i",
  "today we",
  "remind me",
  "meeting at",
  "next week",
  "for now",
];

/** Language marking a note as about right now rather than about the person. */
export function isObviouslyTransient(text: string): boolean {
  const lower = text.toLowerCase();
  return TRANSIENT_MARKERS.some((n) => lower.includes(n));
}

/**
 * Strip one leading list marker.
 *
 * The numeric arm takes at most three ASCII digits before `". "`, so `1234.` is
 * left alone and so is `abc.`. Only the first matching prefix goes; this does
 * not loop.
 */
export function stripListMarker(text: string): string {
  for (const prefix of ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ ", "> "]) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  const at = text.indexOf(". ");
  if (at > 0) {
    const left = text.slice(0, at);
    if (byteLen(left) <= 3 && /^[0-9]+$/.test(left)) return text.slice(at + 2).trim();
  }
  return text;
}

/** One line of markdown as a candidate, or nothing. */
export function candidateTextFromLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (
    trimmed === "" ||
    isHeadingLine(trimmed) ||
    trimmed.startsWith("```") ||
    trimmed === "---" ||
    trimmed.startsWith("|")
  ) {
    return undefined;
  }
  const text = stripListMarker(trimmed).trim();
  if (byteLen(text) < MIN_CANDIDATE_LEN || isObviouslyTransient(text)) return undefined;
  return text;
}

const EDGE_CHARS = new Set(["-", "*", " ", "\t"]);
const TAIL_CHARS = new Set([".", ";", ","]);

function trimMatches(s: string, set: Set<string>): string {
  let a = 0;
  let b = s.length;
  while (a < b && set.has(s[a]!)) a++;
  while (b > a && set.has(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** The form two sightings of the same note are compared by. */
export function normalizeCandidateText(text: string): string {
  const stripped = trimMatches(stripListMarker(text.trim()), EDGE_CHARS);
  const collapsed = stripped
    .split(/\s+/)
    .filter((p) => p !== "")
    .join(" ");
  return trimMatches(collapsed, TAIL_CHARS).toLowerCase();
}

/** FNV-1a, 64-bit. BigInt because the multiply overflows a double long before
 *  the last byte, and the hex is the candidate's identity on disk. */
export function candidateId(normalized: string): string {
  const MASK = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(normalized)) {
    hash = (hash ^ BigInt(byte)) & MASK;
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return `dc-${hash.toString(16).padStart(16, "0")}`;
}

const THEME_VOCABULARY: [string, string[]][] = [
  [
    "preference",
    ["likes", "prefers", "favorite", "favourite", "dislikes", "hates", "enjoys", "wants"],
  ],
  ["identity", ["name is", "birthday", "born", "lives in", "pronouns", "calls themself"]],
  ["project", ["project", "working on", "building", "repo", "branch"]],
  ["commitment", ["remember", "important", "promised", "agreed", "commitment", "must not forget"]],
  ["relationship", ["friend", "partner", "family", "works with", "relationship"]],
  ["stable_context", ["always", "usually", "never", "long-term", "durable"]],
];

/** Themes a note touches. Sorted, because the Rust collects into a `BTreeSet`,
 *  and that order reaches the report and the stored candidate. */
export function detectThemes(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const [theme, needles] of THEME_VOCABULARY) {
    if (needles.some((n) => lower.includes(n))) hits.push(theme);
  }
  return hits.sort();
}

// ── scores ──────────────────────────────────────────────────────────────────

/**
 * Age buckets. An unparseable or absent timestamp gets the middle value rather
 * than the worst — not knowing when a note changed is not evidence it is old.
 */
export function recencyScoreAt(modifiedAt: string, nowMs: number): number {
  // The bucket values are f32 literals in the Rust and land in a `f32` field,
  // so 0.8 is really 0.800000011920929. Returning the double would differ in
  // the sixteenth digit — invisible until it is multiplied by 0.15 and summed
  // into a score compared against a threshold.
  const parsed = Date.parse(modifiedAt);
  if (Number.isNaN(parsed)) return f32(0.5);
  // chrono's `num_days` truncates toward zero, so a future timestamp gives a
  // negative age and lands in the freshest bucket, as it does in the Rust.
  const ageDays = Math.trunc((nowMs - parsed) / 86_400_000);
  if (ageDays <= 7) return f32(1.0);
  if (ageDays <= 30) return f32(0.8);
  if (ageDays <= 180) return f32(0.55);
  return f32(0.3);
}

const STRONG_DURABILITY = [
  "always",
  "usually",
  "prefers",
  "favorite",
  "important",
  "remember",
  "birthday",
  "name is",
  "project",
];

export function durabilityScore(text: string, themes: string[]): number {
  const lower = text.toLowerCase();
  let score = f32(0.2 + f32(themes.length * 0.16));
  if (STRONG_DURABILITY.some((n) => lower.includes(n))) score = f32(score + 0.25);
  if (byteLen(text) >= 48) score = f32(score + 0.1);
  return roundScore(Math.min(score, 1.0));
}

export function specificityScore(text: string): number {
  let score = f32(0.15);
  const words = text.split(/\s+/).filter((w) => w !== "");
  if (words.length >= 5) score = f32(score + 0.25);
  if (words.length >= 9) score = f32(score + 0.15);
  if (/[0-9]/.test(text)) score = f32(score + 0.1);
  // `char::is_uppercase` is Unicode, not ASCII, and `word.len()` is bytes.
  const hasProperNoun = words.some((w) => {
    const first = [...w][0];
    return first !== undefined && first !== first.toLowerCase() && byteLen(w) > 2;
  });
  if (hasProperNoun) score = f32(score + 0.2);
  if (text.includes(":") || text.includes("/") || text.includes("@")) score = f32(score + 0.05);
  return roundScore(Math.min(score, 1.0));
}

export interface ScoreInputs {
  durability_score: number;
  specificity_score: number;
  recency_score: number;
  unique_source_count: number;
  recall_count: number;
  theme_hits: string[];
}

/**
 * The weighted sum that decides promotion, in the Rust's operand order.
 *
 * Evidence saturates at three distinct sources and recall at four sightings:
 * past those, more of the same says nothing new.
 */
export function scoreCandidate(
  c: ScoreInputs,
  reinforcementSignals: Record<string, number>,
): number {
  const evidence = Math.min(f32(c.unique_source_count / 3), 1);
  const recall = Math.min(f32(c.recall_count / 4), 1);

  let theme = 0;
  if (c.theme_hits.length > 0) {
    let reinforced = 0;
    for (const t of c.theme_hits) reinforced += reinforcementSignals[t] ?? 0;
    theme = Math.min(f32(f32(c.theme_hits.length * 0.2) + f32(reinforced * 0.1)), 1);
  }

  let sum = f32(c.durability_score * 0.3);
  sum = f32(sum + f32(c.specificity_score * 0.25));
  sum = f32(sum + f32(c.recency_score * 0.15));
  sum = f32(sum + f32(evidence * 0.1));
  sum = f32(sum + f32(recall * 0.1));
  sum = f32(sum + f32(theme * 0.1));
  return roundScore(sum);
}

export interface DreamGate {
  name: string;
  passed: boolean;
  reason: string;
}

const gate = (name: string, passed: boolean, failure: string): DreamGate => ({
  name,
  passed,
  reason: passed ? "passed" : failure,
});

export interface GateInputs {
  text: string;
  source: string;
  promotion_score: number;
  unique_source_count: number;
  evidence: unknown[];
}

/**
 * Every reason a candidate might not be promoted, evaluated in full.
 *
 * All seven come back, passed or not — the report shows why something was
 * rejected, so short-circuiting would cost the explanation.
 */
export function promotionGates(c: GateInputs, sourceStillPresent: boolean): DreamGate[] {
  return [
    gate(
      "minimum_score",
      c.promotion_score >= MIN_PROMOTION_SCORE,
      `index score ${c.promotion_score.toFixed(2)} is below ${MIN_PROMOTION_SCORE.toFixed(2)}`,
    ),
    gate(
      "minimum_evidence",
      c.evidence.length > 0 && c.unique_source_count >= 1,
      "candidate has no usable source evidence",
    ),
    gate(
      "not_generated_from_dreaming_files",
      !isGeneratedDreamingPath(c.source),
      "generated dreaming artifacts are never index sources",
    ),
    gate(
      "not_too_short",
      byteLen(c.text) >= MIN_CANDIDATE_LEN,
      `candidate is shorter than ${MIN_CANDIDATE_LEN} characters`,
    ),
    gate(
      "not_heading",
      !isHeadingLine(c.text),
      "headings are structure, not durable memory candidates",
    ),
    gate(
      "not_obviously_transient",
      !isObviouslyTransient(c.text),
      "candidate looks temporary or task-like",
    ),
    gate("source_still_present", sourceStillPresent, "source snippet is stale, deleted, or changed"),
  ];
}
