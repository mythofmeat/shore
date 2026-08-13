import type { ContentBlock, Message, MessageAlternative } from "./types.ts";

export type AlternativeDefectKind =
  | "empty"
  | "thinking_lost"
  | "thinking_without_signature";

export interface AlternativeDefect {
  msg_id: string;
  alt_index: number;
  kind: AlternativeDefectKind;
}

function isThinking(b: ContentBlock): boolean {
  return b.type === "thinking" || b.type === "redacted_thinking";
}

function replayable(b: ContentBlock): boolean {
  if (b.type === "redacted_thinking") return true;
  if (b.type !== "thinking") return false;
  return (
    b.signature !== undefined ||
    b.reasoning_details !== undefined ||
    b.reasoning_content !== undefined
  );
}

function defectsIn(
  msgId: string,
  index: number,
  alt: MessageAlternative,
  siblingHasThinking: boolean,
): AlternativeDefect[] {
  const found: AlternativeDefect[] = [];
  const blocks = alt.content_blocks ?? [];

  if (blocks.length === 0 && (alt.content ?? "").trim() === "") {
    found.push({ msg_id: msgId, alt_index: index, kind: "empty" });
    return found;
  }

  const thinking = blocks.filter(isThinking);
  if (thinking.length === 0) {
    if (siblingHasThinking) {
      found.push({ msg_id: msgId, alt_index: index, kind: "thinking_lost" });
    }
    return found;
  }
  if (!thinking.some(replayable)) {
    found.push({ msg_id: msgId, alt_index: index, kind: "thinking_without_signature" });
  }
  return found;
}

export function auditAlternatives(messages: readonly Message[]): AlternativeDefect[] {
  const found: AlternativeDefect[] = [];
  for (const msg of messages) {
    const alternatives = msg.alternatives ?? [];
    if (alternatives.length === 0) continue;

    const siblingHasThinking =
      msg.content_blocks.some(isThinking) ||
      alternatives.some((alt) => (alt.content_blocks ?? []).some(isThinking));

    for (const [index, alt] of alternatives.entries()) {
      found.push(...defectsIn(msg.msg_id, index, alt, siblingHasThinking));
    }
  }
  return found;
}

export function describeAlternativeDefects(
  path: string,
  defects: readonly AlternativeDefect[],
): string | undefined {
  if (defects.length === 0) return undefined;
  const byKind = new Map<AlternativeDefectKind, number>();
  for (const defect of defects) {
    byKind.set(defect.kind, (byKind.get(defect.kind) ?? 0) + 1);
  }
  const parts = [...byKind.entries()].map(([kind, n]) => `${kind}=${String(n)}`);
  return (
    `shore: ${String(defects.length)} stored alternative(s) in ${path} are structurally ` +
    `incomplete (${parts.join(", ")}); a lost signature cannot be recovered, but selecting ` +
    `one of these will replay a turn without its reasoning`
  );
}
