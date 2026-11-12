import { keptDiary } from "../autonomy/diary.ts";
import { characterDataDir } from "../config/dirs.ts";
import type { OperationInput, OperationResult } from "../operations/contracts.ts";

const NEWEST_LISTED = 20;

export interface DiaryContext {
  characterName: string;
  dataDir: string;
  now: number;
}

export function diary(ctx: DiaryContext, args: OperationInput<"diary">): OperationResult<"diary"> {
  const kept = keptDiary(characterDataDir(ctx.dataDir, ctx.characterName), ctx.now);
  return {
    character: ctx.characterName,
    notes: kept.slice(-(args.count ?? NEWEST_LISTED)).map(({ id: _id, ...note }) => note),
    kept: kept.length,
  };
}
