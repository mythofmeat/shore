import type { CompactionReport } from "../../protocol/CompactionReport.ts";
import type { ContentBlock } from "../../protocol/ContentBlock.ts";
import type { Message } from "../../protocol/Message.ts";
import type { ToolResultContent } from "../../protocol/ToolResultContent.ts";

export type TranscriptItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "context"; key: string }
  | { kind: "message"; key: string; message: Message; index: number; last: boolean };

function dayKey(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth())}-${String(date.getDate())}`;
}

export function dayLabel(date: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: days < 7 ? "long" : undefined, month: "long", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function lastAssistantIndex(messages: readonly Message[]): number {
  return messages.findLastIndex((message) => message.role === "assistant");
}

export function transcriptItems(messages: readonly Message[], activeStart: number, now = new Date()): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const lastAssistant = lastAssistantIndex(messages);
  let previousDay = "";
  messages.forEach((message, index) => {
    if (index === activeStart && index > 0) items.push({ kind: "context", key: `context:${message.msg_id}` });
    const date = new Date(message.timestamp);
    if (!Number.isNaN(date.getTime())) {
      const key = dayKey(date);
      if (key !== previousDay) { items.push({ kind: "day", key: `day:${key}:${message.msg_id}`, label: dayLabel(date, now) }); previousDay = key; }
    }
    items.push({ kind: "message", key: message.msg_id, message, index, last: index === lastAssistant });
  });
  return items;
}

export type BlockView =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string; redacted: boolean }
  | { kind: "tool"; key: string; id: string; name: string; input: unknown; output: string | null; error: boolean; images: string[] }
  | { kind: "image"; key: string; source: string };

export function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function toolResultImages(content: ToolResultContent): string[] {
  if (typeof content === "string") return [];
  return content.flatMap((block) => block.type === "image" ? [`data:${block.source.media_type};base64,${block.source.data}`] : []);
}

export function blockViews(blocks: readonly ContentBlock[]): BlockView[] {
  const views: BlockView[] = [];
  const tools = new Map<string, Extract<BlockView, { kind: "tool" }>>();
  blocks.forEach((block, index) => {
    const key = String(index);
    switch (block.type) {
      case "text": if (block.text.trim() !== "") views.push({ kind: "text", key, text: block.text }); break;
      case "thinking": if (block.thinking.trim() !== "") views.push({ kind: "thinking", key, text: block.thinking, redacted: false }); break;
      case "redacted_thinking": views.push({ kind: "thinking", key, text: "", redacted: true }); break;
      case "image": views.push({ kind: "image", key, source: `data:${block.source.media_type};base64,${block.source.data}` }); break;
      case "tool_use": {
        const view = { kind: "tool" as const, key: `tool:${block.id}`, id: block.id, name: block.name, input: block.input, output: null, error: false, images: [] };
        tools.set(block.id, view); views.push(view); break;
      }
      case "tool_result": {
        const view = tools.get(block.tool_use_id);
        const output = toolResultText(block.content);
        const images = toolResultImages(block.content);
        if (view === undefined) views.push({ kind: "tool", key, id: block.tool_use_id, name: "tool", input: null, output, error: block.is_error === true, images });
        else { view.output = output; view.error = block.is_error === true; view.images = images; }
        break;
      }
    }
  });
  return views;
}

export type StepView = Extract<BlockView, { kind: "thinking" | "tool" }>;
export type BodyItem = Exclude<BlockView, StepView> | { kind: "activity"; key: string; steps: StepView[] };

export function bodyItems(views: readonly BlockView[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const view of views) {
    const last = items.at(-1);
    if (view.kind !== "thinking" && view.kind !== "tool") items.push(view);
    else if (last?.kind === "activity") last.steps.push(view);
    else items.push({ kind: "activity", key: `activity:${view.key}`, steps: [view] });
  }
  return items;
}

export function activityHeadline(steps: readonly StepView[], live: boolean): { label: string; detail: string } {
  const latest = steps.at(-1);
  if (live && latest?.kind === "thinking") return { label: "Thinking…", detail: "" };
  if (live && latest?.kind === "tool" && latest.output === null) return { label: latest.name, detail: toolSummary(latest.input) };
  const names = [...new Set(steps.flatMap((step) => step.kind === "tool" ? [step.name] : []))];
  const calls = steps.filter((step) => step.kind === "tool").length;
  const count = `${String(calls)} tool${calls === 1 ? "" : "s"}`;
  const label = calls === 0 ? "Reasoning" : steps.some((step) => step.kind === "thinking") ? `Reasoned and used ${count}` : `Used ${count}`;
  const detail = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${String(names.length - 3)} more` : names.join(", ");
  return { label, detail };
}

export interface LiveReply { reasoning: string; text: string; blocks: readonly ContentBlock[]; tools: readonly string[]; round: { reasoning: string; text: string; tools: readonly string[] } }

const toolUseIds = (blocks: readonly ContentBlock[]): string[] => blocks.flatMap((block) => block.type === "tool_use" ? [block.id] : []);

