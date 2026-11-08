import dreamTemplateRaw from "../../../prompts/memory/dreaming/dream.md" with { type: "text" };

import { renderTemplate, formatWallClock } from "../../engine/prompt.ts";
import { timeLeftPhrase } from "../../autonomy/heartbeat_shape.ts";
import type { DreamOutcome } from "../../protocol/DreamOutcome.ts";
import type { DreamStop } from "../../protocol/DreamStop.ts";

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

const SLOT = /(\d+)/g;

export function renderDreamPrompt(template: string, vars: DreamPromptVars): string {
  const values: [string, string][] = [
    ["now", vars.now],
    ["user", vars.userName],
    ["char", vars.characterName],
    ["last_dream", vars.lastDream ?? ""],
    ["conversations", vars.conversations],
    ["reads", vars.reads ?? ""],
    ["notes", vars.notes ?? ""],
    ["time_limit", vars.timeLimit],
    ["wrap_up_after", vars.wrapUpAfter],
  ];
  const slots = new Map(values.map(([name, value], index) => [name, value === "" ? "" : `${String(index)}`]));
  return renderTemplate(template, slots).replace(SLOT, (_slot, index: string) => values[Number(index)]?.[1] ?? "");
}

export function dreamWrapUpText(msLeft: number, rounds: number): string {
  const stop = rounds === 1 ? "after this round" : `after ${String(rounds)} more rounds, counting this one`;
  return `[System nudge: this dream stops in ${timeLeftPhrase(msLeft)} or ${stop}, whichever comes first. ` +
    "Wrap up now: note in DREAMS.md where you stopped, commit what you have changed, " +
    "then finish with your summary.]";
}

export interface StoppedDream {
  startedAt: number;
  outcome: DreamOutcome;
  stoppedBy: DreamStop | undefined;
}

export function dreamStoppedNote(stopped: StoppedDream, limit: string, timeZone: string): string | undefined {
  const started = `It started ${formatWallClock(stopped.startedAt, timeZone)}.`;
  const noted = "Whatever it had already changed is still in place, and DREAMS.md has whatever it noted about where it stopped.";
  const unnoted = "Whatever it had already changed is still in place, but it had no chance to note where it stopped, so `git log` since then shows what it did.";
  if (stopped.outcome === "cut_off") {
    const why = stopped.stoppedBy === "round_limit"
      ? "used up its rounds of tool calls"
      : `reached its ${limit} limit`;
    return `[Your last dream ${why} and was stopped before it finished. ${started} ${noted}]`;
  }
  if (stopped.outcome === "interrupted") {
    const why = stopped.stoppedBy === "budget" ? "a usage budget paused it" : "Shore shut down";
    return `[Your last dream was stopped partway through when ${why}. ${started} ${unnoted}]`;
  }
  return undefined;
}
