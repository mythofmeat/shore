import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../engine/types.ts";
import { localRfc3339 } from "../util/time.ts";

const TRACE_FILE = "subagents.jsonl";

export interface SubagentTrace {
  ts: string;
  subagent: string;
  parent_tool_use_id: string;
  rid?: string;
  model: string;
  messages: Message[];
  result?: string;
  error?: string;
}

export interface TraceQuery {
  ids?: readonly string[];
  count?: number;
}

export function subagentTraceFile(characterDataDir: string): string {
  return join(characterDataDir, TRACE_FILE);
}

export async function appendSubagentTrace(
  characterDataDir: string,
  trace: Omit<SubagentTrace, "ts"> & { ts?: string },
  now: () => Date = () => new Date(),
): Promise<void> {
  const record: SubagentTrace = { ...trace, ts: trace.ts ?? localRfc3339(now()) };
  await mkdir(characterDataDir, { recursive: true });
  await appendFile(subagentTraceFile(characterDataDir), `${JSON.stringify(record)}\n`, "utf8");
}

export async function readSubagentTraces(
  characterDataDir: string,
  query: TraceQuery = {},
): Promise<SubagentTrace[]> {
  let content: string;
  try {
    content = await readFile(subagentTraceFile(characterDataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const wanted = query.ids === undefined ? undefined : new Set(query.ids);
  const traces: SubagentTrace[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const trace = parseTrace(line);
    if (trace === undefined) continue;
    if (wanted !== undefined && !wanted.has(trace.parent_tool_use_id)) continue;
    traces.push(trace);
  }

  const count = query.count;
  if (count === undefined || count <= 0 || traces.length <= count) return traces;
  return traces.slice(traces.length - count);
}

function parseTrace(line: string): SubagentTrace | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const fields = parsed as Record<string, unknown>;
  const parentId = fields["parent_tool_use_id"];
  const subagent = fields["subagent"];
  if (typeof parentId !== "string" || typeof subagent !== "string") return undefined;

  return {
    ts: typeof fields["ts"] === "string" ? fields["ts"] : "",
    subagent,
    parent_tool_use_id: parentId,
    ...(typeof fields["rid"] === "string" ? { rid: fields["rid"] } : {}),
    model: typeof fields["model"] === "string" ? fields["model"] : "",
    messages: Array.isArray(fields["messages"]) ? (fields["messages"] as Message[]) : [],
    ...(typeof fields["result"] === "string" ? { result: fields["result"] } : {}),
    ...(typeof fields["error"] === "string" ? { error: fields["error"] } : {}),
  };
}
