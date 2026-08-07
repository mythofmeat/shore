import type { ActivityStats } from "../autonomy/activity.ts";

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

export type ActivityStatsLookup = () => { stats: ActivityStats; turnCount: number } | undefined;

const HOURS_IN_DAY = 24;

function daysFrom(input: Record<string, unknown>): number {
  const raw = input["days"];
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return 30;
  return raw;
}

function emptyHours(): HeatmapHour[] {
  return Array.from({ length: HOURS_IN_DAY }, (_unused, hour) => ({
    hour,
    density: 0.0,
    classification: "normal",
  }));
}

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
    density: stats.hourHistogram[hour] ?? 0.0,
    classification: stats.hourClassifications[hour] ?? "normal",
  }));

  return {
    days,
    hours,
    total_messages: turnCount,
    total_turns: turnCount,
    has_sufficient_data: stats.hasSufficientHeatmap,
    engagement_score: stats.engagementScore,
    sessions_per_day: stats.sessionsPerDay,
  };
}
