import { readFile } from "node:fs/promises";

import { required } from "../../util/required.ts";

import { characterActiveJsonl } from "../../config/dirs.ts";
import { normalizeMessage } from "../../engine/message_store.ts";
import type { Message } from "../../engine/types.ts";
import { versionsIn } from "../coverage.ts";
import { rustLines, rustTrim } from "../lines.ts";
import {
  hashCompactionSource,
  loadCompactionCheckpoint,
  type CompactionCheckpoint,
} from "./checkpoint.ts";
import { retainedTurns as retentionForBudget } from "./retention.ts";
import type { ConversationMessage } from "./types.ts";

const isRealUserTurn = (msg: ConversationMessage): boolean =>
  msg.role === "user" && !msg.isToolResultOnly;

export function findTurnSplit(messages: ConversationMessage[], keepTurns: number): number {
  if (keepTurns === 0) return messages.length;
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isRealUserTurn(required(messages[i]))) {
      turnsSeen += 1;
      if (turnsSeen >= keepTurns) return i;
    }
  }
  return 0;
}

export function countTurns(messages: ConversationMessage[]): number {
  return messages.filter(isRealUserTurn).length;
}

export function trailingAutonomousLen(messages: ConversationMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = required(messages[i]);
    if (msg.role !== "assistant" || !msg.isAutonomous) break;
    n += 1;
  }
  return n;
}

export function archiveSplitIndex(
  messages: ConversationMessage[],
  keepTurns: number,
  retainTrailingAutonomous: boolean,
): number {
  const splitAt = findTurnSplit(messages, keepTurns);
  if (!retainTrailingAutonomous) return splitAt;
  const tail = trailingAutonomousLen(messages);
  return Math.min(splitAt, Math.max(messages.length - tail, 0));
}

export interface ArchivalPlanInput {
  rawContent: string;
  messages: readonly ConversationMessage[];
  store: { messages(): readonly Message[] };
}

export interface ArchivalPlanSettings {
  keepRecentTurns: number;
  maxContextTokens: number;
  keepTurnsOverride?: number;
  retainTrailingAutonomous?: boolean;
  restart?: boolean;
}

declare const resolvedByPlanner: unique symbol;

export interface ArchivalPlan {
  readonly [resolvedByPlanner]: true;
  sourceContent: string;
  sourceHash: string;
  messages: readonly Message[];
  conversation: readonly ConversationMessage[];
  splitAt: number;
  archival: readonly Message[];
  versions: readonly string[];
  keepTurns: number;
  checkpoint?: CompactionCheckpoint;
  resumed: boolean;
}

export function messagesFromJsonl(content: string): Message[] {
  const messages: Message[] = [];
  for (const line of rustLines(content)) {
    if (rustTrim(line) === "") continue;
    try {
      messages.push(normalizeMessage(JSON.parse(line) as Message));
    } catch {
      continue;
    }
  }
  return messages;
}

function conversationView(messages: readonly Message[]): ConversationMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    isToolResultOnly:
      message.role === "user" &&
      message.content_blocks.length > 0 &&
      message.content_blocks.every((block) => block.type === "tool_result"),
    isAutonomous: message.origin === "autonomous",
    ...(message.version === undefined ? {} : { version: message.version }),
  }));
}

function resumesCheckpoint(
  checkpoint: CompactionCheckpoint | undefined,
  liveContent: string,
  splitAt: number,
  settings: ArchivalPlanSettings,
): checkpoint is CompactionCheckpoint {
  if (checkpoint === undefined || settings.restart === true) return false;
  if (!sourceIsCurrent(checkpoint.sourceContent, checkpoint.sourceHash, liveContent)) return false;
  if (settings.keepTurnsOverride !== undefined && checkpoint.splitAt !== splitAt) return false;
  return true;
}

export function sourceIsCurrent(
  sourceContent: string,
  sourceHash: string,
  liveContent: string,
): boolean {
  return hashCompactionSource(sourceContent) === sourceHash && liveContent.startsWith(sourceContent);
}

export function planSourceIsCurrent(plan: ArchivalPlan, liveContent: string): boolean {
  return sourceIsCurrent(plan.sourceContent, plan.sourceHash, liveContent);
}

export async function resolveArchivalPlan(
  dataDir: string,
  character: string,
  thread: string,
  input: ArchivalPlanInput,
  settings: ArchivalPlanSettings,
): Promise<ArchivalPlan | undefined> {
  const checkpoint = await loadCompactionCheckpoint(dataDir, character, thread).catch(
    () => undefined,
  );
  return buildArchivalPlan(input, settings, checkpoint);
}

export function archivalPlanInput(rawContent: string): ArchivalPlanInput {
  const messages = messagesFromJsonl(rawContent);
  return {
    rawContent,
    messages: conversationView(messages),
    store: { messages: () => messages },
  };
}

export function buildArchivalPlan(
  input: ArchivalPlanInput,
  settings: ArchivalPlanSettings,
  checkpoint: CompactionCheckpoint | undefined,
): ArchivalPlan | undefined {
  const keepTurns =
    settings.keepTurnsOverride ??
    retentionForBudget(input.messages, settings.keepRecentTurns, settings.maxContextTokens);
  const liveSplitAt = archiveSplitIndex(
    [...input.messages],
    keepTurns,
    settings.retainTrailingAutonomous ?? false,
  );

  const resumed = resumesCheckpoint(checkpoint, input.rawContent, liveSplitAt, settings);

  const sourceContent = resumed ? checkpoint.sourceContent : input.rawContent;
  const messages = resumed ? messagesFromJsonl(sourceContent) : [...input.store.messages()];
  const splitAt = Math.min(resumed ? checkpoint.splitAt : liveSplitAt, messages.length);
  if (splitAt === 0) return undefined;

  const archival = messages.slice(0, splitAt);
  const plan: Omit<ArchivalPlan, typeof resolvedByPlanner> = {
    sourceContent,
    sourceHash: hashCompactionSource(sourceContent),
    messages,
    conversation: conversationView(messages),
    splitAt,
    archival,
    versions: versionsIn(archival),
    keepTurns,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    resumed,
  };
  return plan as ArchivalPlan;
}

export interface ArchivalCommit {
  liveContent: string;
  retained: number;
  retainedTurns: number;
}

export function retainedTurnCount(liveContent: string, from: number): number {
  return countTurns(conversationView(messagesFromJsonl(liveContent)).slice(from));
}

export function openArchivalCommit(
  plan: ArchivalPlan,
  liveContent: string,
): ArchivalCommit | undefined {
  if (!planSourceIsCurrent(plan, liveContent)) return undefined;
  const liveLines = rustLines(liveContent).filter((line) => rustTrim(line) !== "");
  return {
    liveContent,
    retained: Math.max(liveLines.length - plan.splitAt, 0),
    retainedTurns: retainedTurnCount(liveContent, plan.splitAt),
  };
}

export async function readLiveSource(
  dataDir: string,
  character: string,
  thread: string,
  fallback: string,
): Promise<string> {
  try {
    return await readFile(characterActiveJsonl(dataDir, character, thread), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return fallback;
  }
}
