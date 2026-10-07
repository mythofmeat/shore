import type { BashResult } from "./bash.ts";
import type { HeatmapResult } from "./activity.ts";
import type { ModelHistoryResult } from "./model_history.ts";
import { payloadText } from "./media.ts";

function oneLine(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function heatmapText(value: HeatmapResult): string {
  const lines = [`Activity over ${value.days} days: ${value.messages_in_window} messages (${value.total_messages} total)`];
  if (value.messages_in_window === 0) return `${lines[0]}\nNo activity data in this window.`;
  if (!value.has_sufficient_data) lines.push("Insufficient data for reliable activity patterns.");
  lines.push(`Engagement: ${value.engagement_score.toFixed(2)}; sessions/day: ${value.sessions_per_day.toFixed(2)}`);
  lines.push("", "Hour  Share   Activity");
  for (const row of value.hours) {
    lines.push(`${String(row.hour).padStart(2, "0")}    ${(row.density * 100).toFixed(1).padStart(5)}%  ${row.classification}`);
  }
  lines.push("", "Day  Messages  Share");
  for (const row of value.weekdays) {
    lines.push(`${row.weekday}  ${String(row.message_count).padStart(8)}  ${(row.density * 100).toFixed(1)}%`);
  }
  return lines.join("\n");
}

function modelHistoryText(value: ModelHistoryResult): string {
  const lines = [`Model history for ${oneLine(value.character)} (${value.time_zone})`];
  const range = value.time_range;
  if (range.start_time || range.end_time) {
    lines.push(`${range.start_time ?? "earliest"} to ${range.end_time ?? "latest"} (inclusive)`);
  }
  if (value.models.length === 0) return [...lines, "No model usage in this range."].join("\n");
  lines.push("", "Model | Provider | Call type | Kind | Calls | First seen | Last seen");
  for (const row of value.models) {
    lines.push([row.model, row.provider, row.call_type, row.kind, String(row.calls), row.first_seen, row.last_seen].map(oneLine).join(" | "));
  }
  return lines.join("\n");
}

export function formatToolOutput(name: string, value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return payloadText(value);
  switch (name) {
    case "bash": {
      const result = value as BashResult;
      const lines = [`bash: exit ${result.exit_code ?? "terminated by signal"}`, `workdir: ${oneLine(result.workdir)}`];
      if (result.stdout) lines.push(result.stdout.replace(/\n$/, ""));
      if (result.stderr) lines.push(`stderr:\n${result.stderr.replace(/\n$/, "")}`);
      if (result.prompt_files_changed.length > 0) {
        lines.push(`Prompt reload queued: ${result.prompt_files_changed.join(", ")}.`);
      }
      return lines.join("\n");
    }
    case "activity_heatmap":
      return heatmapText(value as HeatmapResult);
    case "model_history":
      return modelHistoryText(value as ModelHistoryResult);
    default:
      return payloadText(value);
  }
}
