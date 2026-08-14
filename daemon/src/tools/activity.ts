import type { ActivityStats, Weekday } from "../autonomy/activity.ts";

export interface HeatmapHour {
  hour: number;
  density: number;
  classification: string;
}

export interface HeatmapWeekday {
  weekday: Weekday;
  message_count: number;
  density: number;
}

export interface HeatmapResult {
  days: number;
  hours: HeatmapHour[];
  weekdays: HeatmapWeekday[];
  total_messages: number;
  messages_in_window: number;
  has_sufficient_data: boolean;
  engagement_score: number;
  sessions_per_day: number;
}

export type ActivityStatsLookup = (
  days: number,
) => { stats: ActivityStats; turnCount: number } | undefined;

const HOURS_IN_DAY = 24;
const DEFAULT_DAYS = 30;

const WEEKDAY_ORDER: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function daysFrom(input: Record<string, unknown>): number {
  const raw = input["days"];
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return DEFAULT_DAYS;
  return raw;
}

function emptyHours(): HeatmapHour[] {
  return Array.from({ length: HOURS_IN_DAY }, (_unused, hour) => ({
    hour,
    density: 0.0,
    classification: "normal",
  }));
}

function emptyWeekdays(): HeatmapWeekday[] {
  return WEEKDAY_ORDER.map((weekday) => ({ weekday, message_count: 0, density: 0.0 }));
}

export function handleActivityHeatmap(
  input: Record<string, unknown>,
  lookup: ActivityStatsLookup,
): HeatmapResult {
  const days = daysFrom(input);
  const found = lookup(days);

  if (found === undefined) {
    return {
      days,
      hours: emptyHours(),
      weekdays: emptyWeekdays(),
      total_messages: 0,
      messages_in_window: 0,
      has_sufficient_data: false,
      engagement_score: 0.0,
      sessions_per_day: 0.0,
    };
  }

  const { stats, turnCount } = found;
  const hours: HeatmapHour[] = Array.from({ length: HOURS_IN_DAY }, (_unused, hour) => ({
    hour,
    density: stats.pooledHourHistogram[hour] ?? 0.0,
    classification: stats.pooledHourClassifications[hour] ?? "normal",
  }));

  const inWindow = stats.windowMessageCount;
  const weekdays: HeatmapWeekday[] = WEEKDAY_ORDER.map((weekday) => {
    const count = stats.weekdayCounts[weekday];
    return {
      weekday,
      message_count: count,
      density: inWindow > 0 ? count / inWindow : 0.0,
    };
  });

  return {
    days,
    hours,
    weekdays,
    total_messages: turnCount,
    messages_in_window: inWindow,
    has_sufficient_data: stats.hasSufficientHeatmap,
    engagement_score: stats.engagementScore,
    sessions_per_day: stats.sessionsPerDay,
  };
}
