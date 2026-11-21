import { changePresence, MAX_STATUS_CHARS, presenceState, type PresenceState } from "../autonomy/presence.ts";
import type { PresenceArgs } from "../protocol/PresenceArgs.ts";
import type { PresenceResult } from "../protocol/PresenceResult.ts";
import { invalidRequest } from "./errors.ts";

export interface PresenceContext {
  dataDir: string;
  changed?: () => Promise<void>;
}

function trimmed(given: readonly string[] | undefined): string[] {
  return (given ?? []).map((status) => status.trim());
}

function shown({ presence, history }: PresenceState): PresenceResult {
  return { statuses: presence?.statuses ?? [], history };
}

export async function presenceCommand(ctx: PresenceContext, args: PresenceArgs): Promise<PresenceResult> {
  const on = trimmed(args.on);
  const off = trimmed(args.off);
  const forget = trimmed(args.forget);
  const wrong = on.find((status) => status === "" || Array.from(status).length > MAX_STATUS_CHARS || /\p{Cc}/u.test(status));
  if (wrong !== undefined) throw invalidRequest(`${JSON.stringify(wrong)} can't be a status: a status is 1 to ${String(MAX_STATUS_CHARS)} characters, on one line`);
  const both = on.find((status) => off.includes(status));
  if (both !== undefined) throw invalidRequest(`${JSON.stringify(both)} can't be turned on and off at once`);
  if (on.length + off.length + forget.length === 0 && args.clear !== true) return shown(presenceState(ctx.dataDir));
  const result = changePresence(ctx.dataDir, { on, off, clear: args.clear, forget }, Date.now());
  if (result.changed) await ctx.changed?.();
  return shown(result);
}