export function savedPart(messages: readonly Message[], stream: Pick<LiveReply, "tools">): Message | undefined {
  const last = messages.at(-1);
  if (last === undefined) return undefined;
  const shared = toolUseIds(last.content_blocks).some((id) => stream.tools.includes(id));
  const awaitingTools = stream.tools.length === 0 && last.content_blocks.at(-1)?.type === "tool_use";
  return shared || awaitingTools ? last : undefined;
}

export function replyBlocks(stream: LiveReply, saved: Message | undefined): ContentBlock[] {
  const blocks = saved?.content_blocks ?? [];
  const ids = toolUseIds(blocks);
  const answered = new Set(blocks.flatMap((block) => block.type === "tool_result" ? [block.tool_use_id] : []));
  const tools = stream.blocks.filter((block) => block.type === "tool_use" ? !ids.includes(block.id) : block.type === "tool_result" && !answered.has(block.tool_use_id));
  const latest = ids.at(-1);
  const roundSaved = latest !== undefined && (stream.round.tools.includes(latest) || !stream.tools.includes(latest));
  const unsaved = saved === undefined ? stream : roundSaved ? { reasoning: "", text: "" } : stream.round;
  return [
    ...blocks,
    ...(unsaved.reasoning === "" ? [] : [{ type: "thinking" as const, thinking: unsaved.reasoning }]),
    ...(unsaved.text === "" ? [] : [{ type: "text" as const, text: unsaved.text }]),
    ...tools,
  ];
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function toolSummary(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return scalar(input) ?? "";
  const values = Object.values(input as Record<string, unknown>);
  const first = values.find((value): value is string => typeof value === "string" && value.trim() !== "") ?? values.find((value): value is number => typeof value === "number");
  return first === undefined ? "" : String(first).split("\n")[0] ?? "";
}

export function formatToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return scalar(input) ?? "";
  const entries = Object.entries(input as Record<string, unknown>);
  return entries.map(([key, value]) => `${key}: ${scalar(value) ?? JSON.stringify(value, null, 2)}`).join("\n");
}

export interface SwipeState { position: number; count: number; canPrevious: boolean; atLast: boolean }

export function swipeState(message: Pick<Message, "alt_index" | "alt_count">): SwipeState {
  const count = Math.max(1, message.alt_count ?? 1);
  const position = Math.min(count, Math.max(1, (message.alt_index ?? count - 1) + 1));
  return { position, count, canPrevious: position > 1, atLast: position >= count };
}

export function visibleStreams<T extends { subagent: string | null; final: boolean; msgId: string | null; rid: string | null }>(streams: readonly T[], messages: readonly Pick<Message, "msg_id">[], active: ReadonlySet<string>): T[] {
  return streams.filter((stream) => stream.subagent === null && (!stream.final || (!messages.some((message) => message.msg_id === stream.msgId) && stream.rid !== null && active.has(stream.rid))));
}

const realUserTurn = (message: Message): boolean => message.role === "user" && !(message.content_blocks.length > 0 && message.content_blocks.every((block) => block.type === "tool_result"));

export function optimisticRegenReplaces(messages: readonly Message[], activeStart: number): string[] {
  return messages.slice(Math.max(messages.findLastIndex(realUserTurn) + 1, activeStart)).map((message) => message.msg_id);
}

export function regenReplaces(messages: readonly Message[], activeStart: number, visible: readonly { replaces?: readonly string[] }[], pendingRegen: boolean): string[] {
  const listed = visible.flatMap((stream) => stream.replaces ?? []);
  return [...new Set(pendingRegen ? [...listed, ...optimisticRegenReplaces(messages, activeStart)] : listed)];
}

export function compactionPhase(activity: readonly { id: number; type: string; data: unknown }[]): string | null {
  let phase: { id: number; text: string } | null = null;
  let finished = -1;
  for (const item of activity) {
    const value = item.data !== null && typeof item.data === "object" ? (item.data as { phase?: unknown }).phase : undefined;
    if (item.type === "phase" && typeof value === "string" && value.startsWith("compacting")) phase = { id: item.id, text: value };
    if (item.type === "request_finished") finished = item.id;
  }
  if (phase === null || phase.id < finished) return null;
  const round = /round (\d+)/.exec(phase.text)?.[1];
  return round === undefined || round === "1" ? "Compacting context…" : `Compacting context (round ${round})…`;
}

export function compactionSummary(report: CompactionReport): string {
  switch (report.status) {
    case "compacted": return `Summarized ${String(report.compacted_turns)} turns and kept the last ${String(report.retained_turns)}.`;
    case "rotated": return `Archived ${String(report.compacted_turns)} turns and kept the last ${String(report.retained_turns)}.`;
    case "dry_run": return `Compaction would summarize ${String(report.compacted_turns)} turns and write ${String(report.would_write_files)} memory files.`;
    case "truncated": return `Compaction stopped early after summarizing ${String(report.compacted_turns)} turns; ${String(report.truncated_turns)} turns were left as they were.`;
    case "paused": return `Compaction paused: ${report.detail ?? report.reason}.${report.resume_at === null ? "" : ` It resumes at ${new Date(report.resume_at).toLocaleTimeString()}.`}`;
  }
}
