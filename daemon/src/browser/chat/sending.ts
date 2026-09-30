import type { WebRequestInfo } from "../../protocol/WebRequestInfo.ts";

export type SentFate = "saved" | "waiting" | "unsent";

export function sentFate(request: WebRequestInfo | undefined): SentFate {
  if (request === undefined) return "unsent";
  if (request.accepted === true || request.phase === "completed") return "saved";
  return request.phase === "running" ? "waiting" : "unsent";
}

export function droppedNotice(dropped: number): string {
  if (dropped === 0) return "";
  return ` ${String(dropped)} image${dropped === 1 ? "" : "s"} attached while it was sending didn’t fit and ${dropped === 1 ? "was" : "were"} removed.`;
}

export function conversationCharacter(conversation: string): string | undefined {
  try {
    const [character] = JSON.parse(conversation) as unknown[];
    return typeof character === "string" ? character : undefined;
  } catch { return undefined; }
}
