import type { AutonomyService } from "../autonomy/service.ts";
import { characterDataDir } from "../config/dirs.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { toRfc3339 } from "../ledger/zoned.ts";
import { lastDream, publicRecord } from "../memory/dreaming/records.ts";
import type { OperationInput, OperationResult } from "../operations/contracts.ts";
import { invalidRequest } from "./errors.ts";

export interface DreamContext {
  characterName: string;
  config: LoadedConfig;
  autonomy: Pick<AutonomyService, "forceDreamNow" | "dreamStatus">;
}

export function dream(ctx: DreamContext, args: OperationInput<"dream">): OperationResult<"dream"> {
  const character = ctx.characterName;
  if (args.now === true && ctx.autonomy.forceDreamNow(character) === undefined) {
    throw invalidRequest(`No autonomy state for character '${character}'`);
  }
  const status = ctx.autonomy.dreamStatus(character);
  const last = lastDream(characterDataDir(ctx.config.dirs.data, character));
  return {
    character,
    enabled: status?.enabled ?? ctx.config.app.memory.dreaming.enabled,
    queued: status?.queued ?? false,
    running: status?.running ?? false,
    ...(status?.nextDueAt === undefined ? {} : { next_due_at: toRfc3339(status.nextDueAt) }),
    ...(last === undefined ? {} : { last: publicRecord(last) }),
  };
}
