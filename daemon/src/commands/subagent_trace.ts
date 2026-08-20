import { characterDataDir } from "../config/dirs.ts";
import { readSubagentTraces, type SubagentTrace } from "../tools/subagent_trace.ts";
import { internalError } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

const DEFAULT_COUNT = 20;

export interface SubagentTraceContext {
  dataDir: string;
  characterName: string;
}

export async function subagentTrace(ctx: SubagentTraceContext, args: Args): Promise<Json> {
  const ids = stringList(args["ids"]);
  const count = countArg(args, DEFAULT_COUNT);
  const dir = characterDataDir(ctx.dataDir, ctx.characterName);

  let traces: SubagentTrace[];
  try {
    traces = await readSubagentTraces(dir, {
      ...(ids === undefined ? {} : { ids }),
      ...(ids === undefined ? { count } : {}),
    });
  } catch (e) {
    throw internalError(
      `subagent trace read failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    character: ctx.characterName,
    ...(ids === undefined ? {} : { requested_ids: ids }),
    entries: traces as unknown,
  };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((v): v is string => typeof v === "string");
  return ids.length === 0 ? undefined : ids;
}

function countArg(args: Args, fallback: number): number {
  const v = args["count"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}
