import { presence, setPresence } from "../autonomy/presence.ts";
import type { PresenceArgs } from "../protocol/PresenceArgs.ts";
import type { PresenceResult } from "../protocol/PresenceResult.ts";
import { invalidRequest } from "./errors.ts";

export interface PresenceContext {
  dataDir: string;
  choices: readonly string[];
  changed?: () => Promise<void>;
}

export async function presenceCommand(ctx: PresenceContext, args: PresenceArgs): Promise<PresenceResult> {
  if (typeof args.status === "string") {
    const status = args.status.trim();
    if (status !== "" && !ctx.choices.includes(status)) {
      const offered = ctx.choices.length === 0 ? "presence.statuses in your config is empty" : `yours are ${ctx.choices.join(", ")}`;
      throw invalidRequest(`${JSON.stringify(status)} isn't one of your statuses: ${offered}. Add it to presence.statuses to use it.`);
    }
    setPresence(ctx.dataDir, status, Date.now());
    await ctx.changed?.();
  }
  const current = presence(ctx.dataDir);
  return { ...(current === undefined || current.status === "" ? {} : { status: current.status, set_at: current.set_at }), choices: [...ctx.choices] };
}
