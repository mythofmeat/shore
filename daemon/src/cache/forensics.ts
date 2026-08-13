import { appendFileSync } from "node:fs";
import { join } from "node:path";

import type { CallContext } from "../llm/types.ts";

export const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;

export interface CachePlacement {
  msg_breakpoints: number[];
  sys_breakpoints: number[];
  msg_count: number;
  sys_blocks: number;
  cache_enabled: boolean;
  has_existing_markers: boolean;
  breakpoints_requested: number;
  breakpoints_placed: number;
  breakpoints_dropped_no_anchor: number;
  breakpoints_dropped_over_limit: number;
}

export interface CacheUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

const LOG_FILE = "cache_forensics.jsonl";

export function recordCacheCall(
  ctx: CallContext | undefined,
  model: string,
  placement: CachePlacement,
  usage: CacheUsage,
  outcome: string,
): void {
  const dir = ctx?.forensics_dir;
  if (ctx === undefined || dir === undefined) return;
  const row = {
    ts: new Date().toISOString(),
    character: ctx.character,
    call_type: ctx.call_type,
    ...(ctx.rid !== undefined ? { rid: ctx.rid } : {}),
    model,
    outcome,
    ...placement,
    ...usage,
  };
  try {
    appendFileSync(join(dir, LOG_FILE), `${JSON.stringify(row)}\n`);
  } catch {
  }
}
