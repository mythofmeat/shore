import type { BashResult } from "./bash.ts";
import { historyText } from "./history_output.ts";
import type { SearchHistoryResult } from "./history.ts";
import type { FetchUrlResult } from "./web.ts";
import type { HeatmapResult } from "./activity.ts";
import type { ModelHistoryResult } from "./model_history.ts";
import { payloadText } from "./media.ts";

interface SearchOutput {
  query: string;
  mode?: string;
  results: { path: string; line: number; excerpt: string }[];
  has_more?: boolean;
  semantic_unavailable?: string;
  pending_files?: number;
  skipped_binary_or_large?: number;
  note?: string;
}

function oneLine(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function searchText(value: SearchOutput): string {
  const lines = [`Search ${JSON.stringify(value.query)} (${value.mode ?? "lexical"}): ${value.results.length} results`];
  let previousPath: string | undefined;
  for (const result of value.results) {
    if (result.path !== previousPath) {
      lines.push("", oneLine(result.path));
      previousPath = result.path;
    }
    lines.push(`  ${result.line}: ${result.excerpt}`);
  }
  if (value.results.length === 0 && value.note) lines.push(value.note);
  if (value.has_more) lines.push("More matches available. Increase max_results (up to 100) or narrow query/path.");
  if (value.semantic_unavailable) lines.push(`Semantic search unavailable: ${value.semantic_unavailable}`);
  if (value.pending_files) lines.push(`${value.pending_files} files pending semantic indexing.`);
  if (value.skipped_binary_or_large) lines.push(`${value.skipped_binary_or_large} binary or oversized files skipped.`);
  return lines.join("\n");
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
    case "search_chat_logs":
      return historyText(value as SearchHistoryResult);
    case "fetch_url": {
      const result = value as FetchUrlResult;
      const range = result.returned_chars === 0 ? "no characters returned" : `characters ${result.offset}–${result.offset + result.returned_chars - 1} of ${result.total_chars}`;
      const lines = [`${result.url} (${result.content_type}; ${range})`];
      if (result.next_offset !== undefined) lines.push(`Continue with offset=${result.next_offset} and the same URL and limit. If output is clipped, retry this offset with a smaller limit.`);
      if (result.body_truncated) lines.push("Download limit reached (5 MiB). Content beyond the downloaded portion is unavailable; pagination cannot recover it.");
      lines.push("", result.content);
      return lines.join("\n");
    }
    case "search":
      return searchText(value as SearchOutput);
    case "activity_heatmap":
      return heatmapText(value as HeatmapResult);
    case "model_history":
      return modelHistoryText(value as ModelHistoryResult);
    case "web_search": {
      const result = value as { query: string; results: { title: string; url: string; content: string }[]; answer?: string };
      const lines = [`Web search ${JSON.stringify(result.query)}: ${result.results.length} results`];
      if (result.answer) lines.push("", `Search provider summary: ${result.answer}`);
      for (const [index, row] of result.results.entries()) {
        lines.push("", `${index + 1}. ${oneLine(row.title)}`, row.url, row.content);
      }
      return lines.join("\n");
    }
    default:
      return payloadText(value);
  }
}
