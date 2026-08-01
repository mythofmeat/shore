/**
 * Replays `engine_fixtures/dreaming_core_parity.json` against the TypeScript
 * dreaming core. Frozen; nothing regenerates it.
 */

import { describe, expect, test } from "bun:test";

import {
  candidateId,
  candidateTextFromLine,
  detectThemes,
  durabilityScore,
  isCandidateSourcePath,
  isGeneratedDreamingPath,
  isHeadingLine,
  isObviouslyTransient,
  normalizeCandidateText,
  promotionGates,
  recencyScoreAt,
  roundScore,
  scoreCandidate,
  sourceKind,
  specificityScore,
  stripListMarker,
} from "../src/memory/dreaming_core";

import fixture from "./engine_fixtures/dreaming_core_parity.json";

const NOW_MS = Date.parse(fixture.now);

describe("text functions", () => {
  for (const c of fixture.text_functions as {
    text: string;
    candidate_text_from_line: string | null;
    strip_list_marker: string;
    is_heading_line: boolean;
    is_obviously_transient: boolean;
    normalize_candidate_text: string;
    candidate_id: string;
    detect_themes: string[];
    durability_score: number;
    specificity_score: number;
    byte_len: number;
  }[]) {
    test(JSON.stringify(c.text).slice(0, 56), () => {
      expect(candidateTextFromLine(c.text) ?? null).toBe(c.candidate_text_from_line);
      expect(stripListMarker(c.text)).toBe(c.strip_list_marker);
      expect(isHeadingLine(c.text)).toBe(c.is_heading_line);
      expect(isObviouslyTransient(c.text)).toBe(c.is_obviously_transient);
      expect(normalizeCandidateText(c.text)).toBe(c.normalize_candidate_text);
      expect(candidateId(c.normalize_candidate_text)).toBe(c.candidate_id);
      expect(detectThemes(c.text)).toEqual(c.detect_themes);
      expect(durabilityScore(c.text, c.detect_themes)).toBe(c.durability_score);
      expect(specificityScore(c.text)).toBe(c.specificity_score);
    });
  }
});

describe("path functions", () => {
  for (const c of fixture.path_functions as {
    path: string;
    is_generated_dreaming_path: boolean;
    is_candidate_source_path: boolean;
    source_kind: string;
  }[]) {
    test(c.path, () => {
      expect(isGeneratedDreamingPath(c.path)).toBe(c.is_generated_dreaming_path);
      expect(isCandidateSourcePath(c.path)).toBe(c.is_candidate_source_path);
      expect(sourceKind(c.path)).toBe(c.source_kind);
    });
  }
});

describe("recency buckets", () => {
  for (const c of fixture.recency as { modified_at: string; score: number }[]) {
    test(c.modified_at || "(empty)", () => {
      expect(recencyScoreAt(c.modified_at, NOW_MS)).toBe(c.score);
    });
  }
});

describe("f32 rounding", () => {
  // The whole reason this table exists: JavaScript has no f32, so every one of
  // these is a chance for the promotion threshold to be crossed differently.
  for (const c of fixture.rounding as { input: number; rounded: number }[]) {
    test(`${c.input} -> ${c.rounded}`, () => {
      expect(roundScore(c.input)).toBe(c.rounded);
    });
  }
});

describe("scoring and gates", () => {
  interface Scored {
    label: string;
    candidate: {
      text: string;
      source: string;
      durability_score: number;
      specificity_score: number;
      recency_score: number;
      unique_source_count: number;
      recall_count: number;
      theme_hits: string[];
      evidence: unknown[];
    };
    promotion_score: number;
    gates: { name: string; passed: boolean; reason: string }[];
  }

  for (const c of fixture.scored_candidates as unknown as Scored[]) {
    test(c.label.slice(0, 70), () => {
      const reinforced = c.label.includes("| reinforced |");
      const signals: Record<string, number> = {};
      if (reinforced) for (const t of c.candidate.theme_hits) signals[t] = 3;

      expect(scoreCandidate(c.candidate, signals)).toBe(c.promotion_score);

      const present = c.label.endsWith("present=true");
      expect(
        promotionGates(
          { ...c.candidate, promotion_score: c.promotion_score },
          present,
        ),
      ).toEqual(c.gates);
    });
  }
});

describe("the promotion threshold itself", () => {
  // Driven by explicit scores rather than whatever the corpus happens to
  // produce, so the boundary is pinned exactly — a `>` where the Rust has `>=`
  // silently drops every candidate that lands on 0.60.
  for (const c of fixture.gate_thresholds as {
    promotion_score: number;
    gates: { name: string; passed: boolean; reason: string }[];
  }[]) {
    test(`score ${c.promotion_score}`, () => {
      expect(
        promotionGates(
          {
            text: "Dana prefers tea over coffee in the morning",
            source: "notes.md",
            promotion_score: c.promotion_score,
            unique_source_count: 1,
            evidence: [null],
          },
          true,
        ),
      ).toEqual(c.gates);
    });
  }
});
