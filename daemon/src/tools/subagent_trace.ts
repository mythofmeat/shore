import { characterScope, importLegacyLog, insertEvent, readEvents, withStorage } from "../storage/store.ts";
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
  messages_expired?: boolean;
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
  await migrateTraces(characterDataDir);
  const { data, character } = characterScope(characterDataDir);
  withStorage(data, (db) => insertEvent(db, { character, kind: "subagent", key: record.parent_tool_use_id, timestamp: record.ts, content: JSON.stringify(record) }));
}

export async function readSubagentTraces(
  characterDataDir: string,
  query: TraceQuery = {},
): Promise<SubagentTrace[]> {
  await migrateTraces(characterDataDir);
  const { data, character } = characterScope(characterDataDir);
  return readEvents(data, character, ["subagent", "subagent_result"], query.count, query.ids)
    .flatMap((line) => { const trace = parseTrace(line); return trace === undefined ? [] : [trace]; });
}

async function migrateTraces(characterDir: string): Promise<void> {
  const { data, character } = characterScope(characterDir);
  await importLegacyLog(data, `${character}/${TRACE_FILE}`, (line) => {
    const trace = parseTrace(line);
    return { character, kind: trace === undefined ? "legacy_invalid" : "subagent", key: trace?.parent_tool_use_id, timestamp: trace?.ts ?? "", content: line };
  });
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
    ...(fields["messages_expired"] === true ? { messages_expired: true } : {}),
    ...(typeof fields["result"] === "string" ? { result: fields["result"] } : {}),
    ...(typeof fields["error"] === "string" ? { error: fields["error"] } : {}),
  };
}
