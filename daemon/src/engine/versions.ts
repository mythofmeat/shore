import { createHash } from "node:crypto";

import { required } from "../util/required.ts";
import type { Message, MessageAlternative } from "./types.ts";

const VERSION_PREFIX = "mv_";

export function newMessageVersion(): string {
  return `${VERSION_PREFIX}${crypto.randomUUID()}`;
}

function isMessageVersion(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(VERSION_PREFIX) && value.length > VERSION_PREFIX.length;
}

export function versionOf(message: Pick<Message, "version">): string | undefined {
  return isMessageVersion(message.version) ? message.version : undefined;
}

export function alternativeVersionOf(
  alternative: Pick<MessageAlternative, "version">,
): string | undefined {
  return isMessageVersion(alternative.version) ? alternative.version : undefined;
}

export function isRealUserTurn(message: Message): boolean {
  if (message.role !== "user") return false;
  const blocks = message.content_blocks;
  return blocks.length === 0 || !blocks.every((block) => block.type === "tool_result");
}

export function realUserTurnIndices(messages: readonly Message[]): number[] {
  const indices: number[] = [];
  messages.forEach((message, index) => {
    if (isRealUserTurn(message)) indices.push(index);
  });
  return indices;
}

export function tailTurnStart(messages: readonly Message[], turns: number | undefined): number {
  if (turns === undefined) return 0;
  const indices = realUserTurnIndices(messages);
  if (indices.length === 0 || turns >= indices.length) return 0;
  return required(indices[indices.length - turns]);
}

export function processingUnitId(versions: readonly string[]): string {
  const digest = createHash("sha256").update(versions.join("\n")).digest("hex");
  return `pu_${digest.slice(0, 32)}`;
}
