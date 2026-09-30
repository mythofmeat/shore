import { required } from "../../util/required.ts";

import { estimateTokens } from "../../engine/tokens.ts";
import type { ConversationMessage } from "./types.ts";

export const RECENT_CONTEXT_FRACTION = 0.25;
export const MIN_RECENT_RESERVE_TOKENS = 4_000;
export const MAX_RECENT_RESERVE_TOKENS = 60_000;

export function recentReserveTokens(
  maxContextTokens: number,
  fraction: number = RECENT_CONTEXT_FRACTION,
): number {
  if (maxContextTokens <= 0) return MIN_RECENT_RESERVE_TOKENS;
  const share = Math.floor(maxContextTokens * fraction);
  return Math.min(MAX_RECENT_RESERVE_TOKENS, Math.max(MIN_RECENT_RESERVE_TOKENS, share));
}

function isRealUserTurn(msg: ConversationMessage): boolean {
  return msg.role === "user" && !msg.isToolResultOnly;
}

export function turnsWithinReserve(
  messages: readonly ConversationMessage[],
  reserveTokens: number,
): number {
  let used = 0;
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = required(messages[i]);
    used += msg.tokens ?? estimateTokens(msg.content);
    if (used > reserveTokens) break;
    if (isRealUserTurn(msg)) turns += 1;
  }
  return turns;
}

export function retainedTurns(
  messages: readonly ConversationMessage[],
  configuredTurns: number,
  maxContextTokens: number,
  fraction: number = RECENT_CONTEXT_FRACTION,
): number {
  if (maxContextTokens <= 0) return configuredTurns;
  const reserve = recentReserveTokens(maxContextTokens, fraction);
  const affordable = turnsWithinReserve(messages, reserve);
  return Math.min(configuredTurns, Math.max(1, affordable));
}
