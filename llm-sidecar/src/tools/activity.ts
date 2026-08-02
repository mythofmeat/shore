/**
 * `activity_heatmap` — when the user typically talks to this character.
 *
 * Ported from `crates/daemon/src/tools/activity.rs`, pinned by
 * `tests/tools_fixtures/tool_handlers_parity.json`.
 *
 * The statistics themselves are not computed here: `autonomy/activity.ts`
 * already owns the histogram, the peak/trough classification and the
 * engagement score, pinned by `autonomy_fixtures/activity_parity.json`. What
 * this module does is reshape those into the tool's response, and answer with
 * an empty heatmap when no tracker is wired.
 */

import type { ActivityStats } from "../autonomy/activity.ts";

/** One hour's slot in the response. */
export interface HeatmapHour {
  hour: number;
  density: number;
  classification: string;
}

export interface HeatmapResult {
  days: number;
  hours: HeatmapHour[];
  total_messages: number;
  total_turns: number;
  has_sufficient_data: boolean;
  engagement_score: number;
  sessions_per_day: number;
}

/** What the tool needs from the activity tracker, if anything is wired. */
export type ActivityStatsLookup = () => { stats: ActivityStats; turnCount: number } | undefined;

const HOURS_IN_DAY = 24;

/**
 * The `days` argument.
 *
 * Rust read this with `as_u64`, which accepts only a JSON integer that fits an
 * unsigned 64-bit value — so a string `"7"`, a negative, and a float all miss
 * and fall back to 30. `Number.isSafeInteger` plus a non-negative check is the
 * same set for any value a model realistically sends.
 */
function daysFrom(input: Record<string, unknown>): number {
  const raw = input["days"];
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return 30;
  return raw;
}

/** Every hour at zero density and normal classification. */
function emptyHours(): HeatmapHour[] {
  return Array.from({ length: HOURS_IN_DAY }, (_unused, hour) => ({
    hour,
    density: 0.0,
    classification: "normal",
  }));
}

/**
 * Handle `activity_heatmap`.
 *
 * Both branches return the same keys — a caller cannot tell "no tracker" from
 * "a tracker with nothing in it" by shape, only by `has_sufficient_data`. That
 * is deliberate: the model gets one response format to read.
 */
export function handleActivityHeatmap(
  input: Record<string, unknown>,
  lookup: ActivityStatsLookup,
): HeatmapResult {
  const days = daysFrom(input);
  const found = lookup();

  if (found === undefined) {
    return {
      days,
      hours: emptyHours(),
      total_messages: 0,
      total_turns: 0,
      has_sufficient_data: false,
      engagement_score: 0.0,
      sessions_per_day: 0.0,
    };
  }

  const { stats, turnCount } = found;
  const hours: HeatmapHour[] = Array.from({ length: HOURS_IN_DAY }, (_unused, hour) => ({
    hour,
    // A histogram or classification shorter than 24 entries reads as zero and
    // "normal" rather than throwing — the Rust used `.get(h)` with defaults,
    // and a truncated tracker should degrade, not fail the tool.
    density: stats.hourHistogram[hour] ?? 0.0,
    classification: stats.hourClassifications[hour] ?? "normal",
  }));

  return {
    days,
    hours,
    // Both keys carry the same number. The Rust did too: `total_messages` is
    // the older name and something may still read it.
    total_messages: turnCount,
    total_turns: turnCount,
    has_sufficient_data: stats.hasSufficientHeatmap,
    engagement_score: stats.engagementScore,
    sessions_per_day: stats.sessionsPerDay,
  };
}
