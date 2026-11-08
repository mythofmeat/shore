import dreamTemplateRaw from "../../../prompts/memory/dreaming/dream.md" with { type: "text" };

import { renderTemplate, formatWallClock } from "../../engine/prompt.ts";
import { timeLeftPhrase } from "../../autonomy/heartbeat_shape.ts";

export const DEFAULT_DREAM_TEMPLATE = dreamTemplateRaw.trimEnd();

export const DREAM_OPENER = "[dream]";

export interface DreamPromptVars {
  now: string;
  userName: string;
  characterName: string;
  lastDream: string | undefined;
  conversations: string;
  reads: string | undefined;
  notes: string | undefined;
  timeLimit: string;
  wrapUpAfter: string;
}

export function renderDreamPrompt(template: string, vars: DreamPromptVars): string {
  return renderTemplate(
    template,
    new Map([
      ["now", vars.now],
      ["user", vars.userName],
      ["char", vars.characterName],
      ["last_dream", vars.lastDream ?? ""],
      ["conversations", vars.conversations],
      ["reads", vars.reads ?? ""],
      ["notes", vars.notes ?? ""],
      ["time_limit", vars.timeLimit],
      ["wrap_up_after", vars.wrapUpAfter],
    ]),
  );
}

export function dreamWrapUpText(msLeft: number, rounds: number): string {
  const stop = rounds === 1 ? "after this round" : `after ${String(rounds)} more rounds, counting this one`;
  return `[System nudge: this dream stops in ${timeLeftPhrase(msLeft)} or ${stop}, whichever comes first. ` +
    "Wrap up now: note in DREAMS.md where you stopped, commit what you have changed, " +
    "then finish with your summary.]";
}

export function dreamCutOffNote(startedAtMs: number, limit: string, timeZone: string): string {
  return `[Your last dream reached its ${limit} limit and was stopped before it finished. It started ` +
    `${formatWallClock(startedAtMs, timeZone)}. Whatever it had already changed is still in place, ` +
    "and DREAMS.md has whatever it noted about where it stopped.]";
}
