import type { AutonomyService } from "../autonomy/service.ts";
import { characterDataDir } from "../config/dirs.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { lastDream, publicRecord } from "../memory/dreaming/records.ts";
import type { OperationInput, OperationResult } from "../operations/contracts.ts";
import { localRfc3339 } from "../util/time.ts";
import { invalidRequest } from "./errors.ts";

export interface DreamContext {
  characterName: string;
  config: LoadedConfig;
  autonomy: Pick<AutonomyService, "forceDreamNow" | "dreamStatus">;
}

function localTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : localRfc3339(new Date(ms));
}

export function dream(ctx: DreamContext, args: OperationInput<"dream">): OperationResult<"dream"> {
  const character = ctx.characterName;
  if (args.now === true && !ctx.autonomy.forceDreamNow(character)) {
    throw invalidRequest(`No autonomy state for character '${character}'`);
  }
  const status = ctx.autonomy.dreamStatus(character);
  const last = lastDream(characterDataDir(ctx.config.dirs.data, character));
  const record = last === undefined ? undefined : publicRecord(last);
  return {
    character,
    enabled: status?.enabled ?? ctx.config.app.memory.dreaming.enabled,
    queued: status?.queued ?? false,
    running: status?.running ?? false,
    ...(status?.nextDueAt === undefined ? {} : { next_due_at: localRfc3339(new Date(status.nextDueAt)) }),
    ...(record === undefined
      ? {}
      : { last: { ...record, started_at: localTime(record.started_at), ended_at: localTime(record.ended_at) } }),
  };
}
