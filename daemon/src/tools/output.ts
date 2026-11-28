import type { BashResult } from "./bash.ts";
import type { HeatmapResult } from "./activity.ts";
import type { ModelHistoryResult } from "./model_history.ts";
import { payloadText } from "./media.ts";
import type { Texts } from "../texts/texts.ts";

function oneLine(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function heatmapText(texts: Texts, value: HeatmapResult): string | undefined {
  return texts.render("output_activity", {
    days: String(value.days),
    messages: String(value.messages_in_window),
    total: String(value.total_messages),
    empty: value.messages_in_window === 0 ? "yes" : undefined,
    thin: value.has_sufficient_data ? undefined : "yes",
    engagement: value.engagement_score.toFixed(2),
    sessions: value.sessions_per_day.toFixed(2),
    hours: value.hours.map((row) => `${String(row.hour).padStart(2, "0")}    ${(row.density * 100).toFixed(1).padStart(5)}%  ${row.classification}`).join("\n"),
    weekdays: value.weekdays.map((row) => `${row.weekday}  ${String(row.message_count).padStart(8)}  ${(row.density * 100).toFixed(1)}%`).join("\n"),
  });
}

function modelHistoryText(texts: Texts, value: ModelHistoryResult): string | undefined {
  const range = value.time_range;
  return texts.render("output_model_history", {
    character: oneLine(value.character),
    zone: value.time_zone,
    range: range.start_time || range.end_time ? "yes" : undefined,
    from: range.start_time ?? undefined,
    to: range.end_time ?? undefined,
    none: value.models.length === 0 ? "yes" : undefined,
    rows: value.models.map((row) => [row.model, row.provider, row.call_type, row.kind, String(row.calls), row.first_seen, row.last_seen].map(oneLine).join(" | ")).join("\n"),
  });
}

export function formatToolOutput(texts: Texts, name: string, value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return payloadText(value);
  switch (name) {
    case "bash": {
      const result = value as BashResult;
      return texts.render("output_bash", {
        code: result.exit_code === null ? undefined : String(result.exit_code),
        workdir: oneLine(result.workdir),
        stdout: result.stdout.replace(/\n$/, ""),
        stderr: result.stderr === "" ? undefined : texts.render("tool_stderr", { stderr: result.stderr.replace(/\n$/, "") }),
        reload: result.prompt_files_changed.length > 0 ? texts.render("prompt_reload", { files: result.prompt_files_changed.join(", ") }) : undefined,
      }) ?? "";
    }
    case "activity_heatmap":
      return heatmapText(texts, value as HeatmapResult) ?? "";
    case "model_history":
      return modelHistoryText(texts, value as ModelHistoryResult) ?? "";
    default:
      return payloadText(value);
  }
}
