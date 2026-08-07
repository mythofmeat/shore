/**
 * Cache forensics — the append-only JSONL the daemon reads when a cache bill
 * looks wrong.
 *
 * This lives in the sidecar because the row that matters records **which
 * `cache_control` breakpoints were placed**, and placement is decided in the
 * Anthropic adapter. The daemon used to write this log; when placement moved
 * here it kept the writer and lost the data, so for a long stretch the log had
 * response rows whose `call_id` correlated with nothing and no request rows at
 * all. Cache questions were unanswerable from disk that whole time.
 *
 * One row per call, placement and usage together — there is no correlation id
 * because there is nothing to correlate.
 *
 * The daemon fills `context.forensics_dir` only when
 * `[advanced].cache_forensics` is on, so its absence is the off switch and this
 * module needs no configuration of its own. The labels themselves ride on the
 * same `CallContext` the ledger row is written from — they used to have their
 * own `ForensicsContext`, which was the same three fields sent only when
 * forensics happened to be enabled.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import type { CallContext } from "./types.ts";

/** What the adapter decided about caching for this call. */
export interface CachePlacement {
  /** Indices into `messages[]` that received a `cache_control` marker. */
  msg_breakpoints: number[];
  /** Indices into the system block array that received one. */
  sys_breakpoints: number[];
  msg_count: number;
  sys_blocks: number;
  /** False when the model has no `cache_ttl` — nothing was placed. */
  cache_enabled: boolean;
  /** True when the incoming messages already carried `cache_control`.
   *
   * Observation only — placement runs regardless and `normalizeMessages` strips
   * them first. It is worth logging because a marker arriving here means one
   * leaked into persisted history, which is a bug upstream even though it no
   * longer breaks caching. */
  has_existing_markers: boolean;
}

/** The provider's reported cache accounting for this call. */
export interface CacheUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

const LOG_FILE = "cache_forensics.jsonl";

/**
 * Append one row. Best-effort: a forensics failure must never take down a call
 * that otherwise succeeded, so I/O errors are swallowed.
 */
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
    // Diagnostics are never worth failing a call over.
  }
}
